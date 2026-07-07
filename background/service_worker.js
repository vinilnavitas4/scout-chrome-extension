const BASE_URL = "https://scout-service.wonderfulfield-ebc060c9.eastus.azurecontainerapps.io";

// Shared secret for the Scout backend endpoints (extension has no Microsoft SSO token).
// Sent as X-Scout-Key on every Scout API call. Must match SCOUT_API_KEY on the server.
const SCOUT_KEY = "scout_a5ThvEKUjRbZmlpDyKQOF9WcKb2fiEl8Vat-8f_3Bzg";

// Standard JSON headers + Scout key for all backend calls.
function scoutHeaders(extra) {
  return { "Content-Type": "application/json", "X-Scout-Key": SCOUT_KEY, ...(extra || {}) };
}

// Open the side panel when the toolbar icon is clicked.
// Side panel stays open across outside clicks (unlike an action popup).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("[SCOUT] setPanelBehavior:", e.message));

// storage.session is extension-pages-only by default — the content script's
// auto-extraction cache writes silently fail without this.
chrome.storage.session
  .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
  .catch((e) => console.error("[SCOUT] setAccessLevel:", e.message));

// In-memory cache: job_id → { title, requirements }
// Pre-populated after GET_JDS so GET_SCORE is instant.
const jobCache = new Map();

// -- Skill matching (semantic, embedding-based) -------------------------------
// Matching is done by cosine similarity over all-MiniLM-L6-v2 embeddings (see
// computeScore / the offscreen doc). normalizeSkill only cleans phrases before
// they are embedded and used as cache keys.

function normalizeSkill(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9+#./\s-]/g, " ")  // keep +, #, ., / (c++, c#, ci/cd, node.js)
    .replace(/\s+/g, " ")
    .trim();
}

// Abbreviation/synonym pairs MiniLM scores BELOW threshold on short phrases
// (measured: "k8s"~"kubernetes" 0.47, "llm"~"large language models" 0.16).
// Canonicalize before comparing/embedding so these match deterministically.
const SKILL_ALIASES = new Map([
  ["k8s", "kubernetes"],
  ["amazon web services", "aws"],
  ["google cloud platform", "gcp"],
  ["google cloud", "gcp"],
  ["large language models", "llm"],
  ["large language model", "llm"],
  ["llms", "llm"],
  ["machine learning", "ml"],
  ["artificial intelligence", "ai"],
  ["postgres", "postgresql"],
  ["js", "javascript"],
  ["ts", "typescript"],
  ["nodejs", "node.js"],
  ["node", "node.js"],
  ["reactjs", "react"],
  ["react.js", "react"],
  ["vuejs", "vue"],
  ["vue.js", "vue"],
  ["angularjs", "angular"],
  ["golang", "go"],
  ["dotnet", ".net"],
  ["springboot", "spring boot"],
  ["restful", "rest"],
  ["restful api", "rest"],
  ["restful apis", "rest"],
  ["rest api", "rest"],
  ["rest apis", "rest"],
  ["continuous integration", "ci/cd"],
  ["continuous integration/continuous delivery", "ci/cd"],
  ["ci cd", "ci/cd"],
  // Security clearance — level-specific. Each wording variant normalizes to its
  // own canonical level label (matching detectClearance), so levels stay distinct
  // (TS/SCI ≠ Secret) instead of collapsing to a generic "clearance".
  // TS/SCI
  ["ts/sci", "ts/sci"],
  ["ts sci", "ts/sci"],
  ["tssci", "ts/sci"],
  ["ts/sci clearance", "ts/sci"],
  ["top secret/sci", "ts/sci"],
  ["top secret sci", "ts/sci"],
  ["sensitive compartmented information", "ts/sci"],
  // Top Secret
  ["top secret", "top secret"],
  ["top secret clearance", "top secret"],
  ["ts clearance", "top secret"],
  // Secret
  ["secret", "secret"],
  ["secret clearance", "secret"],
  ["dod secret", "secret"],
  ["interim secret", "secret"],
  // Public Trust
  ["public trust", "public trust"],
  ["public trust clearance", "public trust"],
  // Generic — only unnamed/typo variants fall back to "clearance".
  ["clearence", "clearance"],
  ["security clearance", "clearance"],
  ["security clearence", "clearance"],
  ["active clearance", "clearance"],
  ["cleared", "clearance"],
  ["clearable", "clearance"],
]);

function canonicalSkill(s) {
  const n = normalizeSkill(s);
  return SKILL_ALIASES.get(n) || n;
}

// ── Parse "What You'll Need" section → structured requirements ────────────────

const TOOL_KEYWORDS = [
  "AWS","Azure","GCP","Docker","Kubernetes","Terraform","Jenkins","CI/CD","Linux","Ansible","Helm",
  "Java","Python","JavaScript","TypeScript","React","Angular","Vue","Spring Boot","Node.js","Flask","Django","FastAPI",".NET","C#","C++","Go","Rust","GraphQL",
  "SQL","Power BI","Power Apps","Power Automate","SharePoint","DAX","Power Query","Spark","ETL","Kafka","dbt","Airflow","Databricks","Snowflake","Tableau","Looker","MongoDB","PostgreSQL","MySQL","Redis","Elasticsearch","Neo4j",
  "LLM","GPT","OpenAI","LangChain","TensorFlow","PyTorch","Scikit","RAG",
  "Top Secret","TS/SCI","Secret clearance","FISMA","FedRAMP","NIST","DISA","STIGs",
  "REST","API","Microservices","Git","Maven","Hibernate","JUnit","Selenium","Agile","Scrum","Jira","ServiceNow","Salesforce","AEM"
];

// Short keywords that double as common English words — match case-sensitively
// so "trusted" doesn't hit Rust, "go through" doesn't hit Go, etc.
const CASE_SENSITIVE_KEYWORDS = new Set(["Go","Rust","React","Spark","Helm","DAX","RAG","Secret clearance"]);

