const profileCard    = document.getElementById('profile-card');
const profileAvatar  = document.getElementById('profile-avatar');
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
const jdSearchBtn     = document.getElementById('jd-search-btn');
const peopleResults       = document.getElementById('people-results');
const peopleResultsStatus = document.getElementById('people-results-status');
const peopleResultsList   = document.getElementById('people-results-list');
const peopleResultsClose  = document.getElementById('people-results-close');
const peopleResultsToggle = document.getElementById('people-results-toggle');
const jdSearchSection = document.getElementById('jd-search-section');
const jdSearchSelect  = document.getElementById('jd-search-select');
const jdSearchSpinner = document.getElementById('jd-search-spinner');
const scoreCard      = document.getElementById('score-card');
const scoreHeading   = document.getElementById('score-heading');
const scoreCircle    = document.getElementById('score-circle');
const scoreNumber    = document.getElementById('score-number');
const scoreLabel     = document.getElementById('score-label');
const scoreRationale = document.getElementById('score-rationale');
const scoreBreakdown = document.getElementById('score-breakdown');
const skillLists     = document.getElementById('skill-lists');
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
const bestfitClose   = document.getElementById('bestfit-close');
const mainView       = document.getElementById('main-view');
const emptyView      = document.getElementById('empty-view');
const matchSection   = document.getElementById('match-section');
const closeBtn       = document.getElementById('close-btn');
const refreshBtn     = document.getElementById('refresh-btn');

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

