const profileCard    = document.getElementById('profile-card');
const profileName    = document.getElementById('profile-name');
const profileTitle   = document.getElementById('profile-title');
const profileLoc     = document.getElementById('profile-location');
const profileExp     = document.getElementById('profile-exp');
const profileEmail   = document.getElementById('profile-email');
const profileEmailFound = document.getElementById('profile-email-found');
const profilePhone   = document.getElementById('profile-phone');
const profilePhoneFound = document.getElementById('profile-phone-found');
const sourceBadge    = document.getElementById('source-badge');
const jdSelect       = document.getElementById('jd-select');
const jdSpinner      = document.getElementById('jd-spinner');
const scoreCard      = document.getElementById('score-card');
const scoreHeading   = document.getElementById('score-heading');
const scoreCircle    = document.getElementById('score-circle');
const scoreNumber    = document.getElementById('score-number');
const scoreLabel     = document.getElementById('score-label');
const scoreRationale = document.getElementById('score-rationale');
const scoreBreakdown = document.getElementById('score-breakdown');
const skillLists     = document.getElementById('skill-lists');
const autoGate       = document.getElementById('auto-gate');
const addBtn         = document.getElementById('add-btn');
const jazzhrBtn      = document.getElementById('jazzhr-btn');
const statusEl       = document.getElementById('status');
const mockDuplicate  = document.getElementById('mock-duplicate');
const resumeUpload   = document.getElementById('resume-upload');
const resumeFile     = document.getElementById('resume-file');
const resumeName     = document.getElementById('resume-name');
const resumeClear    = document.getElementById('resume-clear');
const scanJdsBtn     = document.getElementById('scan-jds-btn');
const bestfit        = document.getElementById('bestfit');
const bestfitStatus  = document.getElementById('bestfit-status');
const bestfitList    = document.getElementById('bestfit-list');
const mainView       = document.getElementById('main-view');
const emptyView      = document.getElementById('empty-view');
const matchSection   = document.getElementById('match-section');
const closeBtn       = document.getElementById('close-btn');
const refreshBtn     = document.getElementById('refresh-btn');
const vapiSection    = document.getElementById('vapi-section');
const vapiPhoneRow   = document.getElementById('vapi-phone-row');
const vapiPhoneInput = document.getElementById('vapi-phone-input');
const vapiBtn        = document.getElementById('vapi-btn');
const vapiStatusEl   = document.getElementById('vapi-status');
const vapiResultEl   = document.getElementById('vapi-result');
const vapiScheduleCheck = document.getElementById('vapi-schedule-check');
const vapiScheduleRow   = document.getElementById('vapi-schedule-row');
const vapiDtInput       = document.getElementById('vapi-dt-input');
const vapiTzSelect      = document.getElementById('vapi-tz-select');
const vapiScheduleBtn   = document.getElementById('vapi-schedule-btn');
const autosourceBtn  = document.getElementById('autosource-btn');
const autoPager      = document.getElementById('auto-pager');
const autoPrev       = document.getElementById('auto-prev');
const autoNext       = document.getElementById('auto-next');
const autoLabel      = document.getElementById('auto-label');

// Close the side panel. window.close() works in the side panel on recent Chrome;
// the SW fallback (disable → re-enable) covers versions where it's a no-op.
// Per-tab setOptions({enabled:false}) is wrong here: it doesn't close a panel
// opened window-wide via the action click, and it leaves the tab unable to reopen.
closeBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLOSE_PANEL' }, () => void chrome.runtime.lastError);
  window.close();
});

// Re-scan: reset state and run the whole pipeline again (profile → JDs → score)
refreshBtn.addEventListener('click', async () => {
  // Leave auto-source mode so the single-profile flow resumes.
  autoResults = [];
  autoPager.style.display = 'none';

  const tab = await getTargetTab();
  const site = siteFor(tab?.url);
  if (!site) return;

  loadJds(selectedJd, true);          // re-fetch JD list + clear SW description cache, keep selection
  startScan(tab.id, site.script, true); // force = bypass content-script extraction cache
});

// Email found on LinkedIn / résumé — used unless the recruiter types a manual
// override into the editable field.
let foundEmail = '';

// Manual email edits flow straight into the candidate. Empty field falls back to
// the found address.
profileEmail.addEventListener('input', () => {
  if (candidate) candidate.email = profileEmail.value.trim() || foundEmail;
});

// Phone found on LinkedIn / résumé — used unless the recruiter types a manual
// override into the editable field.
let foundPhone = '';

// Manual phone edits flow straight into the candidate so Add-to-SCOUT and the
// AI call both use the recruiter-entered number. Empty field falls back to the
// found number.
profilePhone.addEventListener('input', () => {
  if (candidate) candidate.phone = profilePhone.value.trim() || foundPhone;
});

let candidate       = null;   // set when profile fetch completes
let selectedJd      = null;
let selectedJdTitle = null;
let currentScore    = null;
let profilePending  = false;  // true while profile fetch is in flight
let scoreVersion    = 0;      // incremented on each new score request to discard stale AI responses
let modelReady      = false;  // true once offscreen ML model finishes loading
let resumeB64       = '';     // base64-encoded resume file if recruiter attached one
let resumeFileName  = '';     // original filename — JazzHR needs it to attach the resume
let resumeMime      = '';     // file MIME type, sent alongside the base64
let resumeText      = '';     // plain text parsed from the attached resume (for skill re-scoring)
let addedApplicantId = null;  // JazzHR prospect_id set after successful add
let callPollTimer    = null;  // setInterval id for call-status polling

// ── Auto-source (top-5 LinkedIn search) state ──────────────────────────────────
let autoSourcing = false;     // true while the search/scrape/score loop is running
let autoResults  = [];        // [{ candidate, score }] for the top results
let autoIndex    = 0;         // currently shown candidate in the pager

// ── Resume file picker ────────────────────────────────────────────────────────
// PDF.js needs its worker pointed at the bundled local file (CSP forbids remote).
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
}

