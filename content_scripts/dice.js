// Dice Talent Search profile parser — extracts name, title, location, skills,
// experience_years, experience, education, email, phone from a recruiter-view
// candidate profile (https://www.dice.com/employers/talent-search/profile/<uuid>).
// Stores result in chrome.storage.session under key "scout_candidate", mirroring
// the LinkedIn parser's output shape so the side panel / backend are unchanged.
//
// Two data sources, merged:
//   1. Rendered DOM (data-testid + section headings) — always current, survives
//      client-side SPA navigation between profiles.
//   2. Embedded Next.js flight JSON (initialProfileData) — complete skill list
//      (the DOM truncates to ~9), clean experience history, email/phone sources.
// The JSON is guarded by a candidateId === URL-uuid check so a stale SSR payload
// from a previous profile is never used after an in-page navigation.

function diceProfileId(url) {
  const m = (url || '').match(/talent-search\/profile\/([0-9a-f-]+)/i);
  return m ? m[1].toLowerCase() : '';
}

// ── DOM scrapers ──────────────────────────────────────────────────────────────

function sectionByHeading(text) {
  const target = text.toLowerCase();
  for (const h2 of document.querySelectorAll('section h2')) {
    if ((h2.textContent || '').trim().toLowerCase() === target) return h2.closest('section');
  }
  return null;
}

function domText(sel) {
  const el = document.querySelector(sel);
  return el ? (el.textContent || '').trim() : '';
}

function domSkills() {
  const sec = sectionByHeading('Skills');
  if (!sec) return [];
  const out = [], seen = new Set();
  // Each skill chip is `<div title="Ide"><div class="Text">Ide</div>…</div>`.
  sec.querySelectorAll('.Text').forEach(el => {
    const s = (el.textContent || '').trim();
    if (s && s.length < 80 && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
  });
  return out;
}

function domExperience() {
  const sec = sectionByHeading('Work History');
  if (!sec) return [];
  const out = [];
  // Each role: `<div class="mb-4"><h2>AEM Developer @ T3</h2>7/2020 - No end date</div>`.
  sec.querySelectorAll('div.mb-4').forEach(item => {
    const h = item.querySelector('h2');
    if (!h) return;
    const head = (h.textContent || '').trim();
    const dates = (item.textContent || '').replace(head, '').trim();
    let title = head, company = '';
    const parts = head.split(' @ ');
    if (parts.length >= 2) { title = parts[0].trim(); company = parts.slice(1).join(' @ ').trim(); }
    if (title) out.push({ title, company, dates });
  });
  return out;
}

function domEducation() {
  const sec = sectionByHeading('Education');
  if (!sec) return [];
  const out = [];
  // Each: `<label>Masters</label><span>Lamar University - Beaumont</span>`.
  sec.querySelectorAll('label').forEach(l => {
    const degree = (l.textContent || '').trim();
    const school = (l.parentElement?.querySelector('span')?.textContent || '').trim();
    if (school || degree) out.push({ school, degree, dates: '' });
  });
  return out;
}

function domPhone() {
  const a = document.querySelector('a[href^="tel:"]');
  if (!a) return '';
  const digits = (a.getAttribute('href') || '').replace(/^tel:/, '').replace(/[^\d+]/g, '');
  return digits || (a.textContent || '').trim();
}

// Full résumé text from the "Resume" section's in-page PDF text layer (react-pdf).
// Used to score against the JD, recover the candidate's real email (Dice's JSON
// only exposes a masked @mail.dice.com relay), and fill the `about` blob.
// Scoped to the Resume section so unrelated react-pdf text elsewhere can't leak
// in; falls back to a page-wide scan if the section can't be located.
function resumeText() {
  // The react-pdf viewer only exists inside the Resume section, so a document-wide
  // read can't pull in unrelated text — and it avoids a miss if section scoping
  // ever fails. Includes a textLayer fallback for older react-pdf class names.
  const spans = document.querySelectorAll(
    '.react-pdf__Page__textContent span[role="presentation"], .textLayer span[role="presentation"]'
  );
  if (!spans.length) return '';
  return Array.from(spans).map(s => s.textContent).join(' ').replace(/\s+/g, ' ').trim();
}

// Render-independent résumé text: find the résumé PDF the page already fetched
// (via the shared performance resource timeline / embedded ids) and parse it with
// the bundled pdf.js. Used when the on-page react-pdf text layer never renders or
// renders only partially — the cause of the résumé "not reading properly".
function findResumePdfUrl() {
  const json = getDiceJson();
  const ids = [];
  if (json) { [json.resumeId, json.resumeDocumentId, json.id].forEach(v => v && ids.push(v)); }
  const urls = performance.getEntriesByType('resource').map(e => e.name);
  for (const id of ids) {
    const hit = urls.find(u => u.includes(id));
    if (hit) return hit;
  }
  // Any résumé/PDF-looking resource as a last resort.
  return urls.find(u => /resume|cv|\.pdf(\?|$)/i.test(u) && !/\.(png|jpe?g|svg|css|js)(\?|$)/i.test(u)) || '';
}

async function fetchResumePdfText() {
  try {
    if (typeof pdfjsLib === 'undefined') { console.warn('[SCOUT] pdf.js not loaded'); return ''; }
    const url = findResumePdfUrl();
    if (!url) { console.warn('[SCOUT] résumé PDF url not found in resource timeline'); return ''; }
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) { console.warn('[SCOUT] résumé fetch HTTP', res.status); return ''; }
    const buf = await res.arrayBuffer();
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let out = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const content = await (await pdf.getPage(i)).getTextContent();
      out += content.items.map(it => it.str).join(' ') + '\n';
    }
    console.log(`[SCOUT] résumé via PDF fetch: ${out.length} chars from ${url}`);
    return out.replace(/\s+/g, ' ').trim();
  } catch (e) {
    console.warn('[SCOUT] résumé PDF parse failed:', e.message);
    return '';
  }
}

