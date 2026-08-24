import { CHART_CONSTANTS } from "../core/constants.js";
import { clamp } from "../logic/tiltProcessor.js";

const AXES = Object.freeze([
  Object.freeze({ key: "x", label: "X Tilt", color: "#176ff2" }),
  Object.freeze({ key: "y", label: "Y Tilt", color: "#14833b" })
]);

const TOOLTIP_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

function roundedRange(readings) {
  const values = readings.flatMap((reading) => [reading.x, reading.y, 0]);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = Math.max(0.5, maximum - minimum);
  const padding = Math.max(0.2, span * 0.12);
  const step = span > 40 ? 20 : span > 15 ? 10 : span > 5 ? 2 : span > 1.5 ? 0.5 : 0.2;
  const rangeMinimum = Math.floor((minimum - padding) / step) * step;
  const rangeMaximum = Math.ceil((maximum + padding) / step) * step;
  return rangeMinimum === rangeMaximum
    ? { minimum: rangeMinimum - step, maximum: rangeMaximum + step }
    : { minimum: rangeMinimum, maximum: rangeMaximum };
}

function readingsSignature(readings) {
  let hash = 2166136261;
  readings.forEach((reading) => {
    const value = `${reading.timestamp}|${reading.x}|${reading.y};`;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  });
  return `${readings.length}:${hash >>> 0}`;
}

export class TowerTrendChart {
  constructor(documentRef = document, browserWindow = window) {
    this.document = documentRef;
    this.window = browserWindow;
    this.canvas = documentRef.getElementById("towerTrendCanvas");
    this.tooltip = documentRef.getElementById("towerTrendTooltip");
    this.fallback = documentRef.getElementById("towerTrendFallback");
    this.context = null;
    this.readings = [];
    this.metrics = null;
    this.hoverIndex = null;
    this.renderSignature = "";
    this.drawFrame = null;
    this.resizeObserver = null;
    this.abortController = new AbortController();

    this.bindEvents();
    this.observeSize();
  }

  listen(element, eventName, listener) {
    element?.addEventListener(eventName, listener, { signal: this.abortController.signal });
  }

  bindEvents() {
    this.canvas?.setAttribute("tabindex", "0");
    this.listen(this.canvas, "pointermove", (event) => this.handlePointerMove(event));
    this.listen(this.canvas, "pointerleave", () => this.clearHover());
    this.listen(this.canvas, "keydown", (event) => this.handleKeyboard(event));
  }

  observeSize() {
    if (!this.window.ResizeObserver || !this.canvas?.parentElement) {
      return;
    }
    this.resizeObserver = new this.window.ResizeObserver(() => {
      this.requestDraw();
    });
    this.resizeObserver.observe(this.canvas.parentElement);
  }

  render(readings) {
    const nextReadings = Array.isArray(readings) ? readings : [];
    const nextSignature = readingsSignature(nextReadings);
    if (nextSignature === this.renderSignature) {
      return;
    }
    this.readings = nextReadings;
    this.renderSignature = nextSignature;
    this.hoverIndex = null;
    this.hideTooltip();
    this.requestDraw();
  }

  requestDraw() {
    if (this.drawFrame !== null || this.document.hidden) {
      return;
    }
    this.drawFrame = this.window.requestAnimationFrame(() => {
      this.drawFrame = null;
      this.draw();
    });
  }

