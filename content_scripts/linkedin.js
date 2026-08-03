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

// Clean one raw skill row into { name, endorsements }. name is '' when the row
// is not a valid skill (endorsement count leak, "Show all", too short/long).
// Shared by extractProfile's addSkill and the scroll-loop skill capture so both
// normalize identically (strip the inline "· 12 endorsements" tail, etc.).
function cleanSkillRow(raw) {
  let s = (raw || '').trim().split('\n')[0].trim();
  const endMatch = s.match(/(\d+)\s*endorsements?/i);
  s = s.replace(/\s*[·•|–-]\s*(?:\d+\s*endorsements?|endorsed by\b.*)$/i, '');
  s = s.replace(/\s*\d+\s*endorsements?$/i, '');
  s = s.replace(/\s*[·•|]\s*$/, '').trim();
  const low = s.toLowerCase();
  const valid = s && s.length < 80 && s.length > 1 &&
    !low.includes('show all') && !low.includes('endorse') && !/^\d+$/.test(s);
  return { name: valid ? s : '', endorsements: endMatch ? parseInt(endMatch[1], 10) : null };
}

// Harvest skill names from the main-page Skills section, feeding each raw row to
// addSkill(). Returns false when the section isn't in the DOM. Tiered by layout;
// broad fallbacks fire only when richer selectors yield nothing.
function harvestSkillSection(addSkill) {
  const skillSection = findSkillsSection();
  if (!skillSection) return false;

  const names = [];
  // New LinkedIn layout: skill componentkeys (prefix occasionally changes)
  Array.from(skillSection.querySelectorAll('div[componentkey*="profile.skill" i]'))
    .filter(el => {
      const ck = el.getAttribute('componentkey') || '';
      return !ck.endsWith('-divider') && el.querySelector('p');
    })
    .forEach(item => names.push(item.querySelector('p')?.innerText));

  // Classic layout: skill name is a bold hoverable link per row
  if (names.filter(Boolean).length === 0) {
    skillSection.querySelectorAll(
      'a[data-field="skill_card_skill_topic"] span[aria-hidden="true"], ' +
      '.hoverable-link-text.t-bold span[aria-hidden="true"]'
    ).forEach(el => names.push(el.innerText));
  }
  // Old layout fallback
  if (names.filter(Boolean).length === 0) {
    skillSection.querySelectorAll('.t-bold span[aria-hidden="true"]').forEach(el =>
      names.push(el.innerText));
  }

  names.forEach(addSkill);
  return true;
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

// Education section finder — heading lookup, then anchors. Mirrors the
// experience finder so the section is located even when the heading text or
// structure differs across LinkedIn layouts (classic layout uses a
// <div id="education"> anchor inside the section).
function findEducationSection() {
  return findSectionByHeading('Education')
    || document.querySelector('#education')?.closest('section')
    || document.querySelector('a[href*="/details/education"]')?.closest('section')
    || null;
}

function extractEducation() {
  const education = [];
  const section = findEducationSection();
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

// Licenses & certifications (doc §3.1) — name, issuing body, issue/expiry dates.
// Feeds the §4 "Required Certifications" auto-scheduling gate. LinkedIn renders
// the section heading as "Licenses & certifications" (older: "Certifications").
function extractCertifications() {
  const certs = [];
  const section = findSectionByHeading('Licenses & certifications')
    || findSectionByHeading('Licenses and certifications')
    || findSectionByHeading('Certifications')
    || document.querySelector('#licenses_and_certifications')?.closest('section');
  if (!section) return certs;
  getSectionItems(section).forEach(item => {
    const editLink = item.querySelector('a[href*="edit/forms/"]');
    const ps = editLink ? editLink.querySelectorAll('p') : item.querySelectorAll('p');
    const name   = ps[0]?.innerText.trim() || '';
    const issuer = ps[1]?.innerText.trim() || '';
    // Dates line looks like "Issued Jun 2021 · Expires Jun 2024" — take the first
    // <p> that carries an issue/expiry marker or a year.
    let dates = '';
    for (const p of ps) {
      const t = (p.innerText || '').trim();
      if (/issued|expires|\b(?:19|20)\d{2}\b/i.test(t)) { dates = t; break; }
    }
    if (name && !/^show all/i.test(name)) certs.push({ name, issuer, dates });
  });
  return certs;
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
        // Full role text → scorer mines skill keywords from the description.
        const description = (li.innerText || '').trim();
        if (title) experience.push({ title, company: companyName, dates, description });
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
      const description = (item.innerText || '').trim();
      if (title) experience.push({ title, company: companyName, dates, description });
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
      const description = (item.innerText || '').trim();
      if (title) experience.push({ title, company, dates, description });
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

// Topcard fields (name / headline / location). Separate from extractProfile so
// scrollAndExtract can capture them BEFORE scrolling — LinkedIn unloads the
// topcard when it leaves the viewport, so a read at the bottom of the scroll
// (or before the topcard finishes reloading at the top) returns blanks. This
// was why location came back empty on some devices: only reload timing differs.
function extractTopcard() {
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

  return { name, title, location };
}

function extractProfile() {
  const { name, title, location } = extractTopcard();

  // Experience
  const experience = extractExperience();

  // Skills — Source 1: Skills section on main page
  const seen = new Set();
  const skills = [];
  const endorsements = {};   // skill name (lowercased) → endorsement count, when shown

  function addSkill(raw) {
    const { name, endorsements: n } = cleanSkillRow(raw);
    if (!name) return;
    const low = name.toLowerCase();
    if (seen.has(low)) return;
    seen.add(low);
    skills.push(name);
    if (n != null) endorsements[low] = n;
  }

  if (harvestSkillSection(addSkill)) {
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
  const certifications = extractCertifications();
  const openToWork = extractOpenToWork();

  // Clearance from about + skills + title + experience bullets + certifications —
  // highest level found. Candidates often state clearance in a role description
  // ("Active Secret clearance"), so experience text must be scanned too or a
  // cleared candidate reads as "None". Mirrors the scorer's detectClearance.
  const clearance = detectClearance([
    about,
    (skills || []).join(" "),
    title,
    (experience || []).map(e => e && e.description).filter(Boolean).join("\n"),
    (certifications || []).map(c => `${c.name || ""} ${c.issuer || ""}`).join("\n"),
  ].filter(Boolean).join("\n"));

  return {
    source: "linkedin",
    name, title, location, skills, endorsements, experience_years, clearance,
    profileUrl: window.location.href.split('?')[0],
    experience, about, education, certifications, openToWork
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
  // Generic fallback — any mention of clearance/cleared without a named level.
  { label: "Clearance",    re: /\bclear(?:ance|ence|ances|ences)\b|\bcleared\b|\bclearable\b/i },
];
function detectClearance(text) {
  if (!text) return "";
  for (const lvl of CLEARANCE_LEVELS) if (lvl.re.test(text)) return lvl.label;
  return "";
}

// Tech-keyword scan over free text (experience descriptions, About) → skills.
// LinkedIn's Skills section is often thin/curated; the real stack shows up in the
// role write-ups. Mirrors the scorer's TOOL_KEYWORDS / findKeywords and Dice's
// RESUME_SKILL_KEYWORDS so client-derived skills match what the scorer extracts.
const TEXT_SKILL_KEYWORDS = [
  "AWS","Azure","GCP","Docker","Kubernetes","Terraform","Jenkins","CI/CD","Linux","Ansible","Helm",
  "Java","Python","JavaScript","TypeScript","React","Angular","Vue","Spring Boot","Node.js","Flask","Django","FastAPI",".NET","C#","C++","Go","Rust","GraphQL",
  "SQL","Power BI","Power Apps","Power Automate","SharePoint","DAX","Power Query","Spark","ETL","Kafka","dbt","Airflow","Databricks","Snowflake","Tableau","Looker","MongoDB","PostgreSQL","MySQL","Redis","Elasticsearch","Neo4j",
  "LLM","GPT","OpenAI","LangChain","TensorFlow","PyTorch","Scikit","RAG",
  "Top Secret","TS/SCI","Secret clearance","FISMA","FedRAMP","NIST","DISA","STIGs",
  "REST","API","Microservices","Git","Maven","Hibernate","JUnit","Selenium","Agile","Scrum","Jira","ServiceNow","Salesforce","AEM",
];
const TEXT_CASE_SENSITIVE = new Set(["Go","Rust","React","Spark","Helm","DAX","RAG","Secret clearance"]);
function skillsFromText(text) {
  if (!text) return [];
  // Spaced variant "Fast API" is the same skill as the "FastAPI" keyword.
  text = text.replace(/\bFast\s+API\b/gi, "FastAPI");
  const found = [];
  for (const kw of TEXT_SKILL_KEYWORDS) {
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Skip the leading word-boundary check for keywords starting with a non-alphanumeric
    // char (".NET") so they still match mid-token ("ASP.NET").
    const lead = /^[A-Za-z0-9]/.test(kw) ? "(?<![A-Za-z0-9])" : "";
    const re = new RegExp(`${lead}${esc}s?(?![A-Za-z0-9+#])`, TEXT_CASE_SENSITIVE.has(kw) ? "" : "i");
    if (re.test(text) && !found.includes(kw)) found.push(kw);
  }
  return found;
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

// quiet = a background ranking read. Nothing in the score uses email or phone, so
// the modal fallback is skipped: clicking the contact link navigates to the
// /overlay/ route on the current layout, which flashes a full-screen overlay and
// then needs a history.back() to undo — visible churn, and a navigation that can
// race the next profile the walk is about to load.
async function extractContactInfo(quiet = false) {
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
      if (quiet) {
        console.log('[SCOUT] quiet read — keeping fetched contact, skipping modal');
        return { email: fetchedEmail, phone: fetchedPhone, sawOverlay: true };
      }
      console.log('[SCOUT] fetch missing phone — opening modal to complete');
    } else {
      console.log('[SCOUT] fetch status', res.status, '— falling back to modal');
    }
  } catch (e) {
    console.log('[SCOUT] fetch failed:', e.message, '— falling back to modal');
  }

  // Strategy B is click-and-navigate; a ranking read never gets there, including
  // when the fetch above failed outright.
  if (quiet) {
    console.log('[SCOUT] quiet read — no contact modal');
    return { email: fetchedEmail, phone: fetchedPhone, sawOverlay: true };
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

    // Capture skills as the section scrolls into view. LinkedIn virtualizes the
    // Skills section out of the DOM once scrolled well past it, so extractProfile()
    // at the bottom of the scroll can find no section at all ("Skills section NOT
    // found"). Harvest incrementally each step and merge in below.
    const capturedSkills = [];
    const capturedSeen = new Set();
    function captureSkills() {
      harvestSkillSection(raw => {
        const { name } = cleanSkillRow(raw);
        const low = name.toLowerCase();
        if (name && !capturedSeen.has(low)) { capturedSeen.add(low); capturedSkills.push(name); }
      });
    }

    // Capture OTW before scrolling — topcard lazy-unloads when scrolled out of viewport
    const capturedOpenToWork = extractOpenToWork();
    console.log('[SCOUT] OpenToWork (pre-scroll):', capturedOpenToWork);

    // Capture the whole topcard pre-scroll too — the topcard unloads when scrolled
    // out, so extractProfile() at the bottom of the scroll can read empty name/
    // title/location and miss a clearance stated in the headline. Restored below
    // for any field that comes back blank.
    const capturedTopcard = extractTopcard();
    console.log('[SCOUT] Topcard (pre-scroll):', capturedTopcard);

    // Capture education/certifications as their sections scroll into view —
    // same virtualization problem as skills: by the bottom of the scroll the
    // sections can be out of the DOM, and on slow devices they may not have
    // rendered yet when a single bottom-of-scroll read happens.
    let capturedEducation = [];
    let capturedCerts = [];
    function captureSections() {
      const edu = extractEducation();
      if (edu.length > capturedEducation.length) capturedEducation = edu;
      const certs = extractCertifications();
      if (certs.length > capturedCerts.length) capturedCerts = certs;
    }

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
        captureSkills();
        captureSections();
        if (pos < maxScroll) {
          step();
        } else {
          const profile = extractProfile();
          if (capturedAbout) profile.about = capturedAbout;
          // Merge skills captured mid-scroll (section may be virtualized out now).
          if (capturedSkills.length) {
            const have = new Set(profile.skills.map(s => s.toLowerCase()));
            capturedSkills.forEach(s => { if (!have.has(s.toLowerCase())) profile.skills.push(s); });
            console.log(`[SCOUT] merged ${capturedSkills.length} scroll-captured skills; total ${profile.skills.length}`);
          }
          // Restore topcard fields lost to the topcard unloading mid-scroll.
          if (!profile.name && capturedTopcard.name) profile.name = capturedTopcard.name;
          if (!profile.title && capturedTopcard.title) profile.title = capturedTopcard.title;
          if (!profile.location && capturedTopcard.location) profile.location = capturedTopcard.location;
          // Prefer the scroll-captured education/certs when the bottom-of-scroll
          // read saw fewer items (section virtualized out or not yet rendered).
          if (capturedEducation.length > (profile.education?.length || 0)) profile.education = capturedEducation;
          if (capturedCerts.length > (profile.certifications?.length || 0)) profile.certifications = capturedCerts;
          profile.openToWork = capturedOpenToWork;

          // After scrolling back to the top the topcard reloads — one last read
          // there fills any field that was blank both pre-scroll and at bottom
          // (e.g. panel opened mid-render so the pre-scroll capture was empty).
          const finish = () => {
            if (!profile.name || !profile.title || !profile.location) {
              const tc = extractTopcard();
              if (!profile.name && tc.name) profile.name = tc.name;
              if (!profile.title && tc.title) profile.title = tc.title;
              if (!profile.location && tc.location) profile.location = tc.location;
            }
            resolve(profile);
          };

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
              setTimeout(finish, 700);
            }, 1200);
          } else {
            window.scrollTo(0, 0);
            mainEl.scrollTop = 0;
            setTimeout(finish, 700);
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

// quiet = the panel is driving a hidden worker tab (ranking a search page). The
// session write and requestPanelOpen are skipped so those background reads can't
// hijack the panel or overwrite the candidate the recruiter is looking at.
function runExtraction(force = false, quiet = false) {
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
    let contact = await extractContactInfo(quiet);
    if (!contact.email && !contact.phone && !contact.sawOverlay) {
      // Never found the link/modal — topcard likely mid-re-render (lazy reload
      // after scroll, or the side panel opening reflowed the page). One retry
      // after the layout settles. Skipped when the overlay WAS found but empty:
      // that's a profile with no public contact info, not a timing miss.
      console.log('[SCOUT] contact info overlay never found — retrying once');
      await new Promise(r => setTimeout(r, 1500));
      contact = await extractContactInfo(quiet);
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

    // Education loses the same lazy-render race on slower machines. If still
    // empty, scroll its section into view and poll until items stream in.
    if (!profile.education || profile.education.length === 0) {
      console.log('[SCOUT] education empty after scroll — waiting for lazy render');
      let edu = extractEducation();
      const start = Date.now();
      while (edu.length === 0 && Date.now() - start < 5000) {
        findEducationSection()?.scrollIntoView({ block: 'center' });
        await new Promise(r => setTimeout(r, 300));
        edu = extractEducation();
      }
      if (edu.length > 0) profile.education = edu;
      console.log(`[SCOUT] education retry: ${edu.length} items after ${Date.now() - start}ms`);
      window.scrollTo(0, 0);
    }

    if (!profile.about) {
      profile.about = await fetchAbout();
    }

    await expandAndExtractAllSkills(profile);

    // Mine skills from every experience description + About — the Skills section
    // is often thin, but the real stack is written up in the role bullets. Merge
    // the keyword hits into the DOM skills, de-duped case-insensitively.
    const expText = (profile.experience || []).map(e => e && e.description).filter(Boolean).join("\n");
    const textSkills = skillsFromText([expText, profile.about].filter(Boolean).join("\n"));
    if (textSkills.length) {
      profile.skills = Array.isArray(profile.skills) ? profile.skills : [];
      const seen = new Set(profile.skills.map(s => String(s).toLowerCase()));
      for (const s of textSkills) if (!seen.has(s.toLowerCase())) { profile.skills.push(s); seen.add(s.toLowerCase()); }
      console.log(`[SCOUT] +${textSkills.length} skills mined from experience/about`);
    }

    // Recompute clearance now that About + the full skills list are populated.
    // The first extractProfile() runs inside scrollAndExtract, before fetchAbout()
    // and expandAndExtractAllSkills() finish — on slower devices that first pass
    // sees empty About / partial skills and misses a résumé-stated clearance,
    // which then also zeroes the clearance score. Re-scan the complete profile.
    const clr = detectClearance([
      profile.about,
      (profile.skills || []).join(" "),
      profile.title,
      (profile.experience || []).map(e => e && e.description).filter(Boolean).join("\n"),
      (profile.certifications || []).map(c => `${c.name || ""} ${c.issuer || ""}`).join("\n"),
    ].filter(Boolean).join("\n"));
    if (clr) profile.clearance = clr;

    console.log('[SCOUT] LinkedIn parsed:', profile, '| clearance:', profile.clearance || 'None');
    if (!quiet) {
      chrome.storage.session.set({ scout_candidate: profile });
      // Extraction finished — surface the result in the side panel.
      requestPanelOpen();
    }
    return profile;
  })().finally(() => { extractionSettled = true; });
  return extractionPromise;
}

// ── Global search ─────────────────────────────────────────────────────────────
// Types a query into LinkedIn's nav search box and submits it, so picking a JD
// in the panel lands the recruiter on that JD's people-search results.
// The input is React-controlled: assigning .value directly is ignored, so the
// native value setter is used and an input event is dispatched to sync React's
// internal state before Enter is sent.

const SEARCH_INPUT_SELECTORS = [
  'input[data-testid="typeahead-input"]',
  '#global-nav-typeahead input',
  'input[aria-autocomplete="list"][placeholder="Search"]',
  'div[role="search"] input',
];

const PEOPLE_SEARCH_URL = 'https://www.linkedin.com/search/results/people/?keywords=';

function findSearchInput() {
  for (const sel of SEARCH_INPUT_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }
  return null;
}

// The search box collapses to a button on narrow viewports — expand it first.
async function revealSearchInput() {
  let input = findSearchInput();
  if (input) return input;

  const trigger = [...document.querySelectorAll('button')]
    .find(b => /^search/i.test((b.getAttribute('aria-label') || '').trim()));
  if (trigger) {
    trigger.click();
    await new Promise(r => setTimeout(r, 300));
    input = findSearchInput();
  }
  return input;
}

function setNativeValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function pressEnter(el) {
  for (const type of ['keydown', 'keypress', 'keyup']) {
    el.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
    }));
  }
  // Some layouts wrap the input in a real form — submit covers that path.
  el.form?.requestSubmit?.();
}

// searchLinkedIn focuses the nav search box to type the JD title into it. That
// focus survives the results navigation, so when the panel hands the tab back at
// the end of a ranking run LinkedIn re-opens the typeahead — it reads as the
// search icon being clicked on its own. Give the focus back to the page.
function dismissSearchUI() {
  const active = document.activeElement;
  if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) active.blur();
  document.body?.focus?.();
  return { ok: true };
}

