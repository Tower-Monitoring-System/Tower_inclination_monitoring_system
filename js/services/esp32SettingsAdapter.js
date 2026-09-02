import {
  DEFAULT_SYSTEM_SETTINGS,
  mergeSystemSettings
} from "../core/settingsDefaults.js?v=20260902.2";

export class Esp32SettingsAdapter {
  constructor(options = {}) {
    this.window = options.windowRef || window;
    this.sensorProvider = typeof options.sensorProvider === "function" ? options.sensorProvider : () => null;
    this.latencyMs = Number(options.latencyMs) || 180;
    this.settings = mergeSystemSettings(DEFAULT_SYSTEM_SETTINGS, options.initialSettings);
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
    const reading = this.sensorProvider();
    if (!reading) {
      throw new Error("No validated reading is available for the selected tower.");
    }
    const values = {
      x: Number(reading.tiltX ?? reading.x),
      y: Number(reading.tiltY ?? reading.y),
      z: Number(reading.tiltZ ?? reading.z)
    };
    if (!Object.values(values).every(Number.isFinite)) {
      throw new TypeError("The selected tower does not have valid X, Y, and Z telemetry.");
    }
    return Object.freeze({
      ...values
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
