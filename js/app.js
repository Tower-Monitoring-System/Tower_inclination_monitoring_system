const stations = [
  {
    id: "PS-01",
    name: "Transformer Bay A",
    location: "North Substation",
    x: 0.8,
    y: 1.1,
    temperature: 36.8,
    rssi: -66,
    battery: 91
  },
  {
    id: "PS-02",
    name: "Transformer Bay B",
    location: "North Substation",
    x: 2.8,
    y: 1.9,
    temperature: 39.2,
    rssi: -72,
    battery: 83
  },
  {
    id: "PS-03",
    name: "Protection Cabinet",
    location: "Control Room",
    x: 0.5,
    y: 0.7,
    temperature: 32.6,
    rssi: -69,
    battery: 96
  },
  {
    id: "PS-04",
    name: "Busbar Support",
    location: "Outdoor Yard",
    x: 1.3,
    y: 1.6,
    temperature: 35.1,
    rssi: -77,
    battery: 78
  }
];

let selectedStationIndex = 0;
const historySize = 30;

const xHistory = Array.from(
  { length: historySize },
  (_, i) => 0.7 + Math.sin(i / 4) * 0.25 + Math.random() * 0.18
);

const yHistory = Array.from(
  { length: historySize },
  (_, i) => 0.9 + Math.cos(i / 5) * 0.22 + Math.random() * 0.16
);

const stationSelector = document.getElementById("stationSelector");
const stationOverview = document.getElementById("stationOverview");
const tiltDot = document.getElementById("tiltDot");
const canvas = document.getElementById("tiltChart");
const ctx = canvas.getContext("2d");

function getStatus(station) {
  const maxTilt = Math.max(Math.abs(station.x), Math.abs(station.y));

  if (maxTilt >= 5) return "critical";
  if (maxTilt >= 2.5) return "warning";
  return "normal";
}

function init() {
  stationSelector.innerHTML = stations
    .map(
      (station, index) =>
        `<option value="${index}">${station.id} — ${station.name}</option>`
    )
    .join("");

  updateClock();
  updateDashboard();
  resizeCanvas();
  drawChart();

  stationSelector.addEventListener("change", (event) => {
    selectedStationIndex = Number(event.target.value);
    updateSelectedStation();
    resetHistory();
  });

  document.getElementById("refreshButton").addEventListener("click", () => {
    simulateData(true);
  });

  window.addEventListener("resize", () => {
    resizeCanvas();
    drawChart();
  });

  setInterval(updateClock, 1000);
  setInterval(() => simulateData(false), 3000);
}

function updateDashboard() {
  const maxTilt = Math.max(
    ...stations.flatMap((station) => [Math.abs(station.x), Math.abs(station.y)])
  );

  const avgRssi = Math.round(
    stations.reduce((sum, station) => sum + station.rssi, 0) / stations.length
  );

  const activeAlerts = stations.filter(
    (station) => getStatus(station) !== "normal"
  ).length;

  document.getElementById("stationCount").textContent = stations.length;
  document.getElementById("maxTilt").textContent = maxTilt.toFixed(1);
  document.getElementById("avgRssi").textContent = avgRssi;
  document.getElementById("activeAlertCount").textContent = activeAlerts;

  updateSelectedStation();
  renderOverview();
  updateCondition();
}

function updateSelectedStation() {
  const station = stations[selectedStationIndex];

  document.getElementById("tiltX").textContent = station.x.toFixed(1);
  document.getElementById("tiltY").textContent = station.y.toFixed(1);
  document.getElementById("temperature").textContent =
    station.temperature.toFixed(1);

  document.getElementById("stationName").textContent =
    `${station.id} — ${station.name}`;

  document.getElementById("stationLocation").textContent =
    station.location;

  document.getElementById("stationRssi").textContent =
    station.rssi;

  document.getElementById("stationBattery").textContent =
    station.battery;

  const scale = 12;
  const dx = Math.max(-68, Math.min(68, station.x * scale));
  const dy = Math.max(-68, Math.min(68, station.y * scale));

  tiltDot.style.transform = `translate(${dx}px, ${dy}px)`;
}

