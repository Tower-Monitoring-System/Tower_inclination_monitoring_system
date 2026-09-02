import {
  CHART_COLORS,
  CHART_CONSTANTS,
  DISTRIBUTION_CATEGORIES,
  RANGE_DEFINITIONS,
  WARNING_THRESHOLDS
} from "../core/constants.js";
import { calculateOrientationVector } from "./orientationAveraging.js?v=20260902.2";

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function calculateTilt(tiltX, tiltY, tiltZ = 0) {
  const x = Number(tiltX);
  const y = Number(tiltY);
  const z = Number(tiltZ);

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new TypeError("Tilt axes must be finite numbers.");
  }

  return calculateOrientationVector({ x, y, z, timestamp: 0 }).tiltDegrees;
}

export function normalizeTilt(value, minimum = 0, maximum = 90) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new TypeError("Tilt must be a finite number.");
  }

  return clamp(Math.abs(parsed), minimum, maximum);
}

export function isSensorReadingAnomalous(sensorData) {
  if (!sensorData) {
    return true;
  }

  const magnitude = calculateTilt(sensorData.tiltX, sensorData.tiltY, sensorData.tiltZ);
  return magnitude > 90 || sensorData.temperature < -80 || sensorData.temperature > 150;
}

function seededNoise(seed, index) {
  const value = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return (value - Math.floor(value)) - 0.5;
}

function formatTime(date) {
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

export function createRangeLabels(range, points, now = new Date()) {
  return Array.from({ length: points }, (_, index) => {
    const offset = points - 1 - index;
    const date = new Date(now);

    if (range === "realtime") {
      date.setMinutes(now.getMinutes() - offset * 3);
      return formatTime(date);
    }

    if (range === "24h") {
      date.setHours(now.getHours() - offset);
      return `${String(date.getHours()).padStart(2, "0")}:00`;
    }

    if (range === "7d") {
      date.setHours(now.getHours() - offset * 6);
      return date.toLocaleDateString(undefined, { weekday: "short", hour: "2-digit" });
    }

    const dayStep = range === "30d" ? 1 : 14 / Math.max(1, points - 1);
    date.setTime(now.getTime() - offset * dayStep * 24 * 60 * 60 * 1000);
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  });
}

export function createTrendData(stations, range, now = new Date()) {
  const definition = RANGE_DEFINITIONS[range] || RANGE_DEFINITIONS.realtime;
  const points = definition.points;
  const chartStations = stations.slice(0, CHART_CONSTANTS.maximumTrendStations);

  return {
    labels: createRangeLabels(range, points, now),
    datasets: chartStations.map((station, stationIndex) => ({
      id: station.id,
      color: CHART_COLORS[stationIndex % CHART_COLORS.length],
      values: Array.from({ length: points }, (_, pointIndex) => {
        const wave = Math.sin((pointIndex + stationIndex * 1.7) / 2.9) * 0.055;
        const secondaryWave = Math.cos((pointIndex + stationIndex) / 5.2) * 0.025;
        const peakPosition = Math.round(points * (0.54 + stationIndex * 0.025));
        const peakDistance = Math.abs(pointIndex - peakPosition);
        const peak = Math.max(0, 1 - peakDistance / Math.max(2, points * 0.14));
        const peakStrength = stationIndex === 0 ? 0.22 : stationIndex === 1 ? 0.12 : 0.07;
        const noise = seededNoise(stationIndex + 3, pointIndex) * 0.035;
        const base = station.maxTilt * (0.72 + stationIndex * 0.008);

        return clamp(base + wave + secondaryWave + peak * peakStrength + noise, 0.04, 1.38);
      })
    }))
  };
}

export function createDistributionData(stations) {
  const categories = DISTRIBUTION_CATEGORIES.map((category) => ({ ...category, count: 0 }));

  stations.forEach((station) => {
    if (station.maxTilt >= WARNING_THRESHOLDS.alert) {
      categories[3].count += 1;
    } else if (station.maxTilt >= WARNING_THRESHOLDS.warning) {
      categories[2].count += 1;
    } else if (station.maxTilt >= WARNING_THRESHOLDS.stable) {
      categories[1].count += 1;
    } else {
      categories[0].count += 1;
    }
  });

  return categories;
}
