import { ORIENTATION_CONFIG } from "../core/config.js?v=20260902.2";

const AXES = Object.freeze(["x", "y", "z"]);
const DIRECTION_LABELS = Object.freeze([
  "+X",
  "+X / +Y",
  "+Y",
  "−X / +Y",
  "−X",
  "−X / −Y",
  "−Y",
  "+X / −Y"
]);

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizedCalibration(calibration = {}) {
  return Object.freeze({
    x: finiteNumber(calibration.x),
    y: finiteNumber(calibration.y),
    z: finiteNumber(calibration.z)
  });
}

function readingKey(reading) {
  return String(reading?.towerId ?? reading?.stationId ?? "default").trim() || "default";
}

function validOrientationReading(reading) {
  return Boolean(
    reading
    && AXES.every((axis) => Number.isFinite(Number(reading[axis])))
    && Number.isFinite(Number(reading.timestamp))
    && Number(reading.timestamp) >= 0
  );
}

function average(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function wrapDegrees180(value) {
  const degrees = Number(value);
  if (!Number.isFinite(degrees)) {
    throw new TypeError("Angle must be finite.");
  }
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

function averageWrappedAxis(readings, axis, reference) {
  let previous = reference;
  const unwrapped = readings.map((reading) => {
    const current = previous + wrapDegrees180(Number(reading[axis]) - previous);
    previous = current;
    return current;
  });
  return wrapDegrees180(average(unwrapped));
}

function averageWindow(readings, calibration) {
  const latest = readings.at(-1);
  return Object.freeze({
    ...latest,
    x: averageWrappedAxis(readings, "x", calibration.x),
    y: averageWrappedAxis(readings, "y", calibration.y),
    z: average(readings.map((reading) => Number(reading.z))),
    timestamp: Number(latest.timestamp),
    averageSampleCount: readings.length
  });
}

export function createRollingOrientationReadings(readings, options = {}) {
  if (!Array.isArray(readings)) {
    throw new TypeError("Orientation averaging requires an array of readings.");
  }

  const windowSize = Number.isInteger(options.windowSize) && options.windowSize > 0
    ? options.windowSize
    : ORIENTATION_CONFIG.averageWindowSize;
  const maximumGapMs = Number.isFinite(Number(options.maximumGapMs)) && Number(options.maximumGapMs) >= 0
    ? Number(options.maximumGapMs)
    : ORIENTATION_CONFIG.maximumWindowGapMs;
  const calibration = normalizedCalibration(options.calibration);
  const windowsByTower = new Map();

  return readings
    .map((reading, inputIndex) => ({ reading, inputIndex }))
    .filter(({ reading }) => validOrientationReading(reading))
    .sort((left, right) => (
      Number(left.reading.timestamp) - Number(right.reading.timestamp)
      || left.inputIndex - right.inputIndex
    ))
    .map(({ reading }) => {
      const key = readingKey(reading);
      const timestamp = Number(reading.timestamp);
      let state = windowsByTower.get(key);
      if (!state || timestamp - state.lastTimestamp > maximumGapMs) {
        state = { readings: [], lastTimestamp: timestamp };
      }

      state.readings.push(reading);
      if (state.readings.length > windowSize) {
        state.readings.shift();
      }
      state.lastTimestamp = timestamp;
      windowsByTower.set(key, state);
      return averageWindow(state.readings, calibration);
    });
}

export function getLatestAveragedOrientation(readings, options = {}) {
  return createRollingOrientationReadings(readings, options).at(-1) || null;
}

export function calculateTiltComponents(reading, calibration = {}) {
  if (!validOrientationReading({ ...reading, timestamp: reading?.timestamp ?? 0 })) {
    throw new TypeError("Tilt components require finite X, Y, and Z values.");
  }
  const initial = normalizedCalibration(calibration);
  return Object.freeze({
    x: Math.abs(wrapDegrees180(Number(reading.x) - initial.x)),
    y: Math.abs(wrapDegrees180(Number(reading.y) - initial.y)),
    z: Math.abs(Number(reading.z) - initial.z)
  });
}

export function assessOrientation(reading, thresholds = {}, calibration = {}) {
  const components = calculateTiltComponents(reading, calibration);
  const criticalMultiplier = finiteNumber(thresholds.criticalMultiplier, 1.5);
  const ranked = AXES.map((axis, priority) => {
    const threshold = Number(thresholds[axis]);
    const safeThreshold = Number.isFinite(threshold) && threshold > 0 ? threshold : Number.POSITIVE_INFINITY;
    return Object.freeze({
      axis,
      priority,
      value: components[axis],
      threshold: safeThreshold,
      ratio: components[axis] / safeThreshold
    });
  }).sort((left, right) => {
    const ratioDifference = right.ratio - left.ratio;
    return Math.abs(ratioDifference) > 1e-10
      ? ratioDifference
      : left.priority - right.priority;
  });
  const highest = ranked[0];
  const level = highest.ratio >= criticalMultiplier
    ? "critical"
    : highest.ratio >= 1
      ? "warning"
      : "normal";
  const ratios = Object.freeze(Object.fromEntries(ranked.map(({ axis, ratio }) => [axis, ratio])));

  return Object.freeze({
    components,
    ratios,
    maximumRatio: highest.ratio,
    axis: highest.axis,
    value: highest.value,
    threshold: highest.threshold,
    criticalMultiplier,
    level
  });
}

export function calculateOrientationVector(reading, calibration = {}, axisMapping = ORIENTATION_CONFIG.axisMapping) {
  const components = calculateTiltComponents(reading, calibration);
  const initial = normalizedCalibration(calibration);
  const rollSign = finiteNumber(axisMapping?.rollSign, 1) < 0 ? -1 : 1;
  const pitchSign = finiteNumber(axisMapping?.pitchSign, 1) < 0 ? -1 : 1;
  const rollDegrees = wrapDegrees180(Number(reading.x) - initial.x) * rollSign;
  const pitchDegrees = wrapDegrees180(Number(reading.y) - initial.y) * pitchSign;
  const roll = rollDegrees * (Math.PI / 180);
  const pitch = pitchDegrees * (Math.PI / 180);
  const x = Math.sin(pitch) * Math.cos(roll);
  const y = -Math.sin(roll);
  const z = Math.cos(pitch) * Math.cos(roll);
  const horizontalMagnitude = Math.hypot(x, y);
  const azimuthRadians = horizontalMagnitude > 1e-12 ? Math.atan2(y, x) : 0;
  const tiltDegrees = Math.acos(Math.min(1, Math.max(-1, z))) * (180 / Math.PI);

  return Object.freeze({
    x,
    y,
    z,
    rollDegrees,
    pitchDegrees,
    structuralTiltDelta: components.z,
    horizontalMagnitude,
    azimuthRadians,
    tiltDegrees
  });
}

export function formatTiltDirection(vector) {
  const x = Number(vector?.x);
  const y = Number(vector?.y);
  if (![x, y].every(Number.isFinite) || Math.hypot(x, y) < 1e-6) {
    return "Near vertical";
  }
  const angle = ((Math.atan2(y, x) * (180 / Math.PI)) + 360) % 360;
  const sector = Math.round(angle / 45) % DIRECTION_LABELS.length;
  return `Toward ${DIRECTION_LABELS[sector]}`;
}
