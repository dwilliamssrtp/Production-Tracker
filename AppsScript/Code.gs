/**
 * SRTP Production Tracker — backend
 *
 * Model: a WorkOrder holds shared specs/targets/recipe reference (set once by the
 * controller). A Pipe is one reel/run of production under a work order — a work
 * order's total project length may take several reels to fulfill. Each pipe
 * has its own independent status per section (Baseline/Braidline/Coverline) and its
 * own log of readings/checks/notes/photos/material usage, but shares its parent
 * work order's targets.
 *
 * Naming: internally (sheet columns, JS identifiers, API params) this stays "Pipe"/
 * "PipeCode" throughout — only user-facing text (UI labels, toasts, emails) says
 * "reel", per the production manager's preferred terminology. Don't rename the
 * internal identifiers; it'd force a data migration for zero user-visible benefit.
 *
 * Access: every request needs a session token. There are two roles — Admin (the
 * controller: work orders, reels, tags, dashboard, logins) and Operator (the floor:
 * one reel at a time, nothing else). See the AUTHORIZATION block below; that's the
 * whole model. "Who has access: Anyone" on the deployment only means Google won't
 * ask for a Google account — this script's own login is what actually gates the data.
 *
 * Bind this script to a Google Sheet (Extensions > Apps Script from within the Sheet).
 * Run setup() once from the editor to create the tabs — it also prints the first admin
 * username/password, which is shown only that once.
 * Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone.
 * Paste the resulting /exec URL into API_URL near the top of index.html.
 */

var SHEETS = {
  WORKORDERS: 'WorkOrders',
  PIPES: 'Pipes',
  READINGS: 'Readings',
  THICKNESS: 'ThicknessChecks',
  NOTES: 'Notes',
  PHOTOS: 'Photos',
  EMAILLOG: 'EmailLog',
  MATERIAL: 'MaterialUsage',
  PROBLEMS: 'ProblemReports',
  DOWNTIME: 'DowntimeEvents',
  ACCOUNTS: 'Accounts',
  SESSIONS: 'Sessions',
  SETTINGS: 'Settings'
};

// Downtime reason categories offered in the UI (kept here so front end and email report agree).
var DOWNTIME_REASONS = ['Mechanical', 'Material', 'Changeover', 'Quality hold', 'Break', 'Other'];

var HEADERS = {
  WorkOrders: [
    'Code', 'CreatedAt', 'CreatedBy', 'Customer', 'ProductCode', 'PipeSize', 'EmailTo', 'ProjectLength',

    'BL_TargetOD', 'BL_ODTol', 'BL_TargetWall', 'BL_TargetID', 'BL_TargetLength', 'BL_Notes',
    'BL_ChillerTemp', 'BL_VacuumLevel', 'BL_BackerRPM',
    'BL_TZ1', 'BL_TZ2', 'BL_TZ3', 'BL_TZ4', 'BL_TZ5', 'BL_TClamp',
    'BL_DieBody', 'BL_DieManifold', 'BL_DieRetainer', 'BL_DieFlange',

    'BR_LongsCount', 'BR_Longs', 'BR_XbraidEndsUp', 'BR_TargetPitch', 'BR_PitchTol',
    'BR_TargetOD', 'BR_ODTol', 'BR_TargetLength', 'BR_Notes',

    'CV_TargetOD', 'CV_ODTol', 'CV_TargetWall', 'CV_TargetID', 'CV_TargetLength', 'CV_Notes',
    'CV_ChillerTemp', 'CV_VacuumLevel', 'CV_BackerRPM',
    'CV_TZ1', 'CV_TZ2', 'CV_TZ3', 'CV_TZ4', 'CV_TZ5', 'CV_TClamp',
    'CV_DieBody', 'CV_DieManifold', 'CV_DieRetainer', 'CV_DieFlange',

    'LastUpdated',
    'BL_LineSpeed', 'BR_LineSpeed', 'CV_LineSpeed',

    // Appended at the end (append-only — see setup()/HEADERS convention): Baseline has
    // three separate extruders on its recipe card (Backer, Co/Bonding, Co/Inner Liner),
    // each with its own material/RPM/temp zones — Coverline's card only has the one.
    'BL_BackerMaterial',
    'BL_BondMaterial', 'BL_BondRPM', 'BL_BondTZ1', 'BL_BondTZ2', 'BL_BondTZ3', 'BL_BondClamp', 'BL_BondFlange',
    'BL_LinerMaterial', 'BL_LinerRPM', 'BL_LinerTZ1', 'BL_LinerTZ2', 'BL_LinerTZ3', 'BL_LinerClamp', 'BL_LinerFlange', 'BL_LinerThickness',

    // BL_BackerSize/BL_BondSize/BL_LinerSize: unused. These extruders are physically fixed
    // at 3.5"/1.25"/2" on the machine — not a per-work-order value — so the size is hardcoded
    // in index.html's heading text instead of stored here. Column kept per append-only rule.
    'BL_BackerSize', 'BL_BondSize', 'BL_LinerSize',

    // Archiving. Appended at the end per the append-only rule above. Archived is the
    // flag the dashboard filters on; the other two are just an audit trail of who put
    // it away and when. Archiving is reversible — permanent deletion is a separate act.
    'Archived', 'ArchivedAt', 'ArchivedBy',

    // Braid yarns (appended per the append-only rule). The longitudinals and the cross
    // braid can run different yarns, so they're recorded separately.
    'BR_LongsMaterial', 'BR_XbraidMaterial',

    // Tooling from the recipe cards (appended per the append-only rule). The two cards
    // print tip and die in opposite orders, so these are named explicitly rather than
    // stored as the combined slash field the paper shows. Sizer ID holds its ring count
    // as written ("2.243" (27 rings)"), so it's text, not a number.
    'BL_TipSize', 'BL_DieSize', 'BL_Coated', 'BL_ConcentricityGap', 'BL_SizerID', 'BL_RearGasketHole',
    'CV_TipSize', 'CV_DieSize', 'CV_Coated', 'CV_ConcentricityGap'
  ],
  Pipes: [
    'PipeCode', 'WorkOrderCode', 'CreatedAt', 'CreatedBy',
    'BL_Status', 'BL_StartedAt', 'BL_CompletedAt', 'BL_ActualLength',
    'BR_Status', 'BR_StartedAt', 'BR_CompletedAt', 'BR_ActualLength',
    'CV_Status', 'CV_StartedAt', 'CV_CompletedAt', 'CV_ActualLength',
    'OverallStatus', 'LastUpdated', 'LastEmailAt',

    // Last reading, denormalised onto the reel (appended per the append-only rule).
    // The dashboard needs one reading per reel; deriving that meant scanning the whole
    // Readings sheet — every row, every work order, all of plant history — on every
    // 20-second poll. Written by apiAddReading_, which already has the values in hand.
    'LastReadingAt', 'LastReadingType', 'LastReadingValue', 'LastReadingInTol',

    // Footage marker of the newest OD reading in each section, denormalised the same way
    // and for the same reason: the TV view draws a progress bar per section from it, and
    // deriving it would mean scanning Readings on every refresh.
    'BL_LastFootage', 'BR_LastFootage', 'CV_LastFootage'
  ],
  // EnteredAt/TimeSource/TimeOffsetMin appended per the append-only rule. Timestamp is what the
  // operator says the reading was taken at; EnteredAt is when the server actually received
  // it. The two diverging is the whole point - see apiAddReading_.
  Readings: ['RowId', 'PipeCode', 'Section', 'Timestamp', 'Operator', 'Type', 'Value', 'InTol', 'Footage',
    'EnteredAt', 'TimeSource', 'TimeOffsetMin'],
  ThicknessChecks: ['RowId', 'PipeCode', 'Section', 'Position', 'Timestamp', 'Operator', 'OD',
    'T1','T2','T3','T4','T5','T6','T7','T8','T9','T10','T11','T12','T13','T14','T15','T16',
    'AvgThickness', 'ComputedID', 'Ovality'],
  Notes: ['RowId', 'PipeCode', 'Section', 'Timestamp', 'Operator', 'Text'],
  Photos: ['RowId', 'PipeCode', 'Section', 'Timestamp', 'Operator', 'Caption', 'DriveUrl', 'DriveFileId', 'ProblemReportId'],
  EmailLog: ['RowId', 'PipeCode', 'SentAt', 'SentTo', 'Trigger'],
  MaterialUsage: ['RowId', 'PipeCode', 'Section', 'Timestamp', 'Operator', 'Material', 'LotNumber', 'StartWeight', 'EndWeight', 'UsedWeight'],
  ProblemReports: ['RowId', 'PipeCode', 'Section', 'Timestamp', 'Operator', 'FootageMarker', 'Description',
    'Status', 'ResolvedBy', 'ResolvedAt', 'ResolutionNotes'],
  DowntimeEvents: ['RowId', 'PipeCode', 'Section', 'StartTime', 'EndTime', 'ReasonCode', 'Notes', 'Operator'],

  // Logins. Passwords are never stored — only a salted SHA-256 hash (hashPassword_).
  // Role is the whole authorization model: see ACTION_ROLES below.
  Accounts: ['AccountId', 'Username', 'Name', 'Role', 'PasswordHash', 'PasswordSalt', 'Active', 'CreatedAt', 'CreatedBy'],
  // Kind is 'password' (typed a username/password) or 'qr' (scanned a reel tag carrying
  // the shop operator key) — they get different lifetimes, see SESSION_DAYS/QR_SESSION_HOURS.
  Sessions: ['Token', 'AccountId', 'Kind', 'CreatedAt', 'ExpiresAt'],
  Settings: ['Key', 'Value']
};

var DRIVE_ROOT_FOLDER_NAME = 'SRTP Production Tracker Photos';
var DEFAULT_EMAIL_TO = 'dwilliams@specialtyrtp.com';

/* ============================== AUTHORIZATION ==============================
 * Two roles, and the role alone decides everything:
 *
 *   Admin    — the controller. Creates/edits work orders, adds reels, prints tags,
 *              sees the plant-wide Dashboard / TV view / Timers page, manages logins.
 *   Operator — the floor. Can ONLY open one reel at a time and log against it:
 *              readings, thickness checks, notes, photos, material usage, problem
 *              reports, the Stop/Resume timer, and marking a section complete. The
 *              work order's reference targets come along with the reel (getPipe
 *              returns them) so the operator can still see what they're building to,
 *              but there is no route to the dashboard, to another work order's data,
 *              or to any edit of the targets themselves.
 *
 * Operators reach the app by scanning the QR tag the controller printed for the reel.
 * That tag URL carries OPERATOR_KEY_SETTING (a shop-wide secret held in the Settings
 * sheet), which qrLogin trades for a short operator session — so the printed tag IS
 * the credential, and nobody on the floor types a password. Rotating the key from the
 * admin panel invalidates every already-printed tag, so tags must be reprinted after
 * a rotation; that's the deliberate cost of being able to revoke.
 *
 * Every action below is denied unless it's listed for the caller's role — a new action
 * added to doGet/doPost without an entry here fails closed rather than being wide open.
 * ========================================================================== */

var ROLES = ['Admin', 'Operator'];

var ACTION_ROLES = {
  // Read
  ping: ['Admin', 'Operator'],
  getPipe: ['Admin', 'Operator'],
  getWorkOrderInfo: ['Admin'],
  dashboard: ['Admin'],
  getOperatorKey: ['Admin'],
  listAccounts: ['Admin'],
  listArchive: ['Admin'],
  workOrderDeletePreview: ['Admin'],

  // Archiving is reversible; deleting is not. Both are the controller's call alone.
  archiveWorkOrder: ['Admin'],
  unarchiveWorkOrder: ['Admin'],
  deleteWorkOrder: ['Admin'],

  // Work order / reel structure — controller only
  createWorkOrder: ['Admin'],
  updateWorkOrder: ['Admin'],
  createPipe: ['Admin'],
  sendReport: ['Admin'],

  // Logging against one reel — the operator's whole job
  addReading: ['Admin', 'Operator'],
  addReadings: ['Admin', 'Operator'],
  addThicknessCheck: ['Admin', 'Operator'],
  addNote: ['Admin', 'Operator'],
  addPhoto: ['Admin', 'Operator'],
  addMaterialUsage: ['Admin', 'Operator'],
  addProblemReport: ['Admin', 'Operator'],
  resolveProblemReport: ['Admin', 'Operator'],
  startDowntime: ['Admin', 'Operator'],
  endDowntime: ['Admin', 'Operator'],
  setSectionStatus: ['Admin', 'Operator'],

  // Account management
  changePassword: ['Admin', 'Operator'],
  createAccount: ['Admin'],
  updateAccount: ['Admin'],
  resetPassword: ['Admin'],
  setAccountActive: ['Admin'],
  deleteAccount: ['Admin'],
  rotateOperatorKey: ['Admin']
};

// Unauthenticated — these are how you GET a session, so they can't require one.
var PUBLIC_ACTIONS = ['login', 'qrLogin'];

// How far a claimed reading time may sit from when the server received it before it's
// treated as hand-entered regardless of what the client said. Covers device clock skew
// plus the minute or two it takes to fill the form in.
// Bumped whenever Code.gs changes in a way that matters. Returned by ping and shown in
// the site's header, because "is the backend I just edited actually deployed?" is
// otherwise unanswerable from the outside — saving the editor does not publish it.
var BUILD = '2026-10-06.3';

var TIME_DRIFT_TOLERANCE_MIN = 5;

var SESSION_DAYS = 30;       // a typed username/password login (the controller's laptop)
var QR_SESSION_HOURS = 12;   // a scanned-tag login — about one shift on a shared tablet

var OPERATOR_KEY_SETTING = 'OperatorQrKey';

// The account every qrLogin session is issued against. It exists as a real Accounts row
// so resolveSession_ needs no special case, but its PasswordHash is left blank and
// handleLogin_ refuses a blank hash, so nobody can log into it by typing a password.
var QR_ACCOUNT_ID = 'acct_qr_operator';

