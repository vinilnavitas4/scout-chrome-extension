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


# ── Clearance + location signals (mirror of service_worker.js) ────────────────
# Clearance and geography are hard hiring constraints alongside skills; the
# scorer treats each as its own bucket, renormalized in only when the JD states
# it. Kept byte-for-byte equivalent to the client so scores agree.

# Ordered high→low. A higher clearance satisfies a lower requirement.
CLEARANCE_LEVELS = [
    (4, "TS/SCI",       re.compile(r"\bTS\s*/?\s*SCI\b|\bsensitive compartmented\b", re.IGNORECASE)),
    (3, "Top Secret",   re.compile(r"\btop\s+secret\b", re.IGNORECASE)),
    (2, "Secret",       re.compile(r"\bsecret(?:\s+clearance)?\b", re.IGNORECASE)),
    (1, "Public Trust", re.compile(r"\bpublic\s+trust\b", re.IGNORECASE)),
    # Generic fallback — any mention of clearance/cleared without a named level.
    (1, "Clearance",    re.compile(r"\bclear(?:ance|ence|ances|ences)\b|\bcleared\b|\bclearable\b", re.IGNORECASE)),
]


def detect_clearance(text: str) -> dict:
    if not text:
        return {"rank": 0, "label": ""}
    for rank, label, pat in CLEARANCE_LEVELS:
        if pat.search(text):
            return {"rank": rank, "label": label}
    return {"rank": 0, "label": ""}


STATE_ABBRS = {
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
    "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
    "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
}
STATE_NAMES = {
    "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA","colorado":"CO",
    "connecticut":"CT","delaware":"DE","florida":"FL","georgia":"GA","hawaii":"HI","idaho":"ID",
    "illinois":"IL","indiana":"IN","iowa":"IA","kansas":"KS","kentucky":"KY","louisiana":"LA","maine":"ME",
    "maryland":"MD","massachusetts":"MA","michigan":"MI","minnesota":"MN","mississippi":"MS","missouri":"MO",
    "montana":"MT","nebraska":"NE","nevada":"NV","new hampshire":"NH","new jersey":"NJ","new mexico":"NM",
    "new york":"NY","north carolina":"NC","north dakota":"ND","ohio":"OH","oklahoma":"OK","oregon":"OR",
    "pennsylvania":"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD","tennessee":"TN",
    "texas":"TX","utah":"UT","vermont":"VT","virginia":"VA","washington":"WA","west virginia":"WV",
    "wisconsin":"WI","wyoming":"WY","district of columbia":"DC","washington dc":"DC","washington, dc":"DC",
}
# LinkedIn often reports a metro/city only ("Greater Boston Area", "San Francisco
# Bay Area"), with no state token. Map the major US metros to a state so those
# locations still score instead of reading as "unknown".
CITY_NAMES = {
    "san francisco":"CA","bay area":"CA","silicon valley":"CA","san jose":"CA","oakland":"CA",
    "los angeles":"CA","san diego":"CA","sacramento":"CA","orange county":"CA",
    "new york":"NY","nyc":"NY","manhattan":"NY","brooklyn":"NY",
    "boston":"MA","chicago":"IL","seattle":"WA","portland":"OR","las vegas":"NV",
    "houston":"TX","dallas":"TX","austin":"TX","san antonio":"TX","fort worth":"TX",
    "philadelphia":"PA","pittsburgh":"PA","atlanta":"GA",
    "miami":"FL","orlando":"FL","tampa":"FL","jacksonville":"FL",
    "denver":"CO","phoenix":"AZ","tucson":"AZ","detroit":"MI",
    "minneapolis":"MN","st. paul":"MN","saint paul":"MN","st paul":"MN",
    "charlotte":"NC","raleigh":"NC","durham":"NC","nashville":"TN","memphis":"TN",
    "baltimore":"MD","salt lake city":"UT","columbus":"OH","cleveland":"OH","cincinnati":"OH",
    "kansas city":"MO","st. louis":"MO","saint louis":"MO","st louis":"MO",
    "indianapolis":"IN","milwaukee":"WI","new orleans":"LA","richmond":"VA",
}


def detect_state(text: str, bare_abbr: bool) -> str:
    """Extract a US state abbreviation. `bare_abbr` allows a lone two-letter
    token — safe for a short controlled string ('City, ST') but NOT JD prose,
    where 'IN'/'OR'/'OK' false-match, so JD parsing passes False."""
    if not text:
        return ""
    comma = re.search(r",\s*([A-Za-z]{2})\b", text)
    if comma and comma.group(1).upper() in STATE_ABBRS:
        return comma.group(1).upper()
    low = text.lower()
    # "Washington DC" must beat the plain "washington" → WA state name.
    if re.search(r"washington\s*,?\s*d\.?\s*c\.?", low):
        return "DC"
    for name, ab in STATE_NAMES.items():
        if name in low:
            return ab
    for city, ab in CITY_NAMES.items():
        if city in low:
            return ab
    if bare_abbr:
        bare = re.search(r"\b([A-Z]{2})\b", text)
        if bare and bare.group(1) in STATE_ABBRS:
            return bare.group(1)
    return ""


