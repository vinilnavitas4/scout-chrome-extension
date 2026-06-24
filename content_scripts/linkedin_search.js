// LinkedIn people-search results scraper.
// Injected on demand into a /search/results/people/ page by the side panel.
// Scrolls to force the result list to lazy-render, then returns the top N
// candidate profile URLs (deduped by slug) for the auto-source pipeline.
//
// Re-injection guards against duplicate listeners: chrome.scripting.executeScript
// runs the file again on each call, which would otherwise stack onMessage handlers.

(function () {
  if (window.__scoutSearchInjected) return;
  window.__scoutSearchInjected = true;

  function slugOf(href) {
    const m = (href || '').match(/linkedin\.com\/in\/([^\/?#]+)/i);
    return m ? m[1].toLowerCase() : '';
  }

  // Collect candidate result links from the people results. Each result is a
  // [role="listitem"]; the FIRST /in/ anchor in it is the candidate (snippet /
  // mutual-connection /in/ links come later in the same item, so take only the
  // first). Falls back to a broad <main> scan if no listitems are present.
  function collectResults() {
    const out = [];
    const seen = new Set();

    const addFrom = (a) => {
      const href = a?.href || '';
      const slug = slugOf(href);
      if (!slug || seen.has(slug)) return;
      if (/miniprofile|overlay/i.test(href)) return;
      // Name: prefer the bold name link's text, else aria-hidden span, else anchor text.
      const nameRaw = a.querySelector('a.ade390ae')?.innerText
        || a.querySelector('span[aria-hidden="true"]')?.innerText
        || a.innerText || '';
      const name = (nameRaw.trim().split('\n')[0] || '').trim().replace(/\s+/g, ' ');
      if (!name || name.length > 80) return;
      seen.add(slug);
      out.push({ url: `https://www.linkedin.com/in/${slug}/`, name });
    };

    const items = document.querySelectorAll('main [role="listitem"]');
    if (items.length) {
      for (const item of items) {
        const a = item.querySelector('a[href*="/in/"]');   // first = the candidate
        if (a) addFrom(a);
      }
    }
    // Fallback / top-up: broad scan if listitems missed (layout variant).
    if (out.length < 5) {
      const scope = document.querySelector('main') || document.body;
      for (const a of scope.querySelectorAll('a[href*="/in/"]')) addFrom(a);
    }
    return out;
  }

  // Scroll the page in steps so the lazy-loaded result cards render, polling
  // until we have enough results or the timeout elapses.
  async function scrapeWithScroll(minResults = 5, maxMs = 8000) {
    const start = Date.now();
    let results = collectResults();
    let pos = 0;
    while (results.length < minResults && Date.now() - start < maxMs) {
      pos += 700;
      window.scrollTo(0, pos);
      await new Promise(r => setTimeout(r, 500));
      results = collectResults();
      if (pos > document.body.scrollHeight) pos = 0;
    }
    window.scrollTo(0, 0);
    console.log(`[SCOUT] search scrape: ${results.length} results in ${Date.now() - start}ms`);
    return results;
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getSearchResults') {
      scrapeWithScroll(request.count || 5).then(results => sendResponse({ results }));
      return true;
    }
  });
})();
