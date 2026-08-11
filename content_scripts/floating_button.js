// SCOUT floating action button — injected on LinkedIn /in/* and Dice profile
// pages only (scoping comes from the content_scripts matches in manifest.json).
// Clicking it opens the side panel. The click is a user gesture, so
// sidePanel.open() inside the SW's OPEN_PANEL handler succeeds immediately.

(function () {
  const HOST_ID = "scout-fab-host";
  if (document.getElementById(HOST_ID)) return; // guard against double-injection

  // Content scripts inject once per full page load, but LinkedIn/Dice are SPAs:
  // navigating from a profile to the feed keeps the same document, so the button
  // must show/hide itself on client-side URL changes. A profile page is one whose
  // path still matches the content_scripts pattern for this host.
  function onProfilePage() {
    const { hostname, pathname } = window.location;
    if (hostname.endsWith("linkedin.com")) return pathname.startsWith("/in/");
    if (hostname.endsWith("dice.com")) return pathname.startsWith("/employers/talent-search/profile/");
    return false;
  }

  // Reloading/updating the extension orphans every content script already on the
  // page: their chrome.* handles are dead and any call throws "Extension context
  // invalidated". chrome.runtime.id goes undefined first, so test that and stop.
  function extensionAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  // Orphaned script: pull the button (it can't talk to the SW anymore) and stop
  // the timers so the console isn't flooded. A page reload injects a fresh copy.
  let pollId = null;
  let observer = null;
  function teardown() {
    if (pollId) { clearInterval(pollId); pollId = null; }
    if (observer) { observer.disconnect(); observer = null; }
    document.getElementById(HOST_ID)?.remove();
  }

  function send(msg) {
    if (!extensionAlive()) { teardown(); return false; }
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
      return true;
    } catch (_) {
      teardown();   // context died between the check and the call
      return false;
    }
  }

  function openPanel() {
    // Open the panel (needs this click gesture), then nudge it to rescan. If the
    // panel was already open on an SPA-navigated profile, no tabs.onUpdated fired,
    // so it would otherwise keep showing the previous/empty state. The rescan msg
    // is a no-op when the panel is closed (it scans itself on open).
    if (!send({ type: "OPEN_PANEL" })) return;
    setTimeout(() => send({ type: "SCOUT_RESCAN" }), 400);
  }

  function mount() {
    if (document.getElementById(HOST_ID)) return;

    // Shadow DOM isolates our styles from LinkedIn/Dice CSS (and vice versa).
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
      "position:fixed;top:24px;right:24px;z-index:2147483647;width:0;height:0;";
    const root = host.attachShadow({ mode: "open" });

    root.innerHTML = `
      <style>
        .wrap {
          position: fixed;
          top: 24px;
          right: 24px;
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 8px;
        }
        .fab {
          height: 42px;
          padding: 0 16px;
          border: none;
          border-radius: 999px;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 8px;
          font: 700 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          letter-spacing: .5px;
          color: #fff;
          background: linear-gradient(135deg, #0284c7 0%, #0f2557 100%);
          box-shadow: 0 4px 16px rgba(15,37,87,.42);
          transition: transform .15s ease, box-shadow .15s ease, filter .15s ease;
        }
        .fab svg { flex: 0 0 auto; }
        .fab:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 22px rgba(15,37,87,.55);
          filter: brightness(1.08);
        }
        .fab:active { transform: scale(.97); }
        .fab:focus-visible {
          outline: none;
          box-shadow: 0 0 0 3px rgba(56,189,248,.6), 0 8px 22px rgba(15,37,87,.55);
        }
        /* Tooltip sits under the button so it never runs off the right edge. */
        .tip {
          background: #0f172a;
          color: #f1f5f9;
          padding: 6px 10px;
          border-radius: 6px;
          font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          white-space: nowrap;
          opacity: 0;
          transform: translateY(-4px);
          pointer-events: none;
          box-shadow: 0 4px 12px rgba(15,23,42,.28);
          transition: opacity .15s ease, transform .15s ease;
        }
        .fab:hover + .tip,
        .fab:focus-visible + .tip { opacity: 1; transform: none; }
        @media (prefers-reduced-motion: reduce) {
          .fab, .tip { transition: none; }
        }
      </style>
      <div class="wrap">
        <button class="fab" aria-label="Open SCOUT candidate scorer" title="Open SCOUT">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.7" />
            <path d="M10.8 10.8L14 14" fill="none" stroke="currentColor"
                  stroke-width="1.7" stroke-linecap="round" />
          </svg>
          SCOUT
        </button>
        <span class="tip">Score this candidate</span>
      </div>
    `;

    root.querySelector(".fab").addEventListener("click", openPanel);
    document.documentElement.appendChild(host);
  }

  function sync() {
    const host = document.getElementById(HOST_ID);
    if (onProfilePage()) {
      if (!host) mount();
      else host.style.display = "";
    } else if (host) {
      host.style.display = "none";
    }
  }

  // Watch client-side navigation. LinkedIn/Dice are SPAs whose route changes run
  // in the page's main world, so patching history.pushState from this isolated
  // content-script world would never intercept them. Reliable cross-world signals:
  //   - popstate (back/forward)
  //   - a fast URL poll (catches pushState/replaceState route swaps)
  //   - a DOM MutationObserver, so a route swap that mutates the page is caught on
  //     the next frame instead of waiting for the next poll tick.
  function watchUrl() {
    let last = window.location.href;
    const fire = () => {
      if (!extensionAlive()) { teardown(); return; }
      if (window.location.href !== last) { last = window.location.href; sync(); }
    };
    window.addEventListener("popstate", fire);
    pollId = setInterval(fire, 300);
    observer = new MutationObserver(fire);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function start() { sync(); watchUrl(); }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
