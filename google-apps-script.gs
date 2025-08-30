/* eslint-env googleappsscript */
/*
 * To lint this file with ESLint:
 *   npm run lint -- google-apps-script.gs
 * Requires `eslint-plugin-googleappsscript` (install separately if not present).
 */
/**
 * Spatial Cognition Study - Backend (Apps Script)
 * End-to-end version with:
 * - Concurrency locks for all writers
 * - Header map caching + bulk setManyByHeader_
 * - TextFinder row lookup for speed
 * - Strict action whitelist + optional shared key auth
 * - Non-destructive migrations with foldered backups + retention
 * - Header-safe writes everywhere
 * - Hard text formatting for "Tasks Completed" and Email to prevent coercion
 * - Timestamp normalization + device detection
 * - Property-driven EEG reminder date, not hard coded
 *
 * Error handling:
 * - Use handleError(err, showAlert) to log errors and optionally alert users
 * - Wrap spreadsheet operations in try/catch and pass errors to handleError
 */

// ===============================
// Error handling
// ===============================
/**
 * Logs an error and optionally shows a UI alert
 * @param {Error|string} err
 * @param {boolean} [uiAlert] whether to show an alert to the user
 */
function handleError(err, uiAlert) {
  console.error(err);
  if (uiAlert && typeof SpreadsheetApp !== 'undefined') {
    try {
      SpreadsheetApp.getUi().alert('Error: ' + (err && err.message ? err.message : err));
    } catch (_) {}
  }
}

// ===============================
// Entry points + CORS helper
// ===============================
function doPost(e) {
  try {
    console.log('\uD83D\uDCE8 Received POST');

    // Handle preflight / empty body
    if (!e || !e.postData || !e.postData.contents) {
      return createCorsOutput({ success: false, error: 'No data received' });
    }

    var data = JSON.parse(e.postData.contents || '{}');
    var clean = sanitizeInput_(data);
    if (clean.error) {
      return createCorsOutput({ success: false, error: clean.error });
    }
    data = clean.data;
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // Optional simple auth via Script Property SHARED_KEY
    var KEY = PropertiesService.getScriptProperties().getProperty('SHARED_KEY') || '';
    if (KEY) {
      var provided = (data.apiKey || '').toString();
      if (provided !== KEY) {
        return createCorsOutput({ success: false, error: 'Auth failed' });
      }
    }

    // Strict action whitelist
    var allowed = new Set([
      'test_connection', 'safe_setup', 'upload_video',
      'log_video_upload', 'log_video_upload_error',
      'eeg_scheduled',
      'session_created', 'session_resumed', 'session_paused', 'session_timer',
      'consent_opened', 'consent_completed', 'consent_verified', 'consent_affirmed',
      'video_declined',
      'task_opened', 'task_started', 'task_departed', 'task_returned', 'inactivity',
      'tab_hidden', 'tab_visible', 'window_closed',
      'help_requested', 'task_skipped', 'task_completed', 'skilled_task_completed',
      'image_recorded', 'image_recorded_and_uploaded', 'image_recorded_no_upload',
      'video_recorded',
      'calendly_opened', 'eeg_interest', 'aslct_issue',
      'study_completed',
      'save_state',
      'get_session',
      'heartbeat',
      'external_task_stuck',
      'mousemove', 'mousedown', 'keydown', 'touchstart'
    ]);
    if (!allowed.has(data.action)) {
      return createCorsOutput({ success: false, error: 'Unknown action' });
    }

    // Ping
    if (data.action === 'test_connection') {
      return createCorsOutput({ success: true, pong: true, now: new Date().toISOString() });
    }

    // Explicit setup
    if (data.action === 'safe_setup') {
      safeSetupOrMigrate_();
      return createCorsOutput({ success: true, migrated: true });
    }

    // Ensure required sheets exist
    var mustHave = ['Sessions', 'Task Progress', 'Session Events', 'Session Timer'];
    var missing = mustHave.filter(function (n) { return !ss.getSheetByName(n); });
    if (missing.length) safeSetupOrMigrate_();

    // Ensure dynamic columns before we write to Sessions
    ensureEEGColumns_(ss);

    switch (data.action) {
      case 'upload_video':
        return handleVideoUpload(data);

      case 'log_video_upload':
        // Handle both Cloudinary metadata and legacy uploads
        withDocLock_(function () {
          logVideoUpload({
            sessionCode: data.sessionCode,
            imageNumber: data.imageNumber,
            filename: data.filename,
            fileId: data.fileId,
            fileUrl: data.fileUrl,
            fileSize: data.fileSize,
            uploadTime: data.uploadTime,
            uploadMethod: data.uploadMethod || 'unknown',
            uploadStatus: data.uploadStatus || 'success',
            videoFormat: data.videoFormat || data.format || '',
            mimeType: data.mimeType || '',
            cloudinaryPublicId: data.publicId || '',
            externalService: data.uploadMethod === 'cloudinary' ? 'Cloudinary' :
                             data.uploadMethod === 'google_drive' ? 'Google Drive' : 'Unknown'
          });

          // Update session video count
          updateSessionVideoCount(data.sessionCode);
        });
        break;

      case 'log_video_upload_error':
        withDocLock_(function () {
          logVideoUploadError(ss, {
            sessionCode: data.sessionCode,
            imageNumber: data.imageNumber,
            error: data.error,
            timestamp: data.timestamp,
            attemptedMethod: data.attemptedMethod || 'unknown',
            fallbackUsed: data.fallbackUsed || false
          });
        });
        break;

      case 'eeg_scheduled':
        withDocLock_(function () {
          setEEGStatus_(ss, data.sessionCode || 'none',
            'Scheduled',
            data.scheduledAt || data.timestamp,
            data.source || 'self-report',
            'User confirmed scheduling');
        });
        break;

      case 'session_created':
        createSession(ss, data);
        break;

      case 'session_resumed':
        resumeSession(ss, data);
        break;

      case 'session_paused':
        pauseSession(ss, data);
        break;

      case 'session_timer':
        logSessionTimer(ss, data);
        break;

      case 'consent_opened':
        logConsentOpened(ss, data);
        break;

      case 'consent_completed':
        logConsentCompleted(ss, data);
        break;

      case 'consent_verified':
        withDocLock_(function () {
          setConsentVerify_(ss, data.sessionCode || 'none', data.type, 'Verified',
            data.method || 'unknown', data.codeSuffix || data.ridSuffix || '', data.timestamp);
          logSessionEvent(ss, {
            sessionCode: data.sessionCode || '',
            eventType: 'Consent Verified',
            details: (data.type || '') + ' via ' + (data.method || 'unknown'),
            timestamp: data.timestamp || new Date().toISOString()
          });
        });
        break;

      case 'consent_affirmed':
        withDocLock_(function () {
          setConsentVerify_(ss, data.sessionCode || 'none', data.type, 'Affirmed',
            data.method || 'affirmation', '', data.timestamp);
          logSessionEvent(ss, {
            sessionCode: data.sessionCode || '',
            eventType: 'Consent Affirmed',
            details: (data.type || '') + ' via typed affirmation',
            timestamp: data.timestamp || new Date().toISOString()
          });
        });
        break;

      case 'video_declined':
        logVideoDeclined(ss, data);
        break;

      case 'task_opened':
        logTaskOpened(ss, data);
        break;

      case 'task_started':
        logTaskStart(ss, data);
        break;

      case 'task_departed':
        withDocLock_(function () {
          logSessionEvent(ss, {
            sessionCode: data.sessionCode,
            eventType: 'Task Departed',
            details: data.task,
            timestamp: data.timestamp
          });
        });
        break;

      case 'task_returned':
        withDocLock_(function () {
          logSessionEvent(ss, {
            sessionCode: data.sessionCode,
            eventType: 'Task Returned',
            details: data.task + ' (Away: ' + (data.away || 0) + 's)',
            timestamp: data.timestamp
          });
        });
        break;

      case 'heartbeat':
        withDocLock_(function () {
          logSessionEvent(ss, {
            sessionCode: data.sessionCode,
            eventType: 'Heartbeat',
            details: data.task,
            timestamp: data.timestamp || new Date().toISOString()
          });
        });
        break;

      case 'external_task_stuck':
        withDocLock_(function () {
          logSessionEvent(ss, {
            sessionCode: data.sessionCode,
            eventType: 'External Task Stuck',
            details: data.task,
            timestamp: data.timestamp || new Date().toISOString()
          });
        });
        break;

      case 'inactivity':
        withDocLock_(function () {
          logSessionEvent(ss, {
            sessionCode: data.sessionCode,
            eventType: 'Inactivity',
            details: data.task,
            timestamp: data.timestamp
          });
        });
        break;

      case 'tab_hidden':
        withDocLock_(function () {
          logSessionEvent(ss, {
            sessionCode: data.sessionCode,
            eventType: 'Tab Hidden',
            details: data.task,
            timestamp: data.timestamp
          });
        });
        break;

      case 'tab_visible':
        withDocLock_(function () {
          logSessionEvent(ss, {
            sessionCode: data.sessionCode,
            eventType: 'Tab Visible',
            details: data.task,
            timestamp: data.timestamp
          });
        });
        break;

      case 'window_closed':
        withDocLock_(function () {
          logSessionEvent(ss, {
            sessionCode: data.sessionCode,
            eventType: 'Window Closed',
            details: data.task,
            timestamp: data.timestamp
          });
        });
        break;

      case 'mousemove':
      case 'mousedown':
      case 'touchstart':
      case 'keydown':
        withDocLock_(function () {
          var details = {};
          if (typeof data.x === 'number') details.x = data.x;
          if (typeof data.y === 'number') details.y = data.y;
          if (data.key) details.key = data.key;
          var typeMap = {
            mousemove: 'Mouse Move',
            mousedown: 'Mouse Down',
            touchstart: 'Touch Start',
            keydown: 'Key Down'
          };
          logSessionEvent(ss, {
            sessionCode: data.sessionCode,
            eventType: typeMap[data.action] || data.action,
            details: Object.keys(details).length ? JSON.stringify(details) : '',
            timestamp: data.timestamp
          });
        });
        break;

      case 'help_requested':
        logHelpRequested(ss, data);
        break;

      case 'task_skipped':
        logTaskSkipped(ss, data);
        break;

        case 'task_completed':
          logTaskComplete(ss, data);
          break;

        case 'skilled_task_completed':
          logTaskComplete(ss, data);
          break;

      case 'image_recorded':
        logImageRecorded(ss, data);
        break;

      case 'image_recorded_and_uploaded':
        logImageRecordedAndUploaded(ss, data);
        withDocLock_(function () {
          logVideoUpload({
            sessionCode: data.sessionCode,
            imageNumber: data.imageNumber,
            filename: data.filename,
            fileId: data.driveFileId,
            fileUrl: data.driveFileUrl || '',
            fileSize: data.fileSize || 0,
            uploadTime: data.timestamp,
            uploadMethod: data.uploadMethod || 'unknown',
            uploadStatus: data.uploadStatus || 'success',
            mimeType: data.mimeType || ''
          });
        });
        break;

      case 'image_recorded_no_upload':
        logImageRecordedNoUpload(ss, data);
        withDocLock_(function () {
          logVideoUpload({
            sessionCode: data.sessionCode,
            imageNumber: data.imageNumber,
            filename: 'local_only_' + data.imageNumber,
            fileId: '',
            fileUrl: '',
            fileSize: 0,
            uploadTime: data.timestamp,
            uploadMethod: data.uploadMethod || 'local_only',
            uploadStatus: data.uploadStatus || 'skipped',
            mimeType: data.mimeType || ''
          });
        });
        break;

      case 'video_recorded':
        logVideoRecording(ss, data);
        break;

      case 'calendly_opened':
        withDocLock_(function () {
          logCalendlyOpened(ss, data);
          setEEGStatus_(ss, data.sessionCode || 'none', 'Scheduling started', data.timestamp, 'Calendly', 'Calendly link opened');
        });
        break;

      case 'eeg_interest':
        withDocLock_(function () {
          logEEGInterest(ss, data);
          setEEGStatus_(ss, data.sessionCode || 'none', 'Interested', data.timestamp, 'Interest button', 'Participant requested EEG assistance');
        });
        break;

      case 'aslct_issue':
        logASLCTIssue(ss, data);
        break;

      case 'study_completed':
        completeStudy(ss, data);
        break;

      case 'save_state':
        saveSessionState(ss, data);
        break;

      case 'get_session':
        return getSessionData(ss, data.sessionCode);
    }

    return createCorsOutput({ success: true });
  } catch (err) {
    console.error('doPost error:', err);
    return createCorsOutput({ success: false, error: String(err) });
  }
}

function doGet(e) {
  return createCorsOutput({ success: true, status: 'ok', method: 'GET' });
}

function createCorsOutput(data) {
  var output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  output.setHeader('Access-Control-Allow-Origin', '*');
  output.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  output.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return output;
}

function sanitizeInput_(obj) {
  if (typeof obj !== 'object' || obj === null) {
    return { error: 'Invalid data' };
  }
  var out = {};
  for (var k in obj) {
    var v = obj[k];
    var t = typeof v;
    if (t === 'string') {
      out[k] = v.slice(0, 1000);
    } else if (t === 'number' || t === 'boolean') {
      out[k] = v;
    } else {
      out[k] = JSON.stringify(v);
    }
  }
  return { data: out };
}

// ===============================
// Canonical headers + header helpers
// ===============================
var SESSIONS_HEADERS = [
  'Session Code','Participant ID','Email','Created Date','Last Activity',
  'Total Time (min)','Active Time (min)','Idle Time (min)','Paused Time (min)','Tasks Completed','Status',
  'Device Type','Consent Status','Consent Source','Consent Code','Consent Timestamp',
  'EEG Status','EEG Scheduled At','EEG Scheduling Source',
  'Hearing Status','Fluency','State JSON'
];

