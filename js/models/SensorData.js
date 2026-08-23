function requiredString(value, fieldName, maximumLength = 48) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }

  return value.trim().slice(0, maximumLength);
}

function finiteNumber(value, fieldName, minimum, maximum) {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${fieldName} must be a finite number between ${minimum} and ${maximum}.`);
  }

  return parsed;
}

function validTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();

  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new TypeError("Sensor timestamp is invalid.");
  }

  return timestamp;
}

export class SensorData {
  constructor(rawSensorData) {
    if (!rawSensorData || typeof rawSensorData !== "object" || Array.isArray(rawSensorData)) {
      throw new TypeError("Sensor data must be an object.");
    }

    this.stationId = requiredString(rawSensorData.stationId, "Sensor station id");
    this.tiltX = finiteNumber(rawSensorData.tiltX, "Sensor tilt X", -90, 90);
    this.tiltY = finiteNumber(rawSensorData.tiltY, "Sensor tilt Y", -90, 90);
    this.temperature = finiteNumber(rawSensorData.temperature, "Sensor temperature", -100, 200);
    this.rssi = Math.round(finiteNumber(rawSensorData.rssi, "Sensor RSSI", -200, 50));
    this.battery = Math.round(finiteNumber(rawSensorData.battery, "Sensor battery", 0, 100));
    this.timestamp = validTimestamp(rawSensorData.timestamp);

    Object.freeze(this);
  }

  static from(rawSensorData) {
    return rawSensorData instanceof SensorData ? rawSensorData : new SensorData(rawSensorData);
  }

  toJSON() {
    return {
      stationId: this.stationId,
      tiltX: this.tiltX,
      tiltY: this.tiltY,
      temperature: this.temperature,
      rssi: this.rssi,
      battery: this.battery,
      timestamp: this.timestamp
    };
  }
}

