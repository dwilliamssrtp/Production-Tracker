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
 * Bind this script to a Google Sheet (Extensions > Apps Script from within the Sheet).
 * Run setup() once from the editor to create the tabs.
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
  DOWNTIME: 'DowntimeEvents'
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
    'BL_BackerSize', 'BL_BondSize', 'BL_LinerSize'
  ],
  Pipes: [
    'PipeCode', 'WorkOrderCode', 'CreatedAt', 'CreatedBy',
    'BL_Status', 'BL_StartedAt', 'BL_CompletedAt', 'BL_ActualLength',
    'BR_Status', 'BR_StartedAt', 'BR_CompletedAt', 'BR_ActualLength',
    'CV_Status', 'CV_StartedAt', 'CV_CompletedAt', 'CV_ActualLength',
    'OverallStatus', 'LastUpdated', 'LastEmailAt'
  ],
  Readings: ['RowId', 'PipeCode', 'Section', 'Timestamp', 'Operator', 'Type', 'Value', 'InTol', 'Footage'],
  ThicknessChecks: ['RowId', 'PipeCode', 'Section', 'Position', 'Timestamp', 'Operator', 'OD',
    'T1','T2','T3','T4','T5','T6','T7','T8','T9','T10','T11','T12','T13','T14','T15','T16',
    'AvgThickness', 'ComputedID', 'Ovality'],
  Notes: ['RowId', 'PipeCode', 'Section', 'Timestamp', 'Operator', 'Text'],
  Photos: ['RowId', 'PipeCode', 'Section', 'Timestamp', 'Operator', 'Caption', 'DriveUrl', 'DriveFileId', 'ProblemReportId'],
  EmailLog: ['RowId', 'PipeCode', 'SentAt', 'SentTo', 'Trigger'],
  MaterialUsage: ['RowId', 'PipeCode', 'Section', 'Timestamp', 'Operator', 'Material', 'LotNumber', 'StartWeight', 'EndWeight', 'UsedWeight'],
  ProblemReports: ['RowId', 'PipeCode', 'Section', 'Timestamp', 'Operator', 'FootageMarker', 'Description',
    'Status', 'ResolvedBy', 'ResolvedAt', 'ResolutionNotes'],
  DowntimeEvents: ['RowId', 'PipeCode', 'Section', 'StartTime', 'EndTime', 'ReasonCode', 'Notes', 'Operator']
};

var DRIVE_ROOT_FOLDER_NAME = 'SRTP Production Tracker Photos';
var DEFAULT_EMAIL_TO = 'dwilliams@specialtyrtp.com';

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

  brLongsEndsUp: 'BR_Longs', brXbraidEndsUp: 'BR_XbraidEndsUp',
  brTargetPitch: 'BR_TargetPitch', brPitchTol: 'BR_PitchTol', brTargetOD: 'BR_TargetOD', brODTol: 'BR_ODTol',
  brTargetLength: 'BR_TargetLength', brNotes: 'BR_Notes',

  cvTargetOD: 'CV_TargetOD', cvODTol: 'CV_ODTol', cvTargetWall: 'CV_TargetWall', cvTargetID: 'CV_TargetID',
  cvTargetLength: 'CV_TargetLength', cvNotes: 'CV_Notes',
  cvChillerTemp: 'CV_ChillerTemp', cvVacuumLevel: 'CV_VacuumLevel', cvBackerRPM: 'CV_BackerRPM',
  cvTZ1: 'CV_TZ1', cvTZ2: 'CV_TZ2', cvTZ3: 'CV_TZ3', cvTZ4: 'CV_TZ4', cvTZ5: 'CV_TZ5', cvTClamp: 'CV_TClamp',
  cvDieBody: 'CV_DieBody', cvDieManifold: 'CV_DieManifold', cvDieRetainer: 'CV_DieRetainer', cvDieFlange: 'CV_DieFlange',

  blLineSpeed: 'BL_LineSpeed', brLineSpeed: 'BR_LineSpeed', cvLineSpeed: 'CV_LineSpeed'
};
// The subset of WO_FIELD_MAP keys that are free text rather than numeric.
var WO_TEXT_KEYS = ['customer', 'productCode', 'pipeSize', 'emailTo', 'blNotes', 'brNotes', 'cvNotes',
  'blBackerMaterial', 'blBondMaterial', 'blLinerMaterial'];

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
  DowntimeEvents: ['PipeCode']
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
}

