import { SENSOR_DATA_CONFIG } from "../core/config.js";
import { SUPABASE_CONFIG } from "../core/supabaseConfig.js";
import { normalizeSensorListPayload } from "../logic/sensorDataProcessor.js";
import { getSupabaseClient } from "./supabaseClient.js";

export class SensorDataRequestError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "SensorDataRequestError";
    this.status = options.status || 0;
  }
}

export class SensorDataService {
  constructor(options = {}) {
    this.config = options.config || SENSOR_DATA_CONFIG;
    this.client = options.client || getSupabaseClient();
    this.fetchImpl = options.fetchImpl || window.fetch.bind(window);
    this.activeRequest = null;
    this.activeController = null;
  }

  fetchReadings(options = {}) {
    if (this.activeRequest) {
      return this.activeRequest;
    }

    this.activeController = new AbortController();
    this.activeRequest = this.performRequest(this.activeController, options.signal).finally(() => {
      this.activeController = null;
      this.activeRequest = null;
    });
    return this.activeRequest;
  }

  async performRequest(controller, externalSignal) {
    const abortFromExternalSignal = () => controller.abort();
    if (externalSignal?.aborted) {
      controller.abort();
    } else {
      externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
    }

    const timeoutId = window.setTimeout(
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
          body: "{}",
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
          : "The sensor-data service is temporarily unavailable.";
        throw new SensorDataRequestError(message, { status: response.status });
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
            : new Date().toISOString()
        })
      });
    } catch (error) {
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
      window.clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", abortFromExternalSignal);
    }
  }

  cancelActiveRequest() {
    this.activeController?.abort();
  }

  destroy() {
    this.cancelActiveRequest();
  }
}
