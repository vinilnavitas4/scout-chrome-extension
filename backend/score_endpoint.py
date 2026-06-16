"""
SCOUT — backend-authoritative candidate scoring.

Drop-in FastAPI endpoint that the Chrome extension calls at:

    POST /api/scout/score
    body: { jd_id, candidate: { skills[], experience_years }, resume_text? }
    resp: { score, label, rationale }

Why backend: the extension used to run MiniLM embeddings in a per-device WASM
offscreen doc, so scores diverged across browsers. Running the same model on one
server makes the score identical everywhere.

This is a faithful port of the extension's local scorer (service_worker.js) so a
candidate scores the same here as in the client fallback — smooth migration.

Deps:
    pip install fastapi sentence-transformers
Model (match the client exactly):
    sentence-transformers/all-MiniLM-L6-v2   (mean-pooled, L2-normalized)

Integration TODO:
    1. Mount `router` on your existing FastAPI app:  app.include_router(router)
    2. Implement `load_job_description(jd_id)` to return the JD text you already
       serve at /api/scout/jobs/{id}.
"""

from __future__ import annotations

import re
from functools import lru_cache
from typing import Optional

import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

router = APIRouter()

# ── Model (lazy singleton) ────────────────────────────────────────────────────
# Same checkpoint the client used (Xenova/all-MiniLM-L6-v2 == this HF model).

@lru_cache(maxsize=1)
def _model() -> SentenceTransformer:
    return SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")


def _embed(texts: list[str]) -> dict[str, np.ndarray]:
    """Embed unique phrases → {phrase: unit-vector}. Mean-pooled + L2-normalized."""
    uniq = [t for t in dict.fromkeys(texts) if t]
    if not uniq:
        return {}
    vecs = _model().encode(uniq, normalize_embeddings=True)
    return {t: v for t, v in zip(uniq, vecs)}


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    # Vectors are already unit length → dot == cosine.
    return float(np.dot(a, b))


SIM_THRESHOLD = 0.55  # tuned for all-MiniLM: related ~0.6+, unrelated <0.4
# Clear-margin acceptance: borderline cosines are decided by deterministic
# lexical rules instead, so the score is stable. Mirrors the client.
SIM_MARGIN = 0.02
SIM_ACCEPT = SIM_THRESHOLD + SIM_MARGIN  # 0.57

# ── Skill normalization + aliases (port of service_worker.js) ─────────────────

