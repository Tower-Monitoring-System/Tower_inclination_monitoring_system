import { STATION_STATUS, WARNING_THRESHOLDS } from "../core/constants.js";

const VALID_PERIODS = new Set(["day", "month", "custom"]);

function finiteAxis(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < -90 || parsed > 90) {
    throw new TypeError(`${fieldName} must be a finite value between -90 and 90 degrees.`);
  }
  return parsed;
}

function validTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new TypeError("Tower reading timestamp is invalid.");
  }
  return timestamp;
}

export function localIsoDate(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shiftLocalDate(isoDate, dayOffset) {
  const [year, month, day] = String(isoDate).split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (!Number.isFinite(date.getTime())) {
    return localIsoDate();
  }
  date.setDate(date.getDate() + dayOffset);
  return localIsoDate(date.getTime());
}

export function normalizeTowerReading(packet) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    throw new TypeError("Tower reading must be an object.");
  }
  if (typeof packet.stationId !== "string" || !packet.stationId.trim()) {
    throw new TypeError("Tower reading station id is required.");
  }

  return Object.freeze({
    stationId: packet.stationId.trim(),
    x: finiteAxis(packet.tiltX ?? packet.x, "X tilt"),
    y: finiteAxis(packet.tiltY ?? packet.y, "Y tilt"),
    z: finiteAxis(packet.tiltZ ?? packet.z ?? 0, "Z tilt"),
    timestamp: validTimestamp(packet.timestamp)
  });
}

export function mergeTowerReadings(previousReadings, incomingReadings, maximumPoints = 1440) {
  const limit = Number.isInteger(maximumPoints) && maximumPoints > 0 ? maximumPoints : 1440;
  const readingsByTimestamp = new Map();
  [...(Array.isArray(previousReadings) ? previousReadings : []), ...(Array.isArray(incomingReadings) ? incomingReadings : [])]
    .forEach((reading) => {
      const normalized = normalizeTowerReading(reading);
      readingsByTimestamp.set(normalized.timestamp, normalized);
    });

  return Object.freeze(
    [...readingsByTimestamp.values()]
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-limit)
  );
}

function localMonth(timestamp) {
  return localIsoDate(timestamp).slice(0, 7);
}

export function filterTowerReadings(readings, filter = {}) {
  if (!Array.isArray(readings)) {
    return [];
  }
  const period = VALID_PERIODS.has(filter.period) ? filter.period : "day";

  return readings.filter((reading) => {
    if (period === "month") {
      return localMonth(reading.timestamp) === filter.month;
    }
    if (period === "custom") {
      const readingDate = localIsoDate(reading.timestamp);
      return Boolean(filter.startDate && filter.endDate)
        && readingDate >= filter.startDate
        && readingDate <= filter.endDate;
    }
    return localIsoDate(reading.timestamp) === filter.day;
  });
}

export function calculateResultantTilt(reading) {
  if (!reading) {
    return 0;
  }
  return Math.hypot(Number(reading.x) || 0, Number(reading.y) || 0, Number(reading.z) || 0);
}

export function calculateTiltDirection(reading) {
  if (!reading) {
    return "No direction";
  }
  const axes = [
    { axis: "X", value: Number(reading.x) || 0 },
    { axis: "Y", value: Number(reading.y) || 0 },
    { axis: "Z", value: Number(reading.z) || 0 }
  ];
  const dominant = axes.reduce((current, axis) => (
    Math.abs(axis.value) > Math.abs(current.value) ? axis : current
  ));
  if (Math.abs(dominant.value) < 0.005) {
    return "Near vertical";
  }
  return `Toward ${dominant.value >= 0 ? "+" : "−"}${dominant.axis}`;
}

export function getTowerSeverity(resultant, online = true) {
  if (!online) {
    return STATION_STATUS.OFFLINE;
  }
  if (resultant >= WARNING_THRESHOLDS.alert) {
    return STATION_STATUS.ALERT;
  }
  if (resultant >= WARNING_THRESHOLDS.warning) {
    return STATION_STATUS.WARNING;
  }
  return STATION_STATUS.NORMAL;
}

export function createTowerViewModel(station, readings) {
  if (!station) {
    return null;
  }
  const safeReadings = Array.isArray(readings) ? readings : [];
  const latest = safeReadings.at(-1) || Object.freeze({
    stationId: station.id,
    x: Number(station.maxTilt) || 0,
    y: 0,
    z: 0,
    timestamp: 0
  });
  const resultant = calculateResultantTilt(latest);

  return Object.freeze({
    station,
    latest,
    resultant,
    direction: calculateTiltDirection(latest),
    status: getTowerSeverity(resultant, station.online)
  });
}