// Whole-word keyword scan (allows trailing plural "s"/"es"). Substring scanning is
// what caused "Rust"⊂"trusted", "Git"⊂"digital", "REST"⊂"Reston" false positives.
function findKeywords(text) {
  if (!text) return [];
  const found = [];
  for (const kw of TOOL_KEYWORDS) {
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![A-Za-z0-9])${esc}(?:e?s)?(?![A-Za-z0-9+#])`, CASE_SENSITIVE_KEYWORDS.has(kw) ? "" : "i");
    if (re.test(text) && !found.includes(kw)) found.push(kw);
  }
  return found;
}

// Slice `text` from heading `startRe` up to the next known heading. JD text from
// the backend is a single line with apostrophes stripped ("What You ll Need :"),
// so headings — not newlines — are the only reliable section boundaries.
const NEXT_HEADING_RE = /Set\s+Yourself\s+Apart|Clearance\s*:|About\s+Navitas|What\s+We\s+Offer|Equal\s+Opportunity|Who\s+We\s+Are|Benefits\s*:/i;
function sliceSection(text, startRe) {
  const start = text.search(startRe);
  if (start === -1) return "";
  const tail = text.slice(start);
  // Skip past the heading itself (~20 chars) before looking for the next heading.
  const endRel = tail.slice(20).search(NEXT_HEADING_RE);
  return endRel === -1 ? tail : tail.slice(0, endRel + 20);
}

// ── Clearance + location signals ──────────────────────────────────────────────
// Clearance and geography are hard hiring constraints alongside skills, so the
// scorer treats them as their own buckets (renormalized in, only when the JD
// states them). detectClearance/detectState/detectRemote are mirrored verbatim
// in score_endpoint.py and the scrapers so client and backend agree.

// Clearance levels, ordered high→low. A higher clearance satisfies a lower
// requirement (TS/SCI holder meets a Secret ask), so we rank rather than equate.
const CLEARANCE_LEVELS = [
  { rank: 4, label: "TS/SCI",       re: /\bTS\s*\/?\s*SCI\b|\bsensitive compartmented\b/i },
  { rank: 3, label: "Top Secret",   re: /\btop\s+secret\b/i },
  { rank: 2, label: "Secret",       re: /\bsecret(?:\s+clearance)?\b/i },
  { rank: 1, label: "Public Trust", re: /\bpublic\s+trust\b/i },
  // Generic fallback — any mention of clearance/cleared without a named level.
  { rank: 1, label: "Clearance",    re: /\bclear(?:ance|ence|ances|ences)\b|\bcleared\b|\bclearable\b/i },
];
function detectClearance(text) {
  if (!text) return { rank: 0, label: "" };
  for (const lvl of CLEARANCE_LEVELS) if (lvl.re.test(text)) return { rank: lvl.rank, label: lvl.label };
  return { rank: 0, label: "" };
}

const STATE_ABBRS = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
]);
const STATE_NAMES = {
  alabama:"AL",alaska:"AK",arizona:"AZ",arkansas:"AR",california:"CA",colorado:"CO",connecticut:"CT",
  delaware:"DE",florida:"FL",georgia:"GA",hawaii:"HI",idaho:"ID",illinois:"IL",indiana:"IN",iowa:"IA",
  kansas:"KS",kentucky:"KY",louisiana:"LA",maine:"ME",maryland:"MD",massachusetts:"MA",michigan:"MI",
  minnesota:"MN",mississippi:"MS",missouri:"MO",montana:"MT",nebraska:"NE",nevada:"NV","new hampshire":"NH",
  "new jersey":"NJ","new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND",ohio:"OH",
  oklahoma:"OK",oregon:"OR",pennsylvania:"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",
  tennessee:"TN",texas:"TX",utah:"UT",vermont:"VT",virginia:"VA",washington:"WA","west virginia":"WV",
  wisconsin:"WI",wyoming:"WY","district of columbia":"DC","washington dc":"DC","washington, dc":"DC",
};
// LinkedIn often reports a metro/city only ("Greater Boston Area", "San Francisco
// Bay Area"), with no state token. Map the major US metros to a state so those
// locations still score instead of reading as "unknown". Mirrored in score_endpoint.py.
const CITY_NAMES = {
  "san francisco":"CA","bay area":"CA","silicon valley":"CA","san jose":"CA",oakland:"CA",
  "los angeles":"CA","san diego":"CA",sacramento:"CA","orange county":"CA",
  "new york":"NY",nyc:"NY",manhattan:"NY",brooklyn:"NY",
  boston:"MA",chicago:"IL",seattle:"WA",portland:"OR","las vegas":"NV",
  houston:"TX",dallas:"TX",austin:"TX","san antonio":"TX","fort worth":"TX",
  philadelphia:"PA",pittsburgh:"PA",atlanta:"GA",
  miami:"FL",orlando:"FL",tampa:"FL",jacksonville:"FL",
  denver:"CO",phoenix:"AZ",tucson:"AZ",detroit:"MI",
  minneapolis:"MN","st. paul":"MN","saint paul":"MN","st paul":"MN",
  charlotte:"NC",raleigh:"NC",durham:"NC",nashville:"TN",memphis:"TN",
  baltimore:"MD","salt lake city":"UT",columbus:"OH",cleveland:"OH",cincinnati:"OH",
  "kansas city":"MO","st. louis":"MO","saint louis":"MO","st louis":"MO",
  indianapolis:"IN",milwaukee:"WI","new orleans":"LA",richmond:"VA",
};
// Extract a US state abbreviation. `bareAbbr` allows a lone two-letter token —
// safe for a short controlled string (candidate "City, ST") but NOT for JD prose,
// where words like "IN"/"OR"/"OK" would false-match, so JD parsing passes false.
function detectState(text, bareAbbr) {
  if (!text) return "";
  const comma = text.match(/,\s*([A-Za-z]{2})\b/);
  if (comma && STATE_ABBRS.has(comma[1].toUpperCase())) return comma[1].toUpperCase();
  const low = text.toLowerCase();
  // "Washington DC" must beat the plain "washington" → WA state name.
  if (/washington\s*,?\s*d\.?\s*c\.?/.test(low)) return "DC";
  for (const name in STATE_NAMES) if (low.includes(name)) return STATE_NAMES[name];
  for (const city in CITY_NAMES) if (low.includes(city)) return CITY_NAMES[city];
  if (bareAbbr) {
    const bare = text.match(/\b([A-Z]{2})\b/);
    if (bare && STATE_ABBRS.has(bare[1])) return bare[1];
  }
  return "";
}

function detectRemote(text) {
  if (!text) return false;
  if (/\b(?:not|no|non[\s-]?)\s*remote\b/i.test(text)) return false;
  return /\bremote\b/i.test(text);
}

