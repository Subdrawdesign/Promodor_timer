/* ============================================================================
   FOCUS FLOW — POMODORO PRO — GOOGLE APPS SCRIPT BACKEND (Google Sheet = DB)
   ----------------------------------------------------------------------------
   SETUP
   1. Create a new, empty Google Sheet.  (This sheet is your database.)
   2. Extensions -> Apps Script. Delete everything, paste THIS WHOLE FILE.
   3. Change API_KEY below to your own secret. Put the SAME value in
      js/config.js -> API_KEY.
   4. Run the function `setup` once from the editor (select it in the toolbar
      dropdown -> Run) and allow permissions. It creates the tabs:
        Sessions  – one row per focus / break / flow session (the raw data)
        Daily     – auto QUERY summary (minutes + sessions per day)
   5. Deploy -> New deployment -> gear icon -> Web app
        Execute as:      Me
        Who has access:  Anyone
      Copy the "Web app URL" -> paste into js/config.js -> APPS_SCRIPT_URL.

   After ANY edit to this script:
     Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy
   (the URL stays the same).

   Every call from the site is JSONP (GET + &callback=fn) — same trick as the
   PHI quiz: <script> tags follow the Apps Script 302 redirect and ignore CORS,
   so the browser always gets a real answer.
   ============================================================================ */

/* Must match API_KEY in js/config.js */
var API_KEY = 'focus-flow-change-me';

var SESSIONS_SHEET = 'Sessions';
var DAILY_SHEET = 'Daily';
var SETTINGS_PROP = 'FOCUS_FLOW_SETTINGS';

var HEADERS = [
  'id',          // A  auto number
  'clientId',    // B  unique id generated in the browser (dedupe key)
  'date',        // C  yyyy-MM-dd in the user's local time zone
  'startTime',   // D  Date
  'endTime',     // E  Date
  'durationSec', // F  actual focused seconds (pauses excluded)
  'durationMin', // G  F / 60, 2 decimals
  'mode',        // H  focus | short | long | flow
  'task',        // I
  'project',     // J
  'completed',   // K  TRUE when the timer ran to zero (flow = TRUE when stopped)
  'pauses',      // L  how many times it was paused
  'plannedSec',  // M  planned length (0 for flow)
  'note',        // N
  'device',      // O  short browser label
  'createdAt'    // P  server timestamp
];
var COL = {};
HEADERS.forEach(function (h, i) { COL[h] = i; });


/* ================================================================ helpers */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function getSessionsSheet_() {
  var doc = ss_();
  var sheet = doc.getSheetByName(SESSIONS_SHEET);
  if (!sheet) {
    var first = doc.getSheets()[0];
    if (doc.getSheets().length === 1 && first.getLastRow() === 0) {
      first.setName(SESSIONS_SHEET);
      sheet = first;
    } else {
      sheet = doc.insertSheet(SESSIONS_SHEET);
    }
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
      .setFontWeight('bold').setBackground('#1f1f1f').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.getRange('D:E').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sheet.getRange('P:P').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sheet.setColumnWidth(COL.task + 1, 260);
    sheet.setColumnWidth(COL.note + 1, 260);
  }
  return sheet;
}

