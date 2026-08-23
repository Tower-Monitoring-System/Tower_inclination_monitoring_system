import { MQTT_CONFIG } from "../core/config.js";
import { CONNECTION_STATUS } from "../core/constants.js";

function createEmitter() {
  const listeners = new Set();
  return {
    emit(payload) {
      listeners.forEach((listener) => listener(payload));
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      listeners.clear();
    }
  };
}

export class MqttService {
  constructor(config = MQTT_CONFIG) {
    this.config = config;
    this.socket = null;
    this.status = config.enabled ? CONNECTION_STATUS.DISCONNECTED : CONNECTION_STATUS.DISABLED;
    this.subscriptions = new Set(config.topics || []);
    this.messageEmitter = createEmitter();
    this.errorEmitter = createEmitter();
    this.statusEmitter = createEmitter();
  }

  setStatus(status) {
    this.status = status;
    this.statusEmitter.emit(status);
  }

  onMessage(listener) {
    return this.messageEmitter.on(listener);
  }

  onError(listener) {
    return this.errorEmitter.on(listener);
  }

  onStatusChange(listener) {
    return this.statusEmitter.on(listener);
  }

  subscribe(topic) {
    if (typeof topic !== "string" || !topic.trim()) {
      throw new TypeError("MQTT topic must be a non-empty string.");
    }

    this.subscriptions.add(topic.trim());
    return () => this.subscriptions.delete(topic.trim());
  }

  async connect() {
    if (!this.config.enabled) {
      this.setStatus(CONNECTION_STATUS.DISABLED);
      return false;
    }

    if (!this.config.webSocketUrl) {
      const error = new Error("MQTT WebSocket URL is not configured.");
      this.setStatus(CONNECTION_STATUS.ERROR);
      this.errorEmitter.emit(error);
      return false;
    }

    if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
      return true;
    }

    this.setStatus(CONNECTION_STATUS.CONNECTING);

    return new Promise((resolve) => {
      try {
        const socket = new WebSocket(this.config.webSocketUrl);
        let settled = false;
        const finish = (result) => {
          if (!settled) {
            settled = true;
            resolve(result);
          }
        };
        this.socket = socket;

        socket.addEventListener("open", () => {
          this.setStatus(CONNECTION_STATUS.CONNECTED);
          finish(true);
        }, { once: true });

        socket.addEventListener("message", (event) => {
          try {
            const payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
            this.messageEmitter.emit(payload);
          } catch (error) {
            this.errorEmitter.emit(new Error(`Invalid MQTT message: ${error.message}`));
          }
        });

        socket.addEventListener("error", () => {
          const error = new Error("MQTT WebSocket connection failed.");
          this.setStatus(CONNECTION_STATUS.ERROR);
          this.errorEmitter.emit(error);
          finish(false);
        }, { once: true });

        socket.addEventListener("close", () => {
          this.socket = null;
          if (this.status !== CONNECTION_STATUS.ERROR) {
            this.setStatus(CONNECTION_STATUS.DISCONNECTED);
          }
          finish(false);
        });
      } catch (error) {
        this.setStatus(CONNECTION_STATUS.ERROR);
        this.errorEmitter.emit(error);
        resolve(false);
      }
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.close(1000, "Dashboard closed");
      this.socket = null;
    }
    this.setStatus(this.config.enabled ? CONNECTION_STATUS.DISCONNECTED : CONNECTION_STATUS.DISABLED);
  }

  destroy() {
    this.disconnect();
    this.messageEmitter.clear();
    this.errorEmitter.clear();
    this.statusEmitter.clear();
  }
}
