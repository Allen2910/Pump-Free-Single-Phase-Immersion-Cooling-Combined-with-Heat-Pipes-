const state = {
    readings: [],
    latestMetrics: null,
    fanRequestTimer: null,
    fanRequestSequence: 0,
    fanRequestPending: false,
    fanEnabled: true,
    fanSpeedSetting: 50,
};

const elements = {
    canvas: document.querySelector("#temperatureChart"),
    tooltip: document.querySelector("#chartTooltip"),
    sourceStatus: document.querySelector("#sourceStatus"),
    sourceLabel: document.querySelector("#sourceLabel"),
    temperature: document.querySelector("#temperatureValue"),
    maxTemp: document.querySelector("#maxTemp"),
    avgTemp: document.querySelector("#avgTemp"),
    pue: document.querySelector("#pueValue"),
    pueGauge: document.querySelector("#pueGauge"),
    internalFan: document.querySelector("#internalFan"),
    externalFan: document.querySelector("#externalFan"),
    internalFanBar: document.querySelector("#internalFanBar"),
    externalFanBar: document.querySelector("#externalFanBar"),
    chipPower: document.querySelector("#chipPower"),
    fanPower: document.querySelector("#fanPower"),
    clock: document.querySelector("#clock"),
    downloadCsv: document.querySelector("#downloadCsv"),
    fanSpeed: document.querySelector("#fanSpeed"),
    fanSpeedValue: document.querySelector("#fanSpeedValue"),
    fanControlStatus: document.querySelector("#fanControlStatus"),
    fanToggle: document.querySelector("#fanToggle"),
    fanToggleLabel: document.querySelector("#fanToggleLabel"),
    externalFanIcon: document.querySelector(".fan-icon-alt"),
};

function showFanSetting(speed) {
    const value = Math.round(Number(speed));
    state.fanSpeedSetting = value;
    elements.fanSpeed.value = value;
    elements.fanSpeedValue.textContent = `${value}%`;
}

function showExternalFanDuty(speed) {
    const value = Math.round(Number(speed));
    const fanPower = 14.8 * value / 100 + 0.48;
    const pue = (100 + fanPower) / 100;
    elements.externalFan.textContent = value;
    elements.externalFanBar.style.width = `${value}%`;
    elements.fanPower.textContent = fanPower.toFixed(1);
    elements.pue.textContent = pue.toFixed(2);
    elements.pueGauge.setAttribute("aria-label", `PUE ${pue.toFixed(2)}`);
    elements.externalFanIcon.classList.toggle("is-stopped", value === 0);
    elements.externalFanIcon.style.setProperty(
        "--fan-spin-duration",
        `${Math.max(0.55, 4.8 - value * 0.04)}s`,
    );
}

function showFanEnabled(enabled) {
    state.fanEnabled = enabled;
    elements.fanToggle.classList.toggle("is-on", enabled);
    elements.fanToggle.setAttribute("aria-checked", String(enabled));
    elements.fanToggleLabel.textContent = enabled ? "運轉中" : "已關閉";
}

function syncFanControl(data) {
    const speed = Number(data.speed ?? data.fan_speed_setting ?? 50);
    const enabled = Boolean(data.enabled ?? data.fan_enabled);
    const effectiveSpeed = Number(
        data.effective_speed ?? data.external_fan_duty ?? (enabled ? speed : 0),
    );

    showFanSetting(speed);
    showFanEnabled(enabled);
    showExternalFanDuty(effectiveSpeed);
}

async function sendFanControl(payload) {
    const sequence = ++state.fanRequestSequence;
    state.fanRequestPending = true;
    elements.fanControlStatus.textContent = "正在套用模擬控制…";
    elements.fanControlStatus.className = "fan-control-status is-pending";

    await new Promise((resolve) => setTimeout(resolve, 140));
    if (sequence !== state.fanRequestSequence) return;

    if (typeof payload.speed === "number") {
        state.fanSpeedSetting = Math.round(payload.speed);
    }
    if (typeof payload.enabled === "boolean") {
        state.fanEnabled = payload.enabled;
    }

    const data = {
        speed: state.fanSpeedSetting,
        enabled: state.fanEnabled,
        effective_speed: state.fanEnabled ? state.fanSpeedSetting : 0,
    };
    state.fanRequestPending = false;
    syncFanControl(data);
    elements.fanControlStatus.textContent = data.enabled
        ? `展示模式：模擬 PWM ${data.speed}%`
        : `展示模式：風扇已關閉，保留 ${data.speed}%`;
    elements.fanControlStatus.className = "fan-control-status is-ok";
}

function handleFanSlider() {
    const speed = Number(elements.fanSpeed.value);
    showFanSetting(speed);
    if (state.fanEnabled) showExternalFanDuty(speed);
    clearTimeout(state.fanRequestTimer);
    state.fanRequestTimer = setTimeout(() => {
        state.fanRequestTimer = null;
        sendFanControl({ speed });
    }, 180);
}

function handleFanToggle() {
    clearTimeout(state.fanRequestTimer);
    state.fanRequestTimer = null;
    sendFanControl({ enabled: !state.fanEnabled });
}

