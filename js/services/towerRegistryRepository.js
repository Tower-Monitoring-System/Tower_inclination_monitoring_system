import { STORAGE_KEYS } from "../core/constants.js";

export class TowerRegistryRepository {
  constructor(browserWindow = window) {
    this.window = browserWindow;
  }

  load() {
    try {
      const serialized = this.window.localStorage.getItem(STORAGE_KEYS.towerRegistry);
      if (!serialized) {
        return [];
      }
      const parsed = JSON.parse(serialized);
      const towers = Array.isArray(parsed) ? parsed : parsed?.towers;
      return Array.isArray(towers) ? towers : [];
    } catch (error) {
      this.window.console.warn("The saved tower registry could not be read.", error);
      return [];
    }
  }

  save(towers) {
    const payload = JSON.stringify({ version: 1, towers });
    try {
      this.window.localStorage.setItem(STORAGE_KEYS.towerRegistry, payload);
    } catch (error) {
      this.window.console.warn("The tower registry could not be persisted.", error);
      throw new Error("Tower changes could not be saved in this browser.", { cause: error });
    }
  }
}
