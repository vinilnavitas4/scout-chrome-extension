"""
SCOUT — backend-authoritative candidate scoring.

Drop-in FastAPI endpoint that the Chrome extension calls at:

    POST /api/scout/score
    body: { jd_id, candidate: { skills[], experience_years }, resume_text? }
    resp: { score, label, rationale }

Why backend: the extension used to run MiniLM embeddings in a per-device WASM
offscreen doc, so scores diverged across browsers. This server is the single
source of truth — the client always calls it first and only drops to its local
embedding path on a hard failure.

This mirrors the extension's local scorer (service_worker.js) rubric exactly, so
the deterministic part of the score is identical. NOTE: the embedding match can
differ marginally because the client runs the q8-quantized Xenova model while
this server runs full-precision sentence-transformers (same checkpoint, ~0.01-0.02
cosine drift). The lexical rules + a widened margin keep borderline pairs stable.

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
# lexical rules instead, so the score is stable. Margin widened to absorb the
# q8(client) vs fp32(server) drift. Mirrors the client.
SIM_MARGIN = 0.03
SIM_ACCEPT = SIM_THRESHOLD + SIM_MARGIN  # 0.58

# Score calibration (#8): map raw rubric score → calibrated 0-100 the way
# recruiters actually rate fit. Identity until fitted on labeled outcomes
# (raw_score, hired/advanced?) — fit a logistic, then set enabled=True with k/x0.
CALIBRATION = {"enabled": False, "k": 0.12, "x0": 50.0}


def calibrate(raw: float) -> float:
    if not CALIBRATION["enabled"]:
        return raw
    import math
    return 100.0 / (1.0 + math.exp(-CALIBRATION["k"] * (raw - CALIBRATION["x0"])))

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


# ── Off-list skill mining (#1) ────────────────────────────────────────────────
# TOOL_KEYWORDS can't enumerate every tool; mine extra skills from explicit
# enumerations (a "skills cue" followed by a delimited list) so off-list skills
# still score, without scraping whole prose sentences into the requirement set.
SKILL_CUE_RE = re.compile(
    r"(?:experience (?:with|in|using)|proficien\w* (?:with|in)|knowledge of|"
    r"familiar\w* with|expertise in|skilled in|hands[\s-]?on (?:experience )?with|"
    r"working knowledge of|background in|competen\w* in|specific tools[^:]*:|"
    r"skills?\s*:|technologies?\s*:|tech\s*stack\s*:)", re.IGNORECASE)

SKILL_STOPWORDS = {
    "ability","strong","excellent","good","years","year","experience","knowledge","skills","skill",
    "written","verbal","communication","team","teams","etc","including","environment","environments",
    "related","equivalent","degree","plus","preferred","required","work","working","other","various",
    "such","as","is","are","be","you","your","our","we","will","must","should","have","proven","a","an",
    "the","and","or","with","in","of","to","using","for","on","at","but","not","this","that",
}


def extract_listed_skills(section: str) -> list[str]:
    if not section:
        return []
    out: list[str] = []
    for m in SKILL_CUE_RE.finditer(section):
        if len(out) >= 15:
            break
        clause = section[m.end(): m.end() + 140]
        stop = re.search(r"[.;]", clause)
        if stop:
            clause = clause[: stop.start()]
        for phrase in re.split(r"[,/|]|\band\b|\n", clause, flags=re.IGNORECASE):
            phrase = re.sub(r"^[\s\-*•]+", "", phrase)
            phrase = re.sub(r"\s+", " ", phrase).strip()
            if len(phrase) < 2 or len(phrase) > 40:
                continue
            toks = phrase.lower().split()
            if len(toks) > 3:
                continue
            if all(t in SKILL_STOPWORDS for t in toks):
                continue
            if not re.search(r"[a-z0-9]", phrase, re.IGNORECASE):
                continue
            if not any(o.lower() == phrase.lower() for o in out):
                out.append(phrase)
    return out


def skill_prominence(skill: str, text: str) -> int:
    """How many times the JD mentions a skill (#7); floored at 1."""
    if not text or not skill:
        return 1
    esc = re.escape(str(skill))
    if not esc:
        return 1
    hits = re.findall(rf"(?<![A-Za-z0-9]){esc}(?![A-Za-z0-9])", text, re.IGNORECASE)
    return max(len(hits), 1)


def _dedupe_by(items, key):
    seen, out = set(), []
    for x in items:
        k = key(x)
        if k not in seen:
            seen.add(k)
            out.append(x)
    return out


def parse_requirements(description: str) -> dict:
    text = description or ""
    need = _slice_section(text, re.compile(r"What\s+You\s*'?\s*ll?\s*'?\s*Need", re.IGNORECASE)) or text
    preferred = _slice_section(text, re.compile(r"Set\s+Yourself\s+Apart", re.IGNORECASE))

    # Largest stated year requirement, not the first match (#6).
    required_years = 0
    for ym in re.finditer(r"(\d+)\+?\s*years?\b", need, re.IGNORECASE):
        required_years = max(required_years, int(ym.group(1)))

    required_skills = find_keywords(need) or find_keywords(text)
    required_skills = _dedupe_by(
        required_skills + extract_listed_skills(need), canonical_skill)

    preferred_raw = _dedupe_by(
        find_keywords(preferred) + extract_listed_skills(preferred), canonical_skill)
    req_canon = {canonical_skill(s) for s in required_skills}
    preferred_skills = [k for k in preferred_raw if canonical_skill(k) not in req_canon]

    prominence = {s: skill_prominence(s, text) for s in (required_skills + preferred_skills)}

    return {
        "required_skills": required_skills,
        "preferred_skills": preferred_skills,
        "required_years": required_years,
        "prominence": prominence,
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

    # Prominence-weighted required fill (#7): core, oft-repeated skills dominate.
    prom = requirements.get("prominence", {})
    w_of = lambda s: max(prom.get(s, 1), 1)
    req_total = sum(w_of(s) for s in required)
    req_matched = sum(w_of(s) for s in matched_req)
    req_fill = req_matched / req_total if req_total else 0
    pref_fill = (len(matched_pref) / len(preferred)) if preferred else 0
    exp_fill = min(exp_years / required_years, 1) if required_years else 0  # cap 1.0 (#3)

    # Renormalize so only present buckets contribute and they sum to 100 (#2).
    W_REQ, W_PREF, W_EXP = 60, 15, 25
    active = W_REQ                       # required always present here
    if preferred:
        active += W_PREF
    if required_years:
        active += W_EXP
    raw = (W_REQ / active) * req_fill * 100
    if preferred:
        raw += (W_PREF / active) * pref_fill * 100
    if required_years:
        raw += (W_EXP / active) * exp_fill * 100

    score = max(min(round(calibrate(raw)), 99), 5)

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