function formatClock(date) {
    return new Intl.DateTimeFormat("zh-TW", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).format(date);
}

function updateClock() {
    elements.clock.textContent = formatClock(new Date());
}

function updateMetricDisplay(data) {
    state.latestMetrics = data;
    const temperature = data.temperature_live
        ? Number(data.temperature)
        : state.readings.at(-1)?.temperature;

    if (Number.isFinite(temperature)) {
        elements.temperature.textContent = temperature.toFixed(1);
    }

    elements.pue.textContent = Number(data.pue).toFixed(2);
    elements.pueGauge.setAttribute("aria-label", `PUE ${Number(data.pue).toFixed(2)}`);
    elements.internalFan.textContent = Math.round(data.internal_fan_duty);
    elements.internalFanBar.style.width = `${data.internal_fan_duty}%`;
    showExternalFanDuty(data.external_fan_duty);
    elements.chipPower.textContent = Number(data.chip_power_w).toFixed(1);
    elements.fanPower.textContent = Number(data.fan_power_w).toFixed(1);

    elements.sourceStatus.classList.toggle("is-live", data.temperature_live);
    elements.sourceLabel.textContent = data.demo_mode
        ? "STATIC DEMO"
        : data.temperature_live
            ? "TEMP LIVE · METRICS DEMO"
            : "DEMO DATA";

    if (!state.fanRequestPending && state.fanRequestTimer === null) {
        syncFanControl(data);
        if (data.demo_mode) {
            elements.fanControlStatus.textContent = data.fan_enabled
                ? `展示模式 · 模擬 PWM ${data.fan_speed_setting}%`
                : `展示模式 · 風扇已關閉，保留 ${data.fan_speed_setting}%`;
            elements.fanControlStatus.className = "fan-control-status is-ok";
        } else if (data.fan_control_connected) {
            const address = data.fan_control_address
                ? ` · ${data.fan_control_address.replace(/^https?:\/\//, "")}`
                : "";
            elements.fanControlStatus.textContent = data.fan_enabled
                ? `Wi-Fi 已連線${address} · PWM ${data.fan_speed_setting}%`
                : `Wi-Fi 已連線${address} · 風扇已關閉，保留 ${data.fan_speed_setting}%`;
            elements.fanControlStatus.className = "fan-control-status is-ok";
        } else {
            elements.fanControlStatus.textContent =
                "區域網路內找不到 ESP32，請確認兩台裝置連接相同 Wi-Fi";
            elements.fanControlStatus.className = "fan-control-status is-error";
        }
    }
}

function addTemperature(temperature, timestamp, source) {
    const last = state.readings.at(-1);
    const isSameTimestamp = last && last.timestamp.getTime() === timestamp.getTime();

    if (!isSameTimestamp) {
        state.readings.push({ temperature, timestamp, source });
        state.readings = state.readings.slice(-31);
    }

    updateChartStats();
    drawChart();
}

function updateChartStats() {
    const values = state.readings.map((item) => item.temperature);
    if (!values.length) return;

    const maximum = Math.max(...values);
    const average = values.reduce((total, value) => total + value, 0) / values.length;
    elements.maxTemp.textContent = `${maximum.toFixed(1)}°`;
    elements.avgTemp.textContent = `${average.toFixed(1)}°`;
}

async function fetchStatus() {
    const now = new Date();
    const seconds = now.getTime() / 1000;
    const temperature = 37.5
        + Math.sin(seconds / 10) * 1.7
        + Math.sin(seconds / 3.2) * 0.35;
    const effectiveSpeed = state.fanEnabled ? state.fanSpeedSetting : 0;
    const fanPower = 14.8 * effectiveSpeed / 100 + 0.48;
    const data = {
        demo_mode: true,
        temperature,
        temperature_live: true,
        timestamp: now.toISOString(),
        pue: (100 + fanPower) / 100,
        internal_fan_duty: 100,
        external_fan_duty: effectiveSpeed,
        fan_speed_setting: state.fanSpeedSetting,
        fan_enabled: state.fanEnabled,
        chip_power_w: 100,
        fan_power_w: fanPower,
        fan_control_connected: true,
        fan_control_address: "static-demo",
    };

    updateMetricDisplay(data);
    if (data.temperature_live) {
        addTemperature(Number(data.temperature), now, "DEMO");
    }
}

function chartGeometry() {
    const canvas = elements.canvas;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
    }

    const width = rect.width;
    const height = rect.height;
    const padding = { top: 18, right: 16, bottom: 28, left: 40 };
    return { canvas, rect, dpr, width, height, padding };
}

