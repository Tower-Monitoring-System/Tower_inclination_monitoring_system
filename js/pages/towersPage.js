import { TowerTrendChart } from "../components/TowerTrendChart.js?v=20260824.2";
import { TowerVectorChart } from "../components/TowerVectorChart.js?v=20260824.2";
import { TOWERS_CONFIG } from "../core/config.js";
import {
  createTowerViewModel,
  filterTowerReadings,
  localIsoDate,
  mergeTowerReadings,
  normalizeTowerReading,
  shiftLocalDate
} from "../logic/towerMonitoringProcessor.js";

const STATUS_LABELS = Object.freeze({
  normal: "Stable",
  warning: "Warning",
  alert: "Critical",
  offline: "Offline"
});

const READING_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

export class TowersPage {
  constructor(readonlyStore, options = {}) {
    this.store = readonlyStore;
    this.config = options.config || TOWERS_CONFIG;
    this.document = options.documentRef || document;
    this.window = options.windowRef || window;
    this.onRefresh = typeof options.onRefresh === "function" ? options.onRefresh : async () => {};
    this.onToast = typeof options.onToast === "function" ? options.onToast : () => {};
    this.abortController = new AbortController();
    this.state = readonlyStore.getState();
    this.historyByTower = new Map();
    this.selectedTowerId = "";
    this.period = "day";
    this.day = localIsoDate();
    this.month = this.day.slice(0, 7);
    this.customStart = shiftLocalDate(this.day, -2);
    this.customEnd = this.day;
    this.filterTouched = false;
    this.invalidReadingCount = 0;
    this.active = false;
    this.refreshing = false;
    this.refreshPromise = null;
    this.elements = this.collectElements();
    this.trendChart = new TowerTrendChart(this.document, this.window);
    this.vectorChart = new TowerVectorChart(this.document, this.window);

    this.bindEvents();
    this.unsubscribe = this.store.subscribe((state) => this.ingestState(state));
  }

  collectElements() {
    const byId = (id) => this.document.getElementById(id);
    return {
      page: byId("towersPage"),
      towerSelect: byId("towerSelect"),
      selectedName: byId("towerSelectedName"),
      selectedId: byId("towerSelectedId"),
      selectedLocation: byId("towerSelectedLocation"),
      selectedStatus: byId("towerSelectedStatus"),
      xValue: byId("towerCurrentX"),
      yValue: byId("towerCurrentY"),
      zValue: byId("towerCurrentZ"),
      resultantValue: byId("towerResultant"),
      xCard: byId("towerXCard"),
      yCard: byId("towerYCard"),
      zCard: byId("towerZCard"),
      resultantCard: byId("towerResultantCard"),
      rangePicker: byId("towerRangePicker"),
      dayPicker: byId("towerDayPicker"),
      monthPicker: byId("towerMonthPicker"),
      customPickers: byId("towerCustomPickers"),
      customStart: byId("towerCustomStart"),
      customEnd: byId("towerCustomEnd"),
      refreshButton: byId("towerRefreshButton"),
      errorBanner: byId("towerErrorBanner"),
      errorMessage: byId("towerErrorMessage"),
      emptyState: byId("towerEmptyState"),
      emptyTitle: byId("towerEmptyTitle"),
      emptyDescription: byId("towerEmptyDescription"),
      content: byId("towerMonitoringContent"),
      trendLoading: byId("towerTrendLoading"),
      vectorLoading: byId("towerVectorLoading"),
      vectorX: byId("towerVectorX"),
      vectorY: byId("towerVectorY"),
      vectorZ: byId("towerVectorZ"),
      vectorResultant: byId("towerVectorResultant"),
      direction: byId("towerDirection"),
      angle: byId("towerAngle"),
      lastReading: byId("towerLastReading"),
      liveStatus: byId("towerLiveStatus")
    };
  }

  listen(element, eventName, callback) {
    element?.addEventListener(eventName, callback, { signal: this.abortController.signal });
  }

  bindEvents() {
    this.listen(this.elements.towerSelect, "change", (event) => this.changeTower(event.target.value));
    this.document.querySelectorAll("[data-tower-period]").forEach((button) => {
      this.listen(button, "click", () => this.changePeriod(button.dataset.towerPeriod));
    });
    this.listen(this.elements.dayPicker, "change", (event) => {
      if (event.target.value) {
        this.day = event.target.value;
        this.filterTouched = true;
        this.render();
      }
    });
    this.listen(this.elements.monthPicker, "change", (event) => {
      if (event.target.value) {
        this.month = event.target.value;
        this.filterTouched = true;
        this.render();
      }
    });
    this.listen(this.elements.customStart, "change", () => this.changeCustomRange());
    this.listen(this.elements.customEnd, "change", () => this.changeCustomRange());
    this.listen(this.elements.refreshButton, "click", () => this.refresh());
  }

