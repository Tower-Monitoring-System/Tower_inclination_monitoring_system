var REQUIRED_HEADERS = Object.freeze(["Date", "Time", "X", "Y", "Z", "Battery"]);
var MAXIMUM_ROWS = 20000;
var SENSOR_READ_CHUNK_ROWS = 20000;
var TELEMETRY_ACTION = "appendTelemetry";
var TELEMETRY_BATCH_ACTION = "appendTelemetryBatch";
var TELEMETRY_BATCH_MIN_RECORDS = 3;
var TELEMETRY_BATCH_MAX_RECORDS = 32;
var TELEMETRY_TOWER_ID = "TWR-01";
var TELEMETRY_NODE_ID = 1;
var DEDUP_SHEET_NAME = "__TELEMETRY_DEDUP";
var DEDUP_HEADERS = Object.freeze(["Key", "Status", "TargetRow", "Fingerprint", "CreatedAt"]);
// Fire-and-Forget co the tao nhieu Web App execution cung luc. Cho lock du lau
// de request khong bi mat chi vi Master khong doc response BUSY.
var TELEMETRY_LOCK_TIMEOUT_MS = 120000;
var TELEMETRY_SERVICE_VERSION = "tower-telemetry-v8-latest-history";

var EMAILJS_API_URL = "https://api.emailjs.com/api/v1.0/email/send";
var EMAIL_ALERT_ENABLED_PROPERTY = "EMAIL_ALERT_ENABLED";
var EMAILJS_SERVICE_ID_PROPERTY = "EMAILJS_SERVICE_ID";
var EMAILJS_TEMPLATE_ID_PROPERTY = "EMAILJS_TEMPLATE_ID";
var EMAILJS_PUBLIC_KEY_PROPERTY = "EMAILJS_PUBLIC_KEY";
var EMAILJS_PRIVATE_KEY_PROPERTY = "EMAILJS_PRIVATE_KEY";
var EMAIL_ALERT_TO_PROPERTY = "ALERT_EMAIL_TO";
var ALERT_EMAIL_RECHECK_MINUTES_PROPERTY = "ALERT_EMAIL_RECHECK_MINUTES";

var ALERT_INITIAL_X_PROPERTY = "ALERT_INITIAL_X";
var ALERT_INITIAL_Y_PROPERTY = "ALERT_INITIAL_Y";
var ALERT_INITIAL_Z_PROPERTY = "ALERT_INITIAL_Z";
var ALERT_TILT_X_PROPERTY = "ALERT_TILT_X";
var ALERT_TILT_Y_PROPERTY = "ALERT_TILT_Y";
var ALERT_TILT_Z_PROPERTY = "ALERT_TILT_Z";
var ALERT_BATTERY_WARNING_PROPERTY = "ALERT_BATTERY_WARNING";
var ALERT_BATTERY_CRITICAL_PROPERTY = "ALERT_BATTERY_CRITICAL";

var ALERT_ENGINE_STATE_PROPERTY = "TOWER_ALERT_ENGINE_STATE_V1";
var ALERT_EMAIL_QUEUE_PROPERTY = "TOWER_ALERT_EMAIL_QUEUE_V1";

var ALERT_AVERAGE_WINDOW_SIZE = 3;
var ALERT_MAXIMUM_WINDOW_GAP_MS = 90 * 60 * 1000;
var ALERT_CRITICAL_MULTIPLIER = 1.5;
var ALERT_RECENT_MESSAGE_ID_LIMIT = 96;
var ALERT_EMAIL_QUEUE_LIMIT = 2;
var ALERT_EMAIL_SEND_LEASE_MS = 60 * 1000;
var ALERT_EMAIL_DEFAULT_RECHECK_MINUTES = 60;
var ALERT_EMAIL_RETRY_BASE_MS = 60 * 1000;
var ALERT_EMAIL_RETRY_MAX_MS = 15 * 60 * 1000;
var ALERT_EMAIL_FETCH_TIMEOUT_SECONDS = 15;

// Mo URL /exec bang trinh duyet de kiem tra dung deployment va cau hinh.
// Khong tra ve shared secret hay Spreadsheet ID.
function doGet() {
  var status = {
    ok: false,
    service: TELEMETRY_SERVICE_VERSION,
    towerId: TELEMETRY_TOWER_ID,
    nodeId: TELEMETRY_NODE_ID,
    secretConfigured: false,
    sheetConfigured: false,
    towerSheetFound: false,
    headersValid: false,
    emailAlertsEnabled: false,
    emailJsConfigured: false
  };

  try {
    var properties = PropertiesService.getScriptProperties();
    var expectedToken = properties.getProperty("SENSOR_DATA_SHARED_SECRET");
    var sheetId = properties.getProperty("SENSOR_SHEET_ID");
    status.secretConfigured = Boolean(expectedToken);
    status.sheetConfigured = Boolean(sheetId);
    var emailConfig = getEmailAlertConfig_(properties);
    status.emailAlertsEnabled = emailConfig.enabled;
    status.emailJsConfigured = emailConfig.configured;
    status.emailRecheckMinutes = emailConfig.recheckMinutes;

    if (sheetId) {
      var spreadsheet = SpreadsheetApp.openById(sheetId);
      var sheet = spreadsheet.getSheetByName(TELEMETRY_TOWER_ID);
      status.towerSheetFound = Boolean(sheet);
      status.headersValid = Boolean(sheet && hasFixedTelemetryHeaders_(sheet));
    }
    status.ok = status.secretConfigured && status.sheetConfigured &&
      status.towerSheetFound && status.headersValid;
    return jsonResponse_(status);
  } catch (error) {
    status.errorCode = "HEALTH_CHECK_FAILED";
    status.error = String(error && error.message ? error.message : error);
    return jsonResponse_(status);
  }
}

// Chay mot lan trong Apps Script editor sau khi da dat Script Property
// SENSOR_DATA_SHARED_SECRET. Neu script duoc bind voi Sheet, ham tu luu ID;
// neu la standalone script, dat SENSOR_SHEET_ID truoc khi chay.
function setupTelemetryService() {
  var properties = PropertiesService.getScriptProperties();
  if (!properties.getProperty("SENSOR_DATA_SHARED_SECRET")) {
    throw new Error("Set Script Property SENSOR_DATA_SHARED_SECRET first.");
  }

  var sheetId = properties.getProperty("SENSOR_SHEET_ID");
  var spreadsheet = sheetId
    ? SpreadsheetApp.openById(sheetId)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error("Set Script Property SENSOR_SHEET_ID for a standalone script.");
  }

  properties.setProperty("SENSOR_SHEET_ID", spreadsheet.getId());
  properties.setProperty("SENSOR_SHEET_NAME", TELEMETRY_TOWER_ID);
  var sheet = spreadsheet.getSheetByName(TELEMETRY_TOWER_ID);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(TELEMETRY_TOWER_ID);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, REQUIRED_HEADERS.length)
      .setValues([REQUIRED_HEADERS.slice()]);
    sheet.setFrozenRows(1);
  } else if (!hasFixedTelemetryHeaders_(sheet)) {
    throw new Error("TWR-01 columns A:F must be Date, Time, X, Y, Z, Battery.");
  }
  getOrCreateDedupSheet_(spreadsheet);

  var result = {
    ok: true,
    service: TELEMETRY_SERVICE_VERSION,
    towerId: TELEMETRY_TOWER_ID,
    nodeId: TELEMETRY_NODE_ID
  };
  console.log(JSON.stringify(result));
  return result;
}

function doPost(event) {
  try {
    var properties = PropertiesService.getScriptProperties();
    var expectedToken = properties.getProperty("SENSOR_DATA_SHARED_SECRET");
    var sheetId = properties.getProperty("SENSOR_SHEET_ID");
    var fallbackSheetName = properties.getProperty("SENSOR_SHEET_NAME") || "";

    if (!expectedToken || !sheetId) {
      return jsonResponse_({
        ok: false,
        errorCode: "CONFIG_NOT_SET",
        error: "Service is not configured."
      });
    }

    var request = parseRequest_(event);
    if (!request || !safeEqual_(request.token, expectedToken)) {
      return jsonResponse_({
        ok: false,
        errorCode: "UNAUTHORIZED",
        error: "Unauthorized request."
      });
    }

    if (request.action === TELEMETRY_ACTION) {
      return appendTelemetry_(request, sheetId);
    }
    if (request.action === TELEMETRY_BATCH_ACTION) {
      return appendTelemetryBatch_(request, sheetId);
    }

    var requestedTower = resolveRequestedTower_(request);
    if (!requestedTower.valid) {
      return jsonResponse_({
        ok: false,
        errorCode: "INVALID_TOWER_ID",
        error: requestedTower.error
      });
    }

    var spreadsheet = SpreadsheetApp.openById(sheetId);
    var sheet = requestedTower.provided
      ? spreadsheet.getSheetByName(requestedTower.value)
      : fallbackSheetName
        ? spreadsheet.getSheetByName(fallbackSheetName)
        : spreadsheet.getSheets()[0];
    if (!sheet) {
      return requestedTower.provided
        ? jsonResponse_({
            ok: false,
            errorCode: "SHEET_NOT_FOUND",
            error: "No Google Sheet found for Tower " + requestedTower.value + "."
          })
        : jsonResponse_({ ok: false, errorCode: "SHEET_UNAVAILABLE", error: "Sensor sheet is unavailable." });
    }

    var resolvedTowerId = requestedTower.provided ? requestedTower.value : sheet.getName();

    var lastRow = sheet.getLastRow();
    var lastColumn = sheet.getLastColumn();
    if (lastRow < 1 || lastColumn < 1) {
      return jsonResponse_({
        ok: true,
        data: [],
        meta: { received: 0, accepted: 0, rejected: 0, truncated: false, towerId: resolvedTowerId }
      });
    }

    var indexes = resolveHeaderIndexes_(sheet.getRange(1, 1, 1, lastColumn).getValues()[0]);
    if (!indexes) {
      return jsonResponse_({
        ok: false,
        errorCode: "INVALID_SHEET_HEADERS",
        error: "Required sensor columns are missing in Google Sheet " + resolvedTowerId + "."
      });
    }

    var timeZone = spreadsheet.getSpreadsheetTimeZone() || Session.getScriptTimeZone() || "Asia/Ho_Chi_Minh";
    var snapshot = loadLatestSensorRows_(sheet, lastRow, indexes, timeZone);

    return jsonResponse_({
      ok: true,
      data: snapshot.data,
      meta: {
        received: snapshot.validRows + snapshot.rejected,
        accepted: snapshot.data.length,
        rejected: snapshot.rejected,
        omitted: snapshot.validRows - snapshot.data.length,
        truncated: snapshot.truncated,
        towerId: resolvedTowerId
      }
    });
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    return jsonResponse_({
      ok: false,
      errorCode: "INTERNAL_ERROR",
      error: "Sensor data is temporarily unavailable."
    });
  }
}

