// Local development override — copy this file to config.local.js (gitignored)
// to point the extension at a scout-service running on your own machine
// instead of the deployed Azure one. Nothing here is committed, so you can
// test unmerged service/dashboard changes without waiting for a PR + deploy.
//
// ── Setup ────────────────────────────────────────────────────────────────────
// 1. Run the service locally (from the scout-service repo):
//        uvicorn backend.main:app --reload --port 8000
// 2. cp config.local.example.js config.local.js   (then edit below if needed)
// 3. chrome://extensions → reload the SCOUT extension. Config is read when the
//    service worker starts, so reload after every edit to this file.
// 4. The side panel shows an amber "localhost:8000" badge whenever BASE_URL is
//    not production. No badge = you are talking to the deployed service.
//
// Any localhost port works — manifest.json grants http://localhost/* — but 8000
// is the one registered as a Microsoft SSO redirect URI, so the dashboard at
// http://localhost:8000/public/scout/dashboard.html signs in without extra
// Azure AD config. Other ports break dashboard login (extension calls are fine,
// they use the shared key, not SSO).
Object.assign(self.SCOUT_CONFIG, {
  BASE_URL: "http://localhost:8000",

  // Only needed if your local .env has a different SCOUT_API_KEY than prod.
  // The two must match or every Scout API call returns 401 no_scout_key.
  // SCOUT_KEY: "scout_xxx",
});
