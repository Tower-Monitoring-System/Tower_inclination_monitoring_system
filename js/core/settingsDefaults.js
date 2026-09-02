export const SETTINGS_LIMITS = Object.freeze({
  calibration: Object.freeze({ minimum: -180, maximum: 180 }),
  tiltThreshold: Object.freeze({ minimum: 0.1, maximum: 90 }),
  battery: Object.freeze({ minimum: 10, nominal: 12.8, maximum: 14.6, step: 0.1 }),
  alertCriticalMultiplier: 1.5
});

export const DEFAULT_SYSTEM_SETTINGS = Object.freeze({
  calibration: Object.freeze({ x: 0, y: 0, z: 0 }),
  tiltThresholds: Object.freeze({ x: 10, y: 10, z: 10 }),
  battery: Object.freeze({ minimumVoltage: SETTINGS_LIMITS.battery.nominal }),
  wifi: Object.freeze({
    ssid: "",
    password: "",
    ipMode: "dhcp",
    staticIp: "",
    gateway: "",
    subnetMask: "255.255.255.0",
    autoReconnect: true,
    connectionStatus: "disconnected"
  }),
  accessPoint: Object.freeze({
    status: "unavailable",
    ssid: "",
    password: "",
    connectionStatus: "disconnected"
  })
});

function sourceObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function mergeSystemSettings(...sources) {
  const settings = {
    calibration: { ...DEFAULT_SYSTEM_SETTINGS.calibration },
    tiltThresholds: { ...DEFAULT_SYSTEM_SETTINGS.tiltThresholds },
    battery: { ...DEFAULT_SYSTEM_SETTINGS.battery },
    wifi: { ...DEFAULT_SYSTEM_SETTINGS.wifi },
    accessPoint: { ...DEFAULT_SYSTEM_SETTINGS.accessPoint }
  };

  sources.forEach((source) => {
    const safeSource = sourceObject(source);
    settings.calibration = { ...settings.calibration, ...sourceObject(safeSource.calibration) };
    settings.tiltThresholds = { ...settings.tiltThresholds, ...sourceObject(safeSource.tiltThresholds) };
    settings.battery = { ...settings.battery, ...sourceObject(safeSource.battery) };
    settings.wifi = { ...settings.wifi, ...sourceObject(safeSource.wifi) };
    settings.accessPoint = { ...settings.accessPoint, ...sourceObject(safeSource.accessPoint) };
  });

  const minimumVoltage = Number(settings.battery.minimumVoltage);
  settings.battery.minimumVoltage = Number.isFinite(minimumVoltage) &&
    minimumVoltage >= SETTINGS_LIMITS.battery.minimum &&
    minimumVoltage <= SETTINGS_LIMITS.battery.maximum
    ? minimumVoltage
    : DEFAULT_SYSTEM_SETTINGS.battery.minimumVoltage;

  return settings;
}

export function createAlertConfiguration(settings = DEFAULT_SYSTEM_SETTINGS) {
  const normalized = mergeSystemSettings(settings);
  return Object.freeze({
    calibration: Object.freeze({ ...normalized.calibration }),
    battery: Object.freeze({
      warning: Number(normalized.battery.minimumVoltage),
      critical: SETTINGS_LIMITS.battery.minimum
    }),
    inclination: Object.freeze({
      x: Number(normalized.tiltThresholds.x),
      y: Number(normalized.tiltThresholds.y),
      z: Number(normalized.tiltThresholds.z),
      criticalMultiplier: SETTINGS_LIMITS.alertCriticalMultiplier
    })
  });
}
