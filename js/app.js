const stations = [
  {
    id: "PS-01",
    name: "Transformer Bay A",
    location: "North Substation",
    x: 0.8,
    y: 1.1,
    temperature: 36.8,
    rssi: -66,
    battery: 91,
    status: "normal",
  },
  {
    id: "PS-02",
    name: "Transformer Bay B",
    location: "North Substation",
    x: 2.8,
    y: 1.9,
    temperature: 39.2,
    rssi: -72,
    battery: 83,
    status: "warning",
  },
  {
    id: "PS-03",
    name: "Protection Cabinet",
    location: "Control Room",
    x: 0.5,
    y: 0.7,
    temperature: 32.6,
    rssi: -69,
    battery: 96,
    status: "normal",
  },
  {
    id: "PS-04",
    name: "Busbar Support",
    location: "Outdoor Yard",
    x: 1.3,
    y: 1.6,
    temperature: 35.1,
    rssi: -77,
    battery: 78,
    status: "normal",
  },
];

const alertData = [
  {
    type: "warning",
    title: "Tilt angle increased at PS-02",
    description: "X-axis is above the normal baseline but still below the 5.0° critical threshold.",
    time: "2 min ago",
  },
  {
    type: "info",
    title: "Gateway synchronization completed",
    description: "All LoRa nodes successfully synchronized with the monitoring gateway.",
    time: "18 min ago",
  },
  {
    type: "info",
    title: "Daily sensor self-check passed",
    description: "Accelerometer, temperature and radio-health checks completed successfully.",
    time: "07:30",
  },
];

let selectedStationIndex = 0;
const historySize = 30;
const xHistory = Array.from({ length: historySize }, (_, i) => 0.7 + Math.sin(i / 4) * 0.25 + Math.random() * 0.18);
const yHistory = Array.from({ length: historySize }, (_, i) => 0.9 + Math.cos(i / 5) * 0.22 + Math.random() * 0.16);

const stationSelector = document.getElementById("stationSelector");
const stationCards = document.getElementById("stationCards");
const alertList = document.getElementById("alertList");
const tiltDot = document.getElementById("tiltDot");
const canvas = document.getElementById("tiltChart");
const ctx = canvas.getContext("2d");

function init() {
  populateSelector();
  renderStationCards();
  renderAlerts();
  updateClock();
  updateDashboard();
  resizeCanvas();
  drawChart();

  setInterval(updateClock, 1000);
  setInterval(simulateData, 3000);

  window.addEventListener("resize", () => {
    resizeCanvas();
    drawChart();
  });

  stationSelector.addEventListener("change", (event) => {
    selectedStationIndex = Number(event.target.value);
    updateSelectedStation();
  });

  document.getElementById("refreshButton").addEventListener("click", () => {
    simulateData(true);
  });
}

function populateSelector() {
  stationSelector.innerHTML = stations
    .map((station, index) => `<option value="${index}">${station.id} — ${station.name}</option>`)
    .join("");
}

function renderStationCards() {
  stationCards.innerHTML = stations
    .map(
      (station) => `
      <article class="station-card">
        <div class="station-card-head">
          <div>
            <h4>${station.id} — ${station.name}</h4>
            <p class="station-location">${station.location}</p>
          </div>
          <span class="badge ${station.status}">${station.status.toUpperCase()}</span>
        </div>
        <div class="station-stats">
          <div>
            <span>TILT X / Y</span>
            <strong>${station.x.toFixed(1)}° / ${station.y.toFixed(1)}°</strong>
          </div>
          <div>
            <span>TEMPERATURE</span>
            <strong>${station.temperature.toFixed(1)} °C</strong>
          </div>
          <div>
            <span>LoRa RSSI</span>
            <strong>${station.rssi} dBm</strong>
          </div>
          <div>
            <span>NODE BATTERY</span>
            <strong>${station.battery}%</strong>
          </div>
        </div>
      </article>
    `
    )
    .join("");
}

function renderAlerts() {
  alertList.innerHTML = alertData
    .map(
      (item) => `
      <div class="alert-item">
        <span class="alert-indicator ${item.type}"></span>
        <div>
          <p class="alert-title">${item.title}</p>
          <span class="alert-description">${item.description}</span>
        </div>
        <span class="alert-time">${item.time}</span>
      </div>
    `
    )
    .join("");
}