const onPeopleResults = () => /\/search\/results\/people/.test(location.pathname);

// Enter in the nav search lands on the blended /search/results/all/ page (jobs,
// posts, groups, then people). Recruiters want the People vertical, so the
// "People" filter pill in the results toolbar is clicked for them.
function findPeopleFilter() {
  const links = [...document.querySelectorAll('a[href*="/search/results/people/"]')];
  return (
    links.find(a => /^filter by people$/i.test((a.getAttribute('aria-label') || '').trim())) ||
    // Fallback: the pill's own label text, ignoring the canned-search links
    // ("89 school alumni work here") that also point at people results.
    links.find(a => /^people$/i.test((a.innerText || '').trim())) ||
    null
  );
}

async function selectPeopleTab(query) {
  if (onPeopleResults()) return 'already-people';

  // The toolbar renders after the results payload — poll briefly for the pill.
  let pill = null;
  for (let i = 0; i < 20 && !pill; i++) {           // ~3s
    pill = findPeopleFilter();
    if (!pill) await new Promise(r => setTimeout(r, 150));
  }

  if (pill) {
    pill.click();
    for (let i = 0; i < 20; i++) {                  // ~3s for the SPA route swap
      if (onPeopleResults()) return 'pill';
      await new Promise(r => setTimeout(r, 150));
    }
  }

  // Pill missing or click didn't route — go straight to the people URL.
  location.assign(PEOPLE_SEARCH_URL + encodeURIComponent(query));
  return 'url';
}