// The file picker is a <label>; clicking it works, Enter/Space does not — wire it
// up so the upload is reachable without a mouse.
document.querySelector('.resume-pick-btn')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); resumeFile.click(); }
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
  if (message?.type === "DICE_PROFILE_UPDATED" && message.profile) {
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
  jdSearchBtn.disabled = true;
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

// Sync panel to the active tab: empty state off LinkedIn, auto-scan when a
// (new) profile is showing. Runs at open and on every tab switch/navigation.
async function handleActiveTab() {
  // A ranking walk drives the worker tab through profile after profile. Those are
  // background reads, not the recruiter navigating — reacting to them would swap
  // the panel onto each visited candidate and wipe the ranking mid-run.
  if (peopleRankBusy) return;

  const tab = await getTargetTab();
  if (!tab) return;
  const site = siteFor(tab.url);
  const onProfile = !!site;

  // Off-profile pages keep the last extracted candidate on screen (recruiters
  // navigate away mid-review); the empty state only shows before any extraction.
  if (!onProfile && !candidate) await restoreLastProfile();
  const showMain = onProfile || !!candidate;
  mainView.style.display  = showMain ? '' : 'none';
  emptyView.style.display = showMain ? 'none' : 'block';
  if (!showMain) matchSection.style.display = 'none';

  // On LinkedIn without a candidate (feed, search, company page) the empty state
  // still offers the JD picker so a JD search can be launched from there.
  const onLinkedIn = /^https:\/\/www\.linkedin\.com\//i.test(tab.url || '');
  jdSearchSection.style.display = (!showMain && onLinkedIn) ? 'block' : 'none';
  // The search drives LinkedIn's own search box, so it's hidden on Dice tabs.
  jdSearchBtn.style.display = onLinkedIn ? '' : 'none';

  if (!onProfile) return;

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
    jdSearchBtn.disabled = false;
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

// First letter of the first two name words — cheap avatar, no network fetch.
function initialsOf(name) {
  return (name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('') || '?';
}

function renderProfile(p) {
  profileAvatar.textContent = initialsOf(p.name);
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
  jdSearchSpinner.classList.add('show');
  jdSelect.disabled = true;
  jdSearchSelect.disabled = true;

  chrome.runtime.sendMessage({ type: 'GET_JDS', fresh: !!fresh }, (res) => {
    jdSpinner.classList.remove('show');
    jdSearchSpinner.classList.remove('show');
    if (!res?.ok) {
      jdSelect.innerHTML = '<option value="">Failed to load jobs</option>';
      jdSearchSelect.innerHTML = '<option value="">Failed to load jobs</option>';
      return;
    }
    // Same list feeds the scoring dropdown (profile view) and the search-only
    // dropdown on the empty state.
    jdSelect.innerHTML       = '<option value="">— Choose a JD —</option>';
    jdSearchSelect.innerHTML = '<option value="">— Choose a JD —</option>';
    res.data.forEach(jd => {
      const opt = document.createElement('option');
      opt.value = jd.id;
      opt.dataset.title = jd.title;
      opt.textContent = jd.client ? `${jd.title}  ·  ${jd.client}` : jd.title;
      jdSelect.appendChild(opt);
      jdSearchSelect.appendChild(opt.cloneNode(true));
    });
    jdSelect.disabled = false;
    jdSearchSelect.disabled = false;
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
      jdSearchBtn.disabled = !jdSelect.value;
    }
  });
}

jdSelect.addEventListener('change', () => {
  const jdId = jdSelect.value;
  jdSearchBtn.disabled = !jdId;
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

  // Picking a JD also sources for it: search LinkedIn, switch to People, then
  // score that page's candidates and surface the top 5. The scan above already
  // holds this candidate in memory, so replacing the page costs nothing.
  searchJdOnLinkedIn(selectedJdTitle, jdId);
});

// Manual re-run of the same sourcing pass — after the recruiter has navigated
// elsewhere, or to refresh the ranking against a page of newer results.
jdSearchBtn.addEventListener('click', () => {
  if (!selectedJdTitle) return;
  searchJdOnLinkedIn(selectedJdTitle, selectedJd);
});

// Empty-state dropdown: search only, no scoring — there is no candidate here.
jdSearchSelect.addEventListener('change', () => {
  const title = jdSearchSelect.selectedOptions[0]?.dataset.title;
  if (!jdSearchSelect.value || !title) return;
  searchJdOnLinkedIn(title, jdSearchSelect.value);
});

// Backend JD titles carry recruiting noise the role name doesn't need — client
// codes, location, work mode, employment type ("Java Developer - Remote (C2C)
// #REQ1234"). LinkedIn matches on the role, so everything else is stripped and
// only the job title is searched.
function jobTitleQuery(raw) {
  let t = String(raw || '');

  t = t.replace(/[([{][^)\]}]*[)\]}]/g, ' ');   // (Remote), [Contract]
  t = t.replace(/#\s*\w[\w-]*/g, ' ');          // #REQ1234
  t = t.split(/\s+[|–—:]+\s+|\s+-\s+|\s{2,}·\s{2,}|\s+·\s+/)[0];  // cut at first separator

  // Trailing qualifiers left behind when no separator preceded them.
  t = t.replace(
    /\b(?:100%\s*)?(?:remote|onsite|on-?site|hybrid|contract|contract\s*to\s*hire|c2h|c2c|w2|1099|corp\s*to\s*corp|full[\s-]?time|part[\s-]?time|permanent|perm|temp(?:orary)?|urgent|immediate|hiring|opening|position|req(?:uisition)?)\b/gi,
    ' '
  );

  // Req/ID codes and bare numbers are internal bookkeeping. LinkedIn matches on
  // words, so a stray "12345" narrows people results to nothing. Tokens that mix
  // letters into digits are kept — they belong to the tech name ("Oracle 12c",
  // "S/4HANA"); standalone digits are dropped ("Engineer 2" → "Engineer").
  t = t.replace(/\b(?:req|requisition|job|jd|id|ref|no)\.?\s*[-#:]?\s*\d[\w-]*/gi, ' ');
  t = t.replace(/\b\d+(?:[-/.]\d+)*\b/g, ' ');

  return t.replace(/^[\s,:\-–—|]+/, '')      // stray punctuation from a dropped prefix ("URGENT: …")
          .replace(/[\s,:\-–—|/]+$/, '')
          .replace(/\s+/g, ' ')
          .trim() || String(raw || '').trim();
}

// Drives LinkedIn's nav search box via the content script. Falls back to
// navigating the tab directly when the script isn't present on the page.
async function searchJdOnLinkedIn(rawTitle, jdId) {
  const q = jobTitleQuery(rawTitle);
  if (!q) return;

  const tab = await getTargetTab();
  if (!tab || !/^https:\/\/www\.linkedin\.com\//i.test(tab.url || '')) return;

  chrome.tabs.sendMessage(tab.id, { action: 'searchJd', query: q }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) {
      chrome.tabs.update(tab.id, {
        url: 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent(q),
      });
    }
    if (jdId) rankPeopleOnResultsPage(tab.id, jdId);
  });
}

// ── Rank the people-search page ───────────────────────────────────────────────
// Once the People tab is showing, the cards on it are scraped and each is scored
// against the JD in the background, then every candidate is listed with its score,
// ranked best-first. Cards only supply the roster — each score comes from reading
// that person's actual profile, the same read the panel does for one candidate.

let peopleRankVersion = 0;
let peopleRankBusy    = false;   // true while the worker tab is being walked
let selectedRankSlug  = '';      // ranked row currently shown in the panel

// The answer a recruiter wants out of a page of results is the shortlist, not the
// full roster. Only the best PEOPLE_TOP_N are listed; everyone else stays one
// click away behind the "Show all" row, so nothing is lost.
const PEOPLE_TOP_N   = 5;
let peopleShowAll    = false;
// Kept so the "Show all" row can redraw the list without re-running the walk.
let lastPeopleRender = null;

function showPeopleResults(msg) {
  peopleResultsStatus.textContent = msg;
  peopleResults.style.display = 'block';
}

// Minimize hides the rows but leaves the header — and the walk — alone. Close is
// the destructive one: it cancels the ranking and drops the results.
function setPeopleCollapsed(collapsed) {
  peopleResults.classList.toggle('collapsed', collapsed);
  peopleResultsToggle.setAttribute('aria-expanded', String(!collapsed));
  peopleResultsToggle.title = collapsed ? 'Expand list' : 'Minimize list';
  peopleResultsToggle.setAttribute('aria-label',
    collapsed ? 'Expand ranked candidates' : 'Minimize ranked candidates');
}

peopleResultsToggle.addEventListener('click', () => {
  setPeopleCollapsed(!peopleResults.classList.contains('collapsed'));
});

peopleResultsClose.addEventListener('click', () => {
  peopleRankVersion++;                       // abandon an in-flight ranking
  peopleResults.style.display = 'none';
  peopleResultsList.innerHTML = '';
  selectedRankSlug = '';
  peopleShowAll    = false;
  lastPeopleRender = null;
  setPeopleCollapsed(false);   // next ranking opens expanded
});

// The search navigates the tab, so the content script is re-injected on the new
// page — poll it until the People results have rendered.
//
// `notRoster` guards the post-filter read. Applying a filter swaps the list in
// place and the OLD cards stay in the DOM while the new ones load, so a plain
// "any cards present?" poll happily returns the pre-filter roster — which then
// gets ranked, and the results look like the filter did nothing. Passing the
// previous roster makes the poll wait for a list that isn't that one.
const rosterKey = (people) => (people || []).map(p => p.slug).join('|');

async function scrapeWhenReady(tabId, notRoster) {
  for (let i = 0; i < 40; i++) {             // ~12s
    const res = await new Promise(resolve => {
      chrome.tabs.sendMessage(tabId, { action: 'scrapePeopleResults' }, (r) => {
        void chrome.runtime.lastError;       // page mid-navigation — just retry
        resolve(r);
      });
    });
    if (res?.ok && res.people?.length && rosterKey(res.people) !== notRoster) return res.people;
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

// ── Locations filter, driven in the page's own JS world ───────────────────────
// Content scripts run in an ISOLATED world: they share the DOM but not the page's
// JavaScript. LinkedIn's location box is a React controlled input, and React only
// notices a change when its internal value tracker is dirtied — a tracker that
// lives in the page world and is invisible from a content script. Setting .value
// there updates what's on screen but leaves React's state empty, so the typeahead
// never runs its query and the menu keeps showing its default suggestions
// (India, United States, …) no matter what was "typed".
//
// So this whole interaction runs via chrome.scripting.executeScript with
// world: 'MAIN'. The function below is serialized into the page, so it must be
// entirely self-contained — no closure over anything in this file.
function locationFilterInPage(want) {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const norm = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  function realClick(el) {
    if (!el) return;
    el.scrollIntoView?.({ block: 'center' });
    const o = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const C = t.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new C(t, o));
    }
  }

  async function waitFor(fn, tries = 25, gap = 200) {
    for (let i = 0; i < tries; i++) {
      const v = fn();
      if (v) return v;
      await sleep(gap);
    }
    return null;
  }

  const findPill = () =>
    document.querySelector('[componentkey="SearchResults_filter_pill_geoUrn"]');

  const findMenu = () => {
    const portals = [...document.querySelectorAll('[data-floating-ui-portal]')].filter(visible);
    return portals.find(p => p.querySelector('input[data-testid="typeahead-input"]')) || null;
  };

  const findInput = () => {
    const menu = findMenu();
    return menu ? menu.querySelector('input[data-testid="typeahead-input"]') : null;
  };

  const rows = () => {
    const menu = findMenu();
    return menu ? [...menu.querySelectorAll('[role="checkbox"][aria-label]')].filter(visible) : [];
  };
  const names = () => rows().map(r => r.getAttribute('aria-label'));

  // This is the part that only works in the page world: dirty React's value
  // tracker so the component treats the assignment as user input.
  function setReactValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const tracker = el._valueTracker;          // React's own change detector
    if (tracker) tracker.setValue(el.value === value ? value + '_' : el.value);
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Last resort for the DOM path: call the component's own onChange/onInput prop
  // off the React fiber. Dispatching events is what a browser does; this is what
  // React itself does, so a component that ignores synthetic events still reacts.
  function fiberProps(el) {
    const key = Object.keys(el).find(k =>
      k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
    return key ? el[key] : null;
  }

  function callReactHandler(el, value) {
    const props = fiberProps(el);
    if (!props) return false;
    const fake = {
      target: el, currentTarget: el, type: 'change', bubbles: true,
      preventDefault() {}, stopPropagation() {}, persist() {},
    };
    let called = false;
    if (typeof props.onChange === 'function') { props.onChange(fake); called = true; }
    if (typeof props.onInput === 'function') { props.onInput({ ...fake, type: 'input' }); called = true; }
    return called;
  }

  // Typing that React actually believes.
  //
  // Assigning .value (even with the tracker dirtied) and dispatching events left
  // this component's state empty — the menu kept showing its default suggestions.
  // execCommand('insertText') goes through the browser's real editing pipeline, so
  // the component receives genuine beforeinput/input events with the right
  // inputType, exactly as if the keys were pressed. That is what makes the
  // typeahead fire its query.
  async function type(el, text) {
    realClick(el);
    el.focus();

    // Clear whatever is there: select all, then insert over it.
    el.setSelectionRange?.(0, el.value.length);
    if (el.value) document.execCommand('delete', false);
    if (el.value) setReactValue(el, '');
    await sleep(80);

    for (const ch of text) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      const ok = document.execCommand('insertText', false, ch);
      if (!ok || !el.value.endsWith(ch)) {
        // execCommand refused (detached/readonly) — fall back to the older path.
        setReactValue(el, el.value + ch);
        callReactHandler(el, el.value);
      }
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      await sleep(70);
    }
  }

  // The JD gives a state, so the state-level row is the one wanted:
  // "Virginia" → "Virginia, United States", NOT "Virginia Beach, Virginia,
  // United States" (a city) and not the bare country. Country-qualified exact
  // match therefore outranks everything else.
  function match(q) {
    const w = norm(q);
    if (!w) return null;
    const list = rows();
    const nameOf = (el) => norm(el.getAttribute('aria-label'));
    const toks = w.split(' ').filter(Boolean);
    return (
      list.find(el => nameOf(el) === w + ' united states') ||
      list.find(el => nameOf(el) === w) ||
      list.find(el => /^(greater )?/.test(nameOf(el)) && nameOf(el) === 'greater ' + w + ' area') ||
      list.find(el => nameOf(el).startsWith(w + ' ')) ||
      list.find(el => new RegExp(`(^| )${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(nameOf(el))) ||
      list.find(el => { const s = new Set(nameOf(el).split(' ')); return toks.every(t => s.has(t)); }) ||
      null
    );
  }

  return (async () => {
    if (!/\/search\/results\/people/.test(location.pathname)) {
      return { ok: false, error: 'not on people results' };
    }


    const pill = await waitFor(findPill, 20);
    if (!pill) return { ok: false, error: 'no pill' };
    realClick(pill.querySelector('label') || pill);

    let input = await waitFor(findInput, 20);
    if (!input) return { ok: false, error: 'no input' };

    // Clear facets left from a previous search — they add to each other.
    const checked = () => rows().filter(r => r.getAttribute('aria-checked') === 'true');
    if (checked().length) {
      const menu = findMenu();
      const reset = [...menu.querySelectorAll('button, [role="button"], a')]
        .filter(visible)
        .find(el => /^reset\b/i.test((el.innerText || '').trim()));
      if (reset) realClick(reset);
      else for (const r of checked()) realClick(r);
      await waitFor(() => checked().length === 0, 12, 150);
      if (!findMenu()) realClick((findPill() || pill).querySelector('label'));
      input = await waitFor(findInput, 20) || input;
    }

    // Full name first, then the leading word ("Dallas, TX" → "Dallas").
    const queries = [want];
    const head = String(want).split(/[,\s]+/)[0];
    if (head && head.toLowerCase() !== String(want).toLowerCase()) queries.push(head);

    // Rows on screen before anything is typed — LinkedIn's default suggestions
    // (India, United States, …). "Take the top result" is only meaningful once
    // this list has been replaced by results for the query; picking row 0 of the
    // defaults would filter the search to a country nobody asked for.
    const defaults = names().join('|');

    let option = null, offered = [];
    for (const q of queries) {
      await type(input, q);

      // Wait for a real match, or for the list to change — whichever lands first.
      await waitFor(() => match(want) || match(q) || names().join('|') !== defaults, 25, 200);
      offered = names();

      // Preferred: the state-level row. Otherwise the top result, as asked, but
      // only from a list that actually refreshed for the query.
      option = match(want) || match(q) ||
               (offered.join('|') !== defaults ? rows()[0] : null);
      if (option) break;
    }

    if (!option) {
      return { ok: false, error: 'suggestions never updated for the typed text',
               typed: input.value, offered: offered.slice(0, 6) };
    }

    const selected = option.getAttribute('aria-label');
    realClick(option);
    await waitFor(() => option.getAttribute('aria-checked') === 'true', 12, 150);

    // "Show results" is an anchor whose href is the finished faceted search.
    const menu = findMenu() || document;
    const apply = [...menu.querySelectorAll('a, button, [role="button"]')]
      .filter(visible)
      .find(el => /\bshow results?\b/i.test((el.innerText || '').trim()));
    if (!apply) return { ok: false, error: 'no apply control', selected };

    const href = await waitFor(() => {
      const h = apply.getAttribute('href') || '';
      return /geoUrn=/.test(h) ? h : null;
    }, 20, 200);

    // Hand the URL back rather than navigating here — navigating would kill this
    // call before it could return.
    if (href) return { ok: true, selected, url: new URL(href, location.origin).href };

    realClick(apply);
    return { ok: true, selected, clicked: true };
  })();
}

async function runLocationFilterInPage(tabId, label) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: locationFilterInPage,
      args: [label],
    });
    return res?.result || null;
  } catch (e) {
    console.log('[SCOUT] location filter injection failed:', e.message);
    return null;
  }
}

// The JD's location, when it states one, is applied as LinkedIn's own Locations
// filter before anything is scraped — filtering at the source beats reading ten
// profiles in the wrong state and scoring them all down for it. A remote JD has no
// location constraint, so the filter is skipped there.
async function applyJdLocationFilter(tabId, jdId) {
  const res = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_JD_LOCATION', payload: { jd_id: jdId } }, (r) => {
      void chrome.runtime.lastError;
      resolve(r);
    });
  });
  const loc = res?.ok ? res.data : null;
  if (!loc || loc.remote || !loc.label) return null;

  showPeopleResults(`Filtering results to ${loc.label}…`);

  // Page world first — it's the only place React's input can actually be typed
  // into. The content-script path stays as a fallback for when injection is
  // refused (some enterprise policies block MAIN-world scripts).
  let applied = await runLocationFilterInPage(tabId, loc.label);
  if (!applied) {
    applied = await sendTabMessage(tabId, {
      action: 'applyLocationFilter', location: loc.label,
    });
  }
  console.log('[SCOUT] location filter result:', applied);

  // "Show results" is an anchor pointing at the finished faceted search. The
  // content script hands that URL back rather than navigating itself — navigating
  // in-page would kill the message channel before it could reply. Drive the tab
  // from here and wait for the filtered page to load.
  if (applied?.ok && applied.url) {
    await chrome.tabs.update(tabId, { url: applied.url }).catch(() => {});
    await waitForTabComplete(tabId, 20000);
    await new Promise(r => setTimeout(r, 800));
  }
  if (!applied?.ok) {
    // Name the step that failed. A bare "could not filter" hides whether the menu
    // never opened, the typing didn't register, or LinkedIn had no such place.
    const why = applied?.error || 'no response from the page';
    const extra = applied?.typed !== undefined
      ? ` (typed "${applied.typed}"${applied.offered?.length ? `; offered: ${applied.offered.join(', ')}` : ''})`
      : '';
    showPeopleResults(`Could not filter to ${loc.label}: ${why}${extra} — ranking all results on the page.`);
    await new Promise(r => setTimeout(r, 2500));
  }
  return applied?.ok ? loc.label : null;
}

async function rankPeopleOnResultsPage(tabId, jdId) {
  const version = ++peopleRankVersion;
  peopleResultsList.innerHTML = '';
  selectedRankSlug = '';
  peopleShowAll    = false;      // every run opens on the top 5
  lastPeopleRender = null;
  setPeopleCollapsed(false);
  showPeopleResults('Reading candidates on the results page…');

  // Wait for the People results to exist before touching the filter bar — the
  // pill isn't in the DOM until the vertical has rendered.
  const firstPass = await scrapeWhenReady(tabId);
  if (version !== peopleRankVersion) return;

  const filtered = firstPass ? await applyJdLocationFilter(tabId, jdId) : null;
  if (version !== peopleRankVersion) return;

  // Only demand a different roster when a filter actually went through; without
  // one the first read is already the right list.
  let people = await scrapeWhenReady(tabId, filtered ? rosterKey(firstPass) : undefined);

  // The filtered page can legitimately hold the same people (a search already
  // scoped to that location). Fall back to whatever is on screen rather than
  // reporting nothing.
  if (!people && filtered) people = await scrapeWhenReady(tabId);

  if (version !== peopleRankVersion) return;         // closed or re-run
  if (!people) { showPeopleResults('No candidates found on the results page.'); return; }
  console.log('[SCOUT] ranking roster:', people.length, 'candidates', filtered ? `(filtered to ${filtered})` : '(unfiltered)');

  // The cards only supply the list of who is on the page — every score shown
  // comes from reading that person's actual profile.
  await deepScorePeople(jdId, people, version);
}

// ── Deep pass: real profile scores via one worker tab ─────────────────────────
// A single tab is opened once, then walked through every candidate on the results
// page one at a time and closed at the end. Each stop runs the full extraction the
// panel uses for a single candidate — including the "Show all skills" click — so
// the curated Skills list is read, not keyword-guessed. One tab, visited serially:
// the extraction scrolls the page and side-trips to /details/skills, so parallel
// runs would fight each other and look like scraping.
//
// The tab is FOREGROUND on purpose. LinkedIn renders experience, education and
// skills lazily, driven by visibility and scroll position; in a background tab
// Chrome throttles timers and never paints, so those sections stay empty and the
// extraction returns a headline-only profile — which scores as a generic number
// no matter who the candidate is. Visible tab = real sections = real score. The
// panel keeps running because it is a side panel, not an action popup, and the
// recruiter's results page is re-focused when the walk finishes.
//
// A profile the tab can't deliver falls back to the in-page fetch, which gets
// headline/About/roles from the server HTML but no curated skills.

// Every candidate on the page gets read. The cap is only a runaway guard — a
// results page holds ~10, so it never bites in normal use.
const DEEP_MAX           = 25;
const DEEP_FETCH_TIMEOUT = 20000;  // in-page fetch fallback
const DEEP_VISIT_TIMEOUT = 45000;  // one profile in the worker tab

async function deepScorePeople(jdId, cards, version) {
  const resultsTab = await getTargetTab();
  const queue      = cards.slice(0, DEEP_MAX);
  const done   = [];   // scored, kept sorted best-first
  const failed = [];   // profile unreadable or scorer refused — listed without a score
  let read = 0;

  // The whole ranking is redrawn after every profile, so the list fills in as the
  // reads happen instead of sitting empty until the last one lands.
  const progress = (name) => {
    if (done.length || failed.length) renderPeopleResults(done, failed, queue.length, read, name);
    else showPeopleResults(`Reading profile ${read + 1} of ${queue.length}${name ? ` — ${name}` : ''}…`);
  };

  let worker = null;
  peopleRankBusy = true;
  try {
    for (const person of queue) {
      if (version !== peopleRankVersion) return;        // cancelled
      progress(person.name);

      // First profile creates the tab; the rest reuse it.
      if (!worker) worker = await openWorkerTab(person.url);
      else if (!(await navigateWorkerTab(worker, person.url))) worker = null;

      const wantSlug = person.slug || profileSlugOf(person.url);
      let profile = worker
        ? await withTimeout(askProfileWhenReady(worker, wantSlug), DEEP_VISIT_TIMEOUT).catch(() => null)
        : null;

      // Worker tab unavailable or the visit failed — server HTML is still better
      // than card text.
      if (!profile && resultsTab) profile = await fetchProfileViaPage(resultsTab.id, person.url);
      if (version !== peopleRankVersion) return;

      const score = profile ? await scoreProfile(jdId, profile) : null;
      if (version !== peopleRankVersion) return;

      // What the extraction actually came back with. An empty skills/experience
      // list here is why a score looks generic — check this before blaming the
      // scorer.
      console.log('[SCOUT] ranked', person.name,
        '— skills:',     profile?.skills?.length     || 0,
        'experience:',   profile?.experience?.length || 0,
        'education:',    profile?.education?.length  || 0,
        'years:',        profile?.experience_years   ?? '?',
        'score:',        score?.score ?? 'none');

      if (score) {
        done.push({
          ...person,
          ...score,
          title:    profile.title    || person.title,
          location: profile.location || person.location,
          // Kept so clicking the row can render the full card + breakdown from
          // memory — the profile was already read once, re-opening LinkedIn to
          // read it again would be pure waste.
          profile,
          scoreData: score,
        });
        done.sort((a, b) => b.score - a.score);
      } else {
        // Still listed, so the ranking accounts for everyone on the page rather
        // than silently dropping whoever couldn't be read.
        failed.push({ ...person, reason: profile ? 'scoring failed' : 'profile unreadable' });
      }
      read++;
      if (version !== peopleRankVersion) return;
      progress();
    }
  } finally {
    if (worker) chrome.tabs.remove(worker).catch(() => {});
    // Hand the recruiter back to the results page they started on before the
    // panel resumes reacting to tab changes. The nav search box still holds the
    // focus searchLinkedIn gave it, so clear that first — otherwise re-focusing
    // the tab pops the search typeahead open by itself.
    if (resultsTab) {
      await sendTabMessage(resultsTab.id, { action: 'dismissSearchUI' });
      await chrome.tabs.update(resultsTab.id, { active: true }).catch(() => {});
    }
    peopleRankBusy = false;
  }

  if (version !== peopleRankVersion) return;
  if (!done.length && !failed.length) {
    showPeopleResults('Could not read any of the profiles on this page.');
    return;
  }

  renderPeopleResults(done, failed, queue.length, read);
}

// Worker tab: foreground, so LinkedIn paints and its lazy sections actually load.
// Opened next to the results tab and closed when the walk ends.
async function openWorkerTab(url) {
  try {
    const tab = await chrome.tabs.create({ url, active: true });
    return tab.id;
  } catch (_) {
    return null;
  }
}

async function navigateWorkerTab(tabId, url) {
  try {
    await chrome.tabs.update(tabId, { url, active: true });
    return true;
  } catch (_) {
    return false;      // tab was closed by the user mid-run
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

function profileSlugOf(url) {
  return (String(url || '').match(/\/in\/([^/?#]+)/) || [])[1] || '';
}

// The content script auto-injects at document_idle, so early messages can land
// before it exists — retry, then inject it directly (same fallback as
// requestProfile uses for the foreground tab).
//
// The worker tab is reused, so a poll fired right after chrome.tabs.update can be
// answered by the PREVIOUS profile's content script, before the navigation
// commits. Every reply is checked against the slug being visited and a mismatch
// is treated as "not ready yet" — otherwise one candidate's score lands on the
// next candidate's row.
// A profile with no skills AND no roles scores as "matches nothing" — every such
// candidate lands on the same low number. That is an extraction miss, not a real
// verdict, so it is never accepted on the first look.
function profileHasSignal(p) {
  return !!p && ((p.skills || []).length > 0 || (p.experience || []).length > 0);
}

function waitForTabComplete(tabId, ms = 15000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const poll = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') return resolve(true);
      } catch (_) { return resolve(false); }   // tab closed
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, 250);
    };
    poll();
  });
}

// The content script auto-injects at document_idle, so early messages can land
// before it exists — retry, then inject it directly (same fallback as
// requestProfile uses for the foreground tab).
//
// Two traps, both of which produce a wrong score rather than an obvious failure:
//  1. The worker tab is reused, so a poll fired right after chrome.tabs.update can
//     be answered by the PREVIOUS profile's content script. Replies are matched
//     against the slug being visited.
//  2. The URL flips to the new profile before its DOM exists, so a poll that wins
//     that race gets a slug-correct but EMPTY profile — which the scorer reads as
//     "no skills" and rates low. Hence: wait for load, then require real content,
//     and force a re-extract (the cached run is discarded) if the first is thin.
async function askProfileWhenReady(tabId, wantSlug) {
  const isWanted = (p) => p && (!wantSlug || profileSlugOf(p.profileUrl || p.url) === wantSlug);

  await waitForTabComplete(tabId);

  let lastWanted = null;
  for (let i = 0; i < 24; i++) {                        // ~12s of tries
    // After a few thin reads, re-run the extraction from scratch instead of
    // getting the same cached empty result back.
    const force = i > 0 && i % 6 === 0;
    const res = await sendTabMessage(tabId, { action: 'getProfile', quiet: true, force });
    const p = res?.profile;
    if (isWanted(p)) {
      lastWanted = p;
      if (profileHasSignal(p)) return p;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (lastWanted) return lastWanted;   // genuinely sparse profile — score what's there

  try {
    await chrome.scripting.executeScript({
      target: { tabId }, files: ['content_scripts/linkedin.js'],
    });
  } catch (_) {
    return null;
  }
  await new Promise(r => setTimeout(r, 500));
  const res = await sendTabMessage(tabId, { action: 'getProfile', quiet: true });
  return isWanted(res?.profile) ? res.profile : null;
}

// Fallback read: asks the results page to fetch and parse a profile in-page.
// Same-origin so the session rides along, but the Skills section is
// client-rendered and therefore absent — skills get keyword-scanned instead.
// A hung fetch resolves null rather than stalling the batch.
async function fetchProfileViaPage(tabId, url) {
  const res = await Promise.race([
    sendTabMessage(tabId, { action: 'fetchProfileLite', url }),
    new Promise(resolve => setTimeout(() => resolve(null), DEEP_FETCH_TIMEOUT)),
  ]);
  return res?.profile || null;
}

function sendTabMessage(tabId, msg) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, msg, (r) => {
      void chrome.runtime.lastError;   // not injected yet / tab navigating
      resolve(r);
    });
  });
}

// Scores a fetched profile: same GET_SCORE call the panel makes for a single
// candidate, now with real skills, roles and tenure instead of card text.
function scoreProfile(jdId, profile) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(
      { type: 'GET_SCORE', payload: {
        jd_id: jdId,
        candidate: profile,
        resume_text: profile.resumeText || undefined,
      } },
      (res) => {
        void chrome.runtime.lastError;
        resolve(res?.ok ? res.data : null);
      }
    );
  });
}

// The top PEOPLE_TOP_N candidates are listed, best score first. The rest — and the
// ones that couldn't be read — are behind the "Show all" row. `read` < `total`
// means the walk is still going, so the list is labelled as running standings
// rather than the final answer.
function renderPeopleResults(scored, failed, total, read, reading) {
  lastPeopleRender = { scored, failed, total, read, reading };

  const partial = read < total;
  const missed  = failed.length ? ` · ${failed.length} unread` : '';
  const shown   = peopleShowAll ? scored : scored.slice(0, PEOPLE_TOP_N);
  const hidden  = scored.length - shown.length;

  showPeopleResults(partial
    ? `Read ${read}/${total} — top ${shown.length} so far${missed}${reading ? `, reading ${reading}…` : '…'}`
    : (scored.length > shown.length
        ? `Top ${shown.length} of ${scored.length} scored from each full profile${missed}.`
        : `All ${scored.length} of ${total} scored from each full profile${missed}.`));
  peopleResultsList.innerHTML = '';

  shown.forEach((p, i) => {
    const cls = p.score >= 80 ? 'excellent' : p.score >= 65 ? 'good' : p.score >= 45 ? 'fair' : 'poor';
    peopleResultsList.appendChild(peopleRow(p, {
      rank:  i + 1,
      top:   i === 0,
      badge: `<span class="bestfit-score ${cls}">${p.score}</span>`,
    }));
  });

  // Unread candidates are only worth screen space once the shortlist is out of
  // the way — they have no score to rank by.
  if (peopleShowAll) {
    failed.forEach((p) => {
      peopleResultsList.appendChild(peopleRow(p, {
        badge: '<span class="bestfit-score unread" title="' + escapeHtml(p.reason || 'not scored') + '">—</span>',
        muted: true,
      }));
    });
  }

  const rest = hidden + (peopleShowAll ? 0 : failed.length);
  if (rest > 0 || peopleShowAll) {
    peopleResultsList.appendChild(peopleMoreRow(rest));
  }
}

// Expand/collapse the list back to the top PEOPLE_TOP_N. Redraws from the last
// render — the walk is never re-run.
function peopleMoreRow(rest) {
  const row = document.createElement('div');
  row.className = 'bestfit-row people-row-more';
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-expanded', String(peopleShowAll));
  row.textContent = peopleShowAll ? `Show top ${PEOPLE_TOP_N} only` : `Show all ${rest} more`;

  const toggle = () => {
    peopleShowAll = !peopleShowAll;
    if (lastPeopleRender) {
      const { scored, failed, total, read, reading } = lastPeopleRender;
      renderPeopleResults(scored, failed, total, read, reading);
    }
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  return row;
}

function peopleRow(p, { rank, top, badge, muted } = {}) {
  const slug = p.slug || profileSlugOf(p.url);
  const row = document.createElement('div');
  // The list is redrawn after every profile the walk reads, so "which row am I
  // looking at" is held by slug, not by the DOM node.
  row.className = 'bestfit-row' + (top ? ' top' : '') + (muted ? ' unread' : '') +
    (slug && slug === selectedRankSlug ? ' active' : '');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  // Rows with a stored profile open in the panel; unread ones have nothing to
  // show, so they still go to LinkedIn.
  row.title = p.profile
    ? `Show ${p.name} in the panel  (Ctrl/⌘-click or middle-click to open on LinkedIn)`
    : `Open ${p.name}'s profile on LinkedIn`;

  row.dataset.slug = slug;
  const sub = [p.title, p.location].filter(Boolean).join(' · ');
  row.innerHTML =
    `<span class="people-row-rank">${rank ? rank : ''}</span>` +
    badge +
    `<span class="bestfit-title">` +
      `<span class="people-row-name">${escapeHtml(p.name)}</span>` +
      `<span class="people-row-sub">${escapeHtml(sub)}</span>` +
    `</span>`;

  // Opens in a new tab so the ranked list (and the results page) survive.
  const openTab = () => chrome.tabs.create({ url: p.url });
  const activate = () => { if (p.profile) showRankedCandidate(p); else openTab(); };

  row.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) { openTab(); return; }
    activate();
  });
  // Middle-click is the browser's "open in background tab" gesture — keep it.
  row.addEventListener('auxclick', (e) => {
    if (e.button === 1) { e.preventDefault(); openTab(); }
  });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
  });
  return row;
}

