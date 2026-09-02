export const APP_CONFIG = Object.freeze({
  dashboardRevealTimeoutMs: 2000,
  toastDurationMs: 3600,
  resizeDebounceMs: 100
});

export const MQTT_CONFIG = Object.freeze({
  enabled: false,
  webSocketUrl: "",
  topics: Object.freeze(["tower/+/sensor"]),
  reconnectDelayMs: 5000
});

export const AUTH_CONFIG = Object.freeze({
  signInDelayMs: 250,
  redirectDelayMs: 300
});

export const SENSOR_DATA_CONFIG = Object.freeze({
  edgeFunctionName: "sensor-data",
  requestTimeoutMs: 12000,
  pollingIntervalMs: 45000,
  pageSize: 20,
  maximumRecords: 20000
});

export const ALERT_CONFIG = Object.freeze({
  sourceTowerId: "TWR-001",
  pageSize: 10,
  pollingIntervalMs: SENSOR_DATA_CONFIG.pollingIntervalMs,
  maximumAlerts: 5000
});

export const TOWERS_CONFIG = Object.freeze({
  maximumHistoryPointsPerTower: SENSOR_DATA_CONFIG.maximumRecords
});

export const ORIENTATION_CONFIG = Object.freeze({
  averageWindowSize: 3,
  maximumWindowGapMs: 90 * 60 * 1000,
  axisMapping: Object.freeze({
    rollSign: 1,
    pitchSign: 1
  })
});
