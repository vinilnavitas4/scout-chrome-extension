// SCOUT floating action button — injected on all of LinkedIn and on Dice profile
// pages (scoping comes from the content_scripts matches in manifest.json).
// Clicking it opens the side panel. The click is a user gesture, so
// sidePanel.open() inside the SW's OPEN_PANEL handler succeeds immediately.

(function () {
  const HOST_ID = "scout-fab-host";
  if (document.getElementById(HOST_ID)) return; // guard against double-injection

  // Content scripts inject once per full page load, but LinkedIn/Dice are SPAs:
  // route changes keep the same document, so visibility and the label are
  // re-evaluated on client-side URL changes.

  // The button rides along everywhere on LinkedIn — recruiters open the panel from
  // search results, the feed, and company pages, not just profiles. On Dice it
  // stays profile-scoped (no equivalent sourcing flow off the profile page).
  function shouldShow() {
    const { hostname, pathname } = window.location;
    if (hostname.endsWith("linkedin.com")) return true;
    if (hostname.endsWith("dice.com")) return pathname.startsWith("/employers/talent-search/profile/");
    return false;
  }

  // Off a profile there is no candidate to score yet, so the tooltip says what
  // the click actually does instead of promising a score.
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
    let host = document.getElementById(HOST_ID);
    if (!shouldShow()) {
      if (host) host.style.display = "none";
      return;
    }
    if (!host) { mount(); host = document.getElementById(HOST_ID); }
    else host.style.display = "";

    const tip = host?.shadowRoot?.querySelector(".tip");
    if (tip) tip.textContent = onProfilePage() ? "Score this candidate" : "Open SCOUT";
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
