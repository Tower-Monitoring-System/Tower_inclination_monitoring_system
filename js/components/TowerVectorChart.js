import { CHART_CONSTANTS, WARNING_THRESHOLDS } from "../core/constants.js";

const COLORS = Object.freeze({
  x: "#176ff2",
  y: "#14833b",
  z: "#7b24d6",
  ideal: "#9aa6b4",
  grid: "#e8edf4"
});

export class TowerVectorChart {
  constructor(documentRef = document, browserWindow = window) {
    this.document = documentRef;
    this.window = browserWindow;
    this.canvas = documentRef.getElementById("towerVectorCanvas");
    this.fallback = documentRef.getElementById("towerVectorFallback");
    this.viewModel = null;
    this.resizeFrame = null;
    this.resizeObserver = null;
    this.observeSize();
  }

  observeSize() {
    if (!this.window.ResizeObserver || !this.canvas?.parentElement) {
      return;
    }
    this.resizeObserver = new this.window.ResizeObserver(() => {
      if (this.resizeFrame !== null || this.document.hidden) {
        return;
      }
      this.resizeFrame = this.window.requestAnimationFrame(() => {
        this.resizeFrame = null;
        this.draw();
      });
    });
    this.resizeObserver.observe(this.canvas.parentElement);
  }

  render(viewModel) {
    this.viewModel = viewModel;
    this.draw();
  }