// ── Education signals ─────────────────────────────────────────────────────────
// Degree level scored as its own bucket (doc §3.3, 15%). Ranked high→low so a
// higher degree satisfies a lower requirement (a Master's meets a Bachelor's
// ask). Mirrored verbatim in score_endpoint.py so client and backend agree.
const EDUCATION_LEVELS = [
  { rank: 4, label: "Doctorate",  re: /\b(?:ph\.?\s?d|doctorate|doctoral|d\.?sc\.?|ed\.?d)\b/i },
  { rank: 3, label: "Master's",   re: /\b(?:master'?s?|m\.?s\.?c?\.?|m\.?eng\.?|mba|m\.?a\.?|graduate degree)\b/i },
  { rank: 2, label: "Bachelor's", re: /\b(?:bachelor'?s?|b\.?s\.?c?\.?|b\.?eng\.?|b\.?a\.?|undergraduate degree|four[\s-]?year degree|4[\s-]?year degree)\b/i },
  // Bare dotless "AS"/"AA" omitted on purpose — "as" is a common word and would
  // false-match. Accept spelled-out forms and dotted abbreviations only.
  { rank: 1, label: "Associate",  re: /\b(?:associate'?s?|a\.?a\.?s\.?|a\.s|two[\s-]?year degree)\b/i },
];
function detectEducation(text) {
  if (!text) return { rank: 0, label: "" };
  for (const lvl of EDUCATION_LEVELS) if (lvl.re.test(text)) return { rank: lvl.rank, label: lvl.label };
  // Bare "degree" with no named level → treat as a Bachelor's-level ask/hold.
  if (/\bdegree\b/i.test(text)) return { rank: 2, label: "Degree" };
  return { rank: 0, label: "" };
}

// ── Certification signals ─────────────────────────────────────────────────────
// Not a scored bucket, but the auto-scheduling gate (doc §4) needs a pass/fail on
// "Required Certifications". Whole-word scan for named certs; a JD with none
// required passes the gate automatically.
const CERT_KEYWORDS = [
  "PMP","CISSP","CISM","CISA","CEH","Security+","Network+","A+","CCNA","CCNP","CCIE",
  "AWS Certified","Azure Certified","GCP Certified","CKA","CKAD","Terraform Associate",
  "CompTIA","ITIL","CSM","PSM","SAFe","Six Sigma","CPA","PE license",
];
function findCerts(text) {
  if (!text) return [];
  const found = [];
  for (const kw of CERT_KEYWORDS) {
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "i");
    if (re.test(text) && !found.includes(kw)) found.push(kw);
  }
  return found;
}

// ── Off-list skill mining (#1) ────────────────────────────────────────────────
// TOOL_KEYWORDS can't enumerate every tool, so a JD requiring something off-list
// would never score it. Mine extra skill phrases from explicit enumerations only
// (a "skills cue" followed by a delimited list) so we capture off-list skills
// without scraping whole prose sentences into the requirement set.
const SKILL_CUE_RE = /(?:experience (?:with|in|using)|proficien\w* (?:with|in)|knowledge of|familiar\w* with|expertise in|skilled in|hands[\s-]?on (?:experience )?with|working knowledge of|background in|competen\w* in|specific tools[^:]*:|skills?\s*:|technologies?\s*:|tech\s*stack\s*:)/ig;

// Generic words that survive the length/word-count filter but aren't skills.
const SKILL_STOPWORDS = new Set([
  "ability","strong","excellent","good","years","year","experience","knowledge","skills","skill",
  "written","verbal","communication","team","teams","etc","including","environment","environments",
  "related","equivalent","degree","plus","preferred","required","work","working","other","various",
  "such","as","is","are","be","you","your","our","we","will","must","should","have","proven","a","an",
  "the","and","or","with","in","of","to","using","for","on","at","an","but","not","this","that",
]);

function extractListedSkills(section) {
  if (!section) return [];
  const out = [];
  let m;
  SKILL_CUE_RE.lastIndex = 0;
  while ((m = SKILL_CUE_RE.exec(section)) && out.length < 15) {
    const from = m.index + m[0].length;
    let clause = section.slice(from, from + 140);
    const stop = clause.search(/[.;]/);          // end the list at the first sentence break
    if (stop !== -1) clause = clause.slice(0, stop);
    for (let phrase of clause.split(/[,/|]|\band\b|\n/i)) {
      phrase = phrase.replace(/^[\s\-*•]+/, "").replace(/\s+/g, " ").trim();
      if (phrase.length < 2 || phrase.length > 40) continue;
      const toks = phrase.toLowerCase().split(/\s+/);
      if (toks.length > 3) continue;                          // skills are short phrases
      if (toks.every(t => SKILL_STOPWORDS.has(t))) continue;  // pure boilerplate
      if (!/[a-z0-9]/i.test(phrase)) continue;
      if (!out.some(o => o.toLowerCase() === phrase.toLowerCase())) out.push(phrase);
    }
  }
  return out;
}

// Prominence (#7): how many times a skill is mentioned across the whole JD.
// Skills the JD repeats are weighted more in the required-skill fill, so missing
// a core, oft-repeated skill costs more than missing a one-off mention.
function skillProminence(skill, text) {
  if (!text || !skill) return 1;
  const esc = String(skill).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!esc) return 1;
  const re = new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "gi");
  const hits = text.match(re);
  return Math.max(hits ? hits.length : 1, 1);
}

function dedupeBy(list, keyFn) {
  const seen = new Set(), out = [];
  for (const x of list) { const k = keyFn(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}

function parseRequirements(description) {
  const text = description || "";

  const needSection      = sliceSection(text, /What\s+You\s*'?\s*ll?\s*'?\s*Need/i) || text;
  const preferredSection = sliceSection(text, /Set\s+Yourself\s+Apart/i);

  // Take the LARGEST stated year requirement in the need section, not the first
  // match (#6) — a stray "3 years" in an unrelated line must not undercut "8+ years".
  let required_years = 0;
  for (const ym of needSection.matchAll(/(\d+)\+?\s*years?\b/ig)) {
    required_years = Math.max(required_years, parseInt(ym[1], 10));
  }

  // Required = allow-list keyword hits ∪ mined enumeration skills. Fall back to
  // the whole description if the "Need" section yielded nothing.
  let required_skills = findKeywords(needSection);
  if (required_skills.length === 0) required_skills = findKeywords(text);
  required_skills = dedupeBy(
    [...required_skills, ...extractListedSkills(needSection)],
    s => canonicalSkill(s)
  );

  const preferredRaw = dedupeBy(
    [...findKeywords(preferredSection), ...extractListedSkills(preferredSection)],
    s => canonicalSkill(s)
  );
  const reqCanon = new Set(required_skills.map(canonicalSkill));
  const preferred_skills = preferredRaw.filter(k => !reqCanon.has(canonicalSkill(k)));

  // Mention-frequency weight per skill, computed over the full JD text.
  const prominence = {};
  for (const s of [...required_skills, ...preferred_skills]) prominence[s] = skillProminence(s, text);

  // Clearance + location are scanned over the WHOLE JD (clearance often sits in a
  // "Clearance:" line outside the "Need" section). Each only scores when stated.
  const required_clearance = detectClearance(text);
  const jd_state  = detectState(text, false);
  const jd_remote = detectRemote(text);

  // Education requirement — prefer the "Need" section, fall back to the whole JD.
  // Only scores when the JD actually states a degree requirement.
  const required_education = detectEducation(needSection).rank ? detectEducation(needSection) : detectEducation(text);
  // Required certifications — only gate the auto-schedule rule when the JD names one.
  const required_certs = findCerts(needSection.length ? needSection : text);

  return { required_skills, preferred_skills, required_years, prominence,
           required_clearance, jd_state, jd_remote, required_education, required_certs };
}

// ── Semantic skill matching via embeddings (offscreen model) ──────────────────
// The offscreen document runs all-MiniLM-L6-v2. We send every skill phrase, get a
// normalized vector back, and call two skills a match if their cosine ≥ threshold.
// No string-match fallback: if the model can't load, scoring fails loudly.

const SIM_THRESHOLD = 0.55; // tuned for all-MiniLM: related skills ~0.6+, unrelated <0.4
// Cosines within ±SIM_MARGIN of the threshold flip between devices/browsers
// because WASM/quantized embedding math isn't bit-identical. The client runs the
// q8-quantized Xenova model; the backend runs full-precision sentence-transformers,
// so the same pair can differ by ~0.01-0.02. The backend is the single source of
// truth (see backendScore) — this LOCAL path is a best-effort fallback and may
// diverge slightly. Margin widened so the deterministic lexical rules
// (exact/alias/token-subset) decide the borderline band instead of the model.
const SIM_MARGIN    = 0.03;
const SIM_ACCEPT    = SIM_THRESHOLD + SIM_MARGIN; // 0.58

// Score calibration (#8): map the raw rubric score → a calibrated 0-100 the way
// recruiters actually rate fit. Identity until fitted: collect (raw_score,
// hired/advanced?) pairs, fit a logistic P(good_fit | raw), then set
// CALIBRATION.enabled = true with the fitted { k, x0 }. Until then raw passes
// through unchanged so behavior is unsurprising.
const CALIBRATION = { enabled: false, k: 0.12, x0: 50 };
function calibrate(raw) {
  if (!CALIBRATION.enabled) return raw;
  const { k, x0 } = CALIBRATION;
  return 100 / (1 + Math.exp(-k * (raw - x0)));
}

let creatingOffscreen = null; // de-dupe concurrent createDocument calls
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: "offscreen/offscreen.html",
      reasons: ["WORKERS"],
      justification: "Run local embedding model for semantic skill matching.",
    });
  }
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}

// Embed a batch of phrases → array of vectors (same order). Throws on model failure.
// Retries while the offscreen doc spins up: createDocument resolves before the
// module (transformers bundle) evaluates, so the first sendMessage can hit
// "Receiving end does not exist".
async function embed(texts) {
  await ensureOffscreen();
  let lastErr;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await chrome.runtime.sendMessage({ target: "offscreen-embed", texts });
      if (!res?.ok) throw new Error(res?.error || "embedding failed");
      return res.vectors;
    } catch (e) {
      lastErr = e;
      if (!/Receiving end does not exist|message port closed/i.test(e.message)) throw e;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw lastErr;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Parse a résumé PDF (base64) via pdf.js in the offscreen doc — the Dice content
// script can fetch the bytes but can't load pdf.js in its world, so it hands the
// bytes here. Returns { text, links, pages }. Retries while offscreen spins up.
async function parseResumePdf(b64) {
  await ensureOffscreen();
  let lastErr;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await chrome.runtime.sendMessage({ target: "offscreen-pdf", b64 });
      if (!res?.ok) throw new Error(res?.error || "pdf parse failed");
      return res;
    } catch (e) {
      lastErr = e;
      if (!/Receiving end does not exist|message port closed/i.test(e.message)) throw e;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw lastErr;
}

// ── Backend-authoritative scoring ─────────────────────────────────────────────
// POST the candidate + JD id to the backend, which runs the embedding match and
// the rubric server-side so the result is identical on every device. Returns
// { score, label, rationale } on success, or null to signal "fall back to local"
// (endpoint missing / network error / malformed response).

// Retry transient failures (5xx / 429 / network / timeout) before giving up.
// The local fallback uses per-device WASM embeddings, so a machine that drops
// to it gets a DIFFERENT score than one that reached the backend. A single
// Azure cold start or network blip must NOT silently diverge the score — keep
// every device on the deterministic backend path. Only a definitive 404
// (endpoint not deployed) or malformed body falls through to local.
const SCORE_RETRIES   = 2;
const SCORE_TIMEOUT_MS = 12000;

async function backendScore(jd_id, candidate, resume_text) {
  const body = JSON.stringify({
    jd_id,
    resume_text: resume_text || undefined, // backend applies résumé-replace rule
    candidate: {
      skills:           candidate.skills || [],
      experience_years: candidate.experience_years || 0,
      location:         candidate.location  || "",
      clearance:        candidate.clearance || "",
      about:            candidate.about     || "",
      // Flatten education to "degree school" lines so the backend can rank it.
      education:        (candidate.education || [])
                          .map(e => `${e.degree || ""} ${e.school || ""}`.trim())
                          .filter(Boolean),
      // Flatten certifications to "name issuer" lines for the §4 cert gate.
      certifications:   (candidate.certifications || [])
                          .map(c => `${c.name || ""} ${c.issuer || ""}`.trim())
                          .filter(Boolean),
    },
  });

  for (let attempt = 0; attempt <= SCORE_RETRIES; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 400 * 2 ** (attempt - 1)));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SCORE_TIMEOUT_MS);
    try {
      const r = await fetch(`${BASE_URL}/api/scout/score`, {
        method:  "POST",
        headers: scoutHeaders(),
        body,
        signal:  ctrl.signal,
      });
      if (r.status === 404) return null;            // endpoint not deployed → local, no retry
      if (!r.ok) {                                   // 5xx / 429 → transient, retry
        console.warn(`[SCOUT] backendScore HTTP ${r.status} (attempt ${attempt + 1})`);
        continue;
      }
      const d = await r.json();
      if (!d || typeof d.score !== "number") return null; // malformed → local
      return {
        score: d.score, label: d.label || "", rationale: d.rationale || "",
        categories: d.categories || null, gates: d.gates || null,
        auto_schedule: !!d.auto_schedule,
      };
    } catch (e) {                                    // network / abort(timeout) → transient, retry
      console.warn(`[SCOUT] backendScore ${e.name === "AbortError" ? "timeout" : "network"} (attempt ${attempt + 1})`);
    } finally {
      clearTimeout(timer);
    }
  }
  console.warn("[SCOUT] backendScore exhausted retries — falling back to per-device local score");
  return null; // transient errors persisted → local fallback (may differ across devices)
}

