import { ALERT_CONFIG } from "../core/config.js";
import { ALERT_SEVERITY, ALERT_STATUS, ALERT_TYPE } from "../core/constants.js";
import {
  filterAndSortAlerts,
  paginateAlerts,
  summarizeAlerts
} from "../logic/alertProcessor.js";

const EVENT_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

const SYNC_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

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

function formatDateTime(timestamp, formatter = EVENT_DATE_TIME_FORMATTER) {
  const date = new Date(Number(timestamp));
  return Number.isNaN(date.getTime()) ? "Unavailable" : formatter.format(date);
}

function typeLabel(type) {
  return type === ALERT_TYPE.BATTERY ? "Battery" : "Inclination";
}

export class AlertsPage {
  constructor(alertService, options = {}) {
    this.service = alertService;
    this.config = options.config || ALERT_CONFIG;
    this.document = options.documentRef || document;
    this.window = options.windowRef || window;
    this.onToast = typeof options.onToast === "function" ? options.onToast : () => {};
    this.onSummaryChange = typeof options.onSummaryChange === "function"
      ? options.onSummaryChange
      : () => {};
    this.monitorWhenInactive = options.monitorWhenInactive === true;
    this.abortController = new AbortController();
    this.alerts = [];
    this.summary = summarizeAlerts([]);
    this.type = "all";
    this.severity = "all";
    this.sort = "newest";
    this.currentPage = 1;
    this.expandedAlertId = null;
    this.loading = false;
    this.error = null;
    this.active = false;
    this.lastUpdatedAt = 0;
    this.pollingTimer = null;
    this.refreshPromise = null;
    this.elements = this.collectElements();

    this.bindEvents();
    this.render();
  }

  collectElements() {
    const byId = (id) => this.document.getElementById(id);
    return {
      page: byId("alertsPage"),
      syncSummary: byId("alertsSyncSummary"),
      lastUpdated: byId("alertsLastUpdated"),
      totalCount: byId("alertsTotalCount"),
      criticalCount: byId("alertsCriticalCount"),
      batteryCount: byId("alertsBatteryCount"),
      inclinationCount: byId("alertsInclinationCount"),
      typeFilter: byId("alertTypeFilter"),
      sortOrder: byId("alertSortOrder"),
      refreshButton: byId("alertsRefreshButton"),
      errorBanner: byId("alertsErrorBanner"),
      errorMessage: byId("alertsErrorMessage"),
      errorRetry: byId("alertsErrorRetry"),
      tableBody: byId("alertsTableBody"),
      recordSummary: byId("alertsRecordSummary"),
      pagination: byId("alertsPagination"),
      pollingStatus: byId("alertsPollingStatus"),
      liveStatus: byId("alertsLiveStatus")
    };
  }

  listen(element, eventName, callback) {
    element?.addEventListener(eventName, callback, { signal: this.abortController.signal });
  }

  bindEvents() {
    this.listen(this.elements.typeFilter, "change", (event) => {
      this.type = event.target.value;
      this.resetFilteredView();
    });
    this.listen(this.elements.sortOrder, "change", (event) => {
      this.sort = event.target.value;
      this.resetFilteredView();
    });
    this.document.querySelectorAll("[data-alert-severity]").forEach((button) => {
      this.listen(button, "click", () => {
        this.severity = button.dataset.alertSeverity;
        this.resetFilteredView();
      });
    });
    this.listen(this.elements.refreshButton, "click", () => this.refresh({ automatic: false }));
    this.listen(this.elements.errorRetry, "click", () => this.refresh({ automatic: false }));
    this.listen(this.document, "visibilitychange", () => this.handleVisibilityChange());
  }

  resetFilteredView() {
    this.currentPage = 1;
    this.expandedAlertId = null;
    this.render();
  }

  open() {
    if (this.active) {
      return;
    }
    this.active = true;
    if (this.refreshPromise) {
      return;
    }
    void this.refresh({ automatic: this.alerts.length > 0 });
  }

