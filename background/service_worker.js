const BASE_URL = "https://navitas-ai-platform.wonderfulfield-ebc060c9.eastus.azurecontainerapps.io";

// Open the side panel when the toolbar icon is clicked.
// Side panel stays open across outside clicks (unlike an action popup).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("[SCOUT] setPanelBehavior:", e.message));

// In-memory cache: job_id → { title, requirements }
// Pre-populated after GET_JDS so GET_SCORE is instant.
const jobCache = new Map();

// ── Skill matching ────────────────────────────────────────────────────────────
// Semantic-ish matching without a model: alias expansion + fuzzy token overlap.
// Each alias group lists terms that mean the same thing. A skill matches a
// requirement if they share an alias group, contain each other, or have high
// token overlap (handles word-order / abbreviation differences).

const ALIAS_GROUPS = [
  ["ml", "machine learning", "ml engineering", "mle"],
  ["ai", "artificial intelligence"],
  ["dl", "deep learning", "neural networks", "nn"],
  ["nlp", "natural language processing", "text mining"],
  ["llm", "large language model", "large language models", "gpt", "generative ai", "genai"],
  ["cv", "computer vision", "image processing"],
  ["etl", "elt", "data pipeline", "data pipelines", "data engineering", "data integration", "ingestion"],
  ["ci/cd", "cicd", "continuous integration", "continuous delivery", "continuous deployment", "build pipeline"],
  ["k8s", "kubernetes", "container orchestration"],
  ["iac", "infrastructure as code", "terraform", "cloudformation"],
  ["js", "javascript", "ecmascript", "node", "node.js", "nodejs"],
  ["ts", "typescript"],
  ["py", "python"],
  ["cs", "c#", "csharp", ".net", "dotnet"],
  ["cpp", "c++"],
  ["golang", "go"],
  ["db", "database", "databases", "rdbms"],
  ["sql", "postgres", "postgresql", "mysql", "tsql", "t-sql", "relational database"],
  ["nosql", "mongodb", "mongo", "documentdb", "dynamodb"],
  ["rest", "restful", "rest api", "rest apis", "web api", "web services"],
  ["api", "apis", "interface"],
  ["microservices", "micro services", "service oriented", "soa"],
  ["aws", "amazon web services"],
  ["gcp", "google cloud", "google cloud platform"],
  ["azure", "microsoft azure"],
  ["viz", "data visualization", "dashboards", "dashboard", "bi", "business intelligence", "power bi", "tableau", "looker"],
  ["devops", "sre", "site reliability"],
  ["frontend", "front end", "front-end", "ui", "client side"],
  ["backend", "back end", "back-end", "server side"],
  ["fullstack", "full stack", "full-stack"],
  ["spark", "apache spark", "pyspark"],
  ["kafka", "apache kafka", "event streaming", "streaming"],
  ["airflow", "apache airflow", "workflow orchestration"],
  ["scrum", "agile", "kanban", "sprint"],
  ["clearance", "ts/sci", "top secret", "secret clearance", "security clearance"],
  ["scikit", "scikit-learn", "sklearn"],
  ["tensorflow", "tf", "keras"],
  ["pytorch", "torch"],
  ["rag", "retrieval augmented generation", "retrieval-augmented generation"],
];

const STOPWORDS = new Set(["and", "or", "of", "the", "a", "an", "with", "for", "in", "to", "experience"]);

function normalizeSkill(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9+#./\s-]/g, " ")  // keep +, #, ., / (c++, c#, ci/cd, node.js)
    .replace(/\s+/g, " ")
    .trim();
}

// Map every alias term → its group index, for O(1) group lookup.
const ALIAS_INDEX = (() => {
  const m = new Map();
  ALIAS_GROUPS.forEach((group, i) => group.forEach(term => m.set(normalizeSkill(term), i)));
  return m;
})();

// Group indices a normalized skill belongs to (direct hit or substring of an alias term).
function aliasGroupsOf(norm) {
  const groups = new Set();
  if (ALIAS_INDEX.has(norm)) groups.add(ALIAS_INDEX.get(norm));
  for (const [term, i] of ALIAS_INDEX) {
    if (norm === term) { groups.add(i); continue; }
    // token-boundary containment so "ml" doesn't hit "html"
    const re = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
    if (re.test(norm)) groups.add(i);
  }
  return groups;
}

// True only if `needle` appears in `hay` on token boundaries (so "java" ∉ "javascript",
// but "rest api" ∈ "rest api development").
function containsToken(hay, needle) {
  const re = new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
  return re.test(hay);
}