// ── Locations filter ──────────────────────────────────────────────────────────
// When the JD states a location, the people results are narrowed to it the same
// way a recruiter would: open the "Locations" pill, type the place, pick the
// suggestion, apply. Driven from the panel right after the People tab is showing.
//
// Everything here is best-effort — LinkedIn ships layout changes constantly, and a
// missed filter must degrade to "unfiltered results", never to a thrown error that
// takes the ranking down with it. Each step reports what it found via [SCOUT] logs.

// offsetParent is null for every position:fixed element, and LinkedIn renders the
// filter dropdown as a fixed popover — so an offsetParent check throws away the
// whole menu. getClientRects() is the honest "is this laid out on screen" test.
const visible = (el) => !!el && el.getClientRects().length > 0;

function findLocationPill() {
  return (
    document.querySelector('[componentkey="SearchResults_filter_pill_geoUrn"]') ||
    [...document.querySelectorAll('[role="button"], [role="radio"], button')]
      .find(el => /^filter by locations$/i.test((el.getAttribute('aria-label') || '').trim())) ||
    null
  );
}

// The pill's own click target is the <label>; the checkbox behind it is
// tabindex="-1" and clicking the wrapper div alone doesn't always open the menu.
function openLocationPill(pill) {
  realClick(pill.querySelector('label') || pill);
}

