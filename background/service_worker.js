const BASE_URL = "https://navitas-ai-platform.wonderfulfield-ebc060c9.eastus.azurecontainerapps.io";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

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

  if (type === "ADD_CANDIDATE") {
<<<<<<< HEAD
    const { jd_id, candidate, source } = payload;
    const body = JSON.stringify({ job_id: jd_id, candidate: { ...candidate, source } });
    console.log("[SCOUT] ADD_CANDIDATE body:", body);

    fetch(`${BASE_URL}/api/scout/candidates`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body
    })
      .then(async r => {
=======
    // Use async IIFE so Chrome tracks the entire chain as active work,
    // preventing the service worker from being killed mid-fetch (MV3 pitfall).
    (async () => {
      try {
        const { sheetsUrl } = await chrome.storage.local.get(["sheetsUrl"]);
        if (!sheetsUrl) {
          sendResponse({ ok: false, error: "No Google Sheets URL configured. Add it in extension settings." });
          return;
        }

        console.log("[SCOUT] Sending to:", sheetsUrl);
        console.log("[SCOUT] Payload:", JSON.stringify(payload, null, 2));
        const r = await fetch(sheetsUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify(payload),
          redirect: "follow"
        });
        console.log("[SCOUT] HTTP status:", r.status, r.url);
>>>>>>> c0f9b2425017707ebdfcdd9c88eef68d3a73661a
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
      })
      .catch(e => {
        console.error("[SCOUT] ADD_CANDIDATE fetch error:", e.message);
        sendResponse({ ok: false, error: `Fetch failed: ${e.message}` });
<<<<<<< HEAD
      });
    return true;
=======
      }
    })();
    return true; // keep channel open for async response
>>>>>>> c0f9b2425017707ebdfcdd9c88eef68d3a73661a
  }
});
