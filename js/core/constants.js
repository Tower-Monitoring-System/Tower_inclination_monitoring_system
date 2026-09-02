export const ALERT_TYPE = Object.freeze({
  BATTERY: "battery",
  INCLINATION: "inclination"
});

export const ALERT_SEVERITY = Object.freeze({
  CRITICAL: "critical",
  WARNING: "warning",
  RESOLVED: "resolved"
});

export const ALERT_STATUS = Object.freeze({
  ACTIVE: "active",
  RESOLVED: "resolved"
});

export const STATION_STATUS = Object.freeze({
  NORMAL: "normal",
  WARNING: "warning",
  ALERT: "alert",
  OFFLINE: "offline"
});

export const CONNECTION_STATUS = Object.freeze({
  CONNECTING: "connecting",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  DISABLED: "disabled",
  ERROR: "error"
});

export const CHART_CONSTANTS = Object.freeze({
  maximumPixelRatio: 2
});

export const STORAGE_KEYS = Object.freeze({
  session: "tower-monitor.auth-session",
  rememberedUsername: "tower-monitor.remembered-username",
  systemSettings: "tower-monitor.system-settings.v1",
  towerRegistry: "tower-monitor.tower-registry.v1"
});

export const DASHBOARD_ACTION = Object.freeze({
  NAVIGATE: "navigate",
  SIGN_OUT: "sign-out"
});