var DEFAULT_ADMIN_USERNAME = 'controller';

// body key (from index.html) -> WorkOrders column. Shared by create + update so the two never drift apart.
var WO_FIELD_MAP = {
  customer: 'Customer', productCode: 'ProductCode', pipeSize: 'PipeSize', emailTo: 'EmailTo', projectLength: 'ProjectLength',

  blTargetOD: 'BL_TargetOD', blODTol: 'BL_ODTol', blTargetWall: 'BL_TargetWall', blTargetID: 'BL_TargetID',
  blTargetLength: 'BL_TargetLength', blNotes: 'BL_Notes',
  blChillerTemp: 'BL_ChillerTemp', blVacuumLevel: 'BL_VacuumLevel',
  blBackerMaterial: 'BL_BackerMaterial', blBackerRPM: 'BL_BackerRPM',
  blTZ1: 'BL_TZ1', blTZ2: 'BL_TZ2', blTZ3: 'BL_TZ3', blTZ4: 'BL_TZ4', blTZ5: 'BL_TZ5', blTClamp: 'BL_TClamp',
  blDieBody: 'BL_DieBody', blDieManifold: 'BL_DieManifold', blDieRetainer: 'BL_DieRetainer', blDieFlange: 'BL_DieFlange',
  blBondMaterial: 'BL_BondMaterial', blBondRPM: 'BL_BondRPM',
  blBondTZ1: 'BL_BondTZ1', blBondTZ2: 'BL_BondTZ2', blBondTZ3: 'BL_BondTZ3', blBondClamp: 'BL_BondClamp', blBondFlange: 'BL_BondFlange',
  blLinerMaterial: 'BL_LinerMaterial', blLinerRPM: 'BL_LinerRPM',
  blLinerTZ1: 'BL_LinerTZ1', blLinerTZ2: 'BL_LinerTZ2', blLinerTZ3: 'BL_LinerTZ3', blLinerClamp: 'BL_LinerClamp', blLinerFlange: 'BL_LinerFlange',
  blLinerThickness: 'BL_LinerThickness',

  brLongsMaterial: 'BR_LongsMaterial', brXbraidMaterial: 'BR_XbraidMaterial',
  brLongsEndsUp: 'BR_Longs', brXbraidEndsUp: 'BR_XbraidEndsUp',
  brTargetPitch: 'BR_TargetPitch', brPitchTol: 'BR_PitchTol', brTargetOD: 'BR_TargetOD', brODTol: 'BR_ODTol',
  brTargetLength: 'BR_TargetLength', brNotes: 'BR_Notes',

  cvTargetOD: 'CV_TargetOD', cvODTol: 'CV_ODTol', cvTargetWall: 'CV_TargetWall', cvTargetID: 'CV_TargetID',
  cvTargetLength: 'CV_TargetLength', cvNotes: 'CV_Notes',
  cvChillerTemp: 'CV_ChillerTemp', cvVacuumLevel: 'CV_VacuumLevel', cvBackerRPM: 'CV_BackerRPM',
  cvTZ1: 'CV_TZ1', cvTZ2: 'CV_TZ2', cvTZ3: 'CV_TZ3', cvTZ4: 'CV_TZ4', cvTZ5: 'CV_TZ5', cvTClamp: 'CV_TClamp',
  cvDieBody: 'CV_DieBody', cvDieManifold: 'CV_DieManifold', cvDieRetainer: 'CV_DieRetainer', cvDieFlange: 'CV_DieFlange',

  blTipSize: 'BL_TipSize', blDieSize: 'BL_DieSize', blCoated: 'BL_Coated',
  blConcentricityGap: 'BL_ConcentricityGap', blSizerID: 'BL_SizerID', blRearGasketHole: 'BL_RearGasketHole',
  cvTipSize: 'CV_TipSize', cvDieSize: 'CV_DieSize', cvCoated: 'CV_Coated', cvConcentricityGap: 'CV_ConcentricityGap',

  blLineSpeed: 'BL_LineSpeed', brLineSpeed: 'BR_LineSpeed', cvLineSpeed: 'CV_LineSpeed'
};
// The subset of WO_FIELD_MAP keys that are free text rather than numeric.
var WO_TEXT_KEYS = ['customer', 'productCode', 'pipeSize', 'emailTo', 'blNotes', 'brNotes', 'cvNotes',
  'blBackerMaterial', 'blBondMaterial', 'blLinerMaterial', 'brLongsMaterial', 'brXbraidMaterial',
  // Y/N, and a sizer ID written as '2.243" (27 rings)' — neither survives numOrBlank_.
  'blCoated', 'cvCoated', 'blSizerID'];

function valueForField_(body, key) {
  var v = body[key];
  if (v === undefined) return undefined;
  return WO_TEXT_KEYS.indexOf(key) >= 0 ? (v || '') : numOrBlank_(v);
}

// ---------- setup ----------

// Columns holding codes/IDs a person types in — must stay Plain Text so a value like
// "0001" or "007" is never silently coerced into the number 1/7 (which strips the
// leading zeros and breaks every lookup against it, since the app compares strings).
var TEXT_CODE_COLUMNS = {
  WorkOrders: ['Code'],
  Pipes: ['PipeCode', 'WorkOrderCode'],
  Readings: ['PipeCode'],
  ThicknessChecks: ['PipeCode'],
  Notes: ['PipeCode'],
  Photos: ['PipeCode'],
  EmailLog: ['PipeCode'],
  MaterialUsage: ['PipeCode'],
  ProblemReports: ['PipeCode'],
  DowntimeEvents: ['PipeCode'],
  Accounts: ['AccountId', 'Username', 'PasswordHash', 'PasswordSalt'],
  Sessions: ['Token', 'AccountId'],
  Settings: ['Key', 'Value']
};
var TEXT_FORMAT_ROWS = 5000; // headroom of formatted (blank) rows below the header

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HEADERS).forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    var headers = HEADERS[name];
    var existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    var same = existing.join('|') === headers.join('|');
    if (!same) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
    }

    var textCols = TEXT_CODE_COLUMNS[name] || [];
    if (textCols.length && sheet.getMaxRows() < TEXT_FORMAT_ROWS) {
      sheet.insertRowsAfter(sheet.getMaxRows(), TEXT_FORMAT_ROWS - sheet.getMaxRows());
    }
    textCols.forEach(function (colName) {
      var colIndex = headers.indexOf(colName) + 1;
      if (colIndex > 0) sheet.getRange(2, colIndex, TEXT_FORMAT_ROWS - 1, 1).setNumberFormat('@');
    });
  });
  var def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && def.getLastColumn() <= 1) ss.deleteSheet(def);

  var msg = 'Sheets are ready.';

  // One-off backfill of the denormalised last-reading columns, so reels that already
  // have history don't show a blank "Last reading" on the dashboard until someone logs
  // another one. Scans Readings once here rather than on every dashboard poll forever.
  var backfilled = backfillLastReadings_();
  if (backfilled) msg += '\n\nFilled in the last-reading summary on ' + backfilled + ' existing reel(s).';

  // The pseudo-account every scanned-tag session is issued against (see QR_ACCOUNT_ID).
  if (!findAccountById_(QR_ACCOUNT_ID)) {
    appendRow_(SHEETS.ACCOUNTS, {
      AccountId: QR_ACCOUNT_ID, Username: '(qr-scan)', Name: 'Operator (QR scan)',
      Role: 'Operator', PasswordHash: '', PasswordSalt: '', Active: true,
      CreatedAt: nowIso_(), CreatedBy: 'setup'
    });
  }

  // Shop-wide operator key that the printed QR tags carry. Generated once; rotate it
  // from the site's Admin panel (which forces reprinting tags).
  if (!getSetting_(OPERATOR_KEY_SETTING)) {
    setSetting_(OPERATOR_KEY_SETTING, makeSalt_());
  }

  // First admin. Only created when there is no admin at all, so re-running setup()
  // after you've changed the password never resets it.
  var admins = listAccounts_().filter(function (a) { return a.Role === 'Admin' && a.Active !== false; });
  if (!admins.length) {
    var tempPassword = 'srtp-' + makeSalt_().slice(0, 8);
    createAccountRow_({
      username: DEFAULT_ADMIN_USERNAME, name: 'Controller', role: 'Admin',
      password: tempPassword, createdBy: 'setup'
    });
    msg += '\n\nCreated the first admin login:\n  username: ' + DEFAULT_ADMIN_USERNAME +
      '\n  password: ' + tempPassword +
      '\n\nLog in with this, then change the password from the site (Admin > Change password).' +
      '\nThis password is shown only now — it is not recoverable from the sheet.';
  }

  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* no UI when run headless — the log has it */ }
}

// Writes each reel's newest reading onto its own row. Safe to re-run: it only touches
// reels whose stored summary is missing or older than what's actually in Readings.
function backfillLastReadings_() {
  var pipes = sheetToObjects_(SHEETS.PIPES);
  if (!pipes.length) return 0;

  /* Walked in row order, last one wins.
   *
   * Readings are only ever appended, so row order is the order they were entered — which
   * is exactly what the live path records, since apiAddReading_ overwrites these columns
   * with whatever was just submitted. Ordering by the Timestamp column instead would
   * disagree with it: an operator can back-date a reading, and two readings entered in
   * the same minute tie, in which case the earlier row would win and the summary would
   * be left showing an older footage than the reel has actually reached. */
  var newest = {};
  var newestFootage = {}; // pipeCode -> prefix -> footage
  sheetToObjects_(SHEETS.READINGS).forEach(function (r) {
    newest[r.PipeCode] = r;

    if (r.Type !== 'OD' || r.Footage === '' || r.Footage === undefined) return;
    var prefix = r.Section === 'Baseline' ? 'BL' : r.Section === 'Braidline' ? 'BR' : r.Section === 'Coverline' ? 'CV' : null;
    if (!prefix) return;
    if (!newestFootage[r.PipeCode]) newestFootage[r.PipeCode] = {};
    newestFootage[r.PipeCode][prefix] = r.Footage;
  });

  var sheet = getSheet_(SHEETS.PIPES);
  var headers = HEADERS[SHEETS.PIPES];
  var count = 0;
  pipes.forEach(function (p) {
    var r = newest[p.PipeCode];
    var foot = newestFootage[p.PipeCode];
    if (!r && !foot) return;

    var readingStale = r && !(p.LastReadingAt && new Date(p.LastReadingAt) >= new Date(r.Timestamp));
    var footageMissing = false;
    if (foot) {
      ['BL', 'BR', 'CV'].forEach(function (pfx) {
        if (foot[pfx] !== undefined && (p[pfx + '_LastFootage'] === '' || p[pfx + '_LastFootage'] === undefined)) footageMissing = true;
      });
    }
    if (!readingStale && !footageMissing) return;

    var range = sheet.getRange(p._row, 1, 1, headers.length);
    var values = range.getValues()[0];
    if (readingStale) {
      values[headers.indexOf('LastReadingAt')] = r.Timestamp;
      values[headers.indexOf('LastReadingType')] = r.Type;
      values[headers.indexOf('LastReadingValue')] = r.Value;
      values[headers.indexOf('LastReadingInTol')] = r.InTol;
    }
    if (foot) {
      ['BL', 'BR', 'CV'].forEach(function (pfx) {
        if (foot[pfx] !== undefined) values[headers.indexOf(pfx + '_LastFootage')] = foot[pfx];
      });
    }
    range.setValues([values]);
    count++;
  });
  if (count) { _memoDrop_(SHEETS.PIPES); cacheClearDash_(); }
  return count;
}

/* ---------- settings ---------- */

function getSetting_(key) {
  var rows = sheetToObjects_(SHEETS.SETTINGS);
  var row = rows.filter(function (r) { return String(r.Key) === String(key); })[0];
  return row ? String(row.Value || '') : '';
}

function setSetting_(key, value) {
  var existing = findRowByKey_(SHEETS.SETTINGS, 'Key', key);
  if (existing) updateRowByKey_(SHEETS.SETTINGS, 'Key', key, { Value: value });
  else appendRow_(SHEETS.SETTINGS, { Key: key, Value: value });
  return value;
}

function getSheet_(name) {
  if (_sheetHandles[name]) return _sheetHandles[name];
  var sheet = ss_().getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name + ' — run setup() first.');
  _sheetHandles[name] = sheet;
  return sheet;
}

// ---------- generic sheet <-> object helpers ----------

/* Per-execution memo for full-sheet reads.
 *
 * A single request often reads the same sheet several times over — findRowByKey_ then
 * updateRowByKey_, or a chain of helpers that each start with sheetToObjects_. Reading
 * a sheet is the expensive part of everything this backend does, so the second and
 * later reads within one request are served from here.
 *
 * Two things keep it honest: Apps Script can reuse a warm JS context across separate
 * web app invocations, so doGet/doPost reset it at the top rather than trusting it to
 * be fresh; and every write drops the memo for the sheet it touched, so nothing can
 * read back stale rows it just changed.
 */
var _sheetMemo = {};
var _ssHandle = null;      // the Spreadsheet object
var _sheetHandles = {};    // Sheet objects by name
var _lastRowMemo = {};     // getLastRow() results by sheet name

function _memoReset_() {
  _memoResetData_();
  // Handles are reset too: Apps Script can reuse a warm JS context between separate web
  // app invocations, and a handle carried over from a previous one is not safe to trust.
  _ssHandle = null;
  _sheetHandles = {};
}

// Forgets cached row data but keeps the sheet handles. Used when re-reading is needed
// mid-request (after taking the write lock) — a handle is only a reference to the sheet,
// it carries no row data, so dropping it there would just buy back a lookup for nothing.
function _memoResetData_() {
  _sheetMemo = {};
  _lastRowMemo = {};
}
function _memoDrop_(sheetName) {
  delete _sheetMemo[sheetName];
  delete _lastRowMemo[sheetName];
}