function updateDashboard() {
  const maxTilt = Math.max(...stations.flatMap((station) => [Math.abs(station.x), Math.abs(station.y)]));
  const avgRssi = Math.round(stations.reduce((sum, station) => sum + station.rssi, 0) / stations.length);
  const activeAlerts = stations.filter((station) => station.status === "warning").length;

  document.getElementById("stationCount").textContent = stations.length;
  document.getElementById("maxTilt").textContent = maxTilt.toFixed(1);
  document.getElementById("avgRssi").textContent = avgRssi;
  document.getElementById("activeAlertCount").textContent = activeAlerts;

  updateSelectedStation();
  renderStationCards();
}

function updateSelectedStation() {
  const station = stations[selectedStationIndex];

  document.getElementById("tiltX").textContent = station.x.toFixed(1);
  document.getElementById("tiltY").textContent = station.y.toFixed(1);
  document.getElementById("temperature").textContent = station.temperature.toFixed(1);

  const scale = 12;
  const dx = Math.max(-70, Math.min(70, station.x * scale));
  const dy = Math.max(-70, Math.min(70, station.y * scale));
  tiltDot.style.transform = `translate(${dx}px, ${dy}px)`;
}

function simulateData(force = false) {
  stations.forEach((station, index) => {
    const jitter = force ? 0.22 : 0.12;

    station.x = clamp(station.x + (Math.random() - 0.5) * jitter, -5.5, 5.5);
    station.y = clamp(station.y + (Math.random() - 0.5) * jitter, -5.5, 5.5);
    station.temperature = clamp(station.temperature + (Math.random() - 0.5) * 0.35, 25, 55);
    station.rssi = Math.round(clamp(station.rssi + (Math.random() - 0.5) * 3, -105, -45));

    if (index === 1) {
      station.status = Math.max(Math.abs(station.x), Math.abs(station.y)) >= 2.5 ? "warning" : "normal";
    } else {
      station.status = Math.max(Math.abs(station.x), Math.abs(station.y)) >= 5 ? "warning" : "normal";
    }
  });

  const selected = stations[selectedStationIndex];
  xHistory.push(selected.x);
  yHistory.push(selected.y);

  if (xHistory.length > historySize) xHistory.shift();
  if (yHistory.length > historySize) yHistory.shift();

  updateDashboard();
  drawChart();
}

function updateClock() {
  const now = new Date();

  document.getElementById("currentDate").textContent = now.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });

  document.getElementById("currentTime").textContent = now.toLocaleTimeString(undefined, {
    hour12: false,
  });
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawChart() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const pad = { left: 44, right: 18, top: 20, bottom: 32 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  ctx.clearRect(0, 0, width, height);

  const minY = -1;
  const maxY = 6;
  const yToPx = (value) => pad.top + ((maxY - value) / (maxY - minY)) * chartH;
  const xToPx = (index) => pad.left + (index / (historySize - 1)) * chartW;

  ctx.font = "12px system-ui";
  ctx.lineWidth = 1;

  for (let value = 0; value <= 5; value += 1) {
    const y = yToPx(value);
    ctx.strokeStyle = "rgba(255,255,255,0.075)";
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();

    ctx.fillStyle = "#7f96af";
    ctx.fillText(`${value}°`, 8, y + 4);
  }

  const thresholdY = yToPx(5);
  ctx.strokeStyle = "rgba(255,111,125,0.55)";
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(pad.left, thresholdY);
  ctx.lineTo(width - pad.right, thresholdY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#b98a92";
  ctx.fillText("Critical threshold", width - 118, thresholdY - 8);

  drawLine(xHistory, "#39d2c0");
  drawLine(yHistory, "#67a8ff");

  function drawLine(data, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.beginPath();

    data.forEach((value, index) => {
      const x = xToPx(index);
      const y = yToPx(value);

      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.stroke();

    const lastIndex = data.length - 1;
    const x = xToPx(lastIndex);
    const y = yToPx(data[lastIndex]);

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

init();
