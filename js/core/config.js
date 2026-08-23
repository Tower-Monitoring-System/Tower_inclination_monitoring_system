export const APP_CONFIG = Object.freeze({
  refreshIntervalMs: 8000,
  relativeTimeIntervalMs: 15000,
  dashboardRevealTimeoutMs: 2000,
  manualRefreshDelayMs: 480,
  automaticRefreshDelayMs: 260,
  analyticsTransitionMs: 280,
  toastDurationMs: 3600,
  resizeDebounceMs: 100
});

export const API_CONFIG = Object.freeze({
  useMockData: true,
  baseUrl: "",
  dashboardPath: "",
  timeoutMs: 8000,
  mockLatencyMs: 120
});

export const MQTT_CONFIG = Object.freeze({
  enabled: false,
  webSocketUrl: "",
  topics: Object.freeze(["tower/+/sensor"]),
  reconnectDelayMs: 5000
});

export const SUPABASE_CONFIG = Object.freeze({
  url: "https://ruwchblgpynvfwmvrgpj.supabase.co",
  publishableKey: "sb_publishable_uYIKwgig--EPLHTEXcoBFA_RLS0gZWR"
});

