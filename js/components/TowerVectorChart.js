import { CHART_CONSTANTS, WARNING_THRESHOLDS } from "../core/constants.js";

const COLORS = Object.freeze({
  x: "#176ff2",
  y: "#14833b",
  z: "#7b24d6",
  ideal: "#8c9aaa",
  grid: "#e2eaf3"
});

const VIEW = Object.freeze({
  defaultAzimuth: 35,
  keyboardStep: 5,
  buttonStep: 15,
  fullRotation: 360,
  groundDepth: 0.44,
  defaultZoom: 1,
  minimumZoom: 0.7,
  maximumZoom: 1.5,
  wheelZoomStep: 0.08
});

function viewModelSignature(viewModel) {
  const latest = viewModel?.latest;
  return latest
    ? `${latest.timestamp}|${latest.x}|${latest.y}|${latest.z}|${viewModel.resultant}|${viewModel.status}`
    : "empty";
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function normalizeDegrees(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return VIEW.defaultAzimuth;
  }
  return ((number % VIEW.fullRotation) + VIEW.fullRotation) % VIEW.fullRotation;
}

function visualTiltDegrees(actualTilt) {
  if (actualTilt < 0.05) {
    return actualTilt;
  }
  if (actualTilt <= 2) {
    return 2 + (actualTilt * 3);
  }
  if (actualTilt < 10) {
    return 8 + ((actualTilt - 2) * 0.25);
  }
  return Math.min(70, actualTilt);
}

function statusColor(total) {
  if (total >= WARNING_THRESHOLDS.alert) {
    return "#d92e46";
  }
  if (total >= WARNING_THRESHOLDS.warning) {
    return "#e7860b";
  }
  return COLORS.z;
}

export class TowerVectorChart {
  constructor(documentRef = document, browserWindow = window) {
    this.document = documentRef;
    this.window = browserWindow;
    this.canvas = documentRef.getElementById("towerVectorCanvas");
    this.fallback = documentRef.getElementById("towerVectorFallback");
    this.viewModel = null;
    this.period = "day";
    this.renderSignature = "";
    this.viewAzimuthDegrees = VIEW.defaultAzimuth;
    this.zoomLevel = VIEW.defaultZoom;
    this.pointerDrag = null;
    this.drawFrame = null;
    this.resizeObserver = null;
    this.abortController = new this.window.AbortController();

    this.bindInteraction();
    this.observeSize();
  }

  listen(element, eventName, callback, options = {}) {
    element?.addEventListener(eventName, callback, {
      ...options,
      signal: this.abortController.signal
    });
  }

  bindInteraction() {
    this.listen(this.canvas, "pointerdown", (event) => this.startPointerDrag(event));
    this.listen(this.canvas, "pointermove", (event) => this.movePointerDrag(event));
    this.listen(this.canvas, "pointerup", (event) => this.endPointerDrag(event));
    this.listen(this.canvas, "pointercancel", (event) => this.endPointerDrag(event));
    this.listen(this.canvas, "lostpointercapture", () => this.clearPointerDrag());
    this.listen(this.canvas, "keydown", (event) => this.handleKeydown(event));
    this.listen(this.canvas, "wheel", (event) => this.handleWheel(event), { passive: false });
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

  render(viewModel, options = {}) {
    this.period = ["day", "month", "custom"].includes(options.period) ? options.period : "day";
    this.viewModel = viewModel;
    this.updateCanvasLabel();

    const nextSignature = `${this.period}|${viewModelSignature(viewModel)}`;
    if (nextSignature === this.renderSignature) {
      return;
    }
    this.renderSignature = nextSignature;
    this.requestDraw();
  }

  setViewAzimuth(value) {
    const nextValue = normalizeDegrees(value);
    if (Math.abs(nextValue - this.viewAzimuthDegrees) < 0.01) {
      return;
    }
    this.viewAzimuthDegrees = nextValue;
    this.updateCanvasLabel();
    this.requestDraw();
  }

  setZoom(value) {
    const nextValue = clamp(Number(value) || VIEW.defaultZoom, VIEW.minimumZoom, VIEW.maximumZoom);
    if (Math.abs(nextValue - this.zoomLevel) < 0.001) {
      return;
    }
    this.zoomLevel = nextValue;
    this.updateCanvasLabel();
    this.requestDraw();
  }

  changeZoom(delta) {
    this.setZoom(this.zoomLevel + delta);
  }

  updateCanvasLabel() {
    if (!this.canvas) {
      return;
    }
    const angle = Math.round(this.viewAzimuthDegrees) % VIEW.fullRotation;
    const tilt = Number.isFinite(this.viewModel?.resultant)
      ? `${this.viewModel.resultant.toFixed(2)} degrees`
      : "unavailable";
    const zoom = Math.round(this.zoomLevel * 100);
    this.canvas.setAttribute(
      "aria-label",
      `Interactive three-axis orientation for the selected ${this.period} period. Tilt ${tilt}. View ${angle} degrees around Z. Zoom ${zoom} percent. Drag horizontally to rotate. Use the mouse wheel to zoom in or out.`
    );
  }

  startPointerDrag(event) {
    if (!this.viewModel?.latest || event.button !== 0 || event.isPrimary === false) {
      return;
    }
    this.pointerDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startAzimuth: this.viewAzimuthDegrees
    };
    this.canvas.classList.add("is-dragging");
    this.canvas.focus({ preventScroll: true });
    try {
      this.canvas.setPointerCapture?.(event.pointerId);
    } catch (error) {
      this.window.console.debug("Pointer capture is unavailable for the orientation chart.", error);
    }
    event.preventDefault();
  }

