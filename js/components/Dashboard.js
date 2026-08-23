import { APP_CONFIG } from "../core/config.js";
import { CONNECTION_STATUS, DASHBOARD_ACTION } from "../core/constants.js";
import { AlertPanel } from "./AlertPanel.js";
import { StationCard } from "./StationCard.js";
import { TiltChart } from "./TiltChart.js";

export class Dashboard extends EventTarget {
  constructor(readonlyStore, options = {}) {
    super();
    this.store = readonlyStore;
    this.document = options.documentRef || document;
    this.window = options.windowRef || window;
    this.abortController = new AbortController();
    this.state = readonlyStore.getState();
    this.toastTimer = null;
    this.resizeTimer = null;
    this.relativeTimeTimer = null;
    this.revealTimer = null;
    this.activeView = "Overview";
    this.chart = new TiltChart(this.document, this.window);
    this.stationCard = new StationCard(this.document);
    this.alertPanel = new AlertPanel(this.document);
    this.elements = this.collectElements();

    this.bindEvents();
    this.startTimers();
    this.unsubscribe = this.store.subscribe((state) => this.render(state));
    this.scheduleReveal();
  }

  collectElements() {
    const byId = (id) => this.document.getElementById(id);
    return {
      appShell: byId("appShell"),
      overviewPage: byId("overviewPage"),
      listPage: byId("listPage"),
      topbarTitle: byId("topbarTitle"),
      sidebarBackdrop: byId("sidebarBackdrop"),
      menuButton: byId("menuButton"),
      notificationButton: byId("notificationButton"),
      accountButton: byId("accountButton"),
      accountDropdown: byId("accountDropdown"),
      refreshButton: byId("refreshButton"),
      exportButton: byId("exportButton"),
      analyticsPanel: byId("analyticsPanel"),
      dateRangeButton: byId("dateRangeButton"),
      autoRefreshToggle: byId("autoRefreshToggle"),
      lastUpdated: byId("lastUpdated"),
      lastSyncHeader: byId("lastSyncHeader"),
      toast: byId("dashboardToast"),
      toastMessage: byId("dashboardToastMessage"),
      gatewayTitle: this.document.querySelector(".gateway-status strong"),
      gatewayMessage: this.document.querySelector(".gateway-status div span"),
      gatewayIndicator: this.document.querySelector(".gateway-status > i"),
      healthGauge: byId("healthGauge"),
      healthGaugeContainer: this.document.querySelector(".health-gauge"),
      healthLabel: this.document.querySelector(".health-label"),
      towerOnlineProgress: byId("towerOnlineProgress"),
      sensorNormalProgress: byId("sensorNormalProgress")
    };
  }

  listen(element, eventName, listener) {
    element?.addEventListener(eventName, listener, { signal: this.abortController.signal });
  }