// Best résumé text: prefer the fetched-and-parsed PDF (complete, render-proof),
// fall back to whatever the on-page text layer has rendered.
async function bestResumeText() {
  const dom = resumeText();
  const pdf = await fetchResumePdfText();
  return pdf.length > dom.length ? pdf : dom;
}

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
function realEmailFrom(text) {
  for (const e of (text || '').match(EMAIL_RE) || []) {
    if (!/mail\.dice\.com$/i.test(e.split('@')[1] || '')) return e;
  }
  return '';
}

// Tech-keyword scan over résumé text → candidate skills. Mirrors the service
// worker's TOOL_KEYWORDS / findKeywords so the résumé-derived skills match what
// the scorer would extract. Dice's own skill list is generic single words
// (ide/software/configuration); the résumé keywords are the real signal.
const RESUME_SKILL_KEYWORDS = [
  "AWS","Azure","GCP","Docker","Kubernetes","Terraform","Jenkins","CI/CD","Linux","Ansible","Helm",
  "Java","Python","JavaScript","TypeScript","React","Angular","Vue","Spring Boot","Node.js","Flask","Django","FastAPI",".NET","C#","C++","Go","Rust","GraphQL",
  "SQL","Power BI","Power Apps","Power Automate","SharePoint","DAX","Power Query","Spark","ETL","Kafka","dbt","Airflow","Databricks","Snowflake","Tableau","Looker","MongoDB","PostgreSQL","MySQL","Redis","Elasticsearch","Neo4j",
  "LLM","GPT","OpenAI","LangChain","TensorFlow","PyTorch","Scikit","RAG",
  "Top Secret","TS/SCI","Secret clearance","FISMA","FedRAMP","NIST","DISA","STIGs",
  "REST","API","Microservices","Git","Maven","Hibernate","JUnit","Selenium","Agile","Scrum","Jira","ServiceNow","Salesforce","AEM",
];
const RESUME_CASE_SENSITIVE = new Set(["Go","Rust","React","Spark","Helm","DAX","RAG","Secret clearance"]);

function skillsFromResume(text) {
  if (!text) return [];
  const found = [];
  for (const kw of RESUME_SKILL_KEYWORDS) {
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![A-Za-z0-9])${esc}(?:e?s)?(?![A-Za-z0-9+#])`, RESUME_CASE_SENSITIVE.has(kw) ? "" : "i");
    if (re.test(text) && !found.includes(kw)) found.push(kw);
  }
  return found;
}

// ── Embedded flight JSON ──────────────────────────────────────────────────────

// Brace-match a JSON object starting at `start` (index of '{'), respecting strings.
function balancedObject(str, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return str.slice(start, i + 1); }
  }
  return null;
}

// Locate the initialProfileData object in a __next_f.push(...) script and parse it.
// Returns null if absent or if it belongs to a different (stale) candidate.
function getDiceJson() {
  const urlId = diceProfileId(location.href);
  for (const s of document.scripts) {
    const t = s.textContent || '';
    if (t.indexOf('initialProfileData') === -1 || t.indexOf('__next_f') === -1) continue;
    const m = t.match(/self\.__next_f\.push\((\[[\s\S]*\])\)/);
    if (!m) continue;
    let payload;
    try { payload = JSON.parse(m[1])[1]; } catch (_) { continue; }   // [1,"<rsc line>"] → unescaped string
    if (typeof payload !== 'string') continue;
    const ki = payload.indexOf('"initialProfileData":');
    if (ki === -1) continue;
    const obj = balancedObject(payload, payload.indexOf('{', ki));
    if (!obj) continue;
    let data;
    try { data = JSON.parse(obj); } catch (_) { continue; }
    // Reject a payload left over from a previously-viewed profile (SPA nav).
    if (urlId && data.id && data.id.toLowerCase() !== urlId) return null;
    return data;
  }
  return null;
}

