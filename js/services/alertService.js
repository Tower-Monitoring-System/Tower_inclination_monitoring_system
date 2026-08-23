import { ALERT_CONFIG } from "../core/config.js";
import { createAlertsFromReadings, summarizeAlerts } from "../logic/alertProcessor.js";

export class AlertService {
  constructor(sensorDataService, config = ALERT_CONFIG) {
    if (!sensorDataService || typeof sensorDataService.fetchReadings !== "function") {
      throw new TypeError("AlertService requires a SensorDataService instance.");
    }
    this.sensorDataService = sensorDataService;
    this.config = config;
  }

  async fetchAlerts() {
    const result = await this.sensorDataService.fetchReadings();
    const alerts = createAlertsFromReadings(result.readings, {
      defaultTowerId: this.config.sourceTowerId,
      maximumAlerts: this.config.maximumAlerts
    });
    return Object.freeze({
      alerts,
      summary: summarizeAlerts(alerts),
      invalidRows: result.invalidRows,
      meta: result.meta
    });
  }

  cancelActiveRequest() {
    this.sensorDataService.cancelActiveRequest();
  }

  destroy() {
    this.sensorDataService.destroy();
  }
}
