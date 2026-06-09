const profileCard    = document.getElementById('profile-card');
const profileName    = document.getElementById('profile-name');
const profileTitle   = document.getElementById('profile-title');
const profileLoc     = document.getElementById('profile-location');
const profileExp     = document.getElementById('profile-exp');
const sourceBadge    = document.getElementById('source-badge');
const jdSelect       = document.getElementById('jd-select');
const jdSpinner      = document.getElementById('jd-spinner');
const scoreCard      = document.getElementById('score-card');
const scoreCircle    = document.getElementById('score-circle');
const scoreNumber    = document.getElementById('score-number');
const scoreLabel     = document.getElementById('score-label');
const scoreRationale = document.getElementById('score-rationale');
const addBtn         = document.getElementById('add-btn');
const statusEl       = document.getElementById('status');
const mockDuplicate  = document.getElementById('mock-duplicate');
const mainView       = document.getElementById('main-view');
const emptyView      = document.getElementById('empty-view');

let candidate       = null;
let selectedJd      = null;
let selectedJdTitle = null;
let currentScore    = null;

// ── Init ──────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab.url || '';

  const onDice     = url.includes('dice.com');
  const onLinkedIn = url.includes('linkedin.com/in/');

  if (!onDice && !onLinkedIn) {
    mainView.style.display = 'none';
    emptyView.style.display = 'block';
    return;
  }

  sourceBadge.textContent = onDice ? 'Dice.com' : 'LinkedIn';
  if (onDice) sourceBadge.classList.add('dice');

  // Load profile and jobs in parallel
  const script = onDice ? 'content_scripts/dice.js' : 'content_scripts/linkedin.js';
  requestProfile(tab.id, script);

  loadJds();
});

// ── Profile loading (with auto-inject fallback) ───────────────────────────────

function requestProfile(tabId, scriptFile) {
  chrome.tabs.sendMessage(tabId, { action: 'getProfile' }, (response) => {
    if (chrome.runtime.lastError || !response?.profile) {
      // Content script not in this tab yet — inject it now, then retry once
      chrome.scripting.executeScript(
        { target: { tabId }, files: [scriptFile] },
        () => {
          if (chrome.runtime.lastError) {
            renderProfile(null);
            showStatus('Could not inject script. Try refreshing the page.', 'error');
            return;
          }
          // Give the script a moment to register its listener
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { action: 'getProfile' }, (res2) => {
              if (chrome.runtime.lastError || !res2?.profile) {
                renderProfile(null);
                showStatus('Could not read profile. Try refreshing the page.', 'error');
                return;
              }
              candidate = res2.profile;
              renderProfile(candidate);
              // If JD was already selected before profile loaded, score now
              if (selectedJd) requestScore(selectedJd);
            });
          }, 300);
        }
      );
      return;
    }
    candidate = response.profile;
    renderProfile(candidate);
    if (selectedJd) requestScore(selectedJd);
  });
}

// ── Profile card ──────────────────────────────────────────────────────────────

function renderProfile(p) {
  if (!p) return; // keep card hidden on failure
  profileName.textContent  = p.name     || '—';
  profileTitle.textContent = p.title    || '';
  profileLoc.textContent   = p.location || '';
  profileExp.textContent   = p.experience_years != null ? `${p.experience_years} yrs exp` : '';
  profileCard.classList.add('show');
}

// ── JD dropdown ───────────────────────────────────────────────────────────────

function loadJds() {
  jdSpinner.classList.add('show');
  jdSelect.disabled = true;

  chrome.runtime.sendMessage({ type: 'GET_JDS' }, (res) => {
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
  });
}

jdSelect.addEventListener('change', () => {
  const jdId = jdSelect.value;
  if (!jdId) {
    scoreCard.classList.remove('show');
    addBtn.disabled = true;
    currentScore = null;
    return;
  }
  selectedJd      = jdId;
  selectedJdTitle = jdSelect.selectedOptions[0]?.dataset.title || jdId;

  // Only score once we have the candidate profile
  if (candidate) {
    requestScore(jdId);
  }
});

// ── Score ─────────────────────────────────────────────────────────────────────

function requestScore(jdId) {
  addBtn.disabled = true;
  scoreCard.classList.remove('show');
  showStatus('Scoring…', 'loading');

  chrome.runtime.sendMessage(
    { type: 'GET_SCORE', payload: { jd_id: jdId, candidate } },
    (res) => {
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
  addBtn.disabled = false;
  resetAddButton();
}

// ── Add to SCOUT → backend API ────────────────────────────────────────────────

addBtn.addEventListener('click', () => {
  if (mockDuplicate.checked) { renderDuplicateState(); return; }

  const payload = {
    job_id: selectedJd,
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
  showStatus('Adding to SCOUT…', 'loading');

  chrome.runtime.sendMessage({ type: 'ADD_CANDIDATE', payload }, (res) => {
    statusEl.classList.remove('show');
    if (res?.ok) {
      addBtn.textContent = 'Added to SCOUT ✓';
      addBtn.className   = 'btn btn-success';
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className   = `status ${type} show`;
}
