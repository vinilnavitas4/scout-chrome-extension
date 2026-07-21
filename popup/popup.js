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
const diceTop5Btn    = document.getElementById('dice-top5-btn');
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

// Email/phone found on LinkedIn / résumé — used unless the recruiter types a
// manual override into the editable field.
let foundEmail = '';
let foundPhone = '';

// Manual email/phone edits flow straight into the candidate so Add-to-SCOUT and
// the AI call both use the recruiter-entered value. Empty field falls back to
// the found one.
profileEmail.addEventListener('input', () => {
  if (!candidate) return;
  candidate.email = profileEmail.value.trim() || foundEmail;
  saveLastProfile();
});

profilePhone.addEventListener('input', () => {
  if (!candidate) return;
  candidate.phone = profilePhone.value.trim() || foundPhone;
  saveLastProfile();
});

let candidate       = null;   // set when profile fetch completes
let selectedJd      = null;
let selectedJdTitle = null;
let currentScore    = null;
let profilePending  = true;   // true while profile fetch is in flight
let scoreVersion    = 0;      // incremented on each new score request to discard stale AI responses
let modelReady      = false;  // true once offscreen ML model finishes loading
let resumeB64       = '';     // base64-encoded resume file if recruiter attached one
let resumeFileName  = '';     // original filename — JazzHR needs it to attach the resume
let resumeMime      = '';     // file MIME type, sent alongside the base64
let resumeText      = '';     // plain text parsed from the attached resume (for skill re-scoring)