  ingestState(state) {
    this.state = state;
    this.invalidReadingCount = 0;
    const groupedReadings = new Map();

    (Array.isArray(state.sensorData) ? state.sensorData : []).forEach((packet) => {
      try {
        const reading = normalizeTowerReading(packet);
        const towerReadings = groupedReadings.get(reading.stationId) || [];
        towerReadings.push(reading);
        groupedReadings.set(reading.stationId, towerReadings);
      } catch (error) {
        this.invalidReadingCount += 1;
        this.window.console.warn("An invalid Towers reading was ignored.", error);
      }
    });

    groupedReadings.forEach((readings, towerId) => {
      try {
        this.historyByTower.set(
          towerId,
          mergeTowerReadings(
            this.historyByTower.get(towerId) || [],
            readings,
            this.config.maximumHistoryPointsPerTower
          )
        );
      } catch (error) {
        this.invalidReadingCount += readings.length;
        this.window.console.warn(`Tower history for ${towerId} could not be merged.`, error);
      }
    });

    const stationIds = new Set((state.stations || []).map((station) => station.id));
    [...this.historyByTower.keys()].forEach((towerId) => {
      if (!stationIds.has(towerId)) {
        this.historyByTower.delete(towerId);
      }
    });
    if (!stationIds.has(this.selectedTowerId)) {
      this.selectedTowerId = this.sortedStations()[0]?.id || "";
      this.filterTouched = false;
    }
    this.followLatestDate();
    this.render();
  }

  sortedStations() {
    return [...(this.state.stations || [])].sort((left, right) => left.id.localeCompare(right.id));
  }

  changeTower(towerId) {
    if (!this.sortedStations().some((station) => station.id === towerId)) {
      return;
    }
    this.selectedTowerId = towerId;
    this.filterTouched = false;
    this.followLatestDate();
    this.render();
  }

  followLatestDate() {
    if (this.filterTouched) {
      return;
    }
    const readings = this.historyByTower.get(this.selectedTowerId) || [];
    const timestamp = readings.at(-1)?.timestamp || this.state.lastUpdatedAt || Date.now();
    this.day = localIsoDate(timestamp);
    this.month = this.day.slice(0, 7);
    this.customEnd = this.day;
    this.customStart = shiftLocalDate(this.day, -2);
  }

  changePeriod(period) {
    if (!["day", "month", "custom"].includes(period) || period === this.period) {
      return;
    }
    this.period = period;
    this.filterTouched = true;
    this.render();
  }

  changeCustomRange() {
    const start = this.elements.customStart.value;
    const end = this.elements.customEnd.value;
    if (!start || !end) {
      return;
    }
    this.customStart = start <= end ? start : end;
    this.customEnd = start <= end ? end : start;
    this.filterTouched = true;
    this.render();
  }

  async refresh() {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshing = true;
    this.render();
    this.refreshPromise = (async () => {
      try {
        await this.onRefresh();
        this.announce("Tower monitoring data refreshed.");
      } catch (error) {
        this.window.console.error("Towers refresh failed.", error);
        this.onToast("Tower data could not be refreshed. The last valid values were retained.", "error");
      } finally {
        this.refreshing = false;
        this.refreshPromise = null;
        this.render();
      }
    })();
    return this.refreshPromise;
  }

  currentStation() {
    return (this.state.stations || []).find((station) => station.id === this.selectedTowerId) || null;
  }

  currentReadings() {
    return this.historyByTower.get(this.selectedTowerId) || [];
  }

  filteredReadings() {
    return filterTowerReadings(this.currentReadings(), {
      period: this.period,
      day: this.day,
      month: this.month,
      startDate: this.customStart,
      endDate: this.customEnd
    });
  }

  open() {
    this.active = true;
    this.render();
    this.window.setTimeout(() => {
      if (this.active) {
        this.trendChart.draw();
        this.vectorChart.draw();
      }
    }, 0);
  }

  close() {
    this.active = false;
  }

  render() {
    const stations = this.sortedStations();
    this.renderTowerOptions(stations);
    this.renderFilters();
    this.renderError(stations.length);
    const station = this.currentStation();
    const readings = this.currentReadings();
    const filteredReadings = this.filteredReadings();
    const viewModel = createTowerViewModel(station, readings);
    this.renderMetrics(viewModel);
    this.renderVectorValues(viewModel);
    const loading = Boolean(this.state.loading || this.refreshing);
    this.elements.refreshButton.disabled = loading || stations.length === 0;
    this.elements.refreshButton.classList.toggle("is-loading", loading);
    this.elements.trendLoading.hidden = !loading || filteredReadings.length > 0;
    this.elements.vectorLoading.hidden = !loading || Boolean(viewModel?.latest);

    if (this.active) {
      this.trendChart.render(filteredReadings);
      this.vectorChart.render(viewModel);
    }
  }