// ── Score candidate against requirements (local fallback) ─────────────────────

async function computeScore(requirements, jobTitle, candidate) {
  const { required_skills, preferred_skills, required_years } = requirements;
  const cSkills  = candidate.skills || [];
  const expYears = candidate.experience_years || 0;

  if (required_skills.length === 0) {
    return { score: 50, label: "Fair Fit", rationale: "Could not extract skills from JD to score." };
  }

  // Embed every unique skill phrase (JD + candidate) in one batch, build text→vector map.
  // embed() throws if the model is unavailable — let it propagate to the GET_SCORE handler.
  const vecMap = new Map();
  const uniq = [...new Set(
    [...required_skills, ...preferred_skills, ...cSkills].map(canonicalSkill).filter(Boolean)
  )];
  const vectors = await embed(uniq);
  uniq.forEach((t, i) => vecMap.set(t, vectors[i]));

  // Token set of a canonicalized phrase, for lexical containment checks.
  function tokenSet(s) {
    return new Set(canonicalSkill(s).split(/[\s/.+#-]+/).filter(t => t.length > 1));
  }

  // True if `target` matches any candidate skill. Lexical first (alias-canonical
  // exact or token containment — catches abbreviations/variants MiniLM scores
  // below threshold, e.g. "k8s"≈"Kubernetes", "AWS"≈"Amazon Web Services"),
  // then semantic cosine ≥ threshold as fallback.
  function isMatch(target) {
    const tn = canonicalSkill(target);
    if (!tn) return false; // unembeddable phrase (empty after normalize)
    const tTok = tokenSet(target);
    const tv = vecMap.get(tn);
    return cSkills.some(cs => {
      const cn = canonicalSkill(cs);
      if (!cn) return false;
      // Exact normalized match.
      if (cn === tn) return true;
      // Token containment: one phrase's tokens ⊆ the other's (e.g. "react" ⊆ "react.js").
      const cTok = tokenSet(cs);
      if (tTok.size && cTok.size) {
        const [small, big] = tTok.size <= cTok.size ? [tTok, cTok] : [cTok, tTok];
        if ([...small].every(t => big.has(t))) return true;
      }
      // Semantic fallback — clear-margin only, so borderline cosines don't flip
      // the score across devices.
      const cv = vecMap.get(cn);
      return tv && cv && cosine(tv, cv) >= SIM_ACCEPT;
    });
  }

  const matchedReq  = required_skills.filter(isMatch);
  const matchedPref = preferred_skills.filter(isMatch);
  const missingReq  = required_skills.filter(s => !isMatch(s));

  // Debug: full scoring inputs/outputs — compare across browsers when scores diverge.
  console.log("[SCOUT] computeScore inputs:", {
    candidateSkills: cSkills,
    expYears,
    required_skills,
    preferred_skills,
    required_years,
    matchedReq,
    matchedPref,
    missingReq,
  });

  // ── Category fills (each 0-1) ───────────────────────────────────────────────
  // Prominence-weighted required fill (#7): each required skill counts by how
  // often the JD mentions it, so core skills dominate the ratio.
  const prom = requirements.prominence || {};
  const wOf  = s => Math.max(prom[s] || 1, 1);
  const reqTotal   = required_skills.reduce((a, s) => a + wOf(s), 0);
  const reqMatched = matchedReq.reduce((a, s) => a + wOf(s), 0);
  const reqFill  = reqTotal ? reqMatched / reqTotal : 0;
  const prefFill = preferred_skills.length ? matchedPref.length / preferred_skills.length : 0;

  // Clearance bucket — active ONLY when the JD states a required clearance. Meets
  // or exceeds → full credit; holds a lower clearance → half (still investable);
  // none → zero. A JD with no clearance ask leaves this bucket out entirely.
  const reqClr  = requirements.required_clearance || { rank: 0, label: "" };
  const candClr = detectClearance([
    candidate.clearance,
    candidate.about,
    (candidate.certifications || []).map(c => `${c.name || ""} ${c.issuer || ""}`).join("\n"),
    (candidate.experience || []).map(e => e && e.description).filter(Boolean).join("\n"),
  ].filter(Boolean).join("\n"));
  const clearanceActive = reqClr.rank > 0;
  // "Clearance" is the generic fallback label — candidate stated they hold a
  // clearance but not which level. Treat that as meeting a named requirement
  // (they're cleared; recruiter verifies the exact level) rather than half credit.
  const candGeneric = candClr.label === "Clearance";
  const clearanceFill = !clearanceActive ? 0
    : candGeneric                ? 1
    : candClr.rank >= reqClr.rank ? 1
    : candClr.rank > 0            ? 0.5
    :                              0;

  // Education bucket — active ONLY when the JD states a degree requirement. Meets
  // or exceeds → full; holds a lower degree → half; none → zero. Candidate degree
  // level read from the Education section entries (fallback: About/résumé text).
  const reqEdu  = requirements.required_education || { rank: 0, label: "" };
  const eduText = [
    (candidate.education || []).map(e => `${e.degree || ""} ${e.school || ""}`).join("\n"),
    candidate.about,
  ].filter(Boolean).join("\n");
  const candEdu = detectEducation(eduText);
  const educationActive = reqEdu.rank > 0;
  const educationFill = !educationActive ? 0
    : candEdu.rank >= reqEdu.rank ? 1
    : candEdu.rank > 0            ? 0.5
    :                              0;

  // Location bucket — active when the JD is remote, or both JD and candidate
  // states are known. Remote → location is not a constraint (full credit); same
  // state → full; different state → zero (penalized). Unknown either side and
  // not remote → bucket stays out (no penalty for missing data).
  const jdRemote  = !!requirements.jd_remote;
  const jdState   = requirements.jd_state || "";
  const candState = detectState(candidate.location || "", true);
  const locationActive = jdRemote || (!!jdState && !!candState);
  const locationFill = jdRemote ? 1 : (jdState && candState && jdState === candState ? 1 : 0);

  // ── Composite (doc §3.3 weights) ────────────────────────────────────────────
  // Required 35 / Preferred 15 / Clearance 20 / Education 15 / Location 15.
  // Renormalize so only PRESENT buckets contribute and they sum to 100 — no free
  // credit for an unstated preferred/clearance/education/location constraint.
  const W_REQ = 35, W_PREF = 15, W_CLR = 20, W_EDU = 15, W_LOC = 15;
  let active = W_REQ;                                  // required is always present here
  if (preferred_skills.length) active += W_PREF;
  if (clearanceActive)         active += W_CLR;
  if (educationActive)         active += W_EDU;
  if (locationActive)          active += W_LOC;
  let raw = (W_REQ / active) * reqFill * 100;
  if (preferred_skills.length) raw += (W_PREF / active) * prefFill * 100;
  if (clearanceActive)         raw += (W_CLR / active) * clearanceFill * 100;
  if (educationActive)         raw += (W_EDU / active) * educationFill * 100;
  if (locationActive)          raw += (W_LOC / active) * locationFill * 100;

  const score = Math.min(Math.max(Math.round(calibrate(raw)), 5), 99);

  let label;
  if      (score >= 80) label = "Excellent Fit";
  else if (score >= 65) label = "Good Fit";
  else if (score >= 45) label = "Fair Fit";
  else                  label = "Poor Fit";

  // ── Per-category breakdown for the score card (doc §3.4) ────────────────────
  const jdLoc = jdRemote ? "Remote" : (jdState || "");
  const categories = [
    { key: "required",  name: "Required Skills",    weight: W_REQ, active: true,
      fill: reqFill,  matched: matchedReq, missing: missingReq },
    { key: "preferred", name: "Preferred Skills",   weight: W_PREF, active: !!preferred_skills.length,
      fill: prefFill, matched: matchedPref, missing: preferred_skills.filter(s => !matchedPref.includes(s)) },
    { key: "clearance", name: "Clearance",          weight: W_CLR, active: clearanceActive,
      fill: clearanceFill, detected: candClr.label || "None", required: reqClr.label || "None" },
    { key: "education", name: "Education",          weight: W_EDU, active: educationActive,
      fill: educationFill, detected: candEdu.label || "None", required: reqEdu.label || "None" },
    { key: "location",  name: "Location / Commute", weight: W_LOC, active: locationActive,
      fill: locationFill, detected: candState || (candidate.location || "").trim() || "Unknown", required: jdLoc || "Any" },
  ];

  // ── Auto-scheduling gate (doc §4) — pass/fail on the four critical categories,
  // independent of the composite. required_certs gate passes when the JD names
  // no cert; else the candidate text must mention every required cert.
  const certText = [
    (candidate.skills || []).join(" "),
    candidate.about,
    (candidate.certifications || []).map(c => `${c.name || ""} ${c.issuer || ""}`).join("\n"),
    (candidate.experience || []).map(e => e && e.description).filter(Boolean).join("\n"),
  ].filter(Boolean).join("\n");
  const reqCerts    = requirements.required_certs || [];
  const candCerts   = findCerts(certText);
  const missingCerts = reqCerts.filter(c => !candCerts.includes(c));
  const gates = {
    required_skills: reqFill >= 1,
    certifications:  missingCerts.length === 0,
    clearance:       !clearanceActive || clearanceFill >= 1,
    locality:        !locationActive  || locationFill  >= 1,
  };
  const auto_schedule = score >= 80 && gates.required_skills && gates.certifications
                        && gates.clearance && gates.locality;

  const parts = [];
  if (matchedReq.length > 0) {
    const shown = matchedReq.slice(0, 4).join(", ");
    const extra = matchedReq.length > 4 ? ` +${matchedReq.length - 4} more` : "";
    parts.push(`Matches ${matchedReq.length}/${required_skills.length} required skills: ${shown}${extra}.`);
  } else {
    parts.push(`No required skills matched for ${jobTitle}.`);
  }
  if (matchedPref.length > 0) parts.push(`Preferred: ${matchedPref.slice(0, 3).join(", ")}.`);
  if (missingReq.length  > 0) parts.push(`Missing: ${missingReq.slice(0, 3).join(", ")}.`);
  if (educationActive) {
    parts.push(educationFill === 1
      ? `Holds a ${candEdu.label} — meets the ${reqEdu.label} requirement.`
      : candEdu.rank > 0
        ? `Holds a ${candEdu.label}, below the required ${reqEdu.label}.`
        : `No degree found; role requires a ${reqEdu.label}.`);
  }
  if (clearanceActive) {
    parts.push(candGeneric
      ? `Holds an active clearance — meets the ${reqClr.label} requirement (level unverified).`
      : clearanceFill === 1
        ? `Holds ${candClr.label} — meets the ${reqClr.label} clearance.`
        : candClr.rank > 0
          ? `Holds ${candClr.label}, below the required ${reqClr.label} clearance.`
          : `No clearance found; role requires ${reqClr.label}.`);
  }
  // Always report location whenever the JD expresses one (remote or a state),
  // even if the candidate's state is unknown — the bucket may stay out of the
  // score, but the match/mismatch is always surfaced in the rationale.
  if (jdRemote) {
    parts.push(`Remote role — location not a constraint.`);
  } else if (jdState) {
    const candLoc = (candidate.location || "").trim();
    parts.push(!candState
      ? (candLoc
          ? `Located in ${candLoc}; job located in ${jdState}.`
          : `Candidate location unknown; job located in ${jdState}.`)
      : jdState === candState
        ? `Located in ${candState} — matches the ${jdState} job location.`
        : `Located in ${candState}, outside the ${jdState} job location.`);
  }

  return { score, label, rationale: parts.join(" "), categories, gates, auto_schedule };
}

// ── Score one candidate against one JD (backend-first, local fallback) ────────
// Shared by GET_SCORE (single JD) and SCORE_ALL (every JD). Folds experience-
// description skills + résumé skills, then scores. Returns { score, label,
// rationale, source }.
async function scoreCandidateForJd(jd_id, candidate, resume_text) {
  // Fold skills mined from each experience's description into the skill set,
  // alongside the Skills section. findKeywords whitelists known tools → no prose
  // pollution. Overridden when a résumé replaces skills below.
  const expText = (candidate.experience || [])
    .map(e => e && e.description).filter(Boolean).join("\n");
  if (expText) {
    const expSkills = findKeywords(expText);
    if (expSkills.length > 0) {
      const have = new Set((candidate.skills || []).map(s => s.toLowerCase()));
      const added = expSkills.filter(s => !have.has(s.toLowerCase()));
      candidate = { ...candidate, skills: [...(candidate.skills || []), ...added] };
    }
  }

  // Résumé present → score against the résumé's skills only (replace the
  // profile-scraped skills). Guard: empty keyword scan keeps original skills.
  let scored = candidate;
  if (resume_text) {
    const resumeSkills = findKeywords(resume_text);
    if (resumeSkills.length > 0) scored = { ...candidate, skills: resumeSkills };
  }

  // 1) Backend scoring (consistent across devices).
  const backend = await backendScore(jd_id, scored, resume_text);
  if (backend) return { ...backend, source: "backend" };

  // 2) Local fallback (per-device embeddings — may differ across browsers).
  let cached = jobCache.get(jd_id);
  if (!cached) {
    const r   = await fetch(`${BASE_URL}/api/scout/jobs/${jd_id}`, { headers: scoutHeaders() });
    const job = await r.json();
    if (job.error) throw new Error(job.error);
    cached = { title: job.title, requirements: parseRequirements(job.description || "") };
    jobCache.set(jd_id, cached);
  }
  const result = await computeScore(cached.requirements, cached.title, scored);
  return { ...result, source: "local" };
}

// ── Job list fetch + cache ────────────────────────────────────────────────────
// The /api/scout/jobs call is the slow part of opening the panel (Azure cold
// start). Cache the mapped list in storage.local so repeat opens populate the
// dropdown instantly, then revalidate in the background.

const JOBS_CACHE_KEY = "scout_jobs_cache";

async function fetchJobs() {
  const r    = await fetch(`${BASE_URL}/api/scout/jobs`, { headers: scoutHeaders() });
  const data = await r.json();
  return (data.jobs || []).map(j => ({
    id:     j.id,
    title:  j.title,
    client: j.internal_code || [j.city, j.state].filter(Boolean).join(", ") || j.type || ""
  }));
}

async function getCachedJobs() {
  const { [JOBS_CACHE_KEY]: c } = await chrome.storage.local.get(JOBS_CACHE_KEY);
  return c && Array.isArray(c.jobs) ? c : null;
}

async function refreshJobsCache() {
  try {
    const jobs = await fetchJobs();
    await chrome.storage.local.set({ [JOBS_CACHE_KEY]: { ts: Date.now(), jobs } });
    return jobs;
  } catch (e) {
    console.error("[SCOUT] refreshJobsCache:", e.message);
    return null;
  }
}

// Prime the cache + model when the browser/extension starts, so the first panel
// open is already warm instead of paying the cold fetch then.
chrome.runtime.onStartup?.addListener(() => { refreshJobsCache(); ensureOffscreen().catch(() => {}); syncScoutSession(); });
chrome.runtime.onInstalled?.addListener(() => { refreshJobsCache(); syncScoutSession(); });

// ── Pre-fetch all job descriptions in background ──────────────────────────────
// Called after GET_JDS returns. Populates jobCache so GET_SCORE is instant.

async function prefetchJobDescriptions(jobs) {
  await Promise.allSettled(jobs.map(async (job) => {
    try {
      const r   = await fetch(`${BASE_URL}/api/scout/jobs/${job.id}`, { headers: scoutHeaders() });
      const data = await r.json();
      if (!data.error) {
        jobCache.set(job.id, {
          title:        data.title,
          requirements: parseRequirements(data.description || ""),
        });
      }
    } catch (_) { /* silently skip — GET_SCORE will fall back to a live fetch */ }
  }));
  console.log(`[SCOUT] Pre-cached ${jobCache.size} job descriptions`);
}

// ── Floating panel window ──────────────────────────────────────────────────────
// Gesture-free alternative to sidePanel.open(): a small popup-type window showing
// the same popup.html, pinned to the source tab via ?tabId=. Stateless reuse —
// scan existing popup windows instead of caching an id, so it survives SW restarts.

// Window id persists in storage.session so it survives SW restarts; the
// getAll URL scan is a fallback in case the stored id is gone or stale.
async function findFloatingPanel() {
  const { scout_float_win } = await chrome.storage.session.get("scout_float_win");
  if (scout_float_win != null) {
    try {
      const win = await chrome.windows.get(scout_float_win, { populate: true });
      return { win, tab: (win.tabs || [])[0] };
    } catch (_) {
      await chrome.storage.session.remove("scout_float_win"); // window already gone
    }
  }
  const base = chrome.runtime.getURL("popup/popup.html");
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] });
  for (const w of wins) {
    const t = (w.tabs || [])[0];
    if (t && (t.url || t.pendingUrl || "").startsWith(base)) return { win: w, tab: t };
  }
  return null;
}