function loadLatestSensorRows_(sheet, lastRow, indexes, timeZone) {
  var columns = REQUIRED_HEADERS.map(function (header) { return indexes[header]; });
  var firstColumn = Math.min.apply(null, columns);
  var lastColumn = Math.max.apply(null, columns);
  var readIndexes = {};
  REQUIRED_HEADERS.forEach(function (header) { readIndexes[header] = indexes[header] - firstColumn; });
  var newest = new Map();
  // A min heap holds only the newest MAXIMUM_ROWS timestamps. Scanning all
  // chunks handles reused blanks/imports without retaining the whole Sheet.
  var timestamps = [];
  var validRows = 0;
  var rejected = 0;
  var truncated = false;
  for (var startRow = 2; startRow <= lastRow; startRow += SENSOR_READ_CHUNK_ROWS) {
    var rowCount = Math.min(SENSOR_READ_CHUNK_ROWS, lastRow - startRow + 1);
    var values = sheet.getRange(startRow, firstColumn + 1, rowCount, lastColumn - firstColumn + 1).getValues();
    for (var rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
      if (isBlankRow_(values[rowIndex], readIndexes)) continue;
      var normalized = normalizeRow_(values[rowIndex], readIndexes, timeZone);
      if (!normalized) {
        rejected += 1;
        continue;
      }
      validRows += 1;
      var timestamp = normalized.Date + " " + normalized.Time;
      if (newest.has(timestamp)) {
        // Match browser/reminder behavior: the last valid physical duplicate wins.
        newest.set(timestamp, normalized);
      } else if (timestamps.length < MAXIMUM_ROWS) {
        newest.set(timestamp, normalized);
        var position = timestamps.length;
        timestamps.push(timestamp);
        while (position > 0) {
          var parent = Math.floor((position - 1) / 2);
          if (timestamps[parent] <= timestamp) break;
          timestamps[position] = timestamps[parent];
          position = parent;
        }
        timestamps[position] = timestamp;
      } else if (timestamp > timestamps[0]) {
        truncated = true;
        newest.delete(timestamps[0]);
        newest.set(timestamp, normalized);
        var position = 0;
        while (position * 2 + 1 < timestamps.length) {
          var child = position * 2 + 1;
          if (child + 1 < timestamps.length && timestamps[child + 1] < timestamps[child]) child += 1;
          if (timestamp <= timestamps[child]) break;
          timestamps[position] = timestamps[child];
          position = child;
        }
        timestamps[position] = timestamp;
      } else {
        // The timestamp is absent from the retained set and the set is full.
        // Duplicate replacements above never imply missing history.
        truncated = true;
      }
    }
  }
  return {
    data: timestamps.sort().map(function (timestamp) { return newest.get(timestamp); }),
    validRows: validRows,
    rejected: rejected,
    truncated: truncated
  };
}

function appendTelemetry_(request, sheetId) {
  var validation = validateTelemetryRequest_(request);
  if (!validation.valid) {
    return telemetryErrorResponse_(
      validation.errorCode,
      validation.error,
      request
    );
  }

  // Mo va kiem tra Sheet truoc khi lay lock de rut ngan critical section.
  var spreadsheet = SpreadsheetApp.openById(sheetId);
  var sheet = spreadsheet.getSheetByName(TELEMETRY_TOWER_ID);
  if (!sheet) {
    return telemetryErrorResponse_(
      "SHEET_NOT_FOUND",
      "Google Sheet TWR-01 was not found.",
      validation.telemetry
    );
  }

  if (!hasFixedTelemetryHeaders_(sheet)) {
    return telemetryErrorResponse_(
      "INVALID_SHEET_HEADERS",
      "TWR-01 columns A:F must be Date, Time, X, Y, Z, Battery.",
      validation.telemetry
    );
  }

  var timeZone = spreadsheet.getSpreadsheetTimeZone() ||
    Session.getScriptTimeZone() || "Asia/Ho_Chi_Minh";
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(TELEMETRY_LOCK_TIMEOUT_MS)) {
    return telemetryErrorResponse_(
      "LOCK_TIMEOUT",
      "Telemetry service could not acquire the write lock.",
      validation.telemetry
    );
  }

  var response;
  try {
    var dedupSheet = getOrCreateDedupSheet_(spreadsheet);
    response = appendTelemetryIdempotently_(
      sheet,
      dedupSheet,
      validation.telemetry,
      timeZone
    );

    // Alert evaluation is local/persistent only: no external HTTP call while
    // the telemetry ScriptLock is held. Duplicate Message IDs are filtered by
    // the alert engine so they cannot distort the 3-sample average.
    if (textOutputIsOk_(response)) {
      try {
        processTelemetryForEmailAlerts_(validation.telemetry);
      } catch (alertError) {
        console.error("[ALERT][PROCESS] " +
          String(alertError && alertError.stack ? alertError.stack : alertError));
      }
    }
  } finally {
    lock.releaseLock();
  }

  // EmailJS is called after releasing the telemetry lock so a slow mail
  // provider cannot block LoRa -> Apps Script telemetry writes.
  try {
    deliverNextPendingEmailAlert_();
  } catch (emailError) {
    console.error("[ALERT][EMAIL] " +
      String(emailError && emailError.stack ? emailError.stack : emailError));
  }
  return response;
}

function appendTelemetryBatch_(request, sheetId) {
  var validation = validateTelemetryBatchRequest_(request);
  if (!validation.valid) {
    return telemetryErrorResponse_(
      validation.errorCode,
      validation.error,
      validation.context || request
    );
  }

  // Spreadsheet, telemetry sheet and dedup sheet are each opened once. The
  // one ScriptLock below covers the complete two-phase batch transaction.
  var spreadsheet = SpreadsheetApp.openById(sheetId);
  var sheet = spreadsheet.getSheetByName(TELEMETRY_TOWER_ID);
  if (!sheet) {
    return telemetryErrorResponse_(
      "SHEET_NOT_FOUND",
      "Google Sheet TWR-01 was not found.",
      validation.telemetry[0]
    );
  }
  if (!hasFixedTelemetryHeaders_(sheet)) {
    return telemetryErrorResponse_(
      "INVALID_SHEET_HEADERS",
      "TWR-01 columns A:F must be Date, Time, X, Y, Z, Battery.",
      validation.telemetry[0]
    );
  }

  var timeZone = spreadsheet.getSpreadsheetTimeZone() ||
    Session.getScriptTimeZone() || "Asia/Ho_Chi_Minh";
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(TELEMETRY_LOCK_TIMEOUT_MS)) {
    return telemetryErrorResponse_(
      "LOCK_TIMEOUT",
      "Telemetry service could not acquire the batch write lock.",
      validation.telemetry[0]
    );
  }

  var response;
  try {
    var dedupSheet = getOrCreateDedupSheet_(spreadsheet);
    response = appendTelemetryBatchIdempotently_(
      sheet,
      dedupSheet,
      validation.telemetry,
      timeZone
    );

    if (textOutputIsOk_(response)) {
      try {
        processTelemetryBatchForEmailAlerts_(validation.telemetry);
      } catch (alertError) {
        console.error("[ALERT][PROCESS][BATCH] " +
          String(alertError && alertError.stack ? alertError.stack : alertError));
      }
    }
  } finally {
    lock.releaseLock();
  }

  try {
    deliverNextPendingEmailAlert_();
  } catch (emailError) {
    console.error("[ALERT][EMAIL][BATCH] " +
      String(emailError && emailError.stack ? emailError.stack : emailError));
  }
  return response;
}

function validateTelemetryRequest_(request) {
  if (request.towerId !== TELEMETRY_TOWER_ID) {
    return invalidTelemetry_("INVALID_TOWER_ID", "Only towerId TWR-01 is accepted.");
  }

  var nodeId = normalizeInteger_(request.nodeId, 1, 65535);
  if (nodeId !== TELEMETRY_NODE_ID) {
    return invalidTelemetry_("INVALID_NODE_ID", "Only Node 1 is accepted for TWR-01.");
  }

  var messageId = normalizeMessageId_(request.messageId);
  if (messageId === null) {
    return invalidTelemetry_("INVALID_MESSAGE_ID", "Message ID must be an unsigned 32-bit integer greater than zero.");
  }

  var date = normalizeDate_(request.date, "Asia/Ho_Chi_Minh");
  var time = normalizeTime_(request.time, "Asia/Ho_Chi_Minh");
  if (date === null || time === null) {
    return invalidTelemetry_("INVALID_SAMPLE_TIME", "Valid date and time are required.");
  }

  var x = normalizeNumber_(request.x, -180, 180);
  var y = normalizeNumber_(request.y, -180, 180);
  var z = normalizeNumber_(request.z, -180, 180);
  var battery = normalizeNumber_(request.battery, 0, 24);
  if (x === null || y === null || z === null || battery === null) {
    return invalidTelemetry_("INVALID_TELEMETRY", "X, Y, Z or Battery is invalid.");
  }

  var temperature = null;
  if (request.temp !== null && request.temp !== undefined && request.temp !== "") {
    temperature = normalizeNumber_(request.temp, -100, 200);
    if (temperature === null) {
      return invalidTelemetry_("INVALID_TEMPERATURE", "Temperature is invalid.");
    }
  }

  if (request.sampleTimestamp !== undefined && request.sampleTimestamp !== null) {
    var timestamp = normalizeInteger_(request.sampleTimestamp, 1, 4102444800);
    if (timestamp === null) {
      return invalidTelemetry_("INVALID_TIMESTAMP", "Sample timestamp is invalid.");
    }
  }

  return {
    valid: true,
    telemetry: {
      towerId: TELEMETRY_TOWER_ID,
      nodeId: nodeId,
      messageId: messageId,
      date: date,
      time: time,
      x: x,
      y: y,
      z: z,
      battery: battery,
      temp: temperature
    }
  };
}

function validateTelemetryBatchRequest_(request) {
  if (request.towerId !== TELEMETRY_TOWER_ID) {
    return invalidTelemetry_("INVALID_TOWER_ID", "Only towerId TWR-01 is accepted.");
  }

  var nodeId = normalizeInteger_(request.nodeId, 1, 65535);
  if (nodeId !== TELEMETRY_NODE_ID) {
    return invalidTelemetry_("INVALID_NODE_ID", "Only Node 1 is accepted for TWR-01.");
  }
  if (!Array.isArray(request.records)) {
    return invalidTelemetry_("INVALID_BATCH_RECORDS", "Batch records must be an array.");
  }
  if (request.records.length < TELEMETRY_BATCH_MIN_RECORDS ||
      request.records.length > TELEMETRY_BATCH_MAX_RECORDS) {
    return invalidTelemetry_(
      "INVALID_BATCH_SIZE",
      "A telemetry batch must contain from 3 to 32 records."
    );
  }

  var telemetry = [];
  for (var index = 0; index < request.records.length; index += 1) {
    var record = request.records[index];
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return {
        valid: false,
        errorCode: "INVALID_BATCH_RECORD",
        error: "Batch record " + index + " must be an object.",
        context: request
      };
    }

    // Reuse exactly the single-record validation rules by combining the
    // common tower/node fields with this record's telemetry fields.
    var recordValidation = validateTelemetryRequest_({
      towerId: request.towerId,
      nodeId: request.nodeId,
      messageId: record.messageId,
      sampleTimestamp: record.sampleTimestamp,
      date: record.date,
      time: record.time,
      x: record.x,
      y: record.y,
      z: record.z,
      battery: record.battery,
      temp: record.temp,
      validFlags: record.validFlags
    });
    if (!recordValidation.valid) {
      return {
        valid: false,
        errorCode: recordValidation.errorCode,
        error: "Batch record " + index + ": " + recordValidation.error,
        context: {
          towerId: request.towerId,
          nodeId: request.nodeId,
          messageId: record.messageId
        }
      };
    }
    telemetry.push(recordValidation.telemetry);
  }

  return { valid: true, telemetry: telemetry };
}

