const BASE_URL = "https://navitas-ai-platform.wonderfulfield-ebc060c9.eastus.azurecontainerapps.io";

// ── Skill matching helpers ────────────────────────────────────────────────────

function skillMatch(candidateSkills, targetSkill) {
  const t = targetSkill.toLowerCase().trim();
  return candidateSkills.some(cs => {
    const c = cs.toLowerCase().trim();
    return c.includes(t) || t.includes(c);
  });
}

/**
 * Parse skills from the "What You'll Need" section of a plain-text JD.
 * Returns { required_skills, preferred_skills, required_years }.
 */
function parseRequirements(description) {
  // Grab everything from "What You'll Need" to the next header (or end)
  const needMatch = description.match(/What\s+You(?:'|'|ll\s+)?['s\s]*Need\s*[:\-]?([\s\S]*?)(?:\n\s*(?:Clearance|About|What\s+We|Equal|$)|$)/i);
  const section = needMatch ? needMatch[1] : description;

  const required_skills  = [];
  const preferred_skills = [];
  let   required_years   = 0;

  // Extract years of experience
  const yearsMatch = section.match(/(\d+)\+?\s*years?\s+of\s+experience/i);
  if (yearsMatch) required_years = parseInt(yearsMatch[1], 10);

  // Extract preferred certifications/tools listed after "Preferred"
  const preferredMatch = section.match(/Preferred[^:]*:([\s\S]*?)(?:\n\s*(?:\S+:|\n)|$)/i);
  if (preferredMatch) {
    const raw = preferredMatch[1];
    const tokens = raw.split(/[,\n]+/).map(s => s.replace(/^[\s\-\*]+/, '').trim()).filter(s => s.length > 2 && s.length < 60);
    preferred_skills.push(...tokens);
  }

  // Extract tool/tech names from the body (quoted or listed)
  // Match patterns like: Power BI, Power Apps, Power Automate, DAX, SharePoint, etc.
  const techPattern = /\b([A-Z][a-zA-Z0-9\s\/\+#\.]{1,30})\b/g;
  const toolKeywords = [
    // Cloud & DevOps
    "AWS","Azure","GCP","Docker","Kubernetes","Terraform","Jenkins","CI/CD","Linux","Ansible","Helm",
    // Languages & Frameworks
    "Java","Python","JavaScript","TypeScript","React","Angular","Spring Boot","Node.js","FastAPI",".NET","C#","C++","Go","Rust",
    // Data & BI
    "SQL","Power BI","Power Apps","Power Automate","SharePoint","DAX","Power Query","Spark","ETL","Kafka","dbt","Airflow","Databricks","Snowflake","Tableau","Looker","MongoDB","PostgreSQL","MySQL","Redis","Elasticsearch",
    // AI / ML
    "LLM","GPT","OpenAI","LangChain","TensorFlow","PyTorch","Scikit","RAG",
    // Federal / Security
    "Top Secret","TS/SCI","Secret","Clearance","FISMA","FedRAMP","NIST","DISA","STIGs",
    // General IT
    "REST","API","Microservices","Git","Maven","Hibernate","JUnit","Linux","Agile","Scrum"
  ];

  const sectionLower = section.toLowerCase();
  for (const kw of toolKeywords) {
    if (sectionLower.includes(kw.toLowerCase())) {
      if (!required_skills.includes(kw) && !preferred_skills.includes(kw)) {
        required_skills.push(kw);
      }
    }
  }

  // Also pull specific tools from "Specific tools/experience areas:" line
  const specificMatch = section.match(/Specific\s+tools[^:]*:([\s\S]*?)(?:\n\s*(?:[A-Z]|\n)|$)/i);
  if (specificMatch) {
    const extras = specificMatch[1].split(/[,\n]+/).map(s => s.replace(/^[\s\-\*]+/, '').trim()).filter(s => s.length > 1 && s.length < 60);
    for (const e of extras) {
      if (!required_skills.includes(e)) required_skills.push(e);
    }
  }

  return { required_skills, preferred_skills, required_years };
}

/**
 * Compute a fit score from the job's requirement set and the candidate profile.
 */
function computeScore(requirements, jobTitle, candidate) {
  const { required_skills, preferred_skills, required_years } = requirements;
  const cSkills  = candidate.skills || [];
  const expYears = candidate.experience_years || 0;

  if (required_skills.length === 0) {
    return { score: 50, label: "Fair Fit", rationale: "Could not extract skills from JD to score." };
  }

  const matchedReq  = required_skills.filter(s  => skillMatch(cSkills, s));
  const matchedPref = preferred_skills.filter(s  => skillMatch(cSkills, s));
  const missingReq  = required_skills.filter(s  => !skillMatch(cSkills, s));

  // Weights: required 60%, preferred 15%, experience 25%
  const reqWeight  = required_skills.length  ? (matchedReq.length  / required_skills.length)            * 60 : 0;
  const prefWeight = preferred_skills.length ? (matchedPref.length / preferred_skills.length)           * 15 : 15;
  const expWeight  = required_years          ? Math.min(expYears / required_years, 1.2)                 * 25 : (expYears > 0 ? 20 : 10);

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
    parts.push(`No required skills matched from ${jobTitle}.`);
  }
  if (matchedPref.length > 0) {
    parts.push(`Preferred skills: ${matchedPref.slice(0, 3).join(", ")}.`);
  }
  if (missingReq.length > 0) {
    parts.push(`Missing: ${missingReq.slice(0, 3).join(", ")}.`);
  }
  if (expYears > 0 && required_years > 0) {
    parts.push(expYears >= required_years
      ? `${expYears} yrs experience meets the ${required_years}-yr requirement.`
      : `${expYears} yrs experience is below the ${required_years}-yr requirement.`
    );
  }

  return { score, label, rationale: parts.join(" ") };
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  // ── GET_JDS — fetch live active jobs from SCOUT backend ───────────────────
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
      } catch (e) {
        console.error("[SCOUT] GET_JDS error:", e.message);
        sendResponse({ ok: false, error: `Failed to load jobs: ${e.message}` });
      }
    })();
    return true;
  }

  // ── GET_SCORE — fetch job description, parse skills, score candidate ──────
  if (type === "GET_SCORE") {
    (async () => {
      try {
        const { jd_id, candidate } = payload;
        const r    = await fetch(`${BASE_URL}/api/scout/jobs/${jd_id}`);
        const job  = await r.json();

        if (job.error) {
          sendResponse({ ok: false, error: job.error });
          return;
        }

        const requirements = parseRequirements(job.description || "");
        console.log("[SCOUT] Parsed requirements:", requirements);

        const result = computeScore(requirements, job.title, candidate);
        console.log("[SCOUT] Score:", result);

        sendResponse({ ok: true, data: result });
      } catch (e) {
        console.error("[SCOUT] GET_SCORE error:", e.message);
        sendResponse({ ok: false, error: `Scoring failed: ${e.message}` });
      }
    })();
    return true;
  }

  // ── ADD_CANDIDATE — post to Google Sheets via Apps Script ─────────────────
  // Async IIFE prevents Chrome from killing the SW mid-fetch (MV3 requirement).
  if (type === "ADD_CANDIDATE") {
    (async () => {
      try {
        const { sheetsUrl } = await chrome.storage.local.get(["sheetsUrl"]);
        if (!sheetsUrl) {
          sendResponse({ ok: false, error: "No Google Sheets URL configured. Add it in extension settings." });
          return;
        }

        console.log("[SCOUT] Sending to:", sheetsUrl);
        const r = await fetch(sheetsUrl, {
          method:   "POST",
          headers:  { "Content-Type": "text/plain" },
          body:     JSON.stringify(payload),
          redirect: "follow"
        });
        const text = await r.text();
        let data;
        try { data = JSON.parse(text); }
        catch (_) { sendResponse({ ok: false, error: `Non-JSON response (${r.status}): ${text.slice(0, 120)}` }); return; }
        if (data.status === "success") {
          sendResponse({ ok: true, status: "added" });
        } else {
          sendResponse({ ok: false, error: data.message || "Apps Script returned error." });
        }
      } catch (e) {
        console.error("[SCOUT] Fetch error:", e.message);
        sendResponse({ ok: false, error: `Fetch failed: ${e.message}` });
      }
    })();
    return true;
  }
});