function expDates(h) {
  const start = h.periodStart?.generated || '';
  const end = h.periodEnd?.generated || 'Present';
  return start ? `${start} - ${end}` : '';
}

// ── Merge DOM + JSON into the LinkedIn-compatible profile shape ────────────────

function extractProfile(resumeOverride) {
  const json = getDiceJson();
  const resume = (resumeOverride && resumeOverride.length) ? resumeOverride : resumeText();

  let name     = domText('h1[data-testid="candidate-name-page-heading"]');
  let title    = domText('[data-testid="currentJobTitleLatestCompany"]');
  let location = domText('[data-testid="locations"] .text-xl, [data-testid="locations"] .font-semibold');
  let experience  = domExperience();
  let education   = domEducation();
  let skills      = domSkills();
  let phone       = domPhone();
  let email       = realEmailFrom(resume);

  const yrsTxt = domText('[data-testid="years-of-experience"] .text-xl, [data-testid="years-of-experience"] .font-semibold');
  let experience_years = (yrsTxt.match(/\d+/) || [])[0];
  experience_years = experience_years != null ? parseInt(experience_years, 10) : null;
  let openToWork = false;

  // JSON enrich — only for the matching candidate (getDiceJson already guards this).
  if (json) {
    if (json.name) name = json.name;
    if (json.currentTitle) title = json.latestCompany ? `${json.currentTitle} at ${json.latestCompany}` : json.currentTitle;
    if (json.locations?.[0]?.text) location = json.locations[0].text;
    if (typeof json.yearsOfExperienceExtracted === 'number') experience_years = json.yearsOfExperienceExtracted;
    if (typeof json.likelyToMove === 'boolean') openToWork = json.likelyToMove;

    // Full skill list (DOM truncates to the first ~9).
    const jsonSkills = (json.skillScores || []).map(s => s && s.skill).filter(Boolean);
    if (jsonSkills.length > skills.length) skills = jsonSkills;

    if (Array.isArray(json.experience?.history) && json.experience.history.length) {
      experience = json.experience.history.map(h => ({
        title: h.title || '', company: h.company || '', dates: expDates(h),
      }));
    }
    if (Array.isArray(json.educations) && json.educations.length) {
      education = json.educations.map(e => ({
        school: [e.org, e.location].filter(Boolean).join(' - '), degree: e.degree || '', dates: '',
      }));
    }
    if (!phone) phone = (json.phoneSources || []).map(p => p && p.v).find(Boolean) || '';
    // Email comes from the résumé only — Dice's emailSources is a masked
    // @mail.dice.com relay, not the candidate's real address.
  }

  // Résumé skills win when a résumé is present — they're the real signal vs
  // Dice's generic single-word skills. Empty scan keeps the Dice list.
  const resumeSkills = skillsFromResume(resume);
  if (resumeSkills.length) skills = resumeSkills;

  return {
    source: 'dice',
    name, title, location, skills, experience_years,
    profileUrl: window.location.href.split('?')[0],
    experience, about: resume.slice(0, 4000), education, openToWork,
    email, phone,
    // Full résumé text from the in-page PDF, used to score against the JD when
    // the recruiter hasn't manually attached a file. Dice's own skill list is
    // generic single words (ide/software/configuration) — the résumé keywords
    // are a far stronger signal. Empty when the profile has no résumé.
    resumeText: resume.slice(0, 50000),
  };
}

// ── Extraction pipeline (mirrors linkedin.js dedupe/panel-open contract) ────────

let extractionPromise = null;
let extractedId = '';
let extractionSettled = false;

function requestPanelOpen() {
  chrome.runtime.sendMessage({ type: 'OPEN_PANEL' }, (res) => {
    void chrome.runtime.lastError;
    if (res?.ok) return;
    const onInteract = () => {
      window.removeEventListener('pointerdown', onInteract, true);
      window.removeEventListener('keydown', onInteract, true);
      chrome.runtime.sendMessage({ type: 'OPEN_PANEL' }, () => void chrome.runtime.lastError);
    };
    window.addEventListener('pointerdown', onInteract, true);
    window.addEventListener('keydown', onInteract, true);
  });
}