// ── Auto-source (top-5 Dice TalentSearch) state ────────────────────────────────
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
  saveLastProfile();   // persist the attachment with the cached profile

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
  saveLastProfile();   // persist the removal
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
  saveLastProfile();
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
  // Skipped while auto-sourcing / showing top-5 — those updates belong to the
  // batch loop's own candidates, not the single-profile view.
  if (message?.type === "DICE_PROFILE_UPDATED" && message.profile && !autoSourcing && !autoResults.length) {
    candidate = message.profile;
    foundEmail = candidate.email || foundEmail;
    foundPhone = candidate.phone || foundPhone;
    renderProfile(candidate);
    saveLastProfile();
    if (selectedJd) requestScore(selectedJd);
  }

  // Floating button clicked. The panel may already be open on a profile the user
  // reached via SPA navigation (no tabs.onUpdated fired), so re-evaluate the
  // active tab now. Clearing lastProfileSlug forces handleActiveTab to re-run the
  // scan/cache path for the current profile instead of deduping it away.
  if (message?.type === "SCOUT_RESCAN") {
    lastProfileSlug = '';
    handleActiveTab();
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

// JD selection + attached résumé belong to the previous candidate — clear both
// on a profile switch. Not called on the refresh-button rescan, which keeps the
// selected JD (and re-fetches the JD list preserving it).
function clearJdAndResume() {
  selectedJd      = null;
  selectedJdTitle = null;
  jdSelect.value  = '';
  currentScore    = null;
  scoreCard.classList.remove('show');
  resumeUpload.style.display = 'none';

  resumeB64      = '';
  resumeFileName = '';
  resumeMime     = '';
  resumeText     = '';
  resumeFile.value = '';
  resumeName.textContent = 'No file chosen';
  resumeClear.style.display = 'none';
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

// True for the Dice TalentSearch search/results pages (NOT a candidate profile).
// On these pages picking a JD drives the auto-source top-5 pipeline.
function isDiceSearchPage(url) {
  return /dice\.com\/employers\/talent-search\/(?!profile\/)/i.test(url || '');
}

// Sync panel to the active tab: empty state off LinkedIn, auto-scan when a
// (new) profile is showing. Runs at open and on every tab switch/navigation.
// Suppressed while the auto-source loop is driving the tab through profiles.
async function handleActiveTab() {
  if (autoSourcing) return;          // our own navigation — don't react to it
  if (autoResults.length) return;    // showing top-5 results — keep them on screen

  const tab = await getTargetTab();
  if (!tab) return;
  const site = siteFor(tab.url);
  const onProfile = !!site;
  const onDiceSearch = isDiceSearchPage(tab.url);

  // Off-profile pages keep the last extracted candidate on screen (recruiters
  // navigate away mid-review); the empty state only shows before any extraction.
  if (!onProfile && !candidate) await restoreLastProfile();
  const showMain = onProfile || !!candidate || onDiceSearch;
  mainView.style.display  = showMain ? '' : 'none';
  emptyView.style.display = showMain ? 'none' : 'block';
  if (!onProfile) {
    // Dice TalentSearch results page — expose the JD picker so selecting a JD
    // can auto-run the search + top-5 extraction even before any profile scan.
    if (onDiceSearch) {
      sourceBadge.textContent = 'Dice';
      matchSection.style.display = 'block';
    }
    return;
  }

  sourceBadge.textContent = site.source;
  matchSection.style.display = 'block';

  if (site.slug !== lastProfileSlug) {
    lastProfileSlug = site.slug;
    clearJdAndResume();
    // Previously scanned profile → restore from cache (keeps manual edits);
    // brand-new profile → fresh scan, which clears the old details first.
    const hit = (await getProfileCache())[site.slug];
    if (hit?.candidate) adoptCachedProfile(hit);
    else startScan(tab.id, site.script);
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

// Per-profile candidate cache for the browser session, keyed by slug. Lets the
// panel restore a previously scanned profile (including manual contact edits)
// when the recruiter returns to it, and survive panel close/reopen. Evicts the
// oldest entries beyond the cap.
const PROFILE_CACHE_MAX = 20;

async function getProfileCache() {
  try {
    const { profileCache } = await chrome.storage.session.get('profileCache');
    return profileCache || {};
  } catch (_) { return {}; }
}

async function saveLastProfile() {
  if (!candidate || !lastProfileSlug) return;
  const cache = await getProfileCache();
  cache[lastProfileSlug] = {
    candidate,
    source:  sourceBadge.textContent,
    jdId:    selectedJd,
    jdTitle: selectedJdTitle,
    score:   currentScore,
    resume:  resumeB64
      ? { b64: resumeB64, name: resumeFileName, mime: resumeMime, text: resumeText }
      : null,
    ts: Date.now()
  };
  const slugs = Object.keys(cache);
  if (slugs.length > PROFILE_CACHE_MAX) {
    slugs.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
    for (const s of slugs.slice(0, slugs.length - PROFILE_CACHE_MAX)) delete cache[s];
  }
  try {
    await chrome.storage.session.set({ profileCache: cache, lastSlug: lastProfileSlug });
  } catch (_) { /* storage unavailable — cache is best-effort */ }
}

// Restore the JD selection + attached résumé saved with a cached profile.
function applyCachedExtras(hit) {
  if (hit.jdId) {
    selectedJd      = hit.jdId;
    selectedJdTitle = hit.jdTitle || hit.jdId;
    jdSelect.value  = hit.jdId;   // no-op if the JD list hasn't loaded yet — loadJds re-applies it
  }
  if (hit.resume?.b64) {
    resumeB64      = hit.resume.b64;
    resumeFileName = hit.resume.name || 'resume';
    resumeMime     = hit.resume.mime || '';
    resumeText     = hit.resume.text || '';
    resumeName.textContent = resumeFileName;
    resumeClear.style.display = 'inline';
  }
}

// Show the cached score without re-calling the AI; falls back to a re-score
// when a JD was selected but its score never finished.
function renderCachedScore(hit) {
  if (hit.score) {
    currentScore = hit.score;
    renderScore(currentScore, !!(resumeText || candidate?.resumeText));
  } else if (selectedJd) {
    showStatus('Matching profile to selected JD…', 'loading');
    requestScore(selectedJd);
  }
}

// Panel reopened on a non-profile page → bring back the most recent candidate.
async function restoreLastProfile() {
  try {
    const { lastSlug } = await chrome.storage.session.get('lastSlug');
    if (!lastSlug) return;
    const hit = (await getProfileCache())[lastSlug];
    if (!hit?.candidate) return;
    candidate      = hit.candidate;
    profilePending = false;
    sourceBadge.textContent = hit.source || '';
    matchSection.style.display = 'block';
    applyCachedExtras(hit);
    renderProfile(candidate);
    renderCachedScore(hit);
  } catch (_) { /* storage unavailable — keep empty state */ }
}

// Returned to an already-scanned profile → show its cached details instead of
// rescanning, then re-score against the selected JD.
function adoptCachedProfile(hit) {
  candidate      = hit.candidate;
  currentScore   = null;
  profilePending = false;
  scoreVersion++;

  scoreCard.classList.remove('show');
  jazzhrBtn.style.display = 'none';
  resetAddButton();

  applyCachedExtras(hit);
  renderProfile(candidate);
  renderCachedScore(hit);   // sets currentScore before the save below
  saveLastProfile();        // refresh ts + lastSlug pointer
}

function onProfileLoaded(profile) {
  candidate     = profile;
  profilePending = false;
  refreshBtn.classList.remove('spinning');
  renderProfile(profile);
  saveLastProfile();
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

  // Email/phone found on LinkedIn/résumé show read-only above; the editable
  // fields stay empty for a manual add/override. candidate.email/.phone default
  // to the found values until the recruiter types one in.
  foundEmail = p.email || '';
  if (foundEmail) {
    profileEmailFound.textContent = foundEmail;
    profileEmailFound.href = `mailto:${foundEmail}`;
    profileEmailFound.style.display = 'block';
  } else {
    profileEmailFound.style.display = 'none';
  }
  profileEmail.value = '';

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
    // Re-apply the selection: explicit preserveId (refresh button) or a JD
    // restored from the profile cache before the list finished loading.
    const keep = preserveId || selectedJd;
    if (keep) {
      jdSelect.value = keep;
      if (jdSelect.value !== keep) {
        // JD no longer exists on the backend — clear stale selection
        selectedJd = null;
        selectedJdTitle = null;
      }
    }
  });
}

jdSelect.addEventListener('change', async () => {
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
  saveLastProfile();

  // On the Dice TalentSearch results page a JD pick means "source top 5":
  // auto-run the search with JD-derived conditions instead of scoring whatever
  // candidate happens to be cached.
  const tab = await getTargetTab();
  if (isDiceSearchPage(tab?.url)) {
    runDiceAutoSource();
    return;
  }

  if (candidate) {
    // Profile already loaded — score immediately
    requestScore(jdId);
  } else if (profilePending) {
    // Profile still loading — show holding message, score fires in onProfileLoaded
    showStatus('Reading profile… will score when ready.', 'loading');
  } else {
    // Profile fetch already failed
    showStatus('Could not read profile. Try refreshing the page.', 'error');
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
      saveLastProfile();
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

// Doc §3.4 — matched vs missing required + preferred skills as chips.
function renderSkillLists(categories) {
  if (!skillLists) return;
  const cats = categories || [];
  const req = cats.find(c => c.key === 'required');
  if (!req) { skillLists.innerHTML = ''; return; }

  const chip = (s, cls) => `<span class="skill-chip ${cls}">${escapeHtml(s)}</span>`;
  const group = (label, chips) =>
    chips ? `<div class="skill-group"><span class="skill-group-label">${label}</span><div class="skill-chips">${chips}</div></div>` : '';
  const section = (cat) => {
    const matched = (cat.matched || []).map(s => chip(s, 'matched')).join('');
    const missing = (cat.missing || []).map(s => chip(s, 'missing')).join('');
    return group('Matched', matched) + group('Missing', missing);
  };

  let html = `<div class="skill-section"><span class="skill-section-label">Required</span>${section(req)}</div>`;

  // Preferred section — only when the JD actually lists preferred skills.
  const pref = cats.find(c => c.key === 'preferred' && c.active &&
    ((c.matched || []).length || (c.missing || []).length));
  if (pref) {
    html += `<div class="skill-section"><span class="skill-section-label">Preferred</span>${section(pref)}</div>`;
  }
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
  showStatus('Adding to JazzHR…', 'loading');

  chrome.runtime.sendMessage({ type: 'ADD_CANDIDATE', payload }, (res) => {
    statusEl.classList.remove('show');
    if (res?.ok) {
      addBtn.textContent = 'Added to JazzHR ✓';
      addBtn.className   = 'btn btn-success';
      resumeUpload.style.display = 'none';
      if (res.jazzhr_url) {
        jazzhrBtn.href          = res.jazzhr_url;
        jazzhrBtn.style.display = 'flex';
      }
    } else {
      showStatus(res?.error || 'Failed to add.', 'error');
      addBtn.disabled = false;
    }
  });
});

function resetAddButton() {
  addBtn.textContent = 'Add to JazzHR';
  addBtn.className   = 'btn btn-primary';
  addBtn.disabled    = !selectedJd;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Auto-source: search Dice TalentSearch by JD, score the top 5 ────────────────
// Recruiter picks a JD (on the TalentSearch page the pick itself triggers this;
// the button works from anywhere). We drive the active tab:
//   TalentSearch search page → type the JD-derived Boolean + location → submit →
//   scrape 5 profile URLs → visit each → scrape + score.
// Results are cached in autoResults and browsed one-by-one with the ‹ › pager.

const delay = (ms) => new Promise(r => setTimeout(r, ms));

const DICE_SEARCH_URL = 'https://www.dice.com/employers/talent-search/search';

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

// Ask the SW to turn the JD into Dice search conditions (Boolean keyword + location).
function getJdSearchParams(jdId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_JD_SEARCH_PARAMS', payload: { jd_id: jdId } }, (res) => {
      void chrome.runtime.lastError;
      resolve(res?.ok ? res.data : null);
    });
  });
}

// Inject the Dice search driver (idempotent — the script self-guards) and send it a message.
function diceSearchMessage(tabId, msg) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      { target: { tabId }, files: ['content_scripts/dice_search.js'] },
      () => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        chrome.tabs.sendMessage(tabId, msg, (res) => {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      }
    );
  });
}

