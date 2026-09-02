import {
  ALERT_SEVERITY,
  ALERT_STATUS,
  ALERT_TYPE
} from "../core/constants.js";
import { createAlertConfiguration } from "../core/settingsDefaults.js?v=20260902.2";
import {
  assessOrientation,
  calculateOrientationVector,
  calculateTiltComponents,
  createRollingOrientationReadings
} from "./orientationAveraging.js?v=20260902.2";

export { calculateTiltComponents };

const VALID_TYPES = new Set(["all", ...Object.values(ALERT_TYPE)]);
const VALID_SEVERITIES = new Set(["all", ...Object.values(ALERT_SEVERITY)]);
const VALID_SORTS = new Set(["newest", "oldest"]);

function hashAlertKey(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(7, "0");
}

function createAlertId(towerId, type, timestamp) {
  return `ALT-${hashAlertKey(`${towerId}|${type}|${timestamp}`)}`;
}

function severityRank(severity) {
  return severity === ALERT_SEVERITY.CRITICAL ? 2 : severity === ALERT_SEVERITY.WARNING ? 1 : 0;
}

function batterySeverity(voltage, thresholds) {
  if (voltage < thresholds.critical) {
    return ALERT_SEVERITY.CRITICAL;
  }
  if (voltage < thresholds.warning) {
    return ALERT_SEVERITY.WARNING;
  }
  return null;
}

export function calculateInclinationDegrees(reading) {
  return calculateOrientationVector(
    { ...reading, timestamp: reading?.timestamp ?? 0 }
  ).tiltDegrees;
}

function inclinationMeasurement(reading, thresholds, calibration) {
  const assessment = assessOrientation(reading, thresholds, calibration);
  return Object.freeze({
    axis: assessment.axis,
    value: assessment.value,
    threshold: assessment.threshold,
    severity: assessment.level === "critical"
      ? ALERT_SEVERITY.CRITICAL
      : assessment.level === "warning"
        ? ALERT_SEVERITY.WARNING
        : null
  });
}

function alertMessage(type, severity, measurement, threshold, axis) {
  if (type === ALERT_TYPE.BATTERY) {
    const level = severity === ALERT_SEVERITY.CRITICAL ? "critically low" : "low";
    return `Battery voltage is ${level} at ${measurement.toFixed(2)} V (threshold ${threshold.toFixed(2)} V).`;
  }
  const level = severity === ALERT_SEVERITY.CRITICAL ? "critical" : "warning";
  return `${String(axis || "").toUpperCase()}-axis inclination reached ${level} level at ${measurement.toFixed(2)}° (threshold ${threshold.toFixed(2)}°).`;
}

function resolvedMessage(type, measurement) {
  return type === ALERT_TYPE.BATTERY
    ? `Battery voltage recovered to ${measurement.toFixed(2)} V.`
    : `Tower inclination returned to ${measurement.toFixed(2)}° within the safe range.`;
}

function createAlert({ towerId, type, reading, severity, measurement, threshold, axis }) {
  return {
    id: createAlertId(towerId, type, reading.timestamp),
    towerId,
    type,
    message: alertMessage(type, severity, measurement, threshold, axis),
    timestamp: reading.timestamp,
    updatedAt: reading.timestamp,
    resolvedAt: null,
    severity,
    peakSeverity: severity,
    status: ALERT_STATUS.ACTIVE,
    measurement,
    threshold,
    axis: axis || null
  };
}

function updateOpenAlert(alert, reading, severity, measurement, threshold, axis) {
  alert.updatedAt = reading.timestamp;
  alert.severity = severity;
  alert.message = alertMessage(alert.type, severity, measurement, threshold, axis);
  alert.measurement = measurement;
  alert.threshold = threshold;
  alert.axis = axis || null;
  if (severityRank(severity) > severityRank(alert.peakSeverity)) {
    alert.peakSeverity = severity;
  }
}

function resolveOpenAlert(alert, reading, measurement) {
  alert.updatedAt = reading.timestamp;
  alert.resolvedAt = reading.timestamp;
  alert.status = ALERT_STATUS.RESOLVED;
  alert.severity = ALERT_SEVERITY.RESOLVED;
  alert.measurement = measurement;
  alert.message = resolvedMessage(alert.type, measurement);
}

function uniqueChronologicalReadings(readings) {
  const unique = new Map();
  readings.forEach((reading) => {
    const key = [reading.towerId || "", reading.timestamp].join("|");
    unique.set(key, reading);
  });
  return [...unique.values()].sort((left, right) => left.timestamp - right.timestamp);
}