async function openFloatingPanel(tabId) {
  const url = chrome.runtime.getURL(`popup/popup.html?tabId=${tabId}`);
  const existing = await findFloatingPanel();
  if (existing && existing.tab) {
    if ((existing.tab.url || existing.tab.pendingUrl) !== url) {
      await chrome.tabs.update(existing.tab.id, { url });
    } else {
      // Same profile re-extracted (e.g. page reload missed CLOSE_FLOAT):
      // navigation to an identical URL is a no-op, so force a reload to
      // re-read the fresh result from session storage.
      await chrome.tabs.reload(existing.tab.id);
    }
    await chrome.windows.update(existing.win.id, { focused: true, drawAttention: true });
    await chrome.storage.session.set({ scout_float_win: existing.win.id });
    return;
  }
  const win = await chrome.windows.create({ url, type: "popup", width: 420, height: 720, focused: true });
  await chrome.storage.session.set({ scout_float_win: win.id });
}

async function closeFloatingPanel() {
  const existing = await findFloatingPanel();
  await chrome.storage.session.remove("scout_float_win");
  if (existing) await chrome.windows.remove(existing.win.id);
}

chrome.windows.onRemoved.addListener(async (id) => {
  const { scout_float_win } = await chrome.storage.session.get("scout_float_win");
  if (scout_float_win === id) await chrome.storage.session.remove("scout_float_win");
});