var CONSENT_HEADER_VARIANTS = {
  'Consent1 Verify': 'Consent Status',
  'Consent2 Verify': 'Consent Status',
  'Consent 1': 'Consent Status',
  'Consent 2': 'Consent Status',
  'Consent Verify Source': 'Consent Source',
  'Consent Verify Code': 'Consent Code',
  'Consent Verify Timestamp': 'Consent Timestamp'
};

// Header map cache
var __headerCache = {};
function headerMap_(sheet) {
  var key = sheet.getSheetId() + ':' + sheet.getLastColumn();
  if (__headerCache[key]) return __headerCache[key];
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return {};
  var headers = sheet.getRange(1, 1, 1, lastCol)
    .getValues()[0]
    .map(function(v){return String(v || '').trim();});
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    if (headers[i]) map[headers[i]] = i + 1; // 1-based
  }
  __headerCache[key] = map;
  return map;
}
function clearHeaderCache_() { __headerCache = {}; }

function setByHeader_(sheet, rowIndex, headerName, value) {
  var map = headerMap_(sheet);
  var col = map[headerName];
  if (!col) {
    var newCol = sheet.getLastColumn() + 1;
    sheet.insertColumnAfter(sheet.getLastColumn());
    sheet.getRange(1, newCol).setValue(headerName)
      .setFontWeight('bold').setBackground('#f1f3f4');
    clearHeaderCache_();
    col = newCol;
  }
  sheet.getRange(rowIndex, col).setValue(value);
}

function getByHeader_(sheet, rowIndex, headerName) {
  var map = headerMap_(sheet);
  var col = map[headerName];
  if (!col) return '';
  return sheet.getRange(rowIndex, col).getValue();
}

// Bulk setter to reduce round trips
function setManyByHeader_(sheet, rowIndex, kv) {
  var map = headerMap_(sheet);
  var lastCol = sheet.getLastColumn();
  var rowVals = sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];

  Object.keys(kv).forEach(function (key) {
    if (!(key in map)) {
      var newCol = sheet.getLastColumn() + 1;
      sheet.insertColumnAfter(sheet.getLastColumn());
      sheet.getRange(1, newCol).setValue(key)
        .setFontWeight('bold').setBackground('#f1f3f4');
      clearHeaderCache_();
      map = headerMap_(sheet);
      lastCol = Math.max(lastCol, newCol);
      rowVals.length = lastCol;
    }
    rowVals[map[key] - 1] = kv[key];
  });
  sheet.getRange(rowIndex, 1, 1, rowVals.length).setValues([rowVals]);
}

// Faster row finder using TextFinder
function findRowBySessionCode_(sheet, sessionCode) {
  if (!sessionCode) return 0;
  var firstColRange = sheet.getRange(1, 1, sheet.getLastRow(), 1);
  var found = firstColRange.createTextFinder(sessionCode)
    .matchEntireCell(true)
    .useRegularExpression(false)
    .findNext();
  return found ? found.getRow() : 0;
}

// Concurrency guard
function withDocLock_(fn) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try { return fn(); }
  finally { lock.releaseLock(); }
}

// ===============================
// Non-destructive setup / migration
// ===============================
function ensureSheetWithHeaders_(ss, name, headers) {
  return withDocLock_(function () {
    var sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);

    var lastCol = sheet.getLastColumn();
    var haveAnyRows = sheet.getLastRow() > 0;
    var headerRow;

    if (!haveAnyRows) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      headerRow = headers.slice();
    } else {
      if (lastCol < 1) lastCol = headers.length;
      headerRow = sheet.getRange(1, 1, 1, Math.max(lastCol, headers.length)).getValues()[0];
      headerRow = headerRow.map(function (v) { return (v == null) ? '' : String(v); });

      headers.forEach(function (h) {
        if (headerRow.indexOf(h) === -1) {
          var newCol = sheet.getLastColumn() + 1;
          sheet.insertColumnAfter(sheet.getLastColumn());
          sheet.getRange(1, newCol).setValue(h);
          clearHeaderCache_();
        }
      });

      // Re-fetch headers after any additions and reorder columns to match
      headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
        .map(function (v) { return (v == null) ? '' : String(v); });
      for (var i = 0; i < headers.length; i++) {
        var desired = headers[i];
        var currentIndex = headerRow.indexOf(desired);
        if (currentIndex > -1 && currentIndex !== i) {
          sheet.moveColumns(sheet.getRange(1, currentIndex + 1, sheet.getMaxRows(), 1), i + 1);
          // reorder in local array
          headerRow.splice(i, 0, headerRow.splice(currentIndex, 1)[0]);
          clearHeaderCache_();
        }
      }
    }

    var finalCols = sheet.getLastColumn();
    sheet.getRange(1, 1, 1, finalCols)
         .setFontWeight('bold')
         .setBackground('#f1f3f4');
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, Math.min(finalCols, 20));
    return sheet;
  });
}

function normalizeSessionsSheet_() {
  return withDocLock_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var old = ss.getSheetByName('Sessions');
    if (!old) return;

    var data = old.getDataRange().getValues();
    var headers = (data.length ? data[0] : []).map(function(v){return String(v || '').trim();});
    var idxByName = {};
    for (var i = 0; i < headers.length; i++) {
      if (headers[i]) idxByName[headers[i]] = i;
    }

    var tmp = ss.getSheetByName('Sessions__normalized__tmp');
    if (tmp) ss.deleteSheet(tmp);
    tmp = ss.insertSheet('Sessions__normalized__tmp');
    tmp.getRange(1, 1, 1, SESSIONS_HEADERS.length).setValues([SESSIONS_HEADERS]);
    formatHeaders(tmp, SESSIONS_HEADERS.length);

    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      var out = new Array(SESSIONS_HEADERS.length).fill('');

      for (var c = 0; c < SESSIONS_HEADERS.length; c++) {
        var targetName = SESSIONS_HEADERS[c];
        var sourceName = targetName;

        if (!(sourceName in idxByName)) {
          for (var variant in CONSENT_HEADER_VARIANTS) {
            if (CONSENT_HEADER_VARIANTS[variant] === targetName && (variant in idxByName)) {
              sourceName = variant;
              break;
            }
          }
        }
        if (sourceName in idxByName) {
          out[c] = row[idxByName[sourceName]];
        }
      }

      var csIdx = SESSIONS_HEADERS.indexOf('Consent Status');
      if (csIdx !== -1 && !out[csIdx]) {
        var c1i = headers.indexOf('Consent 1');
        var c2i = headers.indexOf('Consent 2');
        var c1 = c1i > -1 ? row[c1i] : '';
        var c2 = c2i > -1 ? row[c2i] : '';
        out[csIdx] = c1 || c2 || '';
      }

      tmp.appendRow(out);
    }

    var oldName = 'Sessions__backup_' + new Date().toISOString().replace(/[:.]/g, '-');
    old.setName(oldName);
    tmp.setName('Sessions');
  });
}
function normalizeSessionsSheet() { return normalizeSessionsSheet_(); }

function backupParticipantData_(ss) {
  return withDocLock_(function () {
    var parent = DriveApp.getRootFolder();
    var folderName = 'Study Backups';
    var it = DriveApp.getFoldersByName(folderName);
    var folder = it.hasNext() ? it.next() : DriveApp.createFolder(folderName);

    var ts = new Date().toISOString().replace(/[:.]/g, '-');
    var backup = SpreadsheetApp.create('Backup_' + ts);
    var file = DriveApp.getFileById(backup.getId());
    folder.addFile(file);
    parent.removeFile(file); // keep only in backups folder

    ['Sessions', 'Task Progress', 'Session Events', 'Video Tracking', 'Email Reminders', 'Scores Summary', 'ASLCT Scores', 'RC Scores']
      .forEach(function(name) {
        var sh = ss.getSheetByName(name);
        if (sh) sh.copyTo(backup).setName(name);
      });

    // Retention: keep latest 10
    var files = folder.getFiles();
    var arr = [];
    while (files.hasNext()) arr.push(files.next());
    arr.sort(function(a,b){ return b.getDateCreated() - a.getDateCreated(); });
    for (var i = 10; i < arr.length; i++) arr[i].setTrashed(true);
  });
}

function cleanSessionsSheet_(ss) {
  return withDocLock_(function () {
    var sheet = ss.getSheetByName('Sessions');
    if (!sheet) return;
    var lastCol = sheet.getLastColumn();
    if (lastCol < 1) return;

    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

    // Merge old consent columns into single Consent Status if present
    var c1 = headers.indexOf('Consent 1');
    var c2 = headers.indexOf('Consent 2');
    var statusIdx = headers.indexOf('Consent Status');
    if (statusIdx === -1) {
      statusIdx = lastCol + 1;
      sheet.insertColumnAfter(lastCol);
      sheet.getRange(1, statusIdx).setValue('Consent Status')
           .setFontWeight('bold').setBackground('#f1f3f4');
      clearHeaderCache_();
      lastCol++;
    }

    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var val = '';
      if (c1 !== -1 && data[i][c1]) val = data[i][c1];
      if (!val && c2 !== -1 && data[i][c2]) val = data[i][c2];
      if (val) sheet.getRange(i + 1, statusIdx).setValue(val);
    }

    // Remove redundant columns if they exist
    var removeNames = ['Sequence Index', 'Activity %', 'Consent 1', 'Consent 2', 'Notes'];
    removeNames.forEach(function(name) {
      var idx = headers.indexOf(name);
      if (idx !== -1) sheet.deleteColumn(idx + 1);
    });
  });
}

function migrateVideoSheets_(ss) {
  return withDocLock_(function () {
    var headers = ['Timestamp','Session Code','Image Number','Filename','File ID','File URL','File Size (KB)','Upload Time','Upload Method','Upload Status','Error Message'];
    var tracking = ensureSheetWithHeaders_(ss, 'Video Tracking', headers);

    var oldUploads = ss.getSheetByName('Video_Uploads');
    if (oldUploads) {
      var upData = oldUploads.getDataRange().getValues();
      for (var i = 1; i < upData.length; i++) {
        tracking.appendRow(upData[i].concat(['']));
      }
      ss.deleteSheet(oldUploads);
    }

    var oldErr = ss.getSheetByName('Video_Upload_Errors');
    if (oldErr) {
      var errData = oldErr.getDataRange().getValues();
      for (var j = 1; j < errData.length; j++) {
        tracking.appendRow([
          errData[j][0], errData[j][1], errData[j][2], '', '', '', '', errData[j][4] || '', errData[j][5] || '', '', 'error', errData[j][3]
        ]);
      }
      ss.deleteSheet(oldErr);
    }

    return tracking;
  });
}

function safeSetupOrMigrate_() {
  return withDocLock_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    backupParticipantData_(ss);

    // Sessions sheet cleanup and setup
    cleanSessionsSheet_(ss);
    var sessionsSheet = ensureSheetWithHeaders_(ss, 'Sessions', SESSIONS_HEADERS);
    enforceColumnFormats_(ss);

    // Task Progress
    ensureSheetWithHeaders_(ss, 'Task Progress', [
      'Timestamp','Session Code','Participant ID','Device Type','Task Name','Event Type','Start Time','End Time','Elapsed Time (sec)','Active Time (sec)','Pause Count','Paused Time (sec)','Inactive Time (sec)','Activity Score (%)','Details','Completed'
    ]);

    // Session Events
    ensureSheetWithHeaders_(ss, 'Session Events', [
      'Timestamp','Session Code','Event Type','Details','IP Address','User Agent'
    ]);

    // Session Timer logs
    ensureSheetWithHeaders_(ss, 'Session Timer', [
      'Timestamp','Session Code','Stage','Elapsed Time (sec)','Active Time (sec)',
      'Paused Time (sec)','Inactive Time (sec)','Pause Count','Activity Score (%)',
      'Start Time','End Time'
    ]);

    // Video tracking (single sheet)
    migrateVideoSheets_(ss);

    // Email reminders
    ensureSheetWithHeaders_(ss, 'Email Reminders', [
      'Session Code','Email','Last Reminder Sent','Reminders Count','Status'
    ]);

    // Score tracking
    ensureSheetWithHeaders_(ss, 'ASLCT Scores', ['Session Code','ASLCT Score','Entry Time','Notes']);
    ensureSheetWithHeaders_(ss, 'RC Scores', ['Session Code','RC Score','Entry Time','Notes']);
    var summary = ensureSheetWithHeaders_(ss, 'Scores Summary', ['Session Code','ASLCT Score','RC Score']);
    if (summary.getLastRow() < 2) {
      summary.getRange('B2').setFormula('=ARRAYFORMULA(IF(A2:A="",,IFERROR(VLOOKUP(A2:A,\'ASLCT Scores\'!A:B,2,false),"")))');
      summary.getRange('C2').setFormula('=ARRAYFORMULA(IF(A2:A="",,IFERROR(VLOOKUP(A2:A,\'RC Scores\'!A:B,2,false),"")))');
    }

    // Dynamic columns + dashboard
    ensureConsentColumns_(ss);
    var eegCols = ensureEEGColumns_(ss);

    var dash = ss.getSheetByName('Dashboard') || ss.insertSheet('Dashboard');
    dash.getRange('A1').setValue('Dashboard').setFontSize(16).setFontWeight('bold');
    dash.getRange('A3').setValue('Total Sessions');
    dash.getRange('B3').setFormula('=COUNTA(Sessions!A2:A)');

    var hmap = headerMap_(sessionsSheet);
    function colLetter(colIndex){ return sessionsSheet.getRange(1, colIndex).getA1Notation().replace(/[0-9]/g,''); }
    var STATUS_COL = colLetter(hmap['Status']);
    var DEVICE_COL = colLetter(hmap['Device Type']);

    dash.getRange('A4').setValue('Completed Studies');
    dash.getRange('B4').setFormula('=COUNTIF(Sessions!' + STATUS_COL + '2:' + STATUS_COL + ',"Complete")');

    dash.getRange('A6').setValue('Device Breakdown');
    dash.getRange('A7').setValue('Desktop');
    dash.getRange('B7').setFormula('=COUNTIF(Sessions!' + DEVICE_COL + '2:' + DEVICE_COL + ',"*Desktop*")');
    dash.getRange('A8').setValue('Mobile');
    dash.getRange('B8').setFormula('=COUNTIF(Sessions!' + DEVICE_COL + '2:' + DEVICE_COL + ',"*Mobile*")');
    dash.getRange('A9').setValue('Tablet');
    dash.getRange('B9').setFormula('=COUNTIF(Sessions!' + DEVICE_COL + '2:' + DEVICE_COL + ',"*Tablet*")');

    dash.getRange('A11').setValue('Video Uploads');
    dash.getRange('A12').setValue('Successful');
    dash.getRange('B12').setFormula('=COUNTIF(\'Video Tracking\'!K2:K,"success")');
    dash.getRange('A13').setValue('Failed');
    dash.getRange('B13').setFormula('=COUNTIF(\'Video Tracking\'!K2:K,"error")');

    dash.getRange('A15').setValue('Score Entries');
    dash.getRange('A16').setValue('ASLCT Scores Entered');
    dash.getRange('B16').setFormula('=COUNTA(\'ASLCT Scores\'!A2:A)');
    dash.getRange('A17').setValue('RC Scores Entered');
    dash.getRange('B17').setFormula('=COUNTA(\'RC Scores\'!A2:A)');

    dash.getRange('A19').setValue('EEG Interested');
    var eegStatusCol = ss.getSheetByName('Sessions').getRange(1, eegCols.status).getA1Notation().replace(/[0-9]/g, '');
    dash.getRange('B19').setFormula('=COUNTIF(Sessions!' + eegStatusCol + '2:' + eegStatusCol + ',"Interested")');
    dash.autoResizeColumns(1, 2);

    // Pre-create Drive root folder
    getOrCreateStudyFolder();

    return true;
  });
}

