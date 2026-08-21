# SCOUT — Candidate Fit Scorer (Chrome Extension)

**Navitas AI Labs** · Part of the SCOUT Recruiting Agent platform

A Manifest V3 Chrome extension that overlays AI fit scores on candidate profiles, attaches the candidate's résumé, and pushes them to JazzHR through the SCOUT backend — all from a side panel.

Supported profile sources:
- **LinkedIn** — `https://www.linkedin.com/in/*`
- **Dice Talent Search** — `https://www.dice.com/employers/talent-search/profile/*`

---

## What It Does

1. Recruiter opens a candidate profile on **LinkedIn** or **Dice**. A floating SCOUT button appears on the page.
2. The SCOUT side panel opens and reads the profile from the page (name, title, location, skills, experience, education, email, phone).
3. Recruiter picks an active **Job Description** — the picker is a searchable combobox: type to filter by job number, title, client, or required clearance, or open it with the chevron to browse the full list. JDs that require a clearance are badged with the level, so that gate is visible while *choosing* the job rather than only after scoring against it.
4. The parsed candidate + JD id go to the **SCOUT backend** → a **fit score (5–99)** + label + rationale come back, rendered live (no reload), with a per-category breakdown and matched/missing skill chips.
5. Optional: attach a **résumé**. Its skills and education replace the profile-scraped ones and the candidate is re-scored.
6. Optional: **Scan all JDs** scores the candidate against every open JD at once and ranks the best fits.
7. **Add to JazzHR** posts the candidate (and résumé bytes) to the backend → backend creates the candidate in **JazzHR** with the résumé attached.