// ── JazzHR session token ──────────────────────────────────────────────────────
// Grab the recruiter's active JazzHR session cookie so the backend can update the
// candidate's workflow step after a call without a separate login (JazzHR has
// email-OTP MFA so server-side login isn't viable). Times out so a missing cookies
// permission never hangs the message port.
async function getJazzhrToken() {
  try {
    const cookie = await Promise.race([
      chrome.cookies.get({ url: "https://api.jazz.co/", name: "sandcastle_ticket" }),
      new Promise(resolve => setTimeout(() => resolve(null), 1500)),
    ]);
    return cookie?.value || "";
  } catch (_) {
    return "";
  }
}

// ── Scout service session auto-sync ───────────────────────────────────────────
// Whenever Chrome is logged into JazzHR as scout@, push that session cookie to
// the backend (→ Key Vault) so headless/scheduled updates can act as scout@.
// Runs on startup and every 30 min via an alarm. Skips the OTP-challenge token
// and expired/other-user sessions.
const SCOUT_SESSION_COOKIES = ["imagicaa_pass", "sandcastle_ticket"];

function _decodeJwtPayload(jwt) {
  try {
    let b = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    b += "=".repeat((4 - (b.length % 4)) % 4);
    return JSON.parse(atob(b));
  } catch (_) { return null; }
}

