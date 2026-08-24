import { TOWERS_CONFIG } from "../core/config.js?v=20260824.2";

export class TowerHistoryService {
  constructor(sensorDataService, options = {}) {
    if (!sensorDataService || typeof sensorDataService.fetchReadings !== "function") {
      throw new TypeError("TowerHistoryService requires a SensorDataService instance.");
    }
    this.sensorDataService = sensorDataService;
    this.sourceTowerId = options.sourceTowerId || TOWERS_CONFIG.sourceTowerId;
  }

  async fetchReadings(options = {}) {
    const result = await this.sensorDataService.fetchReadings(options);
    const readings = result.readings.map((reading) => Object.freeze({
      stationId: this.sourceTowerId,
      tiltX: reading.x,
      tiltY: reading.y,
      tiltZ: reading.z,
      timestamp: reading.timestamp
    }));

    return Object.freeze({
      readings: Object.freeze(readings),
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