// ===============================
// Video upload
// ===============================
function getExtensionFromMime_(mime) {
  mime = (mime || '').toLowerCase();
  if (mime.indexOf('mp4') !== -1 || mime.indexOf('m4a') !== -1) return 'mp4';
  if (mime.indexOf('ogg') !== -1) return 'ogg';
  if (mime.indexOf('wav') !== -1) return 'wav';
  if (mime.indexOf('webm') !== -1) return 'webm';
  return 'bin';
}
/**
 * Simplified video upload handler for Cloudinary-based uploads
 * Now primarily handles metadata since videos go directly to Cloudinary
 */
function handleVideoUpload(data) {
  try {
    // New: Check if this is a metadata-only upload (from Cloudinary)
    if (data.uploadMethod === 'cloudinary' || data.uploadMethod === 'external') {
      console.log('External upload metadata received:', {
        sessionCode: data.sessionCode,
        imageNumber: data.imageNumber,
        method: data.uploadMethod,
        url: data.fileUrl
      });
      
      // Just log the metadata - no file creation needed
      return handleExternalUploadMetadata(data);
    }
    
    // Legacy: Handle direct base64 uploads (fallback only)
    if (!data.videoData) {
      console.log('No video data provided, treating as metadata-only');
      return handleExternalUploadMetadata(data);
    }
    
    console.log('Legacy upload request received:', {
      sessionCode: data.sessionCode,
      imageNumber: data.imageNumber,
      format: data.videoFormat || 'unknown',
      mimeType: data.mimeType || 'unknown',
      size: data.fileSize || 'unknown',
      hasBase64: !!data.videoData
    });

    // Validate required fields
    if (!data.sessionCode || !data.imageNumber) {
      throw new Error('Missing required fields: sessionCode, imageNumber');
    }

    // Size check for base64 data (if provided)
    if (data.videoData) {
      const estimatedSize = (data.videoData.length * 3) / 4; // Base64 to bytes estimation
      const maxSize = PropertiesService.getScriptProperties().getProperty('MAX_UPLOAD_SIZE_BYTES') || 5242880;
      
      if (estimatedSize > parseInt(maxSize)) {
        console.error('File too large:', estimatedSize, 'bytes. Max:', maxSize);
        throw new Error('File too large for direct upload. Please use Cloudinary.');
      }
    }

    // Rest of your existing Google Drive upload code...
    var studyFolder = getOrCreateStudyFolder();
    var participantFolder = getOrCreateParticipantFolder(studyFolder, data.sessionCode);

    var bytes;
    try {
      bytes = Utilities.base64Decode(data.videoData);
      console.log('Decoded bytes:', bytes.length);
    } catch (decodeError) {
      console.error('Base64 decode error:', decodeError);
      throw new Error('Invalid video data encoding');
    }

    // Your existing format detection code...
    var extension = 'webm';
    if (data.videoFormat && data.videoFormat.length > 0) {
      extension = String(data.videoFormat).toLowerCase();
    } else if (data.mimeType && data.mimeType.length > 0) {
      var mime = String(data.mimeType).toLowerCase();
      if (mime.indexOf('mp4') !== -1) extension = 'mp4';
      else if (mime.indexOf('quicktime') !== -1) extension = 'mov';
      else if (mime.indexOf('webm') !== -1) extension = 'webm';
    }

    var ts = new Date().toISOString().replace(/[:.]/g, '-');
    var filename = data.sessionCode + '_image' + data.imageNumber + '_' + ts + '.' + extension;
    
    var mimeTypeMap = {
      'mp4': 'video/mp4',
      'mov': 'video/quicktime',
      'webm': 'video/webm',
      'mkv': 'video/x-matroska',
      'avi': 'video/x-msvideo'
    };
    var blobMimeType = mimeTypeMap[extension] || 'video/webm';

    var blob = Utilities.newBlob(bytes, blobMimeType, filename);
    var file = participantFolder.createFile(blob);

    try {
      file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.VIEW);
    } catch (e) {
      console.warn('Could not set file sharing:', e);
    }

    // Enhanced logging
    logVideoUpload({
      sessionCode: data.sessionCode,
      imageNumber: data.imageNumber,
      filename: filename,
      fileId: file.getId(),
      fileUrl: file.getUrl(),
      fileSize: Math.round(bytes.length / 1024),
      uploadTime: new Date().toISOString(),
      uploadMethod: 'google_drive_fallback', // Mark as fallback
      videoFormat: extension,
      mimeType: blobMimeType,
      uploadStatus: 'success'
    });

    return createCorsOutput({
      success: true,
      fileId: file.getId(),
      fileUrl: file.getUrl(),
      filename: filename,
      format: extension,
      uploadMethod: 'google_drive_fallback'
    });

  } catch (err) {
    console.error('Video upload error:', err);
    
    // Log error with enhanced tracking
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      logVideoUploadError(ss, {
        sessionCode: (data && data.sessionCode) || 'unknown',
        imageNumber: (data && data.imageNumber) || 0,
        error: String(err),
        format: (data && data.videoFormat) || 'unknown',
        size: (data && data.fileSize) || 0,
        timestamp: new Date().toISOString(),
        attemptedMethod: data.uploadMethod || 'google_drive',
        fallbackUsed: false,
        errorType: err.name || 'UnknownError',
        errorStack: err.stack || ''
      });
    } catch (logErr) {
      console.error('Failed to log video upload error:', logErr);
    }

    return createCorsOutput({
      success: false,
      error: String(err),
      details: err.message || 'Upload failed',
      uploadMethod: 'google_drive_fallback'
    });
  }
}

/**
 * Handles metadata for videos uploaded to external services (Cloudinary, etc)
 * No actual file data is processed - just records the upload information
 */
function handleExternalUploadMetadata(data) {
  try {
    console.log('Processing external upload metadata:', {
      method: data.uploadMethod,
      sessionCode: data.sessionCode,
      imageNumber: data.imageNumber,
      url: data.fileUrl
    });

    // Validate required fields
    if (!data.sessionCode || !data.imageNumber) {
      throw new Error('Missing required metadata fields');
    }

    // Create metadata record
    var metadata = {
      sessionCode: data.sessionCode,
      imageNumber: data.imageNumber,
      filename: data.filename || `${data.sessionCode}_image${data.imageNumber}_external`,
      fileId: data.fileId || data.publicId || '',
      fileUrl: data.fileUrl || '',
      fileSize: data.fileSize || 0,
      uploadTime: data.uploadTime || new Date().toISOString(),
      uploadMethod: data.uploadMethod || 'external',
      videoFormat: data.videoFormat || data.format || 'unknown',
      mimeType: data.mimeType || '',
      cloudinaryPublicId: data.publicId || '',
      uploadStatus: 'success',
      externalService: data.uploadMethod === 'cloudinary' ? 'Cloudinary' :
                       data.uploadMethod === 'google_drive' ? 'Google Drive' : 'Unknown'
    };

    // Log to Video Tracking sheet
    logVideoUpload(metadata);

    // Also update Sessions sheet with upload count
    updateSessionVideoCount(data.sessionCode);

    return createCorsOutput({
      success: true,
      message: 'Metadata recorded successfully',
      uploadMethod: data.uploadMethod,
      fileUrl: data.fileUrl
    });

  } catch (error) {
    console.error('External metadata handling error:', error);
    
    return createCorsOutput({
      success: false,
      error: String(error),
      uploadMethod: data.uploadMethod || 'external'
    });
  }
}

/**
 * Updates the video upload count in Sessions sheet
 */
function updateSessionVideoCount(sessionCode) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sessionsSheet = ss.getSheetByName('Sessions');
    if (!sessionsSheet) return;
    
    // Find or create column for video uploads
    var headers = sessionsSheet.getRange(1, 1, 1, sessionsSheet.getLastColumn()).getValues()[0];
    var videoCountCol = headers.indexOf('Videos Uploaded');
    
    if (videoCountCol === -1) {
      // Add new column
      videoCountCol = sessionsSheet.getLastColumn() + 1;
      sessionsSheet.getRange(1, videoCountCol).setValue('Videos Uploaded');
    } else {
      videoCountCol++; // Convert to 1-based index
    }
    
    // Find session row
    var row = findRowBySessionCode_(sessionsSheet, sessionCode);
    if (row) {
      var currentCount = sessionsSheet.getRange(row, videoCountCol).getValue() || 0;
      sessionsSheet.getRange(row, videoCountCol).setValue(currentCount + 1);
    }
  } catch (e) {
    console.warn('Could not update video count:', e);
  }
}

// ===============================
// Setup helpers (destructive only for brand new spreadsheets)
// ===============================
function initialSetup() {
  return withDocLock_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    var sessionsSheet = ss.getSheetByName('Sessions') || ss.insertSheet('Sessions');
    sessionsSheet.clear();
    sessionsSheet.getRange(1, 1, 1, SESSIONS_HEADERS.length).setValues([SESSIONS_HEADERS]);
    formatHeaders(sessionsSheet, SESSIONS_HEADERS.length);

    var progressSheet = ss.getSheetByName('Task Progress') || ss.insertSheet('Task Progress');
    progressSheet.clear();
    progressSheet.getRange(1, 1, 1, 16).setValues([[
      'Timestamp','Session Code','Participant ID','Device Type','Task Name','Event Type','Start Time','End Time','Elapsed Time (sec)','Active Time (sec)','Pause Count','Paused Time (sec)','Inactive Time (sec)','Activity Score (%)','Details','Completed'
    ]]);
    formatHeaders(progressSheet, 16);

    var eventsSheet = ss.getSheetByName('Session Events') || ss.insertSheet('Session Events');
    eventsSheet.clear();
    eventsSheet.getRange(1, 1, 1, 6).setValues([[
      'Timestamp','Session Code','Event Type','Details','IP Address','User Agent'
    ]]);
    formatHeaders(eventsSheet, 6);

    var videoSheet = ss.getSheetByName('Video Tracking') || ss.insertSheet('Video Tracking');
    videoSheet.clear();
    videoSheet.getRange(1, 1, 1, 11).setValues([[
      'Timestamp','Session Code','Image Number','Filename','File ID','File URL','File Size (KB)','Upload Time','Upload Method','Upload Status','Error Message'
    ]]);
    formatHeaders(videoSheet, 11);

    var reminders = ss.getSheetByName('Email Reminders') || ss.insertSheet('Email Reminders');
    reminders.clear();
    reminders.getRange(1, 1, 1, 5).setValues([[
      'Session Code','Email','Last Reminder Sent','Reminders Count','Status'
    ]]);
    formatHeaders(reminders, 5);

    var dash = ss.getSheetByName('Dashboard') || ss.insertSheet('Dashboard');
    setupDashboard(dash);

    getOrCreateStudyFolder();
    console.log('Destructive setup complete.');
  });
}

function formatHeaders(sheet, nCols) {
  var range = sheet.getRange(1, 1, 1, nCols);
  range.setFontWeight('bold').setBackground('#f1f3f4');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, nCols);
}