function invalidTelemetry_(errorCode, error) {
  return { valid: false, errorCode: errorCode, error: error };
}

function normalizeInteger_(value, minimum, maximum) {
  var number = typeof value === "number" ? value : Number(String(value || "").trim());
  return isFinite(number) && Math.floor(number) === number && number >= minimum && number <= maximum
    ? number
    : null;
}

function normalizeMessageId_(value) {
  var text = String(value === undefined || value === null ? "" : value).trim();
  if (!/^\d{1,10}$/.test(text)) {
    return null;
  }
  var number = Number(text);
  return number >= 1 && number <= 4294967295 && Math.floor(number) === number
    ? String(number)
    : null;
}

function hasFixedTelemetryHeaders_(sheet) {
  if (sheet.getLastRow() < 1 || sheet.getMaxColumns() < REQUIRED_HEADERS.length) {
    return false;
  }
  var headers = sheet.getRange(1, 1, 1, REQUIRED_HEADERS.length).getDisplayValues()[0];
  return REQUIRED_HEADERS.every(function (requiredHeader, index) {
    return String(headers[index]).trim().toLowerCase() === requiredHeader.toLowerCase();
  });
}

function getOrCreateDedupSheet_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(DEDUP_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(DEDUP_SHEET_NAME);
    sheet.getRange(1, 1, 1, DEDUP_HEADERS.length).setValues([DEDUP_HEADERS.slice()]);
    sheet.setFrozenRows(1);
  } else {
    var headers = sheet.getRange(1, 1, 1, DEDUP_HEADERS.length).getDisplayValues()[0];
    var headersValid = DEDUP_HEADERS.every(function (header, index) {
      return String(headers[index]).trim() === header;
    });
    if (!headersValid) {
      throw new Error("Dedup sheet headers are invalid.");
    }
  }

  if (!sheet.isSheetHidden()) {
    sheet.hideSheet();
  }
  return sheet;
}

function appendTelemetryIdempotently_(sheet, dedupSheet, telemetry, timeZone) {
  var key = telemetry.towerId + "|" + telemetry.messageId;
  var fingerprint = telemetryFingerprint_(telemetry);
  var dedupRow = findDedupRow_(dedupSheet, key);

  if (dedupRow !== null) {
    var dedupValues = dedupSheet.getRange(dedupRow, 1, 1, DEDUP_HEADERS.length).getValues()[0];
    if (String(dedupValues[3]) !== fingerprint) {
      return telemetryErrorResponse_(
        "MESSAGE_ID_CONFLICT",
        "This Message ID already exists with a different payload.",
        telemetry
      );
    }

    var status = String(dedupValues[1]);
    var targetRow = normalizeInteger_(dedupValues[2], 2, sheet.getMaxRows());
    if ((status !== "PENDING" && status !== "COMMITTED") || targetRow === null) {
      return telemetryErrorResponse_(
        "DEDUP_STATE_INVALID",
        "Stored deduplication state is invalid.",
        telemetry
      );
    }

    var rowValues = sheet.getRange(targetRow, 1, 1, REQUIRED_HEADERS.length).getValues()[0];
    var rowWasPresent = !isBlankTelemetryRow_(rowValues);
    if (rowWasPresent && !telemetryRowMatches_(rowValues, telemetry, timeZone)) {
      return telemetryErrorResponse_(
        "DEDUP_TARGET_CONFLICT",
        "The reserved telemetry row contains different data.",
        telemetry
      );
    }

    var needsFlush = false;
    if (!rowWasPresent) {
      sheet.getRange(targetRow, 1, 1, REQUIRED_HEADERS.length).setValues([telemetrySheetRow_(telemetry)]);
      needsFlush = true;
    }
    if (status !== "COMMITTED") {
      dedupSheet.getRange(dedupRow, 2).setValue("COMMITTED");
      needsFlush = true;
    }
    if (needsFlush) {
      SpreadsheetApp.flush();
    }

    return telemetryAcceptedResponse_(telemetry, status === "COMMITTED" || rowWasPresent);
  }

  var targetRow = nextTelemetryTargetRow_(sheet, dedupSheet);
  var dedupTargetRow = dedupSheet.getLastRow() + 1;
  ensureSheetRowExists_(sheet, targetRow);
  ensureSheetRowExists_(dedupSheet, dedupTargetRow);
  dedupSheet.getRange(dedupTargetRow, 1, 1, DEDUP_HEADERS.length).setValues([[
    key,
    "PENDING",
    targetRow,
    fingerprint,
    new Date()
  ]]);
  SpreadsheetApp.flush();

  sheet.getRange(targetRow, 1, 1, REQUIRED_HEADERS.length).setValues([telemetrySheetRow_(telemetry)]);
  dedupSheet.getRange(dedupTargetRow, 2).setValue("COMMITTED");
  SpreadsheetApp.flush();
  return telemetryAcceptedResponse_(telemetry, false);
}

function appendTelemetryBatchIdempotently_(sheet, dedupSheet, telemetryList, timeZone) {
  var dedupLastRow = dedupSheet.getLastRow();
  var dedupValues = dedupLastRow >= 2
    ? dedupSheet.getRange(2, 1, dedupLastRow - 1, DEDUP_HEADERS.length).getValues()
    : [];
  var dedupByKey = Object.create(null);
  var reservationsByTarget = Object.create(null);
  var maximumSheetRow = sheet.getMaxRows();

  dedupValues.forEach(function (values, index) {
    var key = String(values[0] || "");
    var targetRow = normalizeInteger_(values[2], 2, maximumSheetRow);
    var entry = {
      key: key,
      status: String(values[1]),
      targetRow: targetRow,
      fingerprint: String(values[3]),
      dedupRow: index + 2
    };
    if (key && !Object.prototype.hasOwnProperty.call(dedupByKey, key)) {
      dedupByKey[key] = entry;
    }
    if (targetRow !== null) {
      var targetKey = String(targetRow);
      if (!Object.prototype.hasOwnProperty.call(reservationsByTarget, targetKey)) {
        reservationsByTarget[targetKey] = [];
      }
      reservationsByTarget[targetKey].push(entry);
    }
  });

  // One A:F read is enough to validate all existing dedup targets and find
  // reusable blank rows for every new Message ID.
  var lastSheetRow = Math.max(1, sheet.getLastRow());
  var telemetryRows = lastSheetRow >= 2
    ? sheet.getRange(2, 1, lastSheetRow - 1, REQUIRED_HEADERS.length).getValues()
    : [];
  var plans = [];
  var plansByKey = Object.create(null);
  var claimedTargets = Object.create(null);

  for (var index = 0; index < telemetryList.length; index += 1) {
    var telemetry = telemetryList[index];
    var key = telemetry.towerId + "|" + telemetry.messageId;
    var fingerprint = telemetryFingerprint_(telemetry);
    if (Object.prototype.hasOwnProperty.call(plansByKey, key)) {
      if (plansByKey[key].fingerprint !== fingerprint) {
        return telemetryErrorResponse_(
          "MESSAGE_ID_CONFLICT",
          "A batch contains the same Message ID with different payloads.",
          telemetry
        );
      }
      continue;
    }

    var existing = Object.prototype.hasOwnProperty.call(dedupByKey, key)
      ? dedupByKey[key]
      : null;
    var plan = {
      key: key,
      fingerprint: fingerprint,
      telemetry: telemetry,
      isNew: existing === null,
      dedupRow: null,
      targetRow: null,
      needsRow: false,
      needsCommit: false
    };

    if (existing !== null) {
      if (existing.fingerprint !== fingerprint) {
        return telemetryErrorResponse_(
          "MESSAGE_ID_CONFLICT",
          "This Message ID already exists with a different payload.",
          telemetry
        );
      }
      if ((existing.status !== "PENDING" && existing.status !== "COMMITTED") ||
          existing.targetRow === null) {
        return telemetryErrorResponse_(
          "DEDUP_STATE_INVALID",
          "Stored deduplication state is invalid.",
          telemetry
        );
      }

      var rowValues = telemetryRowValuesForBatch_(
        telemetryRows,
        lastSheetRow,
        existing.targetRow
      );
      var rowWasPresent = !isBlankTelemetryRow_(rowValues);
      if (rowWasPresent && !telemetryRowMatches_(rowValues, telemetry, timeZone)) {
        return telemetryErrorResponse_(
          "DEDUP_TARGET_CONFLICT",
          "The reserved telemetry row contains different data.",
          telemetry
        );
      }

      var claimedKey = String(existing.targetRow);
      if (Object.prototype.hasOwnProperty.call(claimedTargets, claimedKey) &&
          claimedTargets[claimedKey] !== key) {
        return telemetryErrorResponse_(
          "DEDUP_TARGET_CONFLICT",
          "Multiple Message IDs reserve the same telemetry row.",
          telemetry
        );
      }
      claimedTargets[claimedKey] = key;
      plan.dedupRow = existing.dedupRow;
      plan.targetRow = existing.targetRow;
      plan.needsRow = !rowWasPresent;
      plan.needsCommit = existing.status !== "COMMITTED";
    }

    plans.push(plan);
    plansByKey[key] = plan;
  }

  var staleDedupRows = Object.create(null);
  var newPlans = [];
  var candidateRow = 2;
  plans.forEach(function (plan) {
    if (!plan.isNew) {
      return;
    }

    while (true) {
      var candidateKey = String(candidateRow);
      if (Object.prototype.hasOwnProperty.call(claimedTargets, candidateKey) ||
          !isBlankTelemetryRow_(
            telemetryRowValuesForBatch_(telemetryRows, lastSheetRow, candidateRow)
          )) {
        candidateRow += 1;
        continue;
      }

      var reservations = reservationsByTarget[candidateKey] || [];
      var hasPendingReservation = false;
      var committedReservations = [];
      for (var reservationIndex = 0;
           reservationIndex < reservations.length;
           reservationIndex += 1) {
        var reservation = reservations[reservationIndex];
        if (reservation.status === "PENDING") {
          hasPendingReservation = true;
          break;
        }
        if (reservation.status === "COMMITTED") {
          committedReservations.push(reservation.dedupRow);
          continue;
        }
        throw new Error("Dedup state is invalid for target row " + candidateRow + ".");
      }
      if (hasPendingReservation) {
        candidateRow += 1;
        continue;
      }

      committedReservations.forEach(function (dedupRow) {
        staleDedupRows[String(dedupRow)] = dedupRow;
      });
      plan.targetRow = candidateRow;
      plan.needsRow = true;
      plan.needsCommit = true;
      claimedTargets[candidateKey] = plan.key;
      newPlans.push(plan);
      candidateRow += 1;
      break;
    }
  });

  newPlans.forEach(function (plan, index) {
    plan.dedupRow = dedupLastRow + index + 1;
  });

  var maximumTargetRow = plans.reduce(function (maximum, plan) {
    return Math.max(maximum, plan.targetRow || 1);
  }, 1);
  ensureSheetRowExists_(sheet, maximumTargetRow);

  // Phase 1: reserve every new Message ID as PENDING, then flush once. A
  // retry can safely recover any request interrupted after this boundary.
  if (newPlans.length > 0) {
    ensureSheetRowExists_(dedupSheet, dedupLastRow + newPlans.length);
    clearDedupRows_(dedupSheet, Object.keys(staleDedupRows).map(function (key) {
      return staleDedupRows[key];
    }));
    dedupSheet
      .getRange(dedupLastRow + 1, 1, newPlans.length, DEDUP_HEADERS.length)
      .setValues(newPlans.map(function (plan) {
        return [
          plan.key,
          "PENDING",
          plan.targetRow,
          plan.fingerprint,
          new Date()
        ];
      }));
    SpreadsheetApp.flush();
  }

  // Phase 2: write all missing telemetry rows in FIFO plan order, mark every
  // PENDING reservation COMMITTED, and flush once for the whole batch.
  var rowWritePlans = plans.filter(function (plan) {
    return plan.needsRow;
  });
  writeTelemetryBatchRows_(sheet, rowWritePlans);

  var commitRows = plans.filter(function (plan) {
    return plan.needsCommit;
  }).map(function (plan) {
    return plan.dedupRow;
  });
  writeCommittedDedupRows_(dedupSheet, commitRows);
  if (rowWritePlans.length > 0 || commitRows.length > 0) {
    SpreadsheetApp.flush();
  }

  return jsonResponse_({
    ok: true,
    towerId: TELEMETRY_TOWER_ID,
    nodeId: TELEMETRY_NODE_ID,
    accepted: telemetryList.length,
    unique: plans.length,
    duplicate: telemetryList.length - newPlans.length
  });
}

