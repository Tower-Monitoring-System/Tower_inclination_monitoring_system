import { ALERT_CONFIG } from "../core/config.js?v=20261007.1";
import { createAlertsFromReadings, summarizeAlerts } from "../logic/alertProcessor.js?v=20260902.2";

export class AlertService {
  constructor(sensorDataService, options = {}) {
    if (!sensorDataService || typeof sensorDataService.fetchReadings !== "function") {
      throw new TypeError("AlertService requires a SensorDataService instance.");
    }
    this.sensorDataService = sensorDataService;
    this.config = options.sourceTowerId ? options : options.config || ALERT_CONFIG;
    this.settingsService = options.settingsService || null;
    this.derived = new Map();
  }

  async fetchAlerts(options = {}) {
    const towerId = typeof options.towerId === "string" ? options.towerId.trim() : "";
    if (!towerId) {
      throw new TypeError("Tower ID is required to fetch alerts.");
    }
    const result = await this.sensorDataService.fetchReadings({ ...options, towerId });
    return this.derive(towerId, result);
  }

  derive(towerId, result) {
    const configuration = this.settingsService?.getAlertConfiguration();
    const settingsKey = JSON.stringify(configuration);
    const cached = this.derived.get(towerId);
    const alerts = cached?.readings === result.readings && cached.settingsKey === settingsKey
      ? cached.alerts : createAlertsFromReadings(result.readings, {
      defaultTowerId: towerId,
      maximumAlerts: this.config.maximumAlerts,
      configuration
    });
    this.derived.delete(towerId);
    this.derived.set(towerId, { readings: result.readings, settingsKey, alerts });
    if (this.derived.size > 8) this.derived.delete(this.derived.keys().next().value);
    return Object.freeze({
      alerts,
      summary: summarizeAlerts(alerts),
      invalidRows: result.invalidRows,
      meta: result.meta
    });
  }

  subscribe(towerId, listener) {
    return this.sensorDataService.subscribe(towerId, update => {
      listener({ ...update, result: update.result ? this.derive(towerId, update.result) : null });
    });
  }

  destroy() {
    this.derived.clear();
  }
}
