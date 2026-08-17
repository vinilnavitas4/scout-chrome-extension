// Runtime config. config.js holds the deployed defaults; config.local.js is a
// gitignored local override (see config.local.example.js) that points the
// extension at a scout-service running on this machine. A missing local file is
// the normal case — importScripts throws on 404, so swallow that.
importScripts(chrome.runtime.getURL("config.js"));
try { importScripts(chrome.runtime.getURL("config.local.js")); }
catch (_) { /* no local override — using deployed defaults */ }

const BASE_URL = self.SCOUT_CONFIG.BASE_URL;

// Shared secret for the Scout backend endpoints (extension has no Microsoft SSO token).
// Sent as X-Scout-Key on every Scout API call. Must match SCOUT_API_KEY on the server.
const SCOUT_KEY = self.SCOUT_CONFIG.SCOUT_KEY;

// Logged on every worker start so it's never ambiguous which backend is in use.
console.log(`[SCOUT] backend: ${BASE_URL}`);

// Standard JSON headers + Scout key for all backend calls.
function scoutHeaders(extra) {
  return { "Content-Type": "application/json", "X-Scout-Key": SCOUT_KEY, ...(extra || {}) };
}

// GET a Scout JSON endpoint. When the host answers with an HTML page instead —
// an Azure error page, an auth redirect, or a deploy where the Scout routes are
// missing — r.json() throws the useless "Unexpected token '<'". Report the
// status and path so the panel says what actually broke.
async function scoutGetJson(path) {
  const r    = await fetch(`${BASE_URL}${path}`, { headers: scoutHeaders() });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(r.status === 404
      ? `Scout API not found at ${path} (HTTP 404) — backend not deployed`
      : `Backend HTTP ${r.status} at ${path}`);
  }
  try { return JSON.parse(text); }
  catch (_) { throw new Error(`Backend returned non-JSON at ${path}: ${text.slice(0, 80)}`); }
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
  ["fast api", "fastapi"],
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
  // Spaced variant "Fast API" is the same skill as the "FastAPI" keyword.
  text = text.replace(/\bFast\s+API\b/gi, "FastAPI");
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
// Ambiguous names (one city name, several states) are mapped to the metro the
// JDs we see actually mean — e.g. "Arlington" → VA (DC metro), not TX. An
// explicit "City, ST" always wins because the comma form is checked first.
const CITY_NAMES = {
  "san francisco":"CA","bay area":"CA","silicon valley":"CA","san jose":"CA",oakland:"CA",
  "los angeles":"CA","san diego":"CA",sacramento:"CA","orange county":"CA",
  "long beach":"CA",anaheim:"CA",irvine:"CA",fresno:"CA",riverside:"CA","santa clara":"CA",
  "palo alto":"CA","mountain view":"CA",sunnyvale:"CA",cupertino:"CA","redwood city":"CA",
  berkeley:"CA","santa monica":"CA","san mateo":"CA","el segundo":"CA","culver city":"CA",
  "new york":"NY",nyc:"NY",manhattan:"NY",brooklyn:"NY",queens:"NY",bronx:"NY",
  "long island":"NY",westchester:"NY",albany:"NY",buffalo:"NY",rochester:"NY",syracuse:"NY",
  boston:"MA",cambridge:"MA",somerville:"MA",quincy:"MA",worcester:"MA",springfield:"MA",
  chicago:"IL",naperville:"IL",schaumburg:"IL",evanston:"IL",
  seattle:"WA",bellevue:"WA",redmond:"WA",tacoma:"WA",spokane:"WA",
  portland:"OR",beaverton:"OR","las vegas":"NV",reno:"NV",henderson:"NV",
  houston:"TX",dallas:"TX",austin:"TX","san antonio":"TX","fort worth":"TX",
  plano:"TX",irving:"TX",frisco:"TX",richardson:"TX","el paso":"TX",
  philadelphia:"PA",pittsburgh:"PA",allentown:"PA","king of prussia":"PA",
  newark:"NJ","jersey city":"NJ",princeton:"NJ",hoboken:"NJ",edison:"NJ",trenton:"NJ",
  atlanta:"GA",alpharetta:"GA",savannah:"GA",augusta:"GA",
  miami:"FL",orlando:"FL",tampa:"FL",jacksonville:"FL","fort lauderdale":"FL",
  "st. petersburg":"FL","saint petersburg":"FL",tallahassee:"FL",
  denver:"CO",boulder:"CO","colorado springs":"CO",aurora:"CO",
  phoenix:"AZ",tucson:"AZ",scottsdale:"AZ",chandler:"AZ",tempe:"AZ",mesa:"AZ",
  detroit:"MI","ann arbor":"MI",troy:"MI",dearborn:"MI",
  minneapolis:"MN","st. paul":"MN","saint paul":"MN","st paul":"MN",bloomington:"MN",
  charlotte:"NC",raleigh:"NC",durham:"NC","chapel hill":"NC",cary:"NC",greensboro:"NC",
  "research triangle":"NC","rtp":"NC",
  nashville:"TN",memphis:"TN",knoxville:"TN",chattanooga:"TN",
  "salt lake city":"UT",provo:"UT",
  columbus:"OH",cleveland:"OH",cincinnati:"OH",dayton:"OH",
  "kansas city":"MO","st. louis":"MO","saint louis":"MO","st louis":"MO",
  indianapolis:"IN",milwaukee:"WI","new orleans":"LA","baton rouge":"LA",
  "oklahoma city":"OK",tulsa:"OK","little rock":"AR",boise:"ID",omaha:"NE",
  wichita:"KS","overland park":"KS",louisville:"KY",lexington:"KY",birmingham:"AL",huntsville:"AL",
  charleston:"SC",columbia:"SC",greenville:"SC",jackson:"MS",
  hartford:"CT",stamford:"CT","new haven":"CT",providence:"RI",manchester:"NH",
  wilmington:"DE",albuquerque:"NM",
  // DC metro — the largest source of "city only" cleared-work JDs.
  arlington:"VA",alexandria:"VA",reston:"VA",herndon:"VA",tysons:"VA","mclean":"VA",
  vienna:"VA",fairfax:"VA",chantilly:"VA",ashburn:"VA",sterling:"VA",dulles:"VA",
  quantico:"VA",richmond:"VA","virginia beach":"VA",norfolk:"VA",
  chesapeake:"VA",charlottesville:"VA",roanoke:"VA",
  baltimore:"MD",bethesda:"MD",rockville:"MD","silver spring":"MD",annapolis:"MD",
  "college park":"MD",gaithersburg:"MD",frederick:"MD",
  "fort meade":"MD","ft. meade":"MD",
  "dmv area":"DC","national capital region":"DC",
};
// Matched with word boundaries so a short key can't hit inside a longer word
// (e.g. "cary" inside "Carytown"). Insertion order decides ties.
const CITY_MATCHERS = Object.keys(CITY_NAMES).map(key => ({
  state: CITY_NAMES[key],
  re: new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
}));

