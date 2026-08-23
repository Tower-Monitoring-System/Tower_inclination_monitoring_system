import { STATION_STATUS } from "../core/constants.js";

const VALID_STATUSES = new Set(Object.values(STATION_STATUS));

function requiredString(value, fieldName, maximumLength = 120) {
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

function integer(value, fieldName, minimum, maximum) {
  const parsed = finiteNumber(value, fieldName, minimum, maximum);

  if (!Number.isInteger(parsed)) {
    throw new TypeError(`${fieldName} must be an integer.`);
  }

  return parsed;
}

function booleanValue(value, fieldName) {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === 1 || value === 0) {
    return Boolean(value);
  }

  throw new TypeError(`${fieldName} must be a boolean.`);
}

export class Station {
  constructor(rawStation) {
    if (!rawStation || typeof rawStation !== "object" || Array.isArray(rawStation)) {
      throw new TypeError("Station data must be an object.");
    }

    this.id = requiredString(rawStation.id, "Station id", 48);
    this.name = requiredString(rawStation.name, "Station name");
    this.location = requiredString(rawStation.location, "Station location");
    this.online = booleanValue(rawStation.online, "Station online state");
    this.sensors = integer(rawStation.sensors, "Station sensor count", 0, 10000);
    this.rssi = Math.round(finiteNumber(rawStation.rssi, "Station RSSI", -200, 50));
    this.battery = Math.round(finiteNumber(rawStation.battery, "Station battery", 0, 100));
    this.maxTilt = finiteNumber(rawStation.maxTilt, "Station maximum tilt", 0, 90);
    this.status = VALID_STATUSES.has(rawStation.status)
      ? rawStation.status
      : STATION_STATUS.NORMAL;

    Object.freeze(this);
  }

  static from(rawStation) {
    return rawStation instanceof Station ? rawStation : new Station(rawStation);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      location: this.location,
      online: this.online,
      sensors: this.sensors,
      rssi: this.rssi,
      battery: this.battery,
      maxTilt: this.maxTilt,
      status: this.status
    };
  }
}

