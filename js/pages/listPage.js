import { SENSOR_DATA_CONFIG } from "../core/config.js";
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
    description: "Select a date to view sensor data for that day."
  }),
  month: Object.freeze({
    title: "View by month",
    description: "Select a month to review all readings recorded in that month."
  }),
  year: Object.freeze({
    title: "View by year",
    description: "Select a year to review all readings recorded in that year."
  })
});

function localIsoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
    this.loading = false;
    this.error = null;
    this.active = false;
    this.filterTouched = false;
    this.lastUpdatedAt = 0;
    this.pollingTimer = null;
    this.refreshPromise = null;
    this.elements = this.collectElements();

    this.initializePickers();
    this.bindEvents();
    this.render();
  }

  collectElements() {
    const byId = (id) => this.document.getElementById(id);
    return {
      page: byId("listPage"),
      filterTitle: byId("listFilterTitle"),
      filterDescription: byId("listFilterDescription"),
      dayPicker: byId("listDayPicker"),
      monthPicker: byId("listMonthPicker"),
      yearPicker: byId("listYearPicker"),
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
      lastUpdated: byId("listLastUpdated"),
      syncSummary: this.document.querySelector(".list-sync-summary"),
      pollingStatus: byId("listPollingStatus"),
      liveStatus: byId("listLiveStatus")
    };
  }

  listen(element, eventName, callback) {
    element?.addEventListener(eventName, callback, { signal: this.abortController.signal });
  }

  initializePickers() {
    this.elements.dayPicker.value = this.selectedDate;
    this.elements.monthPicker.value = this.selectedDate.slice(0, 7);
    this.populateYearPicker([]);
  }

  populateYearPicker(readings) {
    const currentYear = new Date().getFullYear();
    const selectedYear = this.selectedDate.slice(0, 4) || String(currentYear);
    const years = new Set([selectedYear, String(currentYear)]);
    readings.forEach((reading) => years.add(reading.date.slice(0, 4)));
    const sortedYears = [...years].sort((left, right) => Number(right) - Number(left));
    const fragment = this.document.createDocumentFragment();
    sortedYears.forEach((year) => {
      const option = this.document.createElement("option");
      option.value = year;
      option.textContent = year;
      fragment.append(option);
    });
    this.elements.yearPicker.replaceChildren(fragment);
    this.elements.yearPicker.value = selectedYear;
  }

  bindEvents() {
    this.document.querySelectorAll("[data-list-period]").forEach((button) => {
      this.listen(button, "click", () => this.changePeriod(button.dataset.listPeriod));
    });
    this.document.querySelectorAll("[data-list-picker]").forEach((picker) => {
      this.listen(picker, "change", () => this.changeSelectedPeriod(picker.value));
    });
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
    this.renderPollingStatus();
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
    this.renderPollingStatus();
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
    if (typeof value !== "string" || !value) {
      return;
    }

    if (this.period === "day") {
      this.selectedDate = value;
    } else if (this.period === "month") {
      this.selectedDate = `${value}-01`;
    } else {
      this.selectedDate = `${value}-01-01`;
    }
    this.currentPage = 1;
    this.filterTouched = true;
    this.syncPickerValues();
    this.render();
  }

  syncPickerValues() {
    this.elements.dayPicker.value = this.selectedDate;
    this.elements.monthPicker.value = this.selectedDate.slice(0, 7);
    this.populateYearPicker(this.records);
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
        }
        this.populateYearPicker(this.records);
        this.syncPickerValues();
        this.lastUpdatedAt = Number.isFinite(Date.parse(result.meta.generatedAt))
          ? Date.parse(result.meta.generatedAt)
          : Date.now();
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
          : error?.message || "The sensor-data service could not be reached.";
        this.window.console.error("Sensor data refresh failed.", error);
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
    const selectedValue = this.period === "day"
      ? this.selectedDate
      : this.period === "month"
        ? this.selectedDate.slice(0, 7)
        : this.selectedDate.slice(0, 4);
    const filtered = filterSensorReadings(this.records, this.period, selectedValue);
    return sortSensorReadings(filtered, this.sortField, this.sortDirection);
  }

  render() {
    const copy = PERIOD_COPY[this.period];
    this.elements.filterTitle.textContent = copy.title;
    this.elements.filterDescription.textContent = copy.description;
    this.syncPickerValues();
    this.renderSortHeaders();
    this.renderSyncState();
    this.renderError();
    this.renderTable();
    this.renderPollingStatus();
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

  renderSyncState() {
    this.elements.syncSummary.classList.toggle("is-loading", this.loading);
    this.elements.syncSummary.classList.toggle("is-error", Boolean(this.error));
    this.elements.syncSummary.classList.toggle(
      "is-ready",
      !this.loading && !this.error && this.lastUpdatedAt > 0
    );

    if (this.loading) {
      this.elements.lastUpdated.textContent = "Synchronizing…";
    } else if (this.lastUpdatedAt > 0) {
      this.elements.lastUpdated.textContent = new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      }).format(this.lastUpdatedAt);
    } else {
      this.elements.lastUpdated.textContent = "Not yet";
    }

    this.elements.refreshButton.disabled = this.loading;
    this.elements.refreshButton.classList.toggle("is-loading", this.loading);
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
      this.elements.tableBody.replaceChildren(
        this.createStateRow("empty", `No readings found for this ${this.period}`, "Choose another period or refresh after new data is added.")
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
    if (voltage < this.config.batteryCriticalVoltage) {
      return "critical";
    }
    if (voltage < this.config.batteryWarningVoltage) {
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

    const periodValue = this.period === "day"
      ? this.selectedDate
      : this.period === "month"
        ? this.selectedDate.slice(0, 7)
        : this.selectedDate.slice(0, 4);
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

  renderPollingStatus() {
    const seconds = Math.round(this.config.pollingIntervalMs / 1000);
    this.elements.pollingStatus.textContent = this.active
      ? `Auto-refresh every ${seconds} seconds while this page is open`
      : "Auto-refresh paused while this page is closed";
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
    this.service.destroy();
  }
}
