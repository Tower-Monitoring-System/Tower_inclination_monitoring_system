var REQUIRED_HEADERS = Object.freeze(["Date", "Time", "X", "Y", "Z", "Battery"]);
var MAXIMUM_ROWS = 20000;
var TELEMETRY_ACTION = "appendTelemetry";
var TELEMETRY_TOWER_ID = "TWR-01";
var TELEMETRY_NODE_ID = 1;
var DEDUP_SHEET_NAME = "__TELEMETRY_DEDUP";
var DEDUP_HEADERS = Object.freeze(["Key", "Status", "TargetRow", "Fingerprint", "CreatedAt"]);
// Fire-and-Forget co the tao nhieu Web App execution cung luc. Cho lock du lau
// de request khong bi mat chi vi Master khong doc response BUSY.
var TELEMETRY_LOCK_TIMEOUT_MS = 120000;
var TELEMETRY_SERVICE_VERSION = "tower-telemetry-v3-fire-and-forget";

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
    headersValid: false
  };

  try {
    var properties = PropertiesService.getScriptProperties();
    var expectedToken = properties.getProperty("SENSOR_DATA_SHARED_SECRET");
    var sheetId = properties.getProperty("SENSOR_SHEET_ID");
    status.secretConfigured = Boolean(expectedToken);
    status.sheetConfigured = Boolean(sheetId);

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
        meta: { received: 0, accepted: 0, rejected: 0, towerId: resolvedTowerId }
      });
    }

    var values = sheet.getRange(1, 1, Math.min(lastRow, MAXIMUM_ROWS + 1), lastColumn).getValues();
    var indexes = resolveHeaderIndexes_(values[0]);
    if (!indexes) {
      return jsonResponse_({
        ok: false,
        errorCode: "INVALID_SHEET_HEADERS",
        error: "Required sensor columns are missing in Google Sheet " + resolvedTowerId + "."
      });
    }

    var timeZone = spreadsheet.getSpreadsheetTimeZone() || Session.getScriptTimeZone() || "Asia/Ho_Chi_Minh";
    var data = [];
    var rejected = 0;
    for (var rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
      if (isBlankRow_(values[rowIndex], indexes)) {
        continue;
      }
      var normalized = normalizeRow_(values[rowIndex], indexes, timeZone);
      if (normalized) {
        data.push(normalized);
      } else {
        rejected += 1;
      }
    }

    return jsonResponse_({
      ok: true,
      data: data,
      meta: {
        received: data.length + rejected,
        accepted: data.length,
        rejected: rejected,
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

  try {
    var dedupSheet = getOrCreateDedupSheet_(spreadsheet);
    return appendTelemetryIdempotently_(
      sheet,
      dedupSheet,
      validation.telemetry,
      timeZone
    );
  } finally {
    lock.releaseLock();
  }
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
  var targetRow = Math.max(2, sheet.getLastRow() + 1);
  var lastDedupRow = dedupSheet.getLastRow();
  if (lastDedupRow < 2) {
    return targetRow;
  }

  // Moi reservation duoc append duoi ScriptLock nen TargetRow tang dan.
  // Chi doc reservation cuoi, khong quet lai toan bo dedup sheet moi lan.
  var lastReservedRow = normalizeInteger_(
    dedupSheet.getRange(lastDedupRow, 3).getValue(),
    2,
    sheet.getMaxRows()
  );
  if (lastReservedRow === null) {
    throw new Error("Dedup target row is invalid.");
  }
  return Math.max(targetRow, lastReservedRow + 1);
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

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