function tokenSet(norm) {
  return new Set(norm.split(" ").filter(w => w.length > 1 && !STOPWORDS.has(w)));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function pairMatch(a, b) {
  const na = normalizeSkill(a), nb = normalizeSkill(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // shared alias group → semantic equivalence (ML ↔ machine learning)
  const ga = aliasGroupsOf(na), gb = aliasGroupsOf(nb);
  for (const g of ga) if (gb.has(g)) return true;
  // token-boundary containment (so "java" ∉ "javascript")
  if (na.length >= 3 && containsToken(nb, na)) return true;
  if (nb.length >= 3 && containsToken(na, nb)) return true;
  // fuzzy: high word overlap (handles "data pipeline" ↔ "pipeline data eng")
  if (jaccard(tokenSet(na), tokenSet(nb)) >= 0.5) return true;
  return false;
}

function skillMatch(candidateSkills, targetSkill) {
  return (candidateSkills || []).some(cs => pairMatch(cs, targetSkill));
}

// ── Parse "What You'll Need" section → structured requirements ────────────────

function parseRequirements(description) {
  const needMatch = description.match(/What\s+You(?:'|'|ll\s+)?['s\s]*Need\s*[:\-]?([\s\S]*?)(?:\n\s*(?:Clearance|About|What\s+We|Equal|$)|$)/i);
  const section = needMatch ? needMatch[1] : description;

  const required_skills  = [];
  const preferred_skills = [];
  let   required_years   = 0;

  const yearsMatch = section.match(/(\d+)\+?\s*years?\s+of\s+experience/i);
  if (yearsMatch) required_years = parseInt(yearsMatch[1], 10);

  const preferredMatch = section.match(/Preferred[^:]*:([\s\S]*?)(?:\n\s*(?:\S+:|\n)|$)/i);
  if (preferredMatch) {
    const tokens = preferredMatch[1].split(/[,\n]+/).map(s => s.replace(/^[\s\-\*]+/, '').trim()).filter(s => s.length > 2 && s.length < 60);
    preferred_skills.push(...tokens);
  }

  const toolKeywords = [
    "AWS","Azure","GCP","Docker","Kubernetes","Terraform","Jenkins","CI/CD","Linux","Ansible","Helm",
    "Java","Python","JavaScript","TypeScript","React","Angular","Spring Boot","Node.js","FastAPI",".NET","C#","C++","Go","Rust",
    "SQL","Power BI","Power Apps","Power Automate","SharePoint","DAX","Power Query","Spark","ETL","Kafka","dbt","Airflow","Databricks","Snowflake","Tableau","Looker","MongoDB","PostgreSQL","MySQL","Redis","Elasticsearch",
    "LLM","GPT","OpenAI","LangChain","TensorFlow","PyTorch","Scikit","RAG",
    "Top Secret","TS/SCI","Secret","Clearance","FISMA","FedRAMP","NIST","DISA","STIGs",
    "REST","API","Microservices","Git","Maven","Hibernate","JUnit","Agile","Scrum"
  ];

  const sectionLower = section.toLowerCase();
  for (const kw of toolKeywords) {
    if (sectionLower.includes(kw.toLowerCase()) && !required_skills.includes(kw) && !preferred_skills.includes(kw)) {
      required_skills.push(kw);
    }
  }

  const specificMatch = section.match(/Specific\s+tools[^:]*:([\s\S]*?)(?:\n\s*(?:[A-Z]|\n)|$)/i);
  if (specificMatch) {
    const extras = specificMatch[1].split(/[,\n]+/).map(s => s.replace(/^[\s\-\*]+/, '').trim()).filter(s => s.length > 1 && s.length < 60);
    for (const e of extras) {
      if (!required_skills.includes(e)) required_skills.push(e);
    }
  }

  return { required_skills, preferred_skills, required_years };
}

// ── Score candidate against requirements ──────────────────────────────────────

function computeScore(requirements, jobTitle, candidate) {
  const { required_skills, preferred_skills, required_years } = requirements;
  const cSkills  = candidate.skills || [];
  const expYears = candidate.experience_years || 0;

  if (required_skills.length === 0) {
    return { score: 50, label: "Fair Fit", rationale: "Could not extract skills from JD to score." };
  }

  const matchedReq  = required_skills.filter(s => skillMatch(cSkills, s));
  const matchedPref = preferred_skills.filter(s => skillMatch(cSkills, s));
  const missingReq  = required_skills.filter(s => !skillMatch(cSkills, s));

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
        // Pre-fetch descriptions in background — don't await, popup already has the list
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

        const result = computeScore(cached.requirements, cached.title, candidate);
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
        if (data.ok) {
          console.log("[SCOUT] Candidate added:", data.applicant?.id || data.applicant?.prospect_id);
          sendResponse({ ok: true, status: "added", jazzhr_url: data.jazzhr_url || "" });
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