function setupDashboard(sheet) {
  sheet.clear();
  sheet.getRange('A1').setValue('Dashboard');
  sheet.getRange('A1').setFontSize(16).setFontWeight('bold');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sessionsSheet = ss.getSheetByName('Sessions');
  var hmap = headerMap_(sessionsSheet);
  function colLetter(colIndex){ return sessionsSheet.getRange(1, colIndex).getA1Notation().replace(/[0-9]/g,''); }
  var STATUS_COL = colLetter(hmap['Status']);
  var DEVICE_COL = colLetter(hmap['Device Type']);

  sheet.getRange('A3').setValue('Total Sessions');
  sheet.getRange('B3').setFormula('=COUNTA(Sessions!A2:A)');

  sheet.getRange('A4').setValue('Completed Studies');
  sheet.getRange('B4').setFormula('=COUNTIF(Sessions!' + STATUS_COL + '2:' + STATUS_COL + ',"Complete")');

  sheet.getRange('A5').setValue('Videos Uploaded');
  sheet.getRange('B5').setFormula('=COUNTA(\'Video Tracking\'!A2:A)');

  sheet.getRange('A6').setValue('Device Breakdown');
  sheet.getRange('A7').setValue('Desktop');
  sheet.getRange('B7').setFormula('=COUNTIF(Sessions!' + DEVICE_COL + '2:' + DEVICE_COL + ',"*Desktop*")');
  sheet.getRange('A8').setValue('Mobile');
  sheet.getRange('B8').setFormula('=COUNTIF(Sessions!' + DEVICE_COL + '2:' + DEVICE_COL + ',"*Mobile*")');
  sheet.getRange('A9').setValue('Tablet');
  sheet.getRange('B9').setFormula('=COUNTIF(Sessions!' + DEVICE_COL + '2:' + DEVICE_COL + ',"*Tablet*")');
  
  // Add upload method metrics
  sheet.getRange('A20').setValue('Upload Methods Used');
  sheet.getRange('A21').setValue('Cloudinary Uploads');
  sheet.getRange('B21').setFormula('=COUNTIF(\'Video Tracking\'!I2:I,"cloudinary")');
  sheet.getRange('A22').setValue('Google Drive Uploads');
  sheet.getRange('B22').setFormula('=COUNTIF(\'Video Tracking\'!I2:I,"google_drive*")');

  sheet.getRange('A25').setValue('External Service Success Rate');
  sheet.getRange('A26').setValue('Cloudinary Success');
  sheet.getRange('B26').setFormula('=IFERROR(COUNTIFS(\'Video Tracking\'!I2:I,"cloudinary",\'Video Tracking\'!O2:O,"success")/COUNTIF(\'Video Tracking\'!I2:I,"cloudinary"),0)');
  sheet.getRange('B26').setNumberFormat('0%');

  sheet.getRange('A28').setValue('Average Upload Size (KB)');
  sheet.getRange('B28').setFormula('=IFERROR(AVERAGE(\'Video Tracking\'!G2:G),0)');
  sheet.getRange('B28').setNumberFormat('#,##0');

  sheet.autoResizeColumns(1, 2);
}

// ===============================
// Drive helpers
// ===============================
function getOrCreateStudyFolder() {
  var name = 'Spatial Cognition Study Videos';
  var it = DriveApp.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  var folder = DriveApp.createFolder(name);
  console.log('Created study folder:', name);
  return folder;
}
function getOrCreateParticipantFolder(parent, sessionCode) {
  var name = 'Participant_' + sessionCode;
  var it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  var folder = parent.createFolder(name);
  console.log('Created participant folder:', name);
  return folder;
}

// ===============================
// Sessions and events
// ===============================
function createSession(ss, data) {
  return withDocLock_(function () {
    var sheet = ss.getSheetByName('Sessions') || ss.insertSheet('Sessions');
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, SESSIONS_HEADERS.length).setValues([SESSIONS_HEADERS]);
      formatHeaders(sheet, SESSIONS_HEADERS.length);
    }

    var createdIso = normalizeIso_(data.created || data.timestamp);
    var lastIso    = normalizeIso_(data.timestamp || data.created);
    var dev        = detectDeviceType_(data);
    var totalTasks = dev.isMobile ? 6 : 7;

    var row = findRowBySessionCode_(sheet, data.sessionCode);
    if (!row) {
      row = sheet.getLastRow() + 1;
      sheet.insertRowsAfter(sheet.getLastRow() || 1, 1);
    }

    // Force Tasks Completed to text before writing
    var hmap = headerMap_(sheet);
    if (hmap['Tasks Completed']) {
      sheet.getRange(row, hmap['Tasks Completed']).setNumberFormat('@');
    }

    setManyByHeader_(sheet, row, {
      'Session Code': data.sessionCode,
      'Participant ID': data.participantID,
      'Email': data.email || '',
      'Created Date': createdIso,
      'Last Activity': lastIso,
      'Total Time (min)': 0,
      'Active Time (min)': 0,
      'Idle Time (min)': 0,
      'Paused Time (min)': 0,
      'Tasks Completed': (dev.isMobile ? '0/6' : '0/7'),
      'Status': 'Active',
      'Device Type': dev.label,
      'Consent Status': 'Pending',
      'Hearing Status': data.hearingStatus || '',
      'Fluency': data.fluency || '',
      'State JSON': ''
    });

    enforceColumnFormats_(SpreadsheetApp.getActiveSpreadsheet());

    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: 'Session Created',
      details: 'ID: ' + (data.participantID || '') + ', Device: ' + dev.label + ', Tasks: ' + totalTasks,
      timestamp: lastIso,
      userAgent: data.userAgent || ''
    });

    if (data.email) {
      addEmailReminder(ss, data.sessionCode, data.email);
    }

    try {
      var folder = getOrCreateStudyFolder();
      getOrCreateParticipantFolder(folder, data.sessionCode);
    } catch (e) {
      console.warn('Could not pre-create participant folder:', e);
    }
  });
}

function addEmailReminder(ss, sessionCode, email) {
  return withDocLock_(function () {
    var sheet = ss.getSheetByName('Email Reminders');
    if (!sheet) return;
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === sessionCode) {
        sheet.getRange(i + 1, 2).setValue(email || data[i][1] || '');
        sheet.getRange(i + 1, 5).setValue('New Session');
        return;
      }
    }
    sheet.appendRow([sessionCode, email || '', '', 0, 'New Session']);
  });
}


function resumeSession(ss, data) {
  withDocLock_(function () {
    updateSessionActivity(ss, data.sessionCode, data.timestamp);
    if (data.pausedSeconds) {
      var sheet = ss.getSheetByName('Sessions');
      var row = findRowBySessionCode_(sheet, data.sessionCode);
      if (row) {
        var existing = Number(getByHeader_(sheet, row, 'Paused Time (min)')) || 0;
        var addMin = Math.round(Number(data.pausedSeconds) / 60);
        setByHeader_(sheet, row, 'Paused Time (min)', existing + addMin);
      }
    }
    updateCompletedTasksCount(ss, data.sessionCode);
    var s = ss.getSheetByName('Sessions');
    var r = findRowBySessionCode_(s, data.sessionCode);
    var hmap = headerMap_(s);
    var progress = 'unknown';
    if (r && hmap['Tasks Completed']) {
      progress = String(s.getRange(r, hmap['Tasks Completed']).getValue() || '');
    }
    var resumeDetails = 'Progress: ' + progress;
    if (data.pausedSeconds) {
      resumeDetails += '; pausedSeconds: ' + data.pausedSeconds;
    }
    if (data.pauseType) {
      resumeDetails += '; previousPauseType: ' + data.pauseType;
    }
    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: 'Session Resumed',
      details: resumeDetails,
      timestamp: data.timestamp,
      userAgent: data.userAgent || ''
    });
    updateTotalTime(ss, data.sessionCode);
  });
}

function pauseSession(ss, data) {
  withDocLock_(function () {
    updateSessionActivity(ss, data.sessionCode, data.timestamp);
    updateTotalTime(ss, data.sessionCode);
    updateCompletedTasksCount(ss, data.sessionCode);
    var s = ss.getSheetByName('Sessions');
    var r = findRowBySessionCode_(s, data.sessionCode);
    var hmap = headerMap_(s);
    var progress = 'unknown';
    if (r && hmap['Tasks Completed']) {
      progress = String(s.getRange(r, hmap['Tasks Completed']).getValue() || '');
    }
    var eventType = data.pauseType === 'exit' ? 'Session Saved & Exited' : 'Session Paused';
    var details = 'Progress: ' + progress;
    if (data.pauseType) {
      details += '; pauseType: ' + data.pauseType;
    }
    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: eventType,
      details: details,
      timestamp: data.timestamp,
      userAgent: data.userAgent || ''
    });
  });
}

function logConsentOpened(ss, data) {
  withDocLock_(function () {
    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: 'Consent Opened',
      details: data.type,
      timestamp: data.timestamp
    });
  });
}

function logConsentCompleted(ss, data) {
  withDocLock_(function () {
    var sheet = ss.getSheetByName('Sessions');
    var cols = ensureConsentColumns_(ss);
    var row = findRowBySessionCode_(sheet, data.sessionCode);
    if (row) sheet.getRange(row, cols.status).setValue('Complete');

    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: 'Consent Completed',
      details: 'Consent marked complete',
      timestamp: data.timestamp
    });
  });
}

function logVideoDeclined(ss, data) {
  withDocLock_(function () {
    var sheet = ss.getSheetByName('Sessions');
    var cols = ensureConsentColumns_(ss);
    var row = findRowBySessionCode_(sheet, data.sessionCode);
    if (row) sheet.getRange(row, cols.status).setValue('Declined');
    updateCompletedTasksCount(ss, data.sessionCode);

    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: 'Video Declined',
      details: 'User declined video consent',
      timestamp: data.timestamp
    });
  });
}

function saveSessionState(ss, data) {
  withDocLock_(function () {
    if (!data.sessionCode) return;
    var sheet = ss.getSheetByName('Sessions');
    if (!sheet) return;

    var lastCol = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (v) { return String(v || ''); });

    var stateIdx = headers.indexOf('State JSON');
    if (stateIdx === -1) {
      stateIdx = lastCol;
      sheet.insertColumnAfter(lastCol);
      stateIdx++;
      sheet.getRange(1, stateIdx).setValue('State JSON').setFontWeight('bold').setBackground('#f1f3f4');
      clearHeaderCache_();
      headers.push('State JSON');
    } else {
      stateIdx = stateIdx + 1;
    }

    var lastIdx = headers.indexOf('Last Activity');
    lastIdx = lastIdx === -1 ? null : lastIdx + 1;

    var row = findRowBySessionCode_(sheet, data.sessionCode);
    if (row) {
      var stateObj;
      try {
        stateObj = typeof data.state === 'string' ? JSON.parse(data.state) : (data.state || {});
      } catch (e) {
        stateObj = data.state || {};
      }
      sheet.getRange(row, stateIdx).setValue(JSON.stringify(stateObj));
      if (lastIdx) sheet.getRange(row, lastIdx).setValue(data.timestamp || new Date().toISOString());
      if (stateObj && stateObj.consentStatus) {
        var cols = ensureConsentColumns_(ss);
        var status = stateObj.consentStatus.videoDeclined ? 'Declined'
          : (stateObj.consentStatus.consent2 ? 'Complete' : 'Pending');
        sheet.getRange(row, cols.status).setValue(status);
      }
    }
  });
}

// ===============================
// Task summaries
// ===============================
function getSessionActivityTracking(sessionCode) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Task Progress');
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  var tracking = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === sessionCode) {
      tracking.push({
        timestamp: data[i][0],
        task: data[i][4],
        eventType: data[i][5],
        startTime: data[i][6],
        endTime: data[i][7],
        elapsed: data[i][8],
        active: data[i][9],
        pauseCount: data[i][10],
        paused: data[i][11],
        inactive: data[i][12],
        activity: data[i][13],
        details: data[i][14],
        completed: data[i][15]
      });
    }
  }
  return tracking;
}

function getSessionActivitySummary(sessionCode) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var progressSheet = ss.getSheetByName('Task Progress');
  var eventsSheet = ss.getSheetByName('Session Events');

  var progressData = progressSheet.getDataRange().getValues();
  var eventsData = eventsSheet.getDataRange().getValues();

  var summary = {
    sessionCode: sessionCode,
    tasks: {},
    events: [],
    totalDuration: 0,
    completedCount: 0,
    startedCount: 0
  };

  for (var i = 1; i < progressData.length; i++) {
    if (progressData[i][1] === sessionCode) {
      var taskName = progressData[i][4];
      var eventType = progressData[i][5];
      var duration = progressData[i][8];

      if (!summary.tasks[taskName]) {
        summary.tasks[taskName] = {
          started: false,
          completed: false,
          duration: 0,
          attempts: 0
        };
      }

      if (eventType === 'Started') {
        summary.tasks[taskName].started = true;
        summary.tasks[taskName].attempts++;
        summary.startedCount++;
      } else if (eventType === 'Completed') {
        summary.tasks[taskName].completed = true;
        summary.tasks[taskName].duration = duration;
        summary.totalDuration += Number(duration) || 0;
        summary.completedCount++;
      } else if (eventType === 'Skipped') {
        summary.tasks[taskName].started = true;
        summary.tasks[taskName].completed = true;
        summary.tasks[taskName].attempts++;
        summary.startedCount++;
        summary.completedCount++;
      }
    }
  }

  for (var j = 1; j < eventsData.length; j++) {
    if (eventsData[j][1] === sessionCode) {
      summary.events.push({
        timestamp: eventsData[j][0],
        type: eventsData[j][2],
        details: eventsData[j][3]
      });
    }
  }

  return summary;
}
function testActivitySummary() {
  var code = SpreadsheetApp.getUi().prompt('Enter session code:').getResponseText();
  var summary = getSessionActivitySummary(code);
  SpreadsheetApp.getUi().alert(JSON.stringify(summary, null, 2));
}