def detect_remote(text: str) -> bool:
    if not text:
        return False
    if re.search(r"\b(?:not|no|non[\s-]?)\s*remote\b", text, re.IGNORECASE):
        return False
    return bool(re.search(r"\bremote\b", text, re.IGNORECASE))


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

    # Clearance + location scanned over the WHOLE JD (clearance often sits in a
    # "Clearance:" line outside the "Need" section). Each scores only when stated.
    required_clearance = detect_clearance(text)
    jd_state = detect_state(text, False)
    jd_remote = detect_remote(text)

    return {
        "required_skills": required_skills,
        "preferred_skills": preferred_skills,
        "required_years": required_years,
        "prominence": prominence,
        "required_clearance": required_clearance,
        "jd_state": jd_state,
        "jd_remote": jd_remote,
    }


# ── Scoring (port of computeScore) ────────────────────────────────────────────

def compute_score(requirements: dict, job_title: str, skills: list[str], exp_years: float,
                  location: str = "", clearance: str = "") -> dict:
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

    # Clearance bucket — active ONLY when the JD states a required clearance.
    # Meets/exceeds → full; holds a lower clearance → half; none → zero.
    req_clr = requirements.get("required_clearance") or {"rank": 0, "label": ""}
    cand_clr = detect_clearance(clearance)
    clearance_active = req_clr["rank"] > 0
    if not clearance_active:
        clearance_fill = 0.0
    elif cand_clr["rank"] >= req_clr["rank"]:
        clearance_fill = 1.0
    elif cand_clr["rank"] > 0:
        clearance_fill = 0.5
    else:
        clearance_fill = 0.0

    # Location bucket — active when JD is remote, or both JD + candidate states
    # are known. Remote / same state → full; different state → zero (penalized);
    # unknown either side and not remote → bucket stays out (no penalty).
    jd_remote = bool(requirements.get("jd_remote"))
    jd_state = requirements.get("jd_state") or ""
    cand_state = detect_state(location or "", True)
    location_active = jd_remote or (bool(jd_state) and bool(cand_state))
    location_fill = 1.0 if jd_remote else (1.0 if (jd_state and cand_state and jd_state == cand_state) else 0.0)

    # Renormalize so only present buckets contribute and they sum to 100 (#2).
    W_REQ, W_PREF, W_EXP, W_CLR, W_LOC = 60, 15, 25, 25, 15
    active = W_REQ                       # required always present here
    if preferred:
        active += W_PREF
    if required_years:
        active += W_EXP
    if clearance_active:
        active += W_CLR
    if location_active:
        active += W_LOC
    raw = (W_REQ / active) * req_fill * 100
    if preferred:
        raw += (W_PREF / active) * pref_fill * 100
    if required_years:
        raw += (W_EXP / active) * exp_fill * 100
    if clearance_active:
        raw += (W_CLR / active) * clearance_fill * 100
    if location_active:
        raw += (W_LOC / active) * location_fill * 100

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
    if clearance_active:
        if clearance_fill == 1.0:
            parts.append(f"Holds {cand_clr['label']} — meets the {req_clr['label']} clearance.")
        elif cand_clr["rank"] > 0:
            parts.append(f"Holds {cand_clr['label']}, below the required {req_clr['label']} clearance.")
        else:
            parts.append(f"No clearance found; role requires {req_clr['label']}.")
    # Always report location whenever the JD expresses one (remote or a state),
    # even if the candidate's state is unknown — the bucket may stay out of the
    # score, but the match/mismatch is always surfaced in the rationale.
    if jd_remote:
        parts.append("Remote role — location not a constraint.")
    elif jd_state:
        cand_loc = (location or "").strip()
        if not cand_state:
            if cand_loc:
                parts.append(f"Located in {cand_loc}; job located in {jd_state}.")
            else:
                parts.append(f"Candidate location unknown; job located in {jd_state}.")
        elif jd_state == cand_state:
            parts.append(f"Located in {cand_state} — matches the {jd_state} job location.")
        else:
            parts.append(f"Located in {cand_state}, outside the {jd_state} job location.")

    return {"score": score, "label": label, "rationale": " ".join(parts)}


# ── Request/response models + route ───────────────────────────────────────────

class Candidate(BaseModel):
    skills: list[str] = []
    experience_years: float = 0
    location: str = ""
    clearance: str = ""


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

    # Clearance text = client-detected label + résumé text fallback, so an older
    # client that doesn't send candidate.clearance still scores clearance.
    clearance_text = " ".join(t for t in (req.candidate.clearance, req.resume_text) if t)

    return compute_score(requirements, title, skills, req.candidate.experience_years,
                         location=req.candidate.location, clearance=clearance_text)