resumeFile.addEventListener('change', async () => {
  const file = resumeFile.files[0];
  if (!file) return;
  resumeName.textContent = file.name;
  resumeClear.style.display = 'inline';

  // 1. Base64 + metadata for the backend → JazzHR resume attachment.
  resumeB64      = await fileToB64(file);
  resumeFileName = file.name || 'resume';
  resumeMime     = file.type || '';

  // 2. Parse résumé text once — reused for contact fill + skill re-scoring.
  showStatus('Reading résumé…', 'loading');
  try {
    resumeText = await extractResumeText(file);
  } catch (e) {
    console.warn('[SCOUT] résumé parse failed:', e);
    showStatus('Could not read résumé: ' + e.message, 'error');
    setTimeout(() => statusEl.classList.remove('show'), 3000);
    return;
  }

  // Fill only the email/phone LinkedIn left blank.
  fillContactFromResume(resumeText);

  // Re-score with résumé skills folded in (SW unions résumé keywords into
  // candidate skills). Overrides the contact status with the scoring status.
  if (selectedJd && candidate) {
    requestScore(selectedJd);
  }
});

resumeClear.addEventListener('click', () => {
  resumeB64 = '';
  resumeFileName = '';
  resumeMime = '';
  resumeText = '';
  resumeFile.value = '';
  resumeName.textContent = 'No file chosen';
  resumeClear.style.display = 'none';
  // Re-score without the résumé contribution.
  if (selectedJd && candidate) requestScore(selectedJd);
});

function fileToB64(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload  = (e) => resolve((e.target.result.split(',')[1]) || '');
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

// Fill candidate.email / candidate.phone from already-parsed résumé text, but
// only the field(s) LinkedIn left blank. Never overrides a profile-scraped value.
function fillContactFromResume(text) {
  if (!candidate) return;
  const needEmail = !candidate.email;
  const needPhone = !candidate.phone;
  if (!needEmail && !needPhone) return;            // both present — nothing to fill

  const got = extractContact(text, { email: needEmail, phone: needPhone });
  if (needEmail && got.email) candidate.email = got.email;
  if (needPhone && got.phone) candidate.phone = got.phone;

  renderProfile(candidate);
  // Phone may now exist → refresh the "Call with AI" button availability.
  if (vapiSection && vapiSection.style.display === 'block') showVapiSection(addedApplicantId);
}

// Extract plain text from a résumé file by type. PDF → PDF.js, DOCX → fflate
// unzip + tag strip, everything else (txt/doc/rtf/odt) → best-effort raw text.
async function extractResumeText(file) {
  const name = (file.name || '').toLowerCase();
  const ext  = name.slice(name.lastIndexOf('.') + 1);

  if (ext === 'pdf'  || file.type === 'application/pdf')  return extractPdfText(file);
  if (ext === 'docx') return extractDocxText(file);
  return file.text();   // txt + graceful fallback for doc/rtf/odt
}

async function extractPdfText(file) {
  if (!window.pdfjsLib) throw new Error('PDF library not loaded');
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let out = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    out += content.items.map(it => it.str).join(' ') + '\n';
  }
  return out;
}

async function extractDocxText(file) {
  if (!window.fflate) throw new Error('DOCX library not loaded');
  const buf   = new Uint8Array(await file.arrayBuffer());
  const files = fflate.unzipSync(buf);
  const xml   = files['word/document.xml'];
  if (!xml) return '';
  return fflate.strFromU8(xml).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

// Pull the first plausible email + phone out of résumé text.
const RESUME_EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
function extractContact(text, want = { email: true, phone: true }) {
  const t = text || '';
  let email = '';
  let phone = '';

  // Email: first non-LinkedIn address.
  if (want.email) {
    const emails = t.match(new RegExp(RESUME_EMAIL_RE.source, 'g')) || [];
    email = emails.find(e => !/linkedin\.com$/i.test((e.split('@')[1] || ''))) || '';
  }

  // Phone: prefer a number sitting next to a phone label; else first 7–15 digit run.
  if (want.phone) {
    const labeled = t.match(/(?:phone|mobile|tel|cell|contact)[^\d+]{0,15}(\+?\d[\d\s().\-]{6,}\d)/i);
    if (labeled) {
      phone = labeled[1].trim();
    } else {
      for (const c of (t.match(/\+?\d[\d\s().\-]{6,}\d/g) || [])) {
        const digits = (c.match(/\d/g) || []).length;
        if (digits >= 7 && digits <= 15) { phone = c.trim(); break; }
      }
    }
  }
  return { email, phone };
}

// Listen for MODEL_READY from the service worker (relayed from offscreen doc).
// If a score is in progress, update the status message to stop saying "loading model".
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "MODEL_READY") {
    modelReady = true;
    // If we're currently waiting on a score, update the status to the normal message
    if (statusEl.classList.contains('show') && statusEl.textContent.includes('model')) {
      showStatus('Matching profile to JD…', 'loading');
    }
  }

  // Dice résumé finished rendering after the first scan → adopt the updated
  // candidate (real email + résumé skills + résumé text) and re-score.
  if (message?.type === "DICE_PROFILE_UPDATED" && message.profile) {
    candidate = message.profile;
    foundPhone = candidate.phone || foundPhone;
    renderProfile(candidate);
    if (selectedJd) requestScore(selectedJd);
  }
});

// ── Init + tab watching ───────────────────────────────────────────────────────

let lastProfileSlug = '';   // dedupes rescans across tab events

// Floating-window mode: the SW opens popup.html in a popup-type window with
// ?tabId=<source tab> when sidePanel.open() lacks a gesture. In that window
// "active tab in current window" would be this extension page itself, so all
// tab lookups pin to the tabId from the URL instead.
const pinnedTabId = Number(new URLSearchParams(location.search).get('tabId')) || null;