function telemetryRowValuesForBatch_(telemetryRows, lastSheetRow, rowNumber) {
  if (rowNumber >= 2 && rowNumber <= lastSheetRow) {
    return telemetryRows[rowNumber - 2];
  }
  return ["", "", "", "", "", ""];
}

function clearDedupRows_(dedupSheet, rows) {
  contiguousRowGroups_(rows).forEach(function (group) {
    dedupSheet
      .getRange(group.start, 1, group.length, DEDUP_HEADERS.length)
      .clearContent();
  });
}

function writeTelemetryBatchRows_(sheet, plans) {
  var sortedPlans = plans.slice().sort(function (left, right) {
    return left.targetRow - right.targetRow;
  });
  var index = 0;
  while (index < sortedPlans.length) {
    var startRow = sortedPlans[index].targetRow;
    var values = [telemetrySheetRow_(sortedPlans[index].telemetry)];
    index += 1;
    while (index < sortedPlans.length &&
           sortedPlans[index].targetRow === startRow + values.length) {
      values.push(telemetrySheetRow_(sortedPlans[index].telemetry));
      index += 1;
    }
    sheet.getRange(startRow, 1, values.length, REQUIRED_HEADERS.length).setValues(values);
  }
}

function writeCommittedDedupRows_(dedupSheet, rows) {
  contiguousRowGroups_(rows).forEach(function (group) {
    var values = [];
    for (var index = 0; index < group.length; index += 1) {
      values.push(["COMMITTED"]);
    }
    dedupSheet.getRange(group.start, 2, group.length, 1).setValues(values);
  });
}

function contiguousRowGroups_(rows) {
  var uniqueRows = Object.create(null);
  rows.forEach(function (row) {
    if (row !== null && row !== undefined) {
      uniqueRows[String(row)] = Number(row);
    }
  });
  var sortedRows = Object.keys(uniqueRows).map(function (key) {
    return uniqueRows[key];
  }).sort(function (left, right) {
    return left - right;
  });
  var groups = [];
  sortedRows.forEach(function (row) {
    var lastGroup = groups.length > 0 ? groups[groups.length - 1] : null;
    if (lastGroup && row === lastGroup.start + lastGroup.length) {
      lastGroup.length += 1;
    } else {
      groups.push({ start: row, length: 1 });
    }
  });
  return groups;
}

function findDedupRow_(sheet, key) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return null;
  }
  var match = sheet
    .getRange(2, 1, lastRow - 1, 1)
    .createTextFinder(key)
    .matchEntireCell(true)
    .findNext();
  return match ? match.getRow() : null;
}

function nextTelemetryTargetRow_(sheet, dedupSheet) {
  // Telemetry luon ghi du 6 cot A:F. Tim dong trong thuc su dau tien tu dong 2
  // thay vi dua vao TargetRow cu trong __TELEMETRY_DEDUP.
  var lastSheetRow = Math.max(1, sheet.getLastRow());
  if (lastSheetRow >= 2) {
    // Doc cot Date truoc de giam du lieu phai lay tu Sheets. Chi khi A trong
    // moi doc A:F de xac nhan ca dong telemetry thuc su trong.
    var dateValues = sheet.getRange(2, 1, lastSheetRow - 1, 1).getValues();
    for (var index = 0; index < dateValues.length; index += 1) {
      if (dateValues[index][0] !== "" && dateValues[index][0] !== null) {
        continue;
      }

      var rowNumber = index + 2;
      var rowValues = sheet
        .getRange(rowNumber, 1, 1, REQUIRED_HEADERS.length)
        .getValues()[0];
      if (!isBlankTelemetryRow_(rowValues)) {
        continue;
      }

      if (prepareBlankTelemetryRowForReuse_(dedupSheet, rowNumber)) {
        return rowNumber;
      }
    }
  }

  // Khong co lo trong trong vung hien tai: dung dong ngay sau du lieu.
  // Neu dong nay dang duoc mot execution PENDING giu, bo qua cho den dong
  // dau tien khong con reservation dang hoat dong.
  var targetRow = Math.max(2, lastSheetRow + 1);
  while (!prepareBlankTelemetryRowForReuse_(dedupSheet, targetRow)) {
    targetRow += 1;
  }
  return targetRow;
}

function prepareBlankTelemetryRowForReuse_(dedupSheet, targetRow) {
  var lastDedupRow = dedupSheet.getLastRow();
  if (lastDedupRow < 2) {
    return true;
  }

  var matches = dedupSheet
    .getRange(2, 3, lastDedupRow - 1, 1)
    .createTextFinder(String(targetRow))
    .matchEntireCell(true)
    .findAll();

  if (!matches || matches.length === 0) {
    return true;
  }

  var staleRows = [];
  for (var index = 0; index < matches.length; index += 1) {
    var dedupRow = matches[index].getRow();
    var status = String(dedupSheet.getRange(dedupRow, 2).getValue()).trim();

    // PENDING co the la mot request da reserve dong nhung chua kip commit.
    // Khong duoc ghi de len dong nay; retry cung Message ID se tu khoi phuc.
    if (status === "PENDING") {
      return false;
    }

    // COMMITTED + telemetry row dang trong chi co the xay ra khi du lieu A:F
    // da bi xoa thu cong. Reservation nay da stale va phai duoc giai phong de
    // dong trong co the duoc tai su dung tu tren xuong duoi.
    if (status === "COMMITTED") {
      staleRows.push(dedupRow);
      continue;
    }

    // Trang thai khac cho thay dedup metadata bi hong; dung ghi de len de
    // tranh lam mat kha nang truy vet.
    throw new Error("Dedup state is invalid for target row " + targetRow + ".");
  }

  staleRows.forEach(function (dedupRow) {
    dedupSheet.getRange(dedupRow, 1, 1, DEDUP_HEADERS.length).clearContent();
  });
  return true;
}

function ensureSheetRowExists_(sheet, rowNumber) {
  var maximumRows = sheet.getMaxRows();
  if (rowNumber > maximumRows) {
    sheet.insertRowsAfter(maximumRows, rowNumber - maximumRows);
  }
}

function telemetryFingerprint_(telemetry) {
  return JSON.stringify([
    telemetry.towerId,
    telemetry.nodeId,
    telemetry.messageId,
    telemetry.date,
    telemetry.time,
    telemetry.x,
    telemetry.y,
    telemetry.z,
    telemetry.battery,
    telemetry.temp
  ]);
}

function telemetrySheetRow_(telemetry) {
  return [telemetry.date, telemetry.time, telemetry.x, telemetry.y, telemetry.z, telemetry.battery];
}

function isBlankTelemetryRow_(row) {
  return row.every(function (value) {
    return value === "" || value === null;
  });
}

function telemetryRowMatches_(row, telemetry, timeZone) {
  var date = normalizeDate_(row[0], timeZone);
  var time = normalizeTime_(row[1], timeZone);
  var x = normalizeNumber_(row[2], -180, 180);
  var y = normalizeNumber_(row[3], -180, 180);
  var z = normalizeNumber_(row[4], -180, 180);
  var battery = normalizeNumber_(row[5], 0, 24);
  return date === telemetry.date && time === telemetry.time &&
    numbersEqual_(x, telemetry.x) && numbersEqual_(y, telemetry.y) &&
    numbersEqual_(z, telemetry.z) && numbersEqual_(battery, telemetry.battery);
}

function numbersEqual_(left, right) {
  return left !== null && right !== null && Math.abs(left - right) < 0.000001;
}

function telemetryAcceptedResponse_(telemetry, duplicate) {
  return jsonResponse_({
    ok: true,
    towerId: telemetry.towerId,
    nodeId: telemetry.nodeId,
    messageId: telemetry.messageId,
    duplicate: duplicate
  });
}

// Master Fire-and-Forget khong doc JSON response. Ghi loi kem Message ID vao
// Apps Script Executions de van truy vet duoc ma khong lam lo token bi mat.
function telemetryErrorResponse_(errorCode, error, context) {
  var safeContext = context || {};
  console.error("[TELEMETRY] " + JSON.stringify({
    errorCode: errorCode,
    towerId: String(safeContext.towerId || ""),
    nodeId: safeContext.nodeId === undefined ? "" : safeContext.nodeId,
    messageId: String(safeContext.messageId || "")
  }));
  return jsonResponse_({
    ok: false,
    errorCode: errorCode,
    error: error
  });
}

function resolveRequestedTower_(request) {
  if (!Object.prototype.hasOwnProperty.call(request, "towerId")) {
    return { valid: true, provided: false, value: "", error: "" };
  }
  if (typeof request.towerId !== "string") {
    return { valid: false, provided: true, value: "", error: "Tower ID must be a string." };
  }
  var towerId = request.towerId.trim();
  if (!towerId) {
    return { valid: false, provided: true, value: "", error: "Tower ID is required." };
  }
  if (towerId.length > 100 || /[:\\/?*\[\]]/.test(towerId) || towerId.charAt(0) === "'" || towerId.charAt(towerId.length - 1) === "'") {
    return { valid: false, provided: true, value: "", error: "Tower ID is not a valid Google Sheet name." };
  }
  return { valid: true, provided: true, value: towerId, error: "" };
}

function parseRequest_(event) {
  if (!event || !event.postData || !event.postData.contents) {
    return null;
  }
  try {
    var payload = JSON.parse(event.postData.contents);
    return payload && typeof payload === "object" ? payload : null;
  } catch (error) {
    return null;
  }
}

