import { Dashboard } from "./components/Dashboard.js?v=20260823.8";
import { APP_CONFIG, MQTT_CONFIG } from "./core/config.js";
import {
  CHART_MODE,
  CONNECTION_STATUS,
  DASHBOARD_ACTION,
  RANGE_DEFINITIONS,
  VALID_CHART_MODES
} from "./core/constants.js";
import { createStore } from "./core/store.js";
import { processDashboardPayload, processSensorPacket } from "./logic/stationProcessor.js";
import { ApiService } from "./services/apiService.js";
import { AuthService } from "./services/authService.js?v=20260823.10";
import { MqttService } from "./services/mqttService.js?v=20260823.8";

const initialState = {
  stations: [],
  sensorData: [],
  alerts: [],
  summary: null,
  ranking: [],
  trendData: { labels: [], datasets: [] },
  distributionData: [],
  range: "realtime",
  chartMode: CHART_MODE.TREND,
  autoRefresh: true,
  lastUpdatedAt: 0,
  loading: true,
  connectionStatus: {
    api: CONNECTION_STATUS.DISCONNECTED,
    mqtt: MQTT_CONFIG.enabled ? CONNECTION_STATUS.DISCONNECTED : CONNECTION_STATUS.DISABLED
  },
  error: null
};

let store;
let dashboard;
let apiService;
let mqttService;
let authService;
let refreshPromise = null;
let autoRefreshTimer = null;
let analyticsTimer = null;
const cleanupCallbacks = [];

function updateConnectionStatus(serviceName, status) {
  store.setState((state) => ({
    connectionStatus: { ...state.connectionStatus, [serviceName]: status }
  }));
}

function applyDashboardPayload({ payload }) {
  const currentState = store.getState();
  const processed = processDashboardPayload(payload, {
    range: currentState.range,
    timestamp: Date.now()
  });

  if (processed.invalidPackets.length) {
    window.console.warn("Invalid monitoring packets were ignored.", processed.invalidPackets);
  }

  store.setState({
    stations: processed.stations,
    sensorData: processed.sensorData,
    alerts: processed.alerts,
    summary: processed.summary,
    ranking: processed.ranking,
    trendData: processed.trendData,
    distributionData: processed.distributionData,
    lastUpdatedAt: Date.now(),
    error: null
  });
}

function handleApiError({ error }) {
  store.setState({ error: error.message });
}

