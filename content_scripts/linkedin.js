// LinkedIn profile parser — extracts name, title, location, skills, experience_years
// Stores result in chrome.storage.session under key "scout_candidate"

function getText(selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  for (const sel of list) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim()) return el.innerText.trim();
  }
  return "";
}

function findTopcardColumn() {
  const topcardSection = document.querySelector('section[componentkey*="Topcard"]');
  if (topcardSection) {
    const contactLink = topcardSection.querySelector('a[href*="contact-info"]');
    if (contactLink) {
      let candidate = contactLink.parentElement;
      while (candidate && candidate !== topcardSection) {
        const directPs = candidate.querySelectorAll(':scope > p');
        if (directPs.length > 0 && candidate.querySelector('h2')) return candidate;
        candidate = candidate.parentElement;
      }
    }
  }
  const contactLink = document.querySelector('a[href*="overlay/contact-info"]');
  if (contactLink) {
    let node = contactLink.parentElement;
    for (let i = 0; i < 8 && node; i++) {
      if (node.querySelector('h2') && node.querySelectorAll(':scope > p').length >= 1) return node;
      node = node.parentElement;
    }
  }
  return null;
}

function findSectionByHeading(headingText) {
  const target = headingText.toLowerCase().trim();
  for (const h2 of document.querySelectorAll('section h2')) {
    const text = h2.innerText.trim().toLowerCase();
    if (text === target || text.startsWith(target)) return h2.closest('section');
  }
  for (const h2 of document.querySelectorAll('h2')) {
    const text = h2.innerText.trim().toLowerCase();
    if (text === target || text.startsWith(target)) {
      return h2.closest('section') || h2.closest('[class]')?.parentElement;
    }
  }
  return null;
}

// Skills section finder — heading lookup first, then layout-specific anchors
// (classic LinkedIn uses a <div id="skills"> anchor inside the section).
function findSkillsSection() {
  // Fallback anchor must be the section's "Show all skills" link — NOT a per-skill
  // endorsers link (".../details/skills/urn:li:fsd_skill:(...)/endorsers/"), which
  // also matches "/details/skills" and lives in unrelated cards (browsemap etc.).
  const showAll = Array.from(document.querySelectorAll('a[href*="/details/skills"]'))
    .find(a => !/\/endorsers\//.test(a.href) && !/fsd_skill:/.test(a.href));
  return findSectionByHeading('Skills')
    || document.querySelector('#skills')?.closest('section')
    || showAll?.closest('section')
    || null;
}

// Experience section finder — heading lookup, then anchors. Mirrors the skills
// finder so the section is located even when the heading text/structure differs
// across LinkedIn layouts (the cause of experience missing on some devices).
function findExperienceSection() {
  return findSectionByHeading('Experience')
    || document.querySelector('#experience')?.closest('section')
    || document.querySelector('a[href*="/details/experience"]')?.closest('section')
    || null;
}

// Broad date/duration detector — months ("Jan 2020"), bare years ("2020"),
// ranges ("2020 - Present"), durations ("3 yrs 2 mos"), or "Present". Used to
// pick the dates line; the narrow month-only regex missed year-only layouts.
const DATE_RE = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|\b(?:19|20)\d{2}\b|\bPresent\b|\d+\s*yr|\d+\s*mo/i;

function getSectionItems(section) {
  const expItems = section.querySelectorAll('div[componentkey^="entity-collection-item"]');
  if (expItems.length > 0) return Array.from(expItems);

  for (const sel of ['li.pvs-list__item--line-separated', 'li.pvs-list__paged-list-item', 'ul > li']) {
    const found = section.querySelectorAll(sel);
    if (found.length > 0) return Array.from(found);
  }

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uuidItems = Array.from(section.querySelectorAll('div[componentkey]')).filter(el => {
    return uuidRe.test(el.getAttribute('componentkey') || '') && el.querySelector('p');
  });
  if (uuidItems.length > 0) return uuidItems;

  return Array.from(section.querySelectorAll(':scope > div > div > div')).filter(
    d => d.querySelectorAll('p').length > 0 && !d.querySelector('section')
  );
}

function extractOpenToWork() {
  // Primary: "Open to work" panel renders as <strong>Open to work</strong> in topcard
  const topcard = document.querySelector('section[componentkey*="Topcard"]') || document.body;
  for (const el of topcard.querySelectorAll('strong, b')) {
    if (/^open\s+to\s+work$/i.test((el.textContent || '').trim())) return true;
  }

  // Secondary: aria-label on photo frame svg (older LinkedIn versions)
  const photoLink = document.querySelector('[componentkey*="topcard-logo"]');
  const figure = photoLink
    ? photoLink.querySelector('figure')
    : document.querySelector('section[componentkey*="Topcard"] figure');
  if (figure) {
    for (const el of figure.querySelectorAll('[aria-label]')) {
      if (/open\s+to\s+work/i.test(el.getAttribute('aria-label') || '')) return true;
    }
  }

  return false;
}

function extractAboutFromDoc(doc) {
  // Try expandable-text-box near an "about" h2
  for (const box of doc.querySelectorAll('[data-testid="expandable-text-box"]')) {
    let n = box.parentElement;
    for (let i = 0; i < 10 && n; i++) {
      for (const h2 of n.querySelectorAll('h2')) {
        if ((h2.textContent || '').trim().toLowerCase().startsWith('about')) {
          const clone = box.cloneNode(true);
          clone.querySelector('[data-testid="expandable-text-button"], button')?.remove();
          const text = (clone.textContent || '').trim();
          if (text) return text;
        }
      }
      n = n.parentElement;
    }
  }
  // Try h2 "about" → nearest p with substantial text
  for (const h2 of doc.querySelectorAll('h2')) {
    if (!(h2.textContent || '').trim().toLowerCase().startsWith('about')) continue;
    let n = h2.parentElement;
    for (let i = 0; i < 6 && n; i++) {
      for (const p of n.querySelectorAll('p')) {
        const text = (p.textContent || '').trim();
        if (text.length > 30) return text;
      }
      n = n.parentElement;
    }
  }
  return '';
}

function extractAbout() {
  // Strategy 0 (own profile): edit link is inside the About section
  const editLink = document.querySelector('a[href*="edit/forms/summary"], a[aria-label="Edit about"]');
  if (editLink) {
    let n = editLink.parentElement;
    for (let i = 0; i < 8 && n; i++) {
      const box = n.querySelector('[data-testid="expandable-text-box"]');
      if (box) {
        const clone = box.cloneNode(true);
        clone.querySelector('[data-testid="expandable-text-button"], button')?.remove();
        const text = (clone.textContent || '').trim();
        if (text) { console.log('[SCOUT] About via edit-link:', text.substring(0, 60)); return text; }
      }
      n = n.parentElement;
    }
  }
  return extractAboutFromDoc(document);
}

async function fetchAbout() {
  try {
    const url = window.location.href.split('?')[0];
    const res = await fetch(url, { credentials: 'include', headers: { 'accept': 'text/html' } });
    if (!res.ok) return '';
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const text = extractAboutFromDoc(doc);
    if (text) { console.log('[SCOUT] fetchAbout hit:', text.substring(0, 60)); return text; }

    // JSON-LD fallback
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent || '');
        const desc = data.description || data['@graph']?.find(n => n.description)?.description;
        if (desc) return desc;
      } catch (_) { }
    }
  } catch (e) {
    console.log('[SCOUT] fetchAbout error:', e.message);
  }
  return '';
}

