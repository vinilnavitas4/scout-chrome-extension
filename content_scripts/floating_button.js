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

  function openPanel() {
    // Open the panel (needs this click gesture), then nudge it to rescan. If the
    // panel was already open on an SPA-navigated profile, no tabs.onUpdated fired,
    // so it would otherwise keep showing the previous/empty state. The rescan msg
    // is a no-op when the panel is closed (it scans itself on open).
    chrome.runtime.sendMessage({ type: "OPEN_PANEL" }, () => void chrome.runtime.lastError);
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: "SCOUT_RESCAN" }, () => void chrome.runtime.lastError);
    }, 400);
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
        .fab {
          position: fixed;
          top: 24px;
          right: 24px;
          height: 40px;
          padding: 0 18px;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font: 700 15px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          letter-spacing: .5px;
          color: #fff;
          background: linear-gradient(135deg, #1e3a8a 0%, #0f2557 100%);
          box-shadow: 0 4px 14px rgba(15,37,87,.45);
          transition: transform .15s ease, box-shadow .15s ease;
        }
        .fab:hover {
          transform: translateY(-2px) scale(1.05);
          box-shadow: 0 6px 20px rgba(15,37,87,.55);
        }
        .fab:active { transform: scale(.96); }
        .tip {
          position: fixed;
          top: 34px;
          right: 120px;
          background: #0f172a;
          color: #f1f5f9;
          padding: 6px 10px;
          border-radius: 6px;
          font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          white-space: nowrap;
          opacity: 0;
          pointer-events: none;
          transition: opacity .15s ease;
        }
        .fab:hover + .tip { opacity: 1; }
      </style>
      <button class="fab" aria-label="Open SCOUT" title="Open SCOUT">SCOUT</button>
      <span class="tip">Open SCOUT candidate scorer</span>
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
      if (window.location.href !== last) { last = window.location.href; sync(); }
    };
    window.addEventListener("popstate", fire);
    setInterval(fire, 300);
    new MutationObserver(fire).observe(document.documentElement, { childList: true, subtree: true });
  }

  function start() { sync(); watchUrl(); }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