  close() {
    this.active = false;
    if (this.monitorWhenInactive) {
      this.schedulePolling();
    } else {
      this.clearPollingTimer();
      this.service.cancelActiveRequest();
    }
    this.renderPollingStatus();
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
        const result = await this.service.fetchAlerts();
        this.alerts = [...result.alerts];
        this.summary = result.summary || summarizeAlerts(this.alerts);
        this.onSummaryChange(this.summary);
        this.lastUpdatedAt = Date.parse(result.meta?.generatedAt) || Date.now();
        this.error = null;

        if (result.invalidRows?.length) {
          this.window.console.warn(
            `${result.invalidRows.length} sensor row(s) failed validation and were ignored by alert detection.`
          );
        }
        if (!automatic) {
          this.onToast("Alerts refreshed successfully.", "info");
        }
        this.announce(`${this.alerts.length} alert events loaded.`);
      } catch (error) {
        if (error?.name === "AbortError") {
          return;
        }
        const timedOut = error?.name === "TimeoutError";
        this.error = timedOut
          ? "The request timed out. The last valid alerts were retained."
          : error?.message || "The alert service could not be reached.";
        this.window.console.error("Alert refresh failed.", error);
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

  getFilteredAlerts() {
    return filterAndSortAlerts(this.alerts, {
      type: this.type,
      severity: this.severity,
      sort: this.sort
    });
  }

  render() {
    this.elements.typeFilter.value = this.type;
    this.elements.sortOrder.value = this.sort;
    this.document.querySelectorAll("[data-alert-severity]").forEach((button) => {
      const active = button.dataset.alertSeverity === this.severity;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    this.elements.refreshButton.disabled = this.loading;
    this.elements.refreshButton.classList.toggle("is-loading", this.loading);
    this.renderSummary();
    this.renderSyncState();
    this.renderError();
    this.renderTable();
    this.renderPollingStatus();
  }

  renderSummary() {
    this.elements.totalCount.textContent = String(this.summary.total);
    this.elements.criticalCount.textContent = String(this.summary.critical);
    this.elements.batteryCount.textContent = String(this.summary.battery);
    this.elements.inclinationCount.textContent = String(this.summary.inclination);
  }

  renderSyncState() {
    if (!this.elements.syncSummary || !this.elements.lastUpdated) {
      return;
    }
    this.elements.syncSummary.classList.toggle("is-loading", this.loading);
    this.elements.syncSummary.classList.toggle("is-error", Boolean(this.error));
    this.elements.syncSummary.classList.toggle(
      "is-ready",
      !this.loading && !this.error && this.lastUpdatedAt > 0
    );
    if (this.loading && !this.lastUpdatedAt) {
      this.elements.lastUpdated.textContent = "Synchronizing…";
    } else if (this.lastUpdatedAt) {
      this.elements.lastUpdated.textContent = formatDateTime(this.lastUpdatedAt, SYNC_DATE_TIME_FORMATTER);
    } else {
      this.elements.lastUpdated.textContent = "Not yet";
    }
  }

  renderError() {
    this.elements.errorBanner.hidden = !this.error;
    if (this.error) {
      this.elements.errorMessage.textContent = this.error;
    }
  }

  createStateRow(type, title, description) {
    const row = this.document.createElement("tr");
    row.className = "alerts-state-row";
    const cell = this.document.createElement("td");
    cell.colSpan = 8;

    if (type === "loading") {
      const spinner = this.document.createElement("span");
      spinner.className = "alerts-state-spinner";
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
    const filtered = this.getFilteredAlerts();
    const pageData = paginateAlerts(filtered, this.currentPage, this.config.pageSize);
    this.currentPage = pageData.page;

    if (this.loading && this.alerts.length === 0) {
      this.elements.tableBody.replaceChildren(
        this.createStateRow("loading", "Loading alerts…", "Checking validated sensor readings for battery and inclination events.")
      );
      this.renderPagination(filtered.length, pageData);
      return;
    }
    if (this.error && this.alerts.length === 0) {
      this.elements.tableBody.replaceChildren(
        this.createStateRow("error", "Alerts could not be loaded", "Use Try again when the sensor-data connection is available")
      );
      this.renderPagination(filtered.length, pageData);
      return;
    }
    if (this.alerts.length === 0) {
      this.elements.tableBody.replaceChildren(
        this.createStateRow("empty", "No alerts detected", "All validated battery and inclination readings are within configured thresholds")
      );
      this.renderPagination(filtered.length, pageData);
      return;
    }
    if (filtered.length === 0) {
      this.elements.tableBody.replaceChildren(
        this.createStateRow("empty", "No alerts match these filters", "Choose another type or severity to review alert history.")
      );
      this.renderPagination(filtered.length, pageData);
      return;
    }

    const fragment = this.document.createDocumentFragment();
    pageData.rows.forEach((alert) => {
      fragment.append(this.createAlertRow(alert));
      if (this.expandedAlertId === alert.id) {
        fragment.append(this.createDetailRow(alert));
      }
    });
    this.elements.tableBody.replaceChildren(fragment);
    this.renderPagination(filtered.length, pageData);
  }

  createAlertRow(alert) {
    const row = this.document.createElement("tr");
    row.dataset.alertId = alert.id;
    row.append(
      this.createTextCell(alert.id, "alert-id-cell"),
      this.createTextCell(alert.towerId, "alert-tower-cell"),
      this.createTypeCell(alert),
      this.createTextCell(alert.message, "alert-message-cell"),
      this.createTextCell(formatDateTime(alert.updatedAt || alert.timestamp), "alert-time-cell"),
      this.createBadgeCell(alert.severity, "alert-severity-badge"),
      this.createBadgeCell(alert.status, "alert-status-badge"),
      this.createActionCell(alert)
    );
    return row;
  }

  createTextCell(value, className) {
    const cell = this.document.createElement("td");
    cell.className = className;
    cell.textContent = String(value);
    if (className === "alert-message-cell") {
      cell.title = String(value);
    }
    return cell;
  }

  createTypeCell(alert) {
    const cell = this.document.createElement("td");
    const badge = this.document.createElement("span");
    badge.className = `alert-type-badge ${alert.type}`;
    const svg = this.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("aria-hidden", "true");
    const use = this.document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", alert.type === ALERT_TYPE.BATTERY ? "#icon-battery" : "#icon-chart");
    svg.append(use);
    const label = this.document.createElement("span");
    label.textContent = typeLabel(alert.type);
    badge.append(svg, label);
    cell.append(badge);
    return cell;
  }

  createBadgeCell(value, baseClass) {
    const cell = this.document.createElement("td");
    const badge = this.document.createElement("span");
    badge.className = `${baseClass} ${value}`;
    badge.textContent = value === ALERT_STATUS.ACTIVE ? "Active" : value.charAt(0).toUpperCase() + value.slice(1);
    cell.append(badge);
    return cell;
  }

  createActionCell(alert) {
    const cell = this.document.createElement("td");
    const button = this.document.createElement("button");
    const expanded = this.expandedAlertId === alert.id;
    button.type = "button";
    button.className = "alert-view-button";
    button.textContent = expanded ? "Close" : "View";
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
    button.setAttribute("aria-label", `${expanded ? "Close" : "View"} details for ${alert.id}`);
    button.addEventListener("click", () => {
      this.expandedAlertId = expanded ? null : alert.id;
      this.renderTable();
    });
    cell.append(button);
    return cell;
  }

  createDetailRow(alert) {
    const row = this.document.createElement("tr");
    row.className = "alerts-detail-row";
    const cell = this.document.createElement("td");
    cell.colSpan = 8;
    const list = this.document.createElement("dl");
    list.className = "alert-detail-grid";
    const unit = alert.type === ALERT_TYPE.BATTERY ? "V" : "°";
    const details = [
      ["Latest measurement", `${Number(alert.measurement).toFixed(2)} ${unit}`],
      ["Applied threshold", `${Number(alert.threshold).toFixed(2)} ${unit}`],
      ["Triggered", formatDateTime(alert.timestamp)],
      [alert.resolvedAt ? "Resolved" : "Last reading", formatDateTime(alert.resolvedAt || alert.updatedAt)],
      ["Peak severity", alert.peakSeverity || alert.severity],
      ["Event status", alert.status]
    ];
    details.forEach(([term, description]) => {
      const wrapper = this.document.createElement("div");
      const dt = this.document.createElement("dt");
      const dd = this.document.createElement("dd");
      dt.textContent = term;
      dd.textContent = description.charAt(0).toUpperCase() + description.slice(1);
      wrapper.append(dt, dd);
      list.append(wrapper);
    });
    cell.append(list);
    row.append(cell);
    return row;
  }

  renderPagination(totalEntries, pageData) {
    this.elements.recordSummary.textContent = totalEntries === 0
      ? "Showing 0 alerts"
      : `Showing ${pageData.startIndex + 1} to ${pageData.endIndex} of ${totalEntries} alerts`;

    const fragment = this.document.createDocumentFragment();
    if (pageData.pageCount > 1) {
      fragment.append(this.createPageButton("‹", pageData.page - 1, pageData.page === 1, "Previous page"));
      paginationItems(pageData.pageCount, pageData.page).forEach((item) => {
        if (item === "ellipsis") {
          const ellipsis = this.document.createElement("span");
          ellipsis.textContent = "…";
          ellipsis.setAttribute("aria-hidden", "true");
          fragment.append(ellipsis);
        } else {
          fragment.append(
            this.createPageButton(String(item), item, false, `Page ${item}`, item === pageData.page)
          );
        }
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
      this.expandedAlertId = null;
      this.renderTable();
      this.elements.tableBody.closest(".alerts-table-wrap")?.scrollTo({ left: 0, behavior: "smooth" });
    });
    return button;
  }

  schedulePolling() {
    this.clearPollingTimer();
    if (!this.active && !this.monitorWhenInactive) {
      this.renderPollingStatus();
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
    this.renderPollingStatus();
  }

  clearPollingTimer() {
    if (this.pollingTimer !== null) {
      this.window.clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  renderPollingStatus() {
    if (!this.elements.pollingStatus) {
      return;
    }
    if (this.loading) {
      this.elements.pollingStatus.textContent = "Checking for new sensor events…";
    } else if (!this.active && !this.monitorWhenInactive) {
      this.elements.pollingStatus.textContent = "Updates resume when this page is open";
    } else if (!this.active) {
      this.elements.pollingStatus.textContent = "Background alert monitoring is active";
    } else if (this.document.hidden) {
      this.elements.pollingStatus.textContent = "Updates paused while this tab is hidden";
    } else {
      const seconds = Math.round(this.config.pollingIntervalMs / 1000);
      this.elements.pollingStatus.textContent = `Automatically checks every ${seconds} seconds`;
    }
  }

  handleVisibilityChange() {
    if (!this.active && !this.monitorWhenInactive) {
      return;
    }
    if (this.document.hidden) {
      this.clearPollingTimer();
      this.renderPollingStatus();
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
    this.monitorWhenInactive = false;
    this.close();
    this.abortController.abort();
    this.service.destroy();
  }
}