// Show an already-ranked candidate in the panel: the profile and its score were
// both captured during the walk, so this is a pure re-render — no tab, no second
// read of LinkedIn. The ranked list stays on screen so the recruiter can page
// through candidates from it.
function showRankedCandidate(entry) {
  candidate        = entry.profile;
  currentScore     = entry.scoreData;
  profilePending   = false;
  lastProfileSlug  = entry.slug || profileSlugOf(entry.url);
  selectedRankSlug = lastProfileSlug;

  // Switching candidates invalidates any in-flight score for the previous one.
  scoreVersion++;

  mainView.style.display   = '';
  emptyView.style.display  = 'none';
  jdSearchSection.style.display = 'none';
  matchSection.style.display    = 'block';
  sourceBadge.textContent  = 'LinkedIn';
  statusEl.classList.remove('show');
  refreshBtn.classList.remove('spinning');

  // The card's JD dropdown should read as the JD this ranking ran against.
  if (selectedJd) jdSelect.value = selectedJd;

  renderProfile(candidate);
  renderScore(currentScore);
  saveLastProfile();

  [...peopleResultsList.children].forEach(el => el.classList.remove('active'));
  const active = [...peopleResultsList.children]
    .find(el => el.dataset.slug === selectedRankSlug);
  if (active) active.classList.add('active');

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Score ─────────────────────────────────────────────────────────────────────

function requestScore(jdId) {
  scoreVersion++;
  const version = scoreVersion;

  addBtn.disabled = true;
  scoreCard.classList.remove('show');
  // Wipe the previous JD's breakdown so nothing stale shows during the re-score.
  if (scoreBreakdown) scoreBreakdown.innerHTML = '';
  if (skillLists)     skillLists.innerHTML = '';
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
  // Drives the conic-gradient progress ring in popup.css.
  scoreCircle.style.setProperty('--pct', Math.max(0, Math.min(100, Number(score) || 0)));

  renderBreakdown(data.categories);
  renderSkillLists(data.categories);

  scoreCard.classList.add('show');
  resumeUpload.style.display = 'block';
  addBtn.disabled = false;
  resetAddButton();
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

  // Collapsible so the score + rationale stay above the fold on short panels.
  scoreBreakdown.innerHTML =
    `<details class="report-section" open>` +
      `<summary class="report-summary">Category Breakdown</summary>` +
      `<div class="report-body">${rows}</div>` +
    `</details>`;
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
  skillLists.innerHTML =
    `<details class="report-section" open>` +
      `<summary class="report-summary">Skills</summary>` +
      `<div class="report-body">${html}</div>` +
    `</details>`;
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

// Dismiss the results panel — the button stays available to re-run the check.
bestfitClose.addEventListener('click', () => {
  bestfit.style.display = 'none';
  bestfitList.innerHTML = '';
  bestfitStatus.textContent = '';
});

function renderBestFit(list) {
  if (!list || !list.length) { bestfitStatus.textContent = 'No JDs scored.'; return; }
  const best = list[0];
  bestfitStatus.innerHTML =
    `Best fit: <strong>${escapeHtml(best.title)}</strong> — ${best.score}/100 (${escapeHtml(best.label)})`;

  bestfitList.innerHTML = '';
  list.slice(0, 3).forEach((jd, i) => {
    const cls = jd.score >= 80 ? 'excellent' : jd.score >= 65 ? 'good' : jd.score >= 45 ? 'fair' : 'poor';
    const label = jd.title + (jd.client ? ' · ' + jd.client : '');
    const row = document.createElement('div');
    row.className = 'bestfit-row' + (i === 0 ? ' top' : '');
    // Rows act as buttons — reachable by keyboard, not just mouse.
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.title = `Score ${label}`;
    row.innerHTML =
      `<span class="bestfit-score ${cls}">${jd.score}</span>` +
      `<span class="bestfit-title">${escapeHtml(label)}</span>`;
    // Click a row → select that JD in the dropdown and score it normally.
    const pick = () => {
      jdSelect.value = jd.id;
      jdSelect.dispatchEvent(new Event('change'));
    };
    row.addEventListener('click', pick);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
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
