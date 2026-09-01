import { TowerTrendChart } from "../components/TowerTrendChart.js?v=20260824.3";
import { TowerVectorChart } from "../components/TowerVectorChart.js?v=20260901.3";
import { TOWERS_CONFIG } from "../core/config.js?v=20260824.2";
import {
  createTowerViewModel,
  filterTowerReadings,
  localIsoDate,
  mergeTowerReadings,
  normalizeTowerReading,
  shiftLocalDate
} from "../logic/towerMonitoringProcessor.js?v=20260824.3";

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
    this.onToast = typeof options.onToast === "function" ? options.onToast : () => {};
    this.historyService = options.historyService || null;
    this.towerRegistry = options.towerRegistryService || null;
    this.abortController = new AbortController();
    this.state = readonlyStore.getState();
    this.registryState = this.towerRegistry?.getState() || { towers: [], initialized: true, error: null };
    this.historyByTower = new Map();
    this.historyLoadedTowerIds = new Set();
    this.historyErrors = new Map();
    this.historyInvalidRows = new Map();
    this.historyLoadingTowerId = "";
    this.historyRequest = null;
    this.historyRequestSequence = 0;
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
    this.unsubscribeStore = this.store.subscribe((state) => this.ingestState(state));
    this.unsubscribeRegistry = this.towerRegistry?.subscribe(
      (state) => this.handleRegistryState(state),
      { immediate: false }
    );
    this.syncRegisteredTowers();
    this.render();
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
      batteryValue: byId("towerCurrentBattery"),
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
      assessment: byId("towerTiltAssessment"),
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
    if (this.towerRegistry) {
      return;
    }
    this.ingestLegacyReadings(state.sensorData);
    this.syncRegisteredTowers();
    this.render();
  }

  ingestLegacyReadings(sensorData) {
    this.invalidReadingCount = 0;
    const groupedReadings = new Map();
    (Array.isArray(sensorData) ? sensorData : []).forEach((packet) => {
      try {
        const reading = normalizeTowerReading(packet);
        const readings = groupedReadings.get(reading.stationId) || [];
        readings.push(reading);
        groupedReadings.set(reading.stationId, readings);
      } catch (error) {
        this.invalidReadingCount += 1;
        this.window.console.warn("An invalid Towers reading was ignored.", error);
      }
    });
    groupedReadings.forEach((readings, towerId) => {
      this.historyByTower.set(
        towerId,
        mergeTowerReadings(
          this.historyByTower.get(towerId) || [],
          readings,
          this.config.maximumHistoryPointsPerTower
        )
      );
      this.historyLoadedTowerIds.add(towerId);
    });
  }

  handleRegistryState(state) {
    this.registryState = state;
    this.syncRegisteredTowers();
    this.render();
    if (this.active && this.selectedTowerId && !this.historyLoadedTowerIds.has(this.selectedTowerId)) {
      void this.refreshHistoricalReadings({ automatic: true });
    }
  }

  syncRegisteredTowers() {
    const stations = this.sortedStations();
    const stationIds = new Set(stations.map((station) => station.id));
    [...this.historyByTower.keys()].forEach((towerId) => {
      if (!stationIds.has(towerId)) {
        this.historyByTower.delete(towerId);
        this.historyLoadedTowerIds.delete(towerId);
        this.historyErrors.delete(towerId);
        this.historyInvalidRows.delete(towerId);
      }
    });

    if (!stationIds.has(this.selectedTowerId)) {
      const previousTowerId = this.selectedTowerId;
      this.selectedTowerId = stations[0]?.id || "";
      this.filterTouched = false;
      if (previousTowerId && this.historyLoadingTowerId === previousTowerId) {
        this.cancelHistoryRequest();
      }
      this.followLatestDate();
    }
  }

  sortedStations() {
    if (!this.towerRegistry) {
      return [...(this.state.stations || [])].sort((left, right) => left.id.localeCompare(right.id));
    }
    return [...(this.registryState.towers || [])]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((tower) => ({
        ...tower,
        online: this.historyLoadedTowerIds.has(tower.id)
          && !this.historyErrors.has(tower.id)
          && (this.historyByTower.get(tower.id)?.length || 0) > 0
      }));
  }

  changeTower(towerId) {
    if (!this.sortedStations().some((station) => station.id === towerId) || towerId === this.selectedTowerId) {
      return;
    }
    this.cancelHistoryRequest();
    this.selectedTowerId = towerId;
    this.filterTouched = false;
    this.followLatestDate();
    this.render();
    if (this.active && !this.historyLoadedTowerIds.has(towerId)) {
      void this.refreshHistoricalReadings({ automatic: true });
    }
  }

  followLatestDate() {
    if (this.filterTouched) {
      return;
    }
    const readings = this.historyByTower.get(this.selectedTowerId) || [];
    const latest = readings.at(-1);
    this.day = latest?.date || localIsoDate(latest?.timestamp || Date.now());
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
    if (this.refreshPromise || !this.selectedTowerId) {
      return this.refreshPromise;
    }
    this.refreshing = true;
    this.render();
    this.refreshPromise = (async () => {
      try {
        await this.refreshHistoricalReadings({ rethrow: true });
        this.announce(`${this.selectedTowerId} data refreshed.`);
        this.onToast(`Tower ${this.selectedTowerId} data refreshed successfully.`, "info");
      } catch (error) {
        this.window.console.error("Towers refresh failed.", error);
        this.onToast(error?.message || "Tower data could not be refreshed.", "error");
      } finally {
        this.refreshing = false;
        this.refreshPromise = null;
        this.render();
      }
    })();
    return this.refreshPromise;
  }

  refreshHistoricalReadings({ automatic = false, rethrow = false } = {}) {
    const towerId = this.selectedTowerId;
    if (!this.historyService || !towerId) {
      return Promise.resolve(null);
    }
    if (this.historyRequest?.towerId === towerId) {
      return this.historyRequest.promise;
    }

    this.cancelHistoryRequest();
    const sequence = ++this.historyRequestSequence;
    this.historyLoadingTowerId = towerId;
    this.historyErrors.delete(towerId);
    this.render();
    const promise = (async () => {
      try {
        const result = await this.historyService.fetchReadings(towerId);
        if (sequence !== this.historyRequestSequence) {
          return null;
        }
        const readings = Array.isArray(result.readings) ? result.readings : [];
        this.historyInvalidRows.set(towerId, result.invalidRows?.length || 0);
        this.replaceHistoricalReadings(towerId, readings);
        this.historyLoadedTowerIds.add(towerId);
        this.followLatestDate();
        return result;
      } catch (error) {
        if (error?.name === "AbortError" || sequence !== this.historyRequestSequence) {
          return null;
        }
        const message = error?.message || `Tower ${towerId} data could not be loaded.`;
        this.historyErrors.set(towerId, message);
        this.window.console.error(`Tower history refresh failed for ${towerId}.`, error);
        if (!automatic && !rethrow) {
          this.onToast(message, "error");
        }
        if (rethrow) {
          throw error;
        }
        return null;
      } finally {
        if (sequence === this.historyRequestSequence) {
          this.historyLoadingTowerId = "";
          this.historyRequest = null;
          this.render();
        }
      }
    })();
    this.historyRequest = { towerId, promise };
    return promise;
  }

  replaceHistoricalReadings(towerId, readings) {
    const validReadings = [];
    let invalidCount = this.historyInvalidRows.get(towerId) || 0;
    readings.forEach((packet) => {
      try {
        const reading = normalizeTowerReading(packet);
        if (reading.stationId !== towerId) {
          throw new TypeError("Historical reading belongs to a different tower.");
        }
        validReadings.push(reading);
      } catch (error) {
        invalidCount += 1;
        this.window.console.warn(`An invalid reading for ${towerId} was ignored.`, error);
      }
    });
    this.historyInvalidRows.set(towerId, invalidCount);
    this.historyByTower.set(
      towerId,
      mergeTowerReadings([], validReadings, this.config.maximumHistoryPointsPerTower)
    );
  }

  cancelHistoryRequest() {
    if (!this.historyRequest && !this.historyLoadingTowerId) {
      return;
    }
    this.historyRequestSequence += 1;
    this.historyService?.cancelActiveRequest();
    this.historyRequest = null;
    this.historyLoadingTowerId = "";
  }

  currentStation() {
    return this.sortedStations().find((station) => station.id === this.selectedTowerId) || null;
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
    if (this.selectedTowerId && !this.historyLoadedTowerIds.has(this.selectedTowerId)) {
      void this.refreshHistoricalReadings({ automatic: true });
    }
    this.window.setTimeout(() => {
      if (this.active) {
        this.trendChart.draw();
        this.vectorChart.draw();
      }
    }, 0);
  }

  close() {
    this.active = false;
    this.cancelHistoryRequest();
  }

  render() {
    const stations = this.sortedStations();
    this.renderTowerOptions(stations);
    this.renderFilters();
    this.renderError(stations.length);
    const filteredReadings = this.filteredReadings();
    const viewModel = createTowerViewModel(this.currentStation(), filteredReadings, { fallbackToStation: false });
    this.renderMetrics(viewModel);
    this.renderVectorValues(viewModel);
    const loading = Boolean(
      this.refreshing
      || this.historyLoadingTowerId === this.selectedTowerId
      || (this.towerRegistry && !this.registryState.initialized)
    );
    this.elements.refreshButton.disabled = loading || stations.length === 0;
    this.elements.refreshButton.classList.toggle("is-loading", loading);
    this.elements.trendLoading.hidden = !loading || filteredReadings.length > 0;
    this.elements.vectorLoading.hidden = !loading || Boolean(viewModel?.latest);

    if (this.active) {
      this.trendChart.render(filteredReadings, { period: this.period });
      this.vectorChart.render(viewModel, { period: this.period });
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
    const invalidCount = this.historyInvalidRows.get(this.selectedTowerId) || this.invalidReadingCount;
    const noReadings = Boolean(
      this.selectedTowerId
      && this.historyLoadedTowerIds.has(this.selectedTowerId)
      && this.currentReadings().length === 0
    );
    const message = this.registryState.error
      || this.historyErrors.get(this.selectedTowerId)
      || (invalidCount ? `${invalidCount} invalid sensor reading(s) were ignored.` : "")
      || (noReadings ? `Google Sheet ${this.selectedTowerId} contains no valid sensor readings.` : "")
      || (!this.towerRegistry ? this.state.error : "");
    this.elements.errorBanner.hidden = !message;
    if (message) {
      this.elements.errorMessage.textContent = message;
    }

    const initialLoading = stationCount === 0 && Boolean(this.towerRegistry && !this.registryState.initialized);
    this.elements.emptyState.hidden = stationCount > 0;
    this.elements.emptyState.classList.toggle("is-loading", initialLoading);
    this.elements.emptyTitle.textContent = initialLoading ? "Loading towers…" : "No towers added";
    this.elements.emptyDescription.textContent = initialLoading
      ? "Loading the saved tower registry."
      : "Add a tower in System Settings to link its Tower ID with the matching Google Sheet tab.";
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
    this.elements.batteryValue.textContent = Number.isFinite(latest?.battery) ? `${latest.battery.toFixed(2)} V` : "—";
    this.elements.xValue.textContent = latest ? `${latest.x.toFixed(2)}°` : "—";
    this.elements.yValue.textContent = latest ? `${latest.y.toFixed(2)}°` : "—";
    this.elements.zValue.textContent = latest ? `${latest.z.toFixed(2)}°` : "—";
    this.elements.resultantValue.textContent = latest ? `${viewModel.resultant.toFixed(2)}°` : "—";
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
    this.elements.vectorResultant.textContent = latest ? `${viewModel.resultant.toFixed(2)}°` : "—";
    this.elements.direction.textContent = viewModel?.direction || "No direction";
    this.elements.angle.textContent = latest ? `${viewModel.resultant.toFixed(2)}°` : "—";
    const status = latest ? (viewModel?.status || "offline") : "offline";
    this.elements.assessment.className = `tower-tilt-assessment ${status}`;
    this.elements.assessment.textContent = latest
      ? (STATUS_LABELS[status] || "Unavailable")
      : "Unavailable";
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
    this.unsubscribeStore?.();
    this.unsubscribeRegistry?.();
    this.trendChart.destroy();
    this.vectorChart.destroy();
    this.historyService?.destroy();
  }
}