// ===============================
// Task logging
// ===============================
function logTaskOpened(ss, data) {
  withDocLock_(function () {
    var sheet = ss.getSheetByName('Task Progress');
    var dev = detectDeviceType_(data).label;
    sheet.appendRow([
      data.timestamp,
      data.sessionCode,
      data.participantID || '',
      dev,
      data.task,
      'Opened',
      '',
      '',
      0, 0, 0, 0, 0, 0,
      '',
      false
    ]);
    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: 'Task Opened',
      details: data.task,
      timestamp: data.timestamp
    });
    updateSessionActivity(ss, data.sessionCode, data.timestamp);
  });
}

function logTaskStart(ss, data) {
  withDocLock_(function () {
    var sheet = ss.getSheetByName('Task Progress');
    var dev = detectDeviceType_(data).label;
    sheet.appendRow([
      data.timestamp,
      data.sessionCode,
      data.participantID || getParticipantIDFromSession(ss, data.sessionCode),
      dev,
      data.task,
      'Started',
      data.startTime || data.timestamp,
      '',
      0, 0, 0, 0, 0, 0,
      '',
      false
    ]);
    updateSessionActivity(ss, data.sessionCode, data.timestamp);

    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: 'Task Started',
      details: data.task,
      timestamp: data.timestamp
    });
  });
}

function logTaskComplete(ss, data) {
  withDocLock_(function () {
    var sheet = ss.getSheetByName('Task Progress');
    var details = data.details || '';
    var activityPct = data.activity || (data.elapsed ? (data.active / data.elapsed * 100) : 0);
    var suspicious = (data.elapsed && data.active && (data.active / data.elapsed) < 0.3);
    if (data.recordingDuration) {
      details = (details ? details + '; ' : '') + 'Recording ' + data.recordingDuration + 's';
    }
    if (suspicious) {
      details = (details ? details + ' | ' : '') + 'FLAG: Low activity';
    }
    var dev = detectDeviceType_(data).label;
    sheet.appendRow([
      data.timestamp,
      data.sessionCode,
      data.participantID || getParticipantIDFromSession(ss, data.sessionCode),
      dev,
      data.task,
      'Completed',
      data.startTime || '',
      data.endTime || '',
      data.elapsed || 0,
      data.active || 0,
      data.pauseCount || 0,
      data.paused || 0,
      data.inactive || 0,
      activityPct || 0,
      details,
      true
    ]);
    updateCompletedTasksCount(ss, data.sessionCode);
    updateSessionActivity(ss, data.sessionCode, data.timestamp);
    updateTotalTime(ss, data.sessionCode);

    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: 'Task Completed',
      details: data.task + ' (Elapsed: ' + (data.elapsed || 0) + 's, Active: ' + (data.active || 0) + 's)',
      timestamp: data.timestamp
    });
    if (suspicious) {
      logSessionEvent(ss, {
        sessionCode: data.sessionCode,
        eventType: 'Suspicious Activity',
        details: data.task + ' activity ' + Math.round((data.active / data.elapsed) * 100) + '%',
        timestamp: data.timestamp
      });
    }
  });
}

function getParticipantIDFromSession(ss, sessionCode) {
  var sheet = ss.getSheetByName('Sessions');
  if (!sheet) return '';
  var row = findRowBySessionCode_(sheet, sessionCode);
  if (!row) return '';
  return getByHeader_(sheet, row, 'Participant ID') || '';
}

function logTaskSkipped(ss, data) {
  withDocLock_(function () {
    var sheet = ss.getSheetByName('Task Progress');
    var dev = detectDeviceType_(data).label;
    sheet.appendRow([
      data.timestamp,
      data.sessionCode,
      data.participantID || '',
      dev,
      data.task,
      'Skipped',
      '',
      '',
      0, 0, 0, 0, 0,
      data.reason || 'User choice',
      true
    ]);

    updateCompletedTasksCount(ss, data.sessionCode);
    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: 'Task Skipped',
      details: data.task + ' - Reason: ' + (data.reason || 'User choice'),
      timestamp: data.timestamp
    });
    updateSessionActivity(ss, data.sessionCode, data.timestamp);
  });
}

function logHelpRequested(ss, data) {
  withDocLock_(function () {
    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: 'Help Requested',
      details: data.task,
      timestamp: data.timestamp
    });
  });
}

function logASLCTIssue(ss, data) {
  withDocLock_(function () {
    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: 'ASLCT Issue',
      details: (data.participantID ? data.participantID + ': ' : '') + (data.message || ''),
      timestamp: data.timestamp
    });
  });
}

function logSessionTimer(ss, data) {
  withDocLock_(function () {
    var sheet = ss.getSheetByName('Session Timer');
    if (!sheet) return;
    sheet.appendRow([
      data.timestamp || new Date().toISOString(),
      data.sessionCode || '',
      data.stage || '',
      Number(data.elapsed) || 0,
      Number(data.active) || 0,
      Number(data.paused) || 0,
      Number(data.inactive) || 0,
      Number(data.pauseCount) || 0,
      Number(data.activity) || 0,
      data.startTime || '',
      data.endTime || ''
    ]);
    updateSessionActivity(ss, data.sessionCode, data.timestamp);
    updateTotalTime(ss, data.sessionCode);
  });
}

// ===============================
// Image / video task events
// ===============================
function logImageRecorded(ss, data) {
  withDocLock_(function () {
    var p = ss.getSheetByName('Task Progress');
    var dev = detectDeviceType_(data).label;
    var recType = (data.recordingType || 'video');
    p.appendRow([
      data.timestamp,
      data.sessionCode,
      data.participantID || '',
      dev,
      'Image Description',
      'Image ' + data.imageNumber + ' Recorded (' + recType + ')',
      '', '', 0, 0, 0, 0, 0,
      'Image ' + data.imageNumber + '/2 (' + recType + ')',
      false
    ]);
    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: 'Image Recorded',
      details: 'Image ' + data.imageNumber + '/2 (' + recType + ')',
      timestamp: data.timestamp
    });
  });
}

function logImageRecordedAndUploaded(ss, data) {
  withDocLock_(function () {
    var p = ss.getSheetByName('Task Progress');
    var dev = detectDeviceType_(data).label;
    var recType = (data.recordingType || 'video');
    p.appendRow([
      data.timestamp,
      data.sessionCode,
      data.participantID || '',
      dev,
      'Image Description',
      'Image ' + data.imageNumber + ' Recorded & Uploaded (' + recType + ')',
      '', '', 0, 0, 0, 0, 0,
      'File: ' + data.filename + ' (' + recType + ')',
      false
    ]);
    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: 'Image Recorded & Uploaded',
      details: 'Image ' + data.imageNumber + '/2 - File: ' + data.filename + ' (' + recType + ') - ID: ' + data.driveFileId + ' - Method: ' + (data.uploadMethod || 'unknown'),
      timestamp: data.timestamp
    });
  });
}

function logImageRecordedNoUpload(ss, data) {
  withDocLock_(function () {
    var p = ss.getSheetByName('Task Progress');
    var dev = detectDeviceType_(data).label;
    var recType = (data.recordingType || 'video');
    p.appendRow([
      data.timestamp,
      data.sessionCode,
      data.participantID || '',
      dev,
      'Image Description',
      'Image ' + data.imageNumber + ' Recorded (Local Only - ' + recType + ')',
      '', '', 0, 0, 0, 0, 0,
      'Reason: ' + data.reason + ' (' + recType + ')',
      false
    ]);
    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: 'Image Recorded (No Upload)',
      details: 'Image ' + data.imageNumber + '/2 - ' + recType + ' - Reason: ' + data.reason,
      timestamp: data.timestamp
    });
  });
}

function logVideoRecording(ss, data) {
  withDocLock_(function () {
    var p = ss.getSheetByName('Task Progress');
    var dev = detectDeviceType_(data).label;
    var recType = (data.recordingType || 'video');
    p.appendRow([
      data.timestamp,
      data.sessionCode,
      data.participantID || '',
      dev,
      'Image Description',
      'Recording Completed - Image ' + data.imageNumber + ' (' + recType + ')',
      '', '', 0, 0, 0, 0, 0,
      'Image ' + data.imageNumber + ' of 2 recorded (' + recType + ')',
      false
    ]);

    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: 'Recording Completed',
      details: 'Image ' + data.imageNumber + ' recorded (' + recType + ')',
      timestamp: data.timestamp
    });
  });
}

// ===============================
// Calendly
// ===============================
function logCalendlyOpened(ss, data) {
  withDocLock_(function () {
    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: 'Calendly Opened',
      details: 'Participant opened Calendly scheduling',
      timestamp: data.timestamp
    });
  });
}

function logEEGInterest(ss, data) {
  withDocLock_(function () {
    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: 'EEG Interest',
      details: 'Participant requested EEG scheduling assistance',
      timestamp: data.timestamp
    });
  });
}

// ===============================
// Study completion
// ===============================
function completeStudy(ss, data) {
  withDocLock_(function () {
    var required = getRequiredTasksForSession_(ss, data.sessionCode);
    var s = ss.getSheetByName('Sessions');
    if (!s) return;

    var row = findRowBySessionCode_(s, data.sessionCode);
    if (!row) return;

    // Recompute counts to ensure consistency
    updateCompletedTasksCount(ss, data.sessionCode);
    var hmap = headerMap_(s);
    var tc = hmap['Tasks Completed'] ? String(s.getRange(row, hmap['Tasks Completed']).getValue() || '') : (required.length + '/' + required.length);

    if (hmap['Tasks Completed']) {
      s.getRange(row, hmap['Tasks Completed']).setNumberFormat('@');
    }
    setManyByHeader_(s, row, {
      'Total Time (min)': data.totalDuration || 0,
      'Tasks Completed': tc,
      'Status': data.status || 'Complete'
    });

    logSessionEvent(ss, {
      sessionCode: data.sessionCode,
      eventType: 'Study Completed',
      details: 'Duration: ' + (data.totalDuration || 0) + ' min, Device: ' + (data.deviceType || ''),
      timestamp: data.timestamp
    });
  });
}

// ===============================
// Sheet utilities
// ===============================
// Robust parse -> ms since epoch or null (accepts Date, ISO, seconds/ms epoch-like)
function parseTsMs_(v) {
  if (!v && v !== 0) return null;
  if (v instanceof Date) return v.getTime();
  var s = String(v).trim();

  // ISO-ish string
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  // Pure number? try epoch
  var n = Number(s);
  if (isFinite(n)) {
    if (n > 1e12) return n;           // ms epoch
    if (n >= 1e9 && n <= 2e10) return n * 1000; // s epoch
  }
  return null;
}

// Get earliest + latest timestamps we can trust for a session
function computeSessionWindowMs_(ss, sessionCode) {
  var s = ss.getSheetByName('Sessions');
  var p = ss.getSheetByName('Task Progress');
  var e = ss.getSheetByName('Session Events');

  var minMs = null, maxMs = null;

  // Sessions row fields
  var row = findRowBySessionCode_(s, sessionCode);
  if (row) {
    var created = parseTsMs_(getByHeader_(s, row, 'Created Date'));
    var lastAct = parseTsMs_(getByHeader_(s, row, 'Last Activity'));
    if (created != null) minMs = (minMs == null) ? created : Math.min(minMs, created);
    if (lastAct  != null) maxMs = (maxMs == null) ? lastAct  : Math.max(maxMs, lastAct);
  }

  // Task Progress
  if (p && p.getLastRow() > 1) {
    var lastRow = p.getLastRow();
    var pv = p.getRange(1,1,lastRow,15).getValues(); // only used columns
    for (var i = 1; i < pv.length; i++) {
      if (pv[i][1] !== sessionCode) continue;
      var t0 = parseTsMs_(pv[i][0]); // row timestamp
      var st = parseTsMs_(pv[i][6]);
      var et = parseTsMs_(pv[i][7]);
      [t0, st, et].forEach(function(ms){
        if (ms != null) {
          if (minMs == null || ms < minMs) minMs = ms;
          if (maxMs == null || ms > maxMs) maxMs = ms;
        }
      });
    }
  }

  // Session Events
  if (e && e.getLastRow() > 1) {
    var lastRowE = e.getLastRow();
    var ev = e.getRange(1,1,lastRowE,6).getValues();
    for (var j = 1; j < ev.length; j++) {
      if (ev[j][1] !== sessionCode) continue;
      var ms = parseTsMs_(ev[j][0]);
      if (ms != null) {
        if (minMs == null || ms < minMs) minMs = ms;
        if (maxMs == null || ms > maxMs) maxMs = ms;
      }
    }
  }

  // Fallbacks
  var now = Date.now();
  if (minMs == null) minMs = now;
  if (maxMs == null) maxMs = minMs;

  // Never allow negative window
  if (maxMs < minMs) maxMs = minMs;

  return { startMs: minMs, endMs: maxMs };
}

function updateSessionActivity(ss, sessionCode, timestamp) {
  var sheet = ss.getSheetByName('Sessions');
  if (!sheet) return;
  var row = findRowBySessionCode_(sheet, sessionCode);
  if (!row) return;
  setByHeader_(sheet, row, 'Last Activity', timestamp);
}