  draw() {
    if (!this.canvas) {
      return;
    }
    if (!this.viewModel?.latest) {
      this.showFallback("Current 3-axis orientation is not available.");
      return;
    }

    try {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) {
        return;
      }
      const ratio = Math.min(CHART_CONSTANTS.maximumPixelRatio, this.window.devicePixelRatio || 1);
      this.canvas.width = Math.floor(rect.width * ratio);
      this.canvas.height = Math.floor(rect.height * ratio);
      const context = this.canvas.getContext("2d");
      if (!context) {
        this.showFallback("3-axis rendering is unavailable in this browser.");
        return;
      }
      this.hideFallback();
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      this.drawScene(context, rect.width, rect.height);
    } catch (error) {
      this.window.console.error("Tower 3-axis chart failed to render.", error);
      this.showFallback("The 3-axis orientation could not be rendered. Numeric values remain available.");
    }
  }

  drawScene(context, width, height) {
    const reading = this.viewModel.latest;
    const total = Math.min(89.5, this.viewModel.resultant);
    const origin = { x: width * 0.5, y: height * 0.79 };
    const horizontalScale = Math.min(width * 0.34, 205);
    const verticalScale = Math.min(height * 0.58, 230);
    const xAxis = { x: horizontalScale, y: -horizontalScale * 0.1 };
    const yAxis = { x: horizontalScale * 0.62, y: horizontalScale * 0.34 };

    this.drawGroundGrid(context, origin, xAxis, yAxis);
    this.drawAxis(context, origin, { x: origin.x + xAxis.x, y: origin.y + xAxis.y }, COLORS.x, "+X");
    this.drawAxis(context, origin, { x: origin.x - xAxis.x, y: origin.y - xAxis.y }, COLORS.x, "−X");
    this.drawAxis(context, origin, { x: origin.x + yAxis.x, y: origin.y + yAxis.y }, COLORS.y, "+Y");
    this.drawAxis(context, origin, { x: origin.x - yAxis.x, y: origin.y - yAxis.y }, COLORS.y, "−Y");
    this.drawAxis(context, origin, { x: origin.x, y: origin.y - verticalScale }, COLORS.ideal, "+Z");
    this.drawAxis(context, origin, { x: origin.x, y: origin.y + Math.min(54, height * 0.14) }, COLORS.ideal, "−Z");

    const idealEnd = { x: origin.x, y: origin.y - verticalScale };
    context.save();
    context.strokeStyle = COLORS.ideal;
    context.lineWidth = 1.5;
    context.setLineDash([6, 6]);
    context.beginPath();
    context.moveTo(origin.x, origin.y);
    context.lineTo(idealEnd.x, idealEnd.y);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = "#7a8798";
    context.font = '600 10px Inter, "Segoe UI", sans-serif';
    context.textAlign = "left";
    context.fillText("Ideal vertical", idealEnd.x + 9, idealEnd.y + 11);
    context.restore();

    const tiltRadians = (total * Math.PI) / 180;
    const baseAzimuth = Math.atan2(reading.y, reading.x || Number.EPSILON);
    const azimuth = baseAzimuth + (reading.z * Math.PI) / 180;
    const horizontal = Math.sin(tiltRadians) * verticalScale;
    const vertical = Math.cos(tiltRadians) * verticalScale;
    const actualEnd = {
      x: origin.x + Math.cos(azimuth) * horizontal + Math.sin(azimuth) * horizontal * 0.38,
      y: origin.y - vertical + Math.sin(azimuth) * horizontal * 0.34
    };

    const vectorColor = total >= WARNING_THRESHOLDS.alert
      ? "#d92e46"
      : total >= WARNING_THRESHOLDS.warning
        ? "#e7860b"
        : COLORS.z;

    context.save();
    context.strokeStyle = vectorColor;
    context.fillStyle = vectorColor;
    context.lineWidth = 5;
    context.lineCap = "round";
    context.shadowColor = `${vectorColor}38`;
    context.shadowBlur = 10;
    context.beginPath();
    context.moveTo(origin.x, origin.y);
    context.lineTo(actualEnd.x, actualEnd.y);
    context.stroke();
    context.shadowBlur = 0;
    context.beginPath();
    context.arc(actualEnd.x, actualEnd.y, 6, 0, Math.PI * 2);
    context.fill();
    context.restore();

    this.drawProjection(context, actualEnd, origin, vectorColor);
    this.drawAngle(context, origin, idealEnd, actualEnd, total, vectorColor);

    context.beginPath();
    context.fillStyle = "#526174";
    context.arc(origin.x, origin.y, 6, 0, Math.PI * 2);
    context.fill();
  }

  drawGroundGrid(context, origin, xAxis, yAxis) {
    context.save();
    context.strokeStyle = COLORS.grid;
    context.lineWidth = 1;
    for (let index = -4; index <= 4; index += 1) {
      const ratio = index / 4;
      context.beginPath();
      context.moveTo(origin.x - xAxis.x + yAxis.x * ratio, origin.y - xAxis.y + yAxis.y * ratio);
      context.lineTo(origin.x + xAxis.x + yAxis.x * ratio, origin.y + xAxis.y + yAxis.y * ratio);
      context.stroke();
      context.beginPath();
      context.moveTo(origin.x - yAxis.x + xAxis.x * ratio, origin.y - yAxis.y + xAxis.y * ratio);
      context.lineTo(origin.x + yAxis.x + xAxis.x * ratio, origin.y + yAxis.y + xAxis.y * ratio);
      context.stroke();
    }
    context.restore();
  }

  drawAxis(context, start, end, color, label) {
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const headSize = 7;
    context.save();
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 1.8;
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
    context.beginPath();
    context.moveTo(end.x, end.y);
    context.lineTo(end.x - Math.cos(angle - 0.5) * headSize, end.y - Math.sin(angle - 0.5) * headSize);
    context.lineTo(end.x - Math.cos(angle + 0.5) * headSize, end.y - Math.sin(angle + 0.5) * headSize);
    context.closePath();
    context.fill();
    context.font = '800 11px Inter, "Segoe UI", sans-serif';
    context.textAlign = end.x >= start.x ? "left" : "right";
    context.fillText(label, end.x + (end.x >= start.x ? 7 : -7), end.y + (end.y < start.y ? -7 : 12));
    context.restore();
  }

  drawProjection(context, actualEnd, origin, color) {
    context.save();
    context.strokeStyle = `${color}78`;
    context.lineWidth = 1.2;
    context.setLineDash([5, 5]);
    context.beginPath();
    context.moveTo(actualEnd.x, actualEnd.y);
    context.lineTo(actualEnd.x, origin.y);
    context.lineTo(origin.x, origin.y);
    context.stroke();
    context.restore();
  }

  drawAngle(context, origin, idealEnd, actualEnd, total, color) {
    if (total < 0.05) {
      return;
    }
    const idealAngle = Math.atan2(idealEnd.y - origin.y, idealEnd.x - origin.x);
    const actualAngle = Math.atan2(actualEnd.y - origin.y, actualEnd.x - origin.x);
    const radius = Math.min(50, 29 + total * 0.28);
    context.save();
    context.strokeStyle = color;
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(origin.x, origin.y, radius, idealAngle, actualAngle, actualAngle < idealAngle);
    context.stroke();
    const middle = (idealAngle + actualAngle) / 2;
    context.fillStyle = color;
    context.font = '800 12px Inter, "Segoe UI", sans-serif';
    context.textAlign = "center";
    context.fillText(`${this.viewModel.resultant.toFixed(2)}°`, origin.x + Math.cos(middle) * (radius + 18), origin.y + Math.sin(middle) * (radius + 18));
    context.restore();
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
    this.resizeObserver?.disconnect();
    if (this.resizeFrame !== null) {
      this.window.cancelAnimationFrame(this.resizeFrame);
    }
  }
}
