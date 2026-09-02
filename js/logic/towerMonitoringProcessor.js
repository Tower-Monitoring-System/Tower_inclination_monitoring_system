import { STATION_STATUS } from "../core/constants.js";
import { createAlertConfiguration } from "../core/settingsDefaults.js?v=20260902.2";
import {
  assessOrientation,
  calculateOrientationVector,
  createRollingOrientationReadings,
  formatTiltDirection
} from "./orientationAveraging.js?v=20260902.2";

const VALID_PERIODS = new Set(["day", "month", "custom"]);

function finiteAxis(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < -180 || parsed > 180) {
    throw new TypeError(`${fieldName} must be a finite value between -180 and 180 degrees.`);
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

function optionalBattery(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = typeof value === "string" ? Number(value.replace(",", ".")) : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 24) {
    throw new TypeError("Battery voltage must be a finite value between 0 and 24 volts.");
  }
  return parsed;
}

function optionalIsoDate(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new TypeError("Tower reading date must use the YYYY-MM-DD format.");
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() !== Number(match[2]) - 1
    || date.getUTCDate() !== Number(match[3])
  ) {
    throw new TypeError("Tower reading date is invalid.");
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
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
    battery: optionalBattery(packet.battery ?? packet.voltage),
    date: optionalIsoDate(packet.date),
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

export function filterTowerReadings(readings, filter = {}) {
  if (!Array.isArray(readings)) {
    return [];
  }
  const period = VALID_PERIODS.has(filter.period) ? filter.period : "day";

  return readings.filter((reading) => {
    const readingDate = reading.date || localIsoDate(reading.timestamp);
    if (period === "month") {
      return readingDate.slice(0, 7) === filter.month;
    }
    if (period === "custom") {
      return Boolean(filter.startDate && filter.endDate)
        && readingDate >= filter.startDate
        && readingDate <= filter.endDate;
    }
    return readingDate === filter.day;
  });
}

export function calculateResultantTilt(reading, options = {}) {
  if (!reading) {
    return 0;
  }
  return calculateOrientationVector(
    { ...reading, timestamp: reading.timestamp ?? 0 },
    options.calibration,
    options.axisMapping
  ).tiltDegrees;
}

export function calculateTiltDirection(reading, options = {}) {
  if (!reading) {
    return "No direction";
  }
  return formatTiltDirection(calculateOrientationVector(
    { ...reading, timestamp: reading.timestamp ?? 0 },
    options.calibration,
    options.axisMapping
  ));
}

export function getTowerSeverity(assessment, online = true) {
  if (!online) {
    return STATION_STATUS.OFFLINE;
  }
  if (assessment?.level === "critical") {
    return STATION_STATUS.ALERT;
  }
  if (assessment?.level === "warning") {
    return STATION_STATUS.WARNING;
  }
  return STATION_STATUS.NORMAL;
}

export function createTowerViewModel(station, readings, options = {}) {
  if (!station) {
    return null;
  }
  const safeReadings = Array.isArray(readings) ? readings : [];
  const configuration = options.configuration || createAlertConfiguration(options.settings);
  const averagedReadings = createRollingOrientationReadings(safeReadings, {
    calibration: configuration.calibration,
    windowSize: options.windowSize,
    maximumGapMs: options.maximumGapMs
  });
  const visibleReadings = options.filter
    ? filterTowerReadings(averagedReadings, options.filter)
    : averagedReadings;
  const latest = visibleReadings.at(-1) || null;
  const orientationVector = latest
    ? calculateOrientationVector(latest, configuration.calibration)
    : null;
  const assessment = latest
    ? assessOrientation(latest, configuration.inclination, configuration.calibration)
    : null;
  const resultant = orientationVector?.tiltDegrees || 0;

  return Object.freeze({
    station,
    latest,
    resultant,
    orientationVector,
    assessment,
    direction: formatTiltDirection(orientationVector),
    status: getTowerSeverity(assessment, Boolean(station.online && latest))
  });
}
