const BASE_URL = "https://scout-service.wonderfulfield-ebc060c9.eastus.azurecontainerapps.io";

// Shared secret for the Scout backend endpoints (extension has no Microsoft SSO token).
// Sent as X-Scout-Key on every Scout API call. Must match SCOUT_API_KEY on the server.
const SCOUT_KEY = "scout_a5ThvEKUjRbZmlpDyKQOF9WcKb2fiEl8Vat-8f_3Bzg";

// Standard JSON headers + Scout key for all backend calls.
function scoutHeaders(extra) {
  return { "Content-Type": "application/json", "X-Scout-Key": SCOUT_KEY, ...(extra || {}) };
}

// GET a Scout JSON endpoint. When the host answers with an HTML page instead —
// an Azure error page, an auth redirect, or a deploy where the Scout routes are
// missing — r.json() throws the useless "Unexpected token '<'". Report the
// status and path so the panel says what actually broke.
// `priority: "low"` marks background warm-up traffic so the browser schedules a
// recruiter-facing request (a score) ahead of it.
async function scoutGetJson(path, { priority } = {}) {
  const r    = await fetch(`${BASE_URL}${path}`, { headers: scoutHeaders(), ...(priority ? { priority } : {}) });
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

// Trailing words that describe the SHAPE of a skill rather than the skill
// itself. A JD writes "Fast API framework", "microservices architecture" and
// "API development" for the same things it elsewhere calls "FastAPI",
// "Microservices" and "API" — all three then rendered as separate chips beside
// the plain name. Strip the qualifier ONLY when what remains is itself a skill
// we know, so genuine compounds survive: "database design", "system
// architecture" and "ORM tools" stay whole because "database", "system" and
// "ORM" are not skills on their own.
// A JD also writes the same tool as "CI/CD pipelines", "Docker containers",
// "AWS cloud services" and "Salesforce Administrator", each of which showed up
// as its own chip beside the plain name, so the container/role tails are peeled
// on the same known-remainder rule.
const SKILL_QUALIFIER_TAIL_RE =
  /\s+(?:frameworks?|librar(?:y|ies)|technolog(?:y|ies)|tools?|stack|architecture|development|programming|design|concepts?|principles?|practices?|fundamentals|methodolog(?:y|ies)|management|services?|solutions?|platforms?|pipelines?|containers?|clusters?|suites?|ecosystems?|administration|administrator|cloud)$/;

// Tails that carry no meaning at all — "data warehousing concepts" and "data
// warehousing" are the same requirement, and "communication skills" is only a
// soft trait once the tail is off. These peel unconditionally, so they are
// stripped from the phrase itself and not merely from the match key.
const SKILL_NOISE_TAIL_RE =
  /\s+(?:concepts?|principles?|fundamentals|best\s+practices|expertise|proficienc(?:y|ies)|knowledge|skills?|abilit(?:y|ies)|experience)$/i;

// Every skill name the whitelist and the alias map know, normalized. Built
// lazily because TOOL_KEYWORDS is declared below this point.
let KNOWN_SKILLS = null;
function knownSkills() {
  if (!KNOWN_SKILLS) {
    KNOWN_SKILLS = new Set();
    for (const k of TOOL_KEYWORDS) KNOWN_SKILLS.add(normalizeSkill(k));
    for (const [alias, target] of SKILL_ALIASES) { KNOWN_SKILLS.add(alias); KNOWN_SKILLS.add(target); }
  }
  return KNOWN_SKILLS;
}

function canonicalSkill(s) {
  let n = normalizeSkill(s);
  n = SKILL_ALIASES.get(n) || n;
  // Peel qualifier tails looking for a known skill ("fast api framework" → "fast
  // api" → alias → "fastapi"). Intermediates need not themselves be skills —
  // "aws cloud services" only reaches "aws" by way of "aws cloud" — but the peel
  // is only KEPT if it lands on a name we know, so genuine compounds survive
  // whole ("database design", "ORM tools").
  let probe = n.replace(SKILL_NOISE_TAIL_RE, "").trim() || n;
  for (let i = 0; i < 3 && !knownSkills().has(probe); i++) {
    const stripped = probe.replace(SKILL_QUALIFIER_TAIL_RE, "");
    if (stripped === probe || !stripped) break;
    probe = stripped;
  }
  if (knownSkills().has(probe)) n = SKILL_ALIASES.get(probe) || probe;
  else n = n.replace(SKILL_NOISE_TAIL_RE, "").trim() || n;
  return n;
}

// ── Parse "What You'll Need" section → structured requirements ────────────────

const TOOL_KEYWORDS = [
  "AWS","Azure","GCP","Docker","Kubernetes","Terraform","Jenkins","CI/CD","Linux","Ansible","Helm",
  "Java","Python","JavaScript","TypeScript","React","Angular","Vue","Spring Boot","Node.js","Flask","Django","FastAPI",".NET","C#","C++","Go","Rust","GraphQL",
  "SQL","Power BI","Power Apps","Power Automate","SharePoint","DAX","Power Query","Spark","ETL","Kafka","dbt","Airflow","Databricks","Snowflake","Tableau","Looker","MongoDB","PostgreSQL","MySQL","Redis","Elasticsearch","Neo4j",
  "LLM","GPT","OpenAI","LangChain","TensorFlow","PyTorch","Scikit","RAG",
  "Top Secret","TS/SCI","Secret clearance","FISMA","FedRAMP","NIST","DISA","STIGs",
  "REST","API","Microservices","Git","Maven","Hibernate","JUnit","Selenium","Agile","Scrum","Jira","ServiceNow","Salesforce","AEM",
  // Whatever the whitelist omits can only be caught by a cue-phrase enumeration
  // (JD) or a Skills section (résumé); a stack named in plain prose was dropped
  // entirely. These are the stacks that kept showing up as misses.
  "Kotlin","Swift","PHP","Ruby","Rails","Scala","Perl","MATLAB","Bash","PowerShell","HTML","CSS","SASS",
  "ASP.NET","Blazor","Entity Framework","WPF","WinForms","Xamarin","MAUI","LINQ","NuGet",
  "Next.js","Express","NestJS","Svelte","jQuery","Redux","Bootstrap","Tailwind","Webpack","Vite",
  "SQL Server","SSIS","SSRS","SSAS","Oracle","DB2","SQLite","DynamoDB","Cassandra","Cosmos DB","Couchbase",
  "Hadoop","Hive","Presto","Flink","NiFi","Informatica","Talend","SSMS","Alteryx","Qlik","SAS",
  "Pandas","NumPy","Keras","Hugging Face","MLflow","SageMaker","Vertex AI","Bedrock","NLP","Computer Vision",
  "GitHub Actions","GitLab CI","Azure DevOps","ArgoCD","CircleCI","Bamboo","Octopus","Puppet","TeamCity",
  "Prometheus","Grafana","Datadog","Splunk","ELK","New Relic","Dynatrace","AppDynamics","Nagios",
  "OpenShift","Rancher","Istio","Service Mesh","Lambda","EC2","S3","EKS","ECS","RDS","CloudFormation",
  "RabbitMQ","ActiveMQ","SQS","Event Hubs","Service Bus","gRPC","SOAP","WebSockets","Swagger","OpenAPI",
  "OAuth","SAML","OIDC","Okta","Active Directory","Entra","Cognito","Vault","Zero Trust","SIEM",
  "Postman","Cypress","Playwright","TestNG","Cucumber","JMeter","Appium","Jasmine","Jest","Mocha",
  "Confluence","Bitbucket","Kanban","Figma","Workday","SAP","Dynamics 365","Sitecore","WordPress","Snowpark"
];

// Short keywords that double as common English words — match case-sensitively
// so "trusted" doesn't hit Rust, "go through" doesn't hit Go, etc.
const CASE_SENSITIVE_KEYWORDS = new Set([
  "Go","Rust","React","Spark","Helm","DAX","RAG","Secret clearance",
  // Same trap in the widened list: "express shipping", "we sap morale",
  // "puppet regime", "off the rails", "bedrock of the team".
  // Only genuine English-word collisions belong here — a name that is never an
  // ordinary word (Redux, Kanban, Perl, API…) must stay case-INsensitive, or a
  // résumé that writes it lowercase stops matching.
  "Swift","Express","Vault","Hive","Bedrock","Rails","Bamboo","Puppet","Cucumber","Jasmine","Mocha",
  "Presto","SAP","SAS",
]);

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
// Required/preferred headings. Navitas JDs use "What You'll Need" / "Set Yourself
// Apart", but LinkedIn and Dice postings use the generic ATS wording — matching
// only the Navitas phrasing meant the preferred section was never found on an
// outside posting, so Preferred skills always came back empty.
const JD_REQUIRED_HEADING_RE =
  /What\s+You\s*'?\s*ll?\s*'?\s*(?:Need|Bring|Have|Do)|(?:Basic|Minimum|Required|Core)\s+Qualifications?|Required\s+(?:Skills?|Experience)|Requirements?|Qualifications?|Must[\s-]?Haves?|Skills?\s+(?:&|and)\s+(?:Experience|Qualifications?)|What\s+We\s*(?:'|\s)?re\s+Looking\s+For/i;
const JD_PREFERRED_HEADING_RE =
  /Set\s+Yourself\s+Apart|Preferred\s+(?:Qualifications?|Skills?|Experience)|Nice[\s-]?to[\s-]?Haves?|Good\s+to\s+Haves?|Bonus\s+Points?|Desired\s+(?:Skills?|Qualifications?|Experience)|Plus(?:s)?es\s*:/i;

// Section terminators: the preferred headings (so the required slice stops before
// them) plus the boilerplate that follows the requirements.
const NEXT_HEADING_RE = new RegExp(
  JD_PREFERRED_HEADING_RE.source +
  "|Clearance\\s*:|About\\s+(?:Navitas|Us|the\\s+Company)|What\\s+We\\s+Offer|Equal\\s+Opportunity" +
  "|Who\\s+We\\s+Are|Benefits\\s*:|Compensation|Salary\\s+Range|How\\s+to\\s+Apply|Perks",
  "i"
);
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

// One rationale sentence for the location bucket. Shared by the local scorer and
// the backend-location repair so both word it identically. Returns "" when the
// JD expresses no location at all — nothing truthful to say.
function locationSentence(jdRemote, jdState, candState, candLocationRaw) {
  if (jdRemote) return "Remote role — location not a constraint.";
  if (!jdState) return "";
  const candLoc  = (candLocationRaw || "").trim();
  const jdName   = formatRegion(jdState);
  const candName = formatRegion(candState);
  if (!candState) {
    return candLoc
      ? `Located in ${candLoc}; job located in ${jdName}.`
      : `Candidate location unknown; job located in ${jdName}.`;
  }
  return regionsMatch(jdState, candState)
    ? `Located in ${candName} — matches the ${jdName} job location.`
    : `Located in ${candName}, outside the ${jdName} job location.`;
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
// Résumés name this section a dozen different ways ("AREAS OF EXPERTISE",
// "SKILL SET", "TECHNICAL SUMMARY", "PROGRAMMING LANGUAGES"); matching only the
// handful of literal phrases meant those résumés yielded zero listed skills, so
// everything outside TOOL_KEYWORDS was dropped. Build the alternation from an
// optional qualifier + a head noun + an optional trailing "summary/profile/set"
// so the variants fall out of one pattern.
const RESUME_SKILLS_HEADING_RE =
  /\b(?:areas?\s+of\s+(?:expertise|specialization)|(?:technical|technolog(?:y|ies)|tech)\s+summary|programming\s+languages|(?:(?:technical|core|key|professional|computer|it|software|programming|engineering|relevant)\s+)?(?:skills?\s*(?:&|and)\s*(?:tools|technologies|abilities|expertise)|skill\s*set|skills?|expertise|proficienc(?:y|ies)|competenc(?:y|ies)|technolog(?:y|ies)|tech(?:nical)?\s*stack)(?:\s+(?:summary|profile|set|matrix))?)\b\s*:?/gi;
const RESUME_SKILLS_NEXT_RE =
  /\b(?:(?:work|professional|employment)\s+(?:experience|history)|experience|education|academic|projects?|certifications?|licen[cs]es?|awards?|achievements?|publications?|interests|hobbies|references?|declaration|summary|objective)\b\s*:?/i;

// Separators inside a skills block: commas, pipes, slashes-with-space, bullets,
// semicolons, newlines. A bare "/" is NOT a separator — "CI/CD" is one skill.
// Two-or-more spaces is a column gap left by the PDF/DOCX extractors, not a
// space inside a phrase — "Machine Learning" keeps its single space.
const SKILL_SPLIT_RE = /[,;|•·▪●•\n\r\t]+|\s+[-–—]\s+|\s{2,}/;

// ── Heading detection ─────────────────────────────────────────────────────────
// Every section slicer needs the same answer: "is this word a heading, or is it
// prose that happens to use the heading's word?" The old test accepted ANY
// ALL-CAPS match, wherever it sat on the line — so a skills row spelled
// "CLOUD EXPERIENCE: AWS, Azure" ended the Skills block at "EXPERIENCE" and
// every skill after that row was dropped. Line position is the reliable signal
// whenever the extractor produced real lines; the ALL-CAPS guess is only a
// fallback for text that came back flattened (no line breaks to read).
function hasLineStructure(text) {
  return (text.match(/\n/g) || []).length >= 3;
}

// True when the match at `idx` starts its own line (leading bullets/whitespace
// allowed). `heading` is the matched text, used only for the flattened fallback.
function isHeadingMatch(text, idx, heading, flattened) {
  if (idx === 0) return true;
  const lineStart = text.lastIndexOf("\n", idx - 1) + 1;
  if (/^[\s\-*•·▪●]*$/.test(text.slice(lineStart, idx))) return true;
  // Flattened text has no line breaks to test — fall back to ALL-CAPS, but only
  // when the word is not part of a longer ALL-CAPS phrase ("CLOUD EXPERIENCE").
  if (!flattened) return false;
  if (heading !== heading.toUpperCase()) return false;
  const before = text.slice(Math.max(0, idx - 30), idx);
  return !/[A-Z0-9][A-Z0-9&+/.#-]*\s+$/.test(before);
}

function resumeListedSkills(text) {
  if (!text) return [];
  const matches = [...text.matchAll(RESUME_SKILLS_HEADING_RE)];
  if (matches.length === 0) return [];
  // Résumés routinely split their skills over several headings ("TECHNICAL
  // SKILLS" then "Tools & Technologies"); reading only the first one dropped
  // every later block. Take every match that reads like a real heading (ALL-CAPS
  // or line-start) and union their sections, falling back to the first prose
  // mention only when none of them qualify.
  const flattened = !hasLineStructure(text);
  let heads = matches.filter(m => isHeadingMatch(text, m.index, m[0], flattened));
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
  const flattened = !hasLineStructure(rest);
  const nextRe = new RegExp(RESUME_SKILLS_NEXT_RE.source, "gi");
  let m;
  while ((m = nextRe.exec(rest)) !== null) {
    if (isHeadingMatch(rest, m.index, m[0], flattened)) {
      end = m.index;
      break;
    }
  }
  const section = rest.slice(0, end).trim();
  if (!section) return [];

  const out = [];
  const add = (s) => {
    if (!isPlausibleSkill(s)) return;
    if (isSkillsHeading(s)) return;   // a sub-heading inside the block, not a skill
    if (!out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s);
  };
  const parts = section.split(SKILL_SPLIT_RE);
  for (let i = 0; i < parts.length; i++) {
    let raw = parts[i];
    // A category label and its values are often split apart by the column gap
    // ("Languages" ⟂ ": C#, VB.NET"), which left the label itself sitting in the
    // list as a skill. A fragment whose values begin in the NEXT entry is a
    // label — drop it, and drop the colon the next entry now starts with.
    if (/:\s*$/.test(raw)) continue;
    if (/^\s*:/.test(parts[i + 1] || "")) continue;
    raw = raw.replace(/^\s*:\s*/, "");
    // Drop a leading category label ("Languages: Java Python" → "Java Python").
    raw = raw.replace(/^[^:]{0,40}:\s*/, "").trim();
    // Strip list punctuation and trailing "(5 yrs)" style annotations.
    raw = raw.replace(/\(.*?\)/g, " ").replace(/^[^A-Za-z0-9+#.]+|[^A-Za-z0-9+#)]+$/g, "").trim();
    raw = raw.replace(/\s+/g, " ");
    add(raw);
    // "HTML5/CSS3/JavaScript" is three skills written as one entry, but "CI/CD"
    // and "TCP/IP" are single skills — the difference is segment length, so keep
    // the whole entry and additionally split only when every segment is a word.
    if (raw.includes("/")) {
      const segs = raw.split("/").map(s => s.trim());
      if (segs.length > 1 && segs.every(s => s.length >= 3)) segs.forEach(add);
    }
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
  // The category labels résumés use inside a skills block ("Languages",
  // "Frameworks", "Databases", "Methodologies") are filler too — without them
  // the label rows were scored as if they were skills.
  const filler = /^(?:tools?|technolog(?:y|ies)|skills?|stack|tech|core|key|technical|expertise|competenc(?:y|ies)|proficienc(?:y|ies)|abilities|languages?|frameworks?|librar(?:y|ies)|databases?|platforms?|environments?|methodolog(?:y|ies)|practices?|concepts?|paradigms?|web|frontend|front[\s-]?end|backend|back[\s-]?end|other|misc(?:ellaneous)?|&|and)$/i;
  const words = bare.split(/[\s&]+/).filter(Boolean);
  return words.length > 0 && words.every(w => filler.test(w));
}

// A token still wearing the punctuation it was split beside — "etc.)", "(secure",
// "scalable," — never matched SKILL_STOPWORDS, which is an exact-set lookup, so
// the boilerplate word walked straight into the skill list. Peel the edges only:
// "node.js" and "c++" must survive as themselves.
function stopwordToken(t) {
  return String(t).toLowerCase().replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "");
}

// Single-letter language names the length floor would otherwise throw away.
const ONE_CHAR_SKILLS = new Set(["c", "r"]);

// Verbs the enumeration splitter leaves stranded at the head of a fragment
// ("…FastAPI to design and build scalable" → "build scalable"). Only words that
// are never nouns belong here — "design", "test", "support" and "architect"
// lead real skill names ("design patterns", "test automation"), so they stay out.
const SKILL_LEADING_VERBS = new Set([
  "build","develop","create","implement","maintain","manage","deliver","drive",
  "ensure","deploy","optimize","integrate","troubleshoot","translate","partner",
  "contribute","participate","perform","provide","handle","understand","utilize",
  "leverage","collaborate","assist","enable","execute","oversee","spearhead",
]);

// Marketing adjectives + the generic outcome nouns they attach to. Together they
// name what the work produces ("high-performance backend systems", "scalable
// solutions"), never a skill a résumé can list. Either half alone is fine —
// "distributed systems" and "scalable system design" are real skills — so both
// must be present before the phrase is rejected.
const SKILL_PUFF_ADJ_RE =
  /(?:^|\s|-)(?:high[\s-]?performance|performant|scalable|robust|reliable|efficient|resilient|seamless|cutting[\s-]?edge|world[\s-]?class|best[\s-]?in[\s-]?class|enterprise[\s-]?grade|mission[\s-]?critical|state[\s-]?of[\s-]?the[\s-]?art|innovative|large[\s-]?scale|next[\s-]?gen(?:eration)?)(?:$|\s|-)/i;
const SKILL_OUTCOME_TAIL_RE =
  /(?:^|\s)(?:systems?|solutions?|applications?|apps?|environments?|products?|processes?|workflows?|capabilities|features?|deliverables?|initiatives?|experiences?)$/i;

// Interpersonal traits. Every JD lists them and no stack can be matched against
// them, so scoring them was pure noise on both sides — "leadership" sat in
// Required forever as a miss no résumé could clear. Dropped from JD requirements
// and résumé skills alike so the two sides stay symmetric.
const SOFT_SKILL_LEAD_RE =
  /^(?:excellent|strong|good|great|effective|exceptional|outstanding|proven|solid|superior|demonstrated|clear|professional|written|verbal|oral|highly|very|and|or)\s+/;
const SOFT_SKILLS = new Set([
  "communication","communications","collaboration","teamwork","team work","team player",
  "team collaboration","team building","leadership","mentoring","mentorship","coaching",
  "problem solving","critical thinking","analytical thinking","analytical","time management",
  "self management","task management","adaptability","flexibility","creativity","initiative",
  "work ethic","self starter","self motivated","detail oriented","detail orientation",
  "attention to detail","multitasking","multi tasking","decision making","conflict resolution",
  "negotiation","interpersonal","organizational","organisational","organization","presentation",
  "public speaking","customer service","work independently","fast learner","quick learner",
  "willingness to learn","passion","motivation","people management","emotional intelligence",
  "active listening","stakeholder management","relationship building","work under pressure",
]);
function isSoftSkill(s) {
  let n = String(s).toLowerCase().replace(/[^a-z\s-]/g, " ").replace(/[-\s]+/g, " ").trim();
  n = n.replace(SKILL_NOISE_TAIL_RE, "").trim();
  while (SOFT_SKILL_LEAD_RE.test(n)) n = n.replace(SOFT_SKILL_LEAD_RE, "");
  return SOFT_SKILLS.has(n);
}

// Hiring conditions, not skills. They ride in the same comma list as the stack
// ("Apex, SOQL, US Citizenship required, ability to travel 25%") and were mined
// as requirements. Clearance and education have their own scored buckets, so
// dropping them here loses nothing.
const NON_SKILL_RE =
  /\b(?:citizens?(?:hip)?|green\s+card|visas?|sponsorship|work\s+authoriz\w+|relocation|travel|driver'?s?\s+licen[cs]e|background\s+check|drug\s+(?:test|screen\w*)|degrees?|diplomas?|bachelors?|masters?|ph\.?d|doctorate|gpa|salary|compensation|benefits?|equal\s+opportunity|eeo|w2|c2c|corp[\s-]?to[\s-]?corp|1099)\b/i;

// Words that name a CATEGORY of technology rather than a technology. A phrase
// built only from these ("cloud platforms", "programming languages", "software
// development") describes the shape of the job, not something a résumé can
// match — one specific word is enough to keep the phrase ("data warehousing",
// "service mesh").
const GENERIC_SKILL_WORDS = new Set([
  "cloud","platform","platforms","language","languages","system","systems","tool","tools",
  "technology","technologies","service","services","framework","frameworks","library",
  "libraries","database","databases","application","applications","app","apps","software",
  "solution","solutions","methodology","methodologies","process","processes","concept",
  "concepts","practice","practices","principle","principles","environment","environments",
  "stack","suite","suites","product","products","programming","scripting","coding",
  "development","engineering","web","frontend","backend","general","various","modern","related",
  // Security umbrellas a JD lists in a parenthetical ("secure APIs (OAuth, JWT,
  // encryption, etc.)"). They name a property of the work, not a tool a résumé
  // lists, so alone they sit in Missing forever. A phrase naming the actual
  // mechanism still survives — "AES encryption", "encryption at rest".
  "encryption","encrypted","cryptography","jwt",
]);

// Gerunds are always verbal — "designing REST APIs" and "coaching junior
// developers" are sentence fragments the enumeration splitter tore out, never
// entries a skills list holds. Single-word gerunds ("testing", "scripting") can
// be real, so this only fires on multi-word phrases.
const SKILL_LEADING_GERUNDS = new Set([
  "building","developing","creating","implementing","maintaining","managing","delivering",
  "driving","ensuring","deploying","optimizing","integrating","troubleshooting","translating",
  "partnering","contributing","participating","performing","providing","handling","understanding",
  "utilizing","leveraging","collaborating","assisting","enabling","executing","overseeing",
  "designing","working","using","leading","mentoring","coaching","supporting","writing",
  "defining","learning","helping","owning","growing","scaling","architecting","spearheading",
]);

// A skills list holds short noun phrases, not sentences. Reject anything that
// reads like prose so résumé narrative can't leak into the skill set.
function isPlausibleSkill(s) {
  if (!s) return false;
  if (s.length === 1) return ONE_CHAR_SKILLS.has(s.toLowerCase());
  if (s.length > 40) return false;
  if (!/[A-Za-z]/.test(s)) return false;                     // "5+" etc.
  // A name we already know is a skill by definition — the trait and hiring-
  // condition filters below must never reach "Secret clearance" or "C#".
  if (knownSkills().has(canonicalSkill(s))) return true;
  if (isSoftSkill(s)) return false;
  if (NON_SKILL_RE.test(s)) return false;
  const words = s.split(/\s+/);
  // "3+ years", "25%" — a quantity the splitter left behind, not a skill.
  if (/^\d+[+%]?$/.test(words[0])) return false;
  if (words.every(w => GENERIC_SKILL_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, "")))) return false;
  if (words.length > 4) return false;                        // sentence fragment
  // Words that mark a clause, never a skill name — "FastAPI to design REST APIs"
  // is prose the miner picked up mid-sentence, not a skill.
  // Match on whitespace, not \b: \b treats a hyphen as a word break, so "in"
  // fired inside "In-Memory Caching" and threw a real skill away.
  if (/(?:^|\s)(?:with|the|using|experience|years?|to|for|in)(?:$|\s)/i.test(s)) return false;
  // "and" and "of" are different — they sit inside real skill names ("Internet
  // of Things", "Extract Transform and Load"), and the ≤4-word cap above
  // already keeps prose sentences out.
  // Nothing but generic words ("Secure", "Scalable", "Best Practices") is a
  // scrap the splitter tore off a sentence, never a skill. One real word is
  // enough to keep the phrase — "design patterns", "performance tuning".
  if (words.every(w => SKILL_STOPWORDS.has(stopwordToken(w)))) return false;
  if (words.length > 1) {
    const lead = words[0].toLowerCase().replace(/[^a-z]/g, "");
    if (SKILL_LEADING_VERBS.has(lead)) return false;
    if (SKILL_LEADING_GERUNDS.has(lead)) return false;
    // A puffed-up outcome, unless the whole phrase is a name we actually know.
    if (SKILL_PUFF_ADJ_RE.test(s) && SKILL_OUTCOME_TAIL_RE.test(s) &&
        !knownSkills().has(canonicalSkill(s))) return false;
  }
  return true;
}

// ── Résumé Experience-section reader ──────────────────────────────────────────
// The Skills section is not the whole story: a résumé names most of its stack
// inside the role bullets ("Environment: Java, Autosys, Denodo"). findKeywords
// only sees the tools already on TOOL_KEYWORDS, so everything else in the
// experience entries was dropped. Slice the experience block so the cue-based
// miner can read those enumerations.
const RESUME_EXP_HEADING_RE =
  /\b(?:(?:work|professional|employment|relevant|industry)\s+(?:experience|history)|experience|employment|work\s+history|professional\s+background|projects?|project\s+experience)\b\s*:?/gi;
const RESUME_EXP_NEXT_RE =
  /\b(?:education(?:al)?|academic|certifications?|licen[cs]es?|awards?|achievements?|publications?|interests|hobbies|references?|declaration|personal\s+details)\b\s*:?/i;

function resumeExperienceSection(text) {
  if (!text) return "";
  const matches = [...text.matchAll(RESUME_EXP_HEADING_RE)];
  if (matches.length === 0) return "";
  // Same heading test as the other slicers: ALL-CAPS or line-start is a real
  // heading, a mid-sentence "experience" is prose.
  const flat = !hasLineStructure(text);
  const pick = matches.find(m => isHeadingMatch(text, m.index, m[0], flat));
  if (!pick) return "";
  const rest = text.slice(pick.index + pick[0].length);
  const restFlat = !hasLineStructure(rest);
  const nextRe = new RegExp(RESUME_EXP_NEXT_RE.source, "gi");
  let end = rest.length, m;
  while ((m = nextRe.exec(rest)) !== null) {
    if (isHeadingMatch(rest, m.index, m[0], restFlat)) {
      end = m.index;
      break;
    }
  }
  return rest.slice(0, end).trim();
}

// Skills named in the résumé's experience entries: whitelist hits plus the
// enumerations behind a cue ("Environment:", "Technologies used:").
function resumeExperienceSkills(text) {
  const section = resumeExperienceSection(text);
  if (!section) return [];
  const out = [];
  for (const s of [...findKeywords(section), ...extractListedSkills(section, 60)]) {
    if (!isPlausibleSkill(s)) continue;
    if (isSkillsHeading(s)) continue;
    if (!out.some(o => o.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
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
// "Environment:" / "Technologies used:" trailer lines are where consulting
// résumés actually name a project's stack — without those cues every off-list
// tool in an experience entry was invisible to the scorer.
const SKILL_CUE_RE = /(?:experience (?:with|in|using)|proficien\w* (?:with|in)|knowledge of|familiar\w* with|expertise in|skilled in|hands[\s-]?on (?:experience )?with|working knowledge of|background in|competen\w* in|specific tools[^:]*:|skills?\s*:|(?:technologies|tools|platforms|languages|frameworks|environment)\s*(?:used|utilized)?\s*:|tech\s*stack\s*:)/ig;

// Generic words that survive the length/word-count filter but aren't skills.
const SKILL_STOPWORDS = new Set([
  "ability","strong","excellent","good","years","year","experience","knowledge","skills","skill",
  "written","verbal","communication","team","teams","etc","including","environment","environments",
  "related","equivalent","degree","plus","preferred","required","work","working","other","various",
  "such","as","is","are","be","you","your","our","we","will","must","should","have","proven","a","an",
  "the","and","or","with","in","of","to","using","for","on","at","an","but","not","this","that",
  // Bare verbs and adjectives a split leaves behind ("build secure" → "secure",
  // "build scalable"). Only phrases made ENTIRELY of these are dropped, so
  // "database design" and "performance tuning" are untouched.
  "build","develop","create","implement","deliver","drive","ensure","deploy","design",
  "secure","scalable","robust","reliable","efficient","resilient","seamless","performant",
  "modern","complex","high","performance","best","practices","well","highly","across","within",
]);

// `max` is the cap on mined phrases. A JD states its stack once (15 is plenty);
// a résumé restates it per project, so the résumé callers raise the cap or every
// tool past the first couple of roles is cut off.
function extractListedSkills(section, max = 15) {
  if (!section) return [];
  const out = [];
  let m;
  SKILL_CUE_RE.lastIndex = 0;
  while ((m = SKILL_CUE_RE.exec(section)) && out.length < max) {
    const from = m.index + m[0].length;
    // The fixed-width window used to land mid-word, so "…verbal communication
    // skills" was mined as the literal phrase "verbal communicat" — a
    // requirement nothing can ever match. When the cut falls inside a word, drop
    // the whole trailing entry: keeping its surviving words is just as wrong
    // ("detail oriented" cut to "detail").
    const end = from + 200;
    let clause = section.slice(from, end);
    if (end < section.length && /[A-Za-z0-9+#./-]/.test(section[end])) {
      clause = clause.replace(/[^,|\n]*$/, "");
    }
    // End the list at the first sentence break — but a period only ends a
    // sentence when whitespace follows it. A bare /[.;]/ cut "Vert.x", "Node.js"
    // and ".NET Core" in half at their internal dot.
    const stop = clause.search(/\.(?=\s|$)|;/);
    if (stop !== -1) clause = clause.slice(0, stop);
    const add = (phrase) => {
      phrase = phrase.replace(/^[\s\-*•]+/, "").replace(/\s+/g, " ").trim();
      // The window can run past the end of one cue's list into the next label
      // row ("…detail oriented / Technologies: Java"). The label is not part of
      // the skill — keep what it introduces.
      phrase = phrase.replace(/^[^:]{1,30}:\s*/, "").trim();
      // "data warehousing concepts" and "data warehousing" are one requirement;
      // strip the empty tail off the phrase itself so the chip reads clean, not
      // only off its match key.
      phrase = phrase.replace(SKILL_NOISE_TAIL_RE, "").trim();
      if (phrase.length < 2 || phrase.length > 40) return;
      const toks = phrase.toLowerCase().split(/\s+/);
      if (toks.length > 3) return;                          // skills are short phrases
      if (toks.every(t => SKILL_STOPWORDS.has(stopwordToken(t)))) return;  // pure boilerplate
      if (!/[a-z0-9]/i.test(phrase)) return;
      // A clause fragment is not a skill. "…with FastAPI to design REST APIs"
      // mined "FastAPI to design", which then sat in Required as a permanent
      // miss — nothing can ever match it. Same prose test the résumé reader uses.
      if (!isPlausibleSkill(phrase)) return;
      if (!out.some(o => o.toLowerCase() === phrase.toLowerCase())) out.push(phrase);
    };
    // A bare "/" is NOT a list separator: splitting on it shredded "CI/CD" into
    // a "CI" chip and a "CD" chip, neither of which any résumé can match. Same
    // rule the résumé reader uses — "HTML5/CSS3/JavaScript" is three skills,
    // "CI/CD" and "TCP/IP" are one, and segment length tells them apart.
    for (const entry of clause.split(/[,|]|\band\b|\n/i)) {
      const segs = entry.includes("/") ? entry.split("/").map(x => x.trim()) : [];
      if (segs.length > 1 && segs.every(x => x.length >= 3)) segs.forEach(add);
      else add(entry);
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

  const needSection      = sliceSection(text, JD_REQUIRED_HEADING_RE) || text;
  const preferredSection = sliceSection(text, JD_PREFERRED_HEADING_RE);

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
// Never show a 0 or a 100 — the rubric can't prove either end.
function clampScore(raw) { return Math.min(Math.max(Math.round(raw), 5), 99); }
function fitLabel(score) {
  if (score >= 80) return "Excellent Fit";
  if (score >= 65) return "Good Fit";
  if (score >= 45) return "Fair Fit";
  return "Poor Fit";
}
// Composite over the ACTIVE buckets only, renormalized to 100 (doc §3.3). Reads
// the same category list the breakdown card renders, so the points in the card
// and the number in the ring are always derived from one source.
function compositeFromCategories(categories) {
  const on = (categories || []).filter(c => c && c.active);
  const w  = on.reduce((s, c) => s + (c.weight || 0), 0);
  if (!w) return null;
  return on.reduce((s, c) => s + ((c.weight || 0) / w) * (c.fill || 0) * 100, 0);
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
// Add = JazzHR create + DB writes + résumé/profile indexing server-side; slow
// but finite. Past this the panel reports a timeout instead of spinning forever.
const ADD_TIMEOUT_MS = 90000;

async function backendScore(jd_id, candidate, resume_text) {
  const body = JSON.stringify({
    jd_id,
    // resume_text is deliberately NOT sent as its own field. The backend's port
    // of the résumé rule is the older whitelist-only one
    // (findKeywords(resume_text)), so when it received the text it re-derived
    // the skill set from scratch and threw away everything
    // scoreCandidateForJd had already mined from the résumé's Skills section
    // and experience entries — a résumé listing "Database Design, Query
    // Optimization, Scalable System Design" scored as if it listed none of
    // them, while the local path matched all three. The service worker already
    // applies the résumé-replace rule (skills below, education too) before
    // calling here, so there is nothing left for the backend to re-derive;
    // `candidate` IS the résumé. Re-add the field only once the backend's
    // parser matches this file's (README §"Scoring" calls them faithful ports).
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
      // Prose the backend scans so a JD skill mentioned only in role bullets
      // (never in the Skills list) still matches. A résumé replaces the profile
      // here for the same reason it replaces the skills — it is the fuller
      // document. This mirrors computeScore's textHas source exactly, so the
      // backend and local paths read the same prose and agree on the result.
      experience_text:  resume_text ||
                        (candidate.experience || [])
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
        // false = the JD yielded nothing to score against (not a real match).
        scorable: d.scorable !== false,
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
    // Tolerate a trailing plural, as findKeywords does. Without it a JD asking
    // for "API" / "Microservice" never matched a résumé that wrote "APIs" /
    // "microservices" — the required skill read as missing on a pure plural.
    return new RegExp(`${lead}${s.split(/\s+/).map(escWord).join("\\s+")}(?:e?s)?(?:$|[^A-Za-z0-9+#])`);
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
  // Required fill is a plain ratio of the skills matched, so the count drawn
  // beside the bar IS the bar. This used to be prominence-weighted (#7): each
  // skill counted by how often the JD named it, which made one missed skill the
  // posting repeated four times cost as much as four one-off misses — the card
  // then read "21/24" next to a 77% bar, and dropping a bogus requirement moved
  // no number. requirements.prominence is still carried in the payload (both the
  // backend and the stored requirements hold the field); nothing scores off it.
  const reqFill  = required_skills.length ? matchedReq.length / required_skills.length : 0;
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

  const score = clampScore(calibrate(raw));
  const label = fitLabel(score);

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
  const locLine = locationSentence(jdRemote, jdState, candState, candidate.location);
  if (locLine) parts.push(locLine);

  return { score, label, rationale: parts.join(" "), categories, gates, auto_schedule };
}

// ── JD requirements (fetch + parse + cache) ───────────────────────────────────
// One fetch per JD, shared by the local scorer and the backend location repair
// so both read the same parsed requirements.
// Parse one /api/scout/jobs/:id payload into a jobCache entry. EVERY writer of
// jobCache goes through this — the prefetch warmer used to store the bare prose
// parse, so a warm cache silently lost the location fallbacks below.
function jobCacheEntry(job) {
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
  return { title: job.title, requirements };
}

// In-flight fetches by JD, so a caller arriving while one is running shares it
// instead of paying a second ~1.5s round trip for the same JD.
const jobFetches = new Map();

async function getJobRequirements(jd_id) {
  await jobCacheReady;
  const hit = jobCache.get(jd_id);
  if (hit) return hit;
  if (jobFetches.has(jd_id)) return jobFetches.get(jd_id);
  const p = (async () => {
    const job = await scoutGetJson(`/api/scout/jobs/${jd_id}`);
    if (job.error) throw new Error(job.error);
    const entry = jobCacheEntry(job);
    rememberJob(jd_id, entry);
    return entry;
  })().finally(() => jobFetches.delete(jd_id));
  jobFetches.set(jd_id, p);
  return p;
}

// The backend scorer resolves a JD's location from the description prose alone —
// it has neither the posting's structured city/state fields nor the city tables
// this worker carries, so it drops the Location bucket on postings that DO name
// a place, and the card reads "Not scored — job location not specified". Resolve
// the region here and fold the bucket back in, renormalizing the composite over
// the buckets that are then active. No-op when the location is genuinely unknown
// on either side (missing data must not penalize the candidate).
async function repairBackendLocation(result, jd_id, candidate) {
  const cats = result.categories;
  if (!Array.isArray(cats) || !cats.length) return result;
  const loc = cats.find(c => c && c.key === "location");
  if (!loc || loc.active) return result;

  let requirements;
  try {
    ({ requirements } = await getJobRequirements(jd_id));
  } catch (e) {
    console.warn("[SCOUT] location repair: job fetch failed —", e.message);
    return result;
  }

  const jdRemote  = !!requirements.jd_remote;
  const jdState   = requirements.jd_state || "";
  const candState = detectState(candidate.location || "", true);
  if (!jdRemote && !(jdState && candState)) return result;   // still unknown → stays out

  const fill = jdRemote ? 1 : (regionsMatch(jdState, candState) ? 1 : 0);
  const categories = cats.map(c => c.key !== "location" ? c : {
    ...c,
    active: true,
    fill,
    detected: formatRegion(candState) || (candidate.location || "").trim() || "Unknown",
    required: jdRemote ? "Remote" : formatRegion(jdState),
  });

  // Guard: recomputing WITHOUT location must reproduce the backend's own number.
  // If it doesn't, the two sides disagree on the formula — patching the score
  // from here would be a guess, so leave the backend result untouched.
  const before = compositeFromCategories(cats);
  const after  = compositeFromCategories(categories);
  if (before === null || after === null) return result;
  const rebuilt = clampScore(calibrate(before));
  if (Math.abs(rebuilt - result.score) > 1) {
    console.warn(`[SCOUT] location repair: score formula mismatch (backend ${result.score}, local ${rebuilt}) — leaving the backend result as-is`);
    return result;
  }

  const score = clampScore(calibrate(after));
  const gates = result.gates ? { ...result.gates, locality: fill >= 1 } : result.gates;
  const auto_schedule = gates
    ? score >= 80 && !!gates.required_skills && !!gates.certifications
      && !!gates.clearance && !!gates.locality
    : !!result.auto_schedule && score >= 80;
  // The backend never resolved the location, so its rationale can't mention one.
  const locLine = locationSentence(jdRemote, jdState, candState, candidate.location);
  const rationale = [result.rationale, locLine].filter(Boolean).join(" ").trim();

  console.log(`[SCOUT] location repair: bucket restored (jd ${jdRemote ? "Remote" : jdState}`
    + ` vs candidate ${candState || "?"}) | score ${result.score} → ${score}`);
  return { ...result, score, label: fitLabel(score), rationale, categories, gates, auto_schedule };
}

// Chip hygiene for backend results. The backend runs its own copy of this
// file's JD parser, so a deployment older than the parser's filters ships
// requirement chips this worker would never mine — "secure", "etc.)", "build
// scalable" — and they render in the breakdown as permanent misses no résumé
// can ever clear.
//
// Dropping the chip is only half the job: `fill` is what draws the bar and the
// points, so a filtered chip list left the card contradicting itself — "21/24"
// beside a 77% bar still computed over the 26 the backend counted, and removing
// a junk requirement moved no number at all. Recompute the two skill fills off
// the surviving chips (prominence-weighted for required, exactly as
// computeScore does) and renormalize the composite, with the same guard
// repairBackendLocation uses: if replaying the backend's own fills doesn't
// reproduce its score, the two sides disagree on the formula and patching the
// number from here would be a guess.
function sanitizeCategorySkills(result) {
  const cats = result && result.categories;
  if (!Array.isArray(cats) || !cats.length) return result;

  const dropped = [];
  const clean = (list) => Array.isArray(list)
    ? list.filter(s => {
        const ok = isPlausibleSkill(String(s || "").trim());
        if (!ok) dropped.push(s);
        return ok;
      })
    : list;

  const cleaned = cats.map(c =>
    (c && (Array.isArray(c.matched) || Array.isArray(c.missing)))
      ? { ...c, matched: clean(c.matched), missing: clean(c.missing) }
      : c);
  if (!dropped.length) return result;
  console.log("[SCOUT] dropped non-skill chips from backend result:", dropped.join(", "));

  const categories = cleaned.map(c => {
    if (!c || !Array.isArray(c.matched) || !Array.isArray(c.missing)) return c;
    if (c.key !== "required" && c.key !== "preferred") return c;
    const total = c.matched.length + c.missing.length;
    const fill  = total ? c.matched.length / total : 0;
    return c.key === "preferred" ? { ...c, fill, active: total > 0 } : { ...c, fill };
  });

  const before = compositeFromCategories(cats);
  const after  = compositeFromCategories(categories);
  if (before === null || after === null) return { ...result, categories };
  const rebuilt = clampScore(calibrate(before));
  if (Math.abs(rebuilt - result.score) > 1) {
    console.warn(`[SCOUT] chip filter: score formula mismatch (backend ${result.score}, local ${rebuilt})`
      + " — chips filtered, score left as-is");
    return { ...result, categories };
  }

  const score = clampScore(calibrate(after));
  const reqCat = categories.find(c => c && c.key === "required");
  const gates = result.gates
    ? { ...result.gates, required_skills: !reqCat || reqCat.fill >= 1 }
    : result.gates;
  const auto_schedule = gates
    ? score >= 80 && !!gates.required_skills && !!gates.certifications
      && !!gates.clearance && !!gates.locality
    : !!result.auto_schedule && score >= 80;

  console.log(`[SCOUT] chip filter: ${dropped.length} chip(s) dropped | score ${result.score} → ${score}`);
  return { ...result, score, label: fitLabel(score), categories, gates, auto_schedule };
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
    // …∪ the stack named inside the experience entries. The whitelist scan alone
    // saw only the tools it already knew, so an off-list tool that appears only
    // in a role's "Environment:" line never reached the scorer.
    const fromExp = resumeExperienceSkills(resume_text);
    // Dedupe on the CANONICAL name, not the literal text: a résumé that writes
    // both "FastAPI" and "Fast API framework" (or "REST" and "REST APIs") named
    // one skill twice, and the raw-text key kept both.
    const seen = new Set();
    const resumeSkills = [...findKeywords(resume_text), ...listed, ...fromExp]
      .filter(s => { const k = canonicalSkill(s); return seen.has(k) ? false : seen.add(k); });
    console.log(`[SCOUT] résumé skills: ${resumeSkills.length}`
      + ` (${listed.length} from Skills section, ${fromExp.length} from Experience)`,
      "\n[SCOUT]   Skills section:", listed.join(", ") || "(none)",
      "\n[SCOUT]   Experience:", fromExp.join(", ") || "(none)");
    if (resumeSkills.length > 0) scored = { ...candidate, skills: resumeSkills };
    // Résumé also replaces education — but ONLY its Education section text, so
    // degree words in résumé prose can't inflate the level. Guard: no Education
    // heading found keeps the profile's Education-section entries.
    const resumeEdu = resumeEducationSection(resume_text);
    if (resumeEdu) scored = { ...scored, education: [{ degree: resumeEdu, school: "" }] };
  }

  // Same JD + same scored inputs → same answer. Re-picking a JD, reopening the
  // panel on the same profile, or "best fit" after a single-JD score is served
  // from here instead of another round trip; an identical request already in
  // flight is shared rather than sent twice.
  const key = scoreCacheKey(jd_id, scored, resume_text);
  const cachedScore = scoreCache.get(key);
  if (cachedScore && Date.now() - cachedScore.at < SCORE_CACHE_TTL_MS) return cachedScore.result;
  if (scoreInFlight.has(key)) return scoreInFlight.get(key);
  const p = scoreUncached(jd_id, scored, resume_text)
    .then(result => {
      // Only the backend's answer is cached — a local fallback is a stopgap
      // that the next attempt should try to replace with the real score.
      // Nor an "unscorable" answer: that says the JD could not be read, which a
      // backend fix or an edited JD can change at any moment.
      if (result.source === "backend" && result.scorable !== false) {
        scoreCache.set(key, { at: Date.now(), result });
        if (scoreCache.size > SCORE_CACHE_MAX) scoreCache.delete(scoreCache.keys().next().value);
      }
      return result;
    })
    .finally(() => scoreInFlight.delete(key));
  scoreInFlight.set(key, p);
  return p;
}

// ── Score result cache ────────────────────────────────────────────────────────
// Keyed on the JD and the exact candidate payload scored (after the résumé
// rules above), so any change to the profile or résumé is a different key.
// Short-lived: the backend re-reads an edited JD, and this must follow it.
const SCORE_CACHE_TTL_MS = 10 * 60 * 1000;
const SCORE_CACHE_MAX = 300;
const scoreCache = new Map();
const scoreInFlight = new Map();

// FNV-1a over the serialized inputs — a compact key, not a security hash.
function scoreCacheKey(jd_id, scored, resume_text) {
  const s = JSON.stringify([scored, resume_text || ""]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${jd_id}|${s.length}|${(h >>> 0).toString(36)}`;
}

async function scoreUncached(jd_id, scored, resume_text) {
  // The JD's requirements are needed after the backend answers (location
  // repair) or instead of it (local fallback). Start fetching now, alongside
  // the score, rather than paying the round trip after it — a new job is not
  // in jobCache yet. Failures surface where the result is actually used.
  getJobRequirements(jd_id).catch(() => {});

  // 1) Backend scoring (consistent across devices).
  const backend = await backendScore(jd_id, scored, resume_text);
  if (backend) {
    // The backend's location detection is weaker than this worker's — fold the
    // bucket back in when we can resolve it locally.
    const repaired = sanitizeCategorySkills(
      await repairBackendLocation(backend, jd_id, scored));
    // Which buckets are active after the repair — the breakdown card renders only
    // these, so a missing row (e.g. location) means neither side could resolve it.
    console.log("[SCOUT] score source: backend | buckets:",
      (repaired.categories || []).map(c => `${c.key}=${c.active ? "on" : "off"}`).join(" ") || "none",
      "| candidate location:", scored.location || "(none)");
    return { ...repaired, source: "backend" };
  }

  // 2) Local fallback (per-device embeddings — may differ across browsers).
  const cached = await getJobRequirements(jd_id);
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
  // Carry over any clearance already parsed this session: every writer of the
  // jobs cache goes through here, so without this a background revalidate would
  // silently strip the badges off a dropdown that was already showing them.
  const clr = jobClearanceMap();
  return (data.jobs || []).map(j => ({
    id:     j.id,
    title:  j.title,
    client: j.internal_code || [j.city, j.state].filter(Boolean).join(", ") || j.type || "",
    ...(clr[j.id] ? { clearance: clr[j.id] } : {}),
  }));
}

async function getCachedJobs() {
  const { [JOBS_CACHE_KEY]: c } = await chrome.storage.local.get(JOBS_CACHE_KEY);
  return c && Array.isArray(c.jobs) ? c : null;
}

// Same jobs, same titles, same order — the dropdown would not change.
const jobsSignature = (jobs) => (jobs || []).map(j => `${j.id}|${j.title}|${j.client}`).join("\n");

async function refreshJobsCache() {
  try {
    const prev = await getCachedJobs().catch(() => null);
    const jobs = await fetchJobs();
    await chrome.storage.local.set({ [JOBS_CACHE_KEY]: { ts: Date.now(), jobs } });
    // An open popup already rendered the cached list; hand it the fresh one so
    // a job created a moment ago shows without closing the panel or reloading
    // the extension. No popup open just means nobody is listening.
    if (jobsSignature(prev?.jobs) !== jobsSignature(jobs)) {
      chrome.runtime.sendMessage({ type: "JOBS_UPDATED", data: jobs }).catch(() => {});
      // Only the JDs not already held — the new job, typically.
      prefetchJobDescriptions(jobs.filter(j => !jobCache.has(j.id)));
    }
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
// Fills jobCache (clearance badges in the picker, location repair, the local
// fallback scorer). This used to fire one request per job all at once — ~150
// on every panel open — and the browser's per-host connection limit then held
// the recruiter's actual score request behind the whole burst, for many
// seconds. Now it is a single background queue: low fetch priority, two at a
// time, paused while any score is in flight, skipping JDs fetched in the last
// JD_FRESH_MS. The parsed cache is persisted so a service-worker restart
// (every ~30s idle) does not start the sweep over.

const JD_FRESH_MS = 10 * 60 * 1000;
const PREFETCH_CONCURRENCY = 2;
const JD_STORE_KEY = "scout_jd_cache";
const jobFetchedAt = new Map();          // job_id → ms of last successful fetch
const prefetchQueue = [];
const prefetchQueued = new Set();
let prefetchRunning = false;

// Restore the parsed JDs from the last worker lifetime before anything reads them.
const jobCacheReady = (async () => {
  try {
    const { [JD_STORE_KEY]: saved } = await chrome.storage.local.get(JD_STORE_KEY);
    for (const [id, { at, entry }] of Object.entries(saved || {})) {
      if (!jobCache.has(id)) { jobCache.set(id, entry); jobFetchedAt.set(id, at); }
    }
  } catch (e) { console.warn("[SCOUT] JD cache restore failed:", e.message); }
})();

let persistTimer = null;
function persistJobCache() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const out = {};
    for (const [id, entry] of jobCache) out[id] = { at: jobFetchedAt.get(id) || 0, entry };
    chrome.storage.local.set({ [JD_STORE_KEY]: out }).catch(() => {});
  }, 1000);
}

function rememberJob(id, entry) {
  jobCache.set(id, entry);
  jobFetchedAt.set(id, Date.now());
  persistJobCache();
}

async function prefetchJobDescriptions(jobs) {
  await jobCacheReady;
  for (const job of jobs) {
    const fresh = Date.now() - (jobFetchedAt.get(job.id) || 0) < JD_FRESH_MS;
    if (!fresh && !prefetchQueued.has(job.id)) { prefetchQueued.add(job.id); prefetchQueue.push(job.id); }
  }
  if (prefetchRunning) return;           // the running sweep picks the new ids up
  if (!prefetchQueue.length) { publishJobClearances(); return; }
  prefetchRunning = true;
  let done = 0;
  const worker = async () => {
    while (prefetchQueue.length) {
      // A score the recruiter is waiting on always goes first.
      while (scoreInFlight.size) await new Promise(r => setTimeout(r, 150));
      const id = prefetchQueue.shift();
      prefetchQueued.delete(id);
      try {
        const data = await scoutGetJson(`/api/scout/jobs/${id}`, { priority: "low" });
        if (!data.error) rememberJob(id, jobCacheEntry(data));
      } catch (_) { /* skip — GET_SCORE fetches it live if it is ever needed */ }
      // Badges appear as the sweep goes rather than only at the very end.
      if (++done % 25 === 0) publishJobClearances();
    }
  };
  try {
    await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
  } finally {
    prefetchRunning = false;
  }
  console.log(`[SCOUT] Pre-cached ${jobCache.size} job descriptions (${done} fetched)`);
  await publishJobClearances();
}

// ── Clearance labels for the JD picker ────────────────────────────────────────
// A required clearance is a hard gate — a recruiter should see it while CHOOSING
// the JD, not after scoring a candidate against it. It lives in the description
// (the /jobs list payload doesn't carry one), so it only becomes known once
// prefetchJobDescriptions has parsed each JD. Fold the labels into the cached
// job list and push them to any open panel so the dropdown can badge the rows.
function jobClearanceMap() {
  const out = {};
  for (const [id, entry] of jobCache) {
    const clr = entry?.requirements?.required_clearance;
    if (clr && clr.rank > 0 && clr.label) out[id] = clr.label;
  }
  return out;
}

async function publishJobClearances() {
  const map = jobClearanceMap();
  if (!Object.keys(map).length) return;

  // Merge by id rather than rewriting the list: refreshJobsCache may have
  // replaced it (with no clearance field) while the prefetch was in flight.
  try {
    const cached = await getCachedJobs();
    if (cached && cached.jobs.length) {
      const jobs = cached.jobs.map(j => (map[j.id] ? { ...j, clearance: map[j.id] } : j));
      await chrome.storage.local.set({ [JOBS_CACHE_KEY]: { ts: cached.ts, jobs } });
    }
  } catch (e) {
    console.warn("[SCOUT] clearance cache merge failed:", e.message);
  }

  console.log(`[SCOUT] JD clearances: ${Object.keys(map).length} of ${jobCache.size} jobs`,
    Object.entries(map).map(([id, l]) => `${id}=${l}`).join(", "));
  // The panel may be closed — a failed send is expected, not an error.
  chrome.runtime.sendMessage({ type: "JD_CLEARANCES", data: map }).catch(() => {});
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
        // Scores computed against the old text go with them.
        if (message.fresh) {
          await jobCacheReady;
          jobCache.clear();
          jobFetchedAt.clear();
          scoreCache.clear();
          chrome.storage.local.remove(JD_STORE_KEY).catch(() => {});
        }

        // Stale-while-revalidate: serve ANY cached list immediately (even past
        // TTL) so the dropdown never waits on the network after the first-ever
        // load — Azure cold starts can take many seconds. Always revalidate in
        // the background so next open is current. Skipped only on forced refresh.
        if (!message.fresh) {
          const cached = await getCachedJobs();
          if (cached && cached.jobs.length) {
            sendResponse({ ok: true, data: cached.jobs });
            ensureOffscreen().catch(() => {});
            // A quiet re-check (the panel regaining focus) only fills gaps; a
            // real open re-pulls every JD so edited descriptions are picked up.
            prefetchJobDescriptions(message.quiet
              ? cached.jobs.filter(j => !jobCache.has(j.id)) : cached.jobs);
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
                linkedin_url, override_note, override_score } = payload;
        const jazzhr_token = await getJazzhrToken();
        // Sourcing channel ("LinkedIn" / "Dice.com") — sent top-level as well as on
        // the candidate; the backend normalizes it into scout_candidates.candidate_source
        // for the dashboard chip.
        // Bounded: with no timeout a stalled backend left the panel on
        // "Adding…" forever with no outcome.
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), ADD_TIMEOUT_MS);
        const r = await fetch(`${BASE_URL}/api/scout/candidates`, {
          method:  "POST",
          headers: scoutHeaders(),
          signal:  ctrl.signal,
          body:    JSON.stringify({ job_id, job_title, candidate, resume_b64, resume_name, resume_mime, jazzhr_token,
                                    candidate_source: candidate_source || candidate?.source || "",
                                    // LinkedIn-sourced only (canonical /in/<slug>/); absent for Dice.
                                    linkedin_url: linkedin_url || candidate?.linkedin_url || undefined,
                                    // Set only when the recruiter added below the fit-score
                                    // floor; the backend files it on the candidate timeline.
                                    override_note, override_score }),
        });
        const text = await r.text().finally(() => clearTimeout(timer));
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
        sendResponse({ ok: false, error: e.name === "AbortError"
          ? `SCOUT didn't respond in ${ADD_TIMEOUT_MS / 1000}s — check the dashboard before retrying (it may still have been added).`
          : `Fetch failed: ${e.message}` });
      }
    })();
    return true;
  }
});