  renderTowerOptions(stations) {
    const fragment = this.document.createDocumentFragment();
    stations.forEach((station) => {
      const option = this.document.createElement("option");
      option.value = station.id;
      option.textContent = `${station.id} · ${station.name}`;
      fragment.append(option);
    });
    this.elements.towerSelect.replaceChildren(fragment);
    this.elements.towerSelect.value = this.selectedTowerId;
    this.elements.towerSelect.disabled = stations.length === 0;
  }

  renderFilters() {
    this.elements.dayPicker.value = this.day;
    this.elements.monthPicker.value = this.month;
    this.elements.customStart.value = this.customStart;
    this.elements.customEnd.value = this.customEnd;
    this.elements.customStart.max = this.customEnd;
    this.elements.customEnd.min = this.customStart;
    this.elements.dayPicker.hidden = this.period !== "day";
    this.elements.monthPicker.hidden = this.period !== "month";
    this.elements.customPickers.hidden = this.period !== "custom";
    this.elements.rangePicker.classList.toggle("is-custom", this.period === "custom");
    this.document.querySelectorAll("[data-tower-period]").forEach((button) => {
      const active = button.dataset.towerPeriod === this.period;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  renderError(stationCount) {
    const message = this.state.error
      || (this.invalidReadingCount ? `${this.invalidReadingCount} invalid sensor reading(s) were ignored.` : "");
    this.elements.errorBanner.hidden = !message;
    if (message) {
      this.elements.errorMessage.textContent = message;
    }
    const initialLoading = stationCount === 0 && Boolean(this.state.loading);
    this.elements.emptyState.hidden = stationCount > 0;
    this.elements.emptyState.classList.toggle("is-loading", initialLoading);
    this.elements.emptyTitle.textContent = initialLoading ? "Loading towers…" : "No towers available";
    this.elements.emptyDescription.textContent = initialLoading
      ? "Validating the latest station and sensor data."
      : "Connect a station data source, then refresh the dashboard to begin monitoring.";
    this.elements.content.hidden = stationCount === 0;
  }

  renderMetrics(viewModel) {
    const station = viewModel?.station;
    const latest = viewModel?.latest;
    this.elements.selectedName.textContent = station?.name || "No tower selected";
    this.elements.selectedId.textContent = station?.id || "—";
    this.elements.selectedLocation.textContent = station?.location || "No location available";
    const status = viewModel?.status || "offline";
    this.elements.selectedStatus.className = `tower-status-badge ${status}`;
    this.elements.selectedStatus.textContent = STATUS_LABELS[status] || "Unavailable";
    this.elements.xValue.textContent = latest ? `${latest.x.toFixed(2)}°` : "—";
    this.elements.yValue.textContent = latest ? `${latest.y.toFixed(2)}°` : "—";
    this.elements.zValue.textContent = latest ? `${latest.z.toFixed(2)}°` : "—";
    this.elements.resultantValue.textContent = viewModel ? `${viewModel.resultant.toFixed(2)}°` : "—";
    this.setMetricSeverity(this.elements.xCard, latest ? Math.abs(latest.x) : 0);
    this.setMetricSeverity(this.elements.yCard, latest ? Math.abs(latest.y) : 0);
    this.setMetricSeverity(this.elements.zCard, latest ? Math.abs(latest.z) : 0);
    this.setMetricSeverity(this.elements.resultantCard, viewModel?.resultant || 0);
  }

  setMetricSeverity(card, value) {
    card.classList.toggle("is-warning", value >= 0.7 && value < 1);
    card.classList.toggle("is-alert", value >= 1);
  }

  renderVectorValues(viewModel) {
    const latest = viewModel?.latest;
    this.elements.vectorX.textContent = latest ? `${latest.x.toFixed(2)}°` : "—";
    this.elements.vectorY.textContent = latest ? `${latest.y.toFixed(2)}°` : "—";
    this.elements.vectorZ.textContent = latest ? `${latest.z.toFixed(2)}°` : "—";
    this.elements.vectorResultant.textContent = viewModel ? `${viewModel.resultant.toFixed(2)}°` : "—";
    this.elements.direction.textContent = viewModel?.direction || "No direction";
    this.elements.angle.textContent = viewModel ? `${viewModel.resultant.toFixed(2)}°` : "—";
    this.elements.lastReading.textContent = latest?.timestamp
      ? `Last reading ${READING_TIME.format(new Date(latest.timestamp))}`
      : "No sensor reading received yet";
  }

  announce(message) {
    this.elements.liveStatus.textContent = "";
    this.window.setTimeout(() => {
      if (this.elements.liveStatus) {
        this.elements.liveStatus.textContent = message;
      }
    }, 0);
  }

  destroy() {
    this.close();
    this.abortController.abort();
    this.unsubscribe?.();
    this.trendChart.destroy();
    this.vectorChart.destroy();
  }
}