async function refreshDashboard({ automatic = false, initial = false } = {}) {
  if (refreshPromise) {
    return refreshPromise;
  }

  store.setState({ loading: true, error: null });
  refreshPromise = (async () => {
    try {
      const delay = automatic
        ? APP_CONFIG.automaticRefreshDelayMs
        : initial
          ? 0
          : APP_CONFIG.manualRefreshDelayMs;

      if (delay) {
        await new Promise((resolve) => window.setTimeout(resolve, delay));
      }

      await apiService.refresh({ automatic, initial });

      if (!automatic && !initial) {
        dashboard.showToast("Monitoring data refreshed successfully.", "info");
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        window.console.error("Monitoring data refresh failed.", error);
        dashboard.showToast(
          "New monitoring data could not be loaded. The last valid readings were retained.",
          "error"
        );
      }
    } finally {
      store.setState({ loading: false });
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

function rebuildAnalytics(patch) {
  const currentState = store.getState();
  if (currentState.loading) {
    return;
  }

  window.clearTimeout(analyticsTimer);
  store.setState({ loading: true });
  analyticsTimer = window.setTimeout(() => {
    try {
      const state = store.getState();
      const nextRange = patch.range || state.range;
      const processed = processDashboardPayload(
        { stations: state.stations, sensorData: state.sensorData },
        { range: nextRange, timestamp: state.lastUpdatedAt || Date.now() }
      );

      store.setState({
        ...patch,
        stations: processed.stations,
        sensorData: processed.sensorData,
        alerts: processed.alerts,
        summary: processed.summary,
        ranking: processed.ranking,
        trendData: processed.trendData,
        distributionData: processed.distributionData,
        loading: false
      });
    } catch (error) {
      window.console.error("Analytics update failed.", error);
      store.setState({ loading: false, error: error.message });
      dashboard.showToast("The analytics view could not be updated.", "error");
    }
  }, APP_CONFIG.analyticsTransitionMs);
}

function handleDashboardAction(event) {
  const { action } = event.detail;
  const state = store.getState();

  switch (action) {
    case DASHBOARD_ACTION.REFRESH:
      refreshDashboard({ automatic: false });
      break;
    case DASHBOARD_ACTION.RANGE_CHANGE:
      if (RANGE_DEFINITIONS[event.detail.range] && event.detail.range !== state.range) {
        rebuildAnalytics({ range: event.detail.range });
      }
      break;
    case DASHBOARD_ACTION.CHART_MODE_CHANGE:
      if (VALID_CHART_MODES.includes(event.detail.mode) && event.detail.mode !== state.chartMode) {
        rebuildAnalytics({ chartMode: event.detail.mode });
      }
      break;
    case DASHBOARD_ACTION.AUTO_REFRESH_CHANGE:
      store.setState({ autoRefresh: Boolean(event.detail.enabled) });
      dashboard.showToast(`Auto-refresh ${event.detail.enabled ? "enabled" : "paused"}.`, "info");
      break;
    case DASHBOARD_ACTION.SIGN_OUT:
      void authService.signOut();
      break;
    default:
      window.console.warn("Unknown dashboard action ignored.", action);
  }
}

function handleMqttPacket(rawPacket) {
  try {
    const currentState = store.getState();
    const processed = processSensorPacket(rawPacket, currentState);

    if (!processed) {
      window.console.warn("An invalid or unknown MQTT sensor packet was ignored.");
      return;
    }

    store.setState({
      stations: processed.stations,
      sensorData: processed.sensorData,
      alerts: processed.alerts,
      summary: processed.summary,
      ranking: processed.ranking,
      trendData: processed.trendData,
      distributionData: processed.distributionData,
      lastUpdatedAt: Date.now(),
      error: null
    });
  } catch (error) {
    window.console.warn("An MQTT sensor packet failed validation and was ignored.", error);
  }
}

function startAutoRefresh() {
  if (autoRefreshTimer !== null) {
    return;
  }

  autoRefreshTimer = window.setInterval(() => {
    const state = store.getState();
    if (
      !document.hidden &&
      state.autoRefresh &&
      state.range === "realtime" &&
      !state.loading &&
      !refreshPromise
    ) {
      refreshDashboard({ automatic: true });
    }
  }, APP_CONFIG.refreshIntervalMs);
}

function registerServiceEvents() {
  cleanupCallbacks.push(
    apiService.onData(applyDashboardPayload),
    apiService.onError(handleApiError),
    apiService.onStatusChange((status) => updateConnectionStatus("api", status)),
    mqttService.onMessage(handleMqttPacket),
    mqttService.onError((error) => window.console.warn("MQTT adapter error.", error)),
    mqttService.onStatusChange((status) => updateConnectionStatus("mqtt", status))
  );
}

function destroyApplication() {
  cleanupCallbacks.splice(0).forEach((cleanup) => cleanup());
  window.clearInterval(autoRefreshTimer);
  window.clearTimeout(analyticsTimer);
  dashboard?.destroy();
  mqttService?.destroy();
  apiService?.destroy();
}

function handlePageHide(event) {
  if (!event.persisted) {
    destroyApplication();
  }
}

async function bootstrap() {
  try {
    authService = new AuthService();
    const identity = await authService.guardDashboard();
    if (!identity) {
      return;
    }

    document.documentElement.classList.remove("auth-pending");
    store = createStore(initialState);
    apiService = new ApiService();
    mqttService = new MqttService();
    dashboard = new Dashboard(store.asReadonly());
    dashboard.setIdentity(identity.displayName || identity.username);
    dashboard.addEventListener("action", handleDashboardAction);
    registerServiceEvents();
    cleanupCallbacks.push(
      authService.onAuthStateChange((event) => {
        if (event === "SIGNED_OUT") {
          authService.redirect("sign-in.html");
        }
      })
    );
    startAutoRefresh();
    window.addEventListener("pagehide", handlePageHide);

    mqttService.connect().catch((error) => window.console.warn("MQTT initialization failed.", error));
    await refreshDashboard({ initial: true });
  } catch (error) {
    window.console.error("Dashboard initialization failed.", error);
    if (!authService?.identity) {
      window.location.replace("./sign-in.html?auth=unavailable");
      return;
    }
    document.documentElement.classList.remove("auth-pending");
    document.body?.classList.remove("dashboard-loading");
    dashboard?.showToast("Dashboard loaded with limited interactivity. Please refresh the page.", "error");
  }
}

bootstrap();