/* getActiveSpreadsheet(), getSheetByName() and getLastRow() are each a call across to
 * the Sheets service, not free property reads. A single request calls them dozens of
 * times — opening one reel touches seven history sheets, and every helper re-fetched its
 * own handle and row count. Now the per-execution cost of each is one call.
 *
 * With the cell counts already down, round trips are what's left of the latency: every
 * one of these is a few tens of milliseconds, and they add up faster than the data does.
 */
function ss_() {
  if (!_ssHandle) _ssHandle = SpreadsheetApp.getActiveSpreadsheet();
  return _ssHandle;
}

function lastRow_(sheetName) {
  if (_lastRowMemo[sheetName] === undefined) _lastRowMemo[sheetName] = getSheet_(sheetName).getLastRow();
  return _lastRowMemo[sheetName];
}

function sheetToObjects_(sheetName) {
  if (_sheetMemo[sheetName]) return _sheetMemo[sheetName];
  var sheet = getSheet_(sheetName);
  var lastRow = lastRow_(sheetName);
  var headers = HEADERS[sheetName];
  if (lastRow < 2) { _sheetMemo[sheetName] = []; return []; }
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var out = [];
  for (var r = 0; r < values.length; r++) {
    var obj = {};
    var blank = true;
    for (var c = 0; c < headers.length; c++) {
      var v = values[r][c];
      if (v !== '' && v !== null) blank = false;
      obj[headers[c]] = v;
    }
    if (!blank) { obj._row = r + 2; out.push(obj); }
  }
  _sheetMemo[sheetName] = out;
  return out;
}

/* Targeted reads.
 *
 * What a sheet read costs is roughly the number of cells it moves, and the history
 * sheets are wide: ThicknessChecks is 26 columns, 16 of them the individual wall points.
 * Pulling every column of every row to find the handful belonging to one reel means
 * transferring the whole sheet to throw nearly all of it away.
 *
 * These two read narrowly instead: scan one key column to find out *which* rows matter,
 * then fetch only those. For a reel with 40 thickness checks in a sheet of 5,000, that's
 * one 5,000-cell scan plus a small block, rather than 130,000 cells.
 */

// Reads only the named columns, for every data row. One getValues per column.
function scanColumns_(sheetName, colNames) {
  var sheet = getSheet_(sheetName);
  var headers = HEADERS[sheetName];
  var lastRow = lastRow_(sheetName);
  if (lastRow < 2) return [];
  var cols = colNames.map(function (n) { return headers.indexOf(n) + 1; });
  var data = cols.map(function (c) { return sheet.getRange(2, c, lastRow - 1, 1).getValues(); });
  var out = [];
  for (var i = 0; i < lastRow - 1; i++) {
    var obj = { _row: i + 2 };
    for (var k = 0; k < colNames.length; k++) obj[colNames[k]] = data[k][i][0];
    out.push(obj);
  }
  return out;
}

// Every row of a history sheet belonging to one reel.
function rowsForPipe_(sheetName, pipeCode) {
  // If something already read this sheet in full during this request, reuse that rather
  // than going back to the sheet — filtering in memory is free.
  if (_sheetMemo[sheetName]) {
    return _sheetMemo[sheetName].filter(function (r) { return String(r.PipeCode) === pipeCode; });
  }

  var sheet = getSheet_(sheetName);
  var headers = HEADERS[sheetName];
  var lastRow = lastRow_(sheetName);
  if (lastRow < 2) return [];

  var pipeCol = headers.indexOf('PipeCode') + 1;
  var keys = sheet.getRange(2, pipeCol, lastRow - 1, 1).getValues();
  var wanted = [];
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === pipeCode) wanted.push(i + 2);
  }
  if (!wanted.length) return [];

  // These sheets are append-ordered, so a reel's rows sit inside the window of its run —
  // interleaved with whatever else was on the lines that week, but nowhere near the rest
  // of plant history. Fetching that enclosing window is one round trip and skips
  // everything older.
  //
  // That only holds while the window really is a window. A reel touched at both ends of
  // a long history would make the "block" the entire sheet, and we'd have paid for the
  // key scan on top. So when the span isn't actually narrow, fall back to the plain full
  // read — on these wide sheets the key column we already read is a small fraction of
  // the width, so the fallback costs little more than reading it straight out.
  var first = wanted[0], last = wanted[wanted.length - 1];
  var span = last - first + 1;
  if (span > (lastRow - 1) * 0.5) {
    return sheetToObjects_(sheetName).filter(function (r) { return String(r.PipeCode) === pipeCode; });
  }
  var block = sheet.getRange(first, 1, span, headers.length).getValues();

  return wanted.map(function (rowNum) {
    var v = block[rowNum - first];
    var obj = {};
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = v[c];
    obj._row = rowNum;
    return obj;
  });
}

function appendRow_(sheetName, obj) {
  var sheet = getSheet_(sheetName);
  var headers = HEADERS[sheetName];
  var row = headers.map(function (h) { return (obj[h] === undefined || obj[h] === null) ? '' : obj[h]; });
  sheet.appendRow(row);
  _memoDrop_(sheetName);
  return lastRow_(sheetName);
}

function updateRowByKey_(sheetName, keyField, keyValue, patch) {
  var sheet = getSheet_(sheetName);
  var headers = HEADERS[sheetName];
  var keyCol = headers.indexOf(keyField) + 1;
  var lastRow = lastRow_(sheetName);
  if (lastRow < 2) return false;
  var keys = sheet.getRange(2, keyCol, lastRow - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === String(keyValue)) {
      var rowNum = i + 2;
      // Read the row, patch it in memory, write it back in one call. Setting each cell
      // individually meant a round trip per field — saving a work order patches ~60 of
      // them, so that was ~60 round trips for what is now two.
      var range = sheet.getRange(rowNum, 1, 1, headers.length);
      var values = range.getValues()[0];
      Object.keys(patch).forEach(function (k) {
        var idx = headers.indexOf(k);
        if (idx >= 0) values[idx] = (patch[k] === undefined || patch[k] === null) ? '' : patch[k];
      });
      range.setValues([values]);
      _memoDrop_(sheetName);
      return true;
    }
  }
  return false;
}

// Looking up one row used to pull the entire sheet. WorkOrders is ~75 columns of recipe
// data, so finding one work order to check a tolerance meant transferring every target,
// temperature and die setting of every job ever entered. Scans the key column, then
// fetches the single row it found.
function findRowByKey_(sheetName, keyField, keyValue) {
  // Already loaded this sheet in full during this request? Then scanning it is free.
  if (_sheetMemo[sheetName]) {
    var rows = _sheetMemo[sheetName];
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][keyField]) === String(keyValue)) return rows[i];
    }
    return null;
  }

  var sheet = getSheet_(sheetName);
  var headers = HEADERS[sheetName];
  var lastRow = lastRow_(sheetName);
  if (lastRow < 2) return null;

  var keyCol = headers.indexOf(keyField) + 1;
  if (keyCol < 1) return null;
  var keys = sheet.getRange(2, keyCol, lastRow - 1, 1).getValues();
  for (var k = 0; k < keys.length; k++) {
    if (String(keys[k][0]) === String(keyValue)) {
      var rowNum = k + 2;
      var values = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
      var obj = {};
      for (var c = 0; c < headers.length; c++) obj[headers[c]] = values[c];
      obj._row = rowNum;
      return obj;
    }
  }
  return null;
}

// Deletes every row the predicate matches. Bottom-up, so deleting one row doesn't
// shift the row numbers of the ones still queued behind it.
function deleteRowsWhere_(sheetName, predicate) {
  var sheet = getSheet_(sheetName);
  var doomed = sheetToObjects_(sheetName).filter(predicate);
  doomed.sort(function (a, b) { return b._row - a._row; })
    .forEach(function (r) { sheet.deleteRow(r._row); });
  _memoDrop_(sheetName);
  return doomed.length;
}

function findRowByCode_(sheetName, code) { return findRowByKey_(sheetName, 'Code', code); }
function updateRowByCode_(sheetName, code, patch) { return updateRowByKey_(sheetName, 'Code', code, patch); }

// ---------- read cache ----------
// getPipe/dashboard each do several full-sheet scans (sheetToObjects_ reads every row of
// every history sheet, across ALL work orders ever entered — cost grows with total plant
// history, not just one reel). The front end already polls these every 20s, so a short
// cache turns repeat polls into a CacheService hit instead of 8+ full-sheet reads. TTL is
// kept under the poll interval, and every write clears the affected keys so nobody's own
// change is ever masked by a stale cache entry.
// Longer than the front end's 20s poll on purpose: at 15s every poll from a single
// browser missed, so the cache only ever helped when two people watched at once. Writes
// still clear it, so your own changes are never hidden behind it.
var CACHE_TTL_SEC = 45;

function cache_() { return CacheService.getScriptCache(); }