function extractEducation() {
  const education = [];
  const section = findSectionByHeading('Education');
  if (!section) return education;
  getSectionItems(section).forEach(item => {
    const editLink = item.querySelector('a[href*="edit/forms/"]');
    const ps = editLink ? editLink.querySelectorAll('p') : item.querySelectorAll('p');
    const school = ps[0]?.innerText.trim() || '';
    const degree = ps[1]?.innerText.trim() || '';
    const dates = ps[2]?.innerText.trim() || '';
    if (school) education.push({ school, degree, dates });
  });
  return education;
}

function calcExperienceYears(experience) {
  // Strategy 1: sum "X yrs Y mos" duration strings from LinkedIn
  let totalMonths = 0;
  for (const exp of experience) {
    const m = (exp.dates || '').match(/(\d+)\s*yr[s]?\s*(?:(\d+)\s*mo[s]?)?/);
    if (m) {
      totalMonths += (parseInt(m[1]) || 0) * 12 + (parseInt(m[2]) || 0);
    }
  }
  if (totalMonths > 0) return Math.round(totalMonths / 12 * 10) / 10;

  // Fallback: earliest start year → latest end year (or now if a role is ongoing).
  // Using latest end (not always "now") avoids over-counting profiles whose roles
  // all ended in the past — a layout difference seen on some devices.
  let earliest = null, latest = null, ongoing = false;
  const now = new Date().getFullYear();
  for (const exp of experience) {
    const d = exp.dates || '';
    if (/present/i.test(d)) ongoing = true;
    for (const ym of d.match(/\b(?:19|20)\d{2}\b/g) || []) {
      const y = parseInt(ym, 10);
      if (!earliest || y < earliest) earliest = y;
      if (!latest   || y > latest)   latest = y;
    }
  }
  if (!earliest) return null;
  const end = ongoing ? now : (latest || now);
  return Math.max(end - earliest, 0);
}

function extractExperience() {
  const experience = [];
  const expSection = findExperienceSection();
  if (!expSection) return experience;
  const dateRe = DATE_RE;

  for (const item of expSection.querySelectorAll('div[componentkey^="entity-collection-item"]')) {
    // Company name: first <p> in header area (not inside the roles ul)
    const headerPs = Array.from(item.querySelectorAll('p')).filter(p => !p.closest('ul'));
    const companyName = headerPs[0]?.innerText.trim() || '';

    const roleItems = item.querySelectorAll('ul > li');
    if (roleItems.length > 0) {
      // Multi-role entry: each li = one position
      for (const li of roleItems) {
        // Narrow/zoomed layouts drop the <a> wrapper around each role — fall
        // back to the li's own <p>s so the position isn't skipped (the cause
        // of experience missing at small screen widths).
        const roleLink = li.querySelector('a:not([componentkey])');
        const ps = roleLink
          ? Array.from(roleLink.querySelectorAll('p'))
          : Array.from(li.querySelectorAll('p'));
        const title = ps[0]?.innerText.trim() || '';
        let dates = '';
        for (const p of ps) {
          if (dateRe.test(p.innerText.trim())) { dates = p.innerText.trim(); break; }
        }
        if (title) experience.push({ title, company: companyName, dates });
      }
    } else {
      // Single-role entry: company header IS the role
      const singleLink = item.querySelector('a:not([componentkey])');
      const ps = singleLink ? Array.from(singleLink.querySelectorAll('p')) : headerPs;
      const title = ps[0]?.innerText.trim() || '';
      let dates = '';
      for (const p of ps) {
        if (dateRe.test(p.innerText.trim())) { dates = p.innerText.trim(); break; }
      }
      if (title) experience.push({ title, company: companyName, dates });
    }
  }

  // Fallback: old approach for profiles without entity-collection-item componentkeys
  if (experience.length === 0) {
    getSectionItems(expSection).forEach(item => {
      const ps = Array.from(item.querySelectorAll('p'));
      const title = ps[0]?.innerText.trim() || '';
      const company = ps[1]?.innerText.trim() || '';
      // Don't assume ps[2] is the date line — scan for the first date-like <p>.
      const dateP = ps.find(p => DATE_RE.test(p.innerText.trim()));
      const dates = dateP ? dateP.innerText.trim() : (ps[2]?.innerText.trim() || '');
      if (title) experience.push({ title, company, dates });
    });
  }
  return experience;
}