function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name + ' — run setup() first.');
  return sheet;
}

// ---------- generic sheet <-> object helpers ----------

function sheetToObjects_(sheetName) {
  var sheet = getSheet_(sheetName);
  var lastRow = sheet.getLastRow();
  var headers = HEADERS[sheetName];
  if (lastRow < 2) return [];
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
  return out;
}

function appendRow_(sheetName, obj) {
  var sheet = getSheet_(sheetName);
  var headers = HEADERS[sheetName];
  var row = headers.map(function (h) { return (obj[h] === undefined || obj[h] === null) ? '' : obj[h]; });
  sheet.appendRow(row);
  return sheet.getLastRow();
}

function updateRowByKey_(sheetName, keyField, keyValue, patch) {
  var sheet = getSheet_(sheetName);
  var headers = HEADERS[sheetName];
  var keyCol = headers.indexOf(keyField) + 1;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var keys = sheet.getRange(2, keyCol, lastRow - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === String(keyValue)) {
      var rowNum = i + 2;
      Object.keys(patch).forEach(function (k) {
        var col = headers.indexOf(k) + 1;
        if (col > 0) sheet.getRange(rowNum, col).setValue(patch[k]);
      });
      return true;
    }
  }
  return false;
}

function findRowByKey_(sheetName, keyField, keyValue) {
  var rows = sheetToObjects_(sheetName);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][keyField]) === String(keyValue)) return rows[i];
  }
  return null;
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
var CACHE_TTL_SEC = 15;

function cache_() { return CacheService.getScriptCache(); }

function cacheGetJson_(key) {
  try { var v = cache_().get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
function cacheSetJson_(key, obj) {
  try { cache_().put(key, JSON.stringify(obj), CACHE_TTL_SEC); } catch (e) { /* over 100KB or cache unavailable — just skip caching */ }
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

// ---------- web entry points ----------

function doGet(e) {
  try {
    var action = e.parameter.action || 'ping';
    var result;
    switch (action) {
      case 'ping': result = { ok: true, time: nowIso_() }; break;
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
      default: throw new Error('Unknown GET action: ' + action);
    }
    return jsonOut_({ ok: true, data: result });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var result;
    var lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      switch (action) {
        case 'createWorkOrder': result = apiCreateWorkOrder_(body); break;
        case 'updateWorkOrder': result = apiUpdateWorkOrder_(body); break;
        case 'createPipe': result = apiCreatePipe_(body); break;
        case 'addReading': result = apiAddReading_(body); break;
        case 'addThicknessCheck': result = apiAddThicknessCheck_(body); break;
        case 'addNote': result = apiAddNote_(body); break;
        case 'addPhoto': result = apiAddPhoto_(body); break;
        case 'addMaterialUsage': result = apiAddMaterialUsage_(body); break;
        case 'addProblemReport': result = apiAddProblemReport_(body); break;
        case 'resolveProblemReport': result = apiResolveProblemReport_(body); break;
        case 'startDowntime': result = apiStartDowntime_(body); break;
        case 'endDowntime': result = apiEndDowntime_(body); break;
        case 'setSectionStatus': result = apiSetSectionStatus_(body); break;
        case 'sendReport': result = apiSendReport_(body); break;
        default: throw new Error('Unknown POST action: ' + action);
      }
    } finally {
      lock.releaseLock();
    }
    return jsonOut_({ ok: true, data: result });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.message || err) });
  }
}

