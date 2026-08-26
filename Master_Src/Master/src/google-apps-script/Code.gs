var REQUIRED_HEADERS = Object.freeze(["Date", "Time", "X", "Y", "Z", "Battery"]);
var MAXIMUM_ROWS = 20000;
var SENSOR_API_VERSION = "2026-08-26.2";

// Mo URL Web App /exec tren trinh duyet de xac nhan dung deployment moi.
// Ham nay khong tra ve token, Spreadsheet ID hay du lieu cam bien.
function doGet() {
  var properties = PropertiesService.getScriptProperties();
  return jsonResponse_({
    ok: true,
    service: "Tower inclination sensor API",
    configured: Boolean(
      properties.getProperty("SENSOR_DATA_SHARED_SECRET") &&
      properties.getProperty("SENSOR_SHEET_ID")
    )
  });
}

function doPost(event) {
  try {
    var properties = PropertiesService.getScriptProperties();
    var expectedToken = properties.getProperty("SENSOR_DATA_SHARED_SECRET");
    var sheetId = normalizeSpreadsheetId_(properties.getProperty("SENSOR_SHEET_ID"));
    var fallbackSheetName = properties.getProperty("SENSOR_SHEET_NAME") || "";

    if (!expectedToken || !sheetId) {
      return jsonResponse_({
        ok: false,
        errorCode: "SERVICE_NOT_CONFIGURED",
        error: "Service is not configured. Check SENSOR_DATA_SHARED_SECRET and SENSOR_SHEET_ID."
      });
    }

    var request = parseRequest_(event);
    if (!request || !safeEqual_(request.token, expectedToken)) {
      return jsonResponse_({
        ok: false,
        errorCode: "UNAUTHORIZED",
        error: "Unauthorized request. SENSOR_DATA_SHARED_SECRET does not match."
      });
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

    // Giu nguyen API doc du lieu cu khi request khong co action="append".
    // ESP32 Master dung action="append" de ghi mot mau cam bien moi.
    if (request.action === "append") {
      return appendSensorData_(request, properties, spreadsheet, sheet, resolvedTowerId);
    }

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
      errorCode: "TEMPORARY_UNAVAILABLE",
      error: "Sensor data is temporarily unavailable."
    });
  }
}

function appendSensorData_(request, properties, spreadsheet, sheet, resolvedTowerId) {
  var requestId = normalizeRequestId_(request.requestId);
  var x = normalizeSensorNumber_(request.x, -180, 180);
  var y = normalizeSensorNumber_(request.y, -180, 180);
  var z = normalizeSensorNumber_(request.z, -180, 180);
  var battery = normalizeSensorNumber_(request.battery, 0, 24);

  if (!requestId || x === null || y === null || z === null || battery === null) {
    return jsonResponse_({
      ok: false,
      errorCode: "INVALID_SENSOR_DATA",
      error: "X/Y/Z must be -180..180, Battery must be 0..24, and requestId must be valid."
    });
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    return jsonResponse_({
      ok: false,
      errorCode: "LOCK_TIMEOUT",
      error: "The sensor sheet is busy. Please retry."
    });
  }

  try {
    var idempotencyProperty = "SENSOR_LAST_REQUEST_ID_" + resolvedTowerId;
    if (properties.getProperty(idempotencyProperty) === requestId) {
      return jsonResponse_({
        ok: true,
        duplicate: true,
        requestId: requestId,
        towerId: resolvedTowerId
      });
    }

    var lastRow = sheet.getLastRow();
    var lastColumn = sheet.getLastColumn();
    if (lastRow < 1 || lastColumn < 1) {
      sheet.getRange(1, 1, 1, REQUIRED_HEADERS.length).setValues([REQUIRED_HEADERS]);
      lastRow = 1;
      lastColumn = REQUIRED_HEADERS.length;
    }

    var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
    var indexes = resolveHeaderIndexes_(headers);
    if (!indexes) {
      return jsonResponse_({
        ok: false,
        errorCode: "INVALID_SHEET_HEADERS",
        error: "Required sensor columns are missing in Google Sheet " + resolvedTowerId + "."
      });
    }

    var rowWidth = Math.max(lastColumn, REQUIRED_HEADERS.length);
    var row = [];
    for (var columnIndex = 0; columnIndex < rowWidth; columnIndex += 1) {
      row.push("");
    }

    var writtenAt = new Date();
    row[indexes.Date] = writtenAt;
    row[indexes.Time] = writtenAt;
    row[indexes.X] = x;
    row[indexes.Y] = y;
    row[indexes.Z] = z;
    row[indexes.Battery] = battery;

    var targetRow = sheet.getLastRow() + 1;
    sheet.getRange(targetRow, 1, 1, rowWidth).setValues([row]);
    sheet.getRange(targetRow, indexes.Date + 1).setNumberFormat("yyyy-MM-dd");
    sheet.getRange(targetRow, indexes.Time + 1).setNumberFormat("HH:mm:ss");
    SpreadsheetApp.flush();

    // Chi luu ID sau khi du lieu da duoc ghi thanh cong. Neu ESP32 mat phan hoi
    // va gui lai, request se khong tao them mot dong trung.
    properties.setProperty(idempotencyProperty, requestId);

    var timeZone = spreadsheet.getSpreadsheetTimeZone() || Session.getScriptTimeZone() || "Asia/Ho_Chi_Minh";
    return jsonResponse_({
      ok: true,
      duplicate: false,
      requestId: requestId,
      towerId: resolvedTowerId,
      row: targetRow,
      date: Utilities.formatDate(writtenAt, timeZone, "yyyy-MM-dd"),
      time: Utilities.formatDate(writtenAt, timeZone, "HH:mm:ss")
    });
  } finally {
    lock.releaseLock();
  }
}

function normalizeRequestId_(value) {
  if (typeof value !== "string") {
    return null;
  }
  var requestId = value.trim();
  return /^[A-Za-z0-9._:-]{1,64}$/.test(requestId) ? requestId : null;
}

function normalizeSpreadsheetId_(value) {
  var text = String(value || "").trim();
  var urlMatch = text.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  return urlMatch ? urlMatch[1] : text;
}

function normalizeSensorNumber_(value, minimum, maximum) {
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  return normalizeNumber_(value, minimum, maximum);
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
  payload.apiVersion = SENSOR_API_VERSION;
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