// The menu is rendered into a floating-ui portal at the end of <body>, not inside
// the pill: <div data-floating-ui-portal><div popover="manual"> … </div></div>.
// Everything below is scoped to that portal so the page's own search box, filter
// pills and result cards can never be mistaken for menu parts.
function findLocationMenu() {
  const portals = [...document.querySelectorAll('[data-floating-ui-portal]')].filter(visible);
  return portals.find(p => p.querySelector('input[data-testid="typeahead-input"]')) ||
         portals[portals.length - 1] || null;
}

// The menu's own typeahead: placeholder "Add a location". It shares the
// data-testid with the nav search box, so the nav one is excluded by componentkey.
function findLocationInput() {
  const menu = findLocationMenu();
  const scope = menu || document;
  const inputs = [...scope.querySelectorAll('input')]
    .filter(el => visible(el) && el.getAttribute('componentkey') !== 'SearchResults_SearchTyahInputRef');
  return (
    inputs.find(el => /location|city|region|place/i.test(
      `${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''}`)) ||
    inputs.find(el => el.getAttribute('data-testid') === 'typeahead-input') ||
    inputs[0] || null
  );
}

// LinkedIn's SDUI controls are React components on role="button" divs and labels.
// A bare .click() only fires a click event; these listen for the pointer/mouse
// sequence, so the handler never runs and the menu just sits there. Replay the
// full sequence a real click produces.
function realClick(el) {
  if (!el) return false;
  el.scrollIntoView?.({ block: 'center' });
  const opts = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
  for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown',
                      'pointerup', 'mouseup', 'click']) {
    const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, opts));
  }
  return true;
}

