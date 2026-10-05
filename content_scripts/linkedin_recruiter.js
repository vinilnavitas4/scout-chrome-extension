// LinkedIn Recruiter Lite profile parser — /talent/.../profile/<id>, both the
// full-page profile and the slide-in drawer opened from a pipeline / search.
// Recruiter is a separate app from /in/ profiles (Ember, data-test-* hooks), so
// none of linkedin.js's selectors apply. Loaded in the same content_scripts
// entry as linkedin.js and shares its globals: calcExperienceYears,
// EMPLOYMENT_TYPES, cleanSkillRow, cleanEmail, cleanPhone, detectClearance,
// mineSkillsAndClearance, requestPanelOpen. Entry point is runExtraction() in
// linkedin.js, which hands off here when the URL is a Recruiter profile.

// Recruiter's per-candidate id — the last path segment of every profile route:
//   /talent/profile/<id>
//   /talent/hire/<project>/manage/all/profile/<id>
//   /talent/hire/<project>/discover/recruiterSearch/profile/<id>
//   /talent/hire/<project>/discover/automatedSourcing/review/profile/<id>
function recruiterProfileId(url) {
  const m = (url || '').match(/linkedin\.com\/talent\/(?:[^?#]*\/)?profile\/([^\/?#]+)/i);
  return m ? m[1] : '';
}

// The profile body. The drawer and the full page render the same container; the
// drawer wins when both exist (a full-page profile can sit underneath one).
function recruiterRoot() {
  return document.querySelector('.profile-slidein__wrapper [data-test-profile-container]')
    || document.querySelector('[data-test-profile-container]');
}

function rlText(el) {
  return ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
}

// Multi-line text (role descriptions, summary) — innerText keeps the line
// breaks listedSkillsFromText() relies on to end a skill list.
function rlBlockText(el) {
  if (!el) return '';
  return (el.innerText || el.textContent || '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Position fields exist in two flavours: a standalone role
// (data-test-position-entity-*) and a role inside a multi-role company card
// (data-test-grouped-position-entity-*).
function rlPositionField(scope, field) {
  return scope.querySelector(
    `[data-test-position-entity-${field}], [data-test-grouped-position-entity-${field}]`
  );
}

// Wait for the profile to render. On drawer pagination the URL changes before
// the drawer re-renders, so "a name is present" isn't enough — also require the
// content to stop changing, and to differ from the previous candidate's.
let rlLastSignature = '';
let rlLastSignatureId = '';
async function waitForRecruiterProfile(id, maxMs = 10000) {
  const start = Date.now();
  let lastLen = -1;
  let stable = 0;
  while (Date.now() - start < maxMs) {
    const root = recruiterRoot();
    const name = root && rlText(root.querySelector(
      '[data-test-topcard-condensed-lockup] [data-test-row-lockup-full-name]'));
    const bodyReady = root && root.querySelector(
      '[data-test-profile-background-card], [data-test-profile-skills-card], [data-test-profile-summary-card]');
    if (name && bodyReady) {
      const sig = recruiterSignature(root);
      // Same candidate as the last scan under a new id → drawer not swapped yet.
      // Give it 4s, then accept (it may really be the same person re-opened).
      const stale = id !== rlLastSignatureId && sig === rlLastSignature && Date.now() - start < 4000;
      const len = root.textContent.length;
      stable = (len === lastLen) ? stable + 1 : 0;
      lastLen = len;
      if (!stale && stable >= 2) return root;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return recruiterRoot();
}

function recruiterSignature(root) {
  return rlText(root.querySelector('[data-test-topcard-condensed-lockup] [data-test-row-lockup-full-name]')) +
    '|' + (root.querySelector('[data-test-personal-info-profile-link]')?.getAttribute('href') || '');
}

// Experience shows a few roles and Skills shows 3 until "Show all N ..." is
// clicked; each role's skill tags sit behind their own "Show all N details".
// All expand in place (no navigation). Returns true if the Skills list was
// expanded, so the caller can fold it back afterwards.
async function expandRecruiterSections(root) {
  const collapsed = (card) => Array.from(root.querySelectorAll(
    `${card} [data-test-expandable-button][aria-expanded="false"]`));
  let skillsExpanded = false;
  for (let pass = 0; pass < 3; pass++) {
    const skillBtns = collapsed('[data-test-profile-skills-card]');
    const buttons = collapsed('[data-test-profile-background-card]').concat(skillBtns);
    if (!buttons.length) break;
    if (skillBtns.length) skillsExpanded = true;
    for (const b of buttons) {
      try { b.click(); } catch (_) { /* detached node */ }
    }
    await new Promise(r => setTimeout(r, 700));
  }
  return skillsExpanded;
}

// Fold the Skills list back so the recruiter isn't left with a page of 100+
// skill rows. Experience stays expanded — that's content they read anyway.
function collapseRecruiterSkills(root) {
  const open = Array.from(root.querySelectorAll(
    '[data-test-profile-skills-card] [data-test-expandable-button][aria-expanded="true"]'));
  // Outer "Show fewer" last-in-DOM collapses the whole list; clicking it alone
  // is enough and avoids toggling per-skill detail rows.
  const btn = open[open.length - 1];
  if (btn) { try { btn.click(); } catch (_) { /* detached node */ } }
}

// Return the profile to its top. Expanding/collapsing sections moves the
// viewport, and the profile scrolls inside its own container (the drawer, or a
// page wrapper) rather than the window — so reset every scrollable ancestor.
function scrollRecruiterToTop(root) {
  for (let el = root; el; el = el.parentElement) {
    if (el.scrollTop) el.scrollTop = 0;
  }
  window.scrollTo(0, 0);
}

// "Contract" / "Full-time" as Recruiter prints it next to the company name,
// normalized to the canonical labels isFullTimeRole() tests against.
function rlEmploymentType(raw) {
  const s = (raw || '').trim();
  if (!s || !EMPLOYMENT_TYPE_EXACT_RE.test(s)) return '';
  const key = s.toLowerCase().replace(/\s/g, '-');
  return EMPLOYMENT_TYPES.find(t => t.toLowerCase() === key) || s;
}

function rlReadRole(scope, fallbackCompany, fallbackType) {
  const title = rlText(rlPositionField(scope, 'title'));
  if (!title) return null;

  const companyName = rlText(rlPositionField(scope, 'company-link')) ||
    // "JPMorganChase · Contract" — keep the company, drop the employment type.
    rlText(rlPositionField(scope, 'company-name'))
      .split('·').map(s => s.trim()).filter(s => s && !EMPLOYMENT_TYPE_EXACT_RE.test(s)).join(' · ');
  const employmentType =
    rlEmploymentType(rlText(rlPositionField(scope, 'employment-status'))) || fallbackType || '';

  // "Feb 2024 – Present · 2 yrs 9 mos" — the same line shape /in/ profiles
  // print, which calcExperienceYears() sums the durations from.
  const dates = [rlText(rlPositionField(scope, 'date-range')), rlText(rlPositionField(scope, 'duration'))]
    .filter(Boolean).join(' · ');

  // Description + the role's skill tags, so the text miners see both.
  const roleSkills = Array.from(scope.querySelectorAll('[data-test-position-skill-item]'))
    .map(rlText).filter(Boolean);
  const description = [
    rlBlockText(rlPositionField(scope, 'description')),
    roleSkills.length ? `Skills: ${roleSkills.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  return {
    role: { title, company: companyName || fallbackCompany || '', dates, description, employmentType },
    roleSkills,
  };
}

function extractRecruiterExperience(root) {
  const experience = [];
  const roleSkills = [];
  const push = (r) => { if (r) { experience.push(r.role); roleSkills.push(...r.roleSkills); } };

  for (const item of root.querySelectorAll('[data-test-position-list-container]')) {
    // Multi-role company card: one container, several grouped positions. The
    // company (and sometimes the employment type) is printed once on the card.
    const groupedTitles = Array.from(item.querySelectorAll('[data-test-grouped-position-entity-title]'));
    if (groupedTitles.length) {
      const company = rlText(item.querySelector(
        '[data-test-grouped-position-entity-company-link], [data-test-grouped-position-entity-company-name], ' +
        '[data-test-position-entity-company-link]'));
      const groupType = rlEmploymentType(rlText(item.querySelector(
        '[data-test-grouped-position-entity-employment-status], [data-test-position-entity-employment-status]')));
      for (const t of groupedTitles) {
        // Smallest ancestor holding this one role: stop before it would take in
        // a sibling role's title.
        let scope = t.parentElement;
        while (scope && scope !== item && scope.parentElement &&
          scope.parentElement.querySelectorAll('[data-test-grouped-position-entity-title]').length === 1) {
          scope = scope.parentElement;
        }
        push(rlReadRole(scope || item, company, groupType));
      }
    } else {
      push(rlReadRole(item));
    }
  }

  // Grouped roles rendered outside any position-list container.
  const seenTitles = root.querySelectorAll(
    '[data-test-position-list-container] [data-test-grouped-position-entity-title]').length;
  const allGrouped = root.querySelectorAll('[data-test-grouped-position-entity-title]');
  if (allGrouped.length > seenTitles) {
    for (const t of allGrouped) {
      if (t.closest('[data-test-position-list-container]')) continue;
      push(rlReadRole(t.closest('li') || t.parentElement));
    }
  }

  return { experience, roleSkills };
}

function extractRecruiterEducation(root) {
  const education = [];
  for (const item of root.querySelectorAll('[data-test-education-item]')) {
    const school = rlText(item.querySelector('[data-test-education-entity-school-name]'));
    if (!school) continue;
    const degree = [
      rlText(item.querySelector('[data-test-education-entity-degree-name]')),
      rlText(item.querySelector('[data-test-education-entity-field-of-study]')),
    ].filter(Boolean).join(', ');
    const dates = rlText(item.querySelector('[data-test-education-entity-dates]'));
    education.push({ school, degree, dates });
  }
  return education;
}

// Certifications live in the "Accomplishments" card, which Recruiter hides
// (accomplishments--hidden) when the candidate has none. Best-effort: the card
// carries no per-field data-test hooks we've confirmed, so rows are read by
// their text lines — name, issuer, then the line carrying a year.
function extractRecruiterCertifications(root) {
  const certs = [];
  const card = root.querySelector('section[class*="accomplishments"]:not([class*="accomplishments--hidden"])');
  if (!card) return certs;
  const heading = Array.from(card.querySelectorAll('h3, h4, h5, dt, button, span'))
    .find(h => /^(?:licenses?\s*(?:&|and)\s*)?certifications?\b/i.test(rlText(h)));
  if (!heading) {
    console.log('[SCOUT] Recruiter: Accomplishments card has no Certifications block');
    return certs;
  }
  // Nearest ancestor of the heading that holds list rows.
  let block = heading.parentElement;
  while (block && block !== card && !block.querySelector('li')) block = block.parentElement;
  for (const li of (block || card).querySelectorAll('li')) {
    const lines = rlBlockText(li).split('\n').map(s => s.trim()).filter(Boolean);
    const name = lines[0] || '';
    if (!name || /^show (?:all|more|fewer)/i.test(name)) continue;
    const dates = lines.slice(1).find(l => /issued|expires|\b(?:19|20)\d{2}\b/i.test(l)) || '';
    const issuer = lines.slice(1).find(l => l !== dates) || '';
    certs.push({ name, issuer, dates });
  }
  console.log(`[SCOUT] Recruiter: ${certs.length} certification(s) read from Accomplishments`);
  return certs;
}

function extractRecruiterProfile(root) {
  const topcard = root.querySelector('[data-test-topcard-condensed-lockup]') || root;

  // Read name/headline from the topcard only — "Similar profiles" and the
  // shared-connections list reuse the same lockup hooks.
  const name = rlText(topcard.querySelector('[data-test-row-lockup-full-name]'));
  const title = rlText(topcard.querySelector('[data-test-row-lockup-headline]'));
  const location = rlText(topcard.querySelector('[data-test-row-lockup-location]')).replace(/^[·•\s]+/, '');

  // Contact info shows only when the candidate shared it (applicants, or added
  // by the recruiter); otherwise the row is an "Add email" button.
  const email = cleanEmail(rlText(root.querySelector('[data-test-contact-email-address]')));
  const phone = cleanPhone(rlText(root.querySelector('[data-test-contact-phone]')));

  // Public /in/<slug> link from the Personal Information card — canonicalized
  // so the backend gets the same linkedin_url as for a regular LinkedIn scan.
  const publicHref = root.querySelector('[data-test-personal-info-profile-link]')?.getAttribute('href') || '';
  const slug = (publicHref.match(/linkedin\.com\/in\/([^\/?#]+)/i) || [])[1] || '';
  const profileUrl = slug ? `https://www.linkedin.com/in/${slug}/` : '';

  const about = rlBlockText(root.querySelector('[data-test-summary-card-text]'));
  const { experience, roleSkills } = extractRecruiterExperience(root);
  const education = extractRecruiterEducation(root);
  const certifications = extractRecruiterCertifications(root);

  const seen = new Set();
  const skills = [];
  const addSkill = (raw) => {
    const { name: skill } = cleanSkillRow(raw);
    const low = skill.toLowerCase();
    if (!skill || seen.has(low)) return;
    seen.add(low);
    skills.push(skill);
  };
  root.querySelectorAll('[data-test-skill-entity-skill-name]').forEach(el => addSkill(rlText(el)));
  roleSkills.forEach(addSkill);

  const openToWork = /\bopen to work\b/i.test(
    (root.querySelector('.profile__topcard-wrapper') || topcard.parentElement || topcard).textContent || '');

  if (!experience.length) console.warn('[SCOUT] Recruiter: no experience rows found');
  if (!skills.length) console.warn('[SCOUT] Recruiter: no skills found');

  return {
    source: "linkedin",
    recruiter: true,
    name, title, location, skills, endorsements: {},
    experience_years: calcExperienceYears(experience),
    clearance: '',
    profileUrl,
    recruiterUrl: window.location.href.split('?')[0],
    experience, about, education, certifications, openToWork,
    email, phone,
  };
}

// Same contract as runExtraction() in linkedin.js: one in-flight run per
// candidate, shared by every getProfile request; `force` restarts a settled run.
let rlExtractionPromise = null;
let rlExtractedId = '';
let rlExtractionSettled = false;

function runRecruiterExtraction(force = false) {
  const id = recruiterProfileId(window.location.href);
  if (rlExtractionPromise && rlExtractedId === id) {
    if (!force || !rlExtractionSettled) return rlExtractionPromise;
  }
  rlExtractedId = id;
  rlExtractionSettled = false;
  rlExtractionPromise = (async () => {
    const t0 = Date.now();
    const root = await waitForRecruiterProfile(id);
    if (!root) throw new Error('Recruiter profile did not load');

    const skillsExpanded = await expandRecruiterSections(root);
    // Expanding can re-render the cards; read from the live container.
    const live = recruiterRoot() || root;
    const profile = extractRecruiterProfile(live);
    if (skillsExpanded) {
      collapseRecruiterSkills(live);
      // Let the list fold before resetting scroll, or the re-render shifts it again.
      await new Promise(r => setTimeout(r, 300));
    }
    // Leave the recruiter at the top of the profile — unless they have already
    // paged to another candidate, whose drawer must not be yanked around.
    if (recruiterProfileId(window.location.href) === id) scrollRecruiterToTop(recruiterRoot() || live);

    mineSkillsAndClearance(profile);
    rlLastSignature = recruiterSignature(live);
    rlLastSignatureId = id;

    console.log(`[SCOUT] experience_years = ${profile.experience_years} from ` +
      `${profile.experience.length} role(s):`,
      profile.experience.map(e => `${e.title} | dates="${e.dates}" | type="${e.employmentType || '-'}"`));
    console.log(`[SCOUT] LinkedIn Recruiter parsed in ${Date.now() - t0}ms:`, profile,
      '| clearance:', profile.clearance || 'None');
    chrome.storage.session.set({ scout_candidate: profile });
    requestPanelOpen();
    return profile;
  })().finally(() => { rlExtractionSettled = true; });
  return rlExtractionPromise;
}
