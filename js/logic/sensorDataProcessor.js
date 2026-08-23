const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const PERIODS = new Set(["day", "month", "year"]);
const SORT_FIELDS = new Set(["date", "time"]);
const SORT_DIRECTIONS = new Set(["ascending", "descending"]);

function readField(row, fieldName) {
  if (Object.prototype.hasOwnProperty.call(row, fieldName)) {
    return row[fieldName];
  }

  const matchingKey = Object.keys(row).find(
    (key) => key.toLowerCase() === fieldName.toLowerCase()
  );
  return matchingKey ? row[matchingKey] : undefined;
}

function normalizeDate(value) {
  if (typeof value !== "string") {
    throw new TypeError("Date must use the YYYY-MM-DD format.");
  }

  const match = value.trim().match(ISO_DATE_PATTERN);
  if (!match) {
    throw new TypeError("Date must use the YYYY-MM-DD format.");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new TypeError("Date is not a valid calendar date.");
  }

  return { value: `${match[1]}-${match[2]}-${match[3]}`, timestamp };
}

function normalizeTime(value) {
  if (typeof value !== "string") {
    throw new TypeError("Time must use the HH:mm or HH:mm:ss format.");
  }

  const match = value.trim().match(TIME_PATTERN);
  if (!match) {
    throw new TypeError("Time must use the HH:mm or HH:mm:ss format.");
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw new TypeError("Time is outside the valid 24-hour range.");
  }

  return {
    value: `${match[1]}:${match[2]}:${String(seconds).padStart(2, "0")}`,
    seconds: hours * 3600 + minutes * 60 + seconds
  };
}

function normalizeNumber(value, fieldName, minimum, maximum) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${fieldName} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function normalizeSensorListRow(rawRow, index = 0) {
  if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) {
    throw new TypeError("Sensor row must be an object.");
  }

  const date = normalizeDate(readField(rawRow, "Date"));
  const time = normalizeTime(readField(rawRow, "Time"));
  const x = normalizeNumber(readField(rawRow, "X"), "X", -180, 180);
  const y = normalizeNumber(readField(rawRow, "Y"), "Y", -180, 180);
  const z = normalizeNumber(readField(rawRow, "Z"), "Z", -180, 180);
  const battery = normalizeNumber(readField(rawRow, "Battery"), "Battery", 0, 24);

  return Object.freeze({
    id: `${date.value}T${time.value}-${index}`,
    date: date.value,
    time: time.value,
    x,
    y,
    z,
    battery,
    dateTimestamp: date.timestamp,
    timeSeconds: time.seconds,
    timestamp: date.timestamp + time.seconds * 1000
  });
}

export function normalizeSensorListPayload(payload, maximumRecords = 20000) {
  const rawRows = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(rawRows)) {
    throw new TypeError("The sensor-data response does not contain a data array.");
  }
  if (rawRows.length > maximumRecords) {
    throw new RangeError(`The sensor-data response exceeds the ${maximumRecords} row limit.`);
  }

  const invalidRows = [];
  const readings = rawRows.reduce((validRows, row, index) => {
    try {
      validRows.push(normalizeSensorListRow(row, index));
    } catch (error) {
      invalidRows.push({ row: index + 1, reason: error.message });
    }
    return validRows;
  }, []);

  if (rawRows.length > 0 && readings.length === 0) {
    throw new TypeError("Every sensor-data row failed validation.");
  }

  return Object.freeze({ readings: Object.freeze(readings), invalidRows: Object.freeze(invalidRows) });
}

export function filterSensorReadings(readings, period, selectedValue) {
  if (!Array.isArray(readings) || !PERIODS.has(period) || typeof selectedValue !== "string") {
    return [];
  }

  const prefixLength = period === "day" ? 10 : period === "month" ? 7 : 4;
  const prefix = selectedValue.slice(0, prefixLength);
  if (prefix.length !== prefixLength) {
    return [];
  }

  return readings.filter((reading) => reading.date.startsWith(prefix));
}

export function sortSensorReadings(readings, field = "date", direction = "descending") {
  const safeField = SORT_FIELDS.has(field) ? field : "date";
  const safeDirection = SORT_DIRECTIONS.has(direction) ? direction : "descending";
  const multiplier = safeDirection === "ascending" ? 1 : -1;

  return readings.slice().sort((left, right) => {
    const primary = safeField === "time"
      ? left.timeSeconds - right.timeSeconds
      : left.timestamp - right.timestamp;
    const secondary = safeField === "time"
      ? left.dateTimestamp - right.dateTimestamp
      : left.timeSeconds - right.timeSeconds;
    return (primary || secondary || left.id.localeCompare(right.id)) * multiplier;
  });
}

export function paginateSensorReadings(readings, requestedPage, pageSize) {
  const safePageSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 20;
  const pageCount = Math.max(1, Math.ceil(readings.length / safePageSize));
  const page = Math.min(Math.max(1, Number(requestedPage) || 1), pageCount);
  const startIndex = (page - 1) * safePageSize;

  return Object.freeze({
    page,
    pageCount,
    startIndex,
    endIndex: Math.min(startIndex + safePageSize, readings.length),
    rows: readings.slice(startIndex, startIndex + safePageSize)
  });
}

export function getLatestReadingDate(readings) {
  return readings.reduce(
    (latest, reading) => (!latest || reading.date > latest ? reading.date : latest),
    ""
  );
}