// Poll briefly for the name to render (data-testid is server-rendered, but a
// client-side nav to a new profile may read before the new DOM is painted).
async function waitForName(maxMs = 5000) {
  const start = Date.now();
  while (!extractProfile().name && Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 250));
  }
}

// The Resume section sits far down the profile and its react-pdf viewer only
// mounts once scrolled into view; each page then fills its text layer only as it
// becomes visible. So a plain read sees nothing (PDF unmounted) or page 1 only —
// missing the résumé's "Technical Skills" block on the last page. This:
//   1. scrolls the Resume section into view (mounts the PDF),
//   2. pages through its inner scroll container top→bottom,
// waiting until the extracted text stops growing, so the whole résumé is present
// before extractProfile() reads email + skills from it.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function loadResume(maxMs = 15000) {
  const sec = sectionByHeading('Resume');
  if (!sec) { console.warn('[SCOUT] Dice: no Resume section found'); return; }
  sec.scrollIntoView({ block: 'start' });
  await sleep(500);

  const start = Date.now();
  let last = -1, stable = 0;
  while (Date.now() - start < maxMs) {
    // Bring the section into the main viewport (mounts react-pdf), then page the
    // inner PDF container top→bottom so every page renders its text layer.
    sec.scrollIntoView({ block: 'start' });
    const scroller = sec.querySelector('.overflow-auto');
    if (scroller) scroller.scrollTop = Math.min(scroller.scrollTop + 600, scroller.scrollHeight);

    await sleep(350);

    const pages = sec.querySelectorAll('.react-pdf__Page').length;
    const rendered = Array.from(sec.querySelectorAll('.react-pdf__Page__textContent'))
      .filter(el => (el.textContent || '').trim().length > 0).length;
    const len = (resumeText() || '').length;

    // Ready when every page that mounted has a non-empty text layer (and at least
    // one page exists), or when the extracted length stops growing.
    if (pages > 0 && rendered >= pages && len > 0) break;
    stable = len === last ? stable + 1 : 0;
    last = len;
    if (len > 0 && stable >= 5) break;
  }
  const scroller = sec.querySelector('.overflow-auto');
  if (scroller) scroller.scrollTop = 0;
  console.log(`[SCOUT] Dice résumé loaded: ${(resumeText() || '').length} chars, ` +
    `${sec.querySelectorAll('.react-pdf__Page').length} pages, ${Date.now() - start}ms`);
}

function runExtraction(force = false) {
  const id = diceProfileId(window.location.href);
  if (extractionPromise && extractedId === id) {
    if (!force || !extractionSettled) return extractionPromise;
  }
  extractedId = id;
  extractionSettled = false;
  extractionPromise = (async () => {
    await waitForName();    // header rendered
    await loadResume();     // nudge the on-page résumé render
    const resume = await bestResumeText();   // PDF fetch preferred, DOM fallback
    const profile = extractProfile(resume);
    console.log('[SCOUT] Dice parsed:', profile);
    chrome.storage.session.set({ scout_candidate: profile });
    requestPanelOpen();
    // The PDF can finish rendering AFTER this first read (slow network / late
    // mount). Keep watching; when more résumé text appears, recompute email +
    // skills, restore, and push the update so the panel re-scores. This makes
    // the résumé-driven score robust regardless of when react-pdf finishes.
    watchResume(profile, id);
    return profile;
  })().finally(() => { extractionSettled = true; });
  return extractionPromise;
}

// Poll the résumé text for ~25s after the first read. On each growth, refresh the
// résumé-derived fields and broadcast the updated profile to the side panel.
async function watchResume(profile, id) {
  let best = (profile.resumeText || '').length;
  const start = Date.now();
  while (Date.now() - start < 25000) {
    await sleep(1500);
    if (diceProfileId(window.location.href) !== id) return; // navigated away
    const sec = sectionByHeading('Resume');
    if (sec) {
      sec.scrollIntoView({ block: 'start' });
      const scroller = sec.querySelector('.overflow-auto');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }
    const text = resumeText();
    if (text.length > best + 50) {
      best = text.length;
      profile.resumeText = text.slice(0, 50000);
      profile.about = text.slice(0, 4000);
      const email = realEmailFrom(text);
      if (email) profile.email = email;
      const skills = skillsFromResume(text);
      if (skills.length) profile.skills = skills;
      chrome.storage.session.set({ scout_candidate: profile });
      chrome.runtime.sendMessage({ type: 'DICE_PROFILE_UPDATED', profile }, () => void chrome.runtime.lastError);
      console.log(`[SCOUT] Dice résumé updated: ${text.length} chars, ${skills.length} skills`);
    }
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getProfile') {
    runExtraction(!!request.force).then(profile => sendResponse({ profile }));
  }
  return true;
});
