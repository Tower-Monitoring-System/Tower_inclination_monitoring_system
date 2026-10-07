export class TowerHistoryService {
  constructor(sensorDataService) {
    if (!sensorDataService || typeof sensorDataService.fetchReadings !== "function") {
      throw new TypeError("TowerHistoryService requires a SensorDataService instance.");
    }
    this.sensorDataService = sensorDataService;
    this.derived = new WeakMap();
  }

  async fetchReadings(towerId, options = {}) {
    const requestedTowerId = typeof towerId === "string" ? towerId.trim() : "";
    if (!requestedTowerId) {
      throw new TypeError("A Tower ID is required to load Google Sheet data.");
    }
    const result = await this.sensorDataService.fetchReadings({ ...options, towerId: requestedTowerId });
    return this.derive(requestedTowerId, result);
  }

  derive(towerId, result) {
    let byTower = this.derived.get(result.readings);
    if (!byTower) { byTower = new Map(); this.derived.set(result.readings, byTower); }
    let readings = byTower.get(towerId);
    if (!readings) readings = Object.freeze(result.readings.map((reading) => Object.freeze({
      stationId: towerId,
      tiltX: reading.x,
      tiltY: reading.y,
      tiltZ: reading.z,
      battery: reading.battery,
      date: reading.date,
      time: reading.time,
      timestamp: localSensorTimestamp(reading.date, reading.time)
    })));
    byTower.set(towerId, readings);

    return Object.freeze({
      readings: Object.freeze(readings),
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
    this.derived = new WeakMap();
  }
}

function localSensorTimestamp(dateValue, timeValue) {
  const dateMatch = String(dateValue).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = String(timeValue).match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) {
    throw new TypeError("Sensor date and time are invalid.");
  }
  return new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    Number(timeMatch[3])
  ).getTime();
}
