// SCOUT session recorder — captures every recruiter action on a candidate
// profile (LinkedIn / Dice) and stores Playwright-style events in
// chrome.storage.local. The side panel turns the event log into a runnable
// Playwright .spec.js. Local only: nothing leaves the browser.
//
// Runs in the SAME isolated world as linkedin.js / dice.js, so everything is
// wrapped in an IIFE to avoid clobbering their globals.
(() => {
  "use strict";

  // Guard: the recorder ships as a manifest content script AND can be injected
  // on demand (Record button) into tabs opened before an extension reload.
  // Re-running the IIFE must not double-bind listeners.
  if (window.__scoutRecLoaded) return;
  window.__scoutRecLoaded = true;

  const STATE_KEY  = "scoutRec";        // { on, sessionId, startedAt, startUrl }
  const EVENTS_KEY = "scoutRecEvents";  // [ { t, ts, ... }, ... ]

  let active   = false;   // listeners attached?
  let session  = null;    // current recording state object
  let attached = false;   // guard against double-binding listeners

  // ── Persisted event queue ───────────────────────────────────────────────────
  // The content script re-injects on every page load, so the buffer can't live
  // only in memory. Each push read-modify-writes storage.local through a single
  // promise chain to avoid lost updates from concurrent writes.
  let buffer   = [];
  let flushing = Promise.resolve();
  let flushTimer = null;

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flushNow, 700);
  }

  function flushNow() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!buffer.length) return;
    const pending = buffer;
    buffer = [];
    flushing = flushing.then(async () => {
      try {
        const got = await chrome.storage.local.get(EVENTS_KEY);
        const all = (got[EVENTS_KEY] || []).concat(pending);
        await chrome.storage.local.set({ [EVENTS_KEY]: all });
      } catch (_) { /* storage gone / context invalidated */ }
    });
    return flushing;
  }

  function record(ev) {
    if (!active) return;
    ev.ts  = Date.now();
    ev.url = location.href;
    buffer.push(ev);
    scheduleFlush();
  }

  // ── Selector generation → Playwright locator expression ─────────────────────
  function q(s) {
    return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  }

  const IMPLICIT_ROLE = {
    A: "link", BUTTON: "button", SELECT: "combobox",
    TEXTAREA: "textbox", H1: "heading", H2: "heading",
    H3: "heading", H4: "heading", IMG: "img",
  };

  function implicitRole(el) {
    const tag = el.tagName;
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (t === "submit" || t === "button" || t === "reset") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio")    return "radio";
      if (t === "search")   return "searchbox";
      return "textbox";
    }
    return el.getAttribute("role") || IMPLICIT_ROLE[tag] || null;
  }

  function accessibleName(el) {
    let n = el.getAttribute("aria-label")
         || el.getAttribute("alt")
         || el.getAttribute("title")
         || "";
    if (!n && el.tagName === "INPUT") {
      const id = el.id;
      if (id) {
        const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lab) n = lab.textContent || "";
      }
    }
    if (!n) n = (el.textContent || "").trim();
    return n.replace(/\s+/g, " ").trim().slice(0, 80);
  }

  // LinkedIn/Dice sprinkle hashed ids/classes (e.g. ember1234, css-1a2b3c).
  const RANDOMISH = /(^|[-_])(ember\d+|css-[a-z0-9]{5,}|[a-f0-9]{8,})($|[-_])/i;

  function looksRandom(s) {
    return RANDOMISH.test(s) || /\d{4,}/.test(s);
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      let sel = node.tagName.toLowerCase();
      const stableCls = Array.from(node.classList).find(c => !looksRandom(c));
      if (stableCls) sel += "." + CSS.escape(stableCls);
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (sameTag.length > 1) sel += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      node = parent;
      depth++;
    }
    return parts.join(" > ");
  }

  // Returns a Playwright locator expression string, e.g.
  //   getByRole('link', { name: 'Experience' })
  function pwLocator(el) {
    if (!el || el.nodeType !== 1) return "locator('body')";

    const testid = el.getAttribute("data-testid")
                || el.getAttribute("data-test")
                || el.getAttribute("data-qa")
                || el.getAttribute("data-control-name");
    if (testid) return `getByTestId(${q(testid)})`;

    const role = implicitRole(el);
    const name = accessibleName(el);
    if (role && name) return `getByRole(${q(role)}, { name: ${q(name)} })`;

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const ph = el.getAttribute("placeholder");
      if (ph) return `getByPlaceholder(${q(ph.slice(0, 60))})`;
    }

    if (name) return `getByText(${q(name)})`;

    if (el.id && !looksRandom(el.id)) return `locator('#${CSS.escape(el.id)}')`;

    return `locator(${q(cssPath(el))})`;
  }

  // ── Event handlers ──────────────────────────────────────────────────────────
  const onClick = (e) => {
    const el = e.target.closest("a,button,[role],input,select,textarea,li,span,h1,h2,h3,div") || e.target;
    record({ t: "click", loc: pwLocator(el), label: accessibleName(el) });
  };

  // Collapse rapid typing into a single fill of the final value.
  const inputTimers = new WeakMap();
  const onInput = (e) => {
    const el = e.target;
    if (!(el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
    if (el.type === "password") return; // never record secrets
    clearTimeout(inputTimers.get(el));
    inputTimers.set(el, setTimeout(() => {
      record({ t: "fill", loc: pwLocator(el), value: el.value });
    }, 500));
  };

  const onChange = (e) => {
    const el = e.target;
    if (el.tagName === "SELECT") {
      const opt = el.options[el.selectedIndex];
      record({ t: "select", loc: pwLocator(el), value: el.value, label: opt ? opt.text : "" });
    } else if (el.type === "checkbox" || el.type === "radio") {
      record({ t: el.checked ? "check" : "uncheck", loc: pwLocator(el) });
    }
  };

  const SPECIAL_KEYS = new Set(["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
  const onKeydown = (e) => {
    if (e.metaKey || e.ctrlKey) {
      record({ t: "press", key: `${e.ctrlKey ? "Control+" : "Meta+"}${e.key}`, loc: pwLocator(e.target) });
      return;
    }
    if (SPECIAL_KEYS.has(e.key)) {
      record({ t: "press", key: e.key, loc: pwLocator(e.target) });
    }
  };

  // Scroll — throttled to final position within a window.
  let scrollTimer = null;
  const onScroll = () => {
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      record({ t: "scroll", x: Math.round(window.scrollX), y: Math.round(window.scrollY) });
    }, 600);
  };

  // Hover — throttled, only over meaningful, named elements.
  let lastHover = 0;
  const onHover = (e) => {
    const now = Date.now();
    if (now - lastHover < 800) return;
    const el = e.target.closest("a,button,[role],li");
    if (!el) return;
    const name = accessibleName(el);
    if (!name) return;
    lastHover = now;
    record({ t: "hover", loc: pwLocator(el), label: name });
  };

  // Dwell heartbeat — every 3s note the section heading nearest the viewport
  // centre, so the generated script shows where the recruiter's attention sat.
  let dwellTimer = null;
  let lastSection = "";
  function dwellTick() {
    const heads = document.querySelectorAll("h1,h2,h3,[role='heading']");
    const mid = window.innerHeight / 2;
    let best = null, bestDist = Infinity;
    heads.forEach(h => {
      const r = h.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) return;
      const d = Math.abs(r.top - mid);
      if (d < bestDist) { bestDist = d; best = h; }
    });
    const name = best ? (best.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) : "";
    if (name && name !== lastSection) {
      lastSection = name;
      record({ t: "view", section: name });
    }
  }

  // SPA navigation — LinkedIn/Dice change URL without a full load. Patch history
  // and listen for popstate so route changes land in the log.
  let lastUrl = location.href;
  function noteNav() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    record({ t: "nav", to: location.href });
  }
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...a) { const r = origPush.apply(this, a); noteNav(); return r; };
  history.replaceState = function (...a) { const r = origReplace.apply(this, a); noteNav(); return r; };

  // ── Attach / detach ─────────────────────────────────────────────────────────
  function attach() {
    if (attached) return;
    attached = true;
    document.addEventListener("click",    onClick,   true);
    document.addEventListener("input",    onInput,   true);
    document.addEventListener("change",   onChange,  true);
    document.addEventListener("keydown",  onKeydown, true);
    document.addEventListener("mouseover", onHover,  true);
    window.addEventListener("scroll",     onScroll,  true);
    window.addEventListener("popstate",   noteNav);
    window.addEventListener("pagehide",   flushNow);
    dwellTimer = setInterval(dwellTick, 3000);
  }

  function detach() {
    if (!attached) return;
    attached = false;
    document.removeEventListener("click",    onClick,   true);
    document.removeEventListener("input",    onInput,   true);
    document.removeEventListener("change",   onChange,  true);
    document.removeEventListener("keydown",  onKeydown, true);
    document.removeEventListener("mouseover", onHover,  true);
    window.removeEventListener("scroll",     onScroll,  true);
    window.removeEventListener("popstate",   noteNav);
    window.removeEventListener("pagehide",   flushNow);
    clearInterval(dwellTimer);
    flushNow();
  }

  function apply(state) {
    session = state || null;
    const on = !!(state && state.on);
    if (on === active) return;
    active = on;
    if (on) {
      attach();
      // First event on this page marks entry so the script's goto/timeline is right.
      record({ t: "enter", to: location.href });
    } else {
      record({ t: "stop" });
      flushNow();
      detach();
    }
  }

  // Boot: read current state, then react to toggles from the side panel.
  chrome.storage.local.get(STATE_KEY).then(g => apply(g[STATE_KEY])).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STATE_KEY]) return;
    apply(changes[STATE_KEY].newValue);
  });
})();