// The menu's typeahead is a React input that floating-ui renders with
// tabindex="-1" until it takes focus. A bare .focus() + value assignment leaves it
// empty and the menu keeps showing its DEFAULT suggestions (recent locations),
// which is indistinguishable from "typed but no matches". Click it first, then
// drive it one character at a time with the events a real keyboard produces.
async function typeIntoTypeahead(input, text) {
  realClick(input);
  input.focus();

  // execCommand routes through the browser's real editing pipeline, so the
  // component gets genuine beforeinput/input events instead of a synthetic
  // dispatch it is free to ignore. Assigning .value alone updates the pixels but
  // leaves the typeahead's state empty, which shows up as "the menu still lists
  // the default suggestions".
  input.setSelectionRange?.(0, input.value.length);
  if (input.value) document.execCommand('delete', false);
  if (input.value) setNativeValue(input, '');

  for (const ch of text) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    if (!document.execCommand('insertText', false, ch) || !input.value.endsWith(ch)) {
      setNativeValue(input, input.value + ch);
    }
    input.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
    await new Promise(r => setTimeout(r, 70));
  }

  if (input.value !== text) setNativeValue(input, text);
  return input.value === text;
}

async function waitFor(fn, tries = 20, gap = 150) {
  for (let i = 0; i < tries; i++) {
    const found = fn();
    if (found) return found;
    await new Promise(r => setTimeout(r, gap));
  }
  return null;
}

// Pick the suggestion that matches what was typed. Options are checkbox rows in
// the SDUI layout and role="option" rows in the classic one.
//
// Never falls back to "the first row". The typeahead keeps stale results on screen
// while it fetches, and it also offers unrelated places, so a blind first-row click
// filters the search to the wrong city — worse than not filtering at all. No match
// means no click.
function locationOptionRows() {
  const menu = findLocationMenu();
  if (!menu) return [];
  return [...menu.querySelectorAll('[role="checkbox"][aria-label]')].filter(visible);
}

function checkedLocationRows() {
  const menu = findLocationMenu();
  if (!menu) return [];
  return [...menu.querySelectorAll('[role="checkbox"][aria-checked="true"]')].filter(visible);
}

// LinkedIn keeps previously applied geo facets ticked (a stale "United States" is
// common). Facets ADD to each other, so leaving one on would search the JD's
// location OR that one. Clear the menu before selecting, via its own Reset button;
// if Reset isn't there, untick the boxes directly.
async function resetLocationFilter() {
  if (!checkedLocationRows().length) return true;

  const menu = findLocationMenu() || document;
  const reset = [...menu.querySelectorAll('button, [role="button"], a')]
    .filter(visible)
    .find(el => /^reset\b/i.test((el.innerText || '').replace(/\s+/g, ' ').trim()));

  if (reset) {
    console.log('[SCOUT] location filter: clearing existing selection via Reset');
    realClick(reset);
  } else {
    console.log('[SCOUT] location filter: no Reset — unticking',
      checkedLocationRows().map(el => el.getAttribute('aria-label')));
    for (const row of checkedLocationRows()) realClick(row);
  }

  const cleared = await waitFor(() => checkedLocationRows().length === 0, 16, 150);
  console.log('[SCOUT] location filter: cleared =', !!cleared);
  return !!cleared;
}