function jsonOut_(obj) {
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

  var readings = sheetToObjects_(SHEETS.READINGS).filter(function (r) { return String(r.PipeCode) === pipeCode; });
  var checks = sheetToObjects_(SHEETS.THICKNESS).filter(function (r) { return String(r.PipeCode) === pipeCode; });
  var notes = sheetToObjects_(SHEETS.NOTES).filter(function (r) { return String(r.PipeCode) === pipeCode; });
  var photos = sheetToObjects_(SHEETS.PHOTOS).filter(function (r) { return String(r.PipeCode) === pipeCode; });
  var material = sheetToObjects_(SHEETS.MATERIAL).filter(function (r) { return String(r.PipeCode) === pipeCode; });
  var problems = sheetToObjects_(SHEETS.PROBLEMS).filter(function (r) { return String(r.PipeCode) === pipeCode; });
  var downtime = sheetToObjects_(SHEETS.DOWNTIME).filter(function (r) { return String(r.PipeCode) === pipeCode; });
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
  var row = {
    RowId: newId_(), PipeCode: pipeCode, Section: section, Timestamp: body.timestamp || nowIso_(),
    Operator: body.operator || '', Type: type, Value: value, InTol: inTol === null ? '' : (inTol ? 'Y' : 'N'),
    Footage: numOrBlank_(body.footage)
  };
  appendRow_(SHEETS.READINGS, row);
  markSectionStarted_(pipeCode, section);
  touchPipe_(pipeCode);
  return row;
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

function apiAddPhoto_(body) {
  var pipeCode = String(body.pipeCode || '').trim();
  if (!findRowByKey_(SHEETS.PIPES, 'PipeCode', pipeCode)) throw new Error('Reel not found: ' + pipeCode);
  if (!body.imageBase64) throw new Error('imageBase64 is required.');

  var uploaded = uploadPhotoToDrive_(pipeCode, body.imageBase64, body.filename, body.mimeType);
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
  var readings = sheetToObjects_(SHEETS.READINGS);
  var problems = sheetToObjects_(SHEETS.PROBLEMS);
  var downtimeEvents = sheetToObjects_(SHEETS.DOWNTIME);

  var lastByPipe = {};
  readings.forEach(function (r) {
    var cur = lastByPipe[r.PipeCode];
    if (!cur || new Date(r.Timestamp) > new Date(cur.Timestamp)) lastByPipe[r.PipeCode] = r;
  });
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
      overallStatus: p.OverallStatus, lastUpdated: p.LastUpdated, lastReading: lastByPipe[p.PipeCode] || null,
      blActualLength: p.BL_ActualLength, brActualLength: p.BR_ActualLength, cvActualLength: p.CV_ActualLength,
      openProblems: openProblemsByPipe[p.PipeCode] || 0,
      prodSection: curSection, prodTiming: prodTiming
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

function apiSendReport_(body) {
  var pipeCode = String(body.pipeCode || '').trim();
  var data = apiGetPipe_(pipeCode);
  var to = (body.emailTo || data.workOrder.EmailTo || DEFAULT_EMAIL_TO);
  var html = buildReportHtml_(data);
  MailApp.sendEmail({
    to: to,
    subject: 'SRTP Production Report — Reel ' + pipeCode + ' (' + data.pipe.OverallStatus + ')',
    htmlBody: html
  });
  appendRow_(SHEETS.EMAILLOG, { RowId: newId_(), PipeCode: pipeCode, SentAt: nowIso_(), SentTo: to, Trigger: body.trigger || 'manual' });
  updateRowByKey_(SHEETS.PIPES, 'PipeCode', pipeCode, { LastEmailAt: nowIso_() });
  return { sentTo: to };
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
  h += '<div style="color:#555;margin-bottom:6px">Longs: ' + esc(wo.BR_Longs) +
    ' &nbsp;·&nbsp; Xbraids: ' + esc(wo.BR_XbraidEndsUp) + ' ends up' +
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