// Scrape one Dice profile tab (forces a fresh extraction). Mirrors requestProfile's
// inject-fallback but returns a promise instead of mutating UI state.
function getProfilePromise(tabId, scriptFile) {
  return new Promise((resolve) => {
    const ask = (cb) => chrome.tabs.sendMessage(tabId, { action: 'getProfile', force: true }, cb);
    ask((resp) => {
      if (chrome.runtime.lastError || !resp?.profile) {
        chrome.scripting.executeScript(
          { target: { tabId }, files: [scriptFile] },
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
    chrome.runtime.sendMessage(
      { type: 'GET_SCORE', payload: { jd_id: jdId, candidate: cand, resume_text: cand?.resumeText || undefined } },
      (res) => {
        void chrome.runtime.lastError;
        resolve(res?.ok ? res.data : null);
      }
    );
  });
}

async function runDiceAutoSource() {
  if (!selectedJd) { showStatus('Pick a Job Description first.', 'error'); return; }
  if (autoSourcing) return;

  autoSourcing = true;
  autoResults  = [];
  autoPager.style.display = 'none';
  profileCard.classList.remove('show');
  scoreCard.classList.remove('show');
  if (diceTop5Btn) diceTop5Btn.disabled = true;
  showStatus('Building search from JD…', 'loading');

  try {
    const params = await getJdSearchParams(selectedJd);
    if (!params || !params.keyword) {
      showStatus('Could not derive search conditions from this JD.', 'error');
      return;
    }

    // Need a tab on the TalentSearch search page. Reuse the active tab if it's
    // already there; navigate a Dice tab; otherwise open a fresh tab.
    const tab = await getTargetTab();
    let workTabId;
    if (tab && isDiceSearchPage(tab.url) && /talent-search\/search/.test(tab.url)) {
      workTabId = tab.id;
    } else if (tab && /https:\/\/www\.dice\.com\//.test(tab.url || '')) {
      workTabId = tab.id;
      await chrome.tabs.update(workTabId, { url: DICE_SEARCH_URL, active: true });
      await waitForTabLoad(workTabId);
      await delay(2000);
    } else {
      const created = await chrome.tabs.create({ url: DICE_SEARCH_URL, active: true });
      workTabId = created.id;
      await waitForTabLoad(workTabId);
      await delay(2000);
    }

    // Type the JD-derived Boolean (+ location) into the search bar and submit.
    showStatus('Searching Dice TalentSearch…', 'loading');
    const run = await diceSearchMessage(workTabId, {
      action: 'runDiceSearch',
      keyword:   params.keyword,
      location:  params.location || '',
      clearance: !!params.clearance,   // JD asks for a clearance → filter results to cleared candidates
    });
    if (!run?.ok) {
      showStatus('Search failed: ' + (run?.error || 'could not drive the search page.'), 'error');
      return;
    }
    await delay(2500);   // results stream in via XHR — scraper also polls

    showStatus('Reading top candidates…', 'loading');
    const scrape = await diceSearchMessage(workTabId, { action: 'getDiceSearchResults', count: 5 });
    const results = (scrape?.results || []).slice(0, 5);
    if (!results.length) {
      showStatus('No candidates found on Dice for this JD.', 'error');
      return;
    }

    for (let i = 0; i < results.length; i++) {
      showStatus(`Reading candidate ${i + 1} of ${results.length}… (résumé parse takes a moment)`, 'loading');
      await chrome.tabs.update(workTabId, { url: results[i].url, active: true });
      await waitForTabLoad(workTabId);
      await delay(1500);

      const profile = await getProfilePromise(workTabId, 'content_scripts/dice.js');
      if (!profile) continue;
      showStatus(`Scoring candidate ${i + 1} of ${results.length}…`, 'loading');
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
    console.error('[SCOUT] Dice auto-source error:', e);
    showStatus('Auto-source failed: ' + e.message, 'error');
  } finally {
    autoSourcing = false;
    if (diceTop5Btn) diceTop5Btn.disabled = false;
  }
}

// Render the currently-selected auto-source candidate into the existing profile +
// score cards, reusing the normal single-candidate UI (Add to JazzHR, etc.).
function showAutoResult() {
  const item = autoResults[autoIndex];
  if (!item) return;

  candidate      = item.candidate;
  currentScore   = item.score;
  profilePending = false;

  // Reset per-candidate transient state (résumé attachment, added status).
  resumeB64 = ''; resumeFileName = ''; resumeMime = ''; resumeText = '';
  resumeFile.value = ''; resumeName.textContent = 'No file chosen'; resumeClear.style.display = 'none';
  jazzhrBtn.style.display = 'none';
  resetAddButton();

  sourceBadge.textContent = 'Dice';
  matchSection.style.display = 'block';
  renderProfile(candidate);
  if (currentScore) {
    renderScore(currentScore, !!candidate.resumeText);
  } else {
    scoreCard.classList.remove('show');
    showStatus('Could not score this candidate.', 'error');
  }

  autoLabel.textContent = `${autoIndex + 1} / ${autoResults.length}`;
  autoPrev.disabled = autoIndex === 0;
  autoNext.disabled = autoIndex === autoResults.length - 1;
  autoPager.style.display = 'flex';
}

if (diceTop5Btn) diceTop5Btn.addEventListener('click', runDiceAutoSource);
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