// What the menu is currently offering — the one diagnostic that distinguishes
// "typing didn't register" from "LinkedIn has no such place".
function locationOptionNames() {
  const menu = findLocationMenu();
  if (!menu) return '(no menu)';
  return [...menu.querySelectorAll('[role="checkbox"][aria-label]')]
    .filter(visible)
    .map(el => el.getAttribute('aria-label'));
}

// Suggestions are checkbox rows carrying the place name on aria-label:
//   <div role="checkbox" aria-label="Hyderabad, Telangana, India" aria-checked="false">
// Compare on a normalized form: lowercase, accents stripped, punctuation reduced
// to spaces. "Washington, D.C." and "Washington DC" have to read as the same place.
function normPlace(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function findLocationOption(text) {
  const want = normPlace(text);
  if (!want) return null;
  const menu = findLocationMenu();
  if (!menu) return null;

  const rows = [...menu.querySelectorAll('[role="checkbox"][aria-label]')].filter(visible);
  const nameOf = (el) => normPlace(el.getAttribute('aria-label'));
  const wantTokens = want.split(' ').filter(Boolean);

  // The JD gives a state, so the state-level row wins: "Virginia" →
  // "Virginia, United States", never "Virginia Beach, Virginia, United States".
  // After that it loosens: bare name → metro area → prefix → whole word →
  // every word of the query present.
  return (
    rows.find(el => nameOf(el) === want + ' united states') ||
    rows.find(el => nameOf(el) === want) ||
    rows.find(el => nameOf(el) === 'greater ' + want + ' area') ||
    rows.find(el => nameOf(el).startsWith(want + ' ')) ||
    rows.find(el => new RegExp(`(^| )${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(nameOf(el))) ||
    rows.find(el => {
      const tokens = new Set(nameOf(el).split(' '));
      return wantTokens.every(t => tokens.has(t));
    }) ||
    null
  );
}

// "Show results" is an ANCHOR in this layout, not a button:
//   <a href="/search/results/people/?keywords=…&geoUrn=…&origin=FACETED_SEARCH">Show results</a>
// A button-only query never finds it. The href is also the finished filtered
// search, which makes navigating to it far more reliable than clicking and hoping
// the SPA handler fires.
function findApplyControl() {
  const scope = findLocationMenu() || document;
  const controls = [...scope.querySelectorAll('a, button, [role="button"]')].filter(visible);
  const nameOf = (el) =>
    `${(el.innerText || '').replace(/\s+/g, ' ').trim()} ${el.getAttribute('aria-label') || ''}`.toLowerCase();

  const usable = controls.filter(el =>
    !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !/^reset\b/.test(nameOf(el)));

  return (
    usable.find(el => /\bshow results?\b/.test(nameOf(el))) ||
    usable.find(el => /apply current filter/.test(nameOf(el))) ||
    usable.find(el => /^(apply|done)\b/.test(nameOf(el).trim())) ||
    null
  );
}

// "Did the filter take?" — the URL facet is the strongest signal, but the SPA
// doesn't always put it there, so the pill's own state counts too: once a location
// is applied the pill reads "Locations (1)" / shows as checked.
function locationFilterActive() {
  if (/[?&]geoUrn=/.test(location.href)) return true;

  const pill = findLocationPill();
  if (!pill) return false;
  if (pill.getAttribute('aria-checked') === 'true') return true;
  const box = pill.querySelector('input[type="checkbox"]');
  if (box && box.checked) return true;
  // Applied pills carry a count: "Locations (1)".
  return /\(\s*\d+\s*\)/.test(pill.innerText || '');
}

async function applyLocationFilter(location) {
  const want = String(location || '').trim();
  if (!want) return { ok: false, error: 'no location' };
  if (!onPeopleResults()) return { ok: false, error: 'not on people results' };

  const pill = await waitFor(findLocationPill, 20);
  if (!pill) { console.log('[SCOUT] location filter: pill not found'); return { ok: false, error: 'no pill' }; }

  openLocationPill(pill);

  if (!await waitFor(findLocationInput, 20)) {
    console.log('[SCOUT] location filter: menu input not found');
    return { ok: false, error: 'no input' };
  }

  // Clear any facet left over from a previous search before adding this JD's.
  await resetLocationFilter();

  // Reset can close the menu or re-render its contents, so the pill is reopened
  // when needed and the input is looked up again rather than reused.
  if (!findLocationMenu()) openLocationPill(findLocationPill() || pill);
  const input = await waitFor(findLocationInput, 20);
  if (!input) {
    console.log('[SCOUT] location filter: menu input gone after reset');
    return { ok: false, error: 'no input' };
  }

  // Queries to try in order. The full name first; then the leading word, which
  // covers the case where the typeahead has the place under a different tail
  // ("Texas" vs "Texas Metropolitan Area") and the case where a multi-word query
  // returns nothing at all.
  const queries = [want];
  const head = want.split(/[,\s]+/)[0];
  if (head && head.toLowerCase() !== want.toLowerCase()) queries.push(head);

  // Rows before typing: LinkedIn's default suggestions. Taking "the top result"
  // only makes sense once this list has been replaced by query results.
  const defaults = locationOptionNames().join('|');

  let option = null;
  let lastOffered = [];
  for (const q of queries) {
    await typeIntoTypeahead(input, q);
    console.log('[SCOUT] location filter: typed', JSON.stringify(input.value), 'for', q);

    // ~6s for the typeahead to answer: a matching row, or any refresh of the list.
    await waitFor(() => findLocationOption(want) || findLocationOption(q) ||
                        locationOptionNames().join('|') !== defaults, 30, 200);
    lastOffered = locationOptionNames();

    // State-level row preferred; otherwise the top result of a refreshed list.
    option = findLocationOption(want) || findLocationOption(q) ||
             (lastOffered.join('|') !== defaults ? locationOptionRows()[0] : null);
    if (option) break;
    console.log('[SCOUT] location filter: nothing matched', q, '| offered:', lastOffered);
  }

  // No relevant suggestion → leave the search alone rather than filtering it to
  // somewhere the JD never asked for.
  if (!option) {
    console.log('[SCOUT] location filter: giving up on', want,
      '| input value:', JSON.stringify(input.value),
      '| offered:', lastOffered);
    return {
      ok: false,
      // Carried back to the panel so the reason is visible without devtools.
      error: input.value ? 'no match for typed text' : 'typing did not register',
      typed: input.value,
      offered: Array.isArray(lastOffered) ? lastOffered.slice(0, 6) : [],
    };
  }
  const optionName = (option.getAttribute('aria-label') || '').trim();
  console.log('[SCOUT] location filter: selecting', optionName);
  realClick(option);

  // Confirm the row actually ticked; the checkbox behind it is the source of truth.
  const ticked = await waitFor(
    () => option.getAttribute('aria-checked') === 'true' ||
          option.querySelector('input[type="checkbox"]')?.checked,
    12, 150);
  if (!ticked) {
    // Fall back to the row's own label/checkbox before giving up on it.
    const label = option.querySelector('label');
    if (label) realClick(label);
    await new Promise(r => setTimeout(r, 300));
  }
  console.log('[SCOUT] location filter: selected =',
    option.getAttribute('aria-checked') === 'true' || !!ticked);

  // "Show results" is an anchor whose href is the finished faceted search. Wait
  // for the geo facet to appear in it (LinkedIn rewrites the href as boxes are
  // ticked), then navigate — that applies the filter without depending on the
  // SPA's click handler firing.
  const apply = await waitFor(findApplyControl, 16);
  if (!apply) {
    console.log('[SCOUT] location filter: no apply control. Visible menu controls:',
      [...(findLocationMenu() || document).querySelectorAll('a, button, [role="button"]')]
        .filter(visible)
        .map(el => `<${el.tagName.toLowerCase()}> "${(el.innerText || '').replace(/\s+/g, ' ').trim()}" href="${el.getAttribute('href') || ''}"`)
        .slice(0, 20));
    return { ok: false, error: 'no apply control' };
  }

  const facetHref = await waitFor(() => {
    const href = apply.getAttribute('href') || '';
    return /geoUrn=/.test(href) ? href : null;
  }, 16, 200);

  // Navigating from here would tear down this page mid-call and the reply would
  // never reach the panel. Hand the URL back instead and let the panel drive the
  // tab, which also lets it wait for the new results properly.
  if (facetHref) {
    const url = new URL(facetHref, location.origin).href;
    console.log('[SCOUT] location filter: faceted URL', url);
    return { ok: true, location: want, selected: optionName, url };
  }

  console.log('[SCOUT] location filter: no faceted href — clicking',
    `"${(apply.innerText || '').trim()}"`);
  realClick(apply);

  // Confirm it took, then let the new list settle before it's scraped.
  const applied = await waitFor(locationFilterActive, 24, 250);
  await new Promise(r => setTimeout(r, applied ? 1500 : 600));

  console.log('[SCOUT] location filter', applied ? 'applied:' : 'NOT confirmed for:', want);
  return {
    ok: !!applied,
    error: applied ? undefined : 'clicked apply but filter never took',
    location: want, confirmed: !!applied, selected: optionName,
  };
}

async function searchLinkedIn(query) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'empty query' };

  const input = await revealSearchInput();
  if (!input) {
    // No nav search on this page (overlays, some SPA routes) — go straight to
    // the results URL so the recruiter still ends up on the right search.
    location.assign(PEOPLE_SEARCH_URL + encodeURIComponent(q));
    return { ok: true, via: 'url' };
  }

  input.focus();
  setNativeValue(input, q);
  await new Promise(r => setTimeout(r, 250));   // let the typeahead register the value
  pressEnter(input);

  // If Enter didn't navigate (typeahead swallowed it), fall back to the URL.
  await new Promise(r => setTimeout(r, 1200));
  if (!/\/search\/results\//.test(location.pathname)) {
    location.assign(PEOPLE_SEARCH_URL + encodeURIComponent(q));
    return { ok: true, via: 'url-fallback' };
  }

  const people = await selectPeopleTab(q);
  return { ok: true, via: 'typeahead', people };
}

// ── People-results scraping ───────────────────────────────────────────────────
// Reads the candidate cards off /search/results/people/ to get the roster of who
// is on the page (name + profile URL, with the card's headline/location/snippet
// as a display fallback). Scoring never uses this — the panel walks these URLs
// and reads each real profile.

const PROFILE_SNIPPET_RE = /^(summary|current|past)\s*:/i;

function cardText(el) {
  return (el.innerText || '').replace(/\s+/g, ' ').trim();
}

function scrapePeopleResults() {
  if (!onPeopleResults()) return { ok: false, error: 'not on people results' };

  const seen = new Set();
  const people = [];

  for (const item of document.querySelectorAll('[role="listitem"]')) {
    const link = item.querySelector('a[href*="/in/"]');
    if (!link) continue;                                  // upsell / filler card

    const url  = link.href.split('?')[0];
    const slug = (url.match(/\/in\/([^/?#]+)/) || [])[1];
    if (!slug || seen.has(slug)) continue;                // same person twice
    seen.add(slug);

    // Card paragraphs in DOM order: name(+degree), headline, location, then the
    // keyword snippet and social proof ("X is a mutual connection", follower
    // counts) which are not part of the candidate's own text.
    const texts = [...item.querySelectorAll('p')].map(cardText).filter(Boolean);
    if (!texts.length) continue;

    const degree = (texts[0].match(/•\s*(1st|2nd|3rd\+?)/i) || [])[1] || '';
    const name   = texts[0].replace(/\s*•.*$/, '').trim();

    const rest = texts.slice(1).filter(t => !/mutual connection|followers?\b/i.test(t));
    const snipAt = rest.findIndex(t => PROFILE_SNIPPET_RE.test(t));
    const meta   = snipAt === -1 ? rest : rest.slice(0, snipAt);

    people.push({
      name,
      url,
      slug,
      degree,
      title:    meta[0] || '',
      location: meta[1] || '',
      // Snippet is LinkedIn's own keyword-matched excerpt of the profile — the
      // richest skill signal a search card carries.
      snippet:  snipAt === -1 ? '' : rest.slice(snipAt).join(' '),
    });
  }

  return { ok: true, people, query: new URLSearchParams(location.search).get('keywords') || '' };
}

// ── Tab-free profile read ─────────────────────────────────────────────────────
// Fetches a profile's HTML from the search-results page itself — same origin, so
// the session cookies ride along and no tab is ever opened. What the server
// renders is the JSON-LD Person block plus the About text; the Skills section is
// client-rendered and therefore absent, so skills are keyword-scanned out of the
// headline, About, and role list (same scan the live extraction uses).

function jsonLdPerson(doc) {
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data  = JSON.parse(script.textContent || '');
      const nodes = data['@graph'] || (Array.isArray(data) ? data : [data]);
      const person = nodes.find(n => n && n['@type'] === 'Person');
      if (person) return person;
    } catch (_) { /* malformed block — try the next one */ }
  }
  return null;
}

// worksFor entries carry the role and, when the server includes them, start/end
// dates. Rendered into the "2021 - Present" shape calcExperienceYears parses.
function experienceFromJsonLd(person) {
  const out = [];
  for (const job of [].concat(person?.worksFor || [])) {
    if (!job) continue;
    const m     = job.member || {};
    const start = (m.startDate || '').toString().slice(0, 4);
    const end   = (m.endDate   || '').toString().slice(0, 4);
    out.push({
      company:     job.name || '',
      title:       m.jobTitle || job.description || '',
      dates:       start ? `${start} - ${end || 'Present'}` : '',
      description: [job.description, m.description].filter(Boolean).join(' '),
    });
  }
  return out;
}

async function fetchProfileLite(url) {
  try {
    const res = await fetch(url.split('?')[0], {
      credentials: 'include', headers: { accept: 'text/html' },
    });
    if (!res.ok) return null;

    const doc    = new DOMParser().parseFromString(await res.text(), 'text/html');
    const person = jsonLdPerson(doc);
    const about  = extractAboutFromDoc(doc) || person?.description || '';

    const jobTitle   = [].concat(person?.jobTitle || [])[0] || '';
    const experience = experienceFromJsonLd(person);
    const addr       = person?.address || {};
    const location   = [addr.addressLocality, addr.addressRegion, addr.addressCountry]
      .filter(Boolean).join(', ');

    const text = [
      jobTitle, about,
      experience.map(e => `${e.title} ${e.company} ${e.description}`).join('\n'),
    ].filter(Boolean).join('\n');

    const profile = {
      name:     person?.name || '',
      title:    jobTitle,
      location,
      about,
      experience,
      skills:   skillsFromText(text),
      experience_years: calcExperienceYears(experience) || 0,
      url,
    };
    const clr = detectClearance(text);
    if (clr) profile.clearance = clr;
    return profile;
  } catch (e) {
    console.log('[SCOUT] fetchProfileLite error:', e.message);
    return null;
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getProfile') {
    runExtraction(!!request.force, !!request.quiet).then(profile => sendResponse({ profile }));
  }
  if (request.action === 'fetchProfileLite') {
    fetchProfileLite(request.url).then(profile => sendResponse({ profile }));
  }
  if (request.action === 'searchJd') {
    searchLinkedIn(request.query).then(sendResponse);
  }
  if (request.action === 'scrapePeopleResults') {
    sendResponse(scrapePeopleResults());
  }
  if (request.action === 'dismissSearchUI') {
    sendResponse(dismissSearchUI());
  }
  if (request.action === 'applyLocationFilter') {
    applyLocationFilter(request.location).then(sendResponse);
  }
  return true;
});

// No auto-start: extraction runs only when the side panel asks (getProfile),
// which happens after the user clicks the extension to open the panel. Once
// the panel is open it re-scans on tab switch / SPA navigation via its own
// chrome.tabs.onUpdated / onActivated listeners.