function updateTotalTime(ss, sessionCode) {
  withDocLock_(function () {
    var s = ss.getSheetByName('Sessions');
    if (!s) return;
    var row = findRowBySessionCode_(s, sessionCode);
    if (!row) return;

    // 1) Rebuild session window from all logs
    var win = computeSessionWindowMs_(ss, sessionCode);
    var totalSecByWindow = Math.max(0, Math.round((win.endMs - win.startMs) / 1000));

    // 2) Sum ACTIVE seconds from Task Progress
      var p = ss.getSheetByName('Task Progress');
      var activeSec = 0;
      var inactiveSec = 0;
      if (p && p.getLastRow() > 1) {
        var lastRow = p.getLastRow();
        var pv = p.getRange(1,1,lastRow,15).getValues();
        for (var i = 1; i < pv.length; i++) {
          if (pv[i][1] !== sessionCode) continue;
          var act = Number(pv[i][9]) || 0;  // Active Time (sec)
          var inact = Number(pv[i][12]) || 0;  // Inactive Time (sec)
          if (act > 0) activeSec += act;
          if (inact > 0) inactiveSec += inact;
        }
      }

      // 3) Include paused time from Sessions sheet and derive idle
      var pausedMinExisting = Number(getByHeader_(s, row, 'Paused Time (min)')) || 0;
      var pausedSec = pausedMinExisting * 60;

      // Then idle is what's left
      var idleSec = Math.max(0, totalSecByWindow - activeSec - pausedSec - inactiveSec);

    // 4) Write minutes
    var totalMin = Math.round(totalSecByWindow / 60);
    var activeMin = Math.round(activeSec / 60);
    var idleMin = Math.round(idleSec / 60);
    var pausedMin = Math.round(pausedSec / 60);

    setManyByHeader_(s, row, {
      'Total Time (min)': totalMin,
      'Active Time (min)': activeMin,
      'Idle Time (min)': idleMin,
      'Paused Time (min)': pausedMin
    });

    // 5) Self-heal Created Date & Last Activity if bad
    var createdCell = getByHeader_(s, row, 'Created Date');
    var lastCell    = getByHeader_(s, row, 'Last Activity');

    var fixes = {};
    if (parseTsMs_(createdCell) == null) {
      fixes['Created Date'] = new Date(win.startMs).toISOString();
    }
    if (parseTsMs_(lastCell) == null || parseTsMs_(lastCell) < win.endMs) {
      fixes['Last Activity'] = new Date(win.endMs).toISOString();
    }
    if (Object.keys(fixes).length) {
      setManyByHeader_(s, row, fixes);
    }
  });
}

function normalizeTaskName_(name) {
  var map = {
    'Reading Comprehension (RC)': 'Reading Comprehension Task',
    'RC': 'Reading Comprehension Task',
    'MRT': 'Mental Rotation Task',
    'Virtual Campus': 'Virtual Campus Navigation',
    'Spatial Nav': 'Spatial Navigation',
    'Image Desc': 'Image Description'
  };
  return map[name] || name;
}

function getRequiredTasksForSession_(ss, sessionCode) {
  var sessionsSheet = ss.getSheetByName('Sessions');
  var rows = sessionsSheet.getDataRange().getValues();
  var headers = rows[0].map(function (v) { return String(v || ''); });
  var map = {};
  for (var i = 0; i < headers.length; i++) map[headers[i]] = i;

  var deviceType = 'Desktop';
  var consentStatus = '';
  for (var r = 1; r < rows.length; r++) {
    if (rows[r][0] === sessionCode) {
      if (map['Device Type'] != null) deviceType = rows[r][map['Device Type']] || 'Desktop';
      if (map['Consent Status'] != null) consentStatus = rows[r][map['Consent Status']] || '';
      break;
    }
  }
  var isMobile = String(deviceType).toLowerCase().indexOf('mobile') !== -1;

  var required = [
    'Reading Comprehension Task',
    'Mental Rotation Task',
    'ASL Comprehension Test',
    'Spatial Navigation',
    // 'Image Description', temporarily disabled
    'Demographics Survey'
  ];
  if (!isMobile) required.splice(3, 0, 'Virtual Campus Navigation');

  // Image Description task is disabled; consent filtering not needed

  var progress = ss.getSheetByName('Task Progress').getDataRange().getValues();
  var aslctOptional = false;
  for (var i = 1; i < progress.length; i++) {
    if (progress[i][1] === sessionCode &&
        progress[i][4] === 'ASL Comprehension Test' &&
        progress[i][5] === 'Skipped') {
      var details = String(progress[i][14] || '').toLowerCase();
      if (details.indexOf('does not know asl') !== -1) {
        aslctOptional = true;
        break;
      }
    }
  }
  if (aslctOptional) {
    required = required.filter(function (t) { return t !== 'ASL Comprehension Test'; });
  }

  return required.map(normalizeTaskName_);
}

function updateCompletedTasksCount(ss, sessionCode) {
  withDocLock_(function () {
    var required = getRequiredTasksForSession_(ss, sessionCode);
    var requiredSet = {};
    for (var k = 0; k < required.length; k++) {
      requiredSet[normalizeTaskName_(required[k])] = true;
    }

    var progress = ss.getSheetByName('Task Progress').getDataRange().getValues();
    var completedSet = {};

    for (var i = 1; i < progress.length; i++) {
      if (progress[i][1] !== sessionCode) continue;

      var eventType = progress[i][5];
      var taskName  = normalizeTaskName_(progress[i][4]);

      var isCompleted = (eventType === 'Completed' || eventType === 'Skipped');

      if (isCompleted && requiredSet[taskName]) {
        completedSet[taskName] = true;
      }
    }

    var completedCount = Object.keys(completedSet).length;
    var requiredTotal = Object.keys(requiredSet).length;

    var s = ss.getSheetByName('Sessions');
    if (!s) return;
    var row = findRowBySessionCode_(s, sessionCode);
    if (!row) return;

    var hmap = headerMap_(s);
    if (hmap['Tasks Completed']) {
      s.getRange(row, hmap['Tasks Completed']).setNumberFormat('@');
    }
    setManyByHeader_(s, row, {
      'Tasks Completed': completedCount + '/' + requiredTotal,
      'Status': completedCount === requiredTotal ? 'Complete' : 'Active'
    });
  });
}

function repairAllSessionCounts() {
  return withDocLock_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sessionsSheet = ss.getSheetByName('Sessions');
    var data = sessionsSheet.getDataRange().getValues();

    var repaired = 0;
    for (var i = 1; i < data.length; i++) {
      var sessionCode = data[i][0];
      if (sessionCode) {
        updateCompletedTasksCount(ss, sessionCode);
        repaired++;
      }
    }

    SpreadsheetApp.getUi().alert('Repaired ' + repaired + ' sessions');
    return repaired;
  });
}

function viewSessionActivity() {
  var ui = SpreadsheetApp.getUi();
  var code = ui.prompt('Enter session code:').getResponseText();
  if (!code) return;

  var summary = getSessionActivitySummary(code);
  var output = 'Session: ' + code + '\n\n';
  output += 'Tasks Started: ' + summary.startedCount + '\n';
  output += 'Tasks Completed: ' + summary.completedCount + '\n';
  output += 'Total Duration: ' + Math.round(summary.totalDuration / 60) + ' minutes\n\n';

  output += 'Task Details:\n';
  for (var task in summary.tasks) {
    var t = summary.tasks[task];
    output += '- ' + task + ': ';
    output += t.completed ? 'COMPLETED' : (t.started ? 'STARTED' : 'NOT STARTED');
    if (t.duration) output += ' (' + t.duration + 's)';
    output += '\n';
  }

  ui.alert('Session Activity', output, ui.ButtonSet.OK);
}

// ===============================
// Logging & lookups
// ===============================
function logSessionEvent(ss, ev) {
  try {
    var sheet = ss.getSheetByName('Session Events');
    sheet.appendRow([
      ev.timestamp || new Date(),
      ev.sessionCode || '',
      ev.eventType || '',
      ev.details || '',
      ev.ip || '',
      ev.userAgent || ''
    ]);
  } catch (e) {
    handleError(e);
  }
}

function logEvent(ss, data) {
  logSessionEvent(ss, {
    sessionCode: data.sessionCode || '',
    eventType: data.action || 'event',
    details: JSON.stringify(data),
    timestamp: data.timestamp || new Date().toISOString(),
    userAgent: data.userAgent || ''
  });
}

function getSessionData(ss, sessionCode) {
  if (!sessionCode) return createCorsOutput({ success: false, error: 'Missing sessionCode' });

  sessionCode = String(sessionCode).trim().toUpperCase();

  var sheet = ss.getSheetByName('Sessions');
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function (v) { return String(v || ''); });
  var map = {};
  for (var i = 0; i < headers.length; i++) map[headers[i]] = i;

  for (var r = 1; r < data.length; r++) {
    if (data[r][0] === sessionCode) {
      var activitySummary = getSessionActivitySummary(sessionCode);
      var activityTracking = getSessionActivityTracking(sessionCode);
      var stateRaw = map['State JSON'] != null ? data[r][map['State JSON']] : '';
      var c2 = false;
      var vDeclined = false;
      if (stateRaw) {
        try {
          var parsed = JSON.parse(stateRaw);
          if (typeof parsed === 'string') parsed = JSON.parse(parsed);
          var cs = parsed.consentStatus || {};
          c2 = !!cs.consent2;
          vDeclined = !!cs.videoDeclined;
        } catch (e) {}
      }
      return createCorsOutput({
        success: true,
        session: {
          sessionCode: data[r][0],
          participantID: map['Participant ID'] != null ? data[r][map['Participant ID']] : '',
          email: map['Email'] != null ? data[r][map['Email']] : '',
          created: map['Created Date'] != null ? data[r][map['Created Date']] : '',
          lastActivity: map['Last Activity'] != null ? data[r][map['Last Activity']] : '',
          totalTimeMin: map['Total Time (min)'] != null ? data[r][map['Total Time (min)']] : '',
          activeTimeMin: map['Active Time (min)'] != null ? data[r][map['Active Time (min)']] : '',
          pausedTimeMin: map['Paused Time (min)'] != null ? data[r][map['Paused Time (min)']] : '',
          tasksCompleted: map['Tasks Completed'] != null ? data[r][map['Tasks Completed']] : '',
          status: map['Status'] != null ? data[r][map['Status']] : '',
          deviceType: map['Device Type'] != null ? data[r][map['Device Type']] : '',
          consentStatus: map['Consent Status'] != null ? data[r][map['Consent Status']] : '',
          consent2: c2,
          videoDeclined: vDeclined,
          state: stateRaw
        },
        activity_tracking: activityTracking,
        activity_summary: activitySummary
      });
    }
  }
  return createCorsOutput({ success: false, error: 'Not found' });
}

// ===============================
// Enhanced video logging
// ===============================
function logVideoEvent(data) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Video Tracking') || ss.insertSheet('Video Tracking');

    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, 15).setValues([[
        'Timestamp','Session Code','Image Number','Filename','File ID','File URL','File Size (KB)','Upload Time','Upload Method','External Service','Cloudinary Public ID','Video Format','MIME Type','Upload Status','Error Message'
      ]]);
      formatHeaders(sheet, 15);
    }

    sheet.appendRow([
      new Date(),
      data.sessionCode || '',
      data.imageNumber || '',
      data.filename || '',
      data.fileId || '',
      data.fileUrl || '',
      data.fileSize || 0,
      data.uploadTime || data.timestamp || new Date().toISOString(),
      data.uploadMethod || 'unknown',
      data.externalService || determineServiceFromMethod(data.uploadMethod),
      data.cloudinaryPublicId || '',
      data.videoFormat || '',
      data.mimeType || '',
      data.uploadStatus || 'success',
      data.error || ''
    ]);
  } catch (e) {
    handleError(e, true);
  }
}
/**
 * Enhanced video upload logging with external service tracking
 */
function logVideoUpload(data) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Video Tracking') || ss.insertSheet('Video Tracking');

    // Ensure all columns exist (including new ones)
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, 15).setValues([[
        'Timestamp',
        'Session Code',
        'Image Number',
        'Filename',
        'File ID',
        'File URL',
        'File Size (KB)',
        'Upload Time',
        'Upload Method',
        'External Service',
        'Cloudinary Public ID',
        'Video Format',
        'MIME Type',
        'Upload Status',
        'Error Message'
      ]]);
      formatHeaders(sheet, 15);
    }

    // Convert file size to KB for logging
    var fileSizeKB = data.fileSize ? data.fileSize / 1024 : 0;

    // Prepare row data
    var rowData = [
      new Date(),
      data.sessionCode || '',
      data.imageNumber || '',
      data.filename || '',
      data.fileId || '',
      data.fileUrl || '',
      fileSizeKB,
      data.uploadTime || new Date().toISOString(),
      data.uploadMethod || 'unknown',
      data.externalService || determineServiceFromMethod(data.uploadMethod),
      data.cloudinaryPublicId || '',
      data.videoFormat || '',
      data.mimeType || '',
      data.uploadStatus || 'success',
      data.error || ''
    ];

    sheet.appendRow(rowData);

    // Log success metrics using KB
    data.fileSize = fileSizeKB;
    logUploadMetrics(data);
  } catch (e) {
    handleError(e);
  }
}

/**
 * Helper to determine service from upload method
 */
function determineServiceFromMethod(method) {
  var methodMap = {
    'cloudinary': 'Cloudinary',
    'google_drive': 'Google Drive',
    'google_drive_fallback': 'Google Drive (Fallback)',
    'local_only': 'Local Storage Only',
    'external': 'External Service'
  };
  return methodMap[method] || 'Unknown';
}

/**
 * Track upload success metrics
 */
function logUploadMetrics(data) {
  try {
    var props = PropertiesService.getScriptProperties();
    
    // Get current metrics
    var metrics = JSON.parse(props.getProperty('UPLOAD_METRICS') || '{}');
    
    // Initialize if needed
    if (!metrics[data.uploadMethod]) {
      metrics[data.uploadMethod] = { success: 0, failed: 0, totalSize: 0 };
    }
    
    // Update metrics
    if (data.uploadStatus === 'success') {
      metrics[data.uploadMethod].success++;
      metrics[data.uploadMethod].totalSize += (data.fileSize || 0);
    } else {
      metrics[data.uploadMethod].failed++;
    }
    
    // Save updated metrics
    props.setProperty('UPLOAD_METRICS', JSON.stringify(metrics));
    
  } catch (e) {
    console.warn('Could not update metrics:', e);
  }
}
function logVideoUploadError(ss, data) {
  data.uploadStatus = 'error';
  data.uploadMethod = data.attemptedMethod || data.uploadMethod || 'unknown';
  logVideoEvent(data);
}

