import { RANGE_DEFINITIONS, STATION_STATUS } from "../core/constants.js";
import { SensorData } from "../models/SensorData.js";
import { Station } from "../models/Station.js";
import {
  calculateTilt,
  clamp,
  createDistributionData,
  createTrendData,
  isSensorReadingAnomalous
} from "./tiltProcessor.js";
import { countStationStatuses, createAlerts, getStationStatus } from "./warningProcessor.js";

function parsePackets(rawPackets, factory, packetType, invalidPackets) {
  if (!Array.isArray(rawPackets)) {
    throw new TypeError(`${packetType} payload must be an array.`);
  }

  return rawPackets.reduce((validPackets, rawPacket, index) => {
    try {
      validPackets.push(factory(rawPacket));
    } catch (error) {
      invalidPackets.push(`${packetType} packet ${index + 1}: ${error.message}`);
    }
    return validPackets;
  }, []);
}

function latestSensorByStation(sensorData) {
  return sensorData.reduce((latest, packet) => {
    const current = latest.get(packet.stationId);
    if (!current || packet.timestamp > current.timestamp) {
      latest.set(packet.stationId, packet);
    }
    return latest;
  }, new Map());
}

function enrichStations(stations, sensorData, invalidPackets) {
  const latestSensors = latestSensorByStation(sensorData);

  return stations.map((station) => {
    const sensor = latestSensors.get(station.id);
    let nextData = station.toJSON();

    if (sensor) {
      try {
        if (isSensorReadingAnomalous(sensor)) {
          invalidPackets.push(`Sensor packet for ${station.id}: anomalous reading ignored.`);
        } else {
          nextData = {
            ...nextData,
            maxTilt: calculateTilt(sensor.tiltX, sensor.tiltY),
            rssi: sensor.rssi,
            battery: sensor.battery
          };
        }
      } catch (error) {
        invalidPackets.push(`Sensor packet for ${station.id}: ${error.message}`);
      }
    }

    nextData.status = getStationStatus(nextData);
    return new Station(nextData);
  });
}

export function calculateSystemSummary(stations, alerts) {
  const statusCounts = countStationStatuses(stations);
  const onlineTowers = stations.filter((station) => station.online).length;
  const offlineTowers = stations.length - onlineTowers;
  const tiltValues = stations.map((station) => station.maxTilt);
  const averageTilt = tiltValues.reduce((total, value) => total + value, 0) / stations.length;
  const totalSensors = stations.reduce((total, station) => total + station.sensors, 0);
  const attentionSensors = stations.filter(
    (station) => !station.online || station.status === STATION_STATUS.ALERT
  ).length;
  const normalSensors = Math.max(0, totalSensors - attentionSensors);
  const availability = (onlineTowers / stations.length) * 100;
  const sensorNormalRate = totalSensors ? (normalSensors / totalSensors) * 100 : 0;
  const health = clamp(
    Math.round(
      100 -
      offlineTowers * 3 -
      statusCounts.warning * 0.5 -
      statusCounts.alert * 2
    ),
    0,
    100
  );

  return {
    totalTowers: stations.length,
    onlineTowers,
    offlineTowers,
    averageTilt,
    maximumTilt: Math.max(...tiltValues),
    minimumTilt: Math.min(...tiltValues),
    totalSensors,
    attentionSensors,
    normalSensors,
    availability,
    sensorNormalRate,
    health,
    healthMessage: statusCounts.alert ? "Monitoring services operational" : "All systems operational",
    statusCounts,
    notificationCount: alerts.length
  };
}

export function processDashboardPayload(rawPayload, options = {}) {
  const invalidPackets = [];
  const range = RANGE_DEFINITIONS[options.range] ? options.range : "realtime";
  const timestamp = options.timestamp || Date.now();
  const rawStations = rawPayload?.stations;
  const rawSensorData = rawPayload?.sensorData || [];
  const parsedStations = parsePackets(rawStations, Station.from, "Station", invalidPackets);

  if (parsedStations.length === 0) {
    throw new Error("No valid station data was received; the last valid dashboard state was retained.");
  }

  const knownStationIds = new Set(parsedStations.map((station) => station.id));
  const sensorData = parsePackets(rawSensorData, SensorData.from, "Sensor", invalidPackets).filter((packet) => {
    if (knownStationIds.has(packet.stationId)) {
      return true;
    }

    invalidPackets.push(`Sensor packet for unknown station ${packet.stationId} was ignored.`);
    return false;
  });
  const stations = enrichStations(parsedStations, sensorData, invalidPackets);
  const alerts = createAlerts(stations, timestamp);
  const ranking = stations.slice().sort((left, right) => right.maxTilt - left.maxTilt);

  return {
    stations,
    sensorData,
    alerts,
    summary: calculateSystemSummary(stations, alerts),
    ranking,
    trendData: createTrendData(stations, range, new Date(timestamp)),
    distributionData: createDistributionData(stations),
    invalidPackets
  };
}

export function processSensorPacket(rawPacket, currentState, timestamp = Date.now()) {
  const packet = SensorData.from(rawPacket);
  const stationIds = new Set(currentState.stations.map((station) => station.id));

  if (!stationIds.has(packet.stationId) || isSensorReadingAnomalous(packet)) {
    return null;
  }

  const existingPackets = currentState.sensorData.filter(
    (existingPacket) => existingPacket.stationId !== packet.stationId
  );

  return processDashboardPayload(
    {
      stations: currentState.stations,
      sensorData: [...existingPackets, packet]
    },
    { range: currentState.range, timestamp }
  );
}