// Wait for the Experience section's items to lazy-render, then extract. On
// slower machines/networks the section streams in AFTER the scroll pass, so a
// single read races the render and returns []. Polls up to ~maxMs, scrolling
// the section into view to trigger its lazy load, and returns as soon as items
// appear. Same-account/same-browser profiles only differ by this timing — this
// is why experience was missing on some machines but not others.
async function extractExperienceWithWait(maxMs = 6000) {
  let experience = extractExperience();
  if (experience.length > 0) return experience;

  const section = findExperienceSection();
  if (section) section.scrollIntoView({ block: 'center' });

  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 300));
    experience = extractExperience();
    if (experience.length > 0) break;
    const sec = findExperienceSection();
    if (sec) sec.scrollIntoView({ block: 'center' });
  }
  console.log(`[SCOUT] extractExperienceWithWait: ${experience.length} items after ${Date.now() - start}ms`);
  return experience;
}

function extractProfile() {
  const column = findTopcardColumn();

  const name = (() => {
    if (column) {
      const h2 = column.querySelector('h2');
      if (h2) return h2.innerText.trim();
    }
    return getText(['div[data-display-contents="true"] h2', 'h1.text-heading-xlarge', 'h1']);
  })();

  const title = (() => {
    if (column) {
      const directPs = column.querySelectorAll(':scope > p');
      if (directPs.length > 0) return directPs[0].innerText.trim();
    }
    return getText(['.text-body-medium.break-words', '.pv-text-details__left-panel .text-body-medium']);
  })();

  const location = (() => {
    if (column) {
      const contactLink = column.querySelector('a[href*="contact-info"]');
      if (contactLink) {
        const row = contactLink.closest('div');
        if (row && row !== column) {
          const firstP = row.querySelector('p');
          if (firstP && !firstP.querySelector('a')) return firstP.innerText.trim();
        }
      }
      for (const div of column.querySelectorAll(':scope > div')) {
        for (const p of div.querySelectorAll('p')) {
          const txt = p.innerText.trim();
          if (txt.includes(',') && !txt.includes('·') && !p.querySelector('a')) return txt;
        }
      }
    }
    return getText([
      '.text-body-small.inline.t-black--light.break-words',
      '.pv-text-details__left-panel span.text-body-small'
    ]);
  })();

  // Experience
  const experience = extractExperience();

  // Skills — Source 1: Skills section on main page
  const seen = new Set();
  const skills = [];

  function addSkill(raw) {
    // First line only, then drop any endorsement tail LinkedIn appends inline
    // ("Python · 12 endorsements", "AWS · Endorsed by 3 colleagues") and the
    // leftover middot/separator so only the skill name remains.
    let s = (raw || '').trim().split('\n')[0].trim();
    // Drop the endorsement tail in either form: "· 12 endorsements" or
    // "· Endorsed by 3 colleagues", plus the leftover middot/separator.
    s = s.replace(/\s*[·•|–-]\s*(?:\d+\s*endorsements?|endorsed by\b.*)$/i, '');
    s = s.replace(/\s*\d+\s*endorsements?$/i, '');
    s = s.replace(/\s*[·•|]\s*$/, '').trim();
    const low = s.toLowerCase();
    if (s && s.length < 80 && s.length > 1 &&
      !low.includes('show all') &&
      !low.includes('endorse') &&
      !/^\d+$/.test(s) &&                // pure endorsement count leaked as a row
      !seen.has(low)) {
      seen.add(low);
      skills.push(s);
    }
  }

  const skillSection = findSkillsSection();
  if (skillSection) {
    // New LinkedIn layout: skill componentkeys (prefix occasionally changes — match loosely)
    const skillItems = Array.from(
      skillSection.querySelectorAll('div[componentkey*="profile.skill" i]')
    ).filter(el => {
      const ck = el.getAttribute('componentkey') || '';
      return !ck.endsWith('-divider') && el.querySelector('p');
    });

    skillItems.forEach(item => {
      // First <p> in each skill item = skill name (confirmed from DOM inspection)
      addSkill(item.querySelector('p')?.innerText);
    });

    // Classic layout: skill name is a bold hoverable link per list row
    if (skills.length === 0) {
      skillSection.querySelectorAll(
        'a[data-field="skill_card_skill_topic"] span[aria-hidden="true"], ' +
        '.hoverable-link-text.t-bold span[aria-hidden="true"]'
      ).forEach(el => addSkill(el.innerText));
    }

    // Old layout fallback
    if (skills.length === 0) {
      skillSection.querySelectorAll('.t-bold span[aria-hidden="true"]').forEach(el =>
        addSkill(el.innerText)
      );
    }

    console.log(`[SCOUT] Skills section found, extracted ${skills.length} from main page`);
  } else {
    console.warn('[SCOUT] Skills section NOT found on page');
  }

  // Skills — Source 2: Experience skill-association links
  // e.g. "Java, Spring boot  and +4 skills" or "SQL, Java and +8 skills"
  document.querySelectorAll('a[href*="skill-associations-details"]').forEach(link => {
    const text = (link.innerText || '').trim();
    // Strip trailing "and +N skills"
    const cleaned = text.replace(/\s+and\s+\+\d+\s+skills?\.?$/i, '').replace(/\s{2,}/g, ' ');
    cleaned.split(',').forEach(s => addSkill(s));
  });

  // Skills — Source 3: Headline pipe-separated list
  // e.g. "SDE 1 at PharmEasy|Ex PwC| NITK'23 | Dsa, Java, Spring Boot, SQL, LLD"
  if (title && title.includes('|')) {
    const parts = title.split('|');
    const lastPart = parts[parts.length - 1].trim();
    // Only treat as skills if it looks like a comma-separated list (no year, no company)
    if (lastPart.includes(',') && !/\b(20|19)\d{2}\b/.test(lastPart)) {
      lastPart.split(',').forEach(s => addSkill(s));
    }
  }

  const experience_years = calcExperienceYears(experience);
  const about = extractAbout();
  console.log('[SCOUT] about result:', about ? about.substring(0, 80) : '(empty)');
  const education = extractEducation();
  const openToWork = extractOpenToWork();

  // Clearance from about + skills + title — highest level found. Mirrors the
  // scorer's detectClearance (service_worker.js / score_endpoint.py).
  const clearance = detectClearance([about, (skills || []).join(" "), title].filter(Boolean).join("\n"));

  return {
    source: "linkedin",
    name, title, location, skills, experience_years, clearance,
    profileUrl: window.location.href.split('?')[0],
    experience, about, education, openToWork
  };
}