def normalize_skill(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9+#./\s-]", " ", s)   # keep + # . / (c++, c#, ci/cd, node.js)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


SKILL_ALIASES = {
    "k8s": "kubernetes",
    "amazon web services": "aws",
    "google cloud platform": "gcp",
    "google cloud": "gcp",
    "large language models": "llm",
    "large language model": "llm",
    "llms": "llm",
    "machine learning": "ml",
    "artificial intelligence": "ai",
    "postgres": "postgresql",
    "js": "javascript",
    "ts": "typescript",
    "nodejs": "node.js",
    "node": "node.js",
    "reactjs": "react",
    "react.js": "react",
    "vuejs": "vue",
    "vue.js": "vue",
    "angularjs": "angular",
    "golang": "go",
    "dotnet": ".net",
    "springboot": "spring boot",
    "restful": "rest",
    "restful api": "rest",
    "restful apis": "rest",
    "rest api": "rest",
    "rest apis": "rest",
    "continuous integration": "ci/cd",
    "continuous integration/continuous delivery": "ci/cd",
    "ci cd": "ci/cd",
}


def canonical_skill(s: str) -> str:
    n = normalize_skill(s)
    return SKILL_ALIASES.get(n, n)


def _token_set(s: str) -> set[str]:
    return {t for t in re.split(r"[\s/.+#-]+", canonical_skill(s)) if len(t) > 1}


# ── JD requirement extraction (port of parseRequirements) ─────────────────────

TOOL_KEYWORDS = [
    "AWS","Azure","GCP","Docker","Kubernetes","Terraform","Jenkins","CI/CD","Linux","Ansible","Helm",
    "Java","Python","JavaScript","TypeScript","React","Angular","Vue","Spring Boot","Node.js","Flask","Django","FastAPI",".NET","C#","C++","Go","Rust","GraphQL",
    "SQL","Power BI","Power Apps","Power Automate","SharePoint","DAX","Power Query","Spark","ETL","Kafka","dbt","Airflow","Databricks","Snowflake","Tableau","Looker","MongoDB","PostgreSQL","MySQL","Redis","Elasticsearch","Neo4j",
    "LLM","GPT","OpenAI","LangChain","TensorFlow","PyTorch","Scikit","RAG",
    "Top Secret","TS/SCI","Secret clearance","FISMA","FedRAMP","NIST","DISA","STIGs",
    "REST","API","Microservices","Git","Maven","Hibernate","JUnit","Selenium","Agile","Scrum","Jira","ServiceNow","Salesforce","AEM",
]
CASE_SENSITIVE_KEYWORDS = {"Go","Rust","React","Spark","Helm","DAX","RAG","Secret clearance"}


def find_keywords(text: str) -> list[str]:
    if not text:
        return []
    found: list[str] = []
    for kw in TOOL_KEYWORDS:
        esc = re.escape(kw)
        pattern = rf"(?<![A-Za-z0-9]){esc}(?:e?s)?(?![A-Za-z0-9+#])"
        flags = 0 if kw in CASE_SENSITIVE_KEYWORDS else re.IGNORECASE
        if re.search(pattern, text, flags) and kw not in found:
            found.append(kw)
    return found


NEXT_HEADING_RE = re.compile(
    r"Set\s+Yourself\s+Apart|Clearance\s*:|About\s+Navitas|What\s+We\s+Offer|"
    r"Equal\s+Opportunity|Who\s+We\s+Are|Benefits\s*:", re.IGNORECASE)


def _slice_section(text: str, start_re: re.Pattern) -> str:
    m = start_re.search(text)
    if not m:
        return ""
    tail = text[m.start():]
    nxt = NEXT_HEADING_RE.search(tail[20:])
    return tail if not nxt else tail[: nxt.start() + 20]


def parse_requirements(description: str) -> dict:
    text = description or ""
    need = _slice_section(text, re.compile(r"What\s+You\s*'?\s*ll?\s*'?\s*Need", re.IGNORECASE)) or text
    preferred = _slice_section(text, re.compile(r"Set\s+Yourself\s+Apart", re.IGNORECASE))

    required_years = 0
    ym = re.search(r"(\d+)\+?\s*years?\b", need, re.IGNORECASE)
    if ym:
        required_years = int(ym.group(1))

    required_skills = find_keywords(need) or find_keywords(text)
    preferred_skills = [k for k in find_keywords(preferred) if k not in required_skills]

    return {
        "required_skills": required_skills,
        "preferred_skills": preferred_skills,
        "required_years": required_years,
    }


# ── Scoring (port of computeScore) ────────────────────────────────────────────

def compute_score(requirements: dict, job_title: str, skills: list[str], exp_years: float) -> dict:
    required = requirements["required_skills"]
    preferred = requirements["preferred_skills"]
    required_years = requirements["required_years"]

    if not required:
        return {"score": 50, "label": "Fair Fit",
                "rationale": "Could not extract skills from JD to score."}

    c_skills = skills or []
    vec_map = _embed([canonical_skill(s) for s in (required + preferred + c_skills)])

    def is_match(target: str) -> bool:
        tn = canonical_skill(target)
        if not tn:
            return False
        t_tok = _token_set(target)
        tv = vec_map.get(tn)
        for cs in c_skills:
            cn = canonical_skill(cs)
            if not cn:
                continue
            if cn == tn:
                return True
            c_tok = _token_set(cs)
            if t_tok and c_tok:
                small, big = (t_tok, c_tok) if len(t_tok) <= len(c_tok) else (c_tok, t_tok)
                if small <= big:
                    return True
            cv = vec_map.get(cn)
            if tv is not None and cv is not None and _cosine(tv, cv) >= SIM_ACCEPT:
                return True
        return False

    matched_req = [s for s in required if is_match(s)]
    matched_pref = [s for s in preferred if is_match(s)]
    missing_req = [s for s in required if not is_match(s)]

    req_w = (len(matched_req) / len(required)) * 60 if required else 0
    pref_w = (len(matched_pref) / len(preferred)) * 15 if preferred else 15
    if required_years:
        exp_w = min(exp_years / required_years, 1.2) * 25
    else:
        exp_w = 20 if exp_years > 0 else 10

    score = max(min(round(req_w + pref_w + exp_w), 99), 5)

    if score >= 80:   label = "Excellent Fit"
    elif score >= 65: label = "Good Fit"
    elif score >= 45: label = "Fair Fit"
    else:             label = "Poor Fit"

    parts = []
    if matched_req:
        shown = ", ".join(matched_req[:4])
        extra = f" +{len(matched_req) - 4} more" if len(matched_req) > 4 else ""
        parts.append(f"Matches {len(matched_req)}/{len(required)} required skills: {shown}{extra}.")
    else:
        parts.append(f"No required skills matched for {job_title}.")
    if matched_pref:
        parts.append(f"Preferred: {', '.join(matched_pref[:3])}.")
    if missing_req:
        parts.append(f"Missing: {', '.join(missing_req[:3])}.")
    if exp_years > 0 and required_years > 0:
        parts.append(
            f"{exp_years} yrs meets the {required_years}-yr requirement."
            if exp_years >= required_years
            else f"{exp_years} yrs is below the {required_years}-yr requirement."
        )

    return {"score": score, "label": label, "rationale": " ".join(parts)}


# ── Request/response models + route ───────────────────────────────────────────

class Candidate(BaseModel):
    skills: list[str] = []
    experience_years: float = 0


class ScoreRequest(BaseModel):
    jd_id: str
    candidate: Candidate
    resume_text: Optional[str] = None


def load_job_description(jd_id: str) -> tuple[str, str]:
    """Return (title, description) for the JD. TODO: wire to your jobs store —
    the same data you serve at /api/scout/jobs/{jd_id}."""
    raise NotImplementedError("Wire load_job_description to your jobs source")


@router.post("/api/scout/score")
def score(req: ScoreRequest) -> dict:
    title, description = load_job_description(req.jd_id)
    requirements = parse_requirements(description)

    # Résumé attached → score against the résumé's skills only (replace LinkedIn
    # skills). Guard: empty keyword scan keeps the candidate's skills so a parse
    # miss doesn't collapse the score to the no-skills floor.
    skills = req.candidate.skills
    if req.resume_text:
        resume_skills = find_keywords(req.resume_text)
        if resume_skills:
            skills = resume_skills

    return compute_score(requirements, title, skills, req.candidate.experience_years)