async function syncScoutSession() {
  try {
    // Search ALL jazz.co subdomains — the scout@ session cookie may be scoped to
    // app.jazz.co (login UI) rather than api.jazz.co, so a single-url lookup
    // missed it. Dedupe by name, preferring the most specific/fresh value.
    const cookies = await chrome.cookies.getAll({ domain: "jazz.co" });
    let chosen = null;
    for (const name of SCOUT_SESSION_COOKIES) {
      for (const c of cookies.filter(x => x.name === name)) {
        if ((c.value.match(/\./g) || []).length !== 2) continue;
        const p = _decodeJwtPayload(c.value);
        if (!p || p.isOtpToken) continue;                 // skip OTP challenge token
        if (p.exp && p.exp * 1000 < Date.now()) continue; // skip expired
        chosen = `${name}=${c.value}`;
        break;
      }
      if (chosen) break;
    }
    if (!chosen) { console.log("[SCOUT] syncScoutSession: no valid session cookie on jazz.co"); return; }
    const r = await fetch(`${BASE_URL}/api/scout/set-session`, {
      method: "POST",
      headers: scoutHeaders(),
      body: JSON.stringify({ cookie: chosen }),
    });
    console.log("[SCOUT] syncScoutSession → set-session", r.status, await r.text().catch(() => ""));
  } catch (e) { console.log("[SCOUT] syncScoutSession error:", e?.message || e); }
}

