// Dice TalentSearch results driver + scraper.
// Injected on demand into https://www.dice.com/employers/talent-search/search
// by the side panel. Two jobs:
//   1. runDiceSearch  — type a Boolean keyword (and optional location) into the
//      search bar exactly as a recruiter would, then submit the form.
//   2. getDiceSearchResults — wait for the result list to render, then return
//      the top N candidate profile URLs (deduped by profile uuid).
//
// Re-injection guard: chrome.scripting.executeScript runs the file again on each
// call, which would otherwise stack onMessage handlers.

(function () {
  if (window.__scoutDiceSearchInjected) return;
  window.__scoutDiceSearchInjected = true;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Dice's search bar is React-controlled — assigning .value directly is
  // ignored. Set via the native setter and fire `input` so React sees it.
  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Location is a Google-Places autocomplete combobox: free text does not
  // commit — a suggestion must be picked. Type, wait for the listbox, click the
  // first option. Best-effort: on timeout the search still runs keyword-only.
  async function fillLocation(location) {
    const input = document.querySelector(
      '#talent-search-search-filter-pending-location-input, input[name="pendingLocation.original"]'
    );
    if (!input) return false;
    input.focus();
    setNativeValue(input, location);
    for (let i = 0; i < 12; i++) {
      await sleep(250);
      const opt = document.querySelector('[role="listbox"] [role="option"]');
      if (opt) { opt.click(); await sleep(400); return true; }
    }
    console.warn('[SCOUT] Dice location suggestion never appeared — keyword-only search');
    return false;
  }

  // Toggle a React Aria visually-hidden checkbox. A bare .click() on the
  // wrapping label is often swallowed by React Aria's usePress (it expects a
  // real pointer interaction), so escalate through three strategies and verify
  // the checked state after each:
  //   1. native .click() on the hidden <input> itself,
  //   2. full pointerdown → mousedown → pointerup → mouseup → click sequence
  //      on the label (what usePress actually listens for),
  //   3. keyboard Space on the focused input.
  async function pressControl(ctl) {
    const isChecked = () => ctl.checked === true || ctl.getAttribute('aria-checked') === 'true';
    const target = ctl.closest('label') || ctl;
    const fire = (el, type, Ctor, extra = {}) =>
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, ...extra }));

    ctl.click();
    await sleep(350);
    if (isChecked()) return true;

    const PE = window.PointerEvent || MouseEvent;
    fire(target, 'pointerover', PE, { pointerId: 1, isPrimary: true, pointerType: 'mouse' });
    fire(target, 'pointerdown', PE, { pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, buttons: 1 });
    fire(target, 'mousedown', MouseEvent, { button: 0, buttons: 1, detail: 1 });
    fire(target, 'pointerup', PE, { pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0 });
    fire(target, 'mouseup', MouseEvent, { button: 0, detail: 1 });
    fire(target, 'click', MouseEvent, { button: 0, detail: 1 });
    await sleep(350);
    if (isChecked()) return true;

    ctl.focus();
    fire(ctl, 'keydown', KeyboardEvent, { key: ' ', code: 'Space', keyCode: 32 });
    fire(ctl, 'keyup', KeyboardEvent, { key: ' ', code: 'Space', keyCode: 32 });
    await sleep(350);
    return isChecked();
  }

  // JD requires a clearance → switch on Dice's "Security Clearance" filter.
  // The control lives in the filters panel ("Dice Profile Filters" accordion →
  // "Security Clearance" disclosure). On narrower layouts that panel is a
  // slide-out drawer opened by the "Apply Filters" button; on xl it renders
  // inline in the left column. Flow:
  //   1. locate the Security Clearance disclosure (open the drawer if needed),
  //   2. expand it and tick the "Has Security Clearance" checkbox
  //      (input[name="onlyWithSecurityClearance"]),
  //   3. close the drawer — the checkbox joins the shared search criteria, so
  //      the caller's single main-form submit runs the fully-filtered query.
  // Best-effort: a miss logs a warning and the search stays unfiltered (the
  // scorer still gates on clearance downstream).
  async function enableClearanceFilter() {
    const findTrigger = () =>
      Array.from(document.querySelectorAll('[data-testid="disclosure-trigger"]'))
        .find(b => /security\s*clearance/i.test(b.textContent || ''));

    let trigger = findTrigger();
    let drawerOpened = false;

    // Trigger missing or inside the closed (inert) drawer → open the drawer.
    if (!trigger || trigger.closest('[inert]')) {
      const open = document.querySelector('[data-testid="apply-filters-button"]');
      if (open) {
        open.click();
        drawerOpened = true;
        await sleep(900);
        trigger = findTrigger();
      }
    }
    if (!trigger) {
      console.warn('[SCOUT] Dice Security Clearance filter not found — searching unfiltered');
      return false;
    }

    // Expand the disclosure.
    if (trigger.getAttribute('aria-expanded') !== 'true') {
      trigger.click();
      await sleep(600);
    }

    // Tick the "Has Security Clearance" checkbox inside the disclosure panel.
    // The real control is a visually-hidden React Aria checkbox:
    //   <input type="checkbox" name="onlyWithSecurityClearance"> inside
    //   <label data-react-aria-pressable>…Has Security Clearance</label>
    // Target it by name first; fall back to label-text matching if Dice
    // renames the field.
    const panelId = trigger.getAttribute('aria-controls');
    const panel = (panelId && document.getElementById(panelId)) || trigger.closest('.SeuiDisclosure');
    let toggled = false;
    if (panel) {
      const controls = Array.from(panel.querySelectorAll(
        'input[type="checkbox"], input[type="radio"], [role="switch"], [role="checkbox"], [role="radio"]'
      ));
      const labelOf = (c) =>
        c.closest('label')?.textContent
        || c.getAttribute('aria-label')
        || (c.id && panel.querySelector(`label[for="${c.id}"]`)?.textContent)
        || '';
      const ctl = panel.querySelector('input[name="onlyWithSecurityClearance"]')
        || document.querySelector('input[name="onlyWithSecurityClearance"]')
        || controls.find(c => /has\s+security\s+clearance/i.test(labelOf(c)))
        || controls.find(c => /security\s+clearance|clearance/i.test(labelOf(c)))
        || controls[0];
      if (ctl) {
        const isChecked = () => ctl.checked === true || ctl.getAttribute('aria-checked') === 'true';
        if (isChecked()) {
          toggled = true;
        } else {
          toggled = await pressControl(ctl);
          await sleep(300);
        }
        if (!toggled) console.warn('[SCOUT] Security Clearance checkbox did not toggle');
      }
    }
    if (!toggled) console.warn('[SCOUT] Security Clearance panel had no toggleable control');

    // Ticking the checkbox adds "Has Security Clearance" to the shared search
    // criteria — no submit here. The caller runs ONE search afterwards with
    // everything included. Just close the drawer if we opened it.
    if (drawerOpened) {
      const close = document.querySelector('[data-testid="talent-search-filters-close-button"]');
      if (close) { close.click(); await sleep(400); }
    }
    return toggled;
  }

  // Click the main search bar's Search submit (aria-label="Search").
  function submitMainSearch() {
    const kw = document.querySelector('input[name="keyword"]');
    const btn = Array.from(document.querySelectorAll('form button[type="submit"]'))
      .find(b => /search/i.test(b.getAttribute('aria-label') || b.textContent || ''));
    if (btn) { btn.click(); return true; }
    if (kw?.form?.requestSubmit) { kw.form.requestSubmit(); return true; }
    return false;
  }

  async function runSearch(keyword, location, clearance) {
    const kw = document.querySelector('input[name="keyword"]');
    if (!kw) return { ok: false, error: 'keyword input not found — is this the TalentSearch page?' };
    kw.focus();
    setNativeValue(kw, keyword);
    await sleep(200);
    if (location) await fillLocation(location);

    // Clearance filter is set BEFORE the search: the checkbox joins the shared
    // criteria, so a single submit runs the fully-filtered query — no re-run.
    if (clearance) await enableClearanceFilter();

    if (!submitMainSearch()) return { ok: false, error: 'search submit button not found' };
    return { ok: true };
  }

  function profileIdOf(href) {
    const m = (href || '').match(/talent-search\/profile\/([0-9a-f-]{8,})/i);
    return m ? m[1].toLowerCase() : '';
  }

  // Collect candidate links from the result list, top-first, deduped by uuid.
  // Result cards link to /employers/talent-search/profile/<uuid>; the first
  // anchor per card is the candidate name.
  function collectResults() {
    const out = [], seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/employers/talent-search/profile/"]')) {
      const id = profileIdOf(a.href);
      if (!id || seen.has(id)) continue;
      const name = (a.textContent || '').trim().split('\n')[0].replace(/\s+/g, ' ').slice(0, 80);
      seen.add(id);
      out.push({ url: `https://www.dice.com/employers/talent-search/profile/${id}`, name });
    }
    return out;
  }

  // Results stream in via XHR after submit (SPA — no page load event). Poll and
  // scroll until we have enough results or the timeout elapses.
  async function scrapeWithScroll(minResults = 5, maxMs = 20000) {
    const start = Date.now();
    let results = collectResults();
    let pos = 0;
    while (results.length < minResults && Date.now() - start < maxMs) {
      pos += 700;
      window.scrollTo(0, pos);
      await sleep(500);
      results = collectResults();
      if (pos > document.body.scrollHeight) pos = 0;
    }
    window.scrollTo(0, 0);
    console.log(`[SCOUT] Dice search scrape: ${results.length} results in ${Date.now() - start}ms`);
    return results.slice(0, minResults);
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'runDiceSearch') {
      runSearch(request.keyword || '', request.location || '', !!request.clearance).then(sendResponse);
      return true;
    }
    if (request.action === 'getDiceSearchResults') {
      scrapeWithScroll(request.count || 5).then(results => sendResponse({ results }));
      return true;
    }
  });
})();