// ===============================
// EEG columns + consent verify
// ===============================
function ensureEEGColumns_(ss) {
  return withDocLock_(function () {
    var sheet = ss.getSheetByName('Sessions');
    if (!sheet) return null;
    var lastCol = sheet.getLastColumn();
    if (lastCol < 1) return null;

    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (v) { return String(v || ''); });

    function ensureHeader_(name) {
      var idx = headers.indexOf(name);
      if (idx !== -1) return idx + 1;
      var newCol = sheet.getLastColumn() + 1;
      sheet.insertColumnAfter(sheet.getLastColumn());
      sheet.getRange(1, newCol).setValue(name)
        .setFontWeight('bold')
        .setBackground('#f1f3f4');
      clearHeaderCache_();
      headers.push(name);
      return newCol;
    }

    return {
      status: ensureHeader_('EEG Status'),
      when: ensureHeader_('EEG Scheduled At'),
      source: ensureHeader_('EEG Scheduling Source')
    };
  });
}

function setEEGStatus_(ss, sessionCode, status, scheduledAt, source, note) {
  if (!sessionCode || sessionCode === 'none') return;
  withDocLock_(function () {
    var sheet = ss.getSheetByName('Sessions');
    if (!sheet) return;
    var eegCols = ensureEEGColumns_(ss);
    if (!eegCols) return;

    var row = findRowBySessionCode_(sheet, sessionCode);
    if (!row) return;

    setManyByHeader_(sheet, row, {
      'EEG Status': status || getByHeader_(sheet, row, 'EEG Status'),
      'EEG Scheduled At': scheduledAt || getByHeader_(sheet, row, 'EEG Scheduled At'),
      'EEG Scheduling Source': source || getByHeader_(sheet, row, 'EEG Scheduling Source')
    });
  });
}

function ensureConsentColumns_(ss) {
  return withDocLock_(function () {
    var sheet = ss.getSheetByName('Sessions');
    if (!sheet) return null;

    var lastCol = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (v) { return String(v || ''); });

    function ensureHeader_(name) {
      var idx = headers.indexOf(name);
      if (idx !== -1) return idx + 1;
      var newCol = sheet.getLastColumn() + 1;
      sheet.insertColumnAfter(sheet.getLastColumn());
      sheet.getRange(1, newCol).setValue(name)
           .setFontWeight('bold').setBackground('#f1f3f4');
      clearHeaderCache_();
      headers.push(name);
      return newCol;
    }

    return {
      status: ensureHeader_('Consent Status'),
      src: ensureHeader_('Consent Source'),
      code: ensureHeader_('Consent Code'),
      when: ensureHeader_('Consent Timestamp')
    };
  });
}

function setConsentVerify_(ss, sessionCode, which, status, source, codeSuffix, ts) {
  if (!sessionCode || sessionCode === 'none') return;
  withDocLock_(function () {
    var sheet = ss.getSheetByName('Sessions');
    if (!sheet) return;
    var cols = ensureConsentColumns_(ss);

    var row = findRowBySessionCode_(sheet, sessionCode);
    if (!row) return;

    var kv = {
      'Consent Status': status || 'Verified',
      'Consent Source': source || ''
    };
    if (codeSuffix) kv['Consent Code'] = codeSuffix;
    kv['Consent Timestamp'] = ts || new Date().toISOString();

    setManyByHeader_(sheet, row, kv);
  });
}

// ===============================
// Diagnostics / utilities
// ===============================
function quickDiagnostic() {
  var ok = true;
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    console.log('Spreadsheet:', ss.getName());
  } catch (e) { ok = false; console.error(e); }

  try {
    var tmp = DriveApp.createFolder('DIAG_' + Date.now());
    tmp.setTrashed(true);
  } catch (e2) { ok = false; console.error(e2); }

  return ok;
}

function sendEEGReminderEmails() {
  return withDocLock_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Email Reminders');
    if (!sheet) return;
    var rows = sheet.getDataRange().getValues();

    // Property-driven one-shot date, e.g., '2025-09-27'
    var openDate = PropertiesService.getScriptProperties().getProperty('EEG_OPEN_DATE'); 
    if (!openDate) return;

    var today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
    if (today !== openDate) return;

    var link = 'https://calendly.com/action-brain-lab-gallaudet/spatial-cognition-eeg-only';

    for (var i = 1; i < rows.length; i++) {
      var status = rows[i][4];
      var email = rows[i][1];
      if (status === 'EEG Reminder Requested' && email) {
        MailApp.sendEmail(email,
          'EEG scheduling now open',
          'Scheduling for EEG sessions has reopened. You can now choose your time here: ' + link + '\n\nThank you!');
        sheet.getRange(i + 1, 3).setValue(new Date());
        sheet.getRange(i + 1, 4).setValue((rows[i][3] || 0) + 1);
        sheet.getRange(i + 1, 5).setValue('EEG Reminder Sent');
      }
    }

    // Clear the property so it does not fire again
    PropertiesService.getScriptProperties().deleteProperty('EEG_OPEN_DATE');
  });
}

function repairAllSessionTimes() {
  return withDocLock_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var s = ss.getSheetByName('Sessions');
    if (!s || s.getLastRow() < 2) return 0;
    enforceColumnFormats_(ss);

    var vals = s.getDataRange().getValues();
    var fixed = 0;
    for (var r = 1; r < vals.length; r++) {
      var code = vals[r][0];
      if (!code) continue;
      updateTotalTime(ss, code);
      updateCompletedTasksCount(ss, code);
      fixed++;
    }
    SpreadsheetApp.getUi().alert('Recomputed times for ' + fixed + ' sessions.');
    return fixed;
  });
}

function testVideoUpload() {
  var testData = 'dGVzdCB2aWRlbyBkYXRh'; // "test video data" in base64

  var result = handleVideoUpload({
    action: 'upload_video',
    sessionCode: 'TEST' + new Date().getTime(),
    imageNumber: 1,
    videoData: testData
  });

  console.log('Test result:', JSON.stringify(result));
  SpreadsheetApp.getUi().alert('Test result: ' + JSON.stringify(result));
}

// ---- Menu
function safeSetupOrMigrate() { return safeSetupOrMigrate_(); }
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Study Admin')
    .addItem('Normalize Sessions sheet', 'normalizeSessionsSheet')
    .addItem('Repair session times', 'repairAllSessionTimes')
    .addItem('Safe setup / migrate', 'safeSetupOrMigrate')
    .addItem('Test video upload', 'testVideoUpload')
    .addItem('Repair task counts', 'repairAllSessionCounts')
    .addItem('Test activity summary', 'testActivitySummary')
    .addItem('View session activity', 'viewSessionActivity')
    .addItem('Repair sessions (formats + values)', 'repairCorruptedSessionCells')
    .addSeparator()
    .addItem('Housekeeping → Inventory & clean (safe)', 'housekeepingSafeClean')
    .addItem('Housekeeping → Hide task raw sheets', 'hideTaskRawSheets')
    .addItem('Housekeeping → Unhide ALL sheets', 'unhideAllSheets')
    .addSeparator()
    .addItem('Migrate Video Tracking (Run Once)', 'migrateVideoTrackingSheet')
    .addItem('View Upload Metrics', 'showUploadMetrics')
    .addToUi();
}

// ===============================
// Formats, timestamp normalizer, device detect, repairer
// ===============================
function enforceColumnFormats_(ss) {
  var sh = ss.getSheetByName('Sessions');
  if (!sh) return;
  var map = headerMap_(sh);
  var nRows = Math.max(1, sh.getMaxRows() - 1);

  function fmt(h, format) {
    if (map[h]) sh.getRange(2, map[h], nRows).setNumberFormat(format);
  }

  // Force text where Sheets loves to "help"
  ['Tasks Completed','Status','Device Type','Consent Status','Consent Source','Consent Code',
   'EEG Status','EEG Scheduling Source','Hearing Status','Fluency','Email']
    .forEach(function(h){ fmt(h, '@'); });

  // ISO-like timestamps (24h clock)
  ['Created Date','Last Activity','Consent Timestamp','EEG Scheduled At']
    .forEach(function(h){ fmt(h, 'yyyy-mm-dd"T"HH:mm:ss.000"Z"'); });

  // Plain integers
  ['Total Time (min)','Active Time (min)','Idle Time (min)','Paused Time (min)']
    .forEach(function(h){ fmt(h, '0'); });
}

function normalizeIso_(val) {
  if (!val) return new Date().toISOString();
  if (val instanceof Date) return val.toISOString();

  var s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;

  var n = Number(s);
  if (!isNaN(n) && isFinite(n)) {
    if (n > 1e12) return new Date(n).toISOString();
    if (n > 1e9)  return new Date(n * 1000).toISOString();
  }
  return new Date().toISOString();
}

function detectDeviceType_(data) {
  var raw = (data.deviceType || '').toString();
  var ua  = (data.userAgent || '').toString();
  var mobile = /mobile|tablet/i.test(raw) || /Android|iPhone|iPad|Mobile/i.test(ua);
  return { label: mobile ? 'Mobile/Tablet' : 'Desktop', isMobile: mobile };
}

function repairCorruptedSessionCells() {
  return withDocLock_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('Sessions');
    if (!sh) return;

    enforceColumnFormats_(ss);

    var map = headerMap_(sh);
    var lastRow = sh.getLastRow();
    for (var r = 2; r <= lastRow; r++) {
      var code = map['Session Code'] ? sh.getRange(r, map['Session Code']).getValue() : '';
      if (!code) continue;

      // Fix Created Date if not ISO-ish
      if (map['Created Date']) {
        var cd = sh.getRange(r, map['Created Date']).getValue();
        var cdStr = cd instanceof Date ? cd.toISOString() : String(cd || '');
        if (!/^\d{4}-\d{2}-\d{2}T/.test(cdStr)) {
          var la = map['Last Activity'] ? sh.getRange(r, map['Last Activity']).getValue() : '';
          var use = la ? normalizeIso_(la) : new Date().toISOString();
          sh.getRange(r, map['Created Date']).setNumberFormat('@').setValue(use);
        }
      }

      // Recompute times and tasks
      updateTotalTime(ss, code);
      updateCompletedTasksCount(ss, code);

      // If Status is numeric/blank, set from tasks
      if (map['Status']) {
        var status = sh.getRange(r, map['Status']).getValue();
        if (!status || typeof status === 'number') {
          var tc = map['Tasks Completed'] ? String(sh.getRange(r, map['Tasks Completed']).getValue() || '') : '';
          var parts = tc.split('/');
          var st = (parts.length === 2 && Number(parts[0]) === Number(parts[1])) ? 'Complete' : 'Active';
          sh.getRange(r, map['Status']).setValue(st);
        }
      }

      // If Device Type is blank/garbled, default from State JSON
      if (map['Device Type']) {
        var dt = sh.getRange(r, map['Device Type']).getValue();
        var looksBad = (dt instanceof Date) || (typeof dt === 'number') || /AM|PM/.test(String(dt));
        if (!dt || looksBad) {
          var state = map['State JSON'] ? String(sh.getRange(r, map['State JSON']).getValue() || '') : '';
          var isMobile = /"isMobile"\s*:\s*true/i.test(state);
          sh.getRange(r, map['Device Type']).setValue(isMobile ? 'Mobile/Tablet' : 'Desktop');
        }
      }

      // Default Consent Status if missing
      if (map['Consent Status']) {
        var cs = sh.getRange(r, map['Consent Status']).getValue();
        if (!cs) sh.getRange(r, map['Consent Status']).setValue('Pending');
      }
    }

    enforceColumnFormats_(ss);
    SpreadsheetApp.getUi().alert('Repair complete 👍');
  });
}

/**************
 * HOUSEKEEPING MODULE
 * - Inventory all sheets
 * - Consolidate old video logs into "Video Tracking"
 * - Hide/Archive deprecated or duplicate/empty sheets
 * - Keep RC/MRT/Spatial Navigation raw sheets (hidden)
 **************/

var HOUSEKEEPING_CONFIG = {
  mustKeep: [
    'Sessions','Task Progress','Session Events',
    'Video Tracking','Email Reminders',
    'Scores Summary','ASLCT Scores','RC Scores',
    'Dashboard'
  ],
  taskRawRegex: /^(RC|MRT|Spatial\s*Navigation)/i,
  deprecatedNames: [
    'Video_Uploads','Video_Upload_Errors','Sessions__normalized__tmp',
    'Events','Logs','tmp','test','Sheet1'
  ],
  neverDeleteRegex: [/^Sessions__backup_/i],
  archivePrefix: 'zzz_ARCHIVE_',
  deleteIfTrulyEmpty: true
};


// ---------- Inventory helpers ----------
function listSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var all = ss.getSheets();
  return all.map(function(sh){
    var name = sh.getName();
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    var isHidden = sh.isSheetHidden();
    var looksRawTask = HOUSEKEEPING_CONFIG.taskRawRegex.test(name);
    var isDeprecated = HOUSEKEEPING_CONFIG.deprecatedNames.indexOf(name) !== -1;
    var isMustKeep = HOUSEKEEPING_CONFIG.mustKeep.indexOf(name) !== -1;
    var neverDelete = HOUSEKEEPING_CONFIG.neverDeleteRegex.some(function(rx){return rx.test(name);});
    return {
      name: name,
      lastRow: lastRow,
      lastCol: lastCol,
      isHidden: isHidden,
      looksRawTask: looksRawTask,
      isDeprecated: isDeprecated,
      isMustKeep: isMustKeep,
      neverDelete: neverDelete
    };
  });
}

