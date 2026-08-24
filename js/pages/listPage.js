import { SENSOR_DATA_CONFIG } from "../core/config.js";
import { createAlertConfiguration } from "../core/settingsDefaults.js";
import {
  filterSensorReadings,
  getLatestReadingDate,
  paginateSensorReadings,
  sortSensorReadings
} from "../logic/sensorDataProcessor.js";
import { downloadSensorDataWorkbook } from "../utils/xlsxExporter.js";

const PERIOD_COPY = Object.freeze({
  day: Object.freeze({
    title: "View by day",
    description: "Select a date to view sensor data for that day"
  }),
  month: Object.freeze({
    title: "View by month",
    description: "Select a month to review all readings recorded in that month"
  }),
  custom: Object.freeze({
    title: "View by custom range",
    description: "Select a From and To date to review sensor data within that range"
  })
});

function localIsoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftIsoDate(value, dayOffset) {
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString().slice(0, 10);
}

function formatDisplayDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return `${month}/${day}/${year}`;
}

function formatNumber(value) {
  return Number(value).toFixed(2);
}

function paginationItems(pageCount, currentPage) {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  const pages = new Set([1, pageCount, currentPage - 1, currentPage, currentPage + 1]);
  const ordered = [...pages].filter((page) => page >= 1 && page <= pageCount).sort((a, b) => a - b);
  const items = [];
  ordered.forEach((page, index) => {
    if (index > 0 && page - ordered[index - 1] > 1) {
      items.push("ellipsis");
    }
    items.push(page);
  });
  return items;
}

export class ListPage {
  constructor(sensorDataService, options = {}) {
    this.service = sensorDataService;
    this.config = options.config || SENSOR_DATA_CONFIG;
    this.settingsService = options.settingsService || null;
    this.batteryThresholds = this.settingsService?.getBatteryThresholds()
      || createAlertConfiguration().battery;
    this.document = options.documentRef || document;
    this.window = options.windowRef || window;
    this.onToast = typeof options.onToast === "function" ? options.onToast : () => {};
    this.abortController = new AbortController();
    this.records = [];
    this.invalidRowCount = 0;
    this.period = "day";
    this.sortField = "date";
    this.sortDirection = "descending";
    this.currentPage = 1;
    this.selectedDate = localIsoDate();
    this.customStart = shiftIsoDate(this.selectedDate, -2);
    this.customEnd = this.selectedDate;
    this.loading = false;
    this.error = null;
    this.active = false;
    this.filterTouched = false;
    this.pollingTimer = null;
    this.refreshPromise = null;
    this.elements = this.collectElements();

    this.initializePickers();
    this.bindEvents();
    this.unsubscribeSettings = this.settingsService?.subscribe(() => {
      this.batteryThresholds = this.settingsService.getBatteryThresholds();
      this.renderTable();
    }, { immediate: false });
    this.render();
  }

  collectElements() {
    const byId = (id) => this.document.getElementById(id);
    return {
      page: byId("listPage"),
      filterTitle: byId("listFilterTitle"),
      filterDescription: byId("listFilterDescription"),
      picker: byId("listPicker"),
      dayPicker: byId("listDayPicker"),
      monthPicker: byId("listMonthPicker"),
      customPickers: byId("listCustomPickers"),
      customStart: byId("listCustomStart"),
      customEnd: byId("listCustomEnd"),
      refreshButton: byId("listRefreshButton"),
      exportButton: byId("listExportButton"),
      errorBanner: byId("listErrorBanner"),
      errorMessage: byId("listErrorMessage"),
      errorRetry: byId("listErrorRetry"),
      tableBody: byId("sensorTableBody"),
      dateHeader: byId("listDateHeader"),
      timeHeader: byId("listTimeHeader"),
      recordSummary: byId("listRecordSummary"),
      pagination: byId("listPagination"),
      liveStatus: byId("listLiveStatus")
    };
  }

  listen(element, eventName, callback) {
    element?.addEventListener(eventName, callback, { signal: this.abortController.signal });
  }

  initializePickers() {
    this.elements.dayPicker.value = this.selectedDate;
    this.elements.monthPicker.value = this.selectedDate.slice(0, 7);
    this.elements.customStart.value = this.customStart;
    this.elements.customEnd.value = this.customEnd;
  }

