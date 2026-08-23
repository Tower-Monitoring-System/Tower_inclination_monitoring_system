import {
  CHART_CONSTANTS,
  CHART_MODE,
  RANGE_DEFINITIONS,
  WARNING_THRESHOLDS
} from "../core/constants.js";
import { clamp } from "../logic/tiltProcessor.js";

export class TiltChart {
  constructor(documentRef = document, browserWindow = window) {
    this.document = documentRef;
    this.window = browserWindow;
    this.canvas = documentRef.getElementById("inclinationChart");
    this.fallback = documentRef.getElementById("chartFallback");
    this.tooltip = documentRef.getElementById("chartTooltip");
    this.legend = documentRef.getElementById("chartLegend");
    this.title = documentRef.getElementById("analyticsTitle");
    this.description = documentRef.getElementById("chartDescription");
    this.section = documentRef.getElementById("chartSection");
    this.context = null;
    this.metrics = null;
    this.hoverIndex = null;
    this.state = null;
    this.resizeFrame = null;
    this.resizeObserver = null;
    this.abortController = new AbortController();

    this.bindEvents();
    this.observeSize();
  }

  listen(element, eventName, listener) {
    element?.addEventListener(eventName, listener, { signal: this.abortController.signal });
  }

  bindEvents() {
    if (this.canvas) {
      this.canvas.setAttribute("tabindex", "0");
    }
    this.listen(this.canvas, "pointermove", (event) => this.handlePointerMove(event));
    this.listen(this.canvas, "pointerleave", () => this.clearHover());
    this.listen(this.canvas, "keydown", (event) => this.handleKeyboard(event));
  }

  observeSize() {
    if (!("ResizeObserver" in this.window) || !this.canvas?.parentElement) {
      return;
    }

    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeFrame !== null || this.document.hidden) {
        return;
      }