function safeEqual_(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  var difference = left.length ^ right.length;
  var maximumLength = Math.max(left.length, right.length);
  for (var index = 0; index < maximumLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function resolveHeaderIndexes_(headers) {
  var normalizedHeaders = headers.map(function (header) {
    return String(header).trim().toLowerCase();
  });
  var indexes = {};
  for (var index = 0; index < REQUIRED_HEADERS.length; index += 1) {
    var headerName = REQUIRED_HEADERS[index];
    var columnIndex = normalizedHeaders.indexOf(headerName.toLowerCase());
    if (columnIndex < 0) {
      return null;
    }
    indexes[headerName] = columnIndex;
  }
  return indexes;
}

function isBlankRow_(row, indexes) {
  return REQUIRED_HEADERS.every(function (header) {
    var value = row[indexes[header]];
    return value === "" || value === null;
  });
}

function normalizeRow_(row, indexes, timeZone) {
  var date = normalizeDate_(row[indexes.Date], timeZone);
  var time = normalizeTime_(row[indexes.Time], timeZone);
  var x = normalizeNumber_(row[indexes.X], -180, 180);
  var y = normalizeNumber_(row[indexes.Y], -180, 180);
  var z = normalizeNumber_(row[indexes.Z], -180, 180);
  var battery = normalizeNumber_(row[indexes.Battery], 0, 24);

  if (date === null || time === null || x === null || y === null || z === null || battery === null) {
    return null;
  }
  return { Date: date, Time: time, X: x, Y: y, Z: z, Battery: battery };
}

function normalizeDate_(value, timeZone) {
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, timeZone, "yyyy-MM-dd");
  }
  var text = String(value || "").trim();
  var match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  var localMatch = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match && localMatch) {
    match = [localMatch[0], localMatch[3], localMatch[2], localMatch[1]];
  }
  if (!match) {
    return null;
  }
  var candidate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    candidate.getFullYear() !== Number(match[1]) ||
    candidate.getMonth() !== Number(match[2]) - 1 ||
    candidate.getDate() !== Number(match[3])
  ) {
    return null;
  }
  return match[1] + "-" + match[2] + "-" + match[3];
}

function normalizeTime_(value, timeZone) {
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, timeZone, "HH:mm:ss");
  }
  if (typeof value === "number" && isFinite(value)) {
    var totalSeconds = Math.round(((value % 1) + 1) % 1 * 86400) % 86400;
    return formatTime_(Math.floor(totalSeconds / 3600), Math.floor(totalSeconds / 60) % 60, totalSeconds % 60);
  }
  var match = String(value || "").trim().match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return null;
  }
  var hours = Number(match[1]);
  var minutes = Number(match[2]);
  var seconds = Number(match[3] || 0);
  return hours <= 23 && minutes <= 59 && seconds <= 59
    ? formatTime_(hours, minutes, seconds)
    : null;
}

function formatTime_(hours, minutes, seconds) {
  return [hours, minutes, seconds].map(function (value) {
    return String(value).padStart(2, "0");
  }).join(":");
}

function normalizeNumber_(value, minimum, maximum) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }
  var normalizedValue = value;
  if (typeof value === "string") {
    normalizedValue = value.trim();
    if (normalizedValue.indexOf(",") >= 0 && normalizedValue.indexOf(".") < 0) {
      normalizedValue = normalizedValue.replace(",", ".");
    }
  }
  var parsed = typeof normalizedValue === "number" ? normalizedValue : Number(normalizedValue);
  return isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}


// -----------------------------------------------------------------------------
// EmailJS alert engine
// -----------------------------------------------------------------------------
//
// Rules:
// - Overall state is the higher severity of inclination and battery.
// - Send immediately on NORMAL -> WARNING/CRITICAL or WARNING -> CRITICAL.
//   CRITICAL -> WARNING does not send immediately; later WARNING -> CRITICAL
//   sends again. No episode latch or anti-spam cooldown is used.
// - While WARNING/CRITICAL persists, send current measurements again after
//   ALERT_EMAIL_RECHECK_MINUTES (default 60) since the last successful send.
// - NORMAL cancels pending emails and stops reminders. All active warnings
//   are combined into one EmailJS request.
// - Email sending is decoupled from telemetry writes via a small persistent
//   queue + lease + retry backoff for provider failures only.
//
// Cai dat: them ALERT_EMAIL_RECHECK_MINUTES = 60 vao Thuoc tinh cua tap lenh.
// Chay setupEmailAlertService() mot lan de bat mail va tao trigger moi phut.
// Sau do chi sua thuoc tinh nay (so phut >= 1), khong can tao lai trigger.
// Trigger doc Google Sheet TWR-01, lay toi da 3 mau hop le moi nhat theo
// Date/Time (khong theo vi tri dong). Du lieu co san/nhap truc tiep van duoc
// kiem tra. Mail ghi ro thoi gian mau cuoi cung, khong tao so do moi.
// Chay diagnoseEmailAlertService() de xem trang thai va ly do chua gui mail.

function setupEmailAlertService() {
  var properties = PropertiesService.getScriptProperties();
  setDefaultScriptProperty_(properties, ALERT_INITIAL_X_PROPERTY, "0");
  setDefaultScriptProperty_(properties, ALERT_INITIAL_Y_PROPERTY, "0");
  setDefaultScriptProperty_(properties, ALERT_INITIAL_Z_PROPERTY, "0");
  setDefaultScriptProperty_(properties, ALERT_TILT_X_PROPERTY, "0.5");
  setDefaultScriptProperty_(properties, ALERT_TILT_Y_PROPERTY, "0.5");
  setDefaultScriptProperty_(properties, ALERT_TILT_Z_PROPERTY, "0.5");
  setDefaultScriptProperty_(properties, ALERT_BATTERY_WARNING_PROPERTY, "12.8");
  setDefaultScriptProperty_(properties, ALERT_BATTERY_CRITICAL_PROPERTY, "10.0");
  setDefaultScriptProperty_(properties, ALERT_EMAIL_RECHECK_MINUTES_PROPERTY,
    String(ALERT_EMAIL_DEFAULT_RECHECK_MINUTES));

  var config = getEmailAlertConfig_(properties);
  if (!config.configured) {
    throw new Error(
      "Set EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY and ALERT_EMAIL_TO first."
    );
  }

  // Validate the actual source before installing a timer. Setup preserves
  // existing state and the reminder clock; it must not erase all readings.
  var snapshot = loadLatestSheetAlertReadings_(config);
  var current = assessCurrentEmailAlert_({ readings: snapshot.readings }, config);
  setupEmailAlertTrigger_();
  properties.setProperty(EMAIL_ALERT_ENABLED_PROPERTY, "true");

  var result = {
    ok: true,
    emailAlertsEnabled: true,
    serviceIdConfigured: Boolean(config.serviceId),
    templateIdConfigured: Boolean(config.templateId),
    publicKeyConfigured: Boolean(config.publicKey),
    privateKeyConfigured: Boolean(config.privateKey),
    recipientConfigured: Boolean(config.toEmail),
    recheckMinutes: config.recheckMinutes,
    triggerHandler: "recheckEmailAlerts",
    dataSource: "Google Sheets",
    sampleCount: snapshot.readings.length,
    currentLevel: current ? current.level : "normal",
    inclinationThresholds: config.inclination,
    battery: config.battery
  };
  console.log(JSON.stringify(result));
  return result;
}

function disableEmailAlertService() {
  PropertiesService.getScriptProperties()
    .setProperty(EMAIL_ALERT_ENABLED_PROPERTY, "false");
  return { ok: true, emailAlertsEnabled: false };
}

function resetEmailAlertState() {
  resetEmailAlertState_();
  return { ok: true };
}

function resetEmailAlertState_() {
  var properties = PropertiesService.getScriptProperties();
  properties.setProperties({
    TOWER_ALERT_ENGINE_STATE_V1: JSON.stringify(defaultAlertEngineState_()),
    TOWER_ALERT_EMAIL_QUEUE_V1: "[]"
  });
}