async function getTargetTab() {
  if (pinnedTabId) {
    try { return await chrome.tabs.get(pinnedTabId); } catch (_) { /* tab closed */ }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Supported candidate sources. Returns {source, script, slug} for a profile URL,
// or null when the tab isn't on a recognized profile. `slug` is the canonical
// per-profile identity used to dedupe rescans (full-URL comparison loops because
// the LinkedIn extraction visits /details/skills and /overlay/contact-info
// sub-routes, which fire tabs.onUpdated and must not count as a new profile).
function siteFor(url) {
  const li = (url || '').match(/linkedin\.com\/in\/([^\/?#]+)/i);
  if (li) return { source: 'LinkedIn', script: 'content_scripts/linkedin.js', slug: li[1].toLowerCase() };
  const dc = (url || '').match(/dice\.com\/employers\/talent-search\/profile\/([0-9a-f-]+)/i);
  if (dc) return { source: 'Dice', script: 'content_scripts/dice.js', slug: dc[1].toLowerCase() };
  return null;
}

function startScan(tabId, scriptFile, force = false) {
  candidate      = null;
  currentScore   = null;
  profilePending = true;
  scoreVersion++;

  profileCard.classList.remove('show');
  scoreCard.classList.remove('show');
  jazzhrBtn.style.display = 'none';
  resetAddButton();
  addBtn.disabled = true;

  refreshBtn.classList.add('spinning');
  showStatus('Reading profile…', 'loading');

  requestProfile(tabId, scriptFile, force);
}

// Sync panel to the active tab. The JD picker + auto-source button are always
// available (auto-source works from any page). When the tab IS a candidate
// profile, also auto-scan it for the single-candidate flow. Suppressed while the
// auto-source loop is driving the tab through profiles.
async function handleActiveTab() {
  if (autoSourcing) return;          // our own navigation — don't react to it
  if (autoResults.length) return;    // showing top-5 results — keep them on screen

  const tab = await getTargetTab();
  mainView.style.display  = '';
  emptyView.style.display = 'none';
  matchSection.style.display = 'block';

  const site = tab && siteFor(tab.url);
  sourceBadge.textContent = site ? site.source : '—';
  if (!site) return;

  if (site.slug !== lastProfileSlug) {
    lastProfileSlug = site.slug;
    startScan(tab.id, site.script);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  loadJds();
  handleActiveTab();
});

// New profile in the same tab (LinkedIn is a SPA — watch url, not just status)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.active) return;
  if (changeInfo.url || changeInfo.status === 'complete') handleActiveTab();
});

// Switched to a different tab
chrome.tabs.onActivated.addListener(() => handleActiveTab());

// ── Profile loading (with auto-inject fallback) ───────────────────────────────

function requestProfile(tabId, scriptFile, force = false) {
  chrome.tabs.sendMessage(tabId, { action: 'getProfile', force }, (response) => {
    if (chrome.runtime.lastError || !response?.profile) {
      chrome.scripting.executeScript(
        { target: { tabId }, files: [scriptFile] },
        () => {
          if (chrome.runtime.lastError) {
            onProfileFailed('Could not inject script. Try refreshing the page.');
            return;
          }
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { action: 'getProfile', force }, (res2) => {
              if (chrome.runtime.lastError || !res2?.profile) {
                onProfileFailed('Could not read profile. Try refreshing the page.');
                return;
              }
              onProfileLoaded(res2.profile);
            });
          }, 300);
        }
      );
      return;
    }
    onProfileLoaded(response.profile);
  });
}

function onProfileLoaded(profile) {
  candidate     = profile;
  profilePending = false;
  refreshBtn.classList.remove('spinning');
  renderProfile(profile);
  // If user already picked a JD while profile was loading → score now
  if (selectedJd) {
    showStatus('Matching profile to selected JD…', 'loading');
    requestScore(selectedJd);
  }
}

function onProfileFailed(msg) {
  profilePending = false;
  refreshBtn.classList.remove('spinning');
  // Only show error if user has already selected a JD (otherwise silent)
  if (selectedJd) {
    showStatus(msg, 'error');
    addBtn.disabled = true;
  }
}

// ── Profile card ──────────────────────────────────────────────────────────────

function renderProfile(p) {
  profileName.textContent  = p.name     || '—';
  profileTitle.textContent = p.title    || '';
  profileLoc.textContent   = p.location || '';
  profileExp.textContent   = p.experience_years != null ? `${p.experience_years} yrs exp` : '';

  // Email found on LinkedIn/résumé shows read-only above; the editable field
  // stays empty for a manual add/override. candidate.email defaults to the
  // found address until the recruiter types one in.
  foundEmail = p.email || '';
  if (foundEmail) {
    profileEmailFound.textContent = foundEmail;
    profileEmailFound.href = `mailto:${foundEmail}`;
    profileEmailFound.style.display = 'block';
  } else {
    profileEmailFound.style.display = 'none';
  }
  profileEmail.value = '';
  // Phone found on LinkedIn/résumé shows read-only above; the editable field
  // stays empty for a manual add/override. candidate.phone defaults to the
  // found number until the recruiter types one in.
  foundPhone = p.phone || '';
  if (foundPhone) {
    profilePhoneFound.textContent = foundPhone;
    profilePhoneFound.href = `tel:${foundPhone.replace(/[^\d+]/g, '')}`;
    profilePhoneFound.style.display = 'block';
  } else {
    profilePhoneFound.style.display = 'none';
  }
  profilePhone.value = '';

  profileCard.classList.add('show');
  // Clear any "matching" status that was shown while waiting
  if (!selectedJd) statusEl.classList.remove('show');
}

// ── JD dropdown ───────────────────────────────────────────────────────────────

function loadJds(preserveId, fresh) {
  jdSpinner.classList.add('show');
  jdSelect.disabled = true;

  chrome.runtime.sendMessage({ type: 'GET_JDS', fresh: !!fresh }, (res) => {
    jdSpinner.classList.remove('show');
    if (!res?.ok) {
      jdSelect.innerHTML = '<option value="">Failed to load jobs</option>';
      return;
    }
    jdSelect.innerHTML = '<option value="">— Choose a JD —</option>';
    res.data.forEach(jd => {
      const opt = document.createElement('option');
      opt.value = jd.id;
      opt.dataset.title = jd.title;
      opt.textContent = jd.client ? `${jd.title}  ·  ${jd.client}` : jd.title;
      jdSelect.appendChild(opt);
    });
    jdSelect.disabled = false;
    if (preserveId) {
      jdSelect.value = preserveId;
      if (jdSelect.value !== preserveId) {
        // JD no longer exists on the backend — clear stale selection
        selectedJd = null;
        selectedJdTitle = null;
      }
    }
  });
}

