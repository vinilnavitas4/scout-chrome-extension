// Week 1 scaffold — scoring computed locally from real candidate data. API calls added in Week 2.

const JDS = [
  { id: "jd_001", title: "Java Backend Developer",  client: "Federal"     },
  { id: "jd_002", title: "Data Engineer — AI/BI",   client: "Commercial"  },
  { id: "jd_003", title: "DevSecOps Engineer",       client: "DoD"         }
];

const JD_REQUIREMENTS = {
  jd_001: {
    label:           "Java Backend Developer",
    required_years:  5,
    required_skills: ["Java", "Spring Boot", "Microservices", "REST", "SQL", "AWS", "Maven", "Git"],
    preferred_skills:["Kubernetes", "Docker", "Jenkins", "PostgreSQL", "MongoDB", "JUnit", "Hibernate"]
  },
  jd_002: {
    label:           "Data Engineer — AI/BI",
    required_years:  3,
    required_skills: ["Python", "SQL", "Spark", "ETL", "AWS", "Azure", "GCP", "Data Pipeline"],
    preferred_skills:["Kafka", "dbt", "Airflow", "Databricks", "Snowflake", "Power BI", "Tableau"]
  },
  jd_003: {
    label:           "DevSecOps Engineer",
    required_years:  4,
    required_skills: ["Docker", "Kubernetes", "CI/CD", "Jenkins", "Terraform", "AWS", "Linux", "Security"],
    preferred_skills:["Ansible", "Helm", "GitLab", "Vault", "Istio", "SAST", "DAST"]
  }
};

function skillMatch(candidateSkills, targetSkill) {
  const t = targetSkill.toLowerCase();
  return candidateSkills.some(cs => {
    const c = cs.toLowerCase();
    return c.includes(t) || t.includes(c);
  });
}

function computeScore(jdId, candidate) {
  const jd = JD_REQUIREMENTS[jdId];
  if (!jd) return { score: 50, label: "Fair Fit", rationale: "Unknown JD." };

  const cSkills = (candidate.skills || []);
  const expYears = candidate.experience_years || 0;

  const matchedReq  = jd.required_skills.filter(s  => skillMatch(cSkills, s));
  const matchedPref = jd.preferred_skills.filter(s  => skillMatch(cSkills, s));
  const missingReq  = jd.required_skills.filter(s  => !skillMatch(cSkills, s));

  // Scoring weights: required skills 60%, preferred 15%, experience 25%
  const skillScore = (matchedReq.length  / jd.required_skills.length)            * 60;
  const prefScore  = (matchedPref.length / Math.max(jd.preferred_skills.length, 1)) * 15;
  const expScore   = Math.min(expYears / jd.required_years, 1.2)                  * 25;

  const score = Math.min(Math.max(Math.round(skillScore + prefScore + expScore), 5), 99);

  let label;
  if      (score >= 80) label = "Excellent Fit";
  else if (score >= 65) label = "Good Fit";
  else if (score >= 45) label = "Fair Fit";
  else                  label = "Poor Fit";

  // Build rationale from real data
  const parts = [];

  if (matchedReq.length > 0) {
    const shown = matchedReq.slice(0, 4).join(", ");
    const extra = matchedReq.length > 4 ? ` +${matchedReq.length - 4} more` : "";
    parts.push(`Matches ${matchedReq.length}/${jd.required_skills.length} required skills: ${shown}${extra}.`);
  } else {
    parts.push(`No required skills matched for ${jd.label}.`);
  }

  if (matchedPref.length > 0) {
    parts.push(`Preferred skills: ${matchedPref.slice(0, 3).join(", ")}.`);
  }

  if (missingReq.length > 0) {
    parts.push(`Missing required: ${missingReq.slice(0, 3).join(", ")}.`);
  }

  if (expYears > 0) {
    if (expYears >= jd.required_years) {
      parts.push(`${expYears} yrs experience meets the ${jd.required_years}-yr requirement.`);
    } else {
      parts.push(`${expYears} yrs experience is below the ${jd.required_years}-yr requirement.`);
    }
  } else {
    parts.push("Experience years not detected from profile.");
  }

  return { score, label, rationale: parts.join(" ") };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  if (type === "GET_JDS") {
    sendResponse({ ok: true, data: JDS });
    return;
  }

  if (type === "GET_SCORE") {
    const result = computeScore(payload.jd_id, payload.candidate);
    console.log("[SCOUT] Score computed:", result);
    sendResponse({ ok: true, data: result });
    return;
  }

  if (type === "ADD_CANDIDATE") {
    chrome.storage.local.get(["sheetsUrl"], async ({ sheetsUrl }) => {
      if (!sheetsUrl) {
        sendResponse({ ok: false, error: "No Google Sheets URL configured. Add it in extension settings." });
        return;
      }

      console.log("[SCOUT] Sending to:", sheetsUrl);
      console.log("[SCOUT] Payload:", JSON.stringify(payload, null, 2));
      try {
        const r = await fetch(sheetsUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify(payload),
          redirect: "follow"
        });
        console.log("[SCOUT] HTTP status:", r.status, r.url);
        const text = await r.text();
        console.log("[SCOUT] Response body:", text);
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
    });
    return true; // keep channel open for async response
  }
});
