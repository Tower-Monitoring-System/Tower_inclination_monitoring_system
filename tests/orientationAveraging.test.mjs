import test from "node:test";
import assert from "node:assert/strict";

import { ALERT_SEVERITY, ALERT_STATUS, ALERT_TYPE } from "../js/core/constants.js";
import {
  assessOrientation,
  calculateOrientationVector,
  createRollingOrientationReadings,
  formatTiltDirection
} from "../js/logic/orientationAveraging.js";
import { createAlertsFromReadings } from "../js/logic/alertProcessor.js";
import { createTowerViewModel } from "../js/logic/towerMonitoringProcessor.js";
import { Esp32SettingsAdapter } from "../js/services/esp32SettingsAdapter.js";
import { SettingsRepository } from "../js/services/settingsRepository.js";

const HOUR = 60 * 60 * 1000;
const CALIBRATION = Object.freeze({ x: 0, y: 0, z: 0 });
const THRESHOLDS = Object.freeze({ x: 0.5, y: 0.5, z: 0.5, criticalMultiplier: 1.5 });
const CONFIGURATION = Object.freeze({
  calibration: CALIBRATION,
  inclination: THRESHOLDS,
  battery: Object.freeze({ warning: 12.8, critical: 10 })
});

function reading(x, y = 0, z = Math.abs(x), timestamp = 0, towerId = "TWR-001") {
  return Object.freeze({ towerId, stationId: towerId, x, y, z, battery: 13.2, timestamp });
}

function latestAverage(values, calibration = CALIBRATION) {
  return createRollingOrientationReadings(
    values.map((value, index) => reading(value, 0, Math.abs(value), index * HOUR)),
    { calibration }
  ).at(-1);
}

test("0.30 degree delta stays normal at a 0.50 degree threshold", () => {
  assert.equal(assessOrientation(reading(0.3, 0, 0), THRESHOLDS, CALIBRATION).level, "normal");
});

test("0.55 degree X delta produces an X warning", () => {
  const result = assessOrientation(reading(0.55, 0, 0), THRESHOLDS, CALIBRATION);
  assert.equal(result.level, "warning");
  assert.equal(result.axis, "x");
});

test("exactly 0.50 degree delta enters warning at Rmax 1", () => {
  const result = assessOrientation(reading(0.5, 0, 0), THRESHOLDS, CALIBRATION);
  assert.equal(result.level, "warning");
  assert.ok(Math.abs(result.maximumRatio - 1) < 1e-12);
});

test("exactly 0.75 degree delta enters critical at Rmax 1.5", () => {
  const result = assessOrientation(reading(0.75, 0, 0), THRESHOLDS, CALIBRATION);
  assert.equal(result.level, "critical");
  assert.ok(Math.abs(result.maximumRatio - 1.5) < 1e-12);
});

test("0.80 degree X delta is critical because Rmax is 1.6", () => {
  const result = assessOrientation(reading(0.8, 0, 0), THRESHOLDS, CALIBRATION);
  assert.equal(result.level, "critical");
  assert.ok(Math.abs(result.maximumRatio - 1.6) < 1e-12);
});

test("one spike is suppressed when the three-sample average remains below threshold", () => {
  const values = [0.1, 0.1, 1].map((value, index) => reading(value, 0, value, index * HOUR));
  const averaged = createRollingOrientationReadings(values, { calibration: CALIBRATION });
  assert.ok(Math.abs(averaged.at(-1).x - 0.4) < 1e-12);
  const alerts = createAlertsFromReadings(values, { configuration: CONFIGURATION });
  assert.equal(alerts.filter((alert) => alert.type === ALERT_TYPE.INCLINATION).length, 0);
});