> The extension talks to the **SCOUT backend API** for scoring and candidate creation. It reads the JazzHR session cookie only so the backend can act on the candidate's workflow on the recruiter's behalf (JazzHR enforces email-OTP MFA, so server-side login isn't viable).

---

## Architecture

```
Chrome Extension (this repo)
│
├── manifest.json              ← Manifest V3, side_panel, three content scripts
│
├── content_scripts/
│   ├── floating_button.js     ← the on-page SCOUT button (both sites); opens the side panel
│   ├── linkedin.js            ← scrapes LinkedIn profile DOM (scroll + overlay fetch)
│   └── dice.js                ← scrapes Dice profile DOM + flight JSON; fetches & parses
│                                 the résumé PDF with pdf.js (email, skills, JazzHR bytes)
│
├── popup/                     ← the side panel UI (popup.html / popup.js / popup.css)
│   ├── popup.js               ← tab watching, scoring, résumé parse/upload, Add to JazzHR
│   └── popup.html / .css
│
├── background/
│   └── service_worker.js      ← all backend calls; JD cache; backend+local scoring; JazzHR token
│
├── offscreen/
│   ├── offscreen.html
│   └── offscreen.js           ← all-MiniLM-L6-v2 (transformers.js) embeddings + pdf.js parsing
│
└── lib/                       ← bundled vendor libs (pdf.js, transformers.js, fflate)
```

The authoritative server scorer, `backend/score_endpoint.py`, lives in the **SCOUT backend repo**, not here. See [Scoring Mechanism](#scoring-mechanism-detailed) — the two are currently out of sync.

### Permissions
`activeTab`, `storage`, `scripting`, `sidePanel`, `offscreen`, `cookies`.

Host permissions: LinkedIn, Dice, `api.jazz.co` (JazzHR cookie), the SCOUT Azure backend, and the Hugging Face / jsDelivr CDNs the local model loads from. CSP allows `'wasm-unsafe-eval'` for the ONNX runtime; the model runs single-threaded because the extension CSP blocks the `blob:` workers a threaded build would spawn.

### Backend API (all via the service worker, with header `X-Scout-Key`)
| Endpoint | Purpose |
|----------|---------|
| `GET /api/scout/jobs` | Active JDs for the picker (cached in `storage.local`, stale-while-revalidate). Carries no clearance — see below |
| `GET /api/scout/jobs/{id}` | Full JD description (pre-fetched + parsed into requirements, cached in memory) |
| `POST /api/scout/score` | Resolved candidate + JD id → `{ score, label, rationale, categories, gates, auto_schedule }` |
| `POST /api/scout/candidates` | Create candidate in SCOUT → JazzHR (with `resume_b64` + `jazzhr_token`) |

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
- **Skills for scoring** — the full résumé skill read described under [Inputs](#inputs) (overrides Dice's generic single-word skills like *ide / software / configuration*).
- **Résumé bytes (base64)** — carried on the candidate so **Add to JazzHR** attaches the PDF without a manual upload.

A late-render watcher re-reads the résumé for ~25 s and pushes an updated candidate to the panel (which re-scores) if more text appears.

---

## Scoring Mechanism (detailed)

Scoring is **backend-authoritative**: the same model runs once on the server so every device/browser gets an identical score. If the endpoint is unavailable, the extension falls back to a **local** score computed in the offscreen document. Both paths are meant to be the *same algorithm* — `backend/score_endpoint.py` is a port of `service_worker.js`.

> ⚠️ **The two are currently out of sync.** The backend still runs the older résumé rule and the older JD miner. The worker compensates by resolving the résumé itself and not handing the raw text over (see [Inputs](#inputs)), but the **JD side is still backend-owned**: on the backend path the required-skill list in the response is the backend's, so prose fragments its miner emits (`build scalable`, `FastAPI to design`) appear as permanently-unmatchable requirements even though this file's `isPlausibleSkill` rejects them. Re-porting `score_endpoint.py` from this file clears both.

### Inputs
`POST /api/scout/score` body:
```json
{ "jd_id": "…", "candidate": { "skills": ["…"], "experience_years": 14, "experience_text": "…" } }
```
The service worker applies the **résumé-replace rule before scoring** (so it affects both backend and local paths): when a résumé is attached, the candidate's skills are replaced by the union of

- `findKeywords(resume_text)` — the `TOOL_KEYWORDS` whitelist,
- `resumeListedSkills(resume_text)` — the résumé's own Skills section read verbatim, which is the only source for anything off the whitelist (Blazor, Datadog, Query Optimization…),
- `resumeExperienceSkills(resume_text)` — the stack named inside the role entries (`Environment:` lines).

An *empty* result keeps the original skills (a parse miss must not collapse the score). Résumé **education** replaces the profile's the same way, read from the Education section only.

> **`resume_text` is not sent to the backend.** `score_endpoint.py` still ports the older whitelist-only rule, so receiving the text made it re-derive the skill set and discard the two richer sources above — a résumé listing *Database Design, Query Optimization, Scalable System Design* scored as if it listed none of them, while the local path matched all three. The worker resolves the résumé fully before the call, so `candidate` **is** the résumé: its skills, its education, and its full text as `experience_text` (mirroring `computeScore`'s `textHas` source, which prefers résumé text over profile bullets). Restore the field once the backend parser is a faithful port again.

### Step 1 — Parse JD into requirements (`parseRequirements`)
Sections are sliced by **heading**, not by newline: JD text arrives from the backend as one line with apostrophes stripped, so headings are the only reliable boundary.

- **Required block** = `"What You'll Need"` and the generic ATS equivalents (`Required Qualifications`, `Requirements`, `Must-Haves`, `What We're Looking For`, …), up to the next known heading. Falls back to the whole description if the slice comes back empty.
- **Preferred block** = `"Set Yourself Apart"`, `Preferred Qualifications`, `Nice-to-Haves`, `Bonus Points`, … Anything already required is removed from preferred.
- `required_skills` / `preferred_skills` = **keyword scan ∪ enumeration mining**:
  - `findKeywords` — a fixed **215-term** `TOOL_KEYWORDS` whitelist. Whole-word, plural-tolerant, and **case-sensitive for 27 ambiguous short tokens** (`Go`, `R`, `C`, …) so `Rust` ⊄ `trusted`.
  - `extractListedSkills` — phrases behind an explicit cue (`experience with:`, `Environment:`, `Tech stack:`) so a tool off the whitelist still becomes a requirement. Prose-shaped fragments are rejected by `isPlausibleSkill`.
- `prominence[skill]` = how many times the whole JD mentions it. Used to weight the required fill, so missing a core, repeated skill costs more than missing a one-off.
- `required_years` = the **largest** `N years` in the required block (not the first — a stray "3 years" must not undercut "8+ years"). ⚠️ Parsed and returned, but **not currently scored**.
- `required_clearance`, `required_education`, `required_certs`, `jd_state`, `jd_remote` — each only scores when the JD actually states it. Clearance and location are scanned over the *whole* JD (a `Clearance:` line often sits outside the required block). `jd_state` prefers the posting's structured city/state fields over prose, then falls back to the title.

### Step 2 — Match candidate skills to JD skills (`isMatch`)
For each required/preferred skill, in this order — first hit wins:
1. **Canonical exact** — after `normalizeSkill` + `SKILL_ALIASES` (`k8s→kubernetes`, `amazon web services→aws`, `reactjs→react`, …).
2. **Token containment** — one phrase's tokens ⊆ the other's (`react` ⊆ `react.js`).
3. **Semantic** — cosine of **all-MiniLM-L6-v2** embeddings ≥ **0.58** (`SIM_THRESHOLD` 0.55 + `SIM_MARGIN` 0.03). The margin band is decided by the lexical rules above so borderline cosines don't flip the score between devices.
4. **Full-text scan** (`makeTextMatcher`) — the skill written up in the *résumé text*, or in the profile's experience bullets when no résumé is attached. Alias-aware and plural-tolerant, so a JD asking for `API` matches a résumé that wrote `APIs`.

### Step 3 — Weighted score over *active* buckets
Each bucket yields a fill of 0–1. A bucket is **active** only when the JD states that constraint — an unstated one is dropped, never given free credit, and the remaining weights are renormalized to 100.

| Bucket | Weight | Active when | Fill |
|--------|-------:|-------------|------|
| Required Skills | 35 | always | prominence-weighted matched ÷ total |
| Preferred Skills | 15 | JD lists any | matched ÷ total |
| Clearance | 20 | JD states one | meets/exceeds → 1 · holds a lower level → 0.5 · none → 0 (an unspecified "active clearance" counts as 1) |
| Education | 15 | JD states a degree | meets/exceeds → 1 · lower degree → 0.5 · none → 0 |
| Location / Commute | 15 | JD is remote, **or** both regions known | remote → 1 · same region → 1 · different → 0 |

```
score = clamp(round( Σ active (weight / Σ active weights) × fill × 100 ), 5, 99)
```

Regions are country-namespaced (`US-TX`, `IN-TN`), so the same rule works outside the US. Candidate degree level is read from **Education-section entries only** — a stray "master's" in About or résumé prose can't inflate it. `calibrate()` (a logistic squash) is wired in but **disabled**; raw passes through.

> The backend's location detection is weaker than this worker's, so it drops the Location bucket on postings that do name a place. `repairBackendLocation` resolves the region locally, folds the bucket back in, and renormalizes the composite — the ring and the breakdown card are always derived from the same category list.

### Step 4 — Label, rationale, breakdown
| Score | Label |
|-------|-------|
| ≥ 80 | Excellent Fit |
| 65–79 | Good Fit |
| 45–64 | Fair Fit |
| < 45 | Poor Fit |

The panel renders three things from one response: the **score ring**, a **Category Breakdown** (weight, sub-score, points earned, fill bar per active bucket), and **Skills** chips (matched vs missing, required and preferred). The rationale string lists matched required skills (`Matches 4/6 required skills: …`), top preferred, top missing, plus a sentence each for education, clearance, and location whenever the JD states them.

### Auto-scheduling gate
Separate from the composite — a hard pass/fail used to decide whether a candidate can be advanced without review:

```
auto_schedule = score >= 80
                && every required skill matched     (reqFill == 1)
                && every JD-named certification found
                && clearance bucket inactive or fully met
                && location bucket inactive or fully met
```

Certifications are matched whole-word from a 25-entry `CERT_KEYWORDS` list over the candidate's skills, About, certifications, and experience text. A JD naming no certification passes that gate automatically.

### Consistency notes
- The local fallback uses per-device WASM embeddings, so a machine that drops to it can score slightly differently. The backend call retries on 5xx/429/network/timeout and only falls through on a definitive **404** (endpoint not deployed) or a malformed body, to keep every device on the deterministic server path.
- JD descriptions are pre-fetched and cached in-memory after the picker loads, so the first score is instant. Every writer of that cache goes through `jobCacheEntry`, so a warm cache can't lose the location fallbacks.
- **Clearance badges in the picker** ride on that same prefetch. `GET /api/scout/jobs` returns no clearance field — the requirement only exists in the description — so `prefetchJobDescriptions` parses each JD, then `publishJobClearances` merges the labels into the cached job list *by id* (a background revalidate may have replaced it meanwhile) and pushes a `JD_CLEARANCES` message to any open panel, which repaints the list in place. On a warm open the badges come straight from `storage.local` with no wait; on a cold one they appear a moment after the list does.
- The console logs the path taken and the inputs behind it — `[SCOUT] score source: backend|local`, `[SCOUT] résumé skills: N (…)` with the extracted lists, and `[SCOUT] computeScore inputs:` on the local path. Start there when two machines disagree.

> **Known limitations:** `required_years` is parsed but not scored, so depth of experience does not move the number. Off-whitelist skills depend on the JD/résumé writing them as an explicit list — a tool named only in prose is still missed. Skill matches are binary (recency and duration are ignored; JD-side importance is weighted only by mention count). A skills list written with no delimiters at all (`Languages Java Python Go`) yields nothing beyond whitelist hits. Work authorization is available on Dice but not yet used as a gate.

---

## Résumé Handling

- **Manual upload** (LinkedIn or override): the panel parses **PDF** (pdf.js) and **DOCX** (fflate unzip → `word/document.xml`) properly; `.txt` and anything else the picker accepts (`.doc`, `.rtf`, `.odt`) fall back to a raw `file.text()` read. It then fills any blank email/phone, re-scores against the résumé, and sends `resume_b64` to JazzHR.
- **Dice (automatic):** the résumé PDF is fetched and parsed from the profile — no upload needed. Its bytes ride along to JazzHR on **Add to JazzHR**; manual upload still overrides.

### Getting real lines out of a résumé
Every section slicer depends on line boundaries, so text extraction is where résumé scoring lives or dies. Both extractors rebuild real lines rather than flattening the document:

- **PDF** (`pageItemsToText`): pdf.js returns positioned runs, not lines — a single word is routinely split across runs by kerning (`Kub` + `ernetes`) and line breaks exist only in the coordinates. A new line is emitted when the baseline moves or a run starts left of where the last one ended (a column/table-cell jump); a **tab** on a wide same-baseline gap (a column break); a **space** on a real word gap; and **nothing** between two runs of one word.
- **DOCX**: `</w:p>`, `<w:br/>`, `</w:tr>` → newline and `</w:tc>`, `<w:tab/>` → tab **before** tags are stripped. Word splits one word across several `<w:t>` runs and keeps bullets in numbering properties, not in the text, so a naive tag-strip produced a single 40-word "skill".

Section headings are then found by **line position**, with ALL-CAPS used as a fallback only when the extractor returned no line breaks at all. A caps-anywhere test used to end the Skills block early on a row like `CLOUD EXPERIENCE: AWS, Azure, GCP` — every skill below that row was silently dropped.

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

Then open a LinkedIn `/in/` or Dice Talent Search profile and click the floating SCOUT button on the page (or the toolbar icon) to open the side panel.

> The backend base URL and the `X-Scout-Key` shared secret live in `background/service_worker.js`.

The embedding model (~23 MB, quantized `Xenova/all-MiniLM-L6-v2`) downloads from the Hugging Face hub on first use and is then served from browser Cache Storage. The offscreen document warms it on load, so the first score doesn't pay the download; until it's ready the panel shows a loading state and clears it on `MODEL_READY`. This only affects the **local** fallback path.

### Debugging a score
Open the service worker console from `chrome://extensions` → **service worker**:

| Log line | Tells you |
|----------|-----------|
| `[SCOUT] score source: backend \| buckets: …` | which path scored, and which buckets were active |
| `[SCOUT] résumé skills: N (X from Skills section, Y from Experience)` | whether the résumé parsed, and exactly what came out of each reader |
| `[SCOUT] computeScore inputs: {…}` | local path only — candidate skills, JD requirements, matched/missing |

If the résumé log shows a healthy count but the panel still marks those skills missing, the score came from the backend and the divergence noted under [Scoring Mechanism](#scoring-mechanism-detailed) is the cause.

---

## Contact

- **Navitas AI Labs** — scout@navitastech.com
