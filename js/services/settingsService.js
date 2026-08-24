import { createStore } from "../core/store.js";
import {
  DEFAULT_SYSTEM_SETTINGS,
  createAlertConfiguration,
  mergeSystemSettings
} from "../core/settingsDefaults.js";
import { validateSystemSettings } from "../logic/settingsValidation.js";
import { Esp32SettingsAdapter } from "./esp32SettingsAdapter.js";
import { SettingsRepository } from "./settingsRepository.js";

export class SettingsValidationError extends Error {
  constructor(errors) {
    super("System settings contain invalid values.");
    this.name = "SettingsValidationError";
    this.errors = errors;
  }
}

export class SettingsService {
  constructor(options = {}) {
    this.repository = options.repository || new SettingsRepository(options.windowRef);
    this.adapter = options.adapter || new Esp32SettingsAdapter(options);
    this.store = createStore({
      settings: mergeSystemSettings(DEFAULT_SYSTEM_SETTINGS),
      initialized: false,
      loading: false,
      saving: false,
      error: null
    });
    this.initializePromise = null;
  }

  getState() {
    return this.store.getState();
  }

  getSettings() {
    return mergeSystemSettings(this.store.getState().settings);
  }

  getAlertConfiguration() {
    return createAlertConfiguration(this.store.getState().settings);
  }

  getBatteryThresholds() {
    const battery = this.getAlertConfiguration().battery;
    return Object.freeze({ warning: battery.warning, critical: battery.critical });
  }

  subscribe(callback, options) {
    return this.store.subscribe(callback, options);
  }

  async initialize() {
    if (this.initializePromise) {
      return this.initializePromise;
    }
    this.store.setState({ loading: true, error: null });
    this.initializePromise = (async () => {
      try {
        const deviceSettings = await this.adapter.readSettings();
        const savedSettings = this.repository.load();
        const settings = mergeSystemSettings(DEFAULT_SYSTEM_SETTINGS, deviceSettings, savedSettings);
        this.store.setState({ settings, initialized: true, loading: false, error: null });
        return this.getSettings();
      } catch (error) {
        this.store.setState({ initialized: true, loading: false, error: error.message });
        return this.getSettings();
      } finally {
        this.initializePromise = null;
      }
    })();
    return this.initializePromise;
  }

  validate(settings) {
    return validateSystemSettings(settings);
  }

  async save(settings) {
    const validation = this.validate(settings);
    if (!validation.valid) {
      throw new SettingsValidationError(validation.errors);
    }

    this.store.setState({ saving: true, error: null });
    try {
      const savedSettings = await this.adapter.saveSettings(validation.settings);
      this.repository.save(savedSettings);
      this.store.setState({ settings: savedSettings, saving: false, error: null });
      return this.getSettings();
    } catch (error) {
      this.store.setState({ saving: false, error: error.message });
      throw error;
    }
  }

  readCurrentTilt() {
    return this.adapter.readCurrentTilt();
  }

  resetCalibration() {
    return { ...DEFAULT_SYSTEM_SETTINGS.calibration };
  }

  testConnection(wifiSettings) {
    return this.adapter.testConnection(wifiSettings);
  }

  connectAccessPoint() {
    return this.adapter.connectAccessPoint();
  }

  destroy() {
    this.adapter.destroy?.();
  }
}