function setupEmailAlertTrigger_() {
  var existingTriggers = ScriptApp.getProjectTriggers();
  ScriptApp.newTrigger("recheckEmailAlerts").timeBased().everyMinutes(1).create();
  existingTriggers.forEach(function (trigger) {
    var handler = trigger.getHandlerFunction();
    if (handler === "recheckEmailAlerts" || handler === "retryPendingEmailAlerts") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function testEmailJsConnection() {
  var config = getEmailAlertConfig_(PropertiesService.getScriptProperties());
  if (!config.configured) {
    throw new Error(
      "EmailJS is not configured. Check EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY and ALERT_EMAIL_TO."
    );
  }

  var detectedAt = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone() || "Asia/Ho_Chi_Minh",
    "yyyy-MM-dd HH:mm:ss"
  );
  var params = {
    to_email: config.toEmail,
    subject: "[TEST] " + TELEMETRY_TOWER_ID + " - EmailJS Connection Test",
    message: [
      "TOWER INCLINATION MONITORING SYSTEM",
      "",
      "Tower: " + TELEMETRY_TOWER_ID,
      "Detected: " + detectedAt,
      "Severity: TEST",
      "Active warnings: 0",
      "",
      "EmailJS connection test from Google Apps Script.",
      "If you received this message, EmailJS configuration is working."
    ].join("\n"),
    tower_id: TELEMETRY_TOWER_ID,
    detected_at: detectedAt,
    severity: "TEST",
    alert_count: "0",
    alert_message: "EmailJS connection test from Google Apps Script.",
    avg_x: "--",
    avg_y: "--",
    avg_z: "--",
    battery: "--"
  };

  sendEmailJsAlert_(config, params);
  return { ok: true };
}

// Keep old manually installed triggers compatible with the new reminder rules.
function retryPendingEmailAlerts() {
  return recheckEmailAlerts();
}

// Runs each minute; the Script Property controls when a reminder is due.
// Read the Sheet even when data was entered manually or predates setup.
function recheckEmailAlerts() {
  try {
    var result = deliverNextPendingEmailAlert_(true);
    console.log("[ALERT][RECHECK] " + JSON.stringify(result));
    return result;
  } catch (error) {
    console.error("[ALERT][RECHECK] " +
      String(error && error.message ? error.message : error));
    throw error;
  }
}

// Read-only diagnostic for the editor. No HTTP email send, queue changes,
// or credentials in its output. A running trigger alone does not prove mail.
function diagnoseEmailAlertService() {
  var properties = PropertiesService.getScriptProperties();
  var result = { ok: false, service: TELEMETRY_SERVICE_VERSION, towerId: TELEMETRY_TOWER_ID };
  try {
    var config = getEmailAlertConfig_(properties);
    var state = loadAlertEngineState_(properties);
    var queue = loadEmailAlertQueue_(properties);
    result.enabled = config.enabled;
    result.recheckMinutes = config.recheckMinutes;
    result.triggerInstalled = ScriptApp.getProjectTriggers().some(function (trigger) {
      return trigger.getHandlerFunction() === "recheckEmailAlerts" ||
        trigger.getHandlerFunction() === "retryPendingEmailAlerts";
    });
    result.missingProperties = [];
    [
      [EMAILJS_SERVICE_ID_PROPERTY, config.serviceId],
      [EMAILJS_TEMPLATE_ID_PROPERTY, config.templateId],
      [EMAILJS_PUBLIC_KEY_PROPERTY, config.publicKey],
      [EMAIL_ALERT_TO_PROPERTY, config.toEmail],
      ["SENSOR_SHEET_ID", config.sheetId]
    ].forEach(function (entry) {
      if (!entry[1]) {
        result.missingProperties.push(entry[0]);
      }
    });
    result.privateKeyConfigured = Boolean(config.privateKey);
    result.calibration = config.calibration;
    result.inclinationThresholds = config.inclination;
    result.batteryThresholds = config.battery;
    result.pendingEmails = queue.length;
    result.lastEmailSentAt = state.lastEmailSentAt || null;
    result.nextReminderAt = state.lastEmailSentAt > 0
      ? state.lastEmailSentAt + config.recheckMinutes * 60 * 1000
      : null;

    if (!config.enabled) {
      result.reason = "EMAIL_ALERT_DISABLED";
    } else if (!config.configured) {
      result.reason = "EMAILJS_NOT_CONFIGURED";
    } else if (!config.sheetId) {
      result.reason = "SENSOR_SHEET_NOT_CONFIGURED";
    } else {
      result.reason = "SHEET_READ_FAILED";
      var snapshot = loadLatestSheetAlertReadings_(config);
      var current = assessCurrentEmailAlert_({ readings: snapshot.readings }, config);
      result.sampleCount = snapshot.readings.length;
      result.validSheetRows = snapshot.validRows;
      result.rejectedSheetRows = snapshot.rejectedRows;
      result.currentLevel = current ? current.level : "normal";
      result.latestSampleAt = current ? current.reading.date + " " + current.reading.time : null;
      result.average = current ? current.average : null;
      result.tiltComponents = current ? current.inclination.components : null;
      result.batteryVoltage = current ? current.reading.battery : null;
      result.lastSendError = queue.length > 0 ? queue[queue.length - 1].lastError || null : null;
      result.ok = true;
      result.reason = !current ? "NO_VALID_SHEET_READINGS"
        : current.level === "normal" ? "NORMAL"
          : queue.length > 0 ? "EMAIL_PENDING_OR_RETRYING"
            : state.currentLevel === "normal" ||
              (state.currentLevel === "warning" && current.level === "critical") ||
              state.lastEmailSentAt === 0 || Date.now() >= result.nextReminderAt
              ? "READY_TO_SEND" : "WAITING_RECHECK";
    }
  } catch (error) {
    result.reason = result.reason || "INVALID_ALERT_CONFIGURATION";
    result.error = String(error && error.message ? error.message : error);
  }
  console.log("[ALERT][DIAGNOSE] " + JSON.stringify(result));
  return result;
}

function loadLatestSheetAlertReadings_(config) {
  if (!config.sheetId) {
    throw new Error("Set Script Property SENSOR_SHEET_ID before enabling email checks.");
  }
  var spreadsheet = SpreadsheetApp.openById(config.sheetId);
  var sheet = spreadsheet.getSheetByName(TELEMETRY_TOWER_ID);
  if (!sheet) {
    throw new Error("Google Sheet " + TELEMETRY_TOWER_ID + " was not found for email checks.");
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 1 || sheet.getMaxColumns() < REQUIRED_HEADERS.length) {
    throw new Error("TWR-01 columns A:F must be Date, Time, X, Y, Z, Battery.");
  }
  var indexes = { Date: 0, Time: 1, X: 2, Y: 3, Z: 4, Battery: 5 };
  var timeZone = spreadsheet.getSpreadsheetTimeZone() || Session.getScriptTimeZone() || "Asia/Ho_Chi_Minh";
  var readings = [];
  var validRows = 0;
  var rejectedRows = 0;
  // Scan all rows in bounded bulk chunks; keep only the newest three samples.
  // Rows can be out of order because telemetry reuses blanks or is imported.
  for (var startRow = 1; startRow <= lastRow; startRow += rowCount) {
    var rowCount = Math.min(lastRow - startRow + 1, MAXIMUM_ROWS + (startRow === 1 ? 1 : 0));
    var values = sheet.getRange(startRow, 1, rowCount, REQUIRED_HEADERS.length).getValues();
    if (startRow === 1 && !REQUIRED_HEADERS.every(function (header, index) {
      return String(values[0][index]).trim().toLowerCase() === header.toLowerCase();
    })) {
      throw new Error("TWR-01 columns A:F must be Date, Time, X, Y, Z, Battery.");
    }
    for (var index = startRow === 1 ? 1 : 0; index < values.length; index += 1) {
      if (isBlankRow_(values[index], indexes)) {
        continue;
      }
      var normalized = normalizeRow_(values[index], indexes, timeZone);
      if (!normalized) {
        rejectedRows += 1;
        continue;
      }
      validRows += 1;
      var reading = {
        messageId: "sheet:" + (startRow + index),
        date: normalized.Date, time: normalized.Time,
        x: normalized.X, y: normalized.Y, z: normalized.Z, battery: normalized.Battery
      };
      reading.timestampMs = telemetryTimestampMs_(reading);
      var existingIndex = readings.findIndex(function (sample) {
        return sample.timestampMs === reading.timestampMs;
      });
      if (existingIndex >= 0) {
        // Same rule as the browser: the last valid row at a timestamp wins.
        readings[existingIndex] = reading;
      } else {
        readings.push(reading);
      }
      readings.sort(function (left, right) { return left.timestampMs - right.timestampMs; });
      if (readings.length > ALERT_AVERAGE_WINDOW_SIZE) {
        readings.shift();
      }
    }
  }
  // The rolling average starts over after a >90-minute sample gap.
  for (var index = readings.length - 1; index > 0; index -= 1) {
    if (readings[index].timestampMs - readings[index - 1].timestampMs > ALERT_MAXIMUM_WINDOW_GAP_MS) {
      readings = readings.slice(index);
      break;
    }
  }
  return { readings: readings, validRows: validRows, rejectedRows: rejectedRows };
}

function getEmailAlertConfig_(properties) {
  // Read config in one service call: a minute trigger must not spend dozens
  // of PropertiesService calls while idle. Values remain fresh each execution.
  var snapshot = (properties || PropertiesService.getScriptProperties()).getProperties();
  var source = {
    getProperty: function (key) {
      return Object.prototype.hasOwnProperty.call(snapshot, key) ? snapshot[key] : null;
    }
  };

  var config = {
    enabled: parseBooleanProperty_(
      source.getProperty(EMAIL_ALERT_ENABLED_PROPERTY),
      false
    ),
    serviceId: String(source.getProperty(EMAILJS_SERVICE_ID_PROPERTY) || "").trim(),
    templateId: String(source.getProperty(EMAILJS_TEMPLATE_ID_PROPERTY) || "").trim(),
    publicKey: String(source.getProperty(EMAILJS_PUBLIC_KEY_PROPERTY) || "").trim(),
    privateKey: String(source.getProperty(EMAILJS_PRIVATE_KEY_PROPERTY) || "").trim(),
    toEmail: String(source.getProperty(EMAIL_ALERT_TO_PROPERTY) || "").trim(),
    sheetId: String(source.getProperty("SENSOR_SHEET_ID") || "").trim(),
    recheckMinutes: finitePropertyNumber_(
      source, ALERT_EMAIL_RECHECK_MINUTES_PROPERTY,
      ALERT_EMAIL_DEFAULT_RECHECK_MINUTES, 1, 525600
    ),
    calibration: {
      x: finitePropertyNumber_(source, ALERT_INITIAL_X_PROPERTY, 0, -180, 180),
      y: finitePropertyNumber_(source, ALERT_INITIAL_Y_PROPERTY, 0, -180, 180),
      z: finitePropertyNumber_(source, ALERT_INITIAL_Z_PROPERTY, 0, -180, 180)
    },
    inclination: {
      x: finitePropertyNumber_(source, ALERT_TILT_X_PROPERTY, 0.5, 0.1, 90),
      y: finitePropertyNumber_(source, ALERT_TILT_Y_PROPERTY, 0.5, 0.1, 90),
      z: finitePropertyNumber_(source, ALERT_TILT_Z_PROPERTY, 0.5, 0.1, 90),
      criticalMultiplier: ALERT_CRITICAL_MULTIPLIER
    },
    battery: {
      warning: finitePropertyNumber_(
        source,
        ALERT_BATTERY_WARNING_PROPERTY,
        12.8,
        0,
        24
      ),
      critical: finitePropertyNumber_(
        source,
        ALERT_BATTERY_CRITICAL_PROPERTY,
        10.0,
        0,
        24
      )
    }
  };

  if (config.battery.critical >= config.battery.warning) {
    throw new Error("ALERT_BATTERY_CRITICAL must be lower than ALERT_BATTERY_WARNING.");
  }

  config.configured = Boolean(
    config.serviceId &&
    config.templateId &&
    config.publicKey &&
    config.toEmail
  );
  return config;
}

function setDefaultScriptProperty_(properties, key, value) {
  if (properties.getProperty(key) === null) {
    properties.setProperty(key, value);
  }
}

function parseBooleanProperty_(value, fallback) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return Boolean(fallback);
  }
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function finitePropertyNumber_(properties, key, fallback, minimum, maximum) {
  var raw = properties.getProperty(key);
  var parsed = raw === null || String(raw).trim() === ""
    ? fallback
    : Number(String(raw).trim().replace(",", "."));
  if (!isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      key + " must be a finite number from " + minimum + " to " + maximum + "."
    );
  }
  return parsed;
}

function defaultAlertEngineState_() {
  return {
    version: 2,
    currentLevel: "normal",
    lastEmailSentAt: 0,
    lastEvaluatedTimestampMs: 0,
    readings: [],
    recentMessageIds: []
  };
}

function loadAlertEngineState_(properties) {
  var raw = properties.getProperty(ALERT_ENGINE_STATE_PROPERTY);
  if (!raw) {
    return defaultAlertEngineState_();
  }

  try {
    var parsed = JSON.parse(raw);
    var state = defaultAlertEngineState_();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (parsed.currentLevel === "warning" || parsed.currentLevel === "critical") {
        state.currentLevel = parsed.currentLevel;
      }
      state.lastEmailSentAt =
        Number.isFinite(Number(parsed.lastEmailSentAt)) && Number(parsed.lastEmailSentAt) >= 0
          ? Number(parsed.lastEmailSentAt)
          : 0;
      state.lastEvaluatedTimestampMs =
        Number.isFinite(Number(parsed.lastEvaluatedTimestampMs)) &&
        Number(parsed.lastEvaluatedTimestampMs) >= 0
          ? Number(parsed.lastEvaluatedTimestampMs)
          : 0;
      state.readings = sanitizeAlertReadings_(parsed.readings);
      state.recentMessageIds = sanitizeRecentMessageIds_(parsed.recentMessageIds);
    }
    return state;
  } catch (error) {
    console.error("[ALERT][STATE] Invalid state JSON; resetting.");
    return defaultAlertEngineState_();
  }
}