function renderOverview() {
  stationOverview.innerHTML = stations
    .map((station) => {
      const status = getStatus(station);
      const maxTilt = Math.max(Math.abs(station.x), Math.abs(station.y));

      return `
        <div class="overview-item">
          <div class="overview-top">
            <h3>${station.id}</h3>
            <span class="badge ${status}">${status.toUpperCase()}</span>
          </div>
          <span>${station.name}</span>
          <strong>${maxTilt.toFixed(1)}°</strong>
          <span>${station.rssi} dBm · ${station.battery}% battery</span>
        </div>
      `;
    })
    .join("");
}

function updateCondition() {
  const statuses = stations.map(getStatus);
  const box = document.getElementById("conditionBox");
  const title = document.getElementById("conditionTitle");
  const text = document.getElementById("conditionText");

  box.classList.remove("warning", "critical");

  if (statuses.includes("critical")) {
    box.classList.add("critical");
    title.textContent = "Critical Tilt Detected";
    text.textContent =
      "At least one station has reached or exceeded the 5.0° critical threshold.";
  } else if (statuses.includes("warning")) {
    box.classList.add("warning");
    title.textContent = "Warning Condition";
    text.textContent =
      "At least one station has a tilt angle of 2.5° or higher.";
  } else {
    title.textContent = "System Normal";
    text.textContent =
      "All monitored tilt angles are below the warning threshold.";
  }
}

function simulateData(force = false) {
  stations.forEach((station) => {
    const jitter = force ? 0.22 : 0.12;

    station.x = clamp(
      station.x + (Math.random() - 0.5) * jitter,
      -5.5,
      5.5
    );

    station.y = clamp(
      station.y + (Math.random() - 0.5) * jitter,
      -5.5,
      5.5
    );

    station.temperature = clamp(
      station.temperature + (Math.random() - 0.5) * 0.35,
      25,
      55
    );

    station.rssi = Math.round(
      clamp(station.rssi + (Math.random() - 0.5) * 3, -105, -45)
    );
  });

  const selected = stations[selectedStationIndex];

  xHistory.push(selected.x);
  yHistory.push(selected.y);

  if (xHistory.length > historySize) xHistory.shift();
  if (yHistory.length > historySize) yHistory.shift();

  updateDashboard();
  drawChart();
}

function resetHistory() {
  const selected = stations[selectedStationIndex];

  for (let i = 0; i < historySize; i++) {
    xHistory[i] = selected.x + (Math.random() - 0.5) * 0.25;
    yHistory[i] = selected.y + (Math.random() - 0.5) * 0.25;
  }

  drawChart();
}

function updateClock() {
  const now = new Date();

  document.getElementById("currentDate").textContent =
    now.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit"
    });

  document.getElementById("currentTime").textContent =
    now.toLocaleTimeString(undefined, {
      hour12: false
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

  const pad = {
    left: 44,
    right: 18,
    top: 20,
    bottom: 32
  };

  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  ctx.clearRect(0, 0, width, height);

  const minY = -1;
  const maxY = 6;

  const yToPx = (value) =>
    pad.top + ((maxY - value) / (maxY - minY)) * chartH;

  const xToPx = (index) =>
    pad.left + (index / (historySize - 1)) * chartW;

  ctx.font = "12px Arial";
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

  const warningY = yToPx(2.5);
  ctx.strokeStyle = "rgba(255,189,102,0.35)";
  ctx.setLineDash([5, 6]);
  ctx.beginPath();
  ctx.moveTo(pad.left, warningY);
  ctx.lineTo(width - pad.right, warningY);
  ctx.stroke();

  const criticalY = yToPx(5);
  ctx.strokeStyle = "rgba(255,111,125,0.55)";
  ctx.beginPath();
  ctx.moveTo(pad.left, criticalY);
  ctx.lineTo(width - pad.right, criticalY);
  ctx.stroke();
  ctx.setLineDash([]);

  drawLine(xHistory, "#39d2c0");
  drawLine(yHistory, "#67a8ff");

  function drawLine(data, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.beginPath();

    data.forEach((value, index) => {
      const x = xToPx(index);
      const y = yToPx(value);

      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });

    ctx.stroke();
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

init();
