import { SENSOR_DATA_CONFIG } from "../core/config.js?v=20261007.1";
import { SUPABASE_CONFIG } from "../core/supabaseConfig.js";
import { normalizeSensorListPayload } from "../logic/sensorDataProcessor.js";
import { getSupabaseClient } from "./supabaseClient.js?v=20260901.1";

export class SensorDataRequestError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "SensorDataRequestError";
    this.status = options.status || 0;
    this.code = options.code || "";
  }
}

export class SensorDataService {
  constructor(options = {}) {
    this.config = options.config || SENSOR_DATA_CONFIG;
    this.window = options.windowRef || window;
    this.document = options.documentRef || document;
    this.client = options.client || getSupabaseClient();
    this.fetchImpl = options.fetchImpl || this.window.fetch.bind(this.window);
    this.entries = new Map();
    this.destroyed = false;
    this.resume = () => {
      this.entries.forEach((entry, towerId) => {
        this.clearTimer(entry);
        if (!this.document.hidden && entry.listeners.size) {
          void this.fetchReadings({ towerId, force: true }).catch(() => {});
        }
      });
    };
    this.document.addEventListener("visibilitychange", this.resume);
    this.window.addEventListener("online", this.resume);
  }

  fetchReadings(options = {}) {
    if (this.destroyed || options.signal?.aborted) {
      return Promise.reject(options.signal?.reason || new DOMException("Request cancelled.", "AbortError"));
    }
    const towerId = typeof options.towerId === "string" ? options.towerId.trim() : "";
    const entry = this.entryFor(towerId);
    if (!options.force && entry.result && Date.now() - entry.updatedAt < (this.config.cacheTtlMs ?? 15000)) {
      if (entry.error) return Promise.reject(entry.error);
      return this.waitForResult(Promise.resolve(entry.result), options.signal);
    }
    if (!entry.promise) {
      this.clearTimer(entry);
      entry.controller = new AbortController();
      entry.promise = this.performRequest(entry.controller, { towerId }).then(result => {
        if (this.destroyed) throw new DOMException("Service closed.", "AbortError");
        // Preserve unchanged arrays so derived alert/history caches stay valid.
        const previous = entry.result?.readings;
        const same = previous?.length === result.readings.length && previous.every((reading, index) => {
          const next = result.readings[index];
          return ["date", "time", "x", "y", "z", "battery"].every(key => reading[key] === next[key]);
        });
        entry.result = same ? Object.freeze({ ...result, readings: previous }) : result;
        entry.updatedAt = Date.now();
        entry.failures = 0;
        entry.error = null;
        this.publish(entry, { result: entry.result, error: null });
        return entry.result;
      }).catch(error => {
        if (error?.name !== "AbortError") {
          entry.failures += 1;
          entry.error = error;
          this.publish(entry, { result: entry.result, error });
        }
        throw error;
      }).finally(() => {
        entry.promise = null;
        entry.controller = null;
        this.schedule(towerId, entry);
        this.trimCache();
      });
    }
    return this.waitForResult(entry.promise, options.signal);
  }

  entryFor(towerId) {
    if (!this.entries.has(towerId)) {
      this.entries.set(towerId, { result: null, updatedAt: 0, promise: null,
        controller: null, timer: null, failures: 0, error: null, listeners: new Set() });
    }
    return this.entries.get(towerId);
  }