jdSelect.addEventListener('change', () => {
  const jdId = jdSelect.value;
  if (!jdId) {
    scoreCard.classList.remove('show');
    addBtn.disabled = true;
    currentScore = null;
    scoreVersion++;
    statusEl.classList.remove('show');
    return;
  }

  selectedJd      = jdId;
  selectedJdTitle = jdSelect.selectedOptions[0]?.dataset.title || jdId;
  scoreCard.classList.remove('show');
  addBtn.disabled = true;

  if (candidate) {
    // Profile already loaded — score immediately
    requestScore(jdId);
  } else if (profilePending) {
    // Profile still loading — show holding message, score fires in onProfileLoaded
    showStatus('Reading profile… will score when ready.', 'loading');
  } else {
    // Not on a candidate profile — run the full pipeline: search the JD title,
    // open People, then scrape + score the top 5.
    runAutoSource();
  }
});

// ── Score ─────────────────────────────────────────────────────────────────────

function requestScore(jdId) {
  scoreVersion++;
  const version = scoreVersion;

  addBtn.disabled = true;
  scoreCard.classList.remove('show');
  // Wipe the previous JD's breakdown so nothing stale shows during the re-score.
  if (scoreBreakdown) scoreBreakdown.innerHTML = '';
  if (skillLists)     skillLists.innerHTML = '';
  if (autoGate)       autoGate.style.display = 'none';
  showStatus(modelReady ? 'Matching profile to JD…' : 'Loading AI model (first time only)…', 'loading');

  // Prefer a manually-attached résumé; otherwise fall back to the résumé text
  // scraped from the profile (Dice profiles embed the candidate's résumé).
  const effectiveResume = resumeText || candidate?.resumeText || '';

  chrome.runtime.sendMessage(
    { type: 'GET_SCORE', payload: { jd_id: jdId, candidate, resume_text: effectiveResume || undefined } },
    (res) => {
      if (version !== scoreVersion) return; // stale — user changed JD
      statusEl.classList.remove('show');
      if (!res?.ok) { showStatus('Score failed — ' + (res?.error || 'unknown error'), 'error'); return; }
      currentScore = res.data;
      renderScore(currentScore, !!effectiveResume);
    }
  );
}

function renderScore(data, updated = false) {
  const { score, label, rationale } = data;
  // "Updated Score" heading appears once a résumé has folded skills into the score.
  if (scoreHeading) scoreHeading.style.display = updated ? 'block' : 'none';
  scoreNumber.textContent    = score;
  scoreLabel.textContent     = label;
  scoreRationale.textContent = rationale;

  scoreCircle.className = 'score-circle';
  const tone = score >= 80 ? 'excellent' : score >= 65 ? 'good' : score >= 45 ? 'fair' : 'poor';
  scoreCircle.classList.add(tone);

  renderAutoGate(data);
  renderBreakdown(data.categories);
  renderSkillLists(data.categories);

  scoreCard.classList.add('show');
  resumeUpload.style.display = 'block';
  addBtn.disabled = false;
  resetAddButton();
}

// Doc §4 — auto-scheduling gate. Shows whether the candidate clears all four
// critical gates (required skills, certs, clearance, locality) at score ≥ 80.
function renderAutoGate(data) {
  if (!autoGate) return;
  const gates = data.gates;
  if (!gates) { autoGate.style.display = 'none'; return; }

  const labels = {
    required_skills: 'Required Skills',
    certifications:  'Certifications',
    clearance:       'Clearance',
    locality:        'Commute / Locality',
  };
  const failed = Object.keys(labels).filter(k => !gates[k]);

  autoGate.className = 'auto-gate ' + (data.auto_schedule ? 'pass' : 'hold');
  if (data.auto_schedule) {
    autoGate.innerHTML = `<span class="auto-gate-icon">✓</span>` +
      `<span>Auto-schedule eligible — score ≥ 80 and all critical gates passed.</span>`;
  } else {
    const reason = data.score < 80
      ? `score below 80`
      : `unmet: ${failed.map(k => labels[k]).join(', ')}`;
    autoGate.innerHTML = `<span class="auto-gate-icon">•</span>` +
      `<span>Standard pipeline — no auto-scheduling (${escapeHtml(reason)}).</span>`;
  }
  autoGate.style.display = 'flex';
}

// Doc §3.4 — per-category breakdown: weight, sub-score, and a fill bar. Only the
// categories the JD actually specifies are shown (others renormalized out).
function renderBreakdown(categories) {
  if (!scoreBreakdown) return;
  if (!categories || !categories.length) { scoreBreakdown.innerHTML = ''; return; }

  const rows = categories.filter(c => c.active).map(c => {
    const pct  = Math.round((c.fill || 0) * 100);
    const tone = pct >= 100 ? 'excellent' : pct >= 60 ? 'good' : pct >= 30 ? 'fair' : 'poor';
    let detail = '';
    if (c.key === 'clearance' || c.key === 'education') {
      detail = `<span class="cat-detail">${escapeHtml(c.detected)} vs ${escapeHtml(c.required)}</span>`;
    } else if (c.key === 'location') {
      detail = `<span class="cat-detail">${escapeHtml(c.detected)} vs ${escapeHtml(c.required)}</span>`;
    } else {
      const m = (c.matched || []).length, t = m + (c.missing || []).length;
      detail = `<span class="cat-detail">${m}/${t}</span>`;
    }
    return `
      <div class="cat-row">
        <div class="cat-head">
          <span class="cat-name">${escapeHtml(c.name)} <span class="cat-weight">${c.weight}%</span></span>
          <span class="cat-score ${tone}">${pct}%</span>
        </div>
        <div class="cat-bar"><div class="cat-bar-fill ${tone}" style="width:${pct}%"></div></div>
        <div class="cat-foot">${detail}</div>
      </div>`;
  }).join('');

  scoreBreakdown.innerHTML = `<div class="breakdown-title">Category Breakdown</div>${rows}`;
}