function cacheGetJson_(key) {
  try { var v = cache_().get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
function cacheSetJson_(key, obj, ttlSec) {
  try { cache_().put(key, JSON.stringify(obj), ttlSec || CACHE_TTL_SEC); } catch (e) { /* over 100KB or cache unavailable — just skip caching */ }
}
function cacheClearPipe_(pipeCode) {
  try { cache_().removeAll(['dash', 'pipe:' + pipeCode]); } catch (e) { /* non-fatal */ }
}
function cacheClearDash_() {
  try { cache_().remove('dash'); } catch (e) { /* non-fatal */ }
}

function newId_() { return Utilities.getUuid(); }
function nowIso_() { return new Date().toISOString(); }
function round4_(n) { return Math.round(n * 10000) / 10000; }

function numOrBlank_(v) {
  if (v === undefined || v === null || v === '') return '';
  var n = Number(v);
  return isNaN(n) ? '' : n;
}

// ---------- accounts / passwords / sessions ----------

function makeSalt_() {
  return Utilities.getUuid().replace(/-/g, '');
}

function hashPassword_(password, salt) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(password) + ':' + salt);
  return digest.map(function (b) {
    var v = (b < 0 ? b + 256 : b);
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

// Compares two hex strings in constant time so a wrong password can't be narrowed down
// by timing how long the rejection took.
function hashesEqual_(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return diff === 0;
}

function listAccounts_() { return sheetToObjects_(SHEETS.ACCOUNTS); }

function findAccountByUsername_(username) {
  var uname = String(username || '').trim().toLowerCase();
  if (!uname) return null;
  return listAccounts_().filter(function (a) { return String(a.Username).trim().toLowerCase() === uname; })[0] || null;
}

function findAccountById_(accountId) {
  return listAccounts_().filter(function (a) { return String(a.AccountId) === String(accountId); })[0] || null;
}

function createAccountRow_(opts) {
  var username = String(opts.username || '').trim();
  if (!username) throw new Error('Username is required');
  if (findAccountByUsername_(username)) throw new Error('That username is already taken');
  if (!opts.password || String(opts.password).length < 6) throw new Error('Password must be at least 6 characters');
  if (ROLES.indexOf(opts.role) < 0) throw new Error('Unknown role: ' + opts.role);

  var salt = makeSalt_();
  var accountId = 'acct_' + newId_();
  appendRow_(SHEETS.ACCOUNTS, {
    AccountId: accountId, Username: username, Name: opts.name || username, Role: opts.role,
    PasswordHash: hashPassword_(opts.password, salt), PasswordSalt: salt,
    Active: true, CreatedAt: nowIso_(), CreatedBy: opts.createdBy || ''
  });
  return accountId;
}

// What the front end is allowed to know about an account. Never includes the hash or salt.
function publicAccount_(acc) {
  return {
    accountId: acc.AccountId, username: acc.Username, name: acc.Name,
    role: acc.Role, active: acc.Active !== false
  };
}

function issueSession_(accountId, kind) {
  var token = Utilities.getUuid();
  var ms = kind === 'qr' ? QR_SESSION_HOURS * 60 * 60 * 1000 : SESSION_DAYS * 24 * 60 * 60 * 1000;
  appendRow_(SHEETS.SESSIONS, {
    Token: token, AccountId: accountId, Kind: kind,
    CreatedAt: nowIso_(), ExpiresAt: new Date(Date.now() + ms).toISOString()
  });
  return token;
}

/* Resolving a token used to cost two full-sheet reads (Sessions, then Accounts) on
 * EVERY request — including each 20-second dashboard poll and every reading saved from
 * the floor. That was by far the most expensive thing the backend did, because it was
 * the one thing nothing could skip.
 *
 * Now a resolved session is cached for SESSION_CACHE_SEC, so a signed-in browser's
 * requests cost nothing to authorize. The trade is that revoking access could take up
 * to that long to bite, so everything that revokes — logout, disabling, deleting, a
 * role change, rotating the operator key — drops the cached entries explicitly rather
 * than waiting for them to expire. See dropCachedSessionsFor_.
 */
var SESSION_CACHE_SEC = 600;

function sessionCacheKey_(token) { return 'sess:' + token; }

// Only what authorize_ and the handlers actually need — never the password hash or salt.
function slimAccount_(acc) {
  return { AccountId: acc.AccountId, Username: acc.Username, Name: acc.Name, Role: acc.Role, Active: acc.Active !== false };
}

function resolveSession_(token) {
  if (!token) return null;

  var cached = cacheGetJson_(sessionCacheKey_(token));
  if (cached) {
    // Still honour the session's own expiry, so a cached entry can't outlive the login.
    if (new Date(cached.expiresAt).getTime() < Date.now()) return null;
    return cached.account;
  }

  var row = findRowByKey_(SHEETS.SESSIONS, 'Token', token);
  if (!row) return null;
  if (new Date(row.ExpiresAt).getTime() < Date.now()) return null;
  var acc = findAccountById_(row.AccountId);
  if (!acc || acc.Active === false) return null;

  var slim = slimAccount_(acc);
  cacheSetJson_(sessionCacheKey_(token), { account: slim, expiresAt: row.ExpiresAt }, SESSION_CACHE_SEC);
  return slim;
}

function dropCachedSession_(token) {
  try { cache_().remove(sessionCacheKey_(token)); } catch (e) { /* non-fatal */ }
}

// Drops the cached authorizations for every live session of an account, so a disable,
// delete or role change takes effect on the account's next request rather than whenever
// the cache happens to expire.
function dropCachedSessionsFor_(accountId) {
  sheetToObjects_(SHEETS.SESSIONS)
    .filter(function (s) { return String(s.AccountId) === String(accountId); })
    .forEach(function (s) { dropCachedSession_(s.Token); });
}

// Drops expired session rows so the sheet doesn't grow without bound (every scan of a
// tag mints one). Called opportunistically from handleLogin_/handleQrLogin_ — those
// already hold the script lock and already pay for a Sessions read.
/* Only worth doing in bulk. Pruning ran on every single sign-in, deleting expired rows
 * one at a time while holding the global write lock — so every tag scan on the floor
 * stalled everyone else's saves, and got worse the longer the app ran, because more
 * sessions had expired since the last clean. That made a routine scan one of the most
 * expensive things the backend did.
 *
 * Now it waits until there's a worthwhile batch, and removes consecutive rows in one
 * call each instead of one call per row. Sessions are appended in time order and expire
 * on fixed lifetimes, so the expired ones sit in long runs — in practice a whole shift's
 * worth comes out in one or two calls rather than sixty.
 */
var SESSION_PRUNE_THRESHOLD = 40;

function pruneSessions_(force) {
  var sheet = getSheet_(SHEETS.SESSIONS);
  var rows = sheetToObjects_(SHEETS.SESSIONS);
  var now = Date.now();
  var stale = rows.filter(function (r) { return new Date(r.ExpiresAt).getTime() < now; });
  if (!stale.length) return 0;
  // Below the threshold the rows are cheap to carry and not worth stalling a sign-in for.
  if (!force && stale.length < SESSION_PRUNE_THRESHOLD) return 0;

  // Walk the doomed rows from the bottom up, deleting each consecutive run in one call.
  // Bottom-up so deletions don't shift the rows still queued behind them.
  var nums = stale.map(function (r) { return r._row; }).sort(function (a, b) { return b - a; });
  var removed = 0;
  var i = 0;
  while (i < nums.length) {
    var top = nums[i];
    var j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] - 1) j++;
    var bottom = nums[j];
    sheet.deleteRows(bottom, top - bottom + 1);
    removed += top - bottom + 1;
    i = j + 1;
  }
  _memoDrop_(SHEETS.SESSIONS);
  return removed;
}

function revokeSession_(token) {
  if (!token) return false;
  var row = findRowByKey_(SHEETS.SESSIONS, 'Token', token);
  if (!row) return false;
  getSheet_(SHEETS.SESSIONS).deleteRow(row._row);
  dropCachedSession_(token);
  _memoDrop_(SHEETS.SESSIONS);
  return true;
}

// The single gate every non-public action goes through. Throws an auth error (which the
// entry points turn into code:'session_invalid', so the front end knows to show the login)
// when there's no valid session, and a plain error when the role simply isn't allowed.
function authorize_(action, token) {
  var acc = resolveSession_(token);
  if (!acc) { var e = new Error('Not signed in'); e.authError = true; throw e; }
  var allowed = ACTION_ROLES[action];
  if (!allowed) throw new Error('Unknown action: ' + action);
  if (allowed.indexOf(acc.Role) < 0) throw new Error('Your login is not allowed to do that');
  return acc;
}

// ---------- auth API ----------

function apiLogin_(body) {
  pruneSessions_();
  var acc = findAccountByUsername_(body.username);
  var generic = 'Invalid username or password';
  // A blank hash means the account can't be logged into with a password at all — that's
  // how the QR pseudo-account is kept unreachable from the login form.
  if (!acc || acc.Active === false || !acc.PasswordHash) throw new Error(generic);
  if (!hashesEqual_(hashPassword_(body.password, acc.PasswordSalt), acc.PasswordHash)) throw new Error(generic);
  return { token: issueSession_(acc.AccountId, 'password'), account: publicAccount_(acc) };
}

// Trades the shop operator key printed into a reel's QR tag for an operator session.
function apiQrLogin_(body) {
  var expected = getSetting_(OPERATOR_KEY_SETTING);
  if (!expected) throw new Error('No operator key is configured — run setup() once from the Apps Script editor');
  if (!hashesEqual_(String(body.key || ''), expected)) throw new Error('This tag is out of date — ask the controller to print a new one');
  pruneSessions_();
  var acc = findAccountById_(QR_ACCOUNT_ID);
  if (!acc) throw new Error('Operator account is missing — run setup() once from the Apps Script editor');
  return { token: issueSession_(QR_ACCOUNT_ID, 'qr'), account: publicAccount_(acc) };
}

function apiLogout_(body) {
  revokeSession_(body.token);
  return { ok: true };
}

function apiChangePassword_(acc, body) {
  // authorize_ hands back the slim cached account, which deliberately carries no hash
  // or salt — read the real row for the one action that needs them.
  var full = findAccountById_(acc.AccountId);
  if (!full || !full.PasswordHash) throw new Error('This login has no password to change');
  if (!hashesEqual_(hashPassword_(body.oldPassword, full.PasswordSalt), full.PasswordHash)) {
    throw new Error('Current password is incorrect');
  }
  if (!body.newPassword || String(body.newPassword).length < 6) throw new Error('New password must be at least 6 characters');
  var salt = makeSalt_();
  updateRowByKey_(SHEETS.ACCOUNTS, 'AccountId', acc.AccountId, {
    PasswordHash: hashPassword_(body.newPassword, salt), PasswordSalt: salt
  });
  return { ok: true };
}

function apiListAccounts_() {
  return {
    accounts: listAccounts_()
      .filter(function (a) { return a.AccountId !== QR_ACCOUNT_ID; })
      .map(publicAccount_)
  };
}

function apiCreateAccount_(acc, body) {
  createAccountRow_({
    username: body.username, name: body.name, role: body.role,
    password: body.password, createdBy: acc.Username
  });
  return apiListAccounts_();
}

function apiUpdateAccount_(acc, body) {
  var target = findAccountById_(body.accountId);
  if (!target || target.AccountId === QR_ACCOUNT_ID) throw new Error('Unknown account');
  var patch = {};
  if (body.name !== undefined) patch.Name = body.name;
  if (body.role !== undefined) {
    if (ROLES.indexOf(body.role) < 0) throw new Error('Unknown role: ' + body.role);
    if (target.Role === 'Admin' && body.role !== 'Admin') assertNotLastAdmin_(target.AccountId);
    patch.Role = body.role;
  }
  updateRowByKey_(SHEETS.ACCOUNTS, 'AccountId', body.accountId, patch);
  // A role change must bite on the next request, not whenever the cache expires.
  dropCachedSessionsFor_(body.accountId);
  return apiListAccounts_();
}

function apiResetPassword_(acc, body) {
  var target = findAccountById_(body.accountId);
  if (!target || target.AccountId === QR_ACCOUNT_ID) throw new Error('Unknown account');
  if (!body.newPassword || String(body.newPassword).length < 6) throw new Error('Password must be at least 6 characters');
  var salt = makeSalt_();
  updateRowByKey_(SHEETS.ACCOUNTS, 'AccountId', body.accountId, {
    PasswordHash: hashPassword_(body.newPassword, salt), PasswordSalt: salt
  });
  return { ok: true };
}

function apiSetAccountActive_(acc, body) {
  var target = findAccountById_(body.accountId);
  if (!target || target.AccountId === QR_ACCOUNT_ID) throw new Error('Unknown account');
  var active = !!body.active;
  if (!active && target.Role === 'Admin') assertNotLastAdmin_(target.AccountId);
  updateRowByKey_(SHEETS.ACCOUNTS, 'AccountId', body.accountId, { Active: active });
  if (!active) revokeAccountSessions_(body.accountId);
  return apiListAccounts_();
}

function apiDeleteAccount_(acc, body) {
  var target = findAccountById_(body.accountId);
  if (!target || target.AccountId === QR_ACCOUNT_ID) throw new Error('Unknown account');
  if (target.Role === 'Admin') assertNotLastAdmin_(target.AccountId);
  getSheet_(SHEETS.ACCOUNTS).deleteRow(target._row);
  _memoDrop_(SHEETS.ACCOUNTS);
  revokeAccountSessions_(body.accountId);
  return apiListAccounts_();
}

// Guards against locking everyone out of the admin side of the site.
function assertNotLastAdmin_(accountId) {
  var others = listAccounts_().filter(function (a) {
    return a.Role === 'Admin' && a.Active !== false && String(a.AccountId) !== String(accountId);
  });
  if (!others.length) throw new Error('This is the only active admin — create another admin first');
}

function revokeAccountSessions_(accountId) {
  dropCachedSessionsFor_(accountId);
  var sheet = getSheet_(SHEETS.SESSIONS);
  sheetToObjects_(SHEETS.SESSIONS)
    .filter(function (s) { return String(s.AccountId) === String(accountId); })
    .sort(function (a, b) { return b._row - a._row; })
    .forEach(function (s) { sheet.deleteRow(s._row); });
  _memoDrop_(SHEETS.SESSIONS);
}

function apiGetOperatorKey_() {
  return { key: getSetting_(OPERATOR_KEY_SETTING) };
}

// Invalidates every QR tag already printed — the controller has to reprint them. Existing
// scanned-tag sessions are killed too, so a rotation takes effect immediately rather than
// leaving up to QR_SESSION_HOURS of access behind.
function apiRotateOperatorKey_() {
  var key = setSetting_(OPERATOR_KEY_SETTING, makeSalt_());
  revokeAccountSessions_(QR_ACCOUNT_ID);
  return { key: key };
}

// ---------- web entry points ----------

function doGet(e) {
  var _t0 = Date.now();
  _memoReset_(); // Apps Script may reuse a warm context across invocations
  try {
    var action = e.parameter.action || 'ping';
    authorize_(action, e.parameter.token);
    var result;
    switch (action) {
      case 'ping': result = { ok: true, time: nowIso_(), build: BUILD }; break;
      case 'getPipe':
        var pipeCode = String(e.parameter.pipeCode || '').trim();
        var pipeKey = 'pipe:' + pipeCode;
        result = cacheGetJson_(pipeKey);
        if (!result) { result = apiGetPipe_(pipeCode); cacheSetJson_(pipeKey, result); }
        break;
      case 'getWorkOrderInfo': result = apiGetWorkOrderInfo_(e.parameter.code); break;
      case 'dashboard':
        result = cacheGetJson_('dash');
        if (!result) { result = apiDashboard_(); cacheSetJson_('dash', result); }
        break;
      case 'getOperatorKey': result = apiGetOperatorKey_(); break;
      case 'listAccounts': result = apiListAccounts_(); break;
      case 'listArchive': result = apiListArchive_(); break;
      case 'workOrderDeletePreview': result = apiWorkOrderDeletePreview_(e.parameter.code); break;
      default: throw new Error('Unknown GET action: ' + action);
    }
    return jsonOut_({ ok: true, data: result }, _t0);
  } catch (err) {
    if (err && err.authError) return jsonOut_({ ok: false, error: 'Not signed in', code: 'session_invalid' }, _t0);
    return jsonOut_({ ok: false, error: String(err && err.message || err) }, _t0);
  }
}

function doPost(e) {
  var _t0 = Date.now();
  _memoReset_(); // Apps Script may reuse a warm context across invocations
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var result;
    var lock = LockService.getScriptLock();

    // login/qrLogin are how a session is obtained, so they run before the auth gate.
    // They write session rows, so they keep the lock.
    if (PUBLIC_ACTIONS.indexOf(action) >= 0) {
      lock.waitLock(15000);
      try {
        result = (action === 'login') ? apiLogin_(body) : apiQrLogin_(body);
      } finally { lock.releaseLock(); }
      return jsonOut_({ ok: true, data: result }, _t0);
    }
    if (action === 'logout') return jsonOut_({ ok: true, data: apiLogout_(body) }, _t0);

    // Authorising reads a cached session, so it needs no lock — and doing it here means
    // nothing below runs for a caller who isn't allowed it.
    var acc = authorize_(action, body.token);

    /* Slow work that touches nothing another writer is touching happens before the lock.
     * The write lock is plant-wide: whoever holds it, everyone else's save waits. A photo
     * going to Drive or a report going to Gmail is seconds of that, for work no other
     * writer could conflict with. See preLockWork_. */
    var pre = preLockWork_(action, body);

    lock.waitLock(15000);
    try {
      // Anything read before the lock was read against pre-lock state; drop the cached rows
      // so every read inside the lock sees what's actually there now. Handles are kept.
      _memoResetData_();
      switch (action) {
        case 'createWorkOrder': result = apiCreateWorkOrder_(body); break;
        case 'updateWorkOrder': result = apiUpdateWorkOrder_(body); break;
        case 'createPipe': result = apiCreatePipe_(body); break;
        case 'addReading': result = apiAddReading_(body); break;
        case 'addReadings': result = apiAddReadings_(body); break;
        case 'addThicknessCheck': result = apiAddThicknessCheck_(body); break;
        case 'addNote': result = apiAddNote_(body); break;
        case 'addPhoto': result = apiAddPhoto_(body, pre); break;
        case 'addMaterialUsage': result = apiAddMaterialUsage_(body); break;
        case 'addProblemReport': result = apiAddProblemReport_(body); break;
        case 'resolveProblemReport': result = apiResolveProblemReport_(body); break;
        case 'startDowntime': result = apiStartDowntime_(body); break;
        case 'endDowntime': result = apiEndDowntime_(body); break;
        case 'setSectionStatus': result = apiSetSectionStatus_(body); break;
        case 'sendReport': result = apiSendReport_(body, pre); break;

        case 'changePassword': result = apiChangePassword_(acc, body); break;
        case 'createAccount': result = apiCreateAccount_(acc, body); break;
        case 'updateAccount': result = apiUpdateAccount_(acc, body); break;
        case 'resetPassword': result = apiResetPassword_(acc, body); break;
        case 'setAccountActive': result = apiSetAccountActive_(acc, body); break;
        case 'deleteAccount': result = apiDeleteAccount_(acc, body); break;
        case 'rotateOperatorKey': result = apiRotateOperatorKey_(); break;

        case 'archiveWorkOrder': result = apiArchiveWorkOrder_(body, acc); break;
        case 'unarchiveWorkOrder': result = apiUnarchiveWorkOrder_(body); break;
        case 'deleteWorkOrder': result = apiDeleteWorkOrder_(body); break;

        default: throw new Error('Unknown POST action: ' + action);
      }
    } finally {
      lock.releaseLock();
    }
    /* Hand back the reel's refreshed state with the write that changed it.
     *
     * Every operator action used to be two requests — save, then a separate reload to
     * redraw. An Apps Script web app carries most of a second of fixed overhead per
     * request whatever it's doing, so that doubled the wait on everything the floor does,
     * and logging a Braidline reading (pitch, OD, reload) was three.
     *
     * The data is already to hand here, right after the write, so sending it back costs
     * one extra sheet pass instead of a whole extra round trip. Failing to build it must
     * not fail the write — the write already succeeded — so the client just falls back to
     * reloading if `pipe` is missing. */
    var out = { ok: true, data: result };
    if (body.withPipe && body.pipeCode) {
      try {
        var pc = String(body.pipeCode).trim();
        out.pipe = apiGetPipe_(pc);
        cacheSetJson_('pipe:' + pc, out.pipe);
      } catch (e) { /* client falls back to its own reload */ }
    }
    return jsonOut_(out, _t0);
  } catch (err) {
    if (err && err.authError) return jsonOut_({ ok: false, error: 'Not signed in', code: 'session_invalid' }, _t0);
    return jsonOut_({ ok: false, error: String(err && err.message || err) }, _t0);
  }
}

