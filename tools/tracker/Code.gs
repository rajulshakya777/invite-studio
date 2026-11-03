// Invite tracker: Google Apps Script bound to the "Wedding Invite Tracker" sheet (Extensions → Apps Script).
// Deploy → New deployment → Web app, Execute as: Me, Who has access: Anyone. The studio and the tracker page
// send every request as a POST with this token; the token and the web-app URL reach the browsers only inside
// docs/assets/tracker.json, encrypted with the studio password (tools/tracker/configure.mjs).
// The real token is pasted in place of the placeholder below and never committed.
const TOKEN = "PASTE_TRACKER_TOKEN_HERE";

const TABS = { rajul: "Rajul", dolly: "Dolly" };
// Columns A–K: Created, Type, Language, Guest name, RSVP name, RSVP phone, Downloaded, Shared, Sent, Device, ID
const COL = { created: 1, type: 2, lang: 3, guest: 4, rsvpName: 5, rsvpPhone: 6, downloaded: 7, shared: 8, sent: 9, device: 10, id: 11 };
const WIDTH = 11;

function doGet() {
  return out({ ok: true, service: "invite-tracker" });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (x) { return out({ ok: false, error: "bad request" }); }
  if (!body || body.token !== TOKEN) return out({ ok: false, error: "unauthorized" });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (body.action === "add") return out(add(body.row || {}));
    if (body.action === "mark") return out(mark(String(body.id || ""), body.field, body.value));
    if (body.action === "list") return out(list());
    return out({ ok: false, error: "unknown action" });
  } catch (x) {
    return out({ ok: false, error: String(x && x.message || x) });
  } finally {
    lock.releaseLock();
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Text from the browser is stored as text: a leading = + - @ would otherwise start a formula.
function text(v, max) {
  const s = String(v == null ? "" : v).slice(0, max || 200);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function findRow(id) {
  if (!id) return null;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  for (const name of Object.values(TABS)) {
    const sh = ss.getSheetByName(name);
    const last = sh.getLastRow();
    if (last < 2) continue;
    const hit = sh.getRange(2, COL.id, last - 1, 1).createTextFinder(id).matchEntireCell(true).findNext();
    if (hit) return { sh, row: hit.getRow() };
  }
  return null;
}

function add(r) {
  const tab = TABS[r.side];
  if (!tab) return { ok: false, error: "unknown side" };
  const id = String(r.id || "").slice(0, 64);
  if (!id) return { ok: false, error: "missing id" };
  if (findRow(id)) return { ok: true, duplicate: true }; // a retried request
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tab);
  const created = new Date(r.created);
  const row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, WIDTH).setValues([[
    isNaN(created) ? new Date() : created,
    r.type === "card" ? "Card" : "Video",
    r.lang === "hi" ? "Hindi" : "English",
    text(r.guest, 120), text(r.rsvpName, 80), text(r.rsvpPhone, 30),
    "", "", false, text(r.device, 60), id,
  ]]);
  sh.getRange(row, COL.sent).insertCheckboxes();
  return { ok: true, row };
}

function mark(id, field, value) {
  const hit = findRow(id);
  if (!hit) return { ok: false, error: "not found" };
  if (field === "sent") {
    hit.sh.getRange(hit.row, COL.sent).setValue(!!value);
  } else if (field === "downloaded" || field === "shared") {
    const cell = hit.sh.getRange(hit.row, COL[field]);
    if (cell.getValue() === "") cell.setValue(new Date()); // keep the first time
  } else {
    return { ok: false, error: "unknown field" };
  }
  return { ok: true };
}

function list() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const iso = (v) => (v instanceof Date ? v.toISOString() : "");
  const rows = [];
  for (const [side, name] of Object.entries(TABS)) {
    const sh = ss.getSheetByName(name);
    const last = sh.getLastRow();
    if (last < 2) continue;
    for (const v of sh.getRange(2, 1, last - 1, WIDTH).getValues()) {
      if (!v[COL.id - 1] && !v[COL.guest - 1]) continue;
      rows.push({
        side, created: iso(v[0]), type: v[1], lang: v[2], guest: String(v[3]), rsvpName: String(v[4]),
        rsvpPhone: String(v[5]), downloaded: iso(v[6]), shared: iso(v[7]), sent: v[8] === true,
        device: String(v[9]), id: String(v[10]),
      });
    }
  }
  rows.sort((a, b) => (b.created > a.created ? 1 : -1));
  return { ok: true, rows, sheetUrl: ss.getUrl() };
}