  bindEvents() {
    this.document.querySelectorAll("[data-list-period]").forEach((button) => {
      this.listen(button, "click", () => this.changePeriod(button.dataset.listPeriod));
    });
    this.document.querySelectorAll("[data-list-picker]").forEach((picker) => {
      this.listen(picker, "change", () => this.changeSelectedPeriod(picker.value));
    });
    this.listen(this.elements.customStart, "change", () => this.changeCustomRange());
    this.listen(this.elements.customEnd, "change", () => this.changeCustomRange());
    this.document.querySelectorAll("[data-list-sort]").forEach((button) => {
      this.listen(button, "click", () => this.changeSort(button.dataset.listSort));
    });
    this.listen(this.elements.refreshButton, "click", () => this.refresh({ automatic: false }));
    this.listen(this.elements.errorRetry, "click", () => this.refresh({ automatic: false }));
    this.listen(this.elements.exportButton, "click", () => this.exportFilteredData());
    this.listen(this.document, "visibilitychange", () => this.handleVisibilityChange());
  }

  open() {
    if (this.active) {
      return;
    }
    this.active = true;
    if (this.refreshPromise) {
      void this.refreshPromise.finally(() => {
        if (this.active) {
          void this.refresh({ automatic: this.records.length > 0 });
        }
      });
      return;
    }
    void this.refresh({ automatic: this.records.length > 0 });
  }

  close() {
    this.active = false;
    this.clearPollingTimer();
    this.service.cancelActiveRequest();
  }

  changePeriod(period) {
    if (!PERIOD_COPY[period] || period === this.period) {
      return;
    }
    this.period = period;
    this.currentPage = 1;
    this.filterTouched = true;
    this.syncPickerValues();
    this.render();
  }

  changeSelectedPeriod(value) {
    if (!["day", "month"].includes(this.period) || typeof value !== "string" || !value) {
      return;
    }

    this.selectedDate = this.period === "day" ? value : `${value}-01`;
    this.currentPage = 1;
    this.filterTouched = true;
    this.syncPickerValues();
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
    this.currentPage = 1;
    this.filterTouched = true;
    this.render();
  }