  bindEvents() {
    this.listen(this.elements.menuButton, "click", () => this.toggleNavigation());
    this.listen(this.elements.sidebarBackdrop, "click", () => this.closeMobileNavigation());

    this.document.querySelectorAll("[data-nav-target]").forEach((item) => {
      this.listen(item, "click", () => {
        const target = item.dataset.navTarget;
        this.closeMobileNavigation();
        this.closeAccountMenu();
        if (target === "Overview" || target === "List") {
          this.emitAction(DASHBOARD_ACTION.NAVIGATE, { target });
        } else {
          this.showToast(`${target} is prepared for the next integration phase.`, "info");
        }
      });
    });

    this.listen(this.elements.notificationButton, "click", () => {
      const summary = this.alertPanel.getNotificationSummary();
      this.showToast(summary.message, summary.type);
    });
    this.listen(this.elements.accountButton, "click", () => this.toggleAccountMenu());
    this.listen(this.document, "click", (event) => {
      if (!event.target.closest?.(".account-menu-wrap")) {
        this.closeAccountMenu();
      }
    });
    this.listen(this.document, "keydown", (event) => {
      if (event.key === "Escape") {
        this.closeAccountMenu();
        this.closeMobileNavigation();
      }
    });

    this.listen(this.elements.refreshButton, "click", () => {
      this.emitAction(DASHBOARD_ACTION.REFRESH, { automatic: false });
    });
    this.listen(this.elements.exportButton, "click", () => this.exportStationData());

    this.document.querySelectorAll("[data-range]").forEach((button) => {
      this.listen(button, "click", () => {
        this.emitAction(DASHBOARD_ACTION.RANGE_CHANGE, { range: button.dataset.range });
      });
    });
    this.document.querySelectorAll("[data-chart-mode]").forEach((button) => {
      this.listen(button, "click", () => {
        this.emitAction(DASHBOARD_ACTION.CHART_MODE_CHANGE, { mode: button.dataset.chartMode });
      });
    });
    this.listen(this.elements.dateRangeButton, "click", () => {
      this.emitAction(DASHBOARD_ACTION.RANGE_CHANGE, { range: "custom" });
      this.showToast("Showing a prepared 14-day custom monitoring window.", "info");
    });
    this.listen(this.elements.autoRefreshToggle, "change", (event) => {
      this.emitAction(DASHBOARD_ACTION.AUTO_REFRESH_CHANGE, { enabled: event.target.checked });
    });
    this.document.querySelectorAll("[data-action='sign-out']").forEach((button) => {
      this.listen(button, "click", () => this.emitAction(DASHBOARD_ACTION.SIGN_OUT));
    });

    this.listen(this.window, "resize", () => {
      this.window.clearTimeout(this.resizeTimer);
      this.resizeTimer = this.window.setTimeout(() => {
        if (this.window.innerWidth > 1100) {
          this.closeMobileNavigation();
        }
        if (this.activeView === "Overview") {
          this.chart.draw();
        }
      }, APP_CONFIG.resizeDebounceMs);
    });
  }

  emitAction(action, detail = {}) {
    this.dispatchEvent(new CustomEvent("action", { detail: { action, ...detail } }));
  }

  startTimers() {
    this.relativeTimeTimer = this.window.setInterval(
      () => this.updateRelativeTime(),
      APP_CONFIG.relativeTimeIntervalMs
    );
  }

  scheduleReveal() {
    this.revealTimer = this.window.setTimeout(
      () => this.reveal(),
      APP_CONFIG.dashboardRevealTimeoutMs
    );
  }

