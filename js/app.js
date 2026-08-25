import { Dashboard } from "./components/Dashboard.js?v=20260824.4";
import { APP_CONFIG, MQTT_CONFIG } from "./core/config.js?v=20260824.2";
import {
  CONNECTION_STATUS,
  DASHBOARD_ACTION
} from "./core/constants.js";
import { createStore } from "./core/store.js";
import { processDashboardPayload, processSensorPacket } from "./logic/stationProcessor.js";
import { AlertsPage } from "./pages/alertsPage.js?v=20260824.3";
import { ListPage } from "./pages/listPage.js?v=20260824.3";
import { SettingsPage } from "./pages/settingsPage.js?v=20260824.3";
import { TowersPage } from "./pages/towersPage.js?v=20260825.1";
import { AlertService } from "./services/alertService.js?v=20260824.3";
import { ApiService } from "./services/apiService.js";
import { AuthService } from "./services/authService.js?v=20260823.11";
import { Esp32SettingsAdapter } from "./services/esp32SettingsAdapter.js?v=20260824.1";
import { MqttService } from "./services/mqttService.js?v=20260823.8";
import { SensorDataService } from "./services/sensorDataService.js?v=20260824.2";
import { SettingsService } from "./services/settingsService.js?v=20260824.1";
import { TowerHistoryService } from "./services/towerHistoryService.js?v=20260824.2";
import { TowerRegistryService } from "./services/towerRegistryService.js?v=20260824.1";

const initialState = {
  stations: [],
  sensorData: [],
  alerts: [],
  summary: null,
  ranking: [],
  range: "realtime",
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
let listPage;
let sensorDataService;
let alertsPage;
let towersPage;
let settingsPage;
let settingsService;
let towerRegistryService;
let refreshPromise = null;
let autoRefreshTimer = null;
const cleanupCallbacks = [];
let currentView = "Towers";

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

function getPageControllers() {
  return new Map([
    ["Towers", towersPage],
    ["List", listPage],
    ["Alerts", alertsPage],
    ["System settings", settingsPage]
  ]);
}

function syncPageControllers() {
  getPageControllers().forEach((controller, view) => {
    if (view === currentView) {
      controller?.open();
    } else {
      controller?.close();
    }
  });
}

function closePageControllers() {
  getPageControllers().forEach((controller) => controller?.close());
}

function handleDashboardAction(event) {
  const { action } = event.detail;

  switch (action) {
    case DASHBOARD_ACTION.NAVIGATE:
      if (dashboard.setActiveView(event.detail.target)) {
        currentView = event.detail.target;
        syncPageControllers();
      }
      break;
    case DASHBOARD_ACTION.SIGN_OUT:
      closePageControllers();
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
      currentView === "Towers" &&
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
  dashboard?.destroy();
  listPage?.destroy();
  towersPage?.destroy();
  alertsPage?.destroy();
  settingsPage?.destroy();
  settingsService?.destroy();
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
    settingsService = new SettingsService({
      adapter: new Esp32SettingsAdapter({
        sensorProvider: () => store.getState().sensorData.at(-1) || null
      })
    });
    await settingsService.initialize();
    towerRegistryService = new TowerRegistryService();
    towerRegistryService.initialize();
    sensorDataService = new SensorDataService();
    listPage = new ListPage(sensorDataService, {
      onToast: (message, type) => dashboard.showToast(message, type),
      settingsService,
      towerRegistryService
    });
    const alertsSensorDataService = new SensorDataService();
    const alertService = new AlertService(alertsSensorDataService, { settingsService });
    alertsPage = new AlertsPage(alertService, {
      onToast: (message, type) => dashboard.showToast(message, type),
      onSummaryChange: (summary) => dashboard.updateAlertSummary(summary),
      monitorWhenInactive: true,
      towerRegistryService
    });
    towersPage = new TowersPage(store.asReadonly(), {
      onToast: (message, type) => dashboard.showToast(message, type),
      historyService: new TowerHistoryService(new SensorDataService()),
      towerRegistryService
    });
    settingsPage = new SettingsPage(settingsService, {
      onToast: (message, type) => dashboard.showToast(message, type),
      onSaved: () => alertsPage.refresh({ automatic: true }),
      towerRegistryService
    });
    cleanupCallbacks.push(
      towerRegistryService.subscribe(
        (state) => dashboard.updateTowerRegistry(state.towers),
        { immediate: true }
      )
    );
    dashboard.setIdentity(identity.displayName || identity.username);
    dashboard.setActiveView(currentView);
    syncPageControllers();
    dashboard.addEventListener("action", handleDashboardAction);
    registerServiceEvents();
    cleanupCallbacks.push(
      authService.onAuthStateChange((event) => {
        if (event === "SIGNED_OUT") {
          closePageControllers();
          authService.redirect("sign-in.html");
        }
      })
    );
    startAutoRefresh();
    window.addEventListener("pagehide", handlePageHide);

    const initialAlertRefresh = alertsPage.refresh({ automatic: true });
    mqttService.connect().catch((error) => window.console.warn("MQTT initialization failed.", error));
    await Promise.all([
      refreshDashboard({ initial: true }),
      initialAlertRefresh
    ]);
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