  movePointerDrag(event) {
    if (!this.pointerDrag || event.pointerId !== this.pointerDrag.pointerId) {
      return;
    }
    const width = Math.max(1, this.canvas.getBoundingClientRect().width);
    const deltaDegrees = ((event.clientX - this.pointerDrag.startX) / width) * VIEW.fullRotation;
    this.setViewAzimuth(this.pointerDrag.startAzimuth + deltaDegrees);
    event.preventDefault();
  }

  endPointerDrag(event) {
    if (!this.pointerDrag || event.pointerId !== this.pointerDrag.pointerId) {
      return;
    }
    try {
      if (this.canvas.hasPointerCapture?.(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
    } catch (error) {
      this.window.console.debug("Pointer capture could not be released.", error);
    }
    this.clearPointerDrag();
  }

  clearPointerDrag() {
    this.pointerDrag = null;
    this.canvas?.classList.remove("is-dragging");
  }

  handleKeydown(event) {
    const changes = {
      ArrowLeft: -VIEW.keyboardStep,
      ArrowRight: VIEW.keyboardStep,
      PageDown: -VIEW.buttonStep,
      PageUp: VIEW.buttonStep
    };
    if (Object.prototype.hasOwnProperty.call(changes, event.key)) {
      this.setViewAzimuth(this.viewAzimuthDegrees + changes[event.key]);
      event.preventDefault();
      return;
    }
    if (event.key === "Home") {
      this.setViewAzimuth(VIEW.defaultAzimuth);
      event.preventDefault();
      return;
    }
  }

  handleWheel(event) {
    if (!this.viewModel?.latest || !Number.isFinite(event.deltaY) || event.deltaY === 0) {
      return;
    }
    const direction = event.deltaY < 0 ? 1 : -1;
    this.changeZoom(direction * VIEW.wheelZoomStep);
    event.preventDefault();
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
      const canvasWidth = Math.floor(rect.width * ratio);
      const canvasHeight = Math.floor(rect.height * ratio);
      if (this.canvas.width !== canvasWidth || this.canvas.height !== canvasHeight) {
        this.canvas.width = canvasWidth;
        this.canvas.height = canvasHeight;
      }
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
    const total = clamp(Number(this.viewModel.resultant) || 0, 0, 89.5);
    const origin = { x: width * 0.5, y: height * 0.76 };
    const baseGroundScale = Math.max(74, Math.min(width * 0.33, height * 0.34, 176));
    const baseVerticalScale = Math.max(142, Math.min(width * 0.48, height * 0.58, 248));
    const groundScale = baseGroundScale * this.zoomLevel;
    const verticalScale = baseVerticalScale * this.zoomLevel;
    const project = this.createProjector(origin, groundScale, verticalScale);

    this.drawGroundGrid(context, project);
    this.drawCompass(context, project);
    this.drawAxis(context, origin, project({ x: 1.12 }), COLORS.x, "+X");
    this.drawAxis(context, origin, project({ x: -1.12 }), COLORS.x, "−X");
    this.drawAxis(context, origin, project({ y: 1.12 }), COLORS.y, "+Y");
    this.drawAxis(context, origin, project({ y: -1.12 }), COLORS.y, "−Y");
    this.drawAxis(context, origin, project({ z: -0.18 }), COLORS.ideal, "−Z");

    const idealEnd = project({ z: 1 });
    this.drawIdealVertical(context, origin, idealEnd);

    const planarMagnitude = Math.hypot(reading.x, reading.y);
    const sensorDirection = planarMagnitude > 0.0001
      ? Math.atan2(reading.y, reading.x)
      : 0;
    const directionAzimuth = sensorDirection + toRadians(reading.z);
    const displayedTilt = toRadians(visualTiltDegrees(total));
    const horizontal = Math.sin(displayedTilt);
    const actualWorld = {
      x: Math.cos(directionAzimuth) * horizontal,
      y: Math.sin(directionAzimuth) * horizontal,
      z: Math.cos(displayedTilt)
    };
    const actualGround = { x: actualWorld.x, y: actualWorld.y, z: 0 };
    const actualEnd = project(actualWorld);
    const groundEnd = project(actualGround);
    const vectorColor = statusColor(total);

    if (total >= 0.05) {
      this.drawDirectionGuide(context, origin, project, directionAzimuth, vectorColor);
      this.drawTiltSector(context, origin, project, directionAzimuth, displayedTilt, vectorColor);
      this.drawProjection(context, origin, groundEnd, actualEnd, vectorColor);
    }
    this.drawTowerVector(context, origin, actualEnd, vectorColor);
    this.drawTiltTag(context, width, height, actualEnd, vectorColor);

    context.save();
    context.fillStyle = "#526174";
    context.beginPath();
    context.arc(origin.x, origin.y, 6, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = "#ffffff";
    context.lineWidth = 2;
    context.stroke();
    context.restore();
  }

  createProjector(origin, groundScale, verticalScale) {
    const camera = toRadians(this.viewAzimuthDegrees);
    const sine = Math.sin(camera);
    const cosine = Math.cos(camera);
    return ({ x = 0, y = 0, z = 0 }) => ({
      x: origin.x + ((-sine * x) + (cosine * y)) * groundScale,
      y: origin.y + ((cosine * x) + (sine * y)) * groundScale * VIEW.groundDepth - (z * verticalScale)
    });
  }

  drawGroundGrid(context, project) {
    const corners = [
      project({ x: -1, y: -1 }),
      project({ x: 1, y: -1 }),
      project({ x: 1, y: 1 }),
      project({ x: -1, y: 1 })
    ];
    context.save();
    context.fillStyle = "rgba(242, 247, 253, 0.62)";
    context.beginPath();
    corners.forEach((point, index) => {
      if (index === 0) {
        context.moveTo(point.x, point.y);
      } else {
        context.lineTo(point.x, point.y);
      }
    });
    context.closePath();
    context.fill();

    context.strokeStyle = COLORS.grid;
    context.lineWidth = 1;
    for (let index = -4; index <= 4; index += 1) {
      const position = index / 4;
      const xStart = project({ x: -1, y: position });
      const xEnd = project({ x: 1, y: position });
      const yStart = project({ x: position, y: -1 });
      const yEnd = project({ x: position, y: 1 });
      context.beginPath();
      context.moveTo(xStart.x, xStart.y);
      context.lineTo(xEnd.x, xEnd.y);
      context.stroke();
      context.beginPath();
      context.moveTo(yStart.x, yStart.y);
      context.lineTo(yEnd.x, yEnd.y);
      context.stroke();
    }
    context.restore();
  }

  drawCompass(context, project) {
    context.save();
    context.strokeStyle = "#ccd9e8";
    context.lineWidth = 1.2;
    context.setLineDash([3, 4]);
    context.beginPath();
    for (let index = 0; index <= 64; index += 1) {
      const angle = (index / 64) * Math.PI * 2;
      const point = project({ x: Math.cos(angle) * 0.93, y: Math.sin(angle) * 0.93 });
      if (index === 0) {
        context.moveTo(point.x, point.y);
      } else {
        context.lineTo(point.x, point.y);
      }
    }
    context.stroke();
    context.restore();
  }

  drawIdealVertical(context, origin, idealEnd) {
    context.save();
    context.strokeStyle = COLORS.ideal;
    context.fillStyle = COLORS.ideal;
    context.lineWidth = 1.6;
    context.setLineDash([6, 6]);
    context.beginPath();
    context.moveTo(origin.x, origin.y);
    context.lineTo(idealEnd.x, idealEnd.y);
    context.stroke();
    context.setLineDash([]);
    context.beginPath();
    context.arc(idealEnd.x, idealEnd.y, 3.5, 0, Math.PI * 2);
    context.fill();
    context.font = '700 10px Inter, "Segoe UI", sans-serif';
    context.textAlign = "left";
    context.fillText("Ideal vertical (+Z)", idealEnd.x + 8, idealEnd.y + 4);
    context.restore();
  }

  drawAxis(context, start, end, color, label) {
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const headSize = 7;
    const isVertical = Math.abs(end.x - start.x) < 8;
    context.save();
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 1.7;
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
    context.textAlign = isVertical ? "center" : (end.x >= start.x ? "left" : "right");
    context.fillText(
      label,
      end.x + (isVertical ? 0 : (end.x >= start.x ? 7 : -7)),
      end.y + (end.y < start.y ? -7 : 12)
    );
    context.restore();
  }

  drawDirectionGuide(context, origin, project, directionAzimuth, color) {
    const directionEnd = project({
      x: Math.cos(directionAzimuth) * 0.74,
      y: Math.sin(directionAzimuth) * 0.74
    });
    const angle = Math.atan2(directionEnd.y - origin.y, directionEnd.x - origin.x);
    context.save();
    context.strokeStyle = `${color}9c`;
    context.fillStyle = color;
    context.lineWidth = 1.5;
    context.setLineDash([5, 4]);
    context.beginPath();
    context.moveTo(origin.x, origin.y);
    context.lineTo(directionEnd.x, directionEnd.y);
    context.stroke();
    context.setLineDash([]);
    context.beginPath();
    context.moveTo(directionEnd.x, directionEnd.y);
    context.lineTo(directionEnd.x - Math.cos(angle - 0.48) * 7, directionEnd.y - Math.sin(angle - 0.48) * 7);
    context.lineTo(directionEnd.x - Math.cos(angle + 0.48) * 7, directionEnd.y - Math.sin(angle + 0.48) * 7);
    context.closePath();
    context.fill();
    context.font = '700 9px Inter, "Segoe UI", sans-serif';
    context.textAlign = directionEnd.x >= origin.x ? "left" : "right";
    context.fillText(
      "Tilt direction",
      directionEnd.x + (directionEnd.x >= origin.x ? 7 : -7),
      directionEnd.y - 5
    );
    context.restore();
  }

  drawTiltSector(context, origin, project, directionAzimuth, tiltRadians, color) {
    const radius = 0.42;
    const points = [];
    for (let index = 0; index <= 20; index += 1) {
      const angle = tiltRadians * (index / 20);
      points.push(project({
        x: Math.cos(directionAzimuth) * Math.sin(angle) * radius,
        y: Math.sin(directionAzimuth) * Math.sin(angle) * radius,
        z: Math.cos(angle) * radius
      }));
    }
    context.save();
    context.fillStyle = `${color}18`;
    context.strokeStyle = color;
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(origin.x, origin.y);
    points.forEach((point) => context.lineTo(point.x, point.y));
    context.closePath();
    context.fill();
    context.beginPath();
    points.forEach((point, index) => {
      if (index === 0) {
        context.moveTo(point.x, point.y);
      } else {
        context.lineTo(point.x, point.y);
      }
    });
    context.stroke();
    context.restore();
  }

  drawProjection(context, origin, groundEnd, actualEnd, color) {
    context.save();
    context.strokeStyle = `${color}82`;
    context.lineWidth = 1.2;
    context.setLineDash([5, 5]);
    context.beginPath();
    context.moveTo(origin.x, origin.y);
    context.lineTo(groundEnd.x, groundEnd.y);
    context.lineTo(actualEnd.x, actualEnd.y);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = `${color}b8`;
    context.beginPath();
    context.arc(groundEnd.x, groundEnd.y, 3.5, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  drawTowerVector(context, origin, actualEnd, color) {
    const gradient = context.createLinearGradient(origin.x, origin.y, actualEnd.x, actualEnd.y);
    gradient.addColorStop(0, `${color}bf`);
    gradient.addColorStop(1, color);
    context.save();
    context.strokeStyle = `${color}24`;
    context.lineWidth = 11;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(origin.x, origin.y);
    context.lineTo(actualEnd.x, actualEnd.y);
    context.stroke();
    context.strokeStyle = gradient;
    context.lineWidth = 5;
    context.shadowColor = `${color}55`;
    context.shadowBlur = 10;
    context.beginPath();
    context.moveTo(origin.x, origin.y);
    context.lineTo(actualEnd.x, actualEnd.y);
    context.stroke();
    context.shadowBlur = 0;
    context.fillStyle = "#ffffff";
    context.beginPath();
    context.arc(actualEnd.x, actualEnd.y, 7, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = color;
    context.lineWidth = 4;
    context.stroke();
    context.restore();
  }

  drawTiltTag(context, width, height, actualEnd, color) {
    const text = `Tilt ${this.viewModel.resultant.toFixed(2)}°`;
    context.save();
    context.font = '800 10px Inter, "Segoe UI", sans-serif';
    const tagWidth = Math.ceil(context.measureText(text).width) + 16;
    const tagHeight = 23;
    const preferredX = actualEnd.x <= width * 0.55
      ? actualEnd.x - tagWidth - 10
      : actualEnd.x + 10;
    const x = clamp(preferredX, 5, width - tagWidth - 5);
    const y = clamp(actualEnd.y - 12, 56, height - tagHeight - 26);
    context.fillStyle = "rgba(255, 255, 255, 0.94)";
    context.strokeStyle = `${color}65`;
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(x, y, tagWidth, tagHeight, 7);
    context.fill();
    context.stroke();
    context.fillStyle = color;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, x + tagWidth / 2, y + tagHeight / 2 + 0.5);
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
    this.abortController.abort();
    this.resizeObserver?.disconnect();
    this.clearPointerDrag();
    if (this.drawFrame !== null) {
      this.window.cancelAnimationFrame(this.drawFrame);
    }
  }
}