// Doc §3.4 — matched vs missing required skills as chips.
function renderSkillLists(categories) {
  if (!skillLists) return;
  const req = (categories || []).find(c => c.key === 'required');
  if (!req) { skillLists.innerHTML = ''; return; }

  const chip = (s, cls) => `<span class="skill-chip ${cls}">${escapeHtml(s)}</span>`;
  const matched = (req.matched || []).map(s => chip(s, 'matched')).join('');
  const missing = (req.missing || []).map(s => chip(s, 'missing')).join('');

  let html = '';
  if (matched) html += `<div class="skill-group"><span class="skill-group-label">Matched</span><div class="skill-chips">${matched}</div></div>`;
  if (missing) html += `<div class="skill-group"><span class="skill-group-label">Missing</span><div class="skill-chips">${missing}</div></div>`;
  skillLists.innerHTML = html;
}

// ── Cross-JD fit check ────────────────────────────────────────────────────────
// Scores the candidate against every JD in the background (service worker),
// then surfaces the best-fit JD (and the rest, high→low).
scanJdsBtn.addEventListener('click', () => {
  if (!candidate) { showStatus('Profile not loaded yet — wait and try again.', 'error'); return; }

  scanJdsBtn.disabled = true;
  bestfit.style.display = 'block';
  bestfitList.innerHTML = '';
  bestfitStatus.textContent = 'Scoring against all JDs…';

  const effectiveResume = resumeText || candidate?.resumeText || '';
  chrome.runtime.sendMessage(
    { type: 'SCORE_ALL', payload: { candidate, resume_text: effectiveResume || undefined } },
    (res) => {
      scanJdsBtn.disabled = false;
      if (!res?.ok) { bestfitStatus.textContent = 'Failed — ' + (res?.error || 'unknown error'); return; }
      renderBestFit(res.data);
    }
  );
});

function renderBestFit(list) {
  if (!list || !list.length) { bestfitStatus.textContent = 'No JDs scored.'; return; }
  const best = list[0];
  bestfitStatus.innerHTML = `Best fit: <strong>${best.title}</strong> — ${best.score}/100 (${best.label})`;

  bestfitList.innerHTML = '';
  list.slice(0, 3).forEach((jd, i) => {
    const cls = jd.score >= 80 ? 'excellent' : jd.score >= 65 ? 'good' : jd.score >= 45 ? 'fair' : 'poor';
    const row = document.createElement('div');
    row.className = 'bestfit-row' + (i === 0 ? ' top' : '');
    row.innerHTML =
      `<span class="bestfit-score ${cls}">${jd.score}</span>` +
      `<span class="bestfit-title">${jd.title}${jd.client ? ' · ' + jd.client : ''}</span>`;
    // Click a row → select that JD in the dropdown and score it normally.
    row.addEventListener('click', () => {
      jdSelect.value = jd.id;
      jdSelect.dispatchEvent(new Event('change'));
    });
    bestfitList.appendChild(row);
  });
}

// ── Add to SCOUT → backend API ────────────────────────────────────────────────

addBtn.addEventListener('click', () => {
  if (mockDuplicate.checked) { renderDuplicateState(); return; }

  if (!candidate) {
    showStatus('Profile not loaded yet — wait and try again.', 'error');
    return;
  }
  if (!selectedJd) {
    showStatus('Please select a Job Description first.', 'error');
    return;
  }

  // Manual upload wins; otherwise attach the résumé scraped from the profile
  // (Dice candidates carry the résumé PDF bytes on the candidate) so JazzHR gets
  // the résumé without a separate upload.
  const rB64  = resumeB64 || candidate.resumeB64 || '';
  const rName = resumeB64 ? resumeFileName : (candidate.resumeName || 'resume.pdf');
  const rMime = resumeB64 ? resumeMime : (candidate.resumeMime || 'application/pdf');

  const payload = {
    job_id:      selectedJd,
    job_title:   selectedJdTitle || '',
    resume_b64:  rB64 || undefined,
    resume_name: rB64 ? rName : undefined,
    resume_mime: rB64 ? rMime : undefined,
    candidate: {
      name:             candidate.name,
      title:            candidate.title,
      location:         candidate.location,
      skills:           candidate.skills,
      experience_years: candidate.experience_years,
      profileUrl:       candidate.profileUrl,
      email:            (candidate.email || '').trim(),
      phone:            normalizePhone(candidate.phone),
      experience:       candidate.experience || [],
      about:            candidate.about      || '',
      education:        candidate.education  || [],
      certifications:   candidate.certifications || [],
      endorsements:     candidate.endorsements   || {},
      openToWork:       candidate.openToWork || false,
      source:           candidate.source,
      score:            currentScore?.score,
      score_label:      currentScore?.label,
      rationale:        currentScore?.rationale,
    }
  };

  addBtn.disabled = true;
  jazzhrBtn.style.display = 'none';
  showStatus('Adding to SCOUT…', 'loading');

  chrome.runtime.sendMessage({ type: 'ADD_CANDIDATE', payload }, (res) => {
    statusEl.classList.remove('show');
    if (res?.ok) {
      addBtn.textContent = 'Added to SCOUT ✓';
      addBtn.className   = 'btn btn-success';
      resumeUpload.style.display = 'none';
      if (res.jazzhr_url) {
        jazzhrBtn.href          = res.jazzhr_url;
        jazzhrBtn.style.display = 'flex';
      }
      // Show Vapi call button — enabled only if candidate has a phone number
      addedApplicantId = res.applicant_id || null;
      showVapiSection(addedApplicantId);
    } else {
      showStatus(res?.error || 'Failed to add.', 'error');
      addBtn.disabled = false;
    }
  });
});

// ── Mock ──────────────────────────────────────────────────────────────────────

