// SCOUT — Google Apps Script Web App
//
// SETUP (do this once):
// 1. Open your Google Sheet
// 2. Extensions → Apps Script  (creates a bound script)
// 3. Paste this code, save
// 4. Run the "setup" function once (click ▶ Run) — authorize when prompted
// 5. Deploy → New deployment → Web App
//    Execute as: Me | Who has access: Anyone
// 6. Copy the Web App URL → paste into SCOUT extension settings

const SHEET_NAME = "SCOUT Candidates";

const HEADERS = [
  "Name", "Email", "Phone", "Location", "Open To Work", "About",
  "Current Title", "Current Company", "Current Duration",
  "Past Title", "Past Company", "Past Duration",
  "Skills", "Education", "Profile URL",
  "JD", "Score", "Score Label", "Rationale", "Source"
];

// ── Run this once to authorize & create the sheet tab ──────────────────────
function setup() {
  const sheet = getSheet();
  ensureHeaders(sheet);
  Logger.log("Setup complete. Sheet ready: " + sheet.getParent().getUrl());
}

// Target sheet — used by getSheet() so the deployed Web App writes to the right
// spreadsheet/tab even when deployed as a standalone script.
const TARGET_SPREADSHEET_ID = "1ZwGfs0-XcuJ-YDVvsmmvLlSQBN3htVo-hxraYd1C36g";
const TARGET_TAB_GID        = 2115829000;

// ── POST handler ────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : null;
    if (!raw) throw new Error("Empty request body received.");

    const data = JSON.parse(raw);
    const sheet = getSheet();
    ensureHeaders(sheet);

    const c = data.candidate || {};
    const curr = Array.isArray(c.experience) ? c.experience[0] : null;
    const past = Array.isArray(c.experience) ? c.experience[1] : null;
    const edu  = Array.isArray(c.education)  ? c.education[0]  : null;

    sheet.appendRow([
      c.name             || "",
      c.email            || "",
      c.phone            || "",
      c.location         || "",
      c.openToWork       ? "Yes" : "No",
      c.about            || "",
      curr ? curr.title   || "" : "",
      curr ? curr.company || "" : "",
      curr ? curr.dates   || "" : "",
      past ? past.title   || "" : "",
      past ? past.company || "" : "",
      past ? past.dates   || "" : "",
      Array.isArray(c.skills) ? c.skills.join(", ") : (c.skills || ""),
      edu ? [edu.school, edu.degree, edu.dates].filter(Boolean).join(" · ") : "",
      c.profileUrl       || "",
      data.jd_title      || data.jd_id || "",
      (data.score != null) ? data.score : "",
      data.score_label   || "",
      data.rationale     || "",
      data.source        || ""
    ]);

    return jsonOut({ status: "success" });

  } catch (err) {
    console.error("SCOUT error:", err.message, err.stack);
    return jsonOut({ status: "error", message: err.message });
  }
}

// ── GET handler — health check ──────────────────────────────────────────────
function doGet() {
  return jsonOut({ status: "ok", app: "SCOUT Sheets Writer" });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function getSheet() {
  const ss = SpreadsheetApp.openById(TARGET_SPREADSHEET_ID);
  // Prefer the exact tab by gid; fall back to name, then create.
  const byGid = ss.getSheets().find(s => s.getSheetId() === TARGET_TAB_GID);
  if (byGid) return byGid;
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

function ensureHeaders(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    // Formatting only runs once — avoids 4 extra API calls on every POST
    sheet.getRange(1, 1, 1, HEADERS.length)
         .setFontWeight("bold").setBackground("#0f172a").setFontColor("#ffffff");
    sheet.setFrozenRows(1);
  } else {
    // Keep columns aligned after schema changes but skip re-formatting
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