// Security clearance scan — ordered high→low; highest level found wins (a TS/SCI
// holder also satisfies a Secret requirement). Mirrors detectClearance in
// service_worker.js / score_endpoint.py.
const CLEARANCE_LEVELS = [
  { label: "TS/SCI",       re: /\bTS\s*\/?\s*SCI\b|\bsensitive compartmented\b/i },
  { label: "Top Secret",   re: /\btop\s+secret\b/i },
  { label: "Secret",       re: /\bsecret(?:\s+clearance)?\b/i },
  { label: "Public Trust", re: /\bpublic\s+trust\b/i },
];
function detectClearance(text) {
  if (!text) return "";
  for (const lvl of CLEARANCE_LEVELS) if (lvl.re.test(text)) return lvl.label;
  return "";
}

// Clicks "Show all skills" → extracts from the modal that renders in-place in the live DOM.
// The detail page is client-rendered (no componentkeys in fetched HTML), so fetch won't work.
async function expandAndExtractAllSkills(profile) {
  const skillSection = findSkillsSection();
  if (!skillSection) return;

  // Each skill row also links to its endorsers at
  // ".../details/skills/urn:li:fsd_skill:(...,N)/endorsers/", which ALSO matches
  // "/details/skills" and sits BEFORE the real "Show all" button in DOM order.
  // A bare href*="/details/skills" query therefore grabs an endorsers link and
  // navigates to the endorsers page. Take the aria-labelled button first, then
  // fall back to a skills link that is neither a per-skill urn nor /endorsers/.
  const isEndorsersLink = (a) => /\/endorsers\//.test(a.href) || /fsd_skill:/.test(a.href);
  const showAllBtn =
    skillSection.querySelector('a[aria-label="Show all skills"]') ||
    Array.from(skillSection.querySelectorAll('a[href*="/details/skills"]'))
      .find(a => !isEndorsersLink(a));
  if (!showAllBtn) {
    console.warn('[SCOUT] No "Show all skills" button found');
    return;
  }

  const seen = new Set(profile.skills.map(s => s.toLowerCase()));

  function tryAdd(raw) {
    const skill = (raw || '').trim().split('\n')[0].trim();
    if (skill && skill.length < 80 &&
      !skill.toLowerCase().includes('show all') &&
      !skill.toLowerCase().includes('endorse') &&
      !seen.has(skill.toLowerCase())) {
      seen.add(skill.toLowerCase());
      profile.skills.push(skill);
    }
  }

  function harvest() {
    // SDUI overlay items
    document.querySelectorAll('div[componentkey*="profile.skill" i]').forEach(el => {
      if ((el.getAttribute('componentkey') || '').endsWith('-divider')) return;
      const p = el.querySelector('p');
      if (p) tryAdd(p.innerText || p.textContent);
    });
    // Classic /details/skills page: the skill name is the skill-topic anchor.
    document.querySelectorAll(
      'a[data-field="skill_page_skill_topic"] span[aria-hidden="true"]'
    ).forEach(el => tryAdd(el.innerText));
    // Fallback only if the skill-topic anchor is absent: take the FIRST bold
    // hoverable link per row (the skill name). Each row also nests endorser
    // names with the same class, so a flat query would scrape endorsers as
    // skills — read one per list item to skip them.
    document.querySelectorAll('.pvs-list__paged-list-item').forEach(item => {
      if (item.querySelector('a[data-field="skill_page_skill_topic"]')) return;
      const span = item.querySelector('.hoverable-link-text.t-bold span[aria-hidden="true"]');
      if (span) tryAdd(span.innerText);
    });
  }

  showAllBtn.click();

  await new Promise(resolve => {
    let polls = 0;
    let stable = 0;
    let lastCount = profile.skills.length;

    const timer = setInterval(() => {
      polls++;
      harvest();

      if (profile.skills.length > lastCount) {
        stable = 0;
        lastCount = profile.skills.length;
      } else {
        stable++;
      }

      if (stable >= 4 || polls >= 30) {
        clearInterval(timer);
        resolve();
      }
    }, 500);
  });

  await closeOverlay();
  console.log(`[SCOUT] expandAndExtractAllSkills: ${profile.skills.length} total skills`);
}