chrome.alarms?.create("scoutSessionSync", { periodInMinutes: 30 });
chrome.alarms?.onAlarm.addListener((a) => {
  if (a.name === "scoutSessionSync") syncScoutSession();
});

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Relay MODEL_READY from offscreen → all popup tabs so the loading status clears.
  if (message?.target === "sw" && message?.type === "MODEL_READY") {
    chrome.runtime.sendMessage({ type: "MODEL_READY" }).catch(() => {});
    return;
  }
  if (message?.target === "offscreen-embed" || message?.target === "offscreen-embed-status" || message?.target === "offscreen-pdf") return;
  const { type, payload } = message;

  // ── PARSE_RESUME_PDF — content script fetched résumé bytes but can't load
  // pdf.js in its world; parse them in the offscreen doc and return the text. ──
  if (type === "PARSE_RESUME_PDF") {
    parseResumePdf(message.b64).then(
      r => sendResponse({ ok: true, text: r.text, links: r.links, pages: r.pages }),
      e => sendResponse({ ok: false, error: e.message })
    );
    return true; // async
  }

  // ── OPEN_PANEL — open the side panel for the sender's tab ─────────────────
  // Works when the message rides a user gesture (transient activation, e.g.
  // SPA navigation right after a click). Without a gesture sidePanel.open()
  // rejects — fall back to a floating popup window, which needs no gesture.
  if (type === "OPEN_PANEL") {
    const tabId = sender.tab?.id;
    if (tabId == null) { sendResponse({ ok: false, error: "no tab" }); return; }
    chrome.sidePanel.open({ tabId }).then(
      () => sendResponse({ ok: true }),
      async () => {
        try {
          // No gesture available. We never open a floating popup window — side
          // panel only. If it's already open it shows the result itself; report
          // ok. Otherwise report failure so the content script arms a one-time
          // gesture listener and retries OPEN_PANEL on the user's next click.
          const panels = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
          if (panels.length) { sendResponse({ ok: true }); return; }
          sendResponse({ ok: false, error: "no gesture" });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      }
    );
    return true;
  }

  // ── CLOSE_FLOAT — close only the floating panel window (page reload cleanup) ─
  if (type === "CLOSE_FLOAT") {
    closeFloatingPanel().then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true;
  }

  // ── CLOSE_PANEL — close the side panel everywhere, then re-arm the icon ───
  if (type === "CLOSE_PANEL") {
    (async () => {
      try {
        // Floating fallback window (if any) closes too — same button serves both.
        await closeFloatingPanel().catch(() => {});
        // Disabling the panel closes any open instance; re-enable shortly after
        // so the toolbar icon can open it again.
        await chrome.sidePanel.setOptions({ enabled: false });
        setTimeout(() => {
          chrome.sidePanel
            .setOptions({ enabled: true, path: "popup/popup.html" })
            .catch((e) => console.error("[SCOUT] panel re-enable:", e.message));
        }, 250);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // ── GET_JDS — serve cached list instantly, then revalidate ───────────────
  if (type === "GET_JDS") {
    (async () => {
      try {
        // fresh = user hit refresh: drop cached JD requirements so the next
        // GET_SCORE re-fetches and re-parses descriptions from the backend.
        if (message.fresh) jobCache.clear();

        // Stale-while-revalidate: serve ANY cached list immediately (even past
        // TTL) so the dropdown never waits on the network after the first-ever
        // load — Azure cold starts can take many seconds. Always revalidate in
        // the background so next open is current. Skipped only on forced refresh.
        if (!message.fresh) {
          const cached = await getCachedJobs();
          if (cached && cached.jobs.length) {
            sendResponse({ ok: true, data: cached.jobs });
            ensureOffscreen().catch(() => {});
            prefetchJobDescriptions(cached.jobs);
            refreshJobsCache(); // silent background revalidate
            return;
          }
        }

        // No usable cache (or forced fresh): fetch live, then cache.
        const jobs = await fetchJobs();
        await chrome.storage.local.set({ [JOBS_CACHE_KEY]: { ts: Date.now(), jobs } });
        sendResponse({ ok: true, data: jobs });
        // Warm up the offscreen model + pre-fetch JD descriptions in parallel.
        // Neither is awaited — popup already has the job list.
        ensureOffscreen().catch(() => {});
        prefetchJobDescriptions(jobs);
      } catch (e) {
        console.error("[SCOUT] GET_JDS error:", e.message);
        // Last resort: serve a stale cache if the live fetch failed.
        const cached = await getCachedJobs().catch(() => null);
        if (cached) { sendResponse({ ok: true, data: cached.jobs }); return; }
        sendResponse({ ok: false, error: `Failed to load jobs: ${e.message}` });
      }
    })();
    return true;
  }

  // ── GET_SCORE — backend-authoritative embedding score, local fallback ─────
  // Scoring runs on the backend so every device/browser gets an identical score
  // (client WASM embeddings diverge across browsers). If the backend endpoint is
  // unavailable, fall back to the local offscreen embedding score so the UI keeps
  // working until /api/scout/score is deployed.
  if (type === "GET_SCORE") {
    (async () => {
      try {
        const { jd_id, candidate, resume_text } = payload;
        const result = await scoreCandidateForJd(jd_id, candidate, resume_text);
        console.log(`[SCOUT] Score (${result.source}):`, result);
        sendResponse({ ok: true, data: result, source: result.source });
      } catch (e) {
        console.error("[SCOUT] GET_SCORE error:", e.message);
        sendResponse({ ok: false, error: `Scoring failed: ${e.message}` });
      }
    })();
    return true;
  }

  // ── SCORE_ALL — score the candidate against EVERY JD, return best-first ────
  // Runs entirely in the background (service worker). Scores all jobs with
  // bounded concurrency so Azure isn't hit with N parallel cold-start requests,
  // then returns the list sorted high→low. Popup shows the top (best-fit) JD.
  if (type === "SCORE_ALL") {
    (async () => {
      try {
        const { candidate, resume_text } = payload;

        const cached = await getCachedJobs().catch(() => null);
        let jobs = cached?.jobs;
        if (!jobs || !jobs.length) jobs = await fetchJobs();
        if (!jobs.length) { sendResponse({ ok: false, error: "No jobs to score against." }); return; }

        const CONCURRENCY = 4;
        const results = [];
        let idx = 0;
        async function worker() {
          while (idx < jobs.length) {
            const job = jobs[idx++];
            try {
              const r = await scoreCandidateForJd(job.id, candidate, resume_text);
              results.push({ id: job.id, title: job.title, client: job.client || "",
                             score: r.score, label: r.label, rationale: r.rationale });
            } catch (e) {
              console.warn(`[SCOUT] SCORE_ALL skip ${job.id}: ${e.message}`);
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));

        results.sort((a, b) => b.score - a.score);
        console.log(`[SCOUT] SCORE_ALL: ${results.length}/${jobs.length} scored, best:`, results[0]);
        sendResponse({ ok: true, data: results });
      } catch (e) {
        console.error("[SCOUT] SCORE_ALL error:", e.message);
        sendResponse({ ok: false, error: `Scoring failed: ${e.message}` });
      }
    })();
    return true;
  }

  // ── ADD_CANDIDATE — post to SCOUT backend → JazzHR ───────────────────────
  if (type === "ADD_CANDIDATE") {
    (async () => {
      try {
        const { job_id, job_title, candidate, resume_b64, resume_name, resume_mime } = payload;
        const jazzhr_token = await getJazzhrToken();
        const r = await fetch(`${BASE_URL}/api/scout/candidates`, {
          method:  "POST",
          headers: scoutHeaders(),
          body:    JSON.stringify({ job_id, job_title, candidate, resume_b64, resume_name, resume_mime, jazzhr_token }),
        });
        const text = await r.text();
        let data;
        try { data = JSON.parse(text); }
        catch (_) { sendResponse({ ok: false, error: `Non-JSON (${r.status}): ${text.slice(0, 120)}` }); return; }
        const jazzhrError = data.applicant?._error;
        const jazzhrId    = data.applicant?.id || data.applicant?.prospect_id || data.applicant_id;
        if (data.ok && !jazzhrError && jazzhrId) {
          console.log("[SCOUT] Candidate added:", jazzhrId);
          sendResponse({
            ok:           true,
            status:       "added",
            jazzhr_url:   data.jazzhr_url || "",
            applicant_id: jazzhrId,
          });
        } else if (data.ok) {
          sendResponse({ ok: false, error: jazzhrError || "JazzHR did not create the candidate." });
        } else {
          sendResponse({ ok: false, error: data.error || `API error (${r.status})` });
        }
      } catch (e) {
        console.error("[SCOUT] ADD_CANDIDATE error:", e.message);
        sendResponse({ ok: false, error: `Fetch failed: ${e.message}` });
      }
    })();
    return true;
  }

  // ── INITIATE_CALL — trigger Vapi AI phone screen ──────────────────────────
  if (type === "INITIATE_CALL") {
    (async () => {
      try {
        const jazzhr_token = await getJazzhrToken();
        const r = await fetch(`${BASE_URL}/api/scout/initiate-call`, {
          method:  "POST",
          headers: scoutHeaders(),
          body:    JSON.stringify({ ...payload, jazzhr_token }),
        });
        const data = await r.json();
        sendResponse(data.ok
          ? { ok: true, call_id: data.call_id, status: data.status }
          : { ok: false, error: data.error || "Call initiation failed" }
        );
      } catch (e) {
        console.error("[SCOUT] INITIATE_CALL error:", e.message);
        sendResponse({ ok: false, error: `Fetch failed: ${e.message}` });
      }
    })();
    return true;
  }

  // ── SCHEDULE_CALL — schedule a Vapi AI phone screen for later ──────────────
  if (type === "SCHEDULE_CALL") {
    (async () => {
      try {
        const jazzhr_token = await getJazzhrToken();
        const r = await fetch(`${BASE_URL}/api/scout/schedule-call`, {
          method:  "POST",
          headers: scoutHeaders(),
          body:    JSON.stringify({ ...payload, jazzhr_token }),
        });
        const data = await r.json();
        sendResponse(data.ok
          ? { ok: true, scheduled_id: data.scheduled_id, scheduled_at: data.scheduled_at }
          : { ok: false, error: data.error || "Scheduling failed" }
        );
      } catch (e) {
        console.error("[SCOUT] SCHEDULE_CALL error:", e.message);
        sendResponse({ ok: false, error: `Fetch failed: ${e.message}` });
      }
    })();
    return true;
  }

  // ── GET_CALL_STATUS — poll for call result after initiation ───────────────
  if (type === "GET_CALL_STATUS") {
    (async () => {
      try {
        const { applicant_id } = payload;
        const r    = await fetch(`${BASE_URL}/api/scout/calls/${applicant_id}`, { headers: scoutHeaders() });
        const data = await r.json();
        sendResponse(data);
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});
