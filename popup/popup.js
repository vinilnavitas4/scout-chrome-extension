const profileCard    = document.getElementById('profile-card');
const profileName    = document.getElementById('profile-name');
const profileTitle   = document.getElementById('profile-title');
const profileLoc     = document.getElementById('profile-location');
const profileExp     = document.getElementById('profile-exp');
const profileEmail   = document.getElementById('profile-email');
const profilePhone   = document.getElementById('profile-phone');
const sourceBadge    = document.getElementById('source-badge');
const jdSelect       = document.getElementById('jd-select');
const jdSpinner      = document.getElementById('jd-spinner');
const scoreCard      = document.getElementById('score-card');
const scoreCircle    = document.getElementById('score-circle');
const scoreNumber    = document.getElementById('score-number');
const scoreLabel     = document.getElementById('score-label');
const scoreRationale = document.getElementById('score-rationale');
const addBtn         = document.getElementById('add-btn');
const jazzhrBtn      = document.getElementById('jazzhr-btn');
const statusEl       = document.getElementById('status');
const mockDuplicate  = document.getElementById('mock-duplicate');
const resumeUpload   = document.getElementById('resume-upload');
const resumeFile     = document.getElementById('resume-file');
const resumeName     = document.getElementById('resume-name');
const resumeClear    = document.getElementById('resume-clear');
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
  if (!tab || !(tab.url || '').includes('linkedin.com/in/')) return;

  loadJds(selectedJd, true);   // re-fetch JD list + clear SW description cache, keep selection
  startScan(tab.id, true);     // force = bypass content-script extraction cache
});

let candidate       = null;   // set when profile fetch completes
let selectedJd      = null;
let selectedJdTitle = null;
let currentScore    = null;
let profilePending  = true;   // true while profile fetch is in flight
let scoreVersion    = 0;      // incremented on each new score request to discard stale AI responses
let modelReady      = false;  // true once offscreen ML model finishes loading
let resumeB64       = '';     // base64-encoded resume file if recruiter attached one
let addedApplicantId = null;  // JazzHR prospect_id set after successful add
let callPollTimer    = null;  // setInterval id for call-status polling

// ── Resume file picker ────────────────────────────────────────────────────────

resumeFile.addEventListener('change', () => {
  const file = resumeFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    resumeB64 = e.target.result.split(',')[1] || '';
    resumeName.textContent = file.name;
    resumeClear.style.display = 'inline';
  };
  reader.readAsDataURL(file);
});

resumeClear.addEventListener('click', () => {
  resumeB64 = '';
  resumeFile.value = '';
  resumeName.textContent = 'No file chosen';
  resumeClear.style.display = 'none';
});

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

// Canonical profile identity. Full-URL comparison loops: the extraction visits
// /details/skills and /overlay/contact-info sub-routes, which fire tabs.onUpdated
// and must not count as a new profile.
function profileSlug(url) {
  const m = (url || '').match(/linkedin\.com\/in\/([^\/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function startScan(tabId, force = false) {
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

  requestProfile(tabId, 'content_scripts/linkedin.js', force);
}

// Sync panel to the active tab: empty state off LinkedIn, auto-scan when a
// (new) profile is showing. Runs at open and on every tab switch/navigation.
async function handleActiveTab() {
  const tab = await getTargetTab();
  if (!tab) return;
  const slug = profileSlug(tab.url);
  const onProfile = !!slug;

  mainView.style.display  = onProfile ? '' : 'none';
  emptyView.style.display = onProfile ? 'none' : 'block';
  if (!onProfile) return;

  sourceBadge.textContent = 'LinkedIn';
  matchSection.style.display = 'block';

  if (slug !== lastProfileSlug) {
    lastProfileSlug = slug;
    startScan(tab.id);
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

  if (p.email) {
    profileEmail.textContent = p.email;
    profileEmail.href = `mailto:${p.email}`;
    profileEmail.style.display = 'block';
  } else {
    profileEmail.style.display = 'none';
  }
  if (p.phone) {
    profilePhone.textContent = p.phone;
    profilePhone.href = `tel:${p.phone.replace(/[^\d+]/g, '')}`;
    profilePhone.style.display = 'block';
  } else {
    profilePhone.style.display = 'none';
  }

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
  showStatus(modelReady ? 'Matching profile to JD…' : 'Loading AI model (first time only)…', 'loading');

  chrome.runtime.sendMessage(
    { type: 'GET_SCORE', payload: { jd_id: jdId, candidate } },
    (res) => {
      if (version !== scoreVersion) return; // stale — user changed JD
      statusEl.classList.remove('show');
      if (!res?.ok) { showStatus('Score failed — ' + (res?.error || 'unknown error'), 'error'); return; }
      currentScore = res.data;
      renderScore(currentScore);
    }
  );
}

function renderScore(data) {
  const { score, label, rationale } = data;
  scoreNumber.textContent    = score;
  scoreLabel.textContent     = label;
  scoreRationale.textContent = rationale;

  scoreCircle.className = 'score-circle';
  if      (score >= 80) scoreCircle.classList.add('excellent');
  else if (score >= 65) scoreCircle.classList.add('good');
  else if (score >= 45) scoreCircle.classList.add('fair');
  else                  scoreCircle.classList.add('poor');

  scoreCard.classList.add('show');
  resumeUpload.style.display = 'block';
  addBtn.disabled = false;
  resetAddButton();
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

  const payload = {
    job_id:    selectedJd,
    resume_b64: resumeB64 || undefined,
    candidate: {
      name:             candidate.name,
      title:            candidate.title,
      location:         candidate.location,
      skills:           candidate.skills,
      experience_years: candidate.experience_years,
      profileUrl:       candidate.profileUrl,
      email:            candidate.email      || '',
      phone:            candidate.phone      || '',
      experience:       candidate.experience || [],
      about:            candidate.about      || '',
      education:        candidate.education  || [],
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

  const phone = candidate?.phone || '';
  if (!phone) {
    vapiPhoneRow.style.display  = 'block';
    vapiPhoneInput.value        = '';
    vapiBtn.textContent         = '📞 Call with AI';
    vapiBtn.disabled            = true;  // enabled once number typed
    vapiPhoneInput.addEventListener('input', () => {
      vapiBtn.disabled = vapiPhoneInput.value.trim().length < 7;
    }, { once: false });
  } else {
    vapiPhoneRow.style.display = 'none';
    vapiBtn.disabled           = false;
    vapiBtn.textContent        = '📞 Call with AI';
  }
}

vapiBtn.addEventListener('click', async () => {
  if (!candidate || !addedApplicantId || !selectedJd) return;

  const phone = (candidate.phone || vapiPhoneInput?.value || '').trim();
  if (!phone) {
    vapiStatusEl.textContent   = 'Enter a phone number above.';
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className   = `status ${type} show`;
}