  draw() {
    if (!this.canvas) {
      return;
    }
    if (!this.readings.length) {
      this.showFallback("No X/Y readings match the selected date range.");
      return;
    }

    try {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) {
        return;
      }
      const ratio = Math.min(CHART_CONSTANTS.maximumPixelRatio, this.window.devicePixelRatio || 1);
      const canvasWidth = Math.floor(rect.width * ratio);
      const canvasHeight = Math.floor(rect.height * ratio);
      if (this.canvas.width !== canvasWidth || this.canvas.height !== canvasHeight) {
        this.canvas.width = canvasWidth;
        this.canvas.height = canvasHeight;
      }
      this.context = this.canvas.getContext("2d");
      if (!this.context) {
        this.showFallback("Trend rendering is unavailable in this browser.");
        return;
      }

      this.hideFallback();
      this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
      this.context.clearRect(0, 0, rect.width, rect.height);
      this.drawChart(rect.width, rect.height);
    } catch (error) {
      this.window.console.error("Tower trend chart failed to render.", error);
      this.showFallback("The X/Y trend could not be rendered. Current tower values remain available.");
    }
  }

  drawChart(width, height) {
    const context = this.context;
    const padding = { left: 52, right: 18, top: 24, bottom: 42 };
    const chartWidth = Math.max(1, width - padding.left - padding.right);
    const chartHeight = Math.max(1, height - padding.top - padding.bottom);
    const range = roundedRange(this.readings);
    const ySpan = range.maximum - range.minimum;
    const xAt = (index) => padding.left + (index / Math.max(1, this.readings.length - 1)) * chartWidth;
    const yAt = (value) => padding.top + ((range.maximum - value) / ySpan) * chartHeight;
    this.metrics = { padding, chartWidth, chartHeight, xAt, yAt };

    context.font = '10px Inter, "Segoe UI", sans-serif';
    context.textBaseline = "middle";
    for (let index = 0; index <= 5; index += 1) {
      const value = range.maximum - (ySpan * index) / 5;
      const y = padding.top + (chartHeight * index) / 5;
      context.beginPath();
      context.strokeStyle = "#e7edf4";
      context.lineWidth = 1;
      context.setLineDash(index === 5 ? [] : [4, 4]);
      context.moveTo(padding.left, y);
      context.lineTo(width - padding.right, y);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = "#728198";
      context.textAlign = "right";
      context.fillText(`${value.toFixed(Math.abs(value) < 10 ? 1 : 0)}°`, padding.left - 9, y);
    }

    const labelCount = Math.min(6, this.readings.length);
    for (let index = 0; index < labelCount; index += 1) {
      const readingIndex = Math.round((index / Math.max(1, labelCount - 1)) * (this.readings.length - 1));
      const reading = this.readings[readingIndex];
      const x = xAt(readingIndex);
      const date = new Date(reading.timestamp);
      const label = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
      context.fillStyle = "#728198";
      context.textAlign = index === 0 ? "left" : index === labelCount - 1 ? "right" : "center";
      context.fillText(label, x, height - 16);
    }

    const zeroY = yAt(0);
    if (zeroY >= padding.top && zeroY <= height - padding.bottom) {
      context.beginPath();
      context.strokeStyle = "rgba(69, 86, 107, 0.35)";
      context.moveTo(padding.left, zeroY);
      context.lineTo(width - padding.right, zeroY);
      context.stroke();
    }

    if (this.hoverIndex !== null) {
      const hoverX = xAt(this.hoverIndex);
      context.beginPath();
      context.strokeStyle = "rgba(74, 93, 116, 0.3)";
      context.setLineDash([4, 4]);
      context.moveTo(hoverX, padding.top);
      context.lineTo(hoverX, height - padding.bottom);
      context.stroke();
      context.setLineDash([]);
    }

    AXES.forEach((axis) => {
      context.save();
      context.beginPath();
      context.strokeStyle = axis.color;
      context.lineWidth = 2;
      context.lineCap = "round";
      context.lineJoin = "round";
      this.readings.forEach((reading, index) => {
        const x = xAt(index);
        const y = yAt(reading[axis.key]);
        if (index === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      });
      context.stroke();

      if (this.readings.length === 1 || this.hoverIndex !== null) {
        const index = this.hoverIndex ?? 0;
        context.beginPath();
        context.fillStyle = "#fff";
        context.strokeStyle = axis.color;
        context.lineWidth = 2;
        context.arc(xAt(index), yAt(this.readings[index][axis.key]), 3.5, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }
      context.restore();
    });
  }

  handlePointerMove(event) {
    if (!this.metrics || !this.readings.length) {
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
      Math.round((relativeX / this.metrics.chartWidth) * Math.max(0, this.readings.length - 1)),
      0,
      this.readings.length - 1
    );
    this.hoverIndex = index;
    this.draw();
    this.showTooltip(index, pointerX, event.clientY - rect.top);
  }

  handleKeyboard(event) {
    if (!this.readings.length || !["ArrowLeft", "ArrowRight"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const current = this.hoverIndex ?? this.readings.length - 1;
    this.hoverIndex = clamp(current + (event.key === "ArrowRight" ? 1 : -1), 0, this.readings.length - 1);
    this.draw();
    this.showTooltip(this.hoverIndex, this.metrics.xAt(this.hoverIndex), 45);
  }

  showTooltip(index, pointerX, pointerY) {
    if (!this.tooltip) {
      return;
    }
    const reading = this.readings[index];
    const heading = this.document.createElement("strong");
    heading.textContent = TOOLTIP_TIME.format(new Date(reading.timestamp));
    const fragment = this.document.createDocumentFragment();
    fragment.append(heading);
    AXES.forEach((axis) => {
      const row = this.document.createElement("span");
      const label = this.document.createElement("em");
      const swatch = this.document.createElement("i");
      const value = this.document.createElement("b");
      swatch.style.background = axis.color;
      label.append(swatch, this.document.createTextNode(axis.label));
      value.textContent = `${reading[axis.key].toFixed(2)}°`;
      row.append(label, value);
      fragment.append(row);
    });
    this.tooltip.replaceChildren(fragment);
    this.tooltip.classList.add("is-visible");
    const container = this.canvas.parentElement;
    const left = pointerX + 185 > container.clientWidth ? pointerX - 175 : pointerX + 12;
    const top = clamp(pointerY - 38, 8, Math.max(8, container.clientHeight - 118));
    this.tooltip.style.left = `${Math.max(6, left)}px`;
    this.tooltip.style.top = `${top}px`;
  }

  clearHover() {
    if (this.hoverIndex !== null) {
      this.hoverIndex = null;
      this.draw();
    }
    this.hideTooltip();
  }

  hideTooltip() {
    this.tooltip?.classList.remove("is-visible");
  }

  showFallback(message) {
    this.canvas.style.visibility = "hidden";
    if (this.fallback) {
      this.fallback.textContent = message;
      this.fallback.hidden = false;
    }
  }

  hideFallback() {
    this.canvas.style.removeProperty("visibility");
    if (this.fallback) {
      this.fallback.hidden = true;
    }
  }

  destroy() {
    this.abortController.abort();
    this.resizeObserver?.disconnect();
    if (this.drawFrame !== null) {
      this.window.cancelAnimationFrame(this.drawFrame);
    }
  }
}