// Close whatever overlay we opened (skills "Show all" / contact-info modal).
// Synthetic Escape alone is unreliable: LinkedIn's handlers often ignore
// untrusted key events, and on the classic layout the click navigates to a
// /details/ or /overlay/ route instead of opening a modal.
async function closeOverlay() {
  for (let attempt = 0; attempt < 3; attempt++) {
    // Only true modals — skip bare [role="dialog"] (matches the persistent messaging bubble)
    const modal = document.querySelector('dialog[open], [aria-modal="true"], .artdeco-modal');
    if (!modal) break;
    const dismissBtn =
      modal.querySelector('button[aria-label*="dismiss" i], button[aria-label*="close" i], .artdeco-modal__dismiss') ||
      modal.closest('.artdeco-modal-overlay')?.querySelector('.artdeco-modal__dismiss');
    if (dismissBtn) {
      dismissBtn.click();
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    }
    await new Promise(r => setTimeout(r, 400));
  }

  // Click navigated to an overlay/detail route instead of opening a modal → go back
  if (/\/(overlay|details)\//.test(window.location.pathname)) {
    history.back();
    await new Promise(r => setTimeout(r, 600));
  }

  const left = document.querySelector('dialog[open], [aria-modal="true"], .artdeco-modal');
  console.log('[SCOUT] closeOverlay:', left ? 'overlay still present' : 'closed');
}

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
const cleanPhone = (s) => (s || '').replace(/\((mobile|home|work|cell)\)/ig, '').trim();

// Image/asset filenames look like emails to EMAIL_RE — "icon@2x.png" has
// local="icon", domain="2x.png". Reject these so an asset reference in the
// overlay (e.g. "entity-circle-pile-chat@2x.png") is never taken as the email.
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|ico|bmp|css|m?js|json|woff2?|ttf|otf|eot|map|pdf|mp4|webm|avif)$/i;
function isLikelyEmail(e) {
  if (!e || !e.includes('@')) return false;
  if (ASSET_EXT.test(e)) return false;     // image/font/asset filename
  if (/@\d+x\b/i.test(e)) return false;    // retina marker "@2x", "@3x"
  const domain = e.split('@')[1] || '';
  return domain.includes('.') && EMAIL_RE.test(e);
}

// Extract a clean email from a text blob. Skips asset filenames, and handles the
// SDUI layout (seen on some devices) where the field label is glued to the
// address with no separator — "Emailjohn@x.com" — by stripping a leading label
// token. Returns the first *plausible* email so an asset match in the same blob
// doesn't shadow the real address.
function cleanEmail(text) {
  const all = (text || '').match(new RegExp(EMAIL_RE.source, 'g')) || [];
  for (let e of all) {
    const stripped = e.replace(/^(?:e-?mail(?:address)?|contactinfo|contact)/i, '');
    if (stripped !== e && stripped.includes('@') && EMAIL_RE.test(stripped)) {
      e = stripped.match(EMAIL_RE)[0];
    }
    if (isLikelyEmail(e)) return e;
  }
  return '';
}

// Pick the cleanest email under `root`. Prefers a mailto link, then the leaf
// element whose entire text IS an email (avoids grabbing a parent's glued
// "label+address" text), falling back to the first match anywhere.
function pickEmail(root) {
  const mailto = root.querySelector('a[href^="mailto:"]');
  if (mailto) {
    const e = cleanEmail(mailto.getAttribute('href').replace(/^mailto:/, ''));
    if (e) return e;
  }
  let fallback = '';
  for (const el of root.querySelectorAll('a, span, p, li, dd')) {
    const text = (el.innerText || el.textContent || '').trim();
    if (!text || text.length > 120 || text.includes('linkedin.com')) continue;
    const e = cleanEmail(text);   // '' for asset filenames / invalid
    if (!e) continue;
    // Leaf whose whole text is the email = cleanest, no label glue possible.
    if (text.replace(EMAIL_RE, '').trim() === '') return e;
    if (!fallback) fallback = e;
  }
  return fallback;
}

