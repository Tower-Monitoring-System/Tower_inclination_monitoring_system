export const WARNING_THRESHOLDS = Object.freeze({
  stable: 0.4,
  warning: 0.7,
  alert: 1.0
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

export const CHART_MODE = Object.freeze({
  TREND: "trend",
  DISTRIBUTION: "distribution"
});

export const RANGE_DEFINITIONS = Object.freeze({
  realtime: Object.freeze({ points: 24, label: "Live · Last 24 samples" }),
  "24h": Object.freeze({ points: 24, label: "Today · Hourly samples" }),
  "7d": Object.freeze({ points: 28, label: "Last 7 days · 6-hour samples" }),
  "30d": Object.freeze({ points: 30, label: "Last 30 days · Daily samples" }),
  custom: Object.freeze({ points: 20, label: "Custom · Last 14 days" })
});

export const CHART_COLORS = Object.freeze([
  "#2478f3",
  "#17a655",
  "#ed3548",
  "#8138e9",
  "#f28c18",
  "#16a9cf"
]);

export const DISTRIBUTION_CATEGORIES = Object.freeze([
  Object.freeze({ key: "stable", label: "Stable", shortLabel: "< 0.40°", color: "#18b77d" }),
  Object.freeze({ key: "normal", label: "Normal", shortLabel: "0.40–0.69°", color: "#2478f3" }),
  Object.freeze({ key: "warning", label: "Warning", shortLabel: "0.70–0.99°", color: "#f59e0b" }),
  Object.freeze({ key: "alert", label: "Alert", shortLabel: "≥ 1.00°", color: "#ed3548" })
]);

export const CHART_CONSTANTS = Object.freeze({
  maximumTilt: 1.4,
  maximumPixelRatio: 2,
  maximumTrendStations: 6,
  tooltipWidth: 174
});

export const STORAGE_KEYS = Object.freeze({
  session: "tower-monitor.auth-session",
  rememberedUsername: "tower-monitor.remembered-username"
});

export const DASHBOARD_ACTION = Object.freeze({
  REFRESH: "refresh",
  RANGE_CHANGE: "range-change",
  CHART_MODE_CHANGE: "chart-mode-change",
  AUTO_REFRESH_CHANGE: "auto-refresh-change",
  SIGN_OUT: "sign-out"
});

export const VALID_RANGES = Object.freeze(Object.keys(RANGE_DEFINITIONS));
export const VALID_CHART_MODES = Object.freeze(Object.values(CHART_MODE));