  reveal() {
    if (this.revealTimer !== null) {
      this.window.clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
    this.document.body?.classList.remove("dashboard-loading");
  }

  setIdentity(username) {
    const safeUsername = typeof username === "string" && username.trim() ? username.trim() : "Operator";
    const initial = safeUsername.charAt(0).toUpperCase();
    this.document.querySelectorAll("[data-auth-username]").forEach((element) => {
      element.textContent = safeUsername;
    });
    this.document.querySelectorAll("[data-user-initial]").forEach((element) => {
      element.textContent = initial;
    });
  }

  setText(id, value) {
    const element = this.document.getElementById(id);
    if (element) {
      element.textContent = String(value);
    }
  }

  render(state) {
    this.state = state;

    this.renderSafely("Summary", () => this.renderSummary(state.summary));
    this.renderSafely("Loading state", () => this.renderLoading(state.loading));
    this.renderSafely("Connection status", () => this.renderConnectionStatus(state.connectionStatus));
    this.renderSafely("Alert panel", () => this.alertPanel.render(state.alerts, state.summary));
    this.renderSafely("Station ranking", () => this.stationCard.render(state.ranking));

    if (this.activeView === "Overview") {
      try {
        this.chart.render(state);
      } catch (error) {
        this.window.console.error("The chart component failed independently.", error);
        this.chart.showFallback("The chart could not be rendered. Monitoring summaries and ranking remain available.");
      }
    }

    if (this.elements.autoRefreshToggle) {
      this.elements.autoRefreshToggle.checked = Boolean(state.autoRefresh);
    }
    this.updateRelativeTime();

    if (state.stations.length) {
      this.reveal();
    }
  }

  renderSafely(componentName, renderComponent) {
    try {
      renderComponent();
    } catch (error) {
      this.window.console.error(`${componentName} failed to render.`, error);
      this.showToast(
        "Some monitoring details could not be rendered. Other dashboard sections remain available.",
        "error"
      );
    }
  }

  renderSummary(summary) {
    if (!summary) {
      return;
    }

    this.setText("totalTowerCount", summary.totalTowers);
    this.setText("onlineTowerCount", summary.onlineTowers);
    this.setText("offlineTowerCount", summary.offlineTowers);
    this.setText("averageInclination", summary.averageTilt.toFixed(2));
    this.setText("maximumInclination", `${summary.maximumTilt.toFixed(2)}°`);
    this.setText("minimumInclination", `${summary.minimumTilt.toFixed(2)}°`);
    this.setText("activeSensorCount", summary.totalSensors);
    this.setText("normalSensorCount", summary.normalSensors);
    this.setText("alertSensorCount", summary.attentionSensors);
    this.setText("systemHealthValue", summary.health);
    this.setText("sidebarTowerCount", summary.totalTowers);
    this.setText("towerOnlinePercent", `${summary.availability.toFixed(1)}% network availability`);
    this.setText("sensorNormalPercent", `${summary.sensorNormalRate.toFixed(1)}% reporting normally`);
    this.setText("healthMessage", summary.healthMessage);

    if (this.elements.towerOnlineProgress) {
      this.elements.towerOnlineProgress.style.width = `${summary.availability}%`;
    }
    if (this.elements.sensorNormalProgress) {
      this.elements.sensorNormalProgress.style.width = `${summary.sensorNormalRate}%`;
    }

    const healthAngle = (summary.health / 100) * 180;
    if (this.elements.healthGauge) {
      this.elements.healthGauge.style.background =
        `conic-gradient(from 270deg, var(--success) 0deg ${healthAngle}deg, #e7edf2 ${healthAngle}deg 180deg, transparent 180deg 360deg)`;
    }
    this.elements.healthGaugeContainer?.setAttribute(
      "aria-label",
      `System health ${summary.health} percent`
    );
    if (this.elements.healthLabel) {
      this.elements.healthLabel.textContent = summary.health >= 90 ? "Good" : "Attention";
    }
  }

  renderLoading(isLoading) {
    this.elements.analyticsPanel?.classList.toggle("is-loading", Boolean(isLoading));
    if (this.elements.refreshButton) {
      this.elements.refreshButton.disabled = Boolean(isLoading);
      this.elements.refreshButton.classList.toggle("is-loading", Boolean(isLoading));
    }
  }

  renderConnectionStatus(connectionStatus = {}) {
    const apiStatus = connectionStatus.api;
    const hasError = apiStatus === CONNECTION_STATUS.ERROR;
    if (this.elements.gatewayTitle) {
      this.elements.gatewayTitle.textContent = hasError ? "Data connection interrupted" : "Gateway online";
    }
    if (this.elements.gatewayMessage) {
      this.elements.gatewayMessage.textContent = hasError
        ? "Last valid monitoring data retained"
        : "LoRa network stable";
    }
    this.elements.gatewayIndicator?.classList.toggle("is-error", hasError);
  }

  updateRelativeTime() {
    const lastUpdatedAt = Number(this.state?.lastUpdatedAt);
    let relativeText = "not yet";

    if (Number.isFinite(lastUpdatedAt) && lastUpdatedAt > 0) {
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - lastUpdatedAt) / 1000));
      relativeText = "just now";
      if (elapsedSeconds >= 60) {
        const minutes = Math.floor(elapsedSeconds / 60);
        relativeText = `${minutes} min${minutes === 1 ? "" : "s"} ago`;
      } else if (elapsedSeconds >= 10) {
        relativeText = `${elapsedSeconds} sec ago`;
      }
    }

    if (this.elements.lastUpdated) {
      this.elements.lastUpdated.textContent = relativeText;
    }
    if (this.elements.lastSyncHeader) {
      this.elements.lastSyncHeader.textContent = relativeText.charAt(0).toUpperCase() + relativeText.slice(1);
    }
  }

  toggleNavigation() {
    if (!this.elements.appShell || !this.elements.menuButton) {
      return;
    }
    if (this.window.innerWidth <= 1100) {
      const open = this.elements.appShell.classList.toggle("sidebar-open");
      this.elements.menuButton.setAttribute("aria-expanded", open ? "true" : "false");
      this.document.body?.classList.toggle("sidebar-lock", open);
      return;
    }

    const collapsed = this.elements.appShell.classList.toggle("sidebar-collapsed");
    this.elements.menuButton.setAttribute("aria-expanded", collapsed ? "false" : "true");
    this.window.setTimeout(() => this.chart.draw(), 240);
  }

  setActiveView(view) {
    if (view !== "Overview" && view !== "List") {
      return false;
    }

    this.activeView = view;
    if (this.elements.overviewPage) {
      this.elements.overviewPage.hidden = view !== "Overview";
    }
    if (this.elements.listPage) {
      this.elements.listPage.hidden = view !== "List";
    }
    this.document.querySelectorAll(".sidebar-nav [data-nav-target]").forEach((item) => {
      const active = item.dataset.navTarget === view;
      item.classList.toggle("is-active", active);
      if (active) {
        item.setAttribute("aria-current", "page");
      } else {
        item.removeAttribute("aria-current");
      }
    });

    const pageTitle = view === "List"
      ? "Sensor Data List"
      : "Tower Inclination Monitoring System";
    if (this.elements.topbarTitle) {
      this.elements.topbarTitle.textContent = pageTitle;
    }
    this.document.title = `${view === "List" ? "Sensor Data List" : "Overview"} | Tower Inclination Monitoring System`;
    this.document.body?.setAttribute("data-active-view", view.toLowerCase());

    if (view === "Overview") {
      this.window.setTimeout(() => this.chart.render(this.state), 0);
    }
    return true;
  }

  closeMobileNavigation() {
    this.elements.appShell?.classList.remove("sidebar-open");
    this.elements.menuButton?.setAttribute("aria-expanded", "false");
    this.document.body?.classList.remove("sidebar-lock");
  }

  toggleAccountMenu() {
    if (!this.elements.accountDropdown || !this.elements.accountButton) {
      return;
    }
    const willOpen = this.elements.accountDropdown.hidden;
    this.elements.accountDropdown.hidden = !willOpen;
    this.elements.accountButton.setAttribute("aria-expanded", willOpen ? "true" : "false");
  }

  closeAccountMenu() {
    if (this.elements.accountDropdown) {
      this.elements.accountDropdown.hidden = true;
    }
    this.elements.accountButton?.setAttribute("aria-expanded", "false");
  }

  exportStationData() {
    const stations = this.store.getState().stations;
    if (!stations.length) {
      this.showToast("No station data is available to export.", "warning");
      return;
    }

    const headers = ["Tower ID", "Name", "Location", "Max Tilt (deg)", "Status", "Online", "Sensors", "RSSI", "Battery"];
    const rows = stations.map((station) => [
      station.id,
      station.name,
      station.location,
      station.maxTilt.toFixed(2),
      station.status,
      station.online ? "Yes" : "No",
      station.sensors,
      station.rssi,
      `${station.battery}%`
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const downloadUrl = URL.createObjectURL(blob);
    const link = this.document.createElement("a");
    link.href = downloadUrl;
    link.download = `tower-monitoring-${new Date().toISOString().slice(0, 10)}.csv`;
    this.document.body?.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(downloadUrl);
    this.showToast("Tower monitoring data exported as CSV.", "info");
  }

  showToast(message, type = "info") {
    if (!this.elements.toast || !this.elements.toastMessage) {
      return;
    }

    this.window.clearTimeout(this.toastTimer);
    this.elements.toastMessage.textContent = message;
    this.elements.toast.classList.toggle("is-warning", type === "warning");
    this.elements.toast.classList.toggle("is-error", type === "error");
    this.elements.toast.classList.add("is-visible");
    this.toastTimer = this.window.setTimeout(() => {
      this.elements.toast?.classList.remove("is-visible");
    }, APP_CONFIG.toastDurationMs);
  }

  destroy() {
    this.abortController.abort();
    this.unsubscribe?.();
    this.chart.destroy();
    this.window.clearTimeout(this.toastTimer);
    this.window.clearTimeout(this.resizeTimer);
    this.window.clearTimeout(this.revealTimer);
    this.window.clearInterval(this.relativeTimeTimer);
  }
}