// Parse email + phone out of a contact-info DOM/Document (server HTML or live modal).
function parseContactFrom(root) {
  let email = '';
  let phone = '';

  email = pickEmail(root);

  // Phone: find label <p>"Phone" → sibling value <p> (e.g. "9154262710 (Mobile)")
  for (const label of root.querySelectorAll('p, h3, h4, dt, span, label')) {
    if (/^phone$/i.test((label.textContent || '').trim())) {
      let valEl = label.nextElementSibling;
      if (!valEl && label.parentElement) valEl = label.parentElement.querySelector('p:nth-of-type(2), dd, a');
      const val = cleanPhone(valEl && valEl.textContent);
      if (val && /\d{6,}/.test(val)) { phone = val; break; }
    }
  }
  return { email, phone };
}

async function extractContactInfo() {
  // Poll for contact link — topcard lazy-unloads during scroll, may not be back yet
  let contactLink = document.querySelector('a[href*="overlay/contact-info"]');
  if (!contactLink) {
    await new Promise(resolve => {
      let polls = 0;
      const timer = setInterval(() => {
        polls++;
        contactLink = document.querySelector('a[href*="overlay/contact-info"]');
        if (contactLink || polls >= 40) { clearInterval(timer); resolve(); }
      }, 150);
    });
    console.log('[SCOUT] contact link poll result:', contactLink ? 'found' : 'not found');
  }

  if (!contactLink) {
    console.log('[SCOUT] No contact-info link found after 6s poll');
    return { email: '', phone: '', sawOverlay: false };
  }

  // Carry whatever the fetch path resolves so a partial result (email but no
  // phone) doesn't get thrown away when we fall through to the modal.
  let fetchedEmail = '';
  let fetchedPhone = '';

  // Strategy A (preferred): fetch the overlay route — it returns server-rendered
  // HTML with email/phone inline. No modal, no timing, no navigation.
  try {
    const url = contactLink.href || (window.location.href.split('?')[0].replace(/\/$/, '') + '/overlay/contact-info/');
    console.log('[SCOUT] Fetching contact overlay:', url);
    const res = await fetch(url, { credentials: 'include', headers: { 'accept': 'text/html' } });
    if (res.ok) {
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const scope = doc.querySelector('[componentkey*="ContactInfo"], [data-sdui-screen*="ContactDetails"], dialog') || doc;
      const got = parseContactFrom(scope);
      // Fields can split across sources: email rendered in DOM, phone only in
      // the embedded JSON (SDUI/voyager payload). Scan raw HTML too.
      const rawEmail = (html.match(new RegExp(EMAIL_RE.source, 'g')) || [])
        .find(e => isLikelyEmail(e) && !/linkedin\.com$/i.test(e.split('@')[1] || ''));
      const rawPhone = (html.match(/"(?:phoneNumber|number)"\s*:\s*"(\+?[\d\s\-().]{7,18})"/) || [])[1] || '';
      fetchedEmail = got.email || rawEmail || '';
      fetchedPhone = got.phone || (rawPhone ? rawPhone.trim() : '');
      console.log('[SCOUT] contact info via fetch (DOM+raw):', { email: fetchedEmail, phone: fetchedPhone });
      // Only short-circuit when BOTH fields are in hand. The server-rendered
      // overlay often carries email but loads the phone lazily (only the live
      // modal renders it), so a missing phone must fall through to the modal.
      if (fetchedEmail && fetchedPhone) {
        return { email: fetchedEmail, phone: fetchedPhone, sawOverlay: true };
      }
      console.log('[SCOUT] fetch missing phone — opening modal to complete');
    } else {
      console.log('[SCOUT] fetch status', res.status, '— falling back to modal');
    }
  } catch (e) {
    console.log('[SCOUT] fetch failed:', e.message, '— falling back to modal');
  }

  // Strategy B (fallback): click the link, scrape the live modal.
  // Re-query first — the topcard re-renders during the fetch attempt and can
  // detach the node found earlier; clicking a detached node is a no-op, the
  // modal never opens, and the 10s poll below times out with blank results.
  contactLink = document.querySelector('a[href*="overlay/contact-info"]') || contactLink;
  console.log('[SCOUT] Clicking contact-info overlay');
  contactLink.click();

  // Phase 1: wait up to 10s for the CONTACT modal container. Generic dialog
  // selectors alone match pre-existing overlays (messaging, search) and fire
  // instantly, so generic dialogs only count if their text looks like contact info.
  const looksLikeContactDialog = (el) => /contact|email|phone/i.test(el.textContent || '');
  const findContactContainer = () =>
    document.querySelector('[data-sdui-screen*="ContactDetails"], [componentkey*="ContactInfo"], section.pv-contact-info') ||
    document.querySelector('a[href^="mailto:"]')?.closest('dialog, [role="dialog"], [aria-modal="true"]') ||
    [...document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"], [data-test-modal]')].find(looksLikeContactDialog) ||
    null;
  await new Promise(resolve => {
    let polls = 0;
    const timer = setInterval(() => {
      polls++;
      if (findContactContainer() || polls > 40) { clearInterval(timer); resolve(); }
    }, 250);
  });

  // Phase 2: the container appears as an empty shell first ("Contact info"
  // title only) and its fields stream in via AJAX. Wait until real fields
  // render — mailto / email input / the always-present "Profile" linkedin.com
  // link / phone digits or an email-shaped string — or until the container's
  // text stops growing for 3 consecutive polls (profiles with no email/phone).
  // Up to 8s.
  await new Promise(resolve => {
    let polls = 0;
    let lastLen = -1;
    let stable = 0;
    const timer = setInterval(() => {
      polls++;
      const c = findContactContainer();
      if (c) {
        const hasFields =
          c.querySelector('a[href^="mailto:"], input[type="email"], a[href*="linkedin.com/in/"]') ||
          /\b(phone|email)\b[\s\S]{0,80}?\d{6,}|@[a-z0-9.\-]+\.[a-z]{2,}/i.test(c.textContent || '');
        const len = (c.textContent || '').length;
        stable = (len === lastLen) ? stable + 1 : 0;
        lastLen = len;
        if (hasFields || stable >= 3) { clearInterval(timer); resolve(); return; }
      }
      if (polls > 32) { clearInterval(timer); resolve(); }
    }, 250);
  });

  // Short settle so a just-rendered field's siblings (phone under email) finish too
  await new Promise(r => setTimeout(r, 400));

  console.log('[SCOUT] modal URL:', window.location.href.includes('contact-info') ? 'has contact-info' : 'no contact-info in URL');
  console.log('[SCOUT] modal dialogs:', document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open]').length);
  console.log('[SCOUT] modal mailtos:', document.querySelectorAll('a[href^="mailto:"]').length);
  console.log('[SCOUT] modal componentkeys:', document.querySelectorAll('[componentkey*="ContactInfo"],[data-sdui-screen*="ContactDetails"]').length);

  let email = '';
  let phone = '';

  // Scope to the contact-info overlay so we don't grab page numbers (follower counts etc).
  // Same finder as the readiness polls above, so we scrape the element we waited on.
  const ctx = findContactContainer() || document.body;
  console.log('[SCOUT] modal ctx tag:', ctx === document.body ? 'BODY (no modal found)' : ctx.tagName + ' ' + (ctx.getAttribute('componentkey') || ctx.getAttribute('role') || ''));

  // Strategy 1+3: mailto link, else the leaf element whose text IS an email.
  // pickEmail prefers a clean leaf over a parent's glued "label+address" text
  // and strips a glued label prefix (the SDUI layout that broke some devices).
  email = pickEmail(ctx);
  if (email) console.log('[SCOUT] email via pickEmail:', email);

  // Strategy 2: email input value (own profile edit view)
  if (!email) {
    for (const inp of ctx.querySelectorAll('input[type="email"], input[name*="email"], input[id*="email"]')) {
      if (inp.value) { email = cleanEmail(inp.value); console.log('[SCOUT] email via input:', email); break; }
    }
  }

  const cleanPhone = (s) =>
    (s || '').replace(/\((mobile|home|work|cell)\)/ig, '').trim();

  // Phone strategy 1: label <p>/<h3> "Phone" → following sibling holds the number (current LinkedIn DOM)
  for (const label of ctx.querySelectorAll('p, h3, h4, dt, span, label')) {
    if (/^phone$/i.test((label.innerText || '').trim())) {
      // value is usually the next <p> within the same block
      const block = label.parentElement;
      let valEl = label.nextElementSibling;
      if (!valEl && block) valEl = block.querySelector('p:nth-of-type(2), dd, a');
      const val = cleanPhone(valEl?.innerText);
      if (val && /\d{6,}/.test(val)) { phone = val; console.log('[SCOUT] phone via label:', phone); break; }
    }
  }

  // Phone strategy 2: section with phone/mobile heading (older DOM)
  if (!phone) {
    for (const sec of ctx.querySelectorAll('section, div')) {
      const heading = (sec.querySelector('h3, h4, dt, label')?.innerText || '').toLowerCase();
      if (heading.includes('phone') || heading.includes('mobile')) {
        const val = cleanPhone(sec.querySelector('span, p, dd, a')?.innerText);
        if (val && val.length < 30 && /\d{6,}/.test(val)) { phone = val; console.log('[SCOUT] phone via heading:', phone); break; }
      }
    }
  }

  // Phone strategy 3: pattern scan inside overlay only
  if (!phone) {
    const phoneRe = /[\+\d][\d\s\-\.\(\)]{6,18}\d/;
    for (const el of ctx.querySelectorAll('span, p, a')) {
      const text = cleanPhone(el.innerText);
      if (phoneRe.test(text) && text.length < 25 && !/[a-zA-Z]{3}/.test(text) && (text.match(/\d/g) || []).length >= 7) {
        const m = text.match(phoneRe);
        if (m) { phone = m[0].trim(); console.log('[SCOUT] phone via regex:', phone); break; }
      }
    }
  }

  // Fold in anything the fetch path already resolved (e.g. email) so the modal
  // pass only needs to supply what was missing (e.g. the lazily-rendered phone).
  email = email || fetchedEmail;
  phone = phone || fetchedPhone;

  console.log('[SCOUT] contact info result:', { email, phone });
  await closeOverlay();

  // sawOverlay=false means we never located a contact container (modal didn't
  // open or hadn't rendered) — caller may retry. true with blank fields means
  // the profile genuinely lists no email/phone, so retrying is pointless.
  return { email, phone, sawOverlay: ctx !== document.body };
}

function scrollAndExtract() {
  return new Promise((resolve) => {
    const scrollStep = 800;
    const scrollDelay = 400;
    let pos = 0;
    let capturedAbout = '';
    const mainEl = document.querySelector('main#workspace') || document.querySelector('main') || document.documentElement;

    // Capture OTW before scrolling — topcard lazy-unloads when scrolled out of viewport
    const capturedOpenToWork = extractOpenToWork();
    console.log('[SCOUT] OpenToWork (pre-scroll):', capturedOpenToWork);

    function step() {
      pos += scrollStep;
      window.scrollTo(0, pos);
      mainEl.scrollTop = pos;

      const maxScroll = Math.max(document.body.scrollHeight, mainEl.scrollHeight, document.documentElement.scrollHeight);

      setTimeout(() => {
        if (!capturedAbout) {
          capturedAbout = extractAbout();
          if (capturedAbout) console.log('[SCOUT] About captured at scroll pos', pos);
        }
        if (pos < maxScroll) {
          step();
        } else {
          const profile = extractProfile();
          if (capturedAbout) profile.about = capturedAbout;
          profile.openToWork = capturedOpenToWork;

          if (!profile.about) {
            // About lazy-loads only when its container is in viewport (between topcard and activity).
            // Scroll to 400px so the About container enters view, wait for render, extract, then
            // scroll back to 0 and wait for topcard to reload before resolving (avoids contact-info miss).
            window.scrollTo(0, 400);
            mainEl.scrollTop = 400;
            setTimeout(() => {
              const aboutText = extractAbout();
              console.log('[SCOUT] About after targeted 400px scroll:', aboutText ? aboutText.substring(0, 60) : '(empty)');
              if (aboutText) profile.about = aboutText;
              window.scrollTo(0, 0);
              mainEl.scrollTop = 0;
              // Wait 700ms for topcard to reload before contact-info extraction runs
              setTimeout(() => resolve(profile), 700);
            }, 1200);
          } else {
            window.scrollTo(0, 0);
            mainEl.scrollTop = 0;
            setTimeout(() => resolve(profile), 700);
          }
        }
      }, scrollDelay);
    }

    // Scroll to top first then start downward scroll
    window.scrollTo(0, 0);
    mainEl.scrollTop = 0;
    setTimeout(step, 400);
  });
}

// Single extraction pipeline, deduped per profile (slug, not full URL — the
// extraction itself visits /details/skills and /overlay/contact-info routes,
// which must not look like a new profile). The auto-run on page load and the
// panel's getProfile share the same in-flight promise, so the panel gets an
// instant (or already-running) result instead of starting over.
let extractionPromise = null;
let extractedSlug = '';
let extractionSettled = false;

function profileSlug(url) {
  const m = (url || '').match(/linkedin\.com\/in\/([^\/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

// Ask the SW to open the side panel. sidePanel.open() needs a user gesture;
// if none is active (cold page load), arm a one-time listener so the user's
// next click/keypress on the page opens it.
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

function runExtraction(force = false) {
  const slug = profileSlug(window.location.href);
  if (extractionPromise && extractedSlug === slug) {
    // Same profile: reuse unless forced — and never restart a run in flight,
    // two parallel scroll/overlay routines would fight each other.
    if (!force || !extractionSettled) return extractionPromise;
  }
  extractedSlug = slug;
  extractionSettled = false;
  extractionPromise = (async () => {
    const profile = await scrollAndExtract();

    // Contact info FIRST — while still on the main profile. The skills
    // "Show all" click can navigate to /details/skills and lose the
    // contact-info link, leaving email/phone blank.
    let contact = await extractContactInfo();
    if (!contact.email && !contact.phone && !contact.sawOverlay) {
      // Never found the link/modal — topcard likely mid-re-render (lazy reload
      // after scroll, or the side panel opening reflowed the page). One retry
      // after the layout settles. Skipped when the overlay WAS found but empty:
      // that's a profile with no public contact info, not a timing miss.
      console.log('[SCOUT] contact info overlay never found — retrying once');
      await new Promise(r => setTimeout(r, 1500));
      contact = await extractContactInfo();
    }
    profile.email = contact.email;
    profile.phone = contact.phone;

    // Experience can lose the lazy-render race on slower machines (same account/
    // same browser, only timing differs). If empty, scroll the section into view
    // and poll until it streams in, then recompute experience_years.
    if (!profile.experience || profile.experience.length === 0) {
      console.log('[SCOUT] experience empty after scroll — waiting for lazy render');
      const exp = await extractExperienceWithWait();
      if (exp.length > 0) {
        profile.experience = exp;
        profile.experience_years = calcExperienceYears(exp);
      }
    }

    if (!profile.about) {
      profile.about = await fetchAbout();
    }

    await expandAndExtractAllSkills(profile);

    console.log('[SCOUT] LinkedIn parsed:', profile);
    chrome.storage.session.set({ scout_candidate: profile });
    // Extraction finished — surface the result in the side panel.
    requestPanelOpen();
    return profile;
  })().finally(() => { extractionSettled = true; });
  return extractionPromise;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getProfile') {
    runExtraction(!!request.force).then(profile => sendResponse({ profile }));
  }
  return true;
});

// No auto-start: extraction runs only when the side panel asks (getProfile),
// which happens after the user clicks the extension to open the panel. Once
// the panel is open it re-scans on tab switch / SPA navigation via its own
// chrome.tabs.onUpdated / onActivated listeners.