mockDuplicate.addEventListener('change', () => {
  if (mockDuplicate.checked && selectedJd) renderDuplicateState();
  else resetAddButton();
});

function renderDuplicateState() {
  addBtn.textContent = 'Already in SCOUT — view record →';
  addBtn.className   = 'btn btn-duplicate';
  addBtn.disabled    = false;
}

function resetAddButton() {
  addBtn.textContent = 'Add to SCOUT';
  addBtn.className   = 'btn btn-primary';
  addBtn.disabled    = !selectedJd;
}

// ── Vapi AI phone screen ──────────────────────────────────────────────────────

function showVapiSection(applicantId) {
  if (!vapiSection) return;
  vapiSection.style.display = 'block';

  vapiBtn.disabled    = false;
  vapiBtn.textContent = '📞 Call with AI';

  const phone = candidate?.phone || '';
  vapiPhoneRow.style.display = phone ? 'none' : 'block';
  if (!phone) vapiPhoneInput.value = '';
}

vapiBtn.addEventListener('click', async () => {
  if (!candidate || !selectedJd) return;

  const phone = normalizePhone(candidate.phone || vapiPhoneInput?.value || '');
  if (!phone) {
    vapiPhoneRow.style.display = 'block';
    vapiPhoneInput.focus();
    vapiStatusEl.textContent   = 'Enter a phone number to call.';
    vapiStatusEl.style.display = 'block';
    return;
  }

  vapiBtn.disabled    = true;
  vapiBtn.classList.add('calling');
  vapiBtn.textContent = '📞 Calling…';
  vapiStatusEl.textContent   = 'Initiating AI phone screen…';
  vapiStatusEl.style.display = 'block';
  vapiResultEl.style.display = 'none';

  chrome.runtime.sendMessage({
    type: 'INITIATE_CALL',
    payload: {
      applicant_id:   addedApplicantId,
      job_id:         selectedJd,
      phone:          phone,
      candidate_name: candidate.name || '',
      job_title:      selectedJdTitle || '',
    },
  }, (res) => {
    if (!res?.ok) {
      vapiBtn.classList.remove('calling');
      vapiBtn.disabled    = false;
      vapiBtn.textContent = '📞 Call with AI';
      vapiStatusEl.textContent = '✕ ' + (res?.error || 'Call failed to start');
      return;
    }
    vapiStatusEl.textContent = '📱 Call placed — waiting for candidate to answer…';
    startCallPoll(addedApplicantId);
  });
});

