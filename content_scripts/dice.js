// Dice.com candidate profile parser — extracts name, title, location, skills, experience_years
// Stores result in chrome.storage.session under key "scout_candidate"

function getText(selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  for (const sel of list) {
    try {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim()) return el.innerText.trim();
    } catch (_) {}
  }
  return "";
}

function extractName() {
  return getText([
    '[data-testid="profile-name"]',
    '[data-cy="profile-name"]',
    '.candidate-name',
    '.profile-header h1',
    'h1[class*="name"]',
    'h1[class*="Name"]',
    'h1'
  ]);
}

function extractTitle() {
  return getText([
    '[data-testid="profile-title"]',
    '[data-cy="profile-title"]',
    '.candidate-headline',
    '[class*="headline"]',
    '[class*="Headline"]',
    '.profile-header h2',
    'h2[class*="title"]',
    '[class*="currentPosition"]',
    '[class*="current-position"]'
  ]);
}

function extractLocation() {
  return getText([
    '[data-testid="profile-location"]',
    '[data-cy="profile-location"]',
    '[class*="location"]',
    '[class*="Location"]',
    '.candidate-location',
    '[aria-label*="location" i]',
    'span[class*="city"]'
  ]);
}

function extractSkills() {
  const skills = [];
  const seen = new Set();

  // Strategy 1: skill tags/chips
  const skillSelectors = [
    '[data-testid="skill-tag"]',
    '[data-cy="skill"]',
    '[class*="skill-tag"]',
    '[class*="SkillTag"]',
    '[class*="skill-chip"]',
    '[class*="SkillChip"]',
    '[class*="skills"] li',
    '[class*="Skills"] li',
    '[data-testid="skills-section"] span',
    '[class*="tag"]'
  ];

  for (const sel of skillSelectors) {
    try {
      document.querySelectorAll(sel).forEach(el => {
        const s = el.innerText.trim().split('\n')[0].trim();
        if (s && s.length < 60 && !seen.has(s)) {
          seen.add(s);
          skills.push(s);
        }
      });
    } catch (_) {}
    if (skills.length > 0) break;
  }

  // Strategy 2: look for a "Skills" heading and grab nearby text nodes
  if (skills.length === 0) {
    const headings = document.querySelectorAll('h2, h3, h4, [class*="section-title"]');
    for (const h of headings) {
      if (/skills/i.test(h.innerText)) {
        const section = h.closest('section') || h.parentElement?.parentElement;
        if (section) {
          section.querySelectorAll('span, li, p').forEach(el => {
            const s = el.innerText.trim().split('\n')[0].trim();
            if (s && s.length < 60 && s.length > 1 && !seen.has(s)) {
              seen.add(s);
              skills.push(s);
            }
          });
        }
        break;
      }
    }
  }

  return skills;
}

function extractExperience() {
  const experience = [];

  // Strategy 1: experience section items
  const expSelectors = [
    '[data-testid="experience-item"]',
    '[data-cy="experience"]',
    '[class*="experience-item"]',
    '[class*="ExperienceItem"]',
    '[class*="work-history"] li',
    '[class*="WorkHistory"] li'
  ];

  for (const sel of expSelectors) {
    try {
      const items = document.querySelectorAll(sel);
      if (items.length > 0) {
        items.forEach(item => {
          const ps = item.querySelectorAll('p, span, div');
          const jobTitle = ps[0]?.innerText.trim() || "";
          const company = ps[1]?.innerText.trim() || "";
          const dates = ps[2]?.innerText.trim() || "";
          if (jobTitle) experience.push({ title: jobTitle, company, dates });
        });
        break;
      }
    } catch (_) {}
  }

  // Strategy 2: look for "Experience" heading
  if (experience.length === 0) {
    const headings = document.querySelectorAll('h2, h3, h4, [class*="section-title"]');
    for (const h of headings) {
      if (/experience/i.test(h.innerText) && !/years/i.test(h.innerText)) {
        const section = h.closest('section') || h.parentElement?.parentElement;
        if (section) {
          const items = section.querySelectorAll('li, [class*="item"]');
          items.forEach(item => {
            const ps = item.querySelectorAll('p, span');
            const jobTitle = ps[0]?.innerText.trim() || "";
            const dates = Array.from(ps).find(p => /\d{4}/.test(p.innerText))?.innerText.trim() || "";
            if (jobTitle && jobTitle.length < 100) {
              experience.push({ title: jobTitle, company: "", dates });
            }
          });
        }
        break;
      }
    }
  }

  return experience;
}

function calcExperienceYears(experience) {
  // Parse "X yr(s) Y mo(s)" or "X years" from date strings
  let totalMonths = 0;
  for (const exp of experience) {
    const m = (exp.dates || '').match(/(\d+)\s*yr[s]?\s*(?:(\d+)\s*mo[s]?)?/);
    if (m) {
      totalMonths += (parseInt(m[1]) || 0) * 12 + (parseInt(m[2]) || 0);
    }
  }
  if (totalMonths > 0) return Math.round(totalMonths / 12 * 10) / 10;

  // Fallback: earliest 4-digit year to now
  let earliest = null;
  const now = new Date().getFullYear();
  for (const exp of experience) {
    const m = (exp.dates || '').match(/\b(19|20)(\d{2})\b/);
    if (m) {
      const y = parseInt(m[0]);
      if (!earliest || y < earliest) earliest = y;
    }
  }

  // Also check for "X years of experience" text anywhere on page
  const bodyText = document.body.innerText;
  const yearsMatch = bodyText.match(/(\d+)\+?\s*years?\s+of\s+experience/i);
  if (yearsMatch) return parseInt(yearsMatch[1]);

  return earliest ? now - earliest : null;
}

function extractProfile() {
  const name = extractName();
  const title = extractTitle();
  const location = extractLocation();
  const skills = extractSkills();
  const experience = extractExperience();
  const experience_years = calcExperienceYears(experience);

  return {
    source: "dice",
    name,
    title,
    location,
    skills,
    experience,
    experience_years,
    profileUrl: window.location.href.split('?')[0]
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getProfile') {
    const profile = extractProfile();
    console.log('[SCOUT] Dice.com parsed:', profile);
    chrome.storage.session.set({ scout_candidate: profile });
    sendResponse({ profile });
  }
  return true;
});
