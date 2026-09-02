import {
  DEFAULT_SYSTEM_SETTINGS,
  mergeSystemSettings
} from "../core/settingsDefaults.js?v=20260902.1";

const MOCK_DEVICE_SETTINGS = Object.freeze({
  calibration: Object.freeze({ x: 0.64, y: 0, z: 0 }),
  tiltThresholds: Object.freeze({ x: 10, y: 10, z: 10 }),
  battery: DEFAULT_SYSTEM_SETTINGS.battery,
  wifi: Object.freeze({
    ssid: "TowerNet_5G",
    password: "tower-net",
    ipMode: "dhcp",
    staticIp: "192.168.1.125",
    gateway: "192.168.1.1",
    subnetMask: "255.255.255.0",
    autoReconnect: true,
    connectionStatus: "connected"
  }),
  accessPoint: Object.freeze({
    status: "broadcasting",
    ssid: "ESP32-Config-7A3B",
    password: "esp32setup",
    connectionStatus: "disconnected"
  })
});

export class Esp32SettingsAdapter {
  constructor(options = {}) {
    this.window = options.windowRef || window;
    this.sensorProvider = typeof options.sensorProvider === "function" ? options.sensorProvider : () => null;
    this.latencyMs = Number(options.latencyMs) || 180;
    this.settings = mergeSystemSettings(MOCK_DEVICE_SETTINGS);
  }

  delay() {
    return new Promise((resolve) => this.window.setTimeout(resolve, this.latencyMs));
  }

  async readSettings() {
    await this.delay();
    return mergeSystemSettings(this.settings);
  }

  async saveSettings(settings) {
    await this.delay();
    this.settings = mergeSystemSettings(this.settings, settings);
    return mergeSystemSettings(this.settings);
  }

  async readCurrentTilt() {
    await this.delay();
    const reading = this.sensorProvider() || {};
    return Object.freeze({
      x: Number(reading.tiltX ?? reading.x ?? this.settings.calibration.x),
      y: Number(reading.tiltY ?? reading.y ?? this.settings.calibration.y),
      z: Number(reading.tiltZ ?? reading.z ?? this.settings.calibration.z)
    });
  }

  async testConnection(wifiSettings) {
    await this.delay();
    const connected = Boolean(String(wifiSettings?.ssid || "").trim());
    this.settings.wifi.connectionStatus = connected ? "connected" : "disconnected";
    return Object.freeze({ connected, message: connected ? "Wi-Fi connection test succeeded." : "Wi-Fi connection test failed." });
  }

  async connectAccessPoint() {
    await this.delay();
    this.settings.accessPoint.connectionStatus = "connected";
    return Object.freeze({ connected: true, message: "Connected to the ESP32 local access point." });
  }

  destroy() {}
}
