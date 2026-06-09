const profileCard   = document.getElementById('profile-card');
const profileName   = document.getElementById('profile-name');
const profileTitle  = document.getElementById('profile-title');
const profileLoc    = document.getElementById('profile-location');
const profileExp    = document.getElementById('profile-exp');
const sourceBadge   = document.getElementById('source-badge');
const jdSelect      = document.getElementById('jd-select');
const addBtn        = document.getElementById('add-btn');
const statusEl      = document.getElementById('status');
const mockDuplicate = document.getElementById('mock-duplicate');
const mainView      = document.getElementById('main-view');
const emptyView     = document.getElementById('empty-view');

let candidate       = null;
let selectedJd      = null;
let selectedJdTitle = null;

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

  showStatus('Reading profile…', 'loading');

  chrome.tabs.sendMessage(tab.id, { action: 'getProfile' }, (response) => {
    if (chrome.runtime.lastError || !response?.profile) {
      showStatus('Could not read profile. Refresh the page and try again.', 'error');
      return;
    }
    candidate = response.profile;
    renderProfile(candidate);
    loadJds();
    statusEl.classList.remove('show');
  });
});

// ── Profile card ──────────────────────────────────────────────────────────────

function renderProfile(p) {
  profileName.textContent  = p.name     || '—';
  profileTitle.textContent = p.title    || '—';
  profileLoc.textContent   = p.location || '—';
  profileExp.textContent   = p.experience_years != null ? `${p.experience_years} yrs exp` : '';
  profileCard.classList.add('show');
}

// ── JD dropdown ───────────────────────────────────────────────────────────────

function loadJds() {
  chrome.runtime.sendMessage({ type: 'GET_JDS' }, (res) => {
    if (!res?.ok) { showStatus('Failed to load jobs.', 'error'); return; }
    res.data.forEach(jd => {
      const opt = document.createElement('option');
      opt.value = jd.id;
      opt.dataset.title = jd.title;
      opt.textContent = `${jd.title} · ${jd.client}`;
      jdSelect.appendChild(opt);
    });
  });
}

jdSelect.addEventListener('change', () => {
  const jdId = jdSelect.value;
  if (!jdId) {
    addBtn.disabled = true;
    return;
  }
  selectedJd      = jdId;
  selectedJdTitle = jdSelect.selectedOptions[0]?.dataset.title || jdId;
  addBtn.disabled = false;
  resetAddButton();
});

// ── Add to SCOUT ──────────────────────────────────────────────────────────────

addBtn.addEventListener('click', () => {
  if (mockDuplicate.checked) { renderDuplicateState(); return; }

  const payload = {
    source:   candidate.source,
    jd_id:    selectedJd,
    jd_title: selectedJdTitle,
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
      openToWork:       candidate.openToWork || false
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
      showStatus(res?.error || 'Failed to save.', 'error');
      addBtn.disabled = false;
    }
  });
});

// ── Mock: duplicate state ─────────────────────────────────────────────────────

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
