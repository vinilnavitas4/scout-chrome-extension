const BASE_URL = "https://navitas-ai-platform.wonderfulfield-ebc060c9.eastus.azurecontainerapps.io";

// Open the side panel when the toolbar icon is clicked.
// Side panel stays open across outside clicks (unlike an action popup).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("[SCOUT] setPanelBehavior:", e.message));

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

function parseRequirements(description) {
  const text = description || "";

  const needSection      = sliceSection(text, /What\s+You\s*'?\s*ll?\s*'?\s*Need/i) || text;
  const preferredSection = sliceSection(text, /Set\s+Yourself\s+Apart/i);

  // "5+ years of experience", "5+ years in software engineering", "15+ years of progressive experience"
  let required_years = 0;
  const yearsMatch = needSection.match(/(\d+)\+?\s*years?\b/i);
  if (yearsMatch) required_years = parseInt(yearsMatch[1], 10);

  // Some JDs (e.g. architect roles) list only soft skills under "Need" — fall
  // back to scanning the whole description so we still have something to score.
  let required_skills = findKeywords(needSection);
  if (required_skills.length === 0) required_skills = findKeywords(text);
  const preferred_skills = findKeywords(preferredSection).filter(k => !required_skills.includes(k));

  const specificMatch = needSection.match(/Specific\s+tools[^:]*:([\s\S]*?)(?:\n\s*(?:[A-Z]|\n)|$)/i);
  if (specificMatch) {
    const extras = specificMatch[1].split(/[,\n]+/).map(s => s.replace(/^[\s\-\*]+/, '').trim()).filter(s => s.length > 1 && s.length < 60);
    for (const e of extras) {
      if (!required_skills.includes(e)) required_skills.push(e);
    }
  }

  return { required_skills, preferred_skills, required_years };
}

// ── Semantic skill matching via embeddings (offscreen model) ──────────────────
// The offscreen document runs all-MiniLM-L6-v2. We send every skill phrase, get a
// normalized vector back, and call two skills a match if their cosine ≥ threshold.
// No string-match fallback: if the model can't load, scoring fails loudly.

const SIM_THRESHOLD = 0.55; // tuned for all-MiniLM: related skills ~0.6+, unrelated <0.4

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

// ── Score candidate against requirements ──────────────────────────────────────

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
      // Semantic fallback.
      const cv = vecMap.get(cn);
      return tv && cv && cosine(tv, cv) >= SIM_THRESHOLD;
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

  const reqWeight  = required_skills.length  ? (matchedReq.length  / required_skills.length)  * 60 : 0;
  const prefWeight = preferred_skills.length ? (matchedPref.length / preferred_skills.length) * 15 : 15;
  const expWeight  = required_years ? Math.min(expYears / required_years, 1.2) * 25 : (expYears > 0 ? 20 : 10);

  const score = Math.min(Math.max(Math.round(reqWeight + prefWeight + expWeight), 5), 99);

  let label;
  if      (score >= 80) label = "Excellent Fit";
  else if (score >= 65) label = "Good Fit";
  else if (score >= 45) label = "Fair Fit";
  else                  label = "Poor Fit";

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
  if (expYears > 0 && required_years > 0) {
    parts.push(expYears >= required_years
      ? `${expYears} yrs meets the ${required_years}-yr requirement.`
      : `${expYears} yrs is below the ${required_years}-yr requirement.`
    );
  }

  return { score, label, rationale: parts.join(" ") };
}

// ── Pre-fetch all job descriptions in background ──────────────────────────────
// Called after GET_JDS returns. Populates jobCache so GET_SCORE is instant.

async function prefetchJobDescriptions(jobs) {
  await Promise.allSettled(jobs.map(async (job) => {
    try {
      const r   = await fetch(`${BASE_URL}/api/scout/jobs/${job.id}`);
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

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Relay MODEL_READY from offscreen → all popup tabs so the loading status clears.
  if (message?.target === "sw" && message?.type === "MODEL_READY") {
    chrome.runtime.sendMessage({ type: "MODEL_READY" }).catch(() => {});
    return;
  }
  if (message?.target === "offscreen-embed" || message?.target === "offscreen-embed-status") return;
  const { type, payload } = message;

  // ── GET_JDS — fetch active jobs, then pre-warm description cache ──────────
  if (type === "GET_JDS") {
    (async () => {
      try {
        const r    = await fetch(`${BASE_URL}/api/scout/jobs`);
        const data = await r.json();
        const jobs = (data.jobs || []).map(j => ({
          id:     j.id,
          title:  j.title,
          client: j.internal_code || [j.city, j.state].filter(Boolean).join(", ") || j.type || ""
        }));
        sendResponse({ ok: true, data: jobs });
        // Warm up the offscreen model + pre-fetch JD descriptions in parallel.
        // Neither is awaited — popup already has the job list.
        ensureOffscreen().catch(() => {});
        prefetchJobDescriptions(jobs);
      } catch (e) {
        console.error("[SCOUT] GET_JDS error:", e.message);
        sendResponse({ ok: false, error: `Failed to load jobs: ${e.message}` });
      }
    })();
    return true;
  }

  // ── GET_SCORE — use cache if warm, else fetch live ────────────────────────
  if (type === "GET_SCORE") {
    (async () => {
      try {
        const { jd_id, candidate } = payload;

        let cached = jobCache.get(jd_id);
        if (!cached) {
          // Cache miss (SW was restarted) — fetch live
          const r   = await fetch(`${BASE_URL}/api/scout/jobs/${jd_id}`);
          const job = await r.json();
          if (job.error) { sendResponse({ ok: false, error: job.error }); return; }
          cached = { title: job.title, requirements: parseRequirements(job.description || "") };
          jobCache.set(jd_id, cached);
        }

        const result = await computeScore(cached.requirements, cached.title, candidate);
        console.log("[SCOUT] Score:", result, "(cache hit:", jobCache.has(jd_id), ")");
        sendResponse({ ok: true, data: result });
      } catch (e) {
        console.error("[SCOUT] GET_SCORE error:", e.message);
        sendResponse({ ok: false, error: `Scoring failed: ${e.message}` });
      }
    })();
    return true;
  }

  // ── ADD_CANDIDATE — post to SCOUT backend → JazzHR ───────────────────────
  if (type === "ADD_CANDIDATE") {
    (async () => {
      try {
        const { job_id, candidate } = payload;
        const r = await fetch(`${BASE_URL}/api/scout/candidates`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ job_id, candidate }),
        });
        const text = await r.text();
        let data;
        try { data = JSON.parse(text); }
        catch (_) { sendResponse({ ok: false, error: `Non-JSON (${r.status}): ${text.slice(0, 120)}` }); return; }
        const jazzhrError = data.applicant?._error;
        const jazzhrId    = data.applicant?.id || data.applicant?.prospect_id;
        if (data.ok && !jazzhrError && jazzhrId) {
          console.log("[SCOUT] Candidate added:", jazzhrId);
          sendResponse({ ok: true, status: "added", jazzhr_url: data.jazzhr_url || "" });
        } else if (data.ok) {
          // Backend reports ok but JazzHR rejected the candidate (e.g. missing email)
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
});
