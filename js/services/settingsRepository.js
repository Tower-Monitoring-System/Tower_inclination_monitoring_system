import { STORAGE_KEYS } from "../core/constants.js";
export class SettingsRepository {
  constructor(browserWindow = window) {
    this.window = browserWindow;
  }

  load() {
    try {
      const serialized = this.window.localStorage.getItem(STORAGE_KEYS.systemSettings);
      const parsed = serialized ? JSON.parse(serialized) : null;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch (error) {
      this.window.console.warn("Saved system settings could not be read.", error);
      return null;
    }
  }

  save(settings) {
    const safeSettings = JSON.parse(JSON.stringify(settings));
    delete safeSettings.wifi?.password;
    delete safeSettings.accessPoint?.password;
    try {
      this.window.localStorage.setItem(STORAGE_KEYS.systemSettings, JSON.stringify(safeSettings));
      return true;
    } catch (error) {
      this.window.console.warn("System settings could not be persisted locally.", error);
      return false;
    }
  }
}