function drawChart() {
    if (!state.readings.length) return;

    const { canvas, dpr, width, height, padding } = chartGeometry();
    const context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const values = state.readings.map((item) => item.temperature);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const minValue = Math.floor(rawMin - 1.5);
    const maxValue = Math.ceil(rawMax + 1.5);
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;

    const xAt = (index) => padding.left + (index / 30) * plotWidth;
    const yAt = (value) =>
        padding.top + ((maxValue - value) / Math.max(maxValue - minValue, 1)) * plotHeight;

    context.lineWidth = 1;
    context.font = "9px Inter, sans-serif";
    context.textAlign = "right";
    context.textBaseline = "middle";

    for (let row = 0; row <= 4; row += 1) {
        const y = padding.top + (plotHeight / 4) * row;
        const label = maxValue - ((maxValue - minValue) / 4) * row;
        context.strokeStyle = "rgba(110, 193, 216, 0.10)";
        context.beginPath();
        context.moveTo(padding.left, y);
        context.lineTo(width - padding.right, y);
        context.stroke();
        context.fillStyle = "rgba(153, 176, 193, 0.52)";
        context.fillText(`${label.toFixed(0)}°`, padding.left - 9, y);
    }

    for (let column = 0; column <= 5; column += 1) {
        const x = padding.left + (plotWidth / 5) * column;
        context.strokeStyle = "rgba(110, 193, 216, 0.06)";
        context.beginPath();
        context.moveTo(x, padding.top);
        context.lineTo(x, height - padding.bottom);
        context.stroke();

        const readingIndex = Math.round(30 * (column / 5));
        const reading = state.readings[readingIndex];
        context.textAlign = "center";
        context.textBaseline = "top";
        context.fillStyle = "rgba(153, 176, 193, 0.44)";
        if (reading) {
            context.fillText(formatClock(reading.timestamp).slice(0, 5), x, height - padding.bottom + 10);
        }
    }

    const gradient = context.createLinearGradient(0, padding.top, 0, height - padding.bottom);
    gradient.addColorStop(0, "rgba(80, 230, 255, 0.30)");
    gradient.addColorStop(0.7, "rgba(80, 230, 255, 0.035)");
    gradient.addColorStop(1, "rgba(80, 230, 255, 0)");

    context.beginPath();
    state.readings.forEach((reading, index) => {
        const x = xAt(index);
        const y = yAt(reading.temperature);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
    });
    context.lineTo(xAt(state.readings.length - 1), height - padding.bottom);
    context.lineTo(xAt(0), height - padding.bottom);
    context.closePath();
    context.fillStyle = gradient;
    context.fill();

    context.beginPath();
    state.readings.forEach((reading, index) => {
        const x = xAt(index);
        const y = yAt(reading.temperature);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
    });
    context.strokeStyle = "#50e6ff";
    context.lineWidth = 2;
    context.shadowColor = "rgba(80, 230, 255, 0.7)";
    context.shadowBlur = 12;
    context.stroke();
    context.shadowBlur = 0;

    const lastIndex = state.readings.length - 1;
    context.beginPath();
    context.arc(xAt(lastIndex), yAt(values[lastIndex]), 4, 0, Math.PI * 2);
    context.fillStyle = "#b8ff3d";
    context.shadowColor = "#b8ff3d";
    context.shadowBlur = 12;
    context.fill();
    context.shadowBlur = 0;

    state.chartMap = { xAt, yAt, padding, width, height };
}

function handleChartPointer(event) {
    if (!state.chartMap || !state.readings.length) return;

    const rect = elements.canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const { padding, width } = state.chartMap;
    const usableWidth = width - padding.left - padding.right;
    const ratio = Math.min(1, Math.max(0, (pointerX - padding.left) / usableWidth));
    const index = Math.round(ratio * (state.readings.length - 1));
    const reading = state.readings[index];

    elements.tooltip.hidden = false;
    elements.tooltip.style.left = `${state.chartMap.xAt(index)}px`;
    elements.tooltip.style.top = `${state.chartMap.yAt(reading.temperature)}px`;
    elements.tooltip.innerHTML = `${reading.temperature.toFixed(1)}°C<br>${formatClock(reading.timestamp)}`;
}

function downloadCsv() {
    const headers = ["timestamp", "temperature_c", "source", "pue", "internal_fan_duty_pct", "external_fan_duty_pct", "chip_power_w", "fan_power_w"];
    const metrics = state.latestMetrics || {};
    const rows = state.readings.map((reading) => [
        reading.timestamp.toISOString(),
        reading.temperature.toFixed(2),
        reading.source,
        metrics.pue ?? "",
        metrics.internal_fan_duty ?? "",
        metrics.external_fan_duty ?? "",
        metrics.chip_power_w ?? "",
        metrics.fan_power_w ?? "",
    ]);

    const csv = [headers, ...rows]
        .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
        .join("\r\n");
    const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `thermal-monitor-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
}

updateChartStats();
drawChart();
updateClock();
fetchStatus();

setInterval(updateClock, 1000);
setInterval(fetchStatus, 2000);
window.addEventListener("resize", drawChart);
elements.canvas.addEventListener("pointermove", handleChartPointer);
elements.canvas.addEventListener("pointerleave", () => {
    elements.tooltip.hidden = true;
});
elements.downloadCsv.addEventListener("click", downloadCsv);
elements.fanSpeed.addEventListener("input", handleFanSlider);
elements.fanToggle.addEventListener("click", handleFanToggle);