// ── Schedule for later ────────────────────────────────────────────────────────
if (vapiScheduleCheck) {
  vapiScheduleCheck.addEventListener('change', () => {
    vapiScheduleRow.style.display = vapiScheduleCheck.checked ? 'flex' : 'none';
    if (vapiScheduleCheck.checked && !vapiDtInput.value) {
      // Default to one hour from now, rounded to the next quarter hour
      const d = new Date(Date.now() + 60 * 60 * 1000);
      d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
      const pad = n => String(n).padStart(2, '0');
      vapiDtInput.value =
        `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  });
}

if (vapiScheduleBtn) {
  vapiScheduleBtn.addEventListener('click', async () => {
    if (!candidate || !selectedJd) return;

    const phone = normalizePhone(candidate.phone || vapiPhoneInput?.value || '');
    if (!phone) {
      vapiPhoneRow.style.display = 'block';
      vapiPhoneInput.focus();
      vapiStatusEl.textContent   = 'Enter a phone number to schedule a call.';
      vapiStatusEl.style.display = 'block';
      return;
    }
    if (!vapiDtInput.value) {
      vapiStatusEl.textContent   = 'Pick a date and time first.';
      vapiStatusEl.style.display = 'block';
      return;
    }

    // The datetime-local value is wall-clock time in the chosen timezone.
    // Convert it to an absolute UTC instant for that timezone.
    const tz = vapiTzSelect.value;
    const scheduledUtc = wallClockToUtc(vapiDtInput.value, tz);
    if (scheduledUtc <= new Date()) {
      vapiStatusEl.textContent   = 'Pick a time in the future.';
      vapiStatusEl.style.display = 'block';
      return;
    }

    vapiScheduleBtn.disabled  = true;
    vapiScheduleBtn.textContent = '🗓 Scheduling…';
    vapiStatusEl.textContent   = 'Scheduling AI phone screen…';
    vapiStatusEl.style.display = 'block';
    vapiResultEl.style.display = 'none';

    chrome.runtime.sendMessage({
      type: 'SCHEDULE_CALL',
      payload: {
        applicant_id:   addedApplicantId,
        job_id:         selectedJd,
        phone:          phone,
        candidate_name: candidate.name || '',
        job_title:      selectedJdTitle || '',
        scheduled_at:   scheduledUtc.toISOString(),
        timezone:       tz,
      },
    }, (res) => {
      vapiScheduleBtn.disabled  = false;
      vapiScheduleBtn.textContent = '🗓 Schedule call';
      if (!res?.ok) {
        vapiStatusEl.textContent = '✕ ' + (res?.error || 'Could not schedule call');
        return;
      }
      const when = scheduledUtc.toLocaleString('en-US', {
        timeZone: tz, month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
      vapiStatusEl.textContent = `✓ Scheduled for ${when} (${tzShort(tz)})`;
      vapiScheduleCheck.checked = false;
      vapiScheduleRow.style.display = 'none';
    });
  });
}

// Convert a "YYYY-MM-DDTHH:mm" wall-clock string in `tz` to an absolute Date (UTC instant).
function wallClockToUtc(localStr, tz) {
  const [datePart, timePart] = localStr.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi]    = timePart.split(':').map(Number);
  // Start from the naive UTC guess, then correct by the tz offset at that instant.
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const asInTz = new Date(guess.toLocaleString('en-US', { timeZone: tz }));
  const offset = guess.getTime() - asInTz.getTime();
  return new Date(guess.getTime() + offset);
}

function tzShort(tz) {
  const map = {
    'America/New_York': 'EST', 'Asia/Kolkata': 'IST',
    'America/Los_Angeles': 'PST', 'America/Chicago': 'CST',
    'Europe/London': 'GMT',
  };
  return map[tz] || tz;
}

function startCallPoll(applicantId) {
  if (callPollTimer) clearInterval(callPollTimer);
  let attempts = 0;
  const MAX_ATTEMPTS = 60; // 5 min at 5s intervals

  callPollTimer = setInterval(() => {
    attempts++;
    chrome.runtime.sendMessage(
      { type: 'GET_CALL_STATUS', payload: { applicant_id: applicantId } },
      (res) => {
        if (!res?.ok || !res.call) return;
        const call = res.call;

        if (call.status === 'initiated' || call.status === 'in_progress') {
          vapiStatusEl.textContent = call.status === 'in_progress'
            ? '🎙 In progress…'
            : '📱 Ringing…';
          return;
        }

        // Terminal state — stop polling
        clearInterval(callPollTimer);
        callPollTimer = null;
        vapiBtn.classList.remove('calling');
        vapiBtn.disabled    = false;
        vapiBtn.textContent = '📞 Call again';
        vapiStatusEl.style.display = 'none';
        renderCallResult(call);
      }
    );

    if (attempts >= MAX_ATTEMPTS) {
      clearInterval(callPollTimer);
      callPollTimer = null;
      vapiBtn.classList.remove('calling');
      vapiBtn.disabled    = false;
      vapiBtn.textContent = '📞 Call with AI';
      vapiStatusEl.textContent = 'Timed out waiting for call result.';
    }
  }, 5000);
}

function renderCallResult(call) {
  const statusLabels = {
    completed: 'Call Completed',
    no_answer: 'No Answer',
    failed:    'Call Failed',
  };
  const label = statusLabels[call.status] || call.status;

  let html = `
    <div class="vapi-result-label">AI Phone Screen Result</div>
    <span class="vapi-result-badge ${call.status}">${label}</span>
  `;

  if (call.summary) {
    html += `<div class="vapi-summary">${escapeHtml(call.summary)}</div>`;
  }

  const data = call.structured_data || {};
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== '');
  if (entries.length > 0) {
    html += '<div class="vapi-captured">';
    for (const [key, val] of entries) {
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      html += `
        <div class="vapi-captured-row">
          <span class="vapi-captured-key">${escapeHtml(label)}</span>
          <span class="vapi-captured-val">${escapeHtml(String(val))}</span>
        </div>`;
    }
    html += '</div>';
  }

  vapiResultEl.innerHTML = html;
  vapiResultEl.style.display = 'block';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Auto-source: search LinkedIn by JD, score the top 5 ─────────────────────────
// Recruiter picks a JD then clicks "Find top 5". We drive the active tab:
//   search-results page → scrape 5 profile URLs → visit each → scrape + score.
// Results are cached in autoResults and browsed one-by-one with the ‹ › pager.

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Reduce a JD's title field to a clean role title for the LinkedIn search box.
// Some JD titles carry extra context (client, location, "5+ years…") after a
// dash/pipe/bullet or on later lines — keep only the leading role phrase.
function cleanJobTitle(s) {
  return String(s || '')
    .split('\n')[0]                 // first line only
    .split(/\s[-–|·•]\s/)[0]        // drop " - client", " | location", etc.
    .replace(/[^A-Za-z ]+/g, ' ')   // letters + spaces only (no digits/symbols)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

// Injected into the LinkedIn page: type the JD title into the global search bar
// and submit (Enter), exactly as a recruiter would. LinkedIn's search box is a
// React-controlled typeahead, so set the value via the native setter and fire an
// `input` event before dispatching Enter, otherwise React ignores the change.
// Returns {ok} so the caller can fall back to direct URL navigation if the bar
// isn't present (e.g. layout variant).
function scoutFillSearch(keywords, submit) {
  const input = document.querySelector(
    'input[data-testid="typeahead-input"], input[componentkey="SearchResults_SearchTyahInputRef"], input[placeholder="Search"]'
  );
  if (!input) return { ok: false, error: 'search input not found' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, keywords);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  if (submit) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
  }
  return { ok: true };
}

// Type the JD title into the page's search bar. submit=true also presses Enter to
// run the search. Resolves after the injected function runs.
function fillSearchBar(tabId, keywords, submit = true) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      { target: { tabId }, func: scoutFillSearch, args: [keywords, submit] },
      (res) => { void chrome.runtime.lastError; resolve(res?.[0]?.result || { ok: false }); }
    );
  });
}

// Injected: click the "People" vertical filter on the all-results page so the
// results narrow to people. The pill is an <a> that navigates to the people URL.
function scoutClickPeople() {
  const el = document.querySelector(
    'a[aria-label="Filter by People"], a[href*="/search/results/people/"]'
  );
  if (!el) return { ok: false };
  el.click();
  return { ok: true };
}

function clickPeopleFilter(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      { target: { tabId }, func: scoutClickPeople },
      (res) => { void chrome.runtime.lastError; resolve(res?.[0]?.result || { ok: false }); }
    );
  });
}

// Resolve once the tab finishes loading (or after a timeout — SPA content keeps
// streaming after `complete`, and the per-profile scrapers do their own waiting).
function waitForTabLoad(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpd);
      resolve();
    };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId, (t) => { if (!chrome.runtime.lastError && t?.status === 'complete') finish(); });
    setTimeout(finish, timeout);
  });
}

// Inject the search scraper and ask it for the top profile URLs.
function getSearchResults(tabId, count = 5) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      { target: { tabId }, files: ['content_scripts/linkedin_search.js'] },
      () => {
        if (chrome.runtime.lastError) { resolve([]); return; }
        chrome.tabs.sendMessage(tabId, { action: 'getSearchResults', count }, (res) => {
          void chrome.runtime.lastError;
          resolve(res?.results || []);
        });
      }
    );
  });
}

// Scrape one profile tab (forces a fresh extraction). Mirrors requestProfile's
// inject-fallback but returns a promise instead of mutating UI state.
function getProfilePromise(tabId) {
  return new Promise((resolve) => {
    const ask = (cb) => chrome.tabs.sendMessage(tabId, { action: 'getProfile', force: true }, cb);
    ask((resp) => {
      if (chrome.runtime.lastError || !resp?.profile) {
        chrome.scripting.executeScript(
          { target: { tabId }, files: ['content_scripts/linkedin.js'] },
          () => {
            if (chrome.runtime.lastError) { resolve(null); return; }
            setTimeout(() => ask((r2) => { void chrome.runtime.lastError; resolve(r2?.profile || null); }), 400);
          }
        );
        return;
      }
      resolve(resp.profile);
    });
  });
}

// Score a scraped candidate against the selected JD (promise wrapper for GET_SCORE).
function scorePromise(jdId, cand) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_SCORE', payload: { jd_id: jdId, candidate: cand } }, (res) => {
      void chrome.runtime.lastError;
      resolve(res?.ok ? res.data : null);
    });
  });
}

async function runAutoSource() {
  if (!selectedJd) { showStatus('Pick a Job Description first.', 'error'); return; }

  autoSourcing = true;
  autoResults  = [];
  autoPager.style.display = 'none';
  profileCard.classList.remove('show');
  scoreCard.classList.remove('show');
  autosourceBtn.disabled = true;
  showStatus('Searching LinkedIn…', 'loading');

  try {
    const keywords  = cleanJobTitle(selectedJdTitle);
    const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`;

    // Need a LinkedIn page that has the global search bar. Reuse the active tab
    // if it's already on LinkedIn; otherwise open the feed.
    const tab = await getTargetTab();
    let workTabId;
    if (tab && /https:\/\/www\.linkedin\.com\//.test(tab.url || '')) {
      workTabId = tab.id;
    } else {
      const created = await chrome.tabs.create({ url: 'https://www.linkedin.com/feed/', active: true });
      workTabId = created.id;
      await waitForTabLoad(workTabId);
      await delay(1500);
    }

    // Type the JD title into the search bar and submit (visible recruiter action).
    await fillSearchBar(workTabId, keywords, true);
    await waitForTabLoad(workTabId);
    await delay(1500);

    // Click the People filter on the all-results page. Fall back to the people
    // URL if the pill isn't present (layout variant / search bar missed).
    showStatus('Opening People results…', 'loading');
    const ppl = await clickPeopleFilter(workTabId);
    if (!ppl?.ok) await chrome.tabs.update(workTabId, { url: searchUrl, active: true });
    await waitForTabLoad(workTabId);
    await delay(2000);

    showStatus('Reading top candidates…', 'loading');
    const results = (await getSearchResults(workTabId, 5)).slice(0, 5);
    if (!results.length) {
      showStatus('No people found for this JD on LinkedIn.', 'error');
      return;
    }

    for (let i = 0; i < results.length; i++) {
      showStatus(`Reading candidate ${i + 1} of ${results.length}…`, 'loading');
      await chrome.tabs.update(workTabId, { url: results[i].url, active: true });
      await waitForTabLoad(workTabId);
      await delay(1500);

      const profile = await getProfilePromise(workTabId);
      if (!profile) continue;
      const score = await scorePromise(selectedJd, profile);
      autoResults.push({ candidate: profile, score });
    }

    // Avoid the tab listener re-scanning the last visited profile after we finish.
    lastProfileSlug = siteFor(results[results.length - 1].url)?.slug || lastProfileSlug;

    if (!autoResults.length) {
      showStatus('Could not read any candidate profiles.', 'error');
      return;
    }

    // Rank best-fit first.
    autoResults.sort((a, b) => (b.score?.score || 0) - (a.score?.score || 0));
    autoIndex = 0;
    statusEl.classList.remove('show');
    showAutoResult();
  } catch (e) {
    console.error('[SCOUT] auto-source error:', e);
    showStatus('Auto-source failed: ' + e.message, 'error');
  } finally {
    autoSourcing = false;
    autosourceBtn.disabled = false;
  }
}

// Render the currently-selected auto-source candidate into the existing profile +
// score cards, reusing the normal single-candidate UI (Add to SCOUT, Vapi, etc.).
function showAutoResult() {
  const item = autoResults[autoIndex];
  if (!item) return;

  candidate      = item.candidate;
  currentScore   = item.score;
  profilePending = false;

  // Reset per-candidate transient state (résumé attachment, added/call status).
  resumeB64 = ''; resumeFileName = ''; resumeMime = ''; resumeText = '';
  resumeFile.value = ''; resumeName.textContent = 'No file chosen'; resumeClear.style.display = 'none';
  addedApplicantId = null;
  if (vapiSection) vapiSection.style.display = 'none';
  jazzhrBtn.style.display = 'none';

  renderProfile(candidate);
  if (currentScore) {
    renderScore(currentScore, false);
  } else {
    scoreCard.classList.remove('show');
    showStatus('Could not score this candidate.', 'error');
  }

  autoLabel.textContent = `${autoIndex + 1} / ${autoResults.length}`;
  autoPrev.disabled = autoIndex === 0;
  autoNext.disabled = autoIndex === autoResults.length - 1;
  autoPager.style.display = 'flex';
}

autosourceBtn.addEventListener('click', runAutoSource);
autoPrev.addEventListener('click', () => {
  if (autoIndex > 0) { autoIndex--; showAutoResult(); }
});
autoNext.addEventListener('click', () => {
  if (autoIndex < autoResults.length - 1) { autoIndex++; showAutoResult(); }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className   = `status ${type} show`;
}

// Clean a phone string for the backend/JazzHR: drop "(Mobile)" tags and any
// punctuation/spacing, keep digits and a leading +. Empty if no digits.
function normalizePhone(s) {
  if (!s) return '';
  const t      = String(s).replace(/\((mobile|home|work|cell)\)/ig, '').trim();
  const hasPlus = /^\s*\+/.test(t);
  const digits  = t.replace(/\D/g, '');
  return digits ? (hasPlus ? '+' : '') + digits : '';
}