      const requestFrame = this.window.requestAnimationFrame || ((callback) => this.window.setTimeout(callback, 16));
      this.resizeFrame = requestFrame(() => {
        this.resizeFrame = null;
        this.draw();
      });
    });
    this.resizeObserver.observe(this.canvas.parentElement);
  }

  render(state) {
    const modeChanged = this.state && this.state.chartMode !== state.chartMode;
    this.state = state;

    if (modeChanged) {
      this.hoverIndex = null;
      this.hideTooltip();
    }

    this.document.querySelectorAll("[data-chart-mode]").forEach((button) => {
      const selected = button.dataset.chartMode === state.chartMode;
      button.setAttribute("aria-selected", selected ? "true" : "false");
      button.setAttribute("tabindex", selected ? "0" : "-1");
    });

    this.document.querySelectorAll("[data-range]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.range === state.range);
    });

    const activeTab = this.document.querySelector(`[data-chart-mode="${state.chartMode}"]`);
    if (activeTab?.id && this.section) {
      this.section.setAttribute("aria-labelledby", activeTab.id);
    }
    if (this.title) {
      this.title.textContent = state.chartMode === CHART_MODE.TREND
        ? "Inclination trend"
        : "Tilt angle distribution";
    }
    if (this.description) {
      this.description.textContent = state.chartMode === CHART_MODE.TREND
        ? "Maximum tilt angle by tower"
        : "Tower count grouped by inclination range";
    }
    if (this.canvas) {
      this.canvas.setAttribute(
        "aria-label",
        state.chartMode === CHART_MODE.TREND
          ? "Line chart showing tower inclination over time"
          : "Bar chart showing the distribution of tower tilt angles"
      );
    }

    const rangeLabel = this.document.getElementById("dateRangeLabel");
    if (rangeLabel) {
      rangeLabel.textContent = RANGE_DEFINITIONS[state.range]?.label || RANGE_DEFINITIONS.realtime.label;
    }

    this.renderLegend();
    this.draw();
  }

  renderLegend() {
    if (!this.legend || !this.state) {
      return;
    }

    const items = this.state.chartMode === CHART_MODE.DISTRIBUTION
      ? this.state.distributionData.map((category) => ({
          color: category.color,
          label: `${category.label}: ${category.count}`
        }))
      : this.state.trendData.datasets.map((dataset) => ({
          color: dataset.color,
          label: dataset.id
        }));
    const fragment = this.document.createDocumentFragment();

    items.forEach((item) => {
      const legendItem = this.document.createElement("span");
      const swatch = this.document.createElement("i");
      legendItem.className = "legend-item";
      swatch.style.background = item.color;
      legendItem.append(swatch, this.document.createTextNode(item.label));
      fragment.append(legendItem);
    });

    this.legend.replaceChildren(fragment);
  }

  draw() {
    if (!this.canvas || !this.state) {
      return;
    }

    try {
      const rect = this.canvas.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const pixelRatio = Math.min(CHART_CONSTANTS.maximumPixelRatio, this.window.devicePixelRatio || 1);
      this.canvas.width = Math.max(1, Math.floor(width * pixelRatio));
      this.canvas.height = Math.max(1, Math.floor(height * pixelRatio));
      this.context = this.canvas.getContext("2d");

      if (!this.context) {
        this.showFallback("Chart rendering is unavailable in this browser. Monitoring data remains available below.");
        return;
      }

      this.hideFallback();
      this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      this.context.clearRect(0, 0, width, height);

      if (this.state.chartMode === CHART_MODE.DISTRIBUTION) {
        this.drawDistribution(width, height);
      } else {
        this.drawTrend(width, height);
      }
    } catch (error) {
      this.context = null;
      this.metrics = null;
      this.window.console.error("Dashboard chart rendering failed.", error);
      this.showFallback("The chart could not be rendered. Monitoring data remains available in the summary and ranking table.");
    }
  }

  showFallback(message) {
    if (this.canvas) {
      this.canvas.style.visibility = "hidden";
    }
    if (this.fallback) {
      this.fallback.textContent = message;
      this.fallback.hidden = false;
    }
  }

  hideFallback() {
    this.canvas?.style.removeProperty("visibility");
    if (this.fallback) {
      this.fallback.hidden = true;
    }
  }

  drawTrend(width, height) {
    const { labels = [], datasets = [] } = this.state.trendData || {};
    if (!labels.length) {
      this.showFallback("Trend data is not available yet. Monitoring summaries remain available.");
      return;
    }

    const context = this.context;
    const padding = { left: 45, right: 16, top: 18, bottom: 31 };
    const chartWidth = Math.max(1, width - padding.left - padding.right);
    const chartHeight = Math.max(1, height - padding.top - padding.bottom);
    const maximumY = CHART_CONSTANTS.maximumTilt;
    const yToPixel = (value) => padding.top + ((maximumY - value) / maximumY) * chartHeight;
    const xToPixel = (index) => padding.left + (index / Math.max(1, labels.length - 1)) * chartWidth;
    this.metrics = { padding, chartWidth, chartHeight, xToPixel, yToPixel, pointCount: labels.length };
    context.font = '10px Inter, "Segoe UI", sans-serif';
    context.textBaseline = "middle";

    [0, 0.35, 0.7, 1.05, 1.4].forEach((value) => {
      const y = yToPixel(value);
      context.beginPath();
      context.strokeStyle = "#e9eef4";
      context.lineWidth = 1;
      context.moveTo(padding.left, y);
      context.lineTo(width - padding.right, y);
      context.stroke();
      context.fillStyle = "#8390a0";
      context.textAlign = "right";
      context.fillText(`${value.toFixed(2)}°`, padding.left - 8, y);
    });

    const labelInterval = Math.max(1, Math.ceil(labels.length / 6));
    labels.forEach((label, index) => {
      if (index % labelInterval !== 0 && index !== labels.length - 1) {
        return;
      }
      context.fillStyle = "#8390a0";
      context.textAlign = index === labels.length - 1 ? "right" : index === 0 ? "left" : "center";
      context.fillText(label, xToPixel(index), height - 10);
    });

    const thresholdY = yToPixel(WARNING_THRESHOLDS.alert);
    context.save();
    context.strokeStyle = "#ed3548";
    context.lineWidth = 1.25;
    context.setLineDash([5, 5]);
    context.beginPath();
    context.moveTo(padding.left, thresholdY);
    context.lineTo(width - padding.right, thresholdY);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = "#d52d3f";
    context.textAlign = "right";
    context.fillText("Alert 1.00°", width - padding.right, thresholdY - 9);
    context.restore();

    if (this.hoverIndex !== null) {
      const hoverX = xToPixel(this.hoverIndex);
      context.beginPath();
      context.strokeStyle = "rgba(74, 93, 116, 0.28)";
      context.lineWidth = 1;
      context.moveTo(hoverX, padding.top);
      context.lineTo(hoverX, height - padding.bottom);
      context.stroke();
    }

    datasets.forEach((dataset) => {
      context.save();
      context.beginPath();
      context.strokeStyle = dataset.color;
      context.lineWidth = 1.85;
      context.lineCap = "round";
      context.lineJoin = "round";
      dataset.values.forEach((value, index) => {
        const x = xToPixel(index);
        const y = yToPixel(value);
        if (index === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      });
      context.stroke();

      if (this.hoverIndex !== null && dataset.values[this.hoverIndex] !== undefined) {
        const value = dataset.values[this.hoverIndex];
        context.beginPath();
        context.fillStyle = "#fff";
        context.strokeStyle = dataset.color;
        context.lineWidth = 2;
        context.arc(xToPixel(this.hoverIndex), yToPixel(value), 3.2, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }
      context.restore();
    });
  }

  drawDistribution(width, height) {
    const context = this.context;
    const categories = this.state.distributionData || [];
    if (!categories.length) {
      this.showFallback("Distribution data is not available yet. Monitoring summaries remain available.");
      return;
    }

    const padding = { left: 43, right: 18, top: 20, bottom: 42 };
    const chartWidth = Math.max(1, width - padding.left - padding.right);
    const chartHeight = Math.max(1, height - padding.top - padding.bottom);
    const maximumCount = Math.max(...categories.map((category) => category.count), 1);
    this.metrics = null;
    context.font = '10px Inter, "Segoe UI", sans-serif';
    context.textBaseline = "middle";

    for (let value = 0; value <= maximumCount; value += 1) {
      const y = padding.top + ((maximumCount - value) / maximumCount) * chartHeight;
      context.beginPath();
      context.strokeStyle = "#e9eef4";
      context.moveTo(padding.left, y);
      context.lineTo(width - padding.right, y);
      context.stroke();
      context.fillStyle = "#8390a0";
      context.textAlign = "right";
      context.fillText(String(value), padding.left - 8, y);
    }

    const groupWidth = chartWidth / categories.length;
    const barWidth = Math.min(72, groupWidth * 0.52);
    categories.forEach((category, index) => {
      const barHeight = (category.count / maximumCount) * chartHeight;
      const x = padding.left + index * groupWidth + (groupWidth - barWidth) / 2;
      const y = padding.top + chartHeight - barHeight;
      context.fillStyle = category.color;
      this.roundRect(context, x, y, barWidth, barHeight, 7);
      context.fill();
      context.fillStyle = "#344458";
      context.font = '700 11px Inter, "Segoe UI", sans-serif';
      context.textAlign = "center";
      context.fillText(String(category.count), x + barWidth / 2, Math.max(padding.top + 9, y - 10));
      context.fillStyle = "#718094";
      context.font = '10px Inter, "Segoe UI", sans-serif';
      context.fillText(category.shortLabel, x + barWidth / 2, height - 17);
    });
  }

  handlePointerMove(event) {
    if (this.state?.chartMode !== CHART_MODE.TREND || !this.metrics || !this.canvas) {
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const relativeX = pointerX - this.metrics.padding.left;
    if (relativeX < 0 || relativeX > this.metrics.chartWidth) {
      this.clearHover();
      return;
    }

    const index = clamp(
      Math.round((relativeX / this.metrics.chartWidth) * (this.metrics.pointCount - 1)),
      0,
      this.metrics.pointCount - 1
    );
    this.hoverIndex = index;
    this.draw();
    this.showTooltip(index, pointerX, event.clientY - rect.top);
  }

  handleKeyboard(event) {
    if (
      this.state?.chartMode !== CHART_MODE.TREND ||
      !this.metrics ||
      !["ArrowLeft", "ArrowRight"].includes(event.key)
    ) {
      return;
    }

    event.preventDefault();
    const lastIndex = this.state.trendData.labels.length - 1;
    const currentIndex = this.hoverIndex === null ? lastIndex : this.hoverIndex;
    this.hoverIndex = clamp(currentIndex + (event.key === "ArrowRight" ? 1 : -1), 0, lastIndex);
    this.draw();
    this.showTooltip(this.hoverIndex, this.metrics.xToPixel(this.hoverIndex), 35);
  }

  showTooltip(index, pointerX, pointerY) {
    if (!this.tooltip || !this.state?.trendData) {
      return;
    }

    const heading = this.document.createElement("strong");
    heading.textContent = this.state.trendData.labels[index];
    const fragment = this.document.createDocumentFragment();
    fragment.append(heading);

    this.state.trendData.datasets.forEach((dataset) => {
      const row = this.document.createElement("span");
      const label = this.document.createElement("em");
      const swatch = this.document.createElement("i");
      const value = this.document.createElement("b");
      swatch.style.background = dataset.color;
      label.append(swatch, this.document.createTextNode(dataset.id));
      value.textContent = `${dataset.values[index].toFixed(2)}°`;
      row.append(label, value);
      fragment.append(row);
    });

    this.tooltip.replaceChildren(fragment);
    this.tooltip.classList.add("is-visible");
    const container = this.canvas?.parentElement;
    if (!container) {
      return;
    }
    const left = pointerX + CHART_CONSTANTS.tooltipWidth + 18 > container.clientWidth
      ? pointerX - CHART_CONSTANTS.tooltipWidth - 12
      : pointerX + 12;
    const top = clamp(pointerY - 36, 8, Math.max(8, container.clientHeight - 206));
    this.tooltip.style.left = `${Math.max(6, left)}px`;
    this.tooltip.style.top = `${top}px`;
  }

  hideTooltip() {
    this.tooltip?.classList.remove("is-visible");
  }

  clearHover() {
    if (this.hoverIndex !== null) {
      this.hoverIndex = null;
      this.draw();
    }
    this.hideTooltip();
  }

  roundRect(context, x, y, width, height, radius) {
    const safeRadius = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
    context.beginPath();
    context.moveTo(x + safeRadius, y);
    context.arcTo(x + width, y, x + width, y + height, safeRadius);
    context.arcTo(x + width, y + height, x, y + height, safeRadius);
    context.arcTo(x, y + height, x, y, safeRadius);
    context.arcTo(x, y, x + width, y, safeRadius);
    context.closePath();
  }

  destroy() {
    this.abortController.abort();
    this.resizeObserver?.disconnect();
    if (this.resizeFrame !== null && this.window.cancelAnimationFrame) {
      this.window.cancelAnimationFrame(this.resizeFrame);
    }
  }
}

