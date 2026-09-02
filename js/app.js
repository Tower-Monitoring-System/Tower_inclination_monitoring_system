import { Dashboard } from "./components/Dashboard.js?v=20260902.4";
import { DASHBOARD_ACTION } from "./core/constants.js";
import { AlertsPage } from "./pages/alertsPage.js?v=20260902.1";
import { ListPage } from "./pages/listPage.js?v=20260902.1";
import { SettingsPage } from "./pages/settingsPage.js?v=20260902.1";
import { TowersPage } from "./pages/towersPage.js?v=20260902.4";
import { AlertService } from "./services/alertService.js?v=20260902.2";
import { AuthService } from "./services/authService.js?v=20260901.1";
import { Esp32SettingsAdapter } from "./services/esp32SettingsAdapter.js?v=20260902.4";
import { MqttService } from "./services/mqttService.js?v=20260823.8";
import { SensorDataService } from "./services/sensorDataService.js?v=20260901.1";
import { SettingsService } from "./services/settingsService.js?v=20260902.4";
import { TowerHistoryService } from "./services/towerHistoryService.js?v=20260824.2";
import { TowerRegistryService } from "./services/towerRegistryService.js?v=20260824.1";

let dashboard;
let mqttService;
let authService;
let listPage;
let sensorDataService;
let alertsPage;
let towersPage;
let settingsPage;
let settingsService;
let towerRegistryService;
const cleanupCallbacks = [];
let currentView = "Towers";

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
  const towerId = typeof rawPacket?.stationId === "string" ? rawPacket.stationId.trim() : "";
  if (!towerId) {
    window.console.warn("An MQTT notification without a valid stationId was ignored.");
    return;
  }
  if (towersPage?.getSelectedTowerId() === towerId) {
    void towersPage.refreshHistoricalReadings({ automatic: true });
  }
  void alertsPage?.refresh({ automatic: true });
  void listPage?.refresh({ automatic: true });
}

function registerServiceEvents() {
  cleanupCallbacks.push(
    mqttService.onMessage(handleMqttPacket),
    mqttService.onError((error) => window.console.warn("MQTT adapter error.", error))
  );
}

function destroyApplication() {
  cleanupCallbacks.splice(0).forEach((cleanup) => cleanup());
  dashboard?.destroy();
  listPage?.destroy();
  towersPage?.destroy();
  alertsPage?.destroy();
  settingsPage?.destroy();
  settingsService?.destroy();
  mqttService?.destroy();
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
    mqttService = new MqttService();
    dashboard = new Dashboard();
    settingsService = new SettingsService({
      adapter: new Esp32SettingsAdapter({
        sensorProvider: () => towersPage?.getSelectedTowerLatestReading() || null
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
    towersPage = new TowersPage({
      onToast: (message, type) => dashboard.showToast(message, type),
      historyService: new TowerHistoryService(new SensorDataService()),
      towerRegistryService,
      settingsService
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
    window.addEventListener("pagehide", handlePageHide);

    const initialAlertRefresh = alertsPage.refresh({ automatic: true });
    mqttService.connect().catch((error) => window.console.warn("MQTT initialization failed.", error));
    await initialAlertRefresh;
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