test("sustained 0.60 to 0.70 degree movement produces an active warning", () => {
  const values = [0.6, 0.7, 0.65].map((value, index) => reading(value, 0, value, index * HOUR));
  const alert = createAlertsFromReadings(values, { configuration: CONFIGURATION })
    .find((item) => item.type === ALERT_TYPE.INCLINATION);
  assert.equal(alert?.status, ALERT_STATUS.ACTIVE);
  assert.equal(alert?.severity, ALERT_SEVERITY.WARNING);
});

test("non-zero Initial X of 1.20 with average 1.60 is normal", () => {
  const calibration = { x: 1.2, y: 0, z: 0 };
  assert.equal(assessOrientation(reading(1.6, 0, 0), THRESHOLDS, calibration).level, "normal");
});

test("non-zero Initial X of 1.20 with average 1.80 is warning", () => {
  const calibration = { x: 1.2, y: 0, z: 0 };
  const result = assessOrientation(reading(1.8, 0, 0), THRESHOLDS, calibration);
  assert.equal(result.level, "warning");
  assert.ok(Math.abs(result.components.x - 0.6) < 1e-12);
});

test("positive Roll tilts the vector toward negative Y without yaw rotation", () => {
  const vector = calculateOrientationVector(reading(5, 0, 5));
  assert.ok(Math.abs(vector.x) < 1e-12);
  assert.ok(vector.y < 0);
  assert.equal(formatTiltDirection(vector), "Toward −Y");
});

test("positive Pitch tilts the vector toward positive X", () => {
  const vector = calculateOrientationVector(reading(0, 5, 5));
  assert.ok(vector.x > 0);
  assert.ok(Math.abs(vector.y) < 1e-12);
  assert.equal(formatTiltDirection(vector), "Toward +X");
});

test("negative Roll and Pitch preserve the opposite two mounting directions", () => {
  assert.equal(formatTiltDirection(calculateOrientationVector(reading(-5, 0, 5))), "Toward +Y");
  assert.equal(formatTiltDirection(calculateOrientationVector(reading(0, -5, 5))), "Toward −X");
});

test("changing structural Z does not rotate or alter the physical vector", () => {
  const first = calculateOrientationVector(reading(4, -3, 0));
  const second = calculateOrientationVector(reading(4, -3, 80));
  assert.deepEqual(
    [first.x, first.y, first.z, first.azimuthRadians, first.tiltDegrees],
    [second.x, second.y, second.z, second.azimuthRadians, second.tiltDegrees]
  );
});

test("physical resultant is derived from Roll and Pitch, not hypot(X,Y,Z)", () => {
  const vector = calculateOrientationVector(reading(3, 4, 5));
  assert.ok(Math.abs(vector.tiltDegrees - Math.hypot(3, 4, 5)) > 1);
  assert.ok(Math.abs(vector.tiltDegrees - 5) < 0.01);
});

test("saved calibration and thresholds survive a repository reload", () => {
  const storage = new Map();
  const browserWindow = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value)
    },
    console
  };
  const settings = {
    calibration: { x: 1.2, y: -0.4, z: 1.3 },
    tiltThresholds: { x: 0.5, y: 0.5, z: 0.5 }
  };
  new SettingsRepository(browserWindow).save(settings);
  assert.deepEqual(new SettingsRepository(browserWindow).load(), settings);
});

test("Towers and Alerts use the same three-sample average and thresholds", () => {
  const values = [0.4, 0.6, 0.8].map((value, index) => reading(value, 0, value, index * HOUR));
  const tower = createTowerViewModel(
    { id: "TWR-001", online: true },
    values,
    { fallbackToStation: false, configuration: CONFIGURATION }
  );
  const alert = createAlertsFromReadings(values, { configuration: CONFIGURATION })
    .find((item) => item.type === ALERT_TYPE.INCLINATION);
  assert.ok(Math.abs(tower.latest.x - 0.6) < 1e-12);
  assert.equal(tower.assessment.level, "warning");
  assert.equal(alert?.severity, ALERT_SEVERITY.WARNING);
});