  syncPickerValues() {
    this.elements.dayPicker.value = this.selectedDate;
    this.elements.monthPicker.value = this.selectedDate.slice(0, 7);
    this.elements.customStart.value = this.customStart;
    this.elements.customEnd.value = this.customEnd;
    this.elements.customStart.max = this.customEnd;
    this.elements.customEnd.min = this.customStart;
    this.elements.customPickers.hidden = this.period !== "custom";
    this.elements.picker.classList.toggle("is-custom", this.period === "custom");
    this.document.querySelectorAll("[data-list-picker]").forEach((picker) => {
      picker.hidden = picker.dataset.listPicker !== this.period;
    });
    this.document.querySelectorAll("[data-list-period]").forEach((button) => {
      const active = button.dataset.listPeriod === this.period;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  changeSort(field) {
    if (field !== "date" && field !== "time") {
      return;
    }
    if (this.sortField === field) {
      this.sortDirection = this.sortDirection === "ascending" ? "descending" : "ascending";
    } else {
      this.sortField = field;
      this.sortDirection = field === "date" ? "descending" : "ascending";
    }
    this.currentPage = 1;
    this.render();
  }

  async refresh({ automatic = false } = {}) {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.clearPollingTimer();
    this.loading = true;
    this.error = null;
    this.render();

    this.refreshPromise = (async () => {
      try {
        const result = await this.service.fetchReadings();
        this.records = [...result.readings];
        this.invalidRowCount = result.invalidRows.length;
        const latestDate = getLatestReadingDate(this.records);
        if (!this.filterTouched && latestDate) {
          this.selectedDate = latestDate;
          this.customEnd = latestDate;
          this.customStart = shiftIsoDate(latestDate, -2);
        }
        this.syncPickerValues();
        this.error = null;

        if (result.invalidRows.length) {
          this.window.console.warn(
            `${result.invalidRows.length} sensor row(s) failed client validation and were ignored.`
          );
        }
        if (!automatic) {
          this.onToast("Sensor data refreshed successfully.", "info");
        }
        this.announce(`${this.records.length} sensor data entries loaded.`);
      } catch (error) {
        if (error?.name === "AbortError") {
          return;
        }
        const timedOut = error?.name === "TimeoutError";
        this.error = timedOut
          ? "The request timed out. The last valid readings were retained."
          : error?.message || "The sensor-data service could not be reached";
        this.window.console.error("Sensor data refresh failed", error);
        if (!automatic) {
          this.onToast(this.error, "error");
        }
        this.announce(this.error);
      } finally {
        this.loading = false;
        this.refreshPromise = null;
        this.render();
        this.schedulePolling();
      }
    })();

    return this.refreshPromise;
  }

  getFilteredReadings() {
    const selectedValue = this.period === "custom"
      ? { from: this.customStart, to: this.customEnd }
      : this.period === "day"
        ? this.selectedDate
        : this.selectedDate.slice(0, 7);
    const filtered = filterSensorReadings(this.records, this.period, selectedValue);
    return sortSensorReadings(filtered, this.sortField, this.sortDirection);
  }

  render() {
    const copy = PERIOD_COPY[this.period];
    this.elements.filterTitle.textContent = copy.title;
    this.elements.filterDescription.textContent = copy.description;
    this.syncPickerValues();
    this.renderSortHeaders();
    this.elements.refreshButton.disabled = this.loading;
    this.elements.refreshButton.classList.toggle("is-loading", this.loading);
    this.renderError();
    this.renderTable();
  }

  renderSortHeaders() {
    this.elements.dateHeader.setAttribute(
      "aria-sort",
      this.sortField === "date" ? this.sortDirection : "none"
    );
    this.elements.timeHeader.setAttribute(
      "aria-sort",
      this.sortField === "time" ? this.sortDirection : "none"
    );
  }

  renderError() {
    this.elements.errorBanner.hidden = !this.error;
    if (this.error) {
      this.elements.errorMessage.textContent = this.error;
    }
  }

  createStateRow(type, title, description) {
    const row = this.document.createElement("tr");
    row.className = "list-state-row";
    const cell = this.document.createElement("td");
    cell.colSpan = 6;

    if (type === "loading") {
      const spinner = this.document.createElement("span");
      spinner.className = "list-state-spinner";
      spinner.setAttribute("aria-hidden", "true");
      cell.append(spinner);
    } else {
      const icon = this.document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = type === "error" ? "!" : "—";
      cell.append(icon);
    }

    const heading = this.document.createElement("strong");
    heading.textContent = title;
    cell.append(heading);
    if (description) {
      const detail = this.document.createElement("small");
      detail.textContent = description;
      cell.append(detail);
    }
    row.append(cell);
    return row;
  }

  renderTable() {
    const filtered = this.getFilteredReadings();
    const pageData = paginateSensorReadings(filtered, this.currentPage, this.config.pageSize);
    this.currentPage = pageData.page;
    this.elements.exportButton.disabled = this.loading || filtered.length === 0;

    if (this.loading && this.records.length === 0) {
      this.elements.tableBody.replaceChildren(
        this.createStateRow("loading", "Loading sensor data…", "Validating the latest Google Sheets readings.")
      );
      this.renderPagination(filtered.length, pageData);
      return;
    }

    if (this.error && this.records.length === 0) {
      this.elements.tableBody.replaceChildren(
        this.createStateRow("error", "Sensor data could not be loaded", "Use Try again when the connection is available.")
      );
      this.renderPagination(filtered.length, pageData);
      return;
    }

    if (this.records.length === 0) {
      this.elements.tableBody.replaceChildren(
        this.createStateRow("empty", "No sensor readings available", "Add rows to Google Sheets, then refresh this page.")
      );
      this.renderPagination(filtered.length, pageData);
      return;
    }

    if (filtered.length === 0) {
      const periodLabel = this.period === "custom" ? "date range" : this.period;
      this.elements.tableBody.replaceChildren(
        this.createStateRow("empty", `No readings found for this ${periodLabel}`, "Choose another period or refresh after new data is added.")
      );
      this.renderPagination(filtered.length, pageData);
      return;
    }

    const fragment = this.document.createDocumentFragment();
    pageData.rows.forEach((reading) => fragment.append(this.createReadingRow(reading)));
    this.elements.tableBody.replaceChildren(fragment);
    this.renderPagination(filtered.length, pageData);
  }

  createReadingRow(reading) {
    const row = this.document.createElement("tr");
    const values = [
      formatDisplayDate(reading.date),
      reading.time,
      formatNumber(reading.x),
      formatNumber(reading.y),
      formatNumber(reading.z)
    ];
    values.forEach((value) => {
      const cell = this.document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    });

    const batteryCell = this.document.createElement("td");
    const badge = this.document.createElement("span");
    badge.className = `battery-badge ${this.batteryStatus(reading.battery)}`;
    badge.textContent = `${formatNumber(reading.battery)} V`;
    batteryCell.append(badge);
    row.append(batteryCell);
    return row;
  }

  batteryStatus(voltage) {
    if (voltage < this.batteryThresholds.critical) {
      return "critical";
    }
    if (voltage < this.batteryThresholds.warning) {
      return "warning";
    }
    return "normal";
  }

  renderPagination(totalEntries, pageData) {
    if (totalEntries === 0) {
      this.elements.recordSummary.textContent = "Showing 0 entries";
    } else {
      this.elements.recordSummary.textContent =
        `Showing ${pageData.startIndex + 1} to ${pageData.endIndex} of ${totalEntries} entries`;
    }

    const fragment = this.document.createDocumentFragment();
    if (pageData.pageCount > 1) {
      fragment.append(this.createPageButton("‹", pageData.page - 1, pageData.page === 1, "Previous page"));
      paginationItems(pageData.pageCount, pageData.page).forEach((item) => {
        if (item === "ellipsis") {
          const ellipsis = this.document.createElement("span");
          ellipsis.textContent = "…";
          ellipsis.setAttribute("aria-hidden", "true");
          fragment.append(ellipsis);
          return;
        }
        fragment.append(
          this.createPageButton(String(item), item, false, `Page ${item}`, item === pageData.page)
        );
      });
      fragment.append(
        this.createPageButton("›", pageData.page + 1, pageData.page === pageData.pageCount, "Next page")
      );
    }
    this.elements.pagination.replaceChildren(fragment);
  }

  createPageButton(label, page, disabled, ariaLabel, active = false) {
    const button = this.document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = disabled;
    button.setAttribute("aria-label", ariaLabel);
    if (active) {
      button.classList.add("is-active");
      button.setAttribute("aria-current", "page");
    }
    button.addEventListener("click", () => {
      this.currentPage = page;
      this.renderTable();
      this.elements.tableBody.closest(".sensor-table-wrap")?.scrollTo({ left: 0, behavior: "smooth" });
    });
    return button;
  }

  exportFilteredData() {
    const readings = this.getFilteredReadings();
    if (!readings.length) {
      this.onToast("No filtered sensor data is available to export.", "warning");
      return;
    }

    const periodValue = this.period === "custom"
      ? `${this.customStart}-to-${this.customEnd}`
      : this.period === "day"
        ? this.selectedDate
        : this.selectedDate.slice(0, 7);
    try {
      downloadSensorDataWorkbook(
        readings,
        `sensor-data-${this.period}-${periodValue}.xlsx`,
        this.document
      );
      this.onToast(`${readings.length} filtered readings exported to .xlsx.`, "info");
    } catch (error) {
      this.window.console.error("Sensor data export failed.", error);
      this.onToast("The spreadsheet could not be created.", "error");
    }
  }

  schedulePolling() {
    this.clearPollingTimer();
    if (!this.active) {
      return;
    }
    this.pollingTimer = this.window.setTimeout(() => {
      this.pollingTimer = null;
      if (this.document.hidden) {
        this.schedulePolling();
        return;
      }
      void this.refresh({ automatic: true });
    }, this.config.pollingIntervalMs);
  }

  clearPollingTimer() {
    if (this.pollingTimer !== null) {
      this.window.clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  handleVisibilityChange() {
    if (!this.active) {
      return;
    }
    if (this.document.hidden) {
      this.clearPollingTimer();
      return;
    }
    void this.refresh({ automatic: true });
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
    this.unsubscribeSettings?.();
    this.service.destroy();
  }
}