function sheetIsTrulyEmpty_(sheet) {
  var lr = sheet.getLastRow();
  var lc = sheet.getLastColumn();
  if (lr === 0 || lc === 0) return true;
  if (lr > 1) return false; // has data rows
  // lr === 1 → check if header row is actually blank
  var vals = sheet.getRange(1,1,1,lc).getValues()[0];
  var any = vals.some(function(v){ return String(v||'').trim() !== ''; });
  return !any;
}


// ---------- Consolidation of legacy video logs ----------
function consolidateVideoSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  // If your main script already migrates, calling this is harmless (idempotent).
  if (typeof migrateVideoSheets_ === 'function') {
    migrateVideoSheets_(ss);
    return 'migrated via migrateVideoSheets_()';
  }

  // Fallback: copy rows manually if migrateVideoSheets_ doesn't exist
  var tracking = ss.getSheetByName('Video Tracking') || ss.insertSheet('Video Tracking');
  if (tracking.getLastRow() === 0) {
    tracking.getRange(1,1,1,11).setValues([[
      'Timestamp','Session Code','Image Number','Filename','File ID','File URL',
      'File Size (KB)','Upload Time','Upload Method','Upload Status','Error Message'
    ]]);
  }

  var moved = 0;
  ['Video_Uploads','Video_Upload_Errors'].forEach(function(oldName){
    var old = ss.getSheetByName(oldName);
    if (!old) return;
    var data = old.getDataRange().getValues();
    if (data.length > 1) {
      // Normalize columns if needed
      for (var r = 1; r < data.length; r++) {
        var row = data[r];
        if (oldName === 'Video_Upload_Errors') {
          tracking.appendRow([
            row[0], row[1], row[2], '', '', '', '', row[4] || '', row[5] || '',
            '', 'error', row[3] || ''
          ]);
        } else {
          tracking.appendRow(row.concat(Array(Math.max(0,12-row.length)).fill('')).slice(0,12));
        }
        moved++;
      }
    }
    // rename & hide old sheet rather than delete
    if (old.getName().indexOf(HOUSEKEEPING_CONFIG.archivePrefix) !== 0) {
      old.setName(HOUSEKEEPING_CONFIG.archivePrefix + old.getName());
    }
    old.hideSheet();
  });

  return 'moved ' + moved + ' rows';
}


// ---------- Decide what to do with each sheet ----------
function planHousekeeping_() {
  var rows = listSheets_();
  return rows.map(function(info){
    var action = 'keep';
    var notes = [];

    if (info.isMustKeep) {
      action = 'keep';
    } else if (info.neverDelete) {
      action = 'hide';
      notes.push('never-delete pattern');
    } else if (info.looksRawTask) {
      action = 'hide';
      notes.push('raw task sheet');
    } else if (info.isDeprecated) {
      if (HOUSEKEEPING_CONFIG.deleteIfTrulyEmpty) {
        var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(info.name);
        if (sh && sheetIsTrulyEmpty_(sh)) {
          action = 'delete';
          notes.push('deprecated & empty');
        } else {
          action = 'archive';
          notes.push('deprecated, archiving');
        }
      } else {
        action = 'archive';
        notes.push('deprecated, archiving');
      }
    } else if (/^Copy of /i.test(info.name) || /\(\d+\)$/.test(info.name)) {
      var sh2 = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(info.name);
      if (sh2 && sheetIsTrulyEmpty_(sh2)) {
        action = 'delete';
        notes.push('duplicate & empty');
      } else {
        action = 'archive';
        notes.push('duplicate, archiving');
      }
    } else if (/^Sheet\d*$/.test(info.name)) {
      var sh3 = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(info.name);
      if (sh3 && sheetIsTrulyEmpty_(sh3)) {
        action = 'delete';
        notes.push('unused default & empty');
      } else {
        action = 'hide';
        notes.push('unused default');
      }
    } else {
      action = 'keep';
    }

    if (info.name === 'Housekeeping Report') {
      action = 'keep';
      notes.push('this report');
    }

    return {
      name: info.name,
      lastRow: info.lastRow,
      visible: !info.isHidden,
      action: action,
      notes: notes.join('; ')
    };
  });
}


// ---------- Execute plan (safe) ----------
function housekeepingSafeClean() {
  return withDocLock_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // Always consolidate video legacy sheets first
    var consolidation = consolidateVideoSheets_();

    var plan = planHousekeeping_();
    var log = [];
    plan.forEach(function(item){
      var sh = ss.getSheetByName(item.name);
      if (!sh) return;

      if (HOUSEKEEPING_CONFIG.mustKeep.indexOf(item.name) !== -1 || item.name === 'Housekeeping Report') {
        sh.showSheet();
        log.push([item.name, 'keep', sh.getLastRow(), item.notes || '']);
        return;
      }

      switch (item.action) {
        case 'keep':
          sh.showSheet();
          log.push([item.name, 'keep', sh.getLastRow(), item.notes || '']);
          break;

        case 'hide':
          sh.hideSheet();
          log.push([item.name, 'hide', sh.getLastRow(), item.notes || '']);
          break;

        case 'archive':
          if (sh.getName().indexOf(HOUSEKEEPING_CONFIG.archivePrefix) !== 0) {
            sh.setName(HOUSEKEEPING_CONFIG.archivePrefix + sh.getName());
          }
          sh.hideSheet();
          log.push([item.name, 'archive+hide', sh.getLastRow(), item.notes || '']);
          break;

        case 'delete':
          if (sheetIsTrulyEmpty_(sh)) {
            ss.deleteSheet(sh);
            log.push([item.name, 'deleted', 0, item.notes || '']);
          } else {
            if (sh.getName().indexOf(HOUSEKEEPING_CONFIG.archivePrefix) !== 0) {
              sh.setName(HOUSEKEEPING_CONFIG.archivePrefix + sh.getName());
            }
            sh.hideSheet();
            log.push([item.name, 'archive+hide (was not empty)', sh.getLastRow(), item.notes || '']);
          }
          break;
      }
    });

    // Write report
    createOrReplaceHousekeepingReport_(log, consolidation);

    SpreadsheetApp.getUi().alert('Housekeeping complete. See "Housekeeping Report".');
  });
}


// ---------- Report ----------
function createOrReplaceHousekeepingReport_(rows, consolidationNote) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Housekeeping Report');
  if (sh) ss.deleteSheet(sh);
  sh = ss.insertSheet('Housekeeping Report');
  sh.getRange(1,1,1,4).setValues([['Sheet Name','Action','Last Row','Notes']]);
  if (rows && rows.length) {
    sh.getRange(2,1,rows.length,4).setValues(rows);
  }
  sh.autoResizeColumns(1,4);
  sh.getRange('A1:D1').setFontWeight('bold').setBackground('#f1f3f4');
  if (consolidationNote) {
    sh.getRange(1,6).setValue('Video consolidation: ' + consolidationNote);
  }
}


// ---------- Quick utilities ----------
function hideTaskRawSheets() {
  return withDocLock_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    ss.getSheets().forEach(function(sh){
      if (HOUSEKEEPING_CONFIG.taskRawRegex.test(sh.getName())) {
        sh.hideSheet();
      }
    });
    SpreadsheetApp.getUi().alert('Task raw sheets hidden.');
  });
}

function unhideAllSheets() {
  return withDocLock_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    ss.getSheets().forEach(function(sh){ sh.showSheet(); });
    SpreadsheetApp.getUi().alert('All sheets unhidden.');
  });
}

// ===============================
// Debug helper bundle
// ===============================
function debugSmokeTests_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1) Setup
  safeSetupOrMigrate_();

  // 2) Create a session
  createSession(ss, {
    sessionCode: 'TEST_' + Date.now(),
    participantID: 'P_TEST',
    email: 'test@example.com',
    timestamp: new Date().toISOString(),
    userAgent: 'UnitTest',
    deviceType: 'Desktop'
  });

  // 3) Start and complete a task
  var code = getByHeader_(ss.getSheetByName('Sessions'), 2, 'Session Code');
  logTaskStart(ss, { sessionCode: code, timestamp: new Date().toISOString(), task: 'Reading Comprehension Task', userAgent: 'UnitTest', deviceType: 'Desktop' });
  logTaskComplete(ss, { sessionCode: code, timestamp: new Date().toISOString(), task: 'Reading Comprehension Task', elapsed: 120, active: 100, userAgent: 'UnitTest', deviceType: 'Desktop' });

  // 4) Totals
  updateTotalTime(ss, code);
  updateCompletedTasksCount(ss, code);
  SpreadsheetApp.getUi().alert('Smoke tests passed for ' + code);
}

function quickTimeAdjustment() {
  // Reduces all active times by 30% and increases idle accordingly
  // This is a rough correction based on the overcounting issue
  
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Sessions');
  var data = sheet.getDataRange().getValues();
  
  // Add backup columns if not exist
  if (data[0].indexOf('Original Active Time (min)') === -1) {
    sheet.insertColumnAfter(sheet.getLastColumn());
    sheet.getRange(1, sheet.getLastColumn()).setValue('Original Active Time (min)');
    sheet.insertColumnAfter(sheet.getLastColumn());
    sheet.getRange(1, sheet.getLastColumn()).setValue('Quick Fix Applied');
  }
  
  for (var i = 1; i < data.length; i++) {
    var activeCol = data[0].indexOf('Active Time (min)');
    var idleCol = data[0].indexOf('Idle Time (min)');
    
    if (activeCol === -1 || idleCol === -1) continue;
    
    var currentActive = data[i][activeCol];
    var currentIdle = data[i][idleCol];
    
    // Store original
    sheet.getRange(i + 1, sheet.getLastColumn() - 1).setValue(currentActive);
    
    // Apply 30% reduction to active time
    var newActive = Math.round(currentActive * 0.7);
    var difference = currentActive - newActive;
    var newIdle = currentIdle + difference;
    
    sheet.getRange(i + 1, activeCol + 1).setValue(newActive);
    sheet.getRange(i + 1, idleCol + 1).setValue(newIdle);
    sheet.getRange(i + 1, sheet.getLastColumn()).setValue(new Date().toISOString());
  }
  
  SpreadsheetApp.getUi().alert('Applied quick 30% correction to active times');
}

/**
 * One-time migration to add new tracking columns
 * Run this ONCE via the menu after updating the code
 */
function migrateVideoTrackingSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Video Tracking');
  if (!sheet) return;
  
  // Check if migration needed (look for new columns)
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.indexOf('External Service') > -1) {
    SpreadsheetApp.getUi().alert('Migration already completed.');
    return;
  }
  
  // Add new columns
  var lastCol = sheet.getLastColumn();
  var newHeaders = ['External Service', 'Cloudinary Public ID', 'Video Format', 'MIME Type'];
  
  sheet.getRange(1, lastCol + 1, 1, newHeaders.length).setValues([newHeaders]);
  
  // Format new headers
  sheet.getRange(1, lastCol + 1, 1, newHeaders.length)
    .setFontWeight('bold')
    .setBackground('#f1f3f4');
  
  // Update existing rows based on upload method
  var dataRange = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn());
  var data = dataRange.getValues();
  
  for (var i = 0; i < data.length; i++) {
    var uploadMethod = data[i][8]; // Upload Method column
    
    // Determine external service
    var service = determineServiceFromMethod(uploadMethod);
    
    // Set the service in the new column
    sheet.getRange(i + 2, lastCol + 1).setValue(service);
  }
  
  SpreadsheetApp.getUi().alert('Migration completed! Added ' + newHeaders.length + ' new tracking columns.');
}

/**
 * Display upload metrics in a popup
 */
function showUploadMetrics() {
  try {
    var props = PropertiesService.getScriptProperties();
    var metrics = JSON.parse(props.getProperty('UPLOAD_METRICS') || '{}');
    
    var output = 'UPLOAD METRICS\n' + '='.repeat(30) + '\n\n';
    
    for (var method in metrics) {
      var m = metrics[method];
      var successRate = m.success + m.failed > 0 ? 
        (m.success / (m.success + m.failed) * 100).toFixed(1) : 0;
      
      output += method.toUpperCase() + ':\n';
      output += '  Success: ' + m.success + '\n';
      output += '  Failed: ' + m.failed + '\n';
      output += '  Success Rate: ' + successRate + '%\n';
      output += '  Total Size: ' + (m.totalSize / 1024).toFixed(1) + ' MB\n\n';
    }
    
    SpreadsheetApp.getUi().alert('Upload Metrics', output, SpreadsheetApp.getUi().ButtonSet.OK);
    
  } catch (e) {
    SpreadsheetApp.getUi().alert('No metrics available yet.');
  }
}

/**
 * Test the new Cloudinary metadata logging
 */
function testCloudinaryMetadataLogging() {
  var testData = {
    action: 'log_video_upload',
    sessionCode: 'TEST_CLOUDINARY_' + Date.now(),
    imageNumber: 1,
    filename: 'test_video.webm',
    fileId: 'cloudinary_public_id_123',
    fileUrl: 'https://res.cloudinary.com/test/video/upload/test.webm',
    fileSize: 2048,
    uploadTime: new Date().toISOString(),
    uploadMethod: 'cloudinary',
    publicId: 'spatial-cognition-videos/test_video',
    videoFormat: 'webm',
    mimeType: 'video/webm',
    uploadStatus: 'success'
  };
  
  // Simulate the doPost handler
  var result = doPost({
    postData: {
      contents: JSON.stringify(testData)
    }
  });
  
  var response = JSON.parse(result.getContent());
  
  if (response.success) {
    SpreadsheetApp.getUi().alert('Test successful! Check Video Tracking sheet for the new entry.');
  } else {
    SpreadsheetApp.getUi().alert('Test failed: ' + response.error);
  }
}