// ── Non-US geography ──────────────────────────────────────────────────────────
// Postings and profiles outside the US carried no US state token, so the location
// bucket silently dropped out of every such score ("job location not specified").
//
// Region codes are ALWAYS country-namespaced: "US-TX", "IN-TN", "CA-ON", or a
// bare ISO country code ("DE", "SG") when only the country is known. The prefix
// is what keeps two-letter collisions apart — Tennessee is "US-TN", Tunisia "TN";
// Delaware "US-DE", Germany "DE"; California "US-CA", Canada "CA".
//
// Sub-region granularity exists where these postings need it (US states, Indian
// states, Canadian provinces). Everywhere else the country is the unit: two cities
// in Germany count as the same location. regionsMatch() handles the mixed case
// (country-only vs country+sub-region).
const INDIA_STATE_NAMES = {
  "andhra pradesh":"IN-AP","arunachal pradesh":"IN-AR",assam:"IN-AS",bihar:"IN-BR",
  chhattisgarh:"IN-CG",chattisgarh:"IN-CG",goa:"IN-GA",gujarat:"IN-GJ",haryana:"IN-HR",
  "himachal pradesh":"IN-HP",jharkhand:"IN-JH",karnataka:"IN-KA",kerala:"IN-KL",
  "madhya pradesh":"IN-MP",maharashtra:"IN-MH",manipur:"IN-MN",meghalaya:"IN-ML",
  mizoram:"IN-MZ",nagaland:"IN-NL",odisha:"IN-OD",orissa:"IN-OD",punjab:"IN-PB",
  rajasthan:"IN-RJ",sikkim:"IN-SK","tamil nadu":"IN-TN",tamilnadu:"IN-TN",
  telangana:"IN-TG",tripura:"IN-TR","uttar pradesh":"IN-UP",uttarakhand:"IN-UK",
  "west bengal":"IN-WB","new delhi":"IN-DL",delhi:"IN-DL","jammu and kashmir":"IN-JK",
  ladakh:"IN-LA",puducherry:"IN-PY",pondicherry:"IN-PY",chandigarh:"IN-CH",
};
// City → state for the metros that actually appear on these postings. Names that
// also name a US city (Salem, Aurora, Columbia) are deliberately left out — the
// country cue can't be relied on to disambiguate them.
const INDIA_CITY_NAMES = {
  chennai:"IN-TN",madras:"IN-TN",coimbatore:"IN-TN",madurai:"IN-TN",
  tiruchirappalli:"IN-TN",trichy:"IN-TN",tirunelveli:"IN-TN",vellore:"IN-TN",
  bengaluru:"IN-KA",bangalore:"IN-KA",mysuru:"IN-KA",mysore:"IN-KA",
  mangaluru:"IN-KA",mangalore:"IN-KA",hubli:"IN-KA",belgaum:"IN-KA",
  hyderabad:"IN-TG",secunderabad:"IN-TG",warangal:"IN-TG","hitec city":"IN-TG",
  vijayawada:"IN-AP",visakhapatnam:"IN-AP",vizag:"IN-AP",tirupati:"IN-AP",guntur:"IN-AP",
  mumbai:"IN-MH",bombay:"IN-MH",pune:"IN-MH","navi mumbai":"IN-MH",thane:"IN-MH",
  nagpur:"IN-MH",nashik:"IN-MH",aurangabad:"IN-MH",
  ahmedabad:"IN-GJ",surat:"IN-GJ",vadodara:"IN-GJ",baroda:"IN-GJ",rajkot:"IN-GJ",
  gandhinagar:"IN-GJ",
  kochi:"IN-KL",cochin:"IN-KL",thiruvananthapuram:"IN-KL",trivandrum:"IN-KL",
  kozhikode:"IN-KL",calicut:"IN-KL",thrissur:"IN-KL",
  kolkata:"IN-WB",calcutta:"IN-WB","salt lake sector v":"IN-WB",siliguri:"IN-WB",
  noida:"IN-UP","greater noida":"IN-UP",ghaziabad:"IN-UP",lucknow:"IN-UP",
  kanpur:"IN-UP",varanasi:"IN-UP",agra:"IN-UP",prayagraj:"IN-UP",allahabad:"IN-UP",
  gurgaon:"IN-HR",gurugram:"IN-HR",faridabad:"IN-HR",panchkula:"IN-HR",
  jaipur:"IN-RJ",udaipur:"IN-RJ",jodhpur:"IN-RJ",
  indore:"IN-MP",bhopal:"IN-MP",jabalpur:"IN-MP",gwalior:"IN-MP",
  patna:"IN-BR",ranchi:"IN-JH",jamshedpur:"IN-JH",bhubaneswar:"IN-OD",
  raipur:"IN-CG",dehradun:"IN-UK",guwahati:"IN-AS",panaji:"IN-GA",
  ludhiana:"IN-PB",amritsar:"IN-PB",mohali:"IN-PB",
};
// Canadian provinces. The two-letter forms are checked against a "City, XX" comma
// the same way US states are, since none of them collide with a US abbreviation.
const CANADA_PROVINCE_ABBRS = new Set(["ON","QC","BC","AB","MB","SK","NS","NB","NL","PE","YT","NT","NU"]);
const CANADA_PROVINCE_NAMES = {
  ontario:"CA-ON",quebec:"CA-QC","québec":"CA-QC","british columbia":"CA-BC",alberta:"CA-AB",
  manitoba:"CA-MB",saskatchewan:"CA-SK","nova scotia":"CA-NS","new brunswick":"CA-NB",
  newfoundland:"CA-NL","prince edward island":"CA-PE",yukon:"CA-YT",
  "northwest territories":"CA-NT",nunavut:"CA-NU",
};
const CANADA_CITY_NAMES = {
  toronto:"CA-ON",ottawa:"CA-ON",mississauga:"CA-ON",brampton:"CA-ON",markham:"CA-ON",
  waterloo:"CA-ON",kitchener:"CA-ON","north york":"CA-ON",oshawa:"CA-ON",windsor:"CA-ON",
  montreal:"CA-QC","montréal":"CA-QC","quebec city":"CA-QC",laval:"CA-QC",gatineau:"CA-QC",
  vancouver:"CA-BC",burnaby:"CA-BC",surrey:"CA-BC",richmond:"CA-BC",kelowna:"CA-BC",
  calgary:"CA-AB",edmonton:"CA-AB",winnipeg:"CA-MB",saskatoon:"CA-SK",regina:"CA-SK",
  halifax:"CA-NS",moncton:"CA-NB","st. john's":"CA-NL",
};
// Country names/aliases → ISO-3166 alpha-2. Canonical name listed first per code:
// the display label is derived from it. Names that are also US places (Georgia)
// or common English words (Chad, Turkey as a noun, Jordan as a surname) are
// omitted rather than risk a false match in JD prose.
const COUNTRY_NAMES = {
  "united states of america":"US","united states":"US",usa:"US","u.s.a.":"US",
  canada:"CA",mexico:"MX",brazil:"BR",brasil:"BR",argentina:"AR",chile:"CL",colombia:"CO",
  peru:"PE",uruguay:"UY","costa rica":"CR",panama:"PA",ecuador:"EC",guatemala:"GT",
  "dominican republic":"DO",paraguay:"PY",bolivia:"BO","puerto rico":"PR",
  "united kingdom":"GB",uk:"GB",england:"GB",scotland:"GB",wales:"GB","northern ireland":"GB",
  "great britain":"GB",ireland:"IE",france:"FR",germany:"DE",deutschland:"DE",spain:"ES",
  portugal:"PT",italy:"IT",netherlands:"NL",holland:"NL",belgium:"BE",luxembourg:"LU",
  switzerland:"CH",austria:"AT",denmark:"DK",norway:"NO",sweden:"SE",finland:"FI",
  iceland:"IS",poland:"PL",czechia:"CZ","czech republic":"CZ",slovakia:"SK",hungary:"HU",
  romania:"RO",bulgaria:"BG",greece:"GR",croatia:"HR",serbia:"RS",slovenia:"SI",
  ukraine:"UA",lithuania:"LT",latvia:"LV",estonia:"EE",russia:"RU",belarus:"BY",
  cyprus:"CY",malta:"MT",albania:"AL","bosnia and herzegovina":"BA","north macedonia":"MK",
  "türkiye":"TR",turkiye:"TR",israel:"IL","united arab emirates":"AE",uae:"AE",
  "saudi arabia":"SA",qatar:"QA",kuwait:"KW",bahrain:"BH",oman:"OM",lebanon:"LB",
  egypt:"EG",morocco:"MA",tunisia:"TN",algeria:"DZ",
  "south africa":"ZA",nigeria:"NG",kenya:"KE",ghana:"GH",ethiopia:"ET",rwanda:"RW",
  uganda:"UG",tanzania:"TZ",
  india:"IN",pakistan:"PK",bangladesh:"BD","sri lanka":"LK",nepal:"NP",bhutan:"BT",
  maldives:"MV",afghanistan:"AF",
  china:"CN","hong kong":"HK",taiwan:"TW",japan:"JP","south korea":"KR",korea:"KR",
  singapore:"SG",malaysia:"MY",indonesia:"ID",thailand:"TH",vietnam:"VN","viet nam":"VN",
  philippines:"PH",cambodia:"KH",myanmar:"MM",laos:"LA",brunei:"BN",mongolia:"MN",
  australia:"AU","new zealand":"NZ",fiji:"FJ",
  kazakhstan:"KZ",uzbekistan:"UZ",armenia:"AM",azerbaijan:"AZ",
};
// Major cities → country, for postings that name only the city ("Hiring in Berlin").
// Deliberately excludes any name that also appears in CITY_NAMES above or names a
// well-known US city (Manchester, Birmingham, Vienna, Athens, Alexandria, Naples,
// Florence, Valencia, Columbia, Salem, Cordoba) — those stay US.
const WORLD_CITY_NAMES = {
  london:"GB",edinburgh:"GB",glasgow:"GB",leeds:"GB",bristol:"GB",cardiff:"GB",
  belfast:"GB",liverpool:"GB",sheffield:"GB",nottingham:"GB","milton keynes":"GB",
  dublin:"IE",galway:"IE",limerick:"IE",
  paris:"FR",lyon:"FR",toulouse:"FR",marseille:"FR",bordeaux:"FR",lille:"FR",nantes:"FR",
  "sophia antipolis":"FR",
  berlin:"DE",munich:"DE","münchen":"DE",hamburg:"DE",frankfurt:"DE",cologne:"DE","köln":"DE",
  stuttgart:"DE","düsseldorf":"DE",dusseldorf:"DE",leipzig:"DE",dresden:"DE",nuremberg:"DE",
  madrid:"ES",barcelona:"ES",seville:"ES",sevilla:"ES",malaga:"ES","málaga":"ES",bilbao:"ES",
  zaragoza:"ES",
  lisbon:"PT",lisboa:"PT",porto:"PT",braga:"PT",
  rome:"IT",milan:"IT",milano:"IT",turin:"IT",torino:"IT",bologna:"IT",palermo:"IT",
  amsterdam:"NL",rotterdam:"NL","the hague":"NL",utrecht:"NL",eindhoven:"NL",
  brussels:"BE",antwerp:"BE",ghent:"BE",leuven:"BE",
  zurich:"CH","zürich":"CH",geneva:"CH",basel:"CH",lausanne:"CH",bern:"CH",zug:"CH",
  salzburg:"AT",graz:"AT",linz:"AT",
  copenhagen:"DK",aarhus:"DK",oslo:"NO",bergen:"NO",trondheim:"NO",
  stockholm:"SE",gothenburg:"SE",gothenberg:"SE","malmö":"SE",
  helsinki:"FI",espoo:"FI",tampere:"FI",oulu:"FI",reykjavik:"IS",
  warsaw:"PL",warszawa:"PL",krakow:"PL","kraków":"PL",wroclaw:"PL","wrocław":"PL",
  gdansk:"PL","gdańsk":"PL",poznan:"PL","poznań":"PL",lodz:"PL",katowice:"PL",
  prague:"CZ",praha:"CZ",brno:"CZ",ostrava:"CZ",bratislava:"SK",kosice:"SK",
  budapest:"HU",debrecen:"HU",
  bucharest:"RO","cluj-napoca":"RO",cluj:"RO",timisoara:"RO","timișoara":"RO",iasi:"RO","iași":"RO",
  sofia:"BG",plovdiv:"BG",varna:"BG",
  thessaloniki:"GR",zagreb:"HR",belgrade:"RS","novi sad":"RS",ljubljana:"SI",
  kyiv:"UA",kiev:"UA",lviv:"UA",kharkiv:"UA",odesa:"UA",odessa:"UA",dnipro:"UA",
  vilnius:"LT",kaunas:"LT",riga:"LV",tallinn:"EE",minsk:"BY",
  moscow:"RU","novosibirsk":"RU",yekaterinburg:"RU",kazan:"RU",
  istanbul:"TR",ankara:"TR",izmir:"TR",
  "tel aviv":"IL",jerusalem:"IL",haifa:"IL",herzliya:"IL","ramat gan":"IL","be'er sheva":"IL",
  dubai:"AE","abu dhabi":"AE",sharjah:"AE",ajman:"AE",doha:"QA",
  riyadh:"SA",jeddah:"SA",dammam:"SA",khobar:"SA","kuwait city":"KW",manama:"BH",muscat:"OM",
  amman:"JO",beirut:"LB",cairo:"EG",giza:"EG",casablanca:"MA",rabat:"MA",marrakech:"MA",
  tunis:"TN",algiers:"DZ",
  lagos:"NG",abuja:"NG","port harcourt":"NG",nairobi:"KE",mombasa:"KE",accra:"GH",
  "cape town":"ZA",johannesburg:"ZA",pretoria:"ZA",durban:"ZA",centurion:"ZA",
  kigali:"RW",kampala:"UG",
  karachi:"PK",lahore:"PK",islamabad:"PK",rawalpindi:"PK",dhaka:"BD",chittagong:"BD",
  colombo:"LK",kandy:"LK",kathmandu:"NP",
  beijing:"CN",shanghai:"CN",shenzhen:"CN",guangzhou:"CN",hangzhou:"CN",chengdu:"CN",
  "xi'an":"CN",wuhan:"CN",suzhou:"CN",nanjing:"CN",tianjin:"CN",dalian:"CN",xiamen:"CN",
  "hong kong":"HK",kowloon:"HK",taipei:"TW",hsinchu:"TW",kaohsiung:"TW",
  tokyo:"JP",osaka:"JP",kyoto:"JP",yokohama:"JP",nagoya:"JP",fukuoka:"JP",sapporo:"JP",kobe:"JP",
  seoul:"KR",busan:"KR",incheon:"KR",pangyo:"KR",daejeon:"KR",
  "kuala lumpur":"MY",penang:"MY","johor bahru":"MY",cyberjaya:"MY",putrajaya:"MY",
  jakarta:"ID",bandung:"ID",surabaya:"ID",denpasar:"ID",yogyakarta:"ID",
  bangkok:"TH","chiang mai":"TH",phuket:"TH",
  hanoi:"VN","ho chi minh":"VN",saigon:"VN","da nang":"VN",danang:"VN","can tho":"VN",
  manila:"PH",makati:"PH",cebu:"PH","quezon city":"PH",taguig:"PH",davao:"PH",pasig:"PH",
  "phnom penh":"KH",yangon:"MM",vientiane:"LA",
  sydney:"AU",melbourne:"AU",brisbane:"AU",perth:"AU",adelaide:"AU",canberra:"AU",
  "gold coast":"AU",hobart:"AU",
  auckland:"NZ",wellington:"NZ",christchurch:"NZ",
  "mexico city":"MX",guadalajara:"MX",monterrey:"MX",tijuana:"MX",queretaro:"MX",
  "querétaro":"MX",merida:"MX",puebla:"MX",
  "sao paulo":"BR","são paulo":"BR","rio de janeiro":"BR",brasilia:"BR","brasília":"BR",
  curitiba:"BR","belo horizonte":"BR",campinas:"BR",recife:"BR","porto alegre":"BR",
  florianopolis:"BR","florianópolis":"BR",fortaleza:"BR",
  "buenos aires":"AR",rosario:"AR",mendoza:"AR",
  santiago:"CL","viña del mar":"CL",bogota:"CO","bogotá":"CO",medellin:"CO","medellín":"CO",
  barranquilla:"CO",lima:"PE",quito:"EC",guayaquil:"EC",montevideo:"UY",asuncion:"PY",
  "san jose costa rica":"CR",heredia:"CR",escazu:"CR","santo domingo":"DO",
  almaty:"KZ",astana:"KZ",tashkent:"UZ",yerevan:"AM",baku:"AZ",
};
// One matcher list, ordered most-specific first: sub-region names and cities
// resolve to "CC-XX" before a bare country name collapses the text to "CC".
const WORLD_MATCHERS = [
  ...Object.entries(INDIA_STATE_NAMES),
  ...Object.entries(INDIA_CITY_NAMES),
  ...Object.entries(CANADA_PROVINCE_NAMES),
  ...Object.entries(CANADA_CITY_NAMES),
].map(([key, code]) => ({
  code,
  re: new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
}));
const WORLD_CITY_MATCHERS = Object.entries(WORLD_CITY_NAMES).map(([key, code]) => ({
  code,
  re: new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
}));
// Upper-cases the first letter of each word. `\b[a-z]` would also fire after a
// non-ASCII letter (\b sits between "ü" and "r"), turning "türkiye" into
// "TÜRkiye" — anchor on an actual word separator instead.
const titleCase = s => s.replace(/(^|[\s,.'’\-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
// Country code → display name, taken from the first (canonical) alias listed.
const COUNTRY_LABELS = {};
for (const name in COUNTRY_NAMES) {
  const code = COUNTRY_NAMES[name];
  if (!COUNTRY_LABELS[code]) COUNTRY_LABELS[code] = titleCase(name);
}
// Sub-region code → display name ("IN-TN" → "Tamil Nadu, India").
const REGION_LABELS = {};
for (const [table, country] of [[INDIA_STATE_NAMES, "India"], [CANADA_PROVINCE_NAMES, "Canada"]]) {
  for (const name in table) {
    const code = table[name];
    if (!REGION_LABELS[code]) REGION_LABELS[code] = `${titleCase(name)}, ${country}`;
  }
}
// "US-TX" → "TX" (the US display the card has always shown), "IN-TN" → "Tamil
// Nadu, India", "DE" → "Germany".
function formatRegion(code) {
  if (!code) return "";
  if (code.startsWith("US-")) return code.slice(3);
  return REGION_LABELS[code] || COUNTRY_LABELS[code] || code;
}
function regionCountry(code) {
  const i = code.indexOf("-");
  return i === -1 ? code : code.slice(0, i);
}
// Same region → match. Different countries → no match. Same country where one
// side is country-only ("DE" vs a hypothetical "DE-BY") → match: a mismatch can't
// be proven, and crossing a border is the constraint that actually matters.
function regionsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (regionCountry(a) !== regionCountry(b)) return false;
  return !a.includes("-") || !b.includes("-");
}
// Non-US lookup: sub-regions and cities first, bare country name last.
function detectWorldRegion(text) {
  for (const m of WORLD_MATCHERS)      if (m.re.test(text)) return m.code;
  return "";
}
// `strict` (JD prose) makes a bare country NAME count only next to a location
// cue or a "City, Country" comma — a description that merely mentions "our India
// team" must not relocate the job. City names stay unconditional: they're
// specific enough, same as the US CITY_MATCHERS above.
function detectWorldFallback(text, strict) {
  for (const m of WORLD_CITY_MATCHERS) if (m.re.test(text)) return m.code;
  for (const name in COUNTRY_NAMES) {
    const key = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = strict
      ? new RegExp(`(?:,\\s*|\\b(?:in|near|located\\s+in|based\\s+in|onsite\\s+in|relocate\\s+to|location\\s*[:\\-–—]?)\\s+)${key}\\b`, "i")
      : new RegExp(`\\b${key}\\b`, "i");
    if (re.test(text)) return COUNTRY_NAMES[name];
  }
  return "";
}
// Two-letter abbreviations that are also common English words or mean something
// else in a JD ("onsite OR remote", "experience IN Java", "LA" = Los Angeles).
// The preposition cue below refuses these; an explicit "Location: OR" still counts.
const WORDLIKE_ABBRS = new Set(["IN", "OR", "OK", "ME", "HI", "DE", "LA"]);
// Extract a country-namespaced region code: "US-TX", "IN-TN", "CA-ON", or a bare
// country code ("DE") when only the country is known. `bareAbbr` allows a lone
// two-letter token — safe for a short controlled string (candidate "City, ST")
// but NOT for JD prose, where words like "IN"/"OR"/"OK" would false-match, so JD
// parsing passes false. Returns "" when nothing is recognized (the location
// bucket then stays out of the score rather than guessing).
//
// Order is most-specific-first: an explicit "City, XX" beats every name table, US
// and known-sub-region names beat bare city names, and a bare country name is the
// last resort so "Chennai, India" resolves to IN-TN rather than a flat IN.
function detectState(text, bareAbbr) {
  if (!text) return "";
  const comma = text.match(/,\s*([A-Za-z]{2})\b/);
  if (comma) {
    const ab = comma[1].toUpperCase();
    if (STATE_ABBRS.has(ab)) return "US-" + ab;
    if (CANADA_PROVINCE_ABBRS.has(ab)) return "CA-" + ab;
  }
  const low = text.toLowerCase();
  // "Washington DC" must beat the plain "washington" → WA state name.
  if (/washington\s*,?\s*d\.?\s*c\.?/.test(low)) return "US-DC";
  // Non-US sub-regions are checked before the US tables: the key sets are disjoint,
  // and an explicit "City, ST" (the only real overlap risk) already returned above.
  const sub = detectWorldRegion(text);
  if (sub) return sub;
  for (const name in STATE_NAMES) if (low.includes(name)) return "US-" + STATE_NAMES[name];
  for (const c of CITY_MATCHERS) if (c.re.test(text)) return "US-" + c.state;
  // Foreign city / country names come after the US tables so a shared name
  // (London KY, Paris TX) keeps resolving to the US place it does today.
  const world = detectWorldFallback(text, !bareAbbr);
  if (world) return world;
  if (bareAbbr) {
    const bare = text.match(/\b([A-Z]{2})\b/);
    if (bare && STATE_ABBRS.has(bare[1])) return "US-" + bare[1];
    return "";
  }
  // JD prose: a lone abbreviation is only trusted when a location cue precedes
  // it, and the token must be uppercase in the source (so the sentence word
  // "in" can't pull a state out of lowercase text).
  const label = text.match(/\b(?:work\s+|job\s+)?location\s*[:\-–—]?\s*([A-Za-z]{2})\b/i);
  if (label && label[1] === label[1].toUpperCase() && STATE_ABBRS.has(label[1])) return "US-" + label[1];
  const cue = text.match(/\b(?:in|near|onsite\s+in|located\s+in|based\s+in|relocate\s+to)\s+([A-Za-z]{2})\b/i);
  if (cue && cue[1] === cue[1].toUpperCase()
      && STATE_ABBRS.has(cue[1]) && !WORDLIKE_ABBRS.has(cue[1])) return "US-" + cue[1];
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
  { rank: 3, label: "Master's",   re: /\b(?:master'?s?|m\.?s\.?c?\.?|m\.?\s?tech\b|m\.?eng\.?|mba|m\.?a\.?|graduate degree)\b/i },
  // "b\.e\.?" needs its dot — bare "BE" would false-match the common word "be"
  // in About/résumé prose that this detector also scans.
  { rank: 2, label: "Bachelor's", re: /\b(?:bachelor'?s?|b\.?s\.?c?\.?|b\.?\s?tech\b|b\.?eng\.?|b\.e\.?|b\.?a\.?|undergraduate degree|four[\s-]?year degree|4[\s-]?year degree)\b/i },
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

// Résumé Education-section slicer — when a résumé is attached, the candidate's
// degree level is read ONLY from the résumé's Education section, never from
// prose elsewhere in the résumé. PDF extraction flattens layout (words joined
// by spaces, one newline per page), so this slices the flowing text from the
// Education heading to the next section heading. Returns "" when no Education
// heading is found. Mirrored verbatim in score_endpoint.py.
const RESUME_EDU_HEADING_RE = /\b(?:education(?:al)?(?:\s+(?:qualifications?|background|details|history))?|academic\s+(?:qualifications?|background|details|history))\b\s*:?/gi;
const RESUME_NEXT_SECTION_RE = /\b(?:(?:work|professional|employment)\s+(?:experience|history)|experience|technical\s+skills|skills|projects?|certifications?|licen[cs]es?|awards?|achievements?|publications?|languages|interests|hobbies|references?|declaration|summary|objective)\b\s*:?/i;
function resumeEducationSection(text) {
  if (!text) return "";
  // Prefer ALL-CAPS ("EDUCATION") or line-start matches — those are real
  // headings, not prose mentions ("passionate about education").
  const matches = [...text.matchAll(RESUME_EDU_HEADING_RE)];
  if (matches.length === 0) return "";
  const pick =
    matches.find(m => m[0] === m[0].toUpperCase()) ||
    matches.find(m => m.index === 0 || text[m.index - 1] === "\n") ||
    matches[0];
  const rest = text.slice(pick.index + pick[0].length);
  const next = rest.search(RESUME_NEXT_SECTION_RE);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

// ── Résumé Skills-section reader ──────────────────────────────────────────────
// findKeywords only ever returns the fixed TOOL_KEYWORDS whitelist, so when a
// résumé replaces the profile's skills every technology outside that list
// (Blazor, RabbitMQ, Entity Framework, SSIS…) was silently dropped. Read the
// résumé's own Skills section verbatim as well and union the two.
const RESUME_SKILLS_HEADING_RE =
  /\b(?:technical\s+skills|technical\s+expertise|technical\s+proficienc(?:y|ies)|core\s+competenc(?:y|ies)|skills\s*(?:&|and)\s*(?:tools|technologies|abilities)|key\s+skills|skills|technologies|tech\s+stack)\b\s*:?/gi;
const RESUME_SKILLS_NEXT_RE =
  /\b(?:(?:work|professional|employment)\s+(?:experience|history)|experience|education|academic|projects?|certifications?|licen[cs]es?|awards?|achievements?|publications?|interests|hobbies|references?|declaration|summary|objective)\b\s*:?/i;

// Separators inside a skills block: commas, pipes, slashes-with-space, bullets,
// semicolons, newlines. A bare "/" is NOT a separator — "CI/CD" is one skill.
// Two-or-more spaces is a column gap left by the PDF/DOCX extractors, not a
// space inside a phrase — "Machine Learning" keeps its single space.
const SKILL_SPLIT_RE = /[,;|•·▪●•\n\r\t]+|\s+[-–—]\s+|\s{2,}/;

function resumeListedSkills(text) {
  if (!text) return [];
  const matches = [...text.matchAll(RESUME_SKILLS_HEADING_RE)];
  if (matches.length === 0) return [];
  // Résumés routinely split their skills over several headings ("TECHNICAL
  // SKILLS" then "Tools & Technologies"); reading only the first one dropped
  // every later block. Take every match that reads like a real heading (ALL-CAPS
  // or line-start) and union their sections, falling back to the first prose
  // mention only when none of them qualify.
  let heads = matches.filter(
    m => m[0] === m[0].toUpperCase() || m.index === 0 || text[m.index - 1] === "\n"
  );
  if (heads.length === 0) heads = [matches[0]];

  const out = [];
  for (let i = 0; i < heads.length; i++) {
    const head = heads[i];
    // Stop before the following skills heading too, else that heading's own
    // words ("Tools & Technologies") get read as a skill.
    const limit = heads[i + 1] ? heads[i + 1].index : text.length;
    for (const skill of skillsFromSection(text.slice(0, limit), head)) {
      if (!out.some(s => s.toLowerCase() === skill.toLowerCase())) out.push(skill);
      if (out.length >= 120) return out;   // runaway section guard
    }
  }
  return out;
}

// Slice one skills block starting after `head` and split it into entries.
function skillsFromSection(text, head) {
  const rest = text.slice(head.index + head[0].length);
  // End the block at the next section — but only where that word reads like a
  // heading. A plain `search` ended the block on inline prose ("Java — 5 years
  // experience"), truncating everything listed after it.
  let end = rest.length;
  const nextRe = new RegExp(RESUME_SKILLS_NEXT_RE.source, "gi");
  let m;
  while ((m = nextRe.exec(rest)) !== null) {
    if (m.index === 0 || rest[m.index - 1] === "\n" || m[0] === m[0].toUpperCase()) {
      end = m.index;
      break;
    }
  }
  const section = rest.slice(0, end).trim();
  if (!section) return [];

  const out = [];
  for (let raw of section.split(SKILL_SPLIT_RE)) {
    // Drop a leading category label ("Languages: Java Python" → "Java Python").
    raw = raw.replace(/^[^:]{0,40}:\s*/, "").trim();
    // Strip list punctuation and trailing "(5 yrs)" style annotations.
    raw = raw.replace(/\(.*?\)/g, " ").replace(/^[^A-Za-z0-9+#.]+|[^A-Za-z0-9+#)]+$/g, "").trim();
    raw = raw.replace(/\s+/g, " ");
    if (!isPlausibleSkill(raw)) continue;
    if (isSkillsHeading(raw)) continue;   // a sub-heading inside the block, not a skill
    if (!out.some(s => s.toLowerCase() === raw.toLowerCase())) out.push(raw);
  }
  return out;
}

// True when the whole entry is nothing but heading words ("Tools & Technologies",
// "Tech Stack") — a sub-heading the split picked up, not a skill.
function isSkillsHeading(s) {
  const bare = s.replace(/^[\s&|:-]+|[\s&|:-]+$/g, "");
  const re = new RegExp(`^(?:${RESUME_SKILLS_HEADING_RE.source})$`, "i");
  if (re.test(bare)) return true;
  // "Tools & Technologies" / "Skills and Tools": every word is heading filler.
  const filler = /^(?:tools?|technolog(?:y|ies)|skills?|stack|tech|core|key|technical|expertise|competenc(?:y|ies)|proficienc(?:y|ies)|abilities|&|and)$/i;
  const words = bare.split(/[\s&]+/).filter(Boolean);
  return words.length > 0 && words.every(w => filler.test(w));
}

// Single-letter language names the length floor would otherwise throw away.
const ONE_CHAR_SKILLS = new Set(["c", "r"]);

// A skills list holds short noun phrases, not sentences. Reject anything that
// reads like prose so résumé narrative can't leak into the skill set.
function isPlausibleSkill(s) {
  if (!s) return false;
  if (s.length === 1) return ONE_CHAR_SKILLS.has(s.toLowerCase());
  if (s.length > 40) return false;
  if (!/[A-Za-z]/.test(s)) return false;                     // "5+" etc.
  if (s.split(/\s+/).length > 4) return false;               // sentence fragment
  if (/\b(?:and|with|the|for|of|in|to|using|experience|years?)\b/i.test(s)) return false;
  return true;
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
      title:            candidate.title || "",   // headline — backend scans it for clearance
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
      // Full experience descriptions — backend scans them so a JD skill only
      // mentioned in role bullets (not the Skills section) still matches.
      experience_text:  (candidate.experience || [])
                          .map(e => e && e.description).filter(Boolean).join("\n"),
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

// Lexical scan of raw candidate text (experience descriptions, or the résumé
// when one is attached) — a JD skill counts as matched when its phrase appears
// in that text, so skills only written up in role bullets (never listed in the
// Skills section, and outside the TOOL_KEYWORDS whitelist) still score.
// Ambiguous names (Go, Rust, Spark…) match case-sensitively against the raw
// text so prose ("go through logs") doesn't give false credit.
// Mirrored verbatim in score_endpoint.py.
function makeTextMatcher(rawText) {
  const raw  = " " + String(rawText || "") + " ";
  const text = " " + normalizeSkill(rawText) + " ";
  if (!text.trim()) return () => false;
  const escWord = w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const phraseRe = (s) => {
    // A skill that starts with punctuation (".NET") carries its own left
    // boundary — demanding a non-alphanumeric char before it missed every
    // "ASP.NET" / "VB.NET" mention in a résumé.
    const lead = /^[A-Za-z0-9]/.test(s) ? "(?:^|[^A-Za-z0-9])" : "";
    return new RegExp(`${lead}${s.split(/\s+/).map(escWord).join("\\s+")}(?:$|[^A-Za-z0-9+#])`);
  };
  return (target) => {
    // Match the target's canonical + raw forms AND every alias variant that
    // canonicalizes to it — the text may use the alias ("k8s") while the JD
    // uses the full name ("Kubernetes"), or vice versa.
    const tn = canonicalSkill(target);
    const forms = new Set([tn, normalizeSkill(target)]);
    for (const [alias, canon] of SKILL_ALIASES) if (canon === tn) forms.add(alias);
    for (const f of forms) {
      if (!f) continue;
      const csKeyword = [...CASE_SENSITIVE_KEYWORDS].find(k => k.toLowerCase() === f);
      if (csKeyword) {
        if (phraseRe(csKeyword).test(raw)) return true;
      } else if (phraseRe(f).test(text)) {
        return true;
      }
    }
    return false;
  };
}

async function computeScore(requirements, jobTitle, candidate, resumeText = "") {
  const { required_skills, preferred_skills, required_years } = requirements;
  const cSkills  = candidate.skills || [];
  const expYears = candidate.experience_years || 0;

  // Text scanned for skills beyond the skills list: résumé replaces the profile
  // (same authority rule as the skills-replace above), else every experience
  // description is read for skill mentions.
  const textHas = makeTextMatcher(
    resumeText ||
    (candidate.experience || []).map(e => e && e.description).filter(Boolean).join("\n")
  );

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
    }) || textHas(target); // skill written up in experience bullets / résumé text
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
    candidate.title,   // headline often states the clearance, e.g. "Java Developer | TS/SCI"
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
  // level read from the Education section entries ONLY — About/résumé prose is
  // excluded so a stray "master's"/"degree" mention can't inflate the level.
  const reqEdu  = requirements.required_education || { rank: 0, label: "" };
  const eduText = (candidate.education || [])
    .map(e => `${e.degree || ""} ${e.school || ""}`).join("\n");
  const candEdu = detectEducation(eduText);
  const educationActive = reqEdu.rank > 0;
  const educationFill = !educationActive ? 0
    : candEdu.rank >= reqEdu.rank ? 1
    : candEdu.rank > 0            ? 0.5
    :                              0;

  // Location bucket — active when the JD is remote, or both JD and candidate
  // regions are known. Remote → location is not a constraint (full credit); same
  // region → full; different region → zero (penalized). Unknown either side and
  // not remote → bucket stays out (no penalty for missing data). Regions are
  // country-namespaced, so this works the same for "US-TX" and "IN-TN".
  const jdRemote  = !!requirements.jd_remote;
  const jdState   = requirements.jd_state || "";
  const candState = detectState(candidate.location || "", true);
  const locationActive = jdRemote || (!!jdState && !!candState);
  const locationFill = jdRemote ? 1 : (regionsMatch(jdState, candState) ? 1 : 0);

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
  const jdLoc = jdRemote ? "Remote" : formatRegion(jdState);
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
      fill: locationFill, detected: formatRegion(candState) || (candidate.location || "").trim() || "Unknown", required: jdLoc || "Any" },
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
    const jdName   = formatRegion(jdState);
    const candName = formatRegion(candState);
    parts.push(!candState
      ? (candLoc
          ? `Located in ${candLoc}; job located in ${jdName}.`
          : `Candidate location unknown; job located in ${jdName}.`)
      : regionsMatch(jdState, candState)
        ? `Located in ${candName} — matches the ${jdName} job location.`
        : `Located in ${candName}, outside the ${jdName} job location.`);
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
    // Whitelist hits (any section of the résumé) ∪ the résumé's own Skills
    // section read verbatim — the whitelist alone drops every technology it
    // doesn't already know about.
    const listed = resumeListedSkills(resume_text);
    const seen = new Set();
    const resumeSkills = [...findKeywords(resume_text), ...listed]
      .filter(s => { const k = s.toLowerCase(); return seen.has(k) ? false : seen.add(k); });
    console.log(`[SCOUT] résumé skills: ${resumeSkills.length} (${listed.length} from Skills section)`);
    if (resumeSkills.length > 0) scored = { ...candidate, skills: resumeSkills };
    // Résumé also replaces education — but ONLY its Education section text, so
    // degree words in résumé prose can't inflate the level. Guard: no Education
    // heading found keeps the profile's Education-section entries.
    const resumeEdu = resumeEducationSection(resume_text);
    if (resumeEdu) scored = { ...scored, education: [{ degree: resumeEdu, school: "" }] };
  }

  // 1) Backend scoring (consistent across devices).
  const backend = await backendScore(jd_id, scored, resume_text);
  if (backend) {
    // Which buckets the BACKEND marked active — the breakdown card renders only
    // these, so a missing row (e.g. location) is a backend decision, not a UI bug.
    console.log("[SCOUT] score source: backend | buckets:",
      (backend.categories || []).map(c => `${c.key}=${c.active ? "on" : "off"}`).join(" ") || "none",
      "| candidate location:", scored.location || "(none)");
    return { ...backend, source: "backend" };
  }

  // 2) Local fallback (per-device embeddings — may differ across browsers).
  let cached = jobCache.get(jd_id);
  if (!cached) {
    const job = await scoutGetJson(`/api/scout/jobs/${jd_id}`);
    if (job.error) throw new Error(job.error);
    const requirements = parseRequirements(job.description || "");
    // The posting's structured city/state outrank whatever the description prose
    // implies — prose is a guess, the intake fields are what was entered. Only
    // override when set, so a blank intake keeps a location the JD text stated.
    const structState = detectState([job.city, job.state].filter(Boolean).join(", "), true);
    if (structState) requirements.jd_state = structState;
    // Last resort: many postings carry the city only in the title
    // ("… (Python / FastAPI) - Chennai · Chennai, India"). bareAbbr stays false so
    // a title word like "IN" can't be read as Indiana.
    if (!requirements.jd_state) requirements.jd_state = detectState(job.title || "", false);
    cached = { title: job.title, requirements };
    jobCache.set(jd_id, cached);
  }
  const result = await computeScore(cached.requirements, cached.title, scored, resume_text);
  console.log("[SCOUT] score source: local | buckets:",
    (result.categories || []).map(c => `${c.key}=${c.active ? "on" : "off"}`).join(" "),
    "| jd_state:", cached.requirements.jd_state || "(none)",
    "| jd_remote:", !!cached.requirements.jd_remote,
    "| candidate location:", scored.location || "(none)");
  return { ...result, source: "local" };
}

// ── Job list fetch + cache ────────────────────────────────────────────────────
// The /api/scout/jobs call is the slow part of opening the panel (Azure cold
// start). Cache the mapped list in storage.local so repeat opens populate the
// dropdown instantly, then revalidate in the background.

const JOBS_CACHE_KEY = "scout_jobs_cache";

async function fetchJobs() {
  const data = await scoutGetJson(`/api/scout/jobs`);
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
chrome.runtime.onStartup?.addListener(() => { refreshJobsCache(); ensureOffscreen().catch(() => {}); });
chrome.runtime.onInstalled?.addListener(() => { refreshJobsCache(); });

// ── Pre-fetch all job descriptions in background ──────────────────────────────
// Called after GET_JDS returns. Populates jobCache so GET_SCORE is instant.

async function prefetchJobDescriptions(jobs) {
  await Promise.allSettled(jobs.map(async (job) => {
    try {
      const data = await scoutGetJson(`/api/scout/jobs/${job.id}`);
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

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Relay MODEL_READY from offscreen → all popup tabs so the loading status clears.
  if (message?.target === "sw" && message?.type === "MODEL_READY") {
    chrome.runtime.sendMessage({ type: "MODEL_READY" }).catch(() => {});
    return;
  }
  if (message?.target === "offscreen-embed" || message?.target === "offscreen-embed-status" || message?.target === "offscreen-pdf") return;
  const { type, payload } = message;

  // ── GET_CONFIG — which backend is this build talking to? The panel uses it
  // to show a LOCAL badge so a dev session is never mistaken for production.
  // The worker owns the config (it does the importScripts), so pages ask it
  // rather than loading the possibly-absent config.local.js themselves. ──────
  if (type === "GET_CONFIG") {
    sendResponse({ ok: true, baseUrl: BASE_URL });
    return;
  }

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
        const { job_id, job_title, candidate, resume_b64, resume_name, resume_mime, candidate_source,
                override_note, override_score } = payload;
        const jazzhr_token = await getJazzhrToken();
        // Sourcing channel ("LinkedIn" / "Dice.com") — sent top-level as well as on
        // the candidate; the backend normalizes it into scout_candidates.candidate_source
        // for the dashboard chip.
        const r = await fetch(`${BASE_URL}/api/scout/candidates`, {
          method:  "POST",
          headers: scoutHeaders(),
          body:    JSON.stringify({ job_id, job_title, candidate, resume_b64, resume_name, resume_mime, jazzhr_token,
                                    candidate_source: candidate_source || candidate?.source || "",
                                    // Set only when the recruiter added below the fit-score
                                    // floor; the backend files it on the candidate timeline.
                                    override_note, override_score }),
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
});