test("a new Settings configuration immediately changes Towers and Alerts together", () => {
  const values = [0.6, 0.6, 0.6].map((value, index) => reading(value, 0, 0, index * HOUR));
  const station = { id: "TWR-001", online: true };
  const normalConfiguration = {
    ...CONFIGURATION,
    inclination: { ...THRESHOLDS, x: 1 }
  };
  const recalibratedConfiguration = {
    ...CONFIGURATION,
    calibration: { x: 0.6, y: 0, z: 0 }
  };
  const normal = createTowerViewModel(station, values, { configuration: normalConfiguration });
  const warning = createTowerViewModel(station, values, { configuration: CONFIGURATION });
  const recalibrated = createTowerViewModel(station, values, {
    configuration: recalibratedConfiguration
  });
  const normalAlerts = createAlertsFromReadings(values, { configuration: normalConfiguration });
  const warningAlerts = createAlertsFromReadings(values, { configuration: CONFIGURATION });
  const recalibratedAlerts = createAlertsFromReadings(values, {
    configuration: recalibratedConfiguration
  });
  assert.equal(normal.assessment.level, "normal");
  assert.equal(warning.assessment.level, "warning");
  assert.equal(recalibrated.assessment.level, "normal");
  assert.equal(normalAlerts.some((item) => item.type === ALERT_TYPE.INCLINATION), false);
  assert.equal(
    warningAlerts.find((item) => item.type === ALERT_TYPE.INCLINATION)?.severity,
    ALERT_SEVERITY.WARNING
  );
  assert.equal(recalibratedAlerts.some((item) => item.type === ALERT_TYPE.INCLINATION), false);
});

test("a gap over 90 minutes starts a new progressive-average segment", () => {
  const averaged = createRollingOrientationReadings([
    reading(0.1, 0, 0.1, 0),
    reading(0.2, 0, 0.2, HOUR),
    reading(0.9, 0, 0.9, 3 * HOUR)
  ]);
  assert.equal(averaged.at(-1).averageSampleCount, 1);
  assert.ok(Math.abs(averaged.at(-1).x - 0.9) < 1e-12);
});

test("X and Y averages unwrap safely around the -180/180 boundary", () => {
  const calibration = { x: 179, y: -179, z: 0 };
  const averaged = createRollingOrientationReadings([
    reading(179, -179, 1, 0),
    reading(-179, 179, 1, HOUR)
  ], { calibration }).at(-1);
  assert.ok(Math.abs(Math.abs(averaged.x) - 180) < 1e-12);
  assert.ok(Math.abs(Math.abs(averaged.y) - 180) < 1e-12);
});

test("invalid orientation rows are excluded from the average", () => {
  const averaged = createRollingOrientationReadings([
    reading(0.2, 0, 0.2, 0),
    { ...reading(9, 0, 9, HOUR), x: Number.NaN },
    reading(0.4, 0, 0.4, 2 * HOUR)
  ]);
  assert.equal(averaged.length, 2);
  assert.equal(averaged.at(-1).averageSampleCount, 1);
  assert.ok(Math.abs(averaged.at(-1).x - 0.4) < 1e-12);
});

test("calibration reads validated telemetry and never falls back to mock orientation", async () => {
  const browserWindow = { setTimeout, clearTimeout, console };
  const unavailable = new Esp32SettingsAdapter({
    windowRef: browserWindow,
    latencyMs: 1,
    sensorProvider: () => null
  });
  await assert.rejects(
    unavailable.readCurrentTilt(),
    /No validated reading is available/
  );

  const available = new Esp32SettingsAdapter({
    windowRef: browserWindow,
    latencyMs: 1,
    sensorProvider: () => ({ tiltX: 1.2, tiltY: -0.4, tiltZ: 1.3 })
  });
  assert.deepEqual(
    await available.readCurrentTilt(),
    { x: 1.2, y: -0.4, z: 1.3 }
  );
});