export function createAlertsFromReadings(readings, options = {}) {
  if (!Array.isArray(readings)) {
    throw new TypeError("Alert processing requires an array of sensor readings.");
  }

  const configuration = options.configuration || options.thresholds || createAlertConfiguration();
  const defaultTowerId = typeof options.defaultTowerId === "string" && options.defaultTowerId.trim()
    ? options.defaultTowerId.trim()
    : "Sensor tower";
  const maximumAlerts = Number.isInteger(options.maximumAlerts) && options.maximumAlerts > 0
    ? options.maximumAlerts
    : 5000;
  const openAlerts = new Map();
  const alerts = [];

  const averagedReadings = createRollingOrientationReadings(
    uniqueChronologicalReadings(readings),
    { calibration: configuration.calibration }
  );

  averagedReadings.forEach((reading) => {
    const towerId = typeof reading.towerId === "string" && reading.towerId.trim()
      ? reading.towerId.trim()
      : defaultTowerId;
    const inclination = inclinationMeasurement(
      reading,
      configuration.inclination,
      configuration.calibration
    );
    const measurements = [
      {
        type: ALERT_TYPE.BATTERY,
        value: reading.battery,
        severity: batterySeverity(reading.battery, configuration.battery),
        threshold: reading.battery < configuration.battery.critical
          ? configuration.battery.critical
          : configuration.battery.warning,
        axis: null
      },
      {
        type: ALERT_TYPE.INCLINATION,
        value: inclination.value,
        severity: inclination.severity,
        threshold: inclination.threshold,
        axis: inclination.axis
      }
    ];

    measurements.forEach(({ type, value, severity, threshold, axis }) => {
      const eventKey = `${towerId}|${type}`;
      const openAlert = openAlerts.get(eventKey);
      if (severity) {
        if (openAlert) {
          updateOpenAlert(openAlert, reading, severity, value, threshold, axis);
        } else {
          const alert = createAlert({ towerId, type, reading, severity, measurement: value, threshold, axis });
          alerts.push(alert);
          openAlerts.set(eventKey, alert);
        }
      } else if (openAlert) {
        resolveOpenAlert(openAlert, reading, value);
        openAlerts.delete(eventKey);
      }
    });
  });

  return Object.freeze(
    alerts.slice(-maximumAlerts).map((alert) => Object.freeze({ ...alert }))
  );
}

export function summarizeAlerts(alerts) {
  return Object.freeze({
    total: alerts.length,
    critical: alerts.filter(
      (alert) => alert.status === ALERT_STATUS.ACTIVE && alert.severity === ALERT_SEVERITY.CRITICAL
    ).length,
    battery: alerts.filter(
      (alert) => alert.status === ALERT_STATUS.ACTIVE && alert.type === ALERT_TYPE.BATTERY
    ).length,
    inclination: alerts.filter(
      (alert) => alert.status === ALERT_STATUS.ACTIVE && alert.type === ALERT_TYPE.INCLINATION
    ).length
  });
}

export function filterAndSortAlerts(alerts, filters = {}) {
  const type = VALID_TYPES.has(filters.type) ? filters.type : "all";
  const severity = VALID_SEVERITIES.has(filters.severity) ? filters.severity : "all";
  const sort = VALID_SORTS.has(filters.sort) ? filters.sort : "newest";
  const multiplier = sort === "oldest" ? 1 : -1;

  return alerts
    .filter((alert) => type === "all" || alert.type === type)
    .filter((alert) => {
      if (severity === "all") {
        return true;
      }
      if (severity === ALERT_SEVERITY.RESOLVED) {
        return alert.status === ALERT_STATUS.RESOLVED;
      }
      return alert.status === ALERT_STATUS.ACTIVE && alert.severity === severity;
    })
    .slice()
    .sort((left, right) => ((left.updatedAt || left.timestamp) - (right.updatedAt || right.timestamp)) * multiplier);
}

export function paginateAlerts(alerts, requestedPage, pageSize) {
  const safePageSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 10;
  const pageCount = Math.max(1, Math.ceil(alerts.length / safePageSize));
  const page = Math.min(Math.max(1, Number(requestedPage) || 1), pageCount);
  const startIndex = (page - 1) * safePageSize;
  return Object.freeze({
    page,
    pageCount,
    startIndex,
    endIndex: Math.min(startIndex + safePageSize, alerts.length),
    rows: alerts.slice(startIndex, startIndex + safePageSize)
  });
}
