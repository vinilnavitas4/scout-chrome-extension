# SCOUT — Candidate Fit Scorer (Chrome Extension)

**Navitas AI Labs** · Part of the SCOUT Recruiting Agent platform

A Manifest V3 Chrome extension that overlays AI fit scores on candidate profiles, attaches the candidate's résumé, pushes them to JazzHR through the SCOUT backend, and can place/schedule an AI phone screen — all from a side panel.

Supported profile sources:
- **LinkedIn** — `https://www.linkedin.com/in/*`
- **Dice Talent Search** — `https://www.dice.com/employers/talent-search/profile/*`

---

## What It Does

1. Recruiter opens a candidate profile on **LinkedIn** or **Dice**.
2. The SCOUT side panel opens and reads the profile from the page (name, title, location, skills, experience, education, email, phone).
3. Recruiter picks an active **Job Description** from the dropdown.
4. The parsed candidate + JD id go to the **SCOUT backend** → a **fit score (0–100)** + label + rationale come back, rendered live (no reload).
5. **Add to SCOUT** posts the candidate (and résumé) to the backend → backend creates the candidate in **JazzHR** with the résumé attached.
6. Optional: **Call with AI** places (or schedules) a Vapi phone screen; the result is polled and shown in the panel.

> The extension talks to the **SCOUT backend API** for scoring, candidate creation, and calls. It reads the JazzHR session cookie only to let the backend update the candidate's workflow on the recruiter's behalf.

---

## Architecture

```
Chrome Extension (this repo)
│
├── manifest.json              ← Manifest V3, side_panel, two content scripts
│
├── content_scripts/
│   ├── linkedin.js            ← scrapes LinkedIn profile DOM (scroll + overlay fetch)
│   └── dice.js                ← scrapes Dice profile DOM + flight JSON; fetches & parses
│                                 the résumé PDF with pdf.js (email, skills, JazzHR bytes)
│
├── popup/                     ← the side panel UI (popup.html / popup.js / popup.css)
│   ├── popup.js               ← tab watching, scoring, résumé upload, Add to SCOUT, Vapi
│   └── popup.html / .css
│
├── background/
│   └── service_worker.js      ← all backend calls; JD cache; backend+local scoring; JazzHR token
│
├── offscreen/
│   ├── offscreen.html
│   └── offscreen.js           ← runs all-MiniLM-L6-v2 (transformers.js) for the LOCAL score fallback
│
├── lib/                       ← bundled vendor libs (pdf.js, transformers.js, fflate)
│
└── backend/
    └── score_endpoint.py      ← FastAPI port of the scorer (the authoritative server scorer)
```

### Permissions
`activeTab`, `storage`, `scripting`, `sidePanel`, `offscreen`, `cookies`.

Host permissions: LinkedIn, Dice, `api.jazz.co` (JazzHR cookie), the SCOUT Azure backend, and the Hugging Face / jsDelivr CDNs the local model loads from.

### Backend API (all via the service worker, with header `X-Scout-Key`)
| Endpoint | Purpose |
|----------|---------|
| `GET /api/scout/jobs` | Active JDs for the dropdown (cached in `storage.local`, stale-while-revalidate) |
| `GET /api/scout/jobs/{id}` | Full JD description (pre-fetched + parsed into requirements) |
| `POST /api/scout/score` | Candidate skills + experience (+ résumé text) → `{ score, label, rationale }` |
| `POST /api/scout/candidates` | Create candidate in SCOUT → JazzHR (with `resume_b64`) |
| `POST /api/scout/initiate-call` | Start a Vapi AI phone screen |
| `POST /api/scout/schedule-call` | Schedule a Vapi call for later |
| `GET /api/scout/calls/{applicant_id}` | Poll call status / result |

---

## Profile Extraction

### LinkedIn (`content_scripts/linkedin.js`)
Scrolls the profile to force lazy sections to render, then parses the topcard, Experience, Skills (including the "Show all skills" modal), Education, About, and the contact-info overlay (email/phone) — with retries for the timing differences seen across machines.

### Dice (`content_scripts/dice.js`)
Recruiter-view Talent Search profile. Data is merged from three sources:
1. **Rendered DOM** (`data-testid` + section headings) — always current, survives in-page SPA navigation.
2. **Embedded Next.js flight JSON** (`initialProfileData`) — complete skill list, clean experience history, locations, education. Guarded by a `candidateId === URL-uuid` check so a stale payload from a previous profile is never used.
3. **The résumé PDF** — located in the page's resource timeline (by `resumeId` / `resumeDocumentId`), fetched, and parsed with the bundled **pdf.js**. This is render-independent (the on-page react-pdf text layer is unreliable).