// Every response carries how long the server spent on it and which build answered, so
// "it feels slow" can be checked against a number instead of guessed at.
/* Work done before the write lock is taken.
 *
 * Only for operations whose slow part is external (Drive, Gmail) and touches no sheet
 * another writer could be changing. Everything that reads or writes the Sheet still
 * happens under the lock.
 *
 * The trade: if the lock then times out, the file is already in Drive or the mail is
 * already sent, and the row recording it isn't written. That's an orphaned file or an
 * email the log doesn't show — annoying, but far better than the alternative it replaces,
 * where one person's photo upload could push everyone else past the lock timeout and
 * fail their saves outright. It also becomes much less likely, because this is the change
 * that stops the lock being held that long in the first place.
 */
function preLockWork_(action, body) {
  if (action === 'addPhoto' && body.imageBase64) {
    var pipeCode = String(body.pipeCode || '').trim();
    // Validate before uploading, so a bad reel code doesn't leave a file behind. This is
    // a read, so it's safe outside the lock.
    if (!findRowByKey_(SHEETS.PIPES, 'PipeCode', pipeCode)) throw new Error('Reel not found: ' + pipeCode);
    return { uploaded: uploadPhotoToDrive_(pipeCode, body.imageBase64, body.filename, body.mimeType) };
  }
  if (action === 'sendReport') {
    return sendReportEmail_(body);
  }
  return null;
}

function jsonOut_(obj, t0) {
  if (t0) { obj.ms = Date.now() - t0; obj.build = BUILD; }
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- work order API ----------

function apiCreateWorkOrder_(body) {
  var code = String(body.code || '').trim();
  if (!code) throw new Error('Work order code is required.');
  if (findRowByCode_(SHEETS.WORKORDERS, code)) throw new Error('Work order code "' + code + '" already exists.');

  var row = { Code: code, CreatedAt: nowIso_(), CreatedBy: body.createdBy || '', LastUpdated: nowIso_() };
  Object.keys(WO_FIELD_MAP).forEach(function (key) {
    var v = valueForField_(body, key);
    row[WO_FIELD_MAP[key]] = (v === undefined) ? '' : v;
  });
  if (!row.EmailTo) row.EmailTo = DEFAULT_EMAIL_TO;
  appendRow_(SHEETS.WORKORDERS, row);
  cacheClearDash_();
  return { code: code };
}

function apiUpdateWorkOrder_(body) {
  var code = String(body.code || '').trim();
  if (!code) throw new Error('Work order code is required.');
  var patch = {};
  Object.keys(WO_FIELD_MAP).forEach(function (key) {
    if (body[key] !== undefined) patch[WO_FIELD_MAP[key]] = valueForField_(body, key);
  });
  patch.LastUpdated = nowIso_();
  var okUpd = updateRowByCode_(SHEETS.WORKORDERS, code, patch);
  if (!okUpd) throw new Error('Work order not found: ' + code);
  cacheClearDash_();
  sheetToObjects_(SHEETS.PIPES).filter(function (p) { return String(p.WorkOrderCode) === code; })
    .forEach(function (p) { cacheClearPipe_(p.PipeCode); });
  return { code: code };
}

function apiGetWorkOrderInfo_(code) {
  code = String(code || '').trim();
  if (!code) throw new Error('code is required.');
  var wo = findRowByCode_(SHEETS.WORKORDERS, code);
  if (!wo) throw new Error('Work order not found: ' + code);
  var pipes = sheetToObjects_(SHEETS.PIPES).filter(function (p) { return String(p.WorkOrderCode) === code; });
  return { workOrder: wo, pipes: pipes };
}

// ---------- archive / delete ----------

/* Two stages, deliberately: archiving clears a finished job off the dashboard and is
 * fully reversible, and only from the archive can anything actually be destroyed.
 * Nothing in the app deletes production history in one step.
 *
 * A work order's child data is keyed by PipeCode, not by work order, so a permanent
 * delete has to walk the pipes first and clear every history sheet by their codes —
 * otherwise the rows survive as orphans that no longer belong to anything. */

function isArchived_(wo) { return wo.Archived === true || String(wo.Archived).toUpperCase() === 'TRUE'; }

function apiArchiveWorkOrder_(body, acc) {
  var code = String(body.code || '').trim();
  var wo = findRowByCode_(SHEETS.WORKORDERS, code);
  if (!wo) throw new Error('Work order not found: ' + code);
  updateRowByCode_(SHEETS.WORKORDERS, code, {
    Archived: true, ArchivedAt: nowIso_(), ArchivedBy: (acc && acc.Username) || ''
  });
  cacheClearDash_();
  return { code: code, archived: true };
}

function apiUnarchiveWorkOrder_(body) {
  var code = String(body.code || '').trim();
  var wo = findRowByCode_(SHEETS.WORKORDERS, code);
  if (!wo) throw new Error('Work order not found: ' + code);
  updateRowByCode_(SHEETS.WORKORDERS, code, { Archived: false, ArchivedAt: '', ArchivedBy: '' });
  cacheClearDash_();
  return { code: code, archived: false };
}

function apiListArchive_() {
  var archived = sheetToObjects_(SHEETS.WORKORDERS).filter(isArchived_);
  var pipes = sheetToObjects_(SHEETS.PIPES);
  return {
    workOrders: archived.map(function (wo) {
      var mine = pipes.filter(function (p) { return String(p.WorkOrderCode) === String(wo.Code); });
      return {
        code: wo.Code, customer: wo.Customer || '', productCode: wo.ProductCode || '',
        pipeSize: wo.PipeSize || '', projectLength: wo.ProjectLength,
        createdAt: wo.CreatedAt, archivedAt: wo.ArchivedAt, archivedBy: wo.ArchivedBy,
        pipeCount: mine.length,
        pipeCodes: mine.map(function (p) { return p.PipeCode; }),
        completePipes: mine.filter(function (p) { return p.OverallStatus === 'Complete'; }).length
      };
    }).sort(function (a, b) { return new Date(b.archivedAt) - new Date(a.archivedAt); })
  };
}

// What a permanent delete would destroy. The front end shows this before asking the
// controller to confirm, so nobody is agreeing to a number they haven't seen.
function apiWorkOrderDeletePreview_(code) {
  code = String(code || '').trim();
  var wo = findRowByCode_(SHEETS.WORKORDERS, code);
  if (!wo) throw new Error('Work order not found: ' + code);
  var pipeCodes = sheetToObjects_(SHEETS.PIPES)
    .filter(function (p) { return String(p.WorkOrderCode) === code; })
    .map(function (p) { return String(p.PipeCode); });
  var inSet = function (r) { return pipeCodes.indexOf(String(r.PipeCode)) >= 0; };
  return {
    code: code, archived: isArchived_(wo), pipeCodes: pipeCodes,
    counts: {
      pipes: pipeCodes.length,
      readings: sheetToObjects_(SHEETS.READINGS).filter(inSet).length,
      thicknessChecks: sheetToObjects_(SHEETS.THICKNESS).filter(inSet).length,
      notes: sheetToObjects_(SHEETS.NOTES).filter(inSet).length,
      photos: sheetToObjects_(SHEETS.PHOTOS).filter(inSet).length,
      materialUsage: sheetToObjects_(SHEETS.MATERIAL).filter(inSet).length,
      problemReports: sheetToObjects_(SHEETS.PROBLEMS).filter(inSet).length,
      downtimeEvents: sheetToObjects_(SHEETS.DOWNTIME).filter(inSet).length
    }
  };
}

function apiDeleteWorkOrder_(body) {
  var code = String(body.code || '').trim();
  var wo = findRowByCode_(SHEETS.WORKORDERS, code);
  if (!wo) throw new Error('Work order not found: ' + code);

  // Archive first, delete second — this refuses to skip the reversible stage even if
  // something calls it directly rather than through the UI.
  if (!isArchived_(wo)) throw new Error('Archive this work order before deleting it');
  // The caller must retype the code. Guards against a mis-click destroying the wrong job.
  if (String(body.confirmCode || '').trim() !== code) throw new Error('Type the work order code exactly to confirm');

  var pipeCodes = sheetToObjects_(SHEETS.PIPES)
    .filter(function (p) { return String(p.WorkOrderCode) === code; })
    .map(function (p) { return String(p.PipeCode); });
  var inSet = function (r) { return pipeCodes.indexOf(String(r.PipeCode)) >= 0; };

  // Drive files go to the trash rather than being erased: Drive keeps them ~30 days,
  // which is the one safety net left after this point. A Drive failure must not abort
  // the delete and leave the sheets half-cleared, so each is tried independently.
  var photos = sheetToObjects_(SHEETS.PHOTOS).filter(inSet);
  var trashed = 0, trashFailed = 0;
  photos.forEach(function (p) {
    if (!p.DriveFileId) return;
    try { DriveApp.getFileById(p.DriveFileId).setTrashed(true); trashed++; }
    catch (e) { trashFailed++; }
  });

  var deleted = {
    readings: deleteRowsWhere_(SHEETS.READINGS, inSet),
    thicknessChecks: deleteRowsWhere_(SHEETS.THICKNESS, inSet),
    notes: deleteRowsWhere_(SHEETS.NOTES, inSet),
    photos: deleteRowsWhere_(SHEETS.PHOTOS, inSet),
    materialUsage: deleteRowsWhere_(SHEETS.MATERIAL, inSet),
    problemReports: deleteRowsWhere_(SHEETS.PROBLEMS, inSet),
    downtimeEvents: deleteRowsWhere_(SHEETS.DOWNTIME, inSet),
    emailLog: deleteRowsWhere_(SHEETS.EMAILLOG, inSet),
    pipes: deleteRowsWhere_(SHEETS.PIPES, function (p) { return String(p.WorkOrderCode) === code; }),
    workOrders: deleteRowsWhere_(SHEETS.WORKORDERS, function (w) { return String(w.Code) === code; })
  };

  pipeCodes.forEach(cacheClearPipe_);
  cacheClearDash_();
  return { code: code, deleted: deleted, photosTrashed: trashed, photosNotTrashed: trashFailed };
}

// ---------- pipe API ----------

function apiCreatePipe_(body) {
  var pipeCode = String(body.pipeCode || '').trim();
  var workOrderCode = String(body.workOrderCode || '').trim();
  if (!pipeCode) throw new Error('Reel code is required.');
  if (!workOrderCode) throw new Error('Work order code is required.');
  if (!findRowByCode_(SHEETS.WORKORDERS, workOrderCode)) throw new Error('Work order not found: ' + workOrderCode);
  if (findRowByKey_(SHEETS.PIPES, 'PipeCode', pipeCode)) throw new Error('Reel code "' + pipeCode + '" already exists.');

  var row = {
    PipeCode: pipeCode, WorkOrderCode: workOrderCode, CreatedAt: nowIso_(), CreatedBy: body.createdBy || '',
    BL_Status: 'Not started', BL_StartedAt: '', BL_CompletedAt: '', BL_ActualLength: '',
    BR_Status: 'Not started', BR_StartedAt: '', BR_CompletedAt: '', BR_ActualLength: '',
    CV_Status: 'Not started', CV_StartedAt: '', CV_CompletedAt: '', CV_ActualLength: '',
    OverallStatus: 'Active', LastUpdated: nowIso_(), LastEmailAt: ''
  };
  appendRow_(SHEETS.PIPES, row);
  cacheClearDash_();
  return { pipeCode: pipeCode, workOrderCode: workOrderCode };
}

function apiGetPipe_(pipeCode) {
  pipeCode = String(pipeCode || '').trim();
  if (!pipeCode) throw new Error('pipeCode is required.');
  var allPipes = sheetToObjects_(SHEETS.PIPES);
  var pipe = allPipes.filter(function (p) { return String(p.PipeCode) === pipeCode; })[0];
  if (!pipe) throw new Error('Reel not found: ' + pipeCode);
  var wo = findRowByCode_(SHEETS.WORKORDERS, pipe.WorkOrderCode);
  if (!wo) throw new Error('Work order not found for pipe: ' + pipeCode);

  var readings = rowsForPipe_(SHEETS.READINGS, pipeCode);
  var checks = rowsForPipe_(SHEETS.THICKNESS, pipeCode);
  var notes = rowsForPipe_(SHEETS.NOTES, pipeCode);
  var photos = rowsForPipe_(SHEETS.PHOTOS, pipeCode);
  var material = rowsForPipe_(SHEETS.MATERIAL, pipeCode);
  var problems = rowsForPipe_(SHEETS.PROBLEMS, pipeCode);
  var downtime = rowsForPipe_(SHEETS.DOWNTIME, pipeCode);
  var siblingPipes = allPipes.filter(function (p) { return String(p.WorkOrderCode) === String(pipe.WorkOrderCode); });

  return {
    pipe: pipe, workOrder: wo, readings: readings, thicknessChecks: checks, notes: notes, photos: photos,
    materialUsage: material, problemReports: problems, downtimeEvents: downtime, siblingPipes: siblingPipes
  };
}

function apiAddReading_(body) {
  var pipeCode = String(body.pipeCode || '').trim();
  var pipe = findRowByKey_(SHEETS.PIPES, 'PipeCode', pipeCode);
  if (!pipe) throw new Error('Reel not found: ' + pipeCode);
  var wo = findRowByCode_(SHEETS.WORKORDERS, pipe.WorkOrderCode);
  var value = Number(body.value);
  if (isNaN(value)) throw new Error('Reading value must be numeric.');
  var section = body.section, type = body.type;
  var inTol = computeInTol_(wo, section, type, value);

  /* Timestamp provenance.
   *
   * The operator can change the time on a reading, which is legitimate — you write the
   * measurement down at the gauge and type it in when you get back. But it also lets
   * someone sit on a stack of missed hourly checks and back-date them all at the end of
   * a shift, which is exactly what the hourly check exists to prevent.
   *
   * So the server records when it actually received the reading, and how far the claimed
   * time sits from that. The client says whether the operator touched the time field, and
   * that's trusted when it says "Manual" — but not when it says "Device", because a claim
   * of untouched that arrives with the clock well out is either a back-date or a device
   * whose clock is wrong, and both are worth a controller seeing. */
  var enteredAt = nowIso_();
  var claimedTs = body.timestamp || enteredAt;
  var offsetMin = Math.round((new Date(claimedTs).getTime() - new Date(enteredAt).getTime()) / 60000);
  var saysManual = body.timeSource === 'Manual';
  var timeSource = (saysManual || Math.abs(offsetMin) > TIME_DRIFT_TOLERANCE_MIN) ? 'Manual' : 'Device';

  var row = {
    RowId: newId_(), PipeCode: pipeCode, Section: section, Timestamp: claimedTs,
    Operator: body.operator || '', Type: type, Value: value, InTol: inTol === null ? '' : (inTol ? 'Y' : 'N'),
    Footage: numOrBlank_(body.footage),
    EnteredAt: enteredAt, TimeSource: timeSource, TimeOffsetMin: offsetMin
  };
  appendRow_(SHEETS.READINGS, row);

  // One patch, not two. Marking the section started and carrying the reading onto the
  // reel both write the same Pipes row, and each updateRowByKey_ is a read-modify-write
  // round trip — doing them separately paid that twice on the single most frequent
  // write in the app. `pipe` was already fetched above, so the status check is free.
  var patch = {
    LastReadingAt: row.Timestamp, LastReadingType: row.Type,
    LastReadingValue: row.Value, LastReadingInTol: row.InTol,
    LastUpdated: nowIso_()
  };
  var prefix = sectionPrefix_(section);
  if (pipe[prefix + '_Status'] === 'Not started') {
    patch[prefix + '_Status'] = 'In progress';
    patch[prefix + '_StartedAt'] = nowIso_();
  }
  // Footage marker drives the TV view's per-section progress bar. Only OD readings carry
  // one, and only when the operator walked out and read the marker, so don't clobber a
  // good value with a blank from a reading that skipped it.
  if (type === 'OD' && row.Footage !== '') patch[prefix + '_LastFootage'] = row.Footage;
  updateRowByKey_(SHEETS.PIPES, 'PipeCode', pipeCode, patch);
  cacheClearPipe_(pipeCode);
  return row;
}

// One Braidline entry logs a pitch and an OD, which was two separate requests plus a
// reload. They share a timestamp and a reel, so they belong in one.
function apiAddReadings_(body) {
  var list = body.readings || [];
  if (!list.length) throw new Error('No readings supplied');
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var one = list[i];
    out.push(apiAddReading_({
      pipeCode: body.pipeCode, section: body.section,
      timestamp: body.timestamp, timeSource: body.timeSource, operator: body.operator,
      type: one.type, value: one.value, footage: one.footage
    }));
  }
  return { readings: out };
}

