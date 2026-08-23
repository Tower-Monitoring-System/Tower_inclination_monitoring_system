var REQUIRED_HEADERS = Object.freeze(["Date", "Time", "X", "Y", "Z", "Battery"]);
var MAXIMUM_ROWS = 20000;

function doPost(event) {
  try {
    var properties = PropertiesService.getScriptProperties();
    var expectedToken = properties.getProperty("SENSOR_DATA_SHARED_SECRET");
    var sheetId = properties.getProperty("SENSOR_SHEET_ID");
    var sheetName = properties.getProperty("SENSOR_SHEET_NAME") || "";

    if (!expectedToken || !sheetId) {
      return jsonResponse_({ ok: false, error: "Service is not configured." });
    }

    var request = parseRequest_(event);
    if (!request || !safeEqual_(request.token, expectedToken)) {
      return jsonResponse_({ ok: false, error: "Unauthorized request." });
    }

    var spreadsheet = SpreadsheetApp.openById(sheetId);
    var sheet = sheetName ? spreadsheet.getSheetByName(sheetName) : spreadsheet.getSheets()[0];
    if (!sheet) {
      return jsonResponse_({ ok: false, error: "Sensor sheet is unavailable." });
    }

    var lastRow = sheet.getLastRow();
    var lastColumn = sheet.getLastColumn();
    if (lastRow < 1 || lastColumn < 1) {
      return jsonResponse_({ ok: true, data: [], meta: { received: 0, accepted: 0, rejected: 0 } });
    }

    var values = sheet.getRange(1, 1, Math.min(lastRow, MAXIMUM_ROWS + 1), lastColumn).getValues();
    var indexes = resolveHeaderIndexes_(values[0]);
    if (!indexes) {
      return jsonResponse_({ ok: false, error: "Required sensor columns are missing." });
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
        rejected: rejected
      }
    });
  } catch (error) {
    return jsonResponse_({ ok: false, error: "Sensor data is temporarily unavailable." });
  }
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
  var parsed = typeof value === "number" ? value : Number(value);
  return isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
