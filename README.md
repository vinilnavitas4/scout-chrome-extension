# SCOUT Chrome Extension

**Navitas AI Labs** · Built by intern · Part of the SCOUT Recruiting Agent platform

A standalone Chrome extension that overlays AI-powered fit scores on Dice.com and LinkedIn candidate profiles, and pushes selected candidates to the SCOUT platform with one click.

---

## What It Does

1. Recruiter opens a candidate profile on **Dice.com** or **LinkedIn**
2. Extension popup opens — recruiter selects an active **Job Description** from dropdown
3. Extension reads the profile (name, title, skills, location, experience) from the page
4. Sends parsed profile + selected JD to **SCOUT backend API** → receives a **fit score (0–100)** + rationale
5. Score is displayed in the popup — no page reload
6. Recruiter clicks **"Add to SCOUT"** → profile sent to SCOUT app → SCOUT handles JazzHR push + dedup

> **Note:** The extension talks only to the SCOUT backend API. It never calls JazzHR directly. All JazzHR integration, scoring engine, and dedup logic lives in SCOUT.

---

## Architecture

```
Chrome Extension (this repo)
    │
    ├── content_scripts/
    │   ├── dice.js        ← parses Dice.com profile DOM
    │   └── linkedin.js    ← parses LinkedIn profile DOM
    │
    ├── popup/
    │   ├── popup.html     ← JD dropdown + score display + Add to SCOUT button
    │   ├── popup.js       ← UI logic
    │   └── popup.css      ← styles
    │
    ├── background/
    │   └── service_worker.js  ← all API calls go here (never from content script)
    │
    └── manifest.json      ← Manifest V3
```

**API calls** (all via background service worker):
| Endpoint | Description |
|----------|-------------|
| `GET /api/jds` | Fetch active open JDs for dropdown |
| `POST /api/score` | Send parsed profile + JD ID → get fit score |
| `POST /api/candidates` | Submit candidate to SCOUT → SCOUT pushes to JazzHR |

---

## 2-Week Build Plan

### Week 1 — Build the Extension (dummy data, no backend needed)

**Day 1–2 · Setup + Manifest**
- [ ] Repo setup, Manifest V3 scaffold
- [ ] Permissions: `activeTab`, `storage`, `scripting`
- [ ] Host permissions: `https://www.dice.com/*`, `https://www.linkedin.com/*`
- [ ] Basic popup HTML/CSS + background service worker scaffold

**Day 3–4 · Content Scripts — Profile Parsing**
- [ ] Dice.com content script — extract: name, title, location, skills, years experience from DOM
- [ ] LinkedIn content script — same fields from LinkedIn profile DOM
- [ ] `console.log` parsed object to verify, store in `chrome.storage.session`

**Day 5 · Popup UI + Dummy Score**
- [ ] Popup shows parsed candidate name + title
- [ ] JD dropdown — hardcoded dummy JDs (see below)
- [ ] On JD select → show hardcoded fit score + dummy rationale
- [ ] "Add to SCOUT" button → `console.log` payload (no API call yet)
- [ ] "Already exists" mock state for UI testing

**✅ End of Week 1:** Extension installs, loads on Dice + LinkedIn, parses profile, shows score, button works — fully offline.

---

### Week 2 — Integrate SCOUT APIs

**Day 1 · Auth + Config**
- [ ] API base URL + API key in `chrome.storage.sync`
- [ ] All API calls routed through background service worker

**Day 2 · JD Dropdown → Live**
- [ ] Replace hardcoded JDs with `GET /api/jds`
- [ ] Cache result 10 min in `chrome.storage.local`

**Day 3 · Scoring → Live**
- [ ] Replace dummy score with `POST /api/score`
- [ ] Payload: `{ jd_id, candidate: { name, title, skills, location, experience_years } }`
- [ ] Response: `{ score, rationale }` → render in popup

**Day 4 · Add to SCOUT → Live**
- [ ] Replace `console.log` with `POST /api/candidates`
- [ ] Payload includes source tag: `"dice"` or `"linkedin"`
- [ ] Success → "Added ✅" | Duplicate → "Already in SCOUT — view record →"

**Day 5 · Polish + Test**
- [ ] Error states — API down, parse failed, timeout
- [ ] Loading spinners
- [ ] Test on 5 real Dice + 5 LinkedIn profiles
- [ ] Package `.zip` for internal distribution

**✅ End of Week 2:** Fully integrated. Recruiter opens profile → selects JD → sees live score → clicks Add to SCOUT → candidate lands in SCOUT + JazzHR.

---

## Dummy Data for Week 1

Use these hardcoded values while SCOUT APIs are being built.

### Dummy JDs
```json
[
  { "id": "jd_001", "title": "Java Backend Developer", "client": "Federal" },
  { "id": "jd_002", "title": "Data Engineer — AI/BI", "client": "Commercial" },
  { "id": "jd_003", "title": "DevSecOps Engineer", "client": "DoD" }
]
```

### Dummy Score Response
```json
{
  "score": 74,
  "label": "Good Fit",
  "rationale": "Candidate has 6 years Java experience and Spring Boot background matching the JD. Missing AWS certification required for this role."
}
```

### Dummy Candidate Payload (what Add to SCOUT will send)
```json
{
  "source": "dice",
  "jd_id": "jd_001",
  "candidate": {
    "name": "John Smith",
    "title": "Senior Java Developer",
    "location": "Arlington, VA",
    "skills": ["Java", "Spring Boot", "Microservices", "AWS"],
    "experience_years": 6
  }
}
```

---

## Getting Started

```bash
# Clone the repo
git clone https://github.com/vinilnavitas4/scout-chrome-extension.git
cd scout-chrome-extension

# Load in Chrome
# 1. Go to chrome://extensions
# 2. Enable "Developer mode" (top right)
# 3. Click "Load unpacked"
# 4. Select this folder
```

---

## Contact

- **Navitas AI Labs** — scout@navitastech.com
- Questions on SCOUT APIs → reach out before Week 2 starts