function computeInTol_(wo, section, type, value) {
  var target, tol;
  if (section === 'Baseline' && type === 'OD') { target = wo.BL_TargetOD; tol = wo.BL_ODTol; }
  else if (section === 'Braidline' && type === 'OD') { target = wo.BR_TargetOD; tol = wo.BR_ODTol; }
  else if (section === 'Braidline' && type === 'Pitch') { target = wo.BR_TargetPitch; tol = wo.BR_PitchTol; }
  else if (section === 'Coverline' && type === 'OD') { target = wo.CV_TargetOD; tol = wo.CV_ODTol; }
  if (target === '' || target === undefined || tol === '' || tol === undefined) return null;
  target = Number(target); tol = Number(tol);
  if (isNaN(target) || isNaN(tol)) return null;
  return Math.abs(value - target) <= tol;
}

function apiAddThicknessCheck_(body) {
  var pipeCode = String(body.pipeCode || '').trim();
  if (!findRowByKey_(SHEETS.PIPES, 'PipeCode', pipeCode)) throw new Error('Reel not found: ' + pipeCode);
  var points = body.points || [];
  var od = Number(body.od);
  var nums = points.map(Number).filter(function (n) { return !isNaN(n); });
  var avgThk = nums.length ? nums.reduce(function (a, b) { return a + b; }, 0) / nums.length : null;
  var computedId = (avgThk !== null && !isNaN(od)) ? (od - 2 * avgThk) : null;
  var ovality = nums.length ? (Math.max.apply(null, nums) - Math.min.apply(null, nums)) : null;

  var row = {
    RowId: newId_(), PipeCode: pipeCode, Section: body.section, Position: body.position,
    Timestamp: body.timestamp || nowIso_(), Operator: body.operator || '', OD: isNaN(od) ? '' : od,
    AvgThickness: avgThk === null ? '' : round4_(avgThk),
    ComputedID: computedId === null ? '' : round4_(computedId),
    Ovality: ovality === null ? '' : round4_(ovality)
  };
  for (var i = 0; i < 16; i++) row['T' + (i + 1)] = (points[i] === undefined || points[i] === '' || points[i] === null) ? '' : Number(points[i]);
  appendRow_(SHEETS.THICKNESS, row);
  markSectionStarted_(pipeCode, body.section);
  touchPipe_(pipeCode);
  return row;
}

function apiAddNote_(body) {
  var pipeCode = String(body.pipeCode || '').trim();
  if (!findRowByKey_(SHEETS.PIPES, 'PipeCode', pipeCode)) throw new Error('Reel not found: ' + pipeCode);
  var row = {
    RowId: newId_(), PipeCode: pipeCode, Section: body.section || '', Timestamp: body.timestamp || nowIso_(),
    Operator: body.operator || '', Text: body.text || ''
  };
  appendRow_(SHEETS.NOTES, row);
  touchPipe_(pipeCode);
  return row;
}

function uploadPhotoToDrive_(pipeCode, imageBase64, filename, mimeType) {
  var root = getOrCreateFolder_(DRIVE_ROOT_FOLDER_NAME, DriveApp.getRootFolder());
  var pipeFolder = getOrCreateFolder_(pipeCode, root);
  var mime = mimeType || 'image/jpeg';
  var bytes = Utilities.base64Decode(imageBase64.replace(/^data:[^,]+,/, ''));
  var blob = Utilities.newBlob(bytes, mime, filename || (newId_() + '.jpg'));
  var file = pipeFolder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { url: file.getUrl(), fileId: file.getId() };
}

// `pre` is the already-uploaded file when doPost did the Drive work before taking the
// write lock, which is the normal path — see preLockWork_.
function apiAddPhoto_(body, pre) {
  var pipeCode = String(body.pipeCode || '').trim();
  // preLockWork_ already proved the reel exists before spending a Drive upload on it, so
  // only check here when the upload didn't come from there.
  if (!(pre && pre.uploaded) && !findRowByKey_(SHEETS.PIPES, 'PipeCode', pipeCode)) {
    throw new Error('Reel not found: ' + pipeCode);
  }
  if (!body.imageBase64) throw new Error('imageBase64 is required.');

  var uploaded = (pre && pre.uploaded) || uploadPhotoToDrive_(pipeCode, body.imageBase64, body.filename, body.mimeType);
  var row = {
    RowId: newId_(), PipeCode: pipeCode, Section: body.section || '', Timestamp: body.timestamp || nowIso_(),
    Operator: body.operator || '', Caption: body.caption || '',
    DriveUrl: uploaded.url, DriveFileId: uploaded.fileId, ProblemReportId: ''
  };
  appendRow_(SHEETS.PHOTOS, row);
  touchPipe_(pipeCode);
  return row;
}