function sanitizeAlertReadings_(readings) {
  if (!Array.isArray(readings)) {
    return [];
  }
  return readings.filter(function (reading) {
    return reading &&
      typeof reading === "object" &&
      Number.isFinite(Number(reading.timestampMs)) &&
      Number.isFinite(Number(reading.x)) &&
      Number.isFinite(Number(reading.y)) &&
      Number.isFinite(Number(reading.z)) &&
      Number.isFinite(Number(reading.battery));
  }).map(function (reading) {
    return {
      messageId: String(reading.messageId || ""),
      timestampMs: Number(reading.timestampMs),
      date: String(reading.date || ""),
      time: String(reading.time || ""),
      x: Number(reading.x),
      y: Number(reading.y),
      z: Number(reading.z),
      battery: Number(reading.battery)
    };
  }).sort(function (left, right) {
    return left.timestampMs - right.timestampMs;
  }).slice(-ALERT_AVERAGE_WINDOW_SIZE);
}

function sanitizeRecentMessageIds_(messageIds) {
  if (!Array.isArray(messageIds)) {
    return [];
  }
  var seen = Object.create(null);
  var normalized = [];
  messageIds.forEach(function (messageId) {
    var value = String(messageId || "").trim();
    if (!value || Object.prototype.hasOwnProperty.call(seen, value)) {
      return;
    }
    seen[value] = true;
    normalized.push(value);
  });
  return normalized.slice(-ALERT_RECENT_MESSAGE_ID_LIMIT);
}

function processTelemetryBatchForEmailAlerts_(telemetryList) {
  var properties = PropertiesService.getScriptProperties();
  var config = getEmailAlertConfig_(properties);
  if (!config.enabled || !config.configured) {
    return false;
  }

  var state = loadAlertEngineState_(properties);
  var queue = loadEmailAlertQueue_(properties);
  var changed = false;

  telemetryList.forEach(function (telemetry) {
    var result = applyTelemetryToAlertState_(telemetry, state, queue, config);
    state = result.state;
    queue = result.queue;
    changed = changed || result.changed;
  });

  persistAlertStateAndQueue_(properties, state, queue);
  return changed;
}

function processTelemetryForEmailAlerts_(telemetry) {
  var properties = PropertiesService.getScriptProperties();
  var config = getEmailAlertConfig_(properties);
  if (!config.enabled || !config.configured) {
    return false;
  }

  var state = loadAlertEngineState_(properties);
  var queue = loadEmailAlertQueue_(properties);
  var result = applyTelemetryToAlertState_(telemetry, state, queue, config);
  persistAlertStateAndQueue_(properties, result.state, result.queue);
  return result.changed;
}

function applyTelemetryToAlertState_(telemetry, state, queue, config) {
  var messageKey = telemetry.towerId + "|" + telemetry.messageId;
  if (state.recentMessageIds.indexOf(messageKey) >= 0) {
    return { state: state, queue: queue, changed: false };
  }

  state.recentMessageIds.push(messageKey);
  if (state.recentMessageIds.length > ALERT_RECENT_MESSAGE_ID_LIMIT) {
    state.recentMessageIds.splice(
      0,
      state.recentMessageIds.length - ALERT_RECENT_MESSAGE_ID_LIMIT
    );
  }

  var timestampMs = telemetryTimestampMs_(telemetry);
  if (timestampMs === null) {
    return { state: state, queue: queue, changed: false };
  }

  // Never let an old/backfilled sample roll the live alert state backward.
  if (state.lastEvaluatedTimestampMs > 0 &&
      timestampMs < state.lastEvaluatedTimestampMs) {
    return { state: state, queue: queue, changed: false };
  }

  // A distinct Message ID can share a timestamp and reuse an earlier blank
  // row. Resolve these uncommon ties from the Sheet, where the last physical
  // row wins, rather than counting twice or choosing by arrival order.
  if (state.readings.some(function (sample) {
    return sample.timestampMs === timestampMs;
  })) {
    var snapshot = loadLatestSheetAlertReadings_(config);
    state.readings = snapshot.readings;
    state.lastEvaluatedTimestampMs = state.readings.length > 0
      ? state.readings[state.readings.length - 1].timestampMs : 0;
    return evaluateEmailAlertState_(state, queue, config, Date.now());
  }

  var reading = {
    messageId: String(telemetry.messageId),
    timestampMs: timestampMs,
    date: telemetry.date,
    time: telemetry.time,
    x: telemetry.x,
    y: telemetry.y,
    z: telemetry.z,
    battery: telemetry.battery
  };

  var lastReading = state.readings.length > 0
    ? state.readings[state.readings.length - 1]
    : null;
  if (lastReading &&
      timestampMs - lastReading.timestampMs > ALERT_MAXIMUM_WINDOW_GAP_MS) {
    state.readings = [];
  }

  state.readings.push(reading);
  state.readings.sort(function (left, right) {
    return left.timestampMs - right.timestampMs;
  });
  if (state.readings.length > ALERT_AVERAGE_WINDOW_SIZE) {
    state.readings = state.readings.slice(-ALERT_AVERAGE_WINDOW_SIZE);
  }
  state.lastEvaluatedTimestampMs = Math.max(
    state.lastEvaluatedTimestampMs,
    timestampMs
  );

  return evaluateEmailAlertState_(state, queue, config, Date.now());
}

function assessCurrentEmailAlert_(state, config) {
  if (state.readings.length === 0) {
    return null;
  }
  var reading = state.readings[state.readings.length - 1];
  var average = calculateAlertAverage_(state.readings, config.calibration);
  var inclination = assessEmailInclination_(
    average,
    config.inclination,
    config.calibration
  );
  var battery = assessEmailBattery_(reading.battery, config.battery);
  var level = inclination.level === "critical" || battery.level === "critical"
    ? "critical"
    : inclination.level === "warning" || battery.level === "warning"
      ? "warning"
      : "normal";
  return {
    reading: reading,
    average: average,
    level: level,
    warnings: buildActiveEmailWarnings_(inclination, battery, config),
    inclination: inclination
  };
}

function evaluateEmailAlertState_(state, queue, config, now) {
  var current = assessCurrentEmailAlert_(state, config);
  var previousLevel = state.currentLevel;
  state.currentLevel = current ? current.level : "normal";
  if (state.currentLevel === "normal") {
    state.lastEmailSentAt = 0;
    return { state: state, queue: [], changed: false };
  }

  var transition = previousLevel === "normal" ||
    (previousLevel === "warning" && state.currentLevel === "critical");
  var reminderDue = state.lastEmailSentAt > 0 &&
    now - state.lastEmailSentAt >= config.recheckMinutes * 60 * 1000;
  // A pending/retrying/in-flight email already covers this reminder. A new
  // escalation replaces a pending snapshot so it can be sent immediately.
  var changed = transition ||
    (queue.length === 0 && (state.lastEmailSentAt === 0 || reminderDue));
  if (changed) {
    queue = enqueueEmailAlert_(queue, buildEmailAlertEvent_(
      current.reading, current.average, current.warnings, config,
      transition || state.lastEmailSentAt === 0 ? "transition" : "reminder"
    ));
  }
  return { state: state, queue: queue, changed: changed };
}