  // Cancellation belongs to the waiting page; transport belongs to this service.
  waitForResult(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason || new DOMException("Request cancelled.", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  }

  subscribe(towerId, listener) {
    const key = String(towerId || "").trim();
    if (!key || this.destroyed) return () => {};
    const entry = this.entryFor(key);
    entry.listeners.add(listener);
    if (entry.result || entry.error) listener({ result: entry.result, error: entry.error });
    if (!this.document.hidden) {
      void this.fetchReadings({ towerId: key }).catch(() => {});
    }
    this.schedule(key, entry);
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size) this.clearTimer(entry);
    };
  }

  publish(entry, update) {
    entry.listeners.forEach(listener => {
      try { listener(update); }
      catch (error) { this.window.console.error("Sensor update subscriber failed.", error); }
    });
  }

  schedule(towerId, entry) {
    this.clearTimer(entry);
    if (this.destroyed || this.document.hidden || !entry.listeners.size || entry.promise) return;
    if ([401, 403].includes(entry.error?.status)) return;
    const delay = entry.failures ? Math.min(15000, 2000 * 2 ** Math.min(entry.failures - 1, 3))
      : this.config.pollingIntervalMs;
    entry.timer = this.window.setTimeout(() => {
      entry.timer = null;
      void this.fetchReadings({ towerId, force: true }).catch(() => {});
    }, delay);
  }

  clearTimer(entry) {
    if (entry.timer !== null) this.window.clearTimeout(entry.timer);
    entry.timer = null;
  }

  trimCache() {
    const unused = [...this.entries].filter(([, entry]) => !entry.listeners.size && !entry.promise)
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    while (this.entries.size > 8 && unused.length) this.entries.delete(unused.shift()[0]);
  }

  async performRequest(controller, options = {}) {
    const timeoutId = this.window.setTimeout(
      () => controller.abort(new DOMException("Sensor data request timed out.", "TimeoutError")),
      this.config.requestTimeoutMs
    );

    try {
      const { data: sessionData, error: sessionError } = await this.client.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (sessionError || !accessToken) {
        throw new SensorDataRequestError("Your session is no longer available. Please sign in again.", {
          cause: sessionError,
          status: 401
        });
      }

      const baseUrl = SUPABASE_CONFIG.url.replace(/\/$/, "");
      const response = await this.fetchImpl(
        `${baseUrl}/functions/v1/${encodeURIComponent(this.config.edgeFunctionName)}`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
            apikey: SUPABASE_CONFIG.publishableKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(options.towerId ? { towerId: options.towerId } : {}),
          cache: "no-store",
          signal: controller.signal
        }
      );

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new SensorDataRequestError("The sensor-data service returned an invalid response.", {
          cause: error,
          status: response.status
        });
      }

      if (!response.ok || payload?.ok === false) {
        const message = response.status === 401 || response.status === 403
          ? "You are not authorized to view sensor data."
          : typeof payload?.error === "string" && payload.error.length <= 220
            ? payload.error
            : "The sensor-data service is temporarily unavailable.";
        throw new SensorDataRequestError(message, { status: response.status, code: payload?.errorCode });
      }

      const normalized = normalizeSensorListPayload(payload, this.config.maximumRecords);
      return Object.freeze({
        readings: normalized.readings,
        invalidRows: normalized.invalidRows,
        meta: Object.freeze({
          received: Number(payload?.meta?.received) || normalized.readings.length,
          accepted: normalized.readings.length,
          rejected: Number(payload?.meta?.rejected) || normalized.invalidRows.length,
          generatedAt: typeof payload?.meta?.generatedAt === "string"
            ? payload.meta.generatedAt
            : new Date().toISOString(),
          towerId: options.towerId || payload?.meta?.towerId || null,
          truncated: payload?.meta?.truncated === true
        })
      });
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error?.name === "AbortError" || error?.name === "TimeoutError") {
        throw error;
      }
      if (error instanceof SensorDataRequestError) {
        throw error;
      }
      throw new SensorDataRequestError("Unable to connect to the sensor-data service.", {
        cause: error
      });
    } finally {
      this.window.clearTimeout(timeoutId);
    }
  }

  cancelActiveRequest(towerId) {
    this.entries.get(towerId)?.controller?.abort();
  }

  destroy() {
    this.destroyed = true;
    this.document.removeEventListener("visibilitychange", this.resume);
    this.window.removeEventListener("online", this.resume);
    this.entries.forEach(entry => {
      this.clearTimer(entry);
      entry.listeners.clear();
      entry.controller?.abort();
    });
    this.entries.clear();
  }
}