function getOrCreateFolder_(name, parent) {
  var it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

function apiAddMaterialUsage_(body) {
  var pipeCode = String(body.pipeCode || '').trim();
  if (!findRowByKey_(SHEETS.PIPES, 'PipeCode', pipeCode)) throw new Error('Reel not found: ' + pipeCode);
  var start = numOrBlank_(body.startWeight);
  var end = numOrBlank_(body.endWeight);
  var used = (start !== '' && end !== '') ? round4_(start - end) : '';
  var row = {
    RowId: newId_(), PipeCode: pipeCode, Section: body.section, Timestamp: body.timestamp || nowIso_(),
    Operator: body.operator || '', Material: body.material || '', LotNumber: body.lotNumber || '',
    StartWeight: start, EndWeight: end, UsedWeight: used
  };
  appendRow_(SHEETS.MATERIAL, row);
  markSectionStarted_(pipeCode, body.section);
  touchPipe_(pipeCode);
  return row;
}

function apiAddProblemReport_(body) {
  var pipeCode = String(body.pipeCode || '').trim();
  if (!findRowByKey_(SHEETS.PIPES, 'PipeCode', pipeCode)) throw new Error('Reel not found: ' + pipeCode);
  if (!body.description) throw new Error('A description is required.');

  var row = {
    RowId: newId_(), PipeCode: pipeCode, Section: body.section || '', Timestamp: body.timestamp || nowIso_(),
    Operator: body.operator || '', FootageMarker: numOrBlank_(body.footageMarker), Description: body.description,
    Status: 'Open', ResolvedBy: '', ResolvedAt: '', ResolutionNotes: ''
  };
  appendRow_(SHEETS.PROBLEMS, row);

  var photos = body.photos || [];
  var photoRows = photos.map(function (p) {
    var uploaded = uploadPhotoToDrive_(pipeCode, p.imageBase64, p.filename, p.mimeType);
    var photoRow = {
      RowId: newId_(), PipeCode: pipeCode, Section: body.section || '', Timestamp: row.Timestamp,
      Operator: body.operator || '', Caption: 'Problem report photo',
      DriveUrl: uploaded.url, DriveFileId: uploaded.fileId, ProblemReportId: row.RowId
    };
    appendRow_(SHEETS.PHOTOS, photoRow);
    return photoRow;
  });

  touchPipe_(pipeCode);
  return { report: row, photos: photoRows };
}

function apiResolveProblemReport_(body) {
  var reportId = String(body.reportId || '').trim();
  if (!reportId) throw new Error('reportId is required.');
  var report = findRowByKey_(SHEETS.PROBLEMS, 'RowId', reportId);
  if (!report) throw new Error('Problem report not found: ' + reportId);
  var patch = {
    Status: 'Resolved', ResolvedBy: body.resolvedBy || '', ResolvedAt: nowIso_(),
    ResolutionNotes: body.resolutionNotes || ''
  };
  updateRowByKey_(SHEETS.PROBLEMS, 'RowId', reportId, patch);
  touchPipe_(report.PipeCode);
  return { reportId: reportId };
}

// ---------- production timing (uptime/downtime) ----------

function apiStartDowntime_(body) {
  var pipeCode = String(body.pipeCode || '').trim();
  var section = body.section;
  if (!findRowByKey_(SHEETS.PIPES, 'PipeCode', pipeCode)) throw new Error('Reel not found: ' + pipeCode);
  var open = sheetToObjects_(SHEETS.DOWNTIME).filter(function (e) {
    return String(e.PipeCode) === pipeCode && e.Section === section && e.EndTime === '';
  });
  if (open.length) throw new Error('This reel/section already has an open downtime event.');
  var row = {
    RowId: newId_(), PipeCode: pipeCode, Section: section, StartTime: body.timestamp || nowIso_(),
    EndTime: '', ReasonCode: body.reasonCode || 'Other', Notes: body.notes || '', Operator: body.operator || ''
  };
  appendRow_(SHEETS.DOWNTIME, row);
  touchPipe_(pipeCode);
  return row;
}

function apiEndDowntime_(body) {
  var pipeCode = String(body.pipeCode || '').trim();
  var section = body.section;
  var events = sheetToObjects_(SHEETS.DOWNTIME).filter(function (e) {
    return String(e.PipeCode) === pipeCode && e.Section === section && e.EndTime === '';
  });
  if (!events.length) throw new Error('No open downtime event found for this reel/section.');
  var event = events[events.length - 1];
  updateRowByKey_(SHEETS.DOWNTIME, 'RowId', event.RowId, { EndTime: body.timestamp || nowIso_() });
  touchPipe_(pipeCode);
  return { rowId: event.RowId };
}

// Elapsed running time so far, minus downtime, for a pipe currently 'In progress' on a section;
// plus the expected time from that section's target length / line speed, if both are set.
function computeProdTiming_(wo, pipe, section, downtimeEvents) {
  var prefix = sectionPrefix_(section);
  if (pipe[prefix + '_Status'] !== 'In progress') return null;
  var startedAt = pipe[prefix + '_StartedAt'];
  if (!startedAt) return null;
  var startMs = new Date(startedAt).getTime();
  var nowMs = Date.now();

  var events = downtimeEvents.filter(function (e) { return String(e.PipeCode) === pipe.PipeCode && e.Section === section; });
  var downMinutes = 0, openEvent = null;
  events.forEach(function (e) {
    var s = new Date(e.StartTime).getTime();
    var end = e.EndTime ? new Date(e.EndTime).getTime() : nowMs;
    downMinutes += Math.max(0, (end - s) / 60000);
    if (!e.EndTime) openEvent = e;
  });

  var totalMinutes = Math.max(0, (nowMs - startMs) / 60000);
  var runningMinutes = Math.max(0, totalMinutes - downMinutes);

  var targetLength = wo[prefix + '_TargetLength'], lineSpeed = wo[prefix + '_LineSpeed'];
  var expectedMinutes = '';
  if (targetLength !== '' && targetLength !== undefined && lineSpeed !== '' && lineSpeed !== undefined && Number(lineSpeed) > 0) {
    expectedMinutes = round4_(Number(targetLength) / Number(lineSpeed));
  }

  return {
    status: openEvent ? 'down' : 'running',
    downReason: openEvent ? openEvent.ReasonCode : '',
    downNotes: openEvent ? openEvent.Notes : '',
    downSince: openEvent ? openEvent.StartTime : '',
    runningMinutes: round4_(runningMinutes),
    downMinutes: round4_(downMinutes),
    expectedMinutes: expectedMinutes
  };
}

function markSectionStarted_(pipeCode, section) {
  var prefix = sectionPrefix_(section);
  var pipe = findRowByKey_(SHEETS.PIPES, 'PipeCode', pipeCode);
  if (!pipe) return;
  if (pipe[prefix + '_Status'] === 'Not started') {
    var patch = {};
    patch[prefix + '_Status'] = 'In progress';
    patch[prefix + '_StartedAt'] = nowIso_();
    updateRowByKey_(SHEETS.PIPES, 'PipeCode', pipeCode, patch);
  }
}

function sectionPrefix_(section) {
  if (section === 'Baseline') return 'BL';
  if (section === 'Braidline') return 'BR';
  if (section === 'Coverline') return 'CV';
  throw new Error('Unknown section: ' + section);
}

function touchPipe_(pipeCode) {
  updateRowByKey_(SHEETS.PIPES, 'PipeCode', pipeCode, { LastUpdated: nowIso_() });
  cacheClearPipe_(pipeCode);
}

function apiSetSectionStatus_(body) {
  var pipeCode = String(body.pipeCode || '').trim();
  var section = body.section;
  var status = body.status; // 'In progress' | 'Complete'
  var pipe = findRowByKey_(SHEETS.PIPES, 'PipeCode', pipeCode);
  if (!pipe) throw new Error('Reel not found: ' + pipeCode);
  var prefix = sectionPrefix_(section);
  var patch = {};
  patch[prefix + '_Status'] = status;
  if (status === 'Complete') {
    patch[prefix + '_CompletedAt'] = nowIso_();
    if (body.actualLength !== undefined && body.actualLength !== '') {
      patch[prefix + '_ActualLength'] = numOrBlank_(body.actualLength);
    }
  }
  patch.LastUpdated = nowIso_();

  var willAllComplete =
    (prefix === 'BL' ? status : pipe.BL_Status) === 'Complete' &&
    (prefix === 'BR' ? status : pipe.BR_Status) === 'Complete' &&
    (prefix === 'CV' ? status : pipe.CV_Status) === 'Complete';
  if (willAllComplete) patch.OverallStatus = 'Complete';

  updateRowByKey_(SHEETS.PIPES, 'PipeCode', pipeCode, patch);
  cacheClearPipe_(pipeCode);

  return { pipeCode: pipeCode, section: section, status: status };
}

// ---------- dashboard / TV ----------

function apiDashboard_() {
  var pipes = sheetToObjects_(SHEETS.PIPES);
  var workOrders = sheetToObjects_(SHEETS.WORKORDERS);
  // The board only needs an open-problem count per reel, so read those two columns
  // rather than all 11 — descriptions and resolution notes are never shown here.
  var problems = scanColumns_(SHEETS.PROBLEMS, ['PipeCode', 'Status']);
  var downtimeEvents = sheetToObjects_(SHEETS.DOWNTIME);

  // Reads the reel's own LastReading* columns rather than scanning the Readings sheet.
  // Dashboard cost is now proportional to the number of reels, not to how much history
  // the plant has ever accumulated. Reels last written to before those columns existed
  // simply report no last reading until their next one (setup() backfills them).
  function lastReadingOf(p) {
    if (!p.LastReadingAt) return null;
    return { Timestamp: p.LastReadingAt, Type: p.LastReadingType, Value: p.LastReadingValue, InTol: p.LastReadingInTol };
  }

  /* Progress through each section, for the TV view's three bars.
   *
   * Measured from the footage marker on the section's most recent OD reading against the
   * section's target length — i.e. how far down the reel the last check was taken. A
   * finished section reads 100% from its actual length instead, since the final figure is
   * known exactly and the last check was never at the very end.
   *
   * Progress is null, not zero, when there's nothing to go on (no target set, or no
   * footage marker logged yet) — the bar is then drawn as "no data" rather than implying
   * the line hasn't moved. */
  function sectionProgress_(p, wo, prefix) {
    var status = p[prefix + '_Status'] || 'Not started';
    var target = Number(wo[prefix + '_TargetLength']);
    var hasTarget = wo[prefix + '_TargetLength'] !== '' && wo[prefix + '_TargetLength'] !== undefined && !isNaN(target) && target > 0;

    if (status === 'Complete') {
      var actual = Number(p[prefix + '_ActualLength']);
      return {
        status: status, pct: 100,
        length: isNaN(actual) ? '' : actual,
        target: hasTarget ? target : ''
      };
    }
    var footage = Number(p[prefix + '_LastFootage']);
    var hasFootage = p[prefix + '_LastFootage'] !== '' && p[prefix + '_LastFootage'] !== undefined && !isNaN(footage);
    return {
      status: status,
      pct: (hasTarget && hasFootage) ? Math.max(0, Math.min(100, Math.round(100 * footage / target))) : null,
      length: hasFootage ? footage : '',
      target: hasTarget ? target : ''
    };
  }

  var openProblemsByPipe = {};
  problems.forEach(function (p) {
    if (p.Status !== 'Open') return;
    openProblemsByPipe[p.PipeCode] = (openProblemsByPipe[p.PipeCode] || 0) + 1;
  });
  var woByCode = {};
  workOrders.forEach(function (w) { woByCode[w.Code] = w; });

  var groups = {};
  pipes.forEach(function (p) {
    var key = p.WorkOrderCode;
    var wo = woByCode[key] || {};
    // Archived work orders are off the board entirely — that's the point of archiving.
    // They stay reachable through the Archive view until someone deletes them.
    if (isArchived_(wo)) return;
    if (!groups[key]) {
      groups[key] = {
        workOrderCode: key, customer: wo.Customer || '', productCode: wo.ProductCode || '',
        projectLength: wo.ProjectLength !== undefined ? wo.ProjectLength : '', pipes: []
      };
    }
    var curSection = p.BL_Status === 'In progress' ? 'Baseline' : p.BR_Status === 'In progress' ? 'Braidline'
      : p.CV_Status === 'In progress' ? 'Coverline' : null;
    var prodTiming = curSection ? computeProdTiming_(wo, p, curSection, downtimeEvents) : null;
    groups[key].pipes.push({
      pipeCode: p.PipeCode, blStatus: p.BL_Status, brStatus: p.BR_Status, cvStatus: p.CV_Status,
      overallStatus: p.OverallStatus, lastUpdated: p.LastUpdated, lastReading: lastReadingOf(p),
      blActualLength: p.BL_ActualLength, brActualLength: p.BR_ActualLength, cvActualLength: p.CV_ActualLength,
      openProblems: openProblemsByPipe[p.PipeCode] || 0,
      prodSection: curSection, prodTiming: prodTiming,
      sectionProgress: {
        Baseline: sectionProgress_(p, wo, 'BL'),
        Braidline: sectionProgress_(p, wo, 'BR'),
        Coverline: sectionProgress_(p, wo, 'CV')
      }
    });
  });

  var groupList = Object.keys(groups).map(function (k) {
    var g = groups[k];
    g.producedLength = round4_(g.pipes.reduce(function (sum, p) {
      var v = Number(p.cvActualLength);
      return sum + (isNaN(v) ? 0 : v);
    }, 0));
    g.openProblems = g.pipes.reduce(function (sum, p) { return sum + p.openProblems; }, 0);
    g.activePipes = g.pipes.filter(function (p) { return p.overallStatus !== 'Complete'; });
    g.pipes.sort(function (a, b) { return new Date(b.lastUpdated) - new Date(a.lastUpdated); });
    return g;
  });

  var active = groupList.filter(function (g) { return g.activePipes.length > 0; })
    .sort(function (a, b) {
      var am = Math.max.apply(null, a.pipes.map(function (p) { return new Date(p.lastUpdated).getTime(); }));
      var bm = Math.max.apply(null, b.pipes.map(function (p) { return new Date(p.lastUpdated).getTime(); }));
      return bm - am;
    });
  var recentComplete = groupList.filter(function (g) { return g.activePipes.length === 0 && g.pipes.length > 0; }).slice(0, 10);

  return { active: active, recentComplete: recentComplete, serverTime: nowIso_() };
}

// ---------- email report ----------

// Builds and sends the report. Run before the write lock is taken (see preLockWork_),
// because reading the reel, rendering the HTML and handing it to Gmail is seconds of work
// that touches nothing anyone else is writing to.
function sendReportEmail_(body) {
  var pipeCode = String(body.pipeCode || '').trim();
  var data = apiGetPipe_(pipeCode);
  var to = (body.emailTo || data.workOrder.EmailTo || DEFAULT_EMAIL_TO);
  MailApp.sendEmail({
    to: to,
    subject: 'SRTP Production Report — Reel ' + pipeCode + ' (' + data.pipe.OverallStatus + ')',
    htmlBody: buildReportHtml_(data)
  });
  return { sentTo: to };
}

// All that's left under the lock: record that it went.
function apiSendReport_(body, pre) {
  var pipeCode = String(body.pipeCode || '').trim();
  var sent = pre || sendReportEmail_(body);
  appendRow_(SHEETS.EMAILLOG, { RowId: newId_(), PipeCode: pipeCode, SentAt: nowIso_(), SentTo: sent.sentTo, Trigger: body.trigger || 'manual' });
  updateRowByKey_(SHEETS.PIPES, 'PipeCode', pipeCode, { LastEmailAt: nowIso_() });
  return { sentTo: sent.sentTo };
}

function stats_(values) {
  var nums = values.filter(function (v) { return v !== '' && v !== null && !isNaN(v); }).map(Number);
  if (!nums.length) return null;
  var sum = nums.reduce(function (a, b) { return a + b; }, 0);
  return { count: nums.length, min: Math.min.apply(null, nums), max: Math.max.apply(null, nums), avg: round4_(sum / nums.length) };
}

function buildReportHtml_(data) {
  var wo = data.workOrder, pipe = data.pipe;
  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function sectionReadings(section, type) {
    return data.readings.filter(function (r) { return r.Section === section && r.Type === type; }).map(function (r) { return r.Value; });
  }
  function statRow(label, s, unit) {
    if (!s) return '<tr><td>' + label + '</td><td colspan="4" style="color:#898781">no readings</td></tr>';
    return '<tr><td>' + label + '</td><td>' + s.count + '</td><td>' + s.min + unit + '</td><td>' + s.max + unit + '</td><td>' + s.avg + unit + '</td></tr>';
  }
  function checksTable(section) {
    var checks = data.thicknessChecks.filter(function (c) { return c.Section === section; });
    if (!checks.length) return '<p style="color:#898781;margin:2px 0 10px">No thickness checks recorded.</p>';
    var rows = checks.map(function (c) {
      return '<tr><td>' + esc(c.Position) + '</td><td>' + esc(c.OD) + '</td><td>' + esc(c.AvgThickness) + '</td>' +
        '<td>' + esc(c.ComputedID) + '</td><td>' + esc(c.Ovality) + '</td><td>' + esc(c.Operator) + '</td></tr>';
    }).join('');
    return '<table style="border-collapse:collapse;width:100%;margin-bottom:10px" border="1" cellpadding="4">' +
      '<tr style="background:#f2f2f2"><th>Position</th><th>OD</th><th>Avg wall</th><th>Computed ID</th><th>Ovality (max-min)</th><th>Operator</th></tr>' +
      rows + '</table>';
  }
  function notesList(section) {
    var notes = data.notes.filter(function (n) { return n.Section === section; });
    if (!notes.length) return '<p style="color:#898781;margin:2px 0 10px">No notes.</p>';
    return '<ul style="margin:2px 0 10px">' + notes.map(function (n) {
      return '<li>' + esc(new Date(n.Timestamp).toLocaleString()) + ' — <b>' + esc(n.Operator) + ':</b> ' + esc(n.Text) + '</li>';
    }).join('') + '</ul>';
  }
  function photosList(section) {
    var photos = data.photos.filter(function (p) { return p.Section === section; });
    if (!photos.length) return '<p style="color:#898781;margin:2px 0 10px">No photos.</p>';
    return '<ul style="margin:2px 0 10px">' + photos.map(function (p) {
      return '<li><a href="' + esc(p.DriveUrl) + '">' + esc(p.Caption || 'photo') + '</a> — ' + esc(new Date(p.Timestamp).toLocaleString()) + ' (' + esc(p.Operator) + ')</li>';
    }).join('') + '</ul>';
  }
  function materialTable(section) {
    var rows = (data.materialUsage || []).filter(function (m) { return m.Section === section; });
    if (!rows.length) return '<p style="color:#898781;margin:2px 0 10px">No material usage recorded.</p>';
    var byMaterial = {};
    rows.forEach(function (m) {
      var key = m.Material || '(unspecified)';
      if (!byMaterial[key]) byMaterial[key] = 0;
      if (m.UsedWeight !== '' && m.UsedWeight !== undefined) byMaterial[key] += Number(m.UsedWeight);
    });
    var detail = rows.map(function (m) {
      return '<tr><td>' + esc(new Date(m.Timestamp).toLocaleString()) + '</td><td>' + esc(m.Material) + '</td><td>' + esc(m.LotNumber) + '</td>' +
        '<td>' + esc(m.StartWeight) + '</td><td>' + esc(m.EndWeight) + '</td><td>' + esc(m.UsedWeight) + '</td><td>' + esc(m.Operator) + '</td></tr>';
    }).join('');
    var totals = Object.keys(byMaterial).map(function (k) { return esc(k) + ': <b>' + round4_(byMaterial[k]) + ' lbs</b>'; }).join(' &nbsp;·&nbsp; ');
    return '<div style="margin-bottom:4px">Totals — ' + totals + '</div>' +
      '<table style="border-collapse:collapse;width:100%;margin-bottom:10px" border="1" cellpadding="4">' +
      '<tr style="background:#f2f2f2"><th>Time</th><th>Material</th><th>Lot #</th><th>Start (lbs)</th><th>End (lbs)</th><th>Used (lbs)</th><th>Operator</th></tr>' +
      detail + '</table>';
  }
  function fmtHrsMin(minutes) {
    minutes = Math.round(minutes);
    return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
  }
  function downtimeSummary(section) {
    var events = (data.downtimeEvents || []).filter(function (e) { return e.Section === section; });
    if (!events.length) return '';
    var totalMin = 0;
    var rows = events.map(function (e) {
      var s = new Date(e.StartTime).getTime();
      var end = e.EndTime ? new Date(e.EndTime).getTime() : Date.now();
      var min = Math.max(0, (end - s) / 60000);
      totalMin += min;
      return '<tr><td>' + esc(e.ReasonCode) + '</td><td>' + esc(new Date(e.StartTime).toLocaleString()) + '</td>' +
        '<td>' + (e.EndTime ? esc(new Date(e.EndTime).toLocaleString()) : '<b style="color:#d03b3b">ongoing</b>') + '</td>' +
        '<td>' + fmtHrsMin(min) + '</td><td>' + esc(e.Notes) + '</td></tr>';
    }).join('');
    return '<div style="margin-bottom:4px">Total downtime — <b>' + fmtHrsMin(totalMin) + '</b> across ' + events.length + ' event(s)</div>' +
      '<table style="border-collapse:collapse;width:100%;margin-bottom:10px" border="1" cellpadding="4">' +
      '<tr style="background:#f2f2f2"><th>Reason</th><th>Start</th><th>End</th><th>Duration</th><th>Notes</th></tr>' +
      rows + '</table>';
  }
  function problemsList(section) {
    var rows = (data.problemReports || []).filter(function (p) { return p.Section === section; });
    if (!rows.length) return '';
    var items = rows.map(function (p) {
      var badge = p.Status === 'Open'
        ? '<b style="color:#d03b3b">OPEN</b>'
        : '<span style="color:#0ca30c">Resolved</span>';
      var footage = (p.FootageMarker !== '' && p.FootageMarker !== undefined) ? ' — footage ' + esc(p.FootageMarker) + ' ft' : '';
      return '<li>' + badge + ' &middot; ' + esc(new Date(p.Timestamp).toLocaleString()) + footage +
        ' &mdash; <b>' + esc(p.Operator) + ':</b> ' + esc(p.Description) + '</li>';
    }).join('');
    return '<b style="color:#d03b3b">Problem reports</b><ul style="margin:2px 0 10px">' + items + '</ul>';
  }
  function processRefLine(prefix) {
    var parts = [];
    if (wo[prefix + '_ChillerTemp'] !== '') parts.push('Chiller ' + esc(wo[prefix + '_ChillerTemp']));
    if (wo[prefix + '_VacuumLevel'] !== '') parts.push('Vacuum ' + esc(wo[prefix + '_VacuumLevel']));
    if (wo[prefix + '_BackerRPM'] !== '') parts.push('Backer RPM ' + esc(wo[prefix + '_BackerRPM']));
    var zones = ['TZ1','TZ2','TZ3','TZ4','TZ5','TClamp'].map(function(z){ return wo[prefix+'_'+z]; }).filter(function(v){ return v!==''; });
    if (zones.length) parts.push('Zones ' + zones.map(esc).join('/'));
    var die = ['DieBody','DieManifold','DieRetainer','DieFlange'].map(function(z){ return wo[prefix+'_'+z]; }).filter(function(v){ return v!==''; });
    if (die.length) parts.push('Die ' + die.map(esc).join('/'));
    // Tooling. Labelled individually rather than as the recipe card's slash field, since
    // the Baseline and Coverline cards print tip and die the opposite way round.
    if (wo[prefix + '_TipSize'] !== '') parts.push('Tip ' + esc(wo[prefix + '_TipSize']) + '"');
    if (wo[prefix + '_DieSize'] !== '') parts.push('Die size ' + esc(wo[prefix + '_DieSize']) + '"');
    if (wo[prefix + '_Coated'] !== '') parts.push('Coated ' + esc(wo[prefix + '_Coated']));
    if (wo[prefix + '_ConcentricityGap'] !== '') parts.push('Conc. gap ' + esc(wo[prefix + '_ConcentricityGap']) + '"');
    if (prefix === 'BL') {
      if (wo.BL_SizerID !== '') parts.push('Sizer ID ' + esc(wo.BL_SizerID));
      if (wo.BL_RearGasketHole !== '') parts.push('Rear gasket ' + esc(wo.BL_RearGasketHole) + '"');
    }
    if (!parts.length) return '';
    return '<div style="color:#898781;font-size:11px;margin-bottom:8px">Process ref — ' + parts.join(' &nbsp;·&nbsp; ') + '</div>';
  }
  function lengthLine(prefix) {
    var target = wo[prefix + '_TargetLength'], actual = pipe[prefix + '_ActualLength'];
    if (target === '' && actual === '') return '';
    return '<div style="color:#555;margin-bottom:6px">Length — target ' + esc(target || '—') + ' ft &nbsp;·&nbsp; actual ' + esc(actual || '—') + ' ft</div>';
  }

  var producedLength = round4_((data.siblingPipes || []).reduce(function (sum, p) {
    var v = Number(p.CV_ActualLength);
    return sum + (isNaN(v) ? 0 : v);
  }, 0));

  var css = 'font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#111;';
  var h = '<div style="' + css + 'max-width:720px">';
  h += '<h2 style="margin-bottom:2px">SRTP Production Report — Reel ' + esc(pipe.PipeCode) + '</h2>';
  h += '<div style="color:#555;margin-bottom:6px">Work order: <b>' + esc(wo.Code) + '</b> &nbsp;·&nbsp; Customer: ' + esc(wo.Customer) +
    ' &nbsp;·&nbsp; Product: ' + esc(wo.ProductCode) + ' &nbsp;·&nbsp; Pipe size: ' + esc(wo.PipeSize) +
    ' &nbsp;·&nbsp; Overall status: <b>' + esc(pipe.OverallStatus) + '</b></div>';
  if (wo.ProjectLength !== '') {
    h += '<div style="color:#555;margin-bottom:14px">Project length: <b>' + esc(wo.ProjectLength) + ' ft</b> target &nbsp;·&nbsp; ' +
      '<b>' + producedLength + ' ft</b> produced (finished/cover length) across ' + (data.siblingPipes || []).length + ' pipe(s) on this work order</div>';
  } else {
    h += '<div style="margin-bottom:14px"></div>';
  }

  var openCount = (data.problemReports || []).filter(function (p) { return p.Status === 'Open'; }).length;
  if (openCount) {
    h += '<div style="background:#fdecea;border:1px solid #d03b3b;color:#a52a20;padding:8px 10px;border-radius:4px;margin-bottom:14px">' +
      '&#9888; <b>' + openCount + ' open problem report' + (openCount === 1 ? '' : 's') + '</b> on this pipe — see below.</div>';
  }

  h += '<h3 style="border-bottom:1px solid #ccc;padding-bottom:3px">Baseline — ' + esc(pipe.BL_Status) + '</h3>';
  h += '<div style="color:#555;margin-bottom:6px">Target OD ' + esc(wo.BL_TargetOD) + ' ± ' + esc(wo.BL_ODTol) +
    ' &nbsp;·&nbsp; Target wall ' + esc(wo.BL_TargetWall) + ' &nbsp;·&nbsp; Target ID ' + esc(wo.BL_TargetID) +
    (wo.BL_LineSpeed !== '' ? ' &nbsp;·&nbsp; Line speed ' + esc(wo.BL_LineSpeed) + ' ft/min' : '') + '</div>';
  h += lengthLine('BL');
  h += processRefLine('BL');
  h += problemsList('Baseline');
  h += '<table style="border-collapse:collapse;width:100%;margin-bottom:8px" border="1" cellpadding="4">' +
    '<tr style="background:#f2f2f2"><th align="left">Hourly reading</th><th>Count</th><th>Min</th><th>Max</th><th>Avg</th></tr>' +
    statRow('OD (in)', stats_(sectionReadings('Baseline', 'OD')), '"') + '</table>';
  h += '<b>Downtime</b>' + (downtimeSummary('Baseline') || '<p style="color:#898781;margin:2px 0 10px">No downtime recorded.</p>');
  h += '<b>Thickness checks (16-point)</b>' + checksTable('Baseline');
  h += '<b>Material usage</b>' + materialTable('Baseline');
  h += '<b>Notes</b>' + notesList('Baseline');
  h += '<b>Photos</b>' + photosList('Baseline');

  h += '<h3 style="border-bottom:1px solid #ccc;padding-bottom:3px">Braidline — ' + esc(pipe.BR_Status) + '</h3>';
  h += '<div style="color:#555;margin-bottom:6px">' +
    (wo.BR_LongsMaterial ? 'Longs material: ' + esc(wo.BR_LongsMaterial) + ' &nbsp;·&nbsp; ' : '') +
    (wo.BR_XbraidMaterial ? 'Cross braid material: ' + esc(wo.BR_XbraidMaterial) + ' &nbsp;·&nbsp; ' : '') +
    'Longs: ' + esc(wo.BR_Longs) +
    ' &nbsp;·&nbsp; Ends up: ' + esc(wo.BR_XbraidEndsUp) +
    ' &nbsp;·&nbsp; Target pitch ' + esc(wo.BR_TargetPitch) + ' ± ' + esc(wo.BR_PitchTol) +
    ' &nbsp;·&nbsp; Target OD ' + esc(wo.BR_TargetOD) + ' ± ' + esc(wo.BR_ODTol) +
    (wo.BR_LineSpeed !== '' ? ' &nbsp;·&nbsp; Line speed ' + esc(wo.BR_LineSpeed) + ' ft/min' : '') + '</div>';
  h += lengthLine('BR');
  h += problemsList('Braidline');
  h += '<table style="border-collapse:collapse;width:100%;margin-bottom:8px" border="1" cellpadding="4">' +
    '<tr style="background:#f2f2f2"><th align="left">Hourly reading</th><th>Count</th><th>Min</th><th>Max</th><th>Avg</th></tr>' +
    statRow('Pitch (in)', stats_(sectionReadings('Braidline', 'Pitch')), '"') +
    statRow('OD (in)', stats_(sectionReadings('Braidline', 'OD')), '"') + '</table>';
  h += '<b>Downtime</b>' + (downtimeSummary('Braidline') || '<p style="color:#898781;margin:2px 0 10px">No downtime recorded.</p>');
  h += '<b>Notes</b>' + notesList('Braidline');
  h += '<b>Photos</b>' + photosList('Braidline');

  h += '<h3 style="border-bottom:1px solid #ccc;padding-bottom:3px">Coverline — ' + esc(pipe.CV_Status) + '</h3>';
  h += '<div style="color:#555;margin-bottom:6px">Target OD ' + esc(wo.CV_TargetOD) + ' ± ' + esc(wo.CV_ODTol) +
    ' &nbsp;·&nbsp; Target wall ' + esc(wo.CV_TargetWall) + ' &nbsp;·&nbsp; Target ID ' + esc(wo.CV_TargetID) +
    (wo.CV_LineSpeed !== '' ? ' &nbsp;·&nbsp; Line speed ' + esc(wo.CV_LineSpeed) + ' ft/min' : '') + '</div>';
  h += lengthLine('CV');
  h += processRefLine('CV');
  h += problemsList('Coverline');
  h += '<table style="border-collapse:collapse;width:100%;margin-bottom:8px" border="1" cellpadding="4">' +
    '<tr style="background:#f2f2f2"><th align="left">Hourly reading</th><th>Count</th><th>Min</th><th>Max</th><th>Avg</th></tr>' +
    statRow('OD (in)', stats_(sectionReadings('Coverline', 'OD')), '"') + '</table>';
  h += '<b>Downtime</b>' + (downtimeSummary('Coverline') || '<p style="color:#898781;margin:2px 0 10px">No downtime recorded.</p>');
  h += '<b>Thickness checks (12-point)</b>' + checksTable('Coverline');
  h += '<b>Material usage</b>' + materialTable('Coverline');
  h += '<b>Notes</b>' + notesList('Coverline');
  h += '<b>Photos</b>' + photosList('Coverline');

  h += '<div style="color:#898781;font-size:11px;margin-top:14px;border-top:1px solid #eee;padding-top:6px">' +
    'Generated automatically by the SRTP Production Tracker. Data lives in the linked Google Sheet.</div>';
  h += '</div>';
  return h;
}
