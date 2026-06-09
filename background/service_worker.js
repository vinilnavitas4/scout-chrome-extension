const BASE_URL = "https://navitas-ai-platform.wonderfulfield-ebc060c9.eastus.azurecontainerapps.io";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  // ── GET_JDS — fetch live jobs from SCOUT backend ──────────────────────────
  if (type === "GET_JDS") {
    fetch(`${BASE_URL}/api/scout/jobs`)
      .then(r => r.json())
      .then(data => {
        const jobs = (data.jobs || []).map(j => ({
          id:     j.id,
          title:  j.title,
          client: [j.city, j.state].filter(Boolean).join(", ") || j.type || ""
        }));
        sendResponse({ ok: true, data: jobs });
      })
      .catch(e => {
        console.error("[SCOUT] GET_JDS error:", e.message);
        sendResponse({ ok: false, error: `Failed to load jobs: ${e.message}` });
      });
    return true;
  }

  // ── ADD_CANDIDATE — post to SCOUT backend → JazzHR ───────────────────────
  // Async IIFE keeps Chrome from killing the SW mid-fetch (MV3 requirement).
  if (type === "ADD_CANDIDATE") {
    (async () => {
      try {
        const { jd_id, candidate, source } = payload;
        const body = JSON.stringify({ job_id: jd_id, candidate: { ...candidate, source } });
        console.log("[SCOUT] ADD_CANDIDATE body:", body);

        const r = await fetch(`${BASE_URL}/api/scout/candidates`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        const text = await r.text();
        console.log("[SCOUT] ADD_CANDIDATE status:", r.status, "body:", text);
        let data;
        try { data = JSON.parse(text); }
        catch (_) { sendResponse({ ok: false, error: `Non-JSON (${r.status}): ${text.slice(0, 200)}` }); return; }
        if (data.ok) {
          console.log("[SCOUT] Candidate added:", data.applicant?.prospect_id);
          sendResponse({ ok: true, status: "added" });
        } else {
          sendResponse({ ok: false, error: data.error || data.message || `API error (${r.status})` });
        }
      } catch (e) {
        console.error("[SCOUT] ADD_CANDIDATE fetch error:", e.message);
        sendResponse({ ok: false, error: `Fetch failed: ${e.message}` });
      }
    })();
    return true; // keep channel open for async response
  }
});