function telemetryTimestampMs_(telemetry) {
  var date = String(telemetry.date || "");
  var time = String(telemetry.time || "");
  var timestamp = Date.parse(date + "T" + time + "+07:00");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function wrapAlertDegrees180_(value) {
  return ((((Number(value) + 180) % 360) + 360) % 360) - 180;
}

function calculateAlertAverage_(readings, calibration) {
  function average(values) {
    return values.reduce(function (total, value) {
      return total + value;
    }, 0) / values.length;
  }

  function averageWrappedAxis(axis, reference) {
    var previous = reference;
    var unwrapped = readings.map(function (reading) {
      var current = previous +
        wrapAlertDegrees180_(Number(reading[axis]) - previous);
      previous = current;
      return current;
    });
    return wrapAlertDegrees180_(average(unwrapped));
  }

  return {
    x: averageWrappedAxis("x", calibration.x),
    y: averageWrappedAxis("y", calibration.y),
    z: average(readings.map(function (reading) {
      return Number(reading.z);
    })),
    sampleCount: readings.length
  };
}

function assessEmailInclination_(average, thresholds, calibration) {
  var components = {
    x: Math.abs(wrapAlertDegrees180_(average.x - calibration.x)),
    y: Math.abs(wrapAlertDegrees180_(average.y - calibration.y)),
    z: Math.abs(average.z - calibration.z)
  };
  var axes = ["x", "y", "z"];
  var ranked = axes.map(function (axis, priority) {
    var threshold = Number(thresholds[axis]);
    return {
      axis: axis,
      priority: priority,
      value: components[axis],
      threshold: threshold,
      ratio: components[axis] / threshold
    };
  }).sort(function (left, right) {
    var difference = right.ratio - left.ratio;
    return Math.abs(difference) > 1e-10
      ? difference
      : left.priority - right.priority;
  });

  var highest = ranked[0];
  var level = highest.ratio >= thresholds.criticalMultiplier
    ? "critical"
    : highest.ratio >= 1
      ? "warning"
      : "normal";

  return {
    level: level,
    axis: highest.axis,
    value: highest.value,
    threshold: highest.threshold,
    criticalThreshold: highest.threshold * thresholds.criticalMultiplier,
    components: components
  };
}

function assessEmailBattery_(voltage, thresholds) {
  var value = Number(voltage);
  if (value < thresholds.critical) {
    return {
      active: true,
      level: "critical",
      value: value,
      threshold: thresholds.critical
    };
  }
  if (value < thresholds.warning) {
    return {
      active: true,
      level: "warning",
      value: value,
      threshold: thresholds.warning
    };
  }
  return {
    active: false,
    level: "normal",
    value: value,
    threshold: thresholds.warning
  };
}

function buildActiveEmailWarnings_(inclination, battery, config) {
  var warnings = [];

  if (inclination.level !== "normal") {
    warnings.push({
      type: "inclination",
      severity: inclination.level.toUpperCase(),
      title: "Inclination " + titleCase_(inclination.level),
      axis: inclination.axis.toUpperCase(),
      value: inclination.value,
      threshold: inclination.threshold,
      criticalThreshold: inclination.criticalThreshold
    });
  }

  if (battery.active) {
    warnings.push({
      type: "battery",
      severity: battery.level.toUpperCase(),
      title: "Battery " + titleCase_(battery.level),
      value: battery.value,
      warningThreshold: config.battery.warning,
      criticalThreshold: config.battery.critical
    });
  }

  return warnings;
}

function buildEmailAlertEvent_(reading, average, warnings, config, reason) {
  var overallSeverity = warnings.some(function (warning) {
    return warning.severity === "CRITICAL";
  }) ? "CRITICAL" : "WARNING";

  var subject;
  if (warnings.length === 1) {
    subject = "[" + warnings[0].severity + "] " +
      TELEMETRY_TOWER_ID + " - " + warnings[0].title;
  } else {
    subject = "[" + overallSeverity + "] " + TELEMETRY_TOWER_ID + " - " +
      warnings.length + " Active Warnings";
  }

  var warningSections = warnings.map(function (warning, index) {
    if (warning.type === "inclination") {
      var lines = [
        (index + 1) + ". " + warning.title,
        warning.axis + "-axis inclination reached " +
          warning.value.toFixed(2) + "°."
      ];
      if (warning.severity === "CRITICAL") {
        lines.push(
          "Critical threshold: " +
          warning.criticalThreshold.toFixed(2) + "° " +
          "(configured threshold " + warning.threshold.toFixed(2) + "°)."
        );
      } else {
        lines.push(
          "Configured threshold: " +
          warning.threshold.toFixed(2) + "°."
        );
      }
      return lines.join("\n");
    }

    if (warning.severity === "CRITICAL") {
      return [
        (index + 1) + ". Battery Critical",
        "Battery voltage dropped to " + warning.value.toFixed(2) + " V.",
        "Safe discharge limit: " +
          warning.criticalThreshold.toFixed(2) + " V."
      ].join("\n");
    }

    return [
      (index + 1) + ". Battery Warning",
      "Battery voltage is low at " + warning.value.toFixed(2) + " V.",
      "Warning range: " +
        warning.criticalThreshold.toFixed(2) + " V to below " +
        warning.warningThreshold.toFixed(2) + " V."
    ].join("\n");
  });

  var detectedAt = reading.date + " " + reading.time;
  var message = [
    "TOWER INCLINATION MONITORING SYSTEM",
    "",
    "Tower: " + TELEMETRY_TOWER_ID,
    "Detected: " + detectedAt,
    "Severity: " + overallSeverity,
    "Active warnings: " + warnings.length,
    "Notification: " + (reason === "reminder" ? "Periodic reminder" : "State transition"),
    "",
    warningSections.join("\n\n"),
    "",
    "Current measurements:",
    "Latest X: " + Number(reading.x).toFixed(2) + "°",
    "Latest Y: " + Number(reading.y).toFixed(2) + "°",
    "Latest Z: " + Number(reading.z).toFixed(2) + "°",
    "Average X: " + average.x.toFixed(2) + "°",
    "Average Y: " + average.y.toFixed(2) + "°",
    "Average Z: " + average.z.toFixed(2) + "°",
    "Battery: " + Number(reading.battery).toFixed(2) + " V"
  ].join("\n");

  return {
    id: Utilities.getUuid(),
    reason: reason || "transition",
    status: "pending",
    createdAt: Date.now(),
    attempts: 0,
    nextAttemptAt: 0,
    leaseToken: "",
    leaseUntil: 0,
    templateParams: {
      to_email: config.toEmail,
      subject: subject,
      message: message,
      tower_id: TELEMETRY_TOWER_ID,
      detected_at: detectedAt,
      severity: overallSeverity,
      alert_reason: reason || "transition",
      alert_count: String(warnings.length),
      alert_message: warningSections.join("\n\n"),
      avg_x: average.x.toFixed(2),
      avg_y: average.y.toFixed(2),
      avg_z: average.z.toFixed(2),
      current_x: Number(reading.x).toFixed(2),
      current_y: Number(reading.y).toFixed(2),
      current_z: Number(reading.z).toFixed(2),
      battery: Number(reading.battery).toFixed(2)
    }
  };
}

function titleCase_(value) {
  var text = String(value || "");
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function loadEmailAlertQueue_(properties) {
  var raw = properties.getProperty(ALERT_EMAIL_QUEUE_PROPERTY);
  if (!raw) {
    return [];
  }
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(function (event) {
      return event &&
        typeof event === "object" &&
        typeof event.id === "string" &&
        event.templateParams &&
        typeof event.templateParams === "object";
    }).slice(0, ALERT_EMAIL_QUEUE_LIMIT) : [];
  } catch (error) {
    console.error("[ALERT][QUEUE] Invalid queue JSON; resetting.");
    return [];
  }
}

function enqueueEmailAlert_(queue, event) {
  // Keep a currently sending event so its completion token remains valid,
  // plus at most one pending notification representing the current state.
  var now = Date.now();
  var nextQueue = queue.filter(function (queued) {
    return queued.status === "sending" && Number(queued.leaseUntil || 0) > now;
  }).slice(0, 1);
  nextQueue.push(event);
  return nextQueue;
}

function persistAlertStateAndQueue_(properties, state, queue) {
  var values = {};
  values[ALERT_ENGINE_STATE_PROPERTY] = JSON.stringify(state);
  values[ALERT_EMAIL_QUEUE_PROPERTY] = JSON.stringify(queue);
  properties.setProperties(values);
}

function deliverNextPendingEmailAlert_(refreshFromSheet) {
  var properties = PropertiesService.getScriptProperties();
  var config = getEmailAlertConfig_(properties);
  if (!config.enabled || !config.configured) {
    return { ok: false, skipped: true, reason: "EMAIL_ALERT_DISABLED_OR_NOT_CONFIGURED" };
  }

  var lease = leaseNextEmailAlert_(properties, config, refreshFromSheet);
  if (!lease) {
    return { ok: true, skipped: true, reason: "NO_ELIGIBLE_EMAIL" };
  }

  var sendError = null;
  try {
    sendEmailJsAlert_(config, lease.event.templateParams);
  } catch (error) {
    sendError = error;
  }

  finishEmailAlertLease_(lease.event.id, lease.token, sendError);

  if (sendError) {
    throw sendError;
  }
  return { ok: true, sent: true, eventId: lease.event.id };
}

function leaseNextEmailAlert_(properties, config, refreshFromSheet) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    return null;
  }

  try {
    var now = Date.now();
    config = config || getEmailAlertConfig_(properties);
    var state = loadAlertEngineState_(properties);
    if (refreshFromSheet) {
      var snapshot = loadLatestSheetAlertReadings_(config);
      state.readings = snapshot.readings;
      state.lastEvaluatedTimestampMs = state.readings.length > 0
        ? state.readings[state.readings.length - 1].timestampMs : 0;
    }
    var result = evaluateEmailAlertState_(state, loadEmailAlertQueue_(properties), config, now);
    var queue = result.queue;
    persistAlertStateAndQueue_(properties, result.state, queue);
    console.log("[ALERT][CHECK] " + JSON.stringify({
      source: refreshFromSheet ? "Google Sheets" : "Telemetry",
      currentLevel: state.currentLevel,
      sampleCount: state.readings.length,
      latestSampleAt: state.readings.length > 0
        ? state.readings[state.readings.length - 1].date + " " + state.readings[state.readings.length - 1].time : null,
      recheckMinutes: config.recheckMinutes,
      lastEmailSentAt: state.lastEmailSentAt || null,
      pendingEmails: queue.length
    }));
    // A lease protects against overlapping web requests and timer executions;
    // it is not a cooldown and never suppresses a later state transition.
    if (queue.some(function (event) {
      return event.status === "sending" && Number(event.leaseUntil || 0) > now;
    })) {
      return null;
    }
    // A failed/expired older send may coexist with a newer escalation. Once
    // no send is active, only the latest notification should be delivered.
    queue = queue.slice(-1);
    properties.setProperty(ALERT_EMAIL_QUEUE_PROPERTY, JSON.stringify(queue));
    var eventIndex = -1;
    for (var index = 0; index < queue.length; index += 1) {
      var event = queue[index];
      var nextAttemptAt = Number(event.nextAttemptAt || 0);
      var leaseUntil = Number(event.leaseUntil || 0);
      var eligible = nextAttemptAt <= now &&
        (event.status !== "sending" || leaseUntil <= now);
      if (eligible) {
        eventIndex = index;
        break;
      }
    }
    if (eventIndex < 0) {
      return null;
    }

    var token = Utilities.getUuid();
    var current = assessCurrentEmailAlert_(result.state, config);
    // Rebuild on every attempt: never resend stale values from an old event.
    queue[eventIndex].templateParams = buildEmailAlertEvent_(
      current.reading, current.average, current.warnings, config, queue[eventIndex].reason
    ).templateParams;
    queue[eventIndex].status = "sending";
    queue[eventIndex].leaseToken = token;
    queue[eventIndex].leaseUntil = now + ALERT_EMAIL_SEND_LEASE_MS;

    properties.setProperty(ALERT_EMAIL_QUEUE_PROPERTY, JSON.stringify(queue));

    return {
      token: token,
      event: JSON.parse(JSON.stringify(queue[eventIndex]))
    };
  } finally {
    lock.releaseLock();
  }
}

function finishEmailAlertLease_(eventId, token, error) {
  var properties = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.error("[ALERT][EMAIL] Could not reacquire lock to finish mail lease.");
    return;
  }

  try {
    var queue = loadEmailAlertQueue_(properties);
    var index = queue.findIndex(function (event) {
      return event.id === eventId && event.leaseToken === token;
    });
    if (index < 0) {
      return;
    }

    if (!error) {
      queue.splice(index, 1);
      var state = loadAlertEngineState_(properties);
      if (state.currentLevel !== "normal") {
        state.lastEmailSentAt = Date.now();
      }
      persistAlertStateAndQueue_(properties, state, queue);
      console.log("[ALERT][EMAIL] Sent event " + eventId);
      return;
    }

    var attempts = Number(queue[index].attempts || 0) + 1;
    var backoff = Math.min(
      ALERT_EMAIL_RETRY_MAX_MS,
      ALERT_EMAIL_RETRY_BASE_MS * Math.pow(2, Math.min(attempts - 1, 4))
    );
    queue[index].status = "pending";
    queue[index].attempts = attempts;
    queue[index].nextAttemptAt = Date.now() + backoff;
    queue[index].leaseToken = "";
    queue[index].leaseUntil = 0;
    queue[index].lastError = String(
      error && error.message ? error.message : error
    ).slice(0, 500);
    properties.setProperty(ALERT_EMAIL_QUEUE_PROPERTY, JSON.stringify(queue));
    console.error(
      "[ALERT][EMAIL] Failed event " + eventId +
      "; retry in " + Math.round(backoff / 1000) + "s."
    );
  } finally {
    lock.releaseLock();
  }
}

function sendEmailJsAlert_(config, templateParams) {
  var payload = {
    service_id: config.serviceId,
    template_id: config.templateId,
    user_id: config.publicKey,
    // Also fill the standard variables present in the owner's EmailJS
    // template (including its Reply To field) for tests and real alerts.
    template_params: Object.assign({
      name: "Tower Inclination Monitoring System",
      time: templateParams.detected_at || "",
      email: config.toEmail
    }, templateParams)
  };
  if (config.privateKey) {
    payload.accessToken = config.privateKey;
  }

  var response = UrlFetchApp.fetch(EMAILJS_API_URL, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    followRedirects: true,
    timeoutSeconds: ALERT_EMAIL_FETCH_TIMEOUT_SECONDS
  });

  var status = response.getResponseCode();
  var body = String(response.getContentText() || "");
  if (status < 200 || status >= 300) {
    throw new Error(
      "EmailJS HTTP " + status +
      (body ? ": " + body.slice(0, 500) : "")
    );
  }
  return true;
}

function textOutputIsOk_(textOutput) {
  try {
    return Boolean(
      textOutput &&
      typeof textOutput.getContent === "function" &&
      JSON.parse(textOutput.getContent()).ok === true
    );
  } catch (error) {
    return false;
  }
}


function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