function ensureDailySheet_() {
  var doc = ss_();
  var sheet = doc.getSheetByName(DAILY_SHEET);
  if (!sheet) sheet = doc.insertSheet(DAILY_SHEET);
  if (!sheet.getRange('A1').getFormula()) {
    sheet.clear();
    sheet.getRange('A1').setFormula(
      '=QUERY(' + SESSIONS_SHEET + '!C:H,' +
      '"select C, sum(G), count(G) where H = \'focus\' or H = \'flow\' ' +
      'group by C order by C desc ' +
      'label C \'date\', sum(G) \'focus minutes\', count(G) \'sessions\'",1)'
    );
    sheet.getRange('E1').setValue('Hours').setFontWeight('bold');
    sheet.getRange('E2').setFormula('=ARRAYFORMULA(IF(B2:B="",,ROUND(B2:B/60,2)))');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/* Run once from the editor */
function setup() {
  getSessionsSheet_();
  ensureDailySheet_();
  return 'ok';
}

function toIso_(v) {
  if (v instanceof Date) return v.toISOString();
  return v === null || v === undefined ? '' : String(v);
}

function dateKey_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, ss_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  }
  return String(v || '').replace(/^'/, '').slice(0, 10);
}

function bool_(v) {
  if (v === true || v === false) return v;
  return /^(true|1|yes)$/i.test(String(v));
}

function clean_(v, max) {
  return String(v === undefined || v === null ? '' : v).trim().slice(0, max || 500);
}

function rowToObj_(r) {
  return {
    id: Number(r[COL.id]) || 0,
    clientId: String(r[COL.clientId]),
    date: dateKey_(r[COL.date]),
    startTime: toIso_(r[COL.startTime]),
    endTime: toIso_(r[COL.endTime]),
    durationSec: Number(r[COL.durationSec]) || 0,
    mode: String(r[COL.mode]),
    task: String(r[COL.task]),
    project: String(r[COL.project]),
    completed: bool_(r[COL.completed]),
    pauses: Number(r[COL.pauses]) || 0,
    plannedSec: Number(r[COL.plannedSec]) || 0,
    note: String(r[COL.note]),
    device: String(r[COL.device])
  };
}

function findRowByClientId_(sheet, clientId) {
  var last = sheet.getLastRow();
  if (last < 2 || !clientId) return -1;
  var hit = sheet.getRange(2, COL.clientId + 1, last - 1, 1)
    .createTextFinder(String(clientId)).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : -1;
}

function allRows_() {
  var sheet = getSessionsSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
}


/* ================================================================ actions */

function logSession_(d) {
  var clientId = clean_(d.clientId, 64);
  if (!clientId) throw new Error('clientId required');
  var mode = clean_(d.mode, 10);
  if (['focus', 'short', 'long', 'flow'].indexOf(mode) < 0) throw new Error('bad mode');

  var sheet = getSessionsSheet_();
  var existing = findRowByClientId_(sheet, clientId);
  if (existing > 0) {
    // already saved (retry from the offline queue) -> idempotent success
    return { duplicate: true, id: sheet.getRange(existing, 1).getValue() };
  }

  var dur = Math.max(0, Math.round(Number(d.durationSec) || 0));
  var lastRow = sheet.getLastRow();
  var nextRow = lastRow + 1;
  var id = lastRow < 2 ? 1 : (Number(sheet.getRange(lastRow, 1).getValue()) || lastRow - 1) + 1;
  sheet.getRange(nextRow, 1, 1, HEADERS.length).setValues([[
    id,
    clientId,
    "'" + clean_(d.date, 10),
    d.startTime ? new Date(d.startTime) : '',
    d.endTime ? new Date(d.endTime) : new Date(),
    dur,
    Math.round(dur / 60 * 100) / 100,
    mode,
    clean_(d.task, 300),
    clean_(d.project, 80),
    bool_(d.completed),
    Number(d.pauses) || 0,
    Number(d.plannedSec) || 0,
    clean_(d.note, 500),
    clean_(d.device, 60),
    new Date()
  ]]);
  return { id: id };
}

function handle_(data) {
  var action = data.action || 'ping';

  if (action === 'ping') return { result: 'success', pong: true, time: new Date().toISOString() };

  if (String(data.key || '') !== API_KEY) return { result: 'error', error: 'Unauthorised (API_KEY mismatch)' };

  /* ---------- write one session ---------- */
  if (action === 'log') {
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var r = logSession_(data);
      return { result: 'success', id: r.id, duplicate: !!r.duplicate };
    } finally { try { lock.releaseLock(); } catch (e) {} }
  }

  /* ---------- write many sessions (offline queue flush) ---------- */
  if (action === 'logBatch') {
    var items = JSON.parse(data.items || '[]');
    var lockB = LockService.getScriptLock();
    lockB.waitLock(25000);
    try {
      var saved = [];
      items.forEach(function (it) {
        try { logSession_(it); saved.push(it.clientId); } catch (err) { /* skip bad row */ }
      });
      return { result: 'success', saved: saved };
    } finally { try { lockB.releaseLock(); } catch (e) {} }
  }

  /* ---------- read sessions in a date range ---------- */
  if (action === 'sessions') {
    var from = clean_(data.from, 10) || '0000-00-00';
    var to = clean_(data.to, 10) || '9999-99-99';
    var out = [];
    allRows_().forEach(function (row) {
      if (!row[COL.clientId]) return;
      var dk = dateKey_(row[COL.date]);
      if (dk >= from && dk <= to) out.push(rowToObj_(row));
    });
    return { result: 'success', count: out.length, sessions: out };
  }

  /* ---------- edit task / project / note ---------- */
  if (action === 'update') {
    var sh = getSessionsSheet_();
    var row = findRowByClientId_(sh, data.clientId);
    if (row < 0) return { result: 'error', error: 'Session not found' };
    if (data.task !== undefined) sh.getRange(row, COL.task + 1).setValue(clean_(data.task, 300));
    if (data.project !== undefined) sh.getRange(row, COL.project + 1).setValue(clean_(data.project, 80));
    if (data.note !== undefined) sh.getRange(row, COL.note + 1).setValue(clean_(data.note, 500));
    return { result: 'success' };
  }

  /* ---------- delete ---------- */
  if (action === 'delete') {
    var shD = getSessionsSheet_();
    var rowD = findRowByClientId_(shD, data.clientId);
    if (rowD < 0) return { result: 'error', error: 'Session not found' };
    shD.deleteRow(rowD);
    return { result: 'success' };
  }

  /* ---------- settings (synced across devices) ---------- */
  if (action === 'getSettings') {
    var raw = PropertiesService.getScriptProperties().getProperty(SETTINGS_PROP);
    return { result: 'success', settings: raw ? JSON.parse(raw) : null };
  }
  if (action === 'saveSettings') {
    var s = JSON.parse(data.settings || '{}');
    PropertiesService.getScriptProperties().setProperty(SETTINGS_PROP, JSON.stringify(s));
    return { result: 'success' };
  }

  /* ---------- meta: sheet link + recent tasks / projects for autocomplete ---------- */
  if (action === 'meta') {
    var rows = allRows_();
    var tasks = {}, projects = {};
    for (var i = rows.length - 1; i >= 0 && i >= rows.length - 500; i--) {
      var t = String(rows[i][COL.task]), p = String(rows[i][COL.project]);
      if (t) tasks[t] = 1;
      if (p) projects[p] = 1;
    }
    ensureDailySheet_();
    return {
      result: 'success',
      sheetUrl: ss_().getUrl(),
      totalSessions: rows.length,
      tasks: Object.keys(tasks).slice(0, 40),
      projects: Object.keys(projects).slice(0, 40)
    };
  }

  return { result: 'error', error: 'Unknown action: ' + action };
}


/* ================================================================ entry */

function doGet(e) {
  var params = (e && e.parameter) ? e.parameter : {};
  var payload;
  try { payload = handle_(params); }
  catch (err) { payload = { result: 'error', error: String(err && err.message || err) }; }

  var cb = String(params.callback || '');
  if (cb && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cb)) {
    return ContentService.createTextOutput(cb + '(' + JSON.stringify(payload) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (x) { body = e.parameter || {}; }
  var payload;
  try { payload = handle_(body); }
  catch (err) { payload = { result: 'error', error: String(err && err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
