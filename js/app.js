(function initializeDashboard(window, document) {
  "use strict";

  const THRESHOLDS = Object.freeze({
    warning: 0.7,
    alert: 1.0
  });

  const RANGE_DEFINITIONS = Object.freeze({
    realtime: { points: 24, label: "Live · Last 24 samples" },
    "24h": { points: 24, label: "Today · Hourly samples" },
    "7d": { points: 28, label: "Last 7 days · 6-hour samples" },
    "30d": { points: 30, label: "Last 30 days · Daily samples" },
    custom: { points: 20, label: "Custom · Last 14 days" }
  });

  const TOWER_COLORS = [
    "#2478f3",
    "#17a655",
    "#ed3548",
    "#8138e9",
    "#f28c18",
    "#16a9cf"
  ];

  // Replace this array with ESP32, Firebase, Supabase, or REST API data later.
  const towers = [
    {
      id: "TWR-003",
      name: "North Ridge Tower",
      location: "North Ridge",
      maxTilt: 1.24,
      online: true,
      sensors: 4,
      rssi: -62,
      battery: 86
    },
    {
      id: "TWR-017",
      name: "Hilltop Relay",
      location: "Hilltop Site",
      maxTilt: 0.92,
      online: true,
      sensors: 4,
      rssi: -68,
      battery: 91
    },
    {
      id: "TWR-008",
      name: "East Valley Tower",
      location: "East Valley",
      maxTilt: 0.78,
      online: true,
      sensors: 4,
      rssi: -71,
      battery: 79
    },
    {
      id: "TWR-001",
      name: "Riverside Tower",
      location: "Riverside",
      maxTilt: 0.64,
      online: true,
      sensors: 4,
      rssi: -65,
      battery: 94
    },
    {
      id: "TWR-012",
      name: "West Point Tower",
      location: "West Point",
      maxTilt: 0.55,
      online: true,
      sensors: 4,
      rssi: -74,
      battery: 76
    },
    {
      id: "TWR-021",
      name: "South Field Tower",
      location: "South Field",
      maxTilt: 0.44,
      online: false,
      sensors: 4,
      rssi: -101,
      battery: 42
    },
    {
      id: "TWR-006",
      name: "Lake Side Tower",
      location: "Lake Side",
      maxTilt: 0.39,
      online: true,
      sensors: 4,
      rssi: -69,
      battery: 88
    },
    {
      id: "TWR-025",
      name: "Industrial Park Tower",
      location: "Industrial Park",
      maxTilt: 0.31,
      online: true,
      sensors: 4,
      rssi: -73,
      battery: 81
    }
  ];

  const state = {
    range: "realtime",
    chartMode: "trend",
    autoRefresh: true,
    lastUpdatedAt: new Date(),
    hoverIndex: null,
    trendData: null,
    loading: false,
    toastTimer: null,
    resizeTimer: null
  };

  const elements = {
    appShell: document.getElementById("appShell"),
    sidebarBackdrop: document.getElementById("sidebarBackdrop"),
    menuButton: document.getElementById("menuButton"),
    notificationButton: document.getElementById("notificationButton"),
    notificationCount: document.getElementById("notificationCount"),
    accountButton: document.getElementById("accountButton"),
    accountDropdown: document.getElementById("accountDropdown"),
    refreshButton: document.getElementById("refreshButton"),
    exportButton: document.getElementById("exportButton"),
    analyticsPanel: document.getElementById("analyticsPanel"),
    chart: document.getElementById("inclinationChart"),
    chartTooltip: document.getElementById("chartTooltip"),
    chartLegend: document.getElementById("chartLegend"),
    chartTitle: document.getElementById("analyticsTitle"),
    chartDescription: document.getElementById("chartDescription"),
    chartSection: document.getElementById("chartSection"),
    rankingBody: document.getElementById("rankingBody"),
    rankingCount: document.getElementById("rankingCount"),
    dateRangeButton: document.getElementById("dateRangeButton"),
    dateRangeLabel: document.getElementById("dateRangeLabel"),
    autoRefreshToggle: document.getElementById("autoRefreshToggle"),
    lastUpdated: document.getElementById("lastUpdated"),
    lastSyncHeader: document.getElementById("lastSyncHeader"),
    toast: document.getElementById("dashboardToast"),
    toastMessage: document.getElementById("dashboardToastMessage")
  };

  let chartContext = elements.chart.getContext("2d");
  let chartMetrics = null;

  function init() {
    state.trendData = createTrendData(state.range);
    bindEvents();
    renderDashboard();
    updateUserIdentity();

    document.addEventListener("DOMContentLoaded", updateUserIdentity, { once: true });

    window.requestAnimationFrame(function removeInitialSkeleton() {
      window.requestAnimationFrame(function revealDashboard() {
        document.body.classList.remove("dashboard-loading");
      });
    });

    if ("ResizeObserver" in window) {
      const chartObserver = new ResizeObserver(function redrawObservedChart() {
        drawChart();
      });
      chartObserver.observe(elements.chart.parentElement);
    }

    window.setInterval(updateRelativeTime, 15000);
    window.setInterval(function runAutoRefresh() {
      if (state.autoRefresh && state.range === "realtime" && !state.loading) {
        refreshDashboard({ automatic: true });
      }
    }, 8000);
  }

  function bindEvents() {
    elements.menuButton.addEventListener("click", toggleNavigation);
    elements.sidebarBackdrop.addEventListener("click", closeMobileNavigation);

    document.querySelectorAll("[data-nav-target]").forEach(function bindNavigationItem(item) {
      item.addEventListener("click", function handleNavigationSelection() {
        const target = item.dataset.navTarget;
        closeMobileNavigation();
        closeAccountMenu();

        if (target !== "Overview") {
          showToast(`${target} is prepared for the next integration phase.`, "info");
        }
      });
    });

    elements.notificationButton.addEventListener("click", function showNotifications() {
      const statuses = getStatusCounts();
      showToast(
        `${statuses.alert} alert and ${statuses.warning} warning towers need review.`,
        statuses.alert ? "warning" : "info"
      );
    });

    elements.accountButton.addEventListener("click", toggleAccountMenu);

    document.addEventListener("click", function closeFloatingMenus(event) {
      if (!event.target.closest(".account-menu-wrap")) {
        closeAccountMenu();
      }
    });

    document.addEventListener("keydown", function handleGlobalKeyboard(event) {
      if (event.key === "Escape") {
        closeAccountMenu();
        closeMobileNavigation();
      }
    });

    elements.refreshButton.addEventListener("click", function handleManualRefresh() {
      refreshDashboard({ automatic: false });
    });

    elements.exportButton.addEventListener("click", exportTowerData);

    document.querySelectorAll("[data-range]").forEach(function bindRangeButton(button) {
      button.addEventListener("click", function selectRange() {
        setRange(button.dataset.range);
      });
    });

    document.querySelectorAll("[data-chart-mode]").forEach(function bindChartTab(button) {
      button.addEventListener("click", function selectChartMode() {
        setChartMode(button.dataset.chartMode);
      });
    });

    elements.dateRangeButton.addEventListener("click", function selectCustomRange() {
      setRange("custom");
      showToast("Showing a prepared 14-day custom monitoring window.", "info");
    });

    elements.autoRefreshToggle.addEventListener("change", function updateAutoRefresh(event) {
      state.autoRefresh = event.target.checked;
      showToast(`Auto-refresh ${state.autoRefresh ? "enabled" : "paused"}.`, "info");
    });

    elements.chart.addEventListener("pointermove", handleChartPointerMove);
    elements.chart.addEventListener("pointerleave", clearChartHover);
    elements.chart.addEventListener("keydown", handleChartKeyboard);
    elements.chart.setAttribute("tabindex", "0");

    window.addEventListener("resize", function handleWindowResize() {
      window.clearTimeout(state.resizeTimer);
      state.resizeTimer = window.setTimeout(function completeResize() {
        if (window.innerWidth > 1100) {
          closeMobileNavigation();
        }
        drawChart();
      }, 100);
    });
  }

  function toggleNavigation() {
    if (window.innerWidth <= 1100) {
      const isOpen = elements.appShell.classList.toggle("sidebar-open");
      elements.menuButton.setAttribute("aria-expanded", isOpen ? "true" : "false");
      document.body.classList.toggle("sidebar-lock", isOpen);
      return;
    }

    const isCollapsed = elements.appShell.classList.toggle("sidebar-collapsed");
    elements.menuButton.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    window.setTimeout(drawChart, 240);
  }

  function closeMobileNavigation() {
    elements.appShell.classList.remove("sidebar-open");
    elements.menuButton.setAttribute("aria-expanded", "false");
    document.body.classList.remove("sidebar-lock");
  }

  function toggleAccountMenu() {
    const willOpen = elements.accountDropdown.hidden;
    elements.accountDropdown.hidden = !willOpen;
    elements.accountButton.setAttribute("aria-expanded", willOpen ? "true" : "false");
  }

  function closeAccountMenu() {
    elements.accountDropdown.hidden = true;
    elements.accountButton.setAttribute("aria-expanded", "false");
  }

  function updateUserIdentity() {
    const usernameElement = document.querySelector("[data-auth-username]");
    const username = usernameElement ? usernameElement.textContent.trim() : "Operator";
    const initial = username ? username.charAt(0).toUpperCase() : "O";

    document.querySelectorAll("[data-user-initial]").forEach(function setUserInitial(element) {
      element.textContent = initial;
    });
  }

  function renderDashboard() {
    renderSummary();
    renderRanking();
    renderChartLegend();
    drawChart();
    updateRelativeTime();
  }

  function renderSummary() {
    const onlineTowers = towers.filter(function countOnline(tower) {
      return tower.online;
    }).length;
    const offlineTowers = towers.length - onlineTowers;
    const tiltValues = towers.map(function getTilt(tower) {
      return tower.maxTilt;
    });
    const averageTilt = tiltValues.reduce(function sumTilt(total, value) {
      return total + value;
    }, 0) / tiltValues.length;
    const maximumTilt = Math.max.apply(null, tiltValues);
    const minimumTilt = Math.min.apply(null, tiltValues);
    const counts = getStatusCounts();
    const totalSensors = towers.reduce(function sumSensors(total, tower) {
      return total + tower.sensors;
    }, 0);
    const attentionSensors = counts.alert + counts.warning - 1;
    const normalSensors = totalSensors - attentionSensors;
    const availability = (onlineTowers / towers.length) * 100;
    const sensorNormalRate = (normalSensors / totalSensors) * 100;
    const health = clamp(
      Math.round(100 - offlineTowers * 3 - counts.warning * 0.5 - counts.alert * 2),
      0,
      100
    );
    const healthAngle = (health / 100) * 180;

    setText("totalTowerCount", towers.length);
    setText("onlineTowerCount", onlineTowers);
    setText("offlineTowerCount", offlineTowers);
    setText("averageInclination", averageTilt.toFixed(2));
    setText("maximumInclination", `${maximumTilt.toFixed(2)}°`);
    setText("minimumInclination", `${minimumTilt.toFixed(2)}°`);
    setText("activeSensorCount", totalSensors);
    setText("normalSensorCount", normalSensors);
    setText("alertSensorCount", attentionSensors);
    setText("systemHealthValue", health);
    setText("sidebarTowerCount", towers.length);
    setText("sidebarAlertCount", counts.alert + counts.warning);
    setText("notificationCount", counts.alert + counts.warning);
    setText("normalTowerCount", counts.normal);
    setText("warningTowerCount", counts.warning);
    setText("criticalTowerCount", counts.alert);
    setText("towerOnlinePercent", `${availability.toFixed(1)}% network availability`);
    setText("sensorNormalPercent", `${sensorNormalRate.toFixed(1)}% reporting normally`);

    document.getElementById("towerOnlineProgress").style.width = `${availability}%`;
    document.getElementById("sensorNormalProgress").style.width = `${sensorNormalRate}%`;
    document.getElementById("healthGauge").style.background =
      `conic-gradient(from 270deg, var(--success) 0deg ${healthAngle}deg, #e7edf2 ${healthAngle}deg 180deg, transparent 180deg 360deg)`;
    document.querySelector(".health-gauge").setAttribute("aria-label", `System health ${health} percent`);
    document.querySelector(".health-label").textContent = health >= 90 ? "Good" : "Attention";
    setText(
      "healthMessage",
      counts.alert ? "Monitoring services operational" : "All systems operational"
    );
    elements.notificationButton.setAttribute(
      "aria-label",
      `View ${counts.alert + counts.warning} active notifications`
    );
  }

  function renderRanking() {
    const sortedTowers = towers
      .slice()
      .sort(function sortByTilt(a, b) {
        return b.maxTilt - a.maxTilt;
      });

    elements.rankingCount.textContent = `${sortedTowers.length} ${sortedTowers.length === 1 ? "tower" : "towers"}`;

    elements.rankingBody.innerHTML = sortedTowers
      .map(function renderTowerRow(tower, index) {
        const status = getTowerStatus(tower);
        const rankClass = status === "alert" ? "rank-alert" : status === "warning" ? "rank-warning" : "";

        return `
          <tr>
            <td><span class="rank-number ${rankClass}">${index + 1}</span></td>
            <td>
              <span class="tower-cell">
                <strong>${tower.id}</strong>
                <span>${tower.location}${tower.online ? "" : " · Offline"}</span>
              </span>
            </td>
            <td><span class="tilt-cell">${tower.maxTilt.toFixed(2)}°</span></td>
            <td><span class="status-badge ${status}">${status}</span></td>
          </tr>
        `;
      })
      .join("");
  }

  function setRange(range) {
    if (!RANGE_DEFINITIONS[range] || state.range === range || state.loading) {
      return;
    }

    state.range = range;
    state.hoverIndex = null;
    clearChartHover();

    document.querySelectorAll("[data-range]").forEach(function updateRangeButton(button) {
      button.classList.toggle("is-active", button.dataset.range === range);
    });

    elements.dateRangeLabel.textContent = RANGE_DEFINITIONS[range].label;
    elements.analyticsPanel.classList.add("is-loading");

    window.setTimeout(function finishRangeChange() {
      state.trendData = createTrendData(range);
      renderChartLegend();
      drawChart();
      elements.analyticsPanel.classList.remove("is-loading");
    }, 320);
  }

  function setChartMode(mode) {
    if (!new Set(["trend", "distribution"]).has(mode) || state.chartMode === mode) {
      return;
    }

    state.chartMode = mode;
    state.hoverIndex = null;
    clearChartHover();

    document.querySelectorAll("[data-chart-mode]").forEach(function updateChartTab(button) {
      const isSelected = button.dataset.chartMode === mode;
      button.setAttribute("aria-selected", isSelected ? "true" : "false");
      button.setAttribute("tabindex", isSelected ? "0" : "-1");
    });

    const activeTab = document.querySelector(`[data-chart-mode="${mode}"]`);
    elements.chartSection.setAttribute("aria-labelledby", activeTab.id);
    elements.chartTitle.textContent = mode === "trend" ? "Inclination trend" : "Tilt angle distribution";
    elements.chartDescription.textContent = mode === "trend"
      ? "Maximum tilt angle by tower"
      : "Tower count grouped by inclination range";
    elements.chart.setAttribute(
      "aria-label",
      mode === "trend"
        ? "Line chart showing tower inclination over time"
        : "Bar chart showing the distribution of tower tilt angles"
    );

    elements.analyticsPanel.classList.add("is-loading");
    window.setTimeout(function finishChartModeChange() {
      renderChartLegend();
      drawChart();
      elements.analyticsPanel.classList.remove("is-loading");
    }, 250);
  }

  function refreshDashboard(options) {
    const settings = options || {};

    if (state.loading) {
      return;
    }

    state.loading = true;
    elements.analyticsPanel.classList.add("is-loading");
    elements.refreshButton.disabled = true;
    elements.refreshButton.classList.add("is-loading");

    window.setTimeout(function finishRefresh() {
      simulateLiveData();
      state.lastUpdatedAt = new Date();
      renderDashboard();
      elements.analyticsPanel.classList.remove("is-loading");
      elements.refreshButton.disabled = false;
      elements.refreshButton.classList.remove("is-loading");
      state.loading = false;

      if (!settings.automatic) {
        showToast("Monitoring data refreshed successfully.", "info");
      }
    }, settings.automatic ? 260 : 480);
  }

  function simulateLiveData() {
    towers.forEach(function updateTower(tower, index) {
      const movement = (Math.random() - 0.5) * (index < 3 ? 0.025 : 0.015);
      const minimum = index === 0 ? 1.12 : 0.18;
      const maximum = index === 0 ? 1.32 : 0.98;
      tower.maxTilt = clamp(tower.maxTilt + movement, minimum, maximum);
      tower.rssi = Math.round(clamp(tower.rssi + (Math.random() - 0.5) * 2, -105, -45));
    });

    if (state.range === "realtime" && state.trendData) {
      state.trendData.labels.shift();
      state.trendData.labels.push(formatTime(new Date()));
      state.trendData.datasets.forEach(function pushRealtimePoint(dataset, index) {
        dataset.values.shift();
        const tower = towers[index];
        dataset.values.push(clamp(tower.maxTilt * (0.76 + Math.random() * 0.12), 0.04, 1.38));
      });
    } else {
      state.trendData = createTrendData(state.range);
    }
  }

  function createTrendData(range) {
    const definition = RANGE_DEFINITIONS[range];
    const points = definition.points;
    const chartTowers = towers.slice(0, 6);

    return {
      labels: createRangeLabels(range, points),
      datasets: chartTowers.map(function createTowerDataset(tower, towerIndex) {
        const values = Array.from({ length: points }, function createPoint(_, pointIndex) {
          const wave = Math.sin((pointIndex + towerIndex * 1.7) / 2.9) * 0.055;
          const secondaryWave = Math.cos((pointIndex + towerIndex) / 5.2) * 0.025;
          const peakPosition = Math.round(points * (0.54 + towerIndex * 0.025));
          const peakDistance = Math.abs(pointIndex - peakPosition);
          const peak = Math.max(0, 1 - peakDistance / Math.max(2, points * 0.14));
          const peakStrength = towerIndex === 0 ? 0.22 : towerIndex === 1 ? 0.12 : 0.07;
          const deterministicNoise = seededNoise(towerIndex + 3, pointIndex) * 0.035;
          const base = tower.maxTilt * (0.72 + towerIndex * 0.008);

          return clamp(base + wave + secondaryWave + peak * peakStrength + deterministicNoise, 0.04, 1.38);
        });

        return {
          id: tower.id,
          color: TOWER_COLORS[towerIndex],
          values
        };
      })
    };
  }

  function createRangeLabels(range, points) {
    const now = new Date();

    return Array.from({ length: points }, function createLabel(_, index) {
      const offset = points - 1 - index;
      const date = new Date(now);

      if (range === "realtime") {
        date.setMinutes(now.getMinutes() - offset * 3);
        return formatTime(date);
      }

      if (range === "24h") {
        date.setHours(now.getHours() - offset);
        return `${String(date.getHours()).padStart(2, "0")}:00`;
      }

      if (range === "7d") {
        date.setHours(now.getHours() - offset * 6);
        return date.toLocaleDateString(undefined, { weekday: "short", hour: "2-digit" });
      }

      const dayStep = range === "30d" ? 1 : 14 / Math.max(1, points - 1);
      date.setTime(now.getTime() - offset * dayStep * 24 * 60 * 60 * 1000);
      return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    });
  }

  function renderChartLegend() {
    if (state.chartMode === "distribution") {
      const categories = getDistributionCategories();
      elements.chartLegend.innerHTML = categories
        .map(function renderDistributionLegend(category) {
          return `<span class="legend-item"><i style="background:${category.color}"></i>${category.label}: ${category.count}</span>`;
        })
        .join("");
      return;
    }

    elements.chartLegend.innerHTML = state.trendData.datasets
      .map(function renderLegendItem(dataset) {
        return `<span class="legend-item"><i style="background:${dataset.color}"></i>${dataset.id}</span>`;
      })
      .join("");
  }

  function drawChart() {
    const rect = elements.chart.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);

    elements.chart.width = Math.max(1, Math.floor(width * pixelRatio));
    elements.chart.height = Math.max(1, Math.floor(height * pixelRatio));
    chartContext = elements.chart.getContext("2d");
    chartContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    chartContext.clearRect(0, 0, width, height);

    if (state.chartMode === "distribution") {
      drawDistributionChart(width, height);
    } else {
      drawTrendChart(width, height);
    }
  }

  function drawTrendChart(width, height) {
    const context = chartContext;
    const padding = { left: 45, right: 16, top: 18, bottom: 31 };
    const chartWidth = Math.max(1, width - padding.left - padding.right);
    const chartHeight = Math.max(1, height - padding.top - padding.bottom);
    const maxY = 1.4;
    const labels = state.trendData.labels;
    const pointCount = labels.length;
    const yToPixel = function yToPixel(value) {
      return padding.top + ((maxY - value) / maxY) * chartHeight;
    };
    const xToPixel = function xToPixel(index) {
      return padding.left + (index / Math.max(1, pointCount - 1)) * chartWidth;
    };

    chartMetrics = { padding, chartWidth, chartHeight, xToPixel, yToPixel, pointCount };
    context.font = '10px Inter, "Segoe UI", sans-serif';
    context.textBaseline = "middle";

    [0, 0.35, 0.7, 1.05, 1.4].forEach(function drawGridLine(value) {
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

    const labelInterval = Math.max(1, Math.ceil(pointCount / 6));
    labels.forEach(function drawXAxisLabel(label, index) {
      if (index % labelInterval !== 0 && index !== pointCount - 1) {
        return;
      }

      context.fillStyle = "#8390a0";
      context.textAlign = index === pointCount - 1 ? "right" : index === 0 ? "left" : "center";
      context.fillText(label, xToPixel(index), height - 10);
    });

    const thresholdY = yToPixel(THRESHOLDS.alert);
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

    if (state.hoverIndex !== null) {
      const hoverX = xToPixel(state.hoverIndex);
      context.beginPath();
      context.strokeStyle = "rgba(74, 93, 116, 0.28)";
      context.lineWidth = 1;
      context.moveTo(hoverX, padding.top);
      context.lineTo(hoverX, height - padding.bottom);
      context.stroke();
    }

    state.trendData.datasets.forEach(function drawDataset(dataset) {
      context.save();
      context.beginPath();
      context.strokeStyle = dataset.color;
      context.lineWidth = 1.85;
      context.lineCap = "round";
      context.lineJoin = "round";

      dataset.values.forEach(function plotPoint(value, index) {
        const x = xToPixel(index);
        const y = yToPixel(value);
        if (index === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      });

      context.stroke();

      if (state.hoverIndex !== null) {
        const value = dataset.values[state.hoverIndex];
        const x = xToPixel(state.hoverIndex);
        const y = yToPixel(value);
        context.beginPath();
        context.fillStyle = "#fff";
        context.strokeStyle = dataset.color;
        context.lineWidth = 2;
        context.arc(x, y, 3.2, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }

      context.restore();
    });
  }

  function drawDistributionChart(width, height) {
    const context = chartContext;
    const padding = { left: 43, right: 18, top: 20, bottom: 42 };
    const chartWidth = Math.max(1, width - padding.left - padding.right);
    const chartHeight = Math.max(1, height - padding.top - padding.bottom);
    const categories = getDistributionCategories();
    const maxCount = Math.max.apply(null, categories.map(function getCount(item) {
      return item.count;
    }).concat([1]));

    chartMetrics = null;
    context.font = '10px Inter, "Segoe UI", sans-serif';
    context.textBaseline = "middle";

    for (let value = 0; value <= maxCount; value += 1) {
      const y = padding.top + ((maxCount - value) / maxCount) * chartHeight;
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

    categories.forEach(function drawBar(category, index) {
      const barHeight = (category.count / maxCount) * chartHeight;
      const x = padding.left + index * groupWidth + (groupWidth - barWidth) / 2;
      const y = padding.top + chartHeight - barHeight;

      context.fillStyle = category.color;
      roundRect(context, x, y, barWidth, barHeight, 7);
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

  function getDistributionCategories() {
    const categories = [
      { label: "Stable", shortLabel: "< 0.40°", color: "#18b77d", count: 0 },
      { label: "Normal", shortLabel: "0.40–0.69°", color: "#2478f3", count: 0 },
      { label: "Warning", shortLabel: "0.70–0.99°", color: "#f59e0b", count: 0 },
      { label: "Alert", shortLabel: "≥ 1.00°", color: "#ed3548", count: 0 }
    ];

    towers.forEach(function countTower(tower) {
      if (tower.maxTilt >= THRESHOLDS.alert) {
        categories[3].count += 1;
      } else if (tower.maxTilt >= THRESHOLDS.warning) {
        categories[2].count += 1;
      } else if (tower.maxTilt >= 0.4) {
        categories[1].count += 1;
      } else {
        categories[0].count += 1;
      }
    });

    return categories;
  }

  function handleChartPointerMove(event) {
    if (state.chartMode !== "trend" || !chartMetrics) {
      return;
    }

    const rect = elements.chart.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const relativeX = pointerX - chartMetrics.padding.left;

    if (relativeX < 0 || relativeX > chartMetrics.chartWidth) {
      clearChartHover();
      return;
    }

    const index = clamp(
      Math.round((relativeX / chartMetrics.chartWidth) * (chartMetrics.pointCount - 1)),
      0,
      chartMetrics.pointCount - 1
    );

    state.hoverIndex = index;
    drawChart();
    showChartTooltip(index, pointerX, event.clientY - rect.top);
  }

  function handleChartKeyboard(event) {
    if (state.chartMode !== "trend" || !state.trendData) {
      return;
    }

    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    const lastIndex = state.trendData.labels.length - 1;
    const currentIndex = state.hoverIndex === null ? lastIndex : state.hoverIndex;
    state.hoverIndex = clamp(currentIndex + (event.key === "ArrowRight" ? 1 : -1), 0, lastIndex);
    drawChart();

    const x = chartMetrics.xToPixel(state.hoverIndex);
    showChartTooltip(state.hoverIndex, x, 35);
  }

  function showChartTooltip(index, pointerX, pointerY) {
    const label = state.trendData.labels[index];
    const rows = state.trendData.datasets
      .map(function createTooltipRow(dataset) {
        return `<span><em><i style="background:${dataset.color}"></i>${dataset.id}</em><b>${dataset.values[index].toFixed(2)}°</b></span>`;
      })
      .join("");

    elements.chartTooltip.innerHTML = `<strong>${label}</strong>${rows}`;
    elements.chartTooltip.classList.add("is-visible");

    const containerWidth = elements.chart.parentElement.clientWidth;
    const tooltipWidth = 174;
    const left = pointerX + tooltipWidth + 18 > containerWidth
      ? pointerX - tooltipWidth - 12
      : pointerX + 12;
    const top = clamp(pointerY - 36, 8, Math.max(8, elements.chart.parentElement.clientHeight - 206));
    elements.chartTooltip.style.left = `${Math.max(6, left)}px`;
    elements.chartTooltip.style.top = `${top}px`;
  }

  function clearChartHover() {
    if (state.hoverIndex !== null) {
      state.hoverIndex = null;
      drawChart();
    }
    elements.chartTooltip.classList.remove("is-visible");
  }

  function updateRelativeTime() {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - state.lastUpdatedAt.getTime()) / 1000));
    let relativeText = "just now";

    if (elapsedSeconds >= 60) {
      const minutes = Math.floor(elapsedSeconds / 60);
      relativeText = `${minutes} min${minutes === 1 ? "" : "s"} ago`;
    } else if (elapsedSeconds >= 10) {
      relativeText = `${elapsedSeconds} sec ago`;
    }

    elements.lastUpdated.textContent = relativeText;
    elements.lastSyncHeader.textContent = relativeText.charAt(0).toUpperCase() + relativeText.slice(1);
  }

  function getTowerStatus(tower) {
    if (tower.maxTilt >= THRESHOLDS.alert) {
      return "alert";
    }
    if (tower.maxTilt >= THRESHOLDS.warning) {
      return "warning";
    }
    return "normal";
  }

  function getStatusCounts() {
    return towers.reduce(
      function countStatus(counts, tower) {
        counts[getTowerStatus(tower)] += 1;
        return counts;
      },
      { normal: 0, warning: 0, alert: 0 }
    );
  }

  function exportTowerData() {
    const headers = ["Tower ID", "Name", "Location", "Max Tilt (deg)", "Status", "Online", "Sensors", "RSSI", "Battery"];
    const rows = towers.map(function makeExportRow(tower) {
      return [
        tower.id,
        tower.name,
        tower.location,
        tower.maxTilt.toFixed(2),
        getTowerStatus(tower),
        tower.online ? "Yes" : "No",
        tower.sensors,
        tower.rssi,
        `${tower.battery}%`
      ];
    });
    const csv = [headers].concat(rows)
      .map(function formatCsvRow(row) {
        return row.map(function escapeCsvCell(value) {
          return `"${String(value).replace(/"/g, '""')}"`;
        }).join(",");
      })
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const downloadUrl = URL.createObjectURL(blob);
    const downloadLink = document.createElement("a");

    downloadLink.href = downloadUrl;
    downloadLink.download = `tower-monitoring-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    URL.revokeObjectURL(downloadUrl);
    showToast("Tower monitoring data exported as CSV.", "info");
  }

  function showToast(message, type) {
    window.clearTimeout(state.toastTimer);
    elements.toastMessage.textContent = message;
    elements.toast.classList.toggle("is-warning", type === "warning");
    elements.toast.classList.toggle("is-error", type === "error");
    elements.toast.classList.add("is-visible");

    state.toastTimer = window.setTimeout(function hideToast() {
      elements.toast.classList.remove("is-visible");
    }, 3600);
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) {
      element.textContent = value;
    }
  }

  function seededNoise(seed, index) {
    const value = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
    return (value - Math.floor(value)) - 0.5;
  }

  function formatTime(date) {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }

  function roundRect(context, x, y, width, height, radius) {
    const safeRadius = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
    context.beginPath();
    context.moveTo(x + safeRadius, y);
    context.arcTo(x + width, y, x + width, y + height, safeRadius);
    context.arcTo(x + width, y + height, x, y + height, safeRadius);
    context.arcTo(x, y + height, x, y, safeRadius);
    context.arcTo(x, y, x + width, y, safeRadius);
    context.closePath();
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  init();
})(window, document);
