import { API_CONFIG } from "../core/config.js";
import { CONNECTION_STATUS } from "../core/constants.js";
import { clamp } from "../logic/tiltProcessor.js";

const MOCK_STATIONS = Object.freeze([
  Object.freeze({ id: "TWR-003", name: "North Ridge Tower", location: "North Ridge", maxTilt: 1.24, online: true, sensors: 4, rssi: -62, battery: 86 }),
  Object.freeze({ id: "TWR-017", name: "Hilltop Relay", location: "Hilltop Site", maxTilt: 0.92, online: true, sensors: 4, rssi: -68, battery: 91 }),
  Object.freeze({ id: "TWR-008", name: "East Valley Tower", location: "East Valley", maxTilt: 0.78, online: true, sensors: 4, rssi: -71, battery: 79 }),
  Object.freeze({ id: "TWR-001", name: "Riverside Tower", location: "Riverside", maxTilt: 0.64, online: true, sensors: 4, rssi: -65, battery: 94 }),
  Object.freeze({ id: "TWR-012", name: "West Point Tower", location: "West Point", maxTilt: 0.55, online: true, sensors: 4, rssi: -74, battery: 76 }),
  Object.freeze({ id: "TWR-021", name: "South Field Tower", location: "South Field", maxTilt: 0.44, online: false, sensors: 4, rssi: -101, battery: 42 }),
  Object.freeze({ id: "TWR-006", name: "Lake Side Tower", location: "Lake Side", maxTilt: 0.39, online: true, sensors: 4, rssi: -69, battery: 88 }),
  Object.freeze({ id: "TWR-025", name: "Industrial Park Tower", location: "Industrial Park", maxTilt: 0.31, online: true, sensors: 4, rssi: -73, battery: 81 })
]);

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(resolve, milliseconds);

    if (!signal) {
      return;
    }

    const abort = () => {
      window.clearTimeout(timeoutId);
      reject(new DOMException("The request was aborted.", "AbortError"));
    };

    if (signal.aborted) {
      abort();
      return;
    }

    signal.addEventListener("abort", abort, { once: true });
  });
}

function createEmitter() {
  const listeners = new Set();

  return {
    emit(payload) {
      listeners.forEach((listener) => listener(payload));
    },
    on(listener) {
      if (typeof listener !== "function") {
        throw new TypeError("Service listeners must be functions.");
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      listeners.clear();
    }
  };
}

export class ApiService {
  constructor(config = API_CONFIG) {
    this.config = config;
    this.status = CONNECTION_STATUS.DISCONNECTED;
    this.requestCount = 0;
    this.mockStations = MOCK_STATIONS.map((station) => ({ ...station }));
    this.activeRequest = null;
    this.dataEmitter = createEmitter();
    this.errorEmitter = createEmitter();
    this.statusEmitter = createEmitter();
  }

  onData(listener) {
    return this.dataEmitter.on(listener);
  }

  onError(listener) {
    return this.errorEmitter.on(listener);
  }

  onStatusChange(listener) {
    return this.statusEmitter.on(listener);
  }

  setStatus(status) {
    this.status = status;
    this.statusEmitter.emit(status);
  }

  refresh(context = {}) {
    if (this.activeRequest) {
      return this.activeRequest;
    }

    this.activeRequest = this.performRefresh(context).finally(() => {
      this.activeRequest = null;
    });

    return this.activeRequest;
  }

  async performRefresh(context) {
    this.setStatus(CONNECTION_STATUS.CONNECTING);

    try {
      const payload = this.config.useMockData
        ? await this.loadMockData(context.signal)
        : await this.loadRemoteData(context.signal);

      this.dataEmitter.emit({ payload, context });
      this.setStatus(CONNECTION_STATUS.CONNECTED);
      return payload;
    } catch (error) {
      if (error?.name !== "AbortError") {
        this.setStatus(CONNECTION_STATUS.ERROR);
        this.errorEmitter.emit({ error, context });
      }
      throw error;
    }
  }

  async loadMockData(signal) {
    await wait(this.config.mockLatencyMs, signal);

    if (this.requestCount > 0) {
      this.mockStations = this.mockStations.map((station, index) => {
        const movement = (Math.random() - 0.5) * (index < 3 ? 0.025 : 0.015);
        const minimum = index === 0 ? 1.12 : 0.18;
        const maximum = index === 0 ? 1.32 : 0.98;

        return {
          ...station,
          maxTilt: clamp(station.maxTilt + movement, minimum, maximum),
          rssi: Math.round(clamp(station.rssi + (Math.random() - 0.5) * 2, -105, -45))
        };
      });
    }

    this.requestCount += 1;
    const timestamp = new Date().toISOString();

    return {
      stations: this.mockStations.map((station) => ({ ...station })),
      sensorData: this.mockStations.map((station) => ({
        stationId: station.id,
        tiltX: station.maxTilt,
        tiltY: 0,
        temperature: 26.5,
        rssi: station.rssi,
        battery: station.battery,
        timestamp
      }))
    };
  }

  async loadRemoteData(externalSignal) {
    if (!this.config.baseUrl || !this.config.dashboardPath) {
      throw new Error("REST API configuration is incomplete. Enable mock mode or configure an endpoint.");
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), this.config.timeoutMs);
    const abortFromExternalSignal = () => controller.abort();
    externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });

    try {
      const baseUrl = this.config.baseUrl.replace(/\/$/, "");
      const dashboardPath = this.config.dashboardPath.replace(/^\//, "");
      const response = await fetch(`${baseUrl}/${dashboardPath}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`REST API request failed with status ${response.status}.`);
      }

      return await response.json();
    } finally {
      window.clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", abortFromExternalSignal);
    }
  }

  destroy() {
    this.dataEmitter.clear();
    this.errorEmitter.clear();
    this.statusEmitter.clear();
  }
}