From the résumé the extension derives:
- **Email** — the real address (Dice's `emailSources` is a masked `@mail.dice.com` relay).
- **Skills for scoring** — a tech-keyword scan over the full résumé text (overrides Dice's generic single-word skills like *ide / software / configuration*).
- **Résumé bytes (base64)** — carried on the candidate so **Add to SCOUT** attaches the PDF to JazzHR without a manual upload.

A late-render watcher re-reads the résumé for ~25 s and pushes an updated candidate to the panel (which re-scores) if more text appears.

---

## Scoring Mechanism (detailed)

Scoring is **backend-authoritative**: the same model runs once on the server so every device/browser gets an identical score. If the endpoint is unavailable, the extension falls back to a **local** score computed in the offscreen document. Both paths are the *same algorithm* (`backend/score_endpoint.py` is a faithful port of `service_worker.js`).

### Inputs
`POST /api/scout/score` body:
```json
{ "jd_id": "…", "candidate": { "skills": ["…"], "experience_years": 14 }, "resume_text": "…optional…" }
```
The service worker applies the **résumé-replace rule before scoring** (so it affects both backend and local paths): when `resume_text` is present, the candidate's skills are replaced by `findKeywords(resume_text)` — the résumé's keywords are the real signal. An *empty* keyword scan keeps the original skills (a parse miss must not collapse the score).

### Step 1 — Parse JD into requirements (`parseRequirements`)
- Slice the **"What You'll Need"** section (up to the next known heading) as the required block; **"Set Yourself Apart"** as preferred.
- `required_years` = first `N years` match in the required block.
- `required_skills` / `preferred_skills` = keyword scan (`findKeywords`) over those sections, using a fixed ~90-term `TOOL_KEYWORDS` list. Whole-word, case-sensitive for ambiguous short tokens (`Go`, `Rust`, …) to avoid false hits (`Rust` ⊄ `trusted`).

### Step 2 — Match candidate skills to JD skills (`isMatch`)
For each required/preferred skill, check the candidate's skills in this order:
1. **Canonical exact** — after `normalizeSkill` + `SKILL_ALIASES` (`k8s→kubernetes`, `amazon web services→aws`, `reactjs→react`, …).
2. **Token containment** — one phrase's tokens ⊆ the other's (`react` ⊆ `react.js`).
3. **Semantic** — cosine of **all-MiniLM-L6-v2** embeddings ≥ **0.57** (threshold 0.55 + 0.02 margin). The margin band is decided by the lexical rules above so borderline cosines don't flip the score between devices.

### Step 3 — Weighted score
```
required  = (matched_required  / total_required ) * 60
preferred = (matched_preferred / total_preferred) * 15      # 15 if JD lists none
experience:
    required_years > 0 → min(exp_years / required_years, 1.2) * 25
    else               → 20 if exp_years > 0 else 10

score = clamp(round(required + preferred + experience), 5, 99)
```

### Step 4 — Label + rationale
| Score | Label |
|-------|-------|
| ≥ 80 | Excellent Fit |
| 65–79 | Good Fit |
| 45–64 | Fair Fit |
| < 45 | Poor Fit |

Rationale string lists matched required skills (`Matches 4/6 required skills: …`), top preferred, top missing, and whether experience meets the requirement.

### Consistency notes
- The local fallback uses per-device WASM embeddings, so a machine that drops to it can score slightly differently. The backend call retries on 5xx/429/network/timeout and only falls through on a definitive 404 or malformed body, to keep every device on the deterministic server path.
- JD descriptions are pre-fetched and cached in-memory after the dropdown loads, so the first score is instant.

> **Known limitations:** JD/résumé skill extraction is bounded by the fixed keyword list; skill matches are binary (no importance/recency weighting); `required_years` is a naive regex; hard signals available on Dice (work authorization, clearance, location) are not yet used as gates.

---

## Résumé Handling

- **Manual upload** (LinkedIn or override): the panel parses PDF (pdf.js) / DOCX (fflate) / text, fills any blank email/phone, re-scores against the résumé, and sends `resume_b64` to JazzHR.
- **Dice (automatic):** the résumé PDF is fetched and parsed from the profile — no upload needed. Its bytes ride along to JazzHR on **Add to SCOUT**; manual upload still overrides.

---

## AI Phone Screen (Vapi)

After a candidate is added, **Call with AI** (or **Schedule call**) sends the applicant id, job, phone, and the JazzHR session token to the backend, which drives a Vapi call. The panel polls `GET /api/scout/calls/{applicant_id}` and renders the status, summary, and any captured structured data.

---

## Getting Started

```bash
git clone https://github.com/vinilnavitas4/scout-chrome-extension.git
cd scout-chrome-extension
```

Load in Chrome:
1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder

Then open a LinkedIn `/in/` or Dice Talent Search profile and click the SCOUT toolbar icon to open the side panel.

> The backend base URL and the `X-Scout-Key` shared secret live in `background/service_worker.js`.

---

## Contact

- **Navitas AI Labs** — scout@navitastech.com
