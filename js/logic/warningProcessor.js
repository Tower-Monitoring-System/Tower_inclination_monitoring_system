import { STATION_STATUS, WARNING_THRESHOLDS } from "../core/constants.js";

export function getStationStatus(station) {
  if (!station.online) {
    return STATION_STATUS.OFFLINE;
  }

  if (station.maxTilt >= WARNING_THRESHOLDS.alert) {
    return STATION_STATUS.ALERT;
  }

  if (station.maxTilt >= WARNING_THRESHOLDS.warning) {
    return STATION_STATUS.WARNING;
  }

  return STATION_STATUS.NORMAL;
}

export function countStationStatuses(stations) {
  return stations.reduce(
    (counts, station) => {
      const status = station.status || getStationStatus(station);
      counts[status] += 1;
      return counts;
    },
    { normal: 0, warning: 0, alert: 0, offline: 0 }
  );
}

export function createAlerts(stations, timestamp = Date.now()) {
  return stations
    .filter((station) => station.status === STATION_STATUS.WARNING || station.status === STATION_STATUS.ALERT)
    .map((station) => ({
      id: `${station.id}-${station.status}`,
      stationId: station.id,
      severity: station.status,
      title: station.status === STATION_STATUS.ALERT ? "Inclination alert" : "Inclination warning",
      message: `${station.id} is reporting ${station.maxTilt.toFixed(2)}° maximum tilt.`,
      timestamp
    }))
    .sort((left, right) => {
      if (left.severity === right.severity) {
        return left.stationId.localeCompare(right.stationId);
      }
      return left.severity === STATION_STATUS.ALERT ? -1 : 1;
    });
}

