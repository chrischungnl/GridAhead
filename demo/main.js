// GridAhead demo — fetches the public R2 JSON feed and renders a Chart.js
// line chart with a confidence band, day-divider rules, and cheap/peak
// markers drawn by two small custom Chart.js plugins.
//
// No framework, no build step. Use ?sample=1 to render synthesised data when
// developing locally (the R2 origin's CORS only allows the production host).

"use strict";

const DATA_BASE = "https://data.gridahead.chrischung.nl";
const OCTOPUS_BASE = "https://api.octopus.energy/v1";
const AGILE_PRODUCT_CODE = "AGILE-24-10-01";

const SYSTEM_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const REGIONS = {
  A: "Eastern England",
  B: "East Midlands",
  C: "London / South East",
  D: "Merseyside & North Wales",
  E: "West Midlands",
  F: "North Eastern England",
  G: "North Western England",
  H: "Southern England",
  J: "South Eastern England",
  K: "Southern Wales",
  L: "South Western England",
  M: "Yorkshire",
  N: "Southern Scotland",
  P: "Northern Scotland",
};

let chartInstance = null;
let allData = null;
const actualRateCache = new Map();   // regionCode → array of {valid_from, value_inc_vat}
let sampleActuals = null;            // populated in ?sample=1 mode; null otherwise
let currentOverlayRegion = null;     // guards stale overlay writes on fast region switching

/* ---------- helpers ---------- */

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function formatIssued(iso) {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) {
    const h = Math.round(mins / 60);
    return h === 1 ? "1 hour ago" : `${h} hours ago`;
  }
  const days = Math.round(mins / (60 * 24));
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function longUkDate(iso) {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}

function currentSlots(regionCode) {
  if (!allData) return [];
  const region = allData.regions[regionCode];
  if (!region) return [];
  const dates = region.dates || {};
  const out = [];
  for (const d of Object.keys(dates).sort()) {
    for (const s of dates[d].slots || []) {
      out.push({ ...s, _date: d });
    }
  }
  return out;
}

/* ---------- region select ---------- */

function populateRegionSelect() {
  const select = document.getElementById("region");
  select.innerHTML = "";
  for (const [code, name] of Object.entries(REGIONS)) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `${code} \u2014 ${name}`;
    if (code === "C") opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => renderRegion(select.value));
}

/* ---------- custom Chart.js plugins ---------- */

// Dashed vertical rule + italic day label at each date boundary.
const dayDividerPlugin = {
  id: "dayDivider",
  afterDatasetsDraw(chart, _, opts) {
    const metas = chart.$metas;
    if (!metas || !metas.length) return;
    const { ctx, chartArea, scales } = chart;

    ctx.save();
    let lastDate = null;
    metas.forEach((m, i) => {
      if (m._date === lastDate) return;

      const x = scales.x.getPixelForValue(i);

      if (lastDate !== null) {
        ctx.beginPath();
        ctx.setLineDash([2, 4]);
        ctx.strokeStyle = opts.ruleColor;
        ctx.lineWidth = 1;
        ctx.moveTo(x, chartArea.top + 4);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const day = new Date(m.from).toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "short",
        timeZone: "Europe/London",
      });

      ctx.fillStyle = opts.labelColor;
      ctx.font = `italic 500 12px ${SYSTEM_FONT}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const labelX = Math.min(
        lastDate === null ? chartArea.left + 6 : x + 6,
        chartArea.right - 130
      );
      ctx.fillText(day, labelX, chartArea.top - 16);

      lastDate = m._date;
    });
    ctx.restore();
  },
};

// Thin vertical crosshair that follows the cursor while hovering the chart.
// Distinct from the day-divider rules (those are dashed) — this one is solid
// and faint, so the reader can trace a specific half-hour to the x-axis.
const crosshairPlugin = {
  id: "crosshair",
  afterDatasetsDraw(chart, _, opts) {
    const tooltip = chart.tooltip;
    if (!tooltip || tooltip.opacity === 0) return;
    const active =
      (tooltip.getActiveElements && tooltip.getActiveElements()) ||
      tooltip._active ||
      [];
    if (!active.length) return;

    const x = active[0].element.x;
    const { ctx, chartArea } = chart;

    ctx.save();
    ctx.strokeStyle = opts.color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top + 4);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

// Halo + solid dot + small italic label at the min and max data points.
const extremesPlugin = {
  id: "extremes",
  afterDatasetsDraw(chart, _, opts) {
    const ds = chart.data.datasets.find((d) => d._isPrice);
    if (!ds) return;
    const data = ds.data;
    if (!data || data.length < 2) return;

    let minIdx = 0;
    let maxIdx = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] < data[minIdx]) minIdx = i;
      if (data[i] > data[maxIdx]) maxIdx = i;
    }

    const { ctx, scales, chartArea } = chart;
    const marks = [
      { idx: minIdx, color: opts.cheapColor, label: "cheap" },
      { idx: maxIdx, color: opts.peakColor, label: "peak" },
    ];

    ctx.save();
    for (const m of marks) {
      const x = scales.x.getPixelForValue(m.idx);
      const y = scales.y.getPixelForValue(data[m.idx]);

      // Halo ring
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.strokeStyle = m.color;
      ctx.globalAlpha = 0.38;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Solid dot
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(x, y, 3.25, 0, Math.PI * 2);
      ctx.fillStyle = m.color;
      ctx.fill();

      // Peak label sits above the dot, cheap label sits below.
      ctx.font = `italic 500 11px ${SYSTEM_FONT}`;
      ctx.fillStyle = m.color;
      ctx.textAlign = "center";
      if (m.label === "peak") {
        ctx.textBaseline = "bottom";
        ctx.fillText(m.label, x, y - 11);
      } else {
        ctx.textBaseline = "top";
        ctx.fillText(m.label, x, y + 11);
      }
    }
    ctx.restore();
  },
};

/* ---------- meta line ---------- */

function renderMeta(meta) {
  document.getElementById("meta").textContent =
    `Last updated ${formatIssued(meta.generated_at)}`;
}

/* ---------- actual Agile overlay ---------- */

// Fetch the real, published Octopus Agile unit rates for the selected region.
// Used to overlay "what actually happened" onto the forecast so readers can
// see the model's error bar directly. Cached per region for the session.
async function fetchActualAgilePrices(regionCode) {
  if (sampleActuals) {
    return sampleActuals.get(regionCode) || [];
  }

  const tariffCode = `E-1R-${AGILE_PRODUCT_CODE}-${regionCode}`;
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 4);

  const url =
    `${OCTOPUS_BASE}/products/${AGILE_PRODUCT_CODE}/electricity-tariffs/` +
    `${tariffCode}/standard-unit-rates/` +
    `?period_from=${encodeURIComponent(from.toISOString())}` +
    `&period_to=${encodeURIComponent(to.toISOString())}` +
    `&page_size=200`;

  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`octopus rates ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

// Align a list of Octopus unit-rate objects to the forecast slots by start
// timestamp. Returns an array the same length as `slots` with either the
// actual price or null (for uncovered half-hours).
function alignActualToSlots(slots, rates) {
  const byTime = new Map();
  for (const r of rates) {
    byTime.set(new Date(r.valid_from).getTime(), r.value_inc_vat);
  }
  return slots.map((s) => {
    const v = byTime.get(new Date(s.from).getTime());
    return v == null ? null : Math.round(v * 100) / 100;
  });
}

function setActualLegendVisible(visible) {
  const el = document.getElementById("legend-actual");
  if (el) el.hidden = !visible;
}

// Progressive enhancement: fetch the actual rates after the forecast chart
// has already rendered, then splice the overlay dataset in. If the fetch
// fails or there's nothing to show, the chart stays as it was.
async function loadActualOverlay(regionCode) {
  currentOverlayRegion = regionCode;
  try {
    let rates;
    if (actualRateCache.has(regionCode)) {
      rates = actualRateCache.get(regionCode);
    } else {
      rates = await fetchActualAgilePrices(regionCode);
      actualRateCache.set(regionCode, rates);
    }
    // Guard: user may have clicked a different region while fetch was in flight
    if (currentOverlayRegion !== regionCode) return;
    applyActualOverlay(rates);
  } catch (err) {
    console.warn("Actual Agile rates unavailable:", err);
    setActualLegendVisible(false);
  }
}

function applyActualOverlay(rates) {
  if (!chartInstance) return;
  const slots = chartInstance.$metas;
  if (!slots || !slots.length) return;

  const aligned = alignActualToSlots(slots, rates);
  const hasAny = aligned.some((v) => v != null);
  if (!hasAny) {
    setActualLegendVisible(false);
    // Remove any previous overlay dataset in case of region-switch back to one without data
    const idx = chartInstance.data.datasets.findIndex((d) => d._isActual);
    if (idx >= 0) {
      chartInstance.data.datasets.splice(idx, 1);
      chartInstance.update("none");
    }
    return;
  }

  const actualColor = cssVar("--actual");
  const card = cssVar("--card");

  const existing = chartInstance.data.datasets.find((d) => d._isActual);
  if (existing) {
    existing.data = aligned;
    existing.borderColor = actualColor;
    existing.pointHoverBorderColor = card;
  } else {
    chartInstance.data.datasets.push({
      label: "Actual",
      data: aligned,
      borderColor: actualColor,
      backgroundColor: actualColor,
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBorderWidth: 2,
      pointHoverBorderColor: card,
      fill: false,
      tension: 0.28,
      spanGaps: false,
      _isActual: true,
    });
  }

  setActualLegendVisible(true);
  chartInstance.update("none");
}

/* ---------- chart + summary ---------- */

function renderRegion(regionCode) {
  if (!allData) return;
  const slots = currentSlots(regionCode);
  if (!slots.length) return;

  const labels = slots.map((s) =>
    new Date(s.from).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/London",
    })
  );
  const prices = slots.map((s) => s.pence_inc_vat);
  const lows = slots.map((s) => (s.low != null ? s.low : null));
  const highs = slots.map((s) => (s.high != null ? s.high : null));

  // Read palette from CSS custom properties so theme switches just work
  const accent = cssVar("--accent");
  const band = cssVar("--accent-band");
  const text = cssVar("--text");
  const muted = cssVar("--muted");
  const border = cssVar("--border");
  const card = cssVar("--card");
  const cheap = cssVar("--cheap");
  const peak = cssVar("--peak");

  Chart.defaults.font.family = SYSTEM_FONT;
  Chart.defaults.font.size = 12;
  Chart.defaults.color = muted;

  if (chartInstance) chartInstance.destroy();

  const ctx = document.getElementById("chart").getContext("2d");

  chartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "upper",
          data: highs,
          borderColor: "transparent",
          backgroundColor: band,
          borderWidth: 0,
          pointRadius: 0,
          fill: "+1",
          tension: 0.3,
        },
        {
          label: "lower",
          data: lows,
          borderColor: "transparent",
          backgroundColor: band,
          borderWidth: 0,
          pointRadius: 0,
          fill: false,
          tension: 0.3,
        },
        {
          label: "Predicted unit rate",
          data: prices,
          borderColor: accent,
          backgroundColor: accent,
          borderWidth: 1.75,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBorderWidth: 2,
          pointHoverBorderColor: card,
          fill: false,
          tension: 0.28,
          _isPrice: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 26, bottom: 4, left: 4, right: 4 } },
      interaction: { intersect: false, mode: "index" },
      animation: prefersReducedMotion() ? false : { duration: 500, easing: "easeOutQuart" },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: card,
          titleColor: text,
          bodyColor: text,
          borderColor: border,
          borderWidth: 1,
          cornerRadius: 0,
          padding: { top: 10, right: 14, bottom: 10, left: 14 },
          displayColors: false,
          titleFont: { family: SYSTEM_FONT, weight: "600", size: 12 },
          bodyFont: { family: SYSTEM_FONT, weight: "500", size: 12 },
          titleMarginBottom: 6,
          filter: (item) => item.dataset._isPrice || item.dataset._isActual,
          itemSort: (a, b) => {
            // Show "actual" first so it reads as ground truth at the top
            const weight = (d) => (d.dataset._isActual ? 0 : 1);
            return weight(a) - weight(b);
          },
          callbacks: {
            title: (items) => {
              if (!items.length) return "";
              const s = slots[items[0].dataIndex];
              if (!s) return "";
              return longUkDate(s.from);
            },
            label: (item) => {
              const s = slots[item.dataIndex];
              if (!s) return "";
              if (item.dataset._isActual) {
                const v = item.parsed.y;
                if (v == null) return "";
                return `actual    ${v.toFixed(2)} p/kWh`;
              }
              if (item.dataset._isPrice) {
                const lines = [`forecast  ${s.pence_inc_vat.toFixed(2)} p/kWh`];
                if (s.low != null && s.high != null) {
                  lines.push(`band      ${s.low.toFixed(1)}\u2013${s.high.toFixed(1)} p`);
                }
                return lines;
              }
              return "";
            },
          },
        },
        dayDivider: {
          ruleColor: muted,
          labelColor: muted,
        },
        extremes: {
          cheapColor: cheap,
          peakColor: peak,
        },
        crosshair: {
          color: accent,
        },
      },
      scales: {
        x: {
          ticks: {
            color: muted,
            maxRotation: 0,
            autoSkip: true,
            autoSkipPadding: 28,
            font: { family: SYSTEM_FONT, size: 11 },
            callback(value) {
              const lbl = this.getLabelForValue(value);
              if (lbl && lbl.endsWith(":00")) return lbl;
              return "";
            },
          },
          grid: { display: false },
          border: { color: border },
        },
        y: {
          ticks: {
            color: muted,
            font: { family: SYSTEM_FONT, size: 11 },
            padding: 8,
            callback: (v) => `${Math.round(v)} p`,
          },
          grid: { color: border, drawTicks: false },
          border: { display: false },
        },
      },
    },
    plugins: [dayDividerPlugin, extremesPlugin, crosshairPlugin],
  });

  chartInstance.$metas = slots;
  chartInstance.draw();

  renderSummary(regionCode, slots);

  // Progressive enhancement: overlay the real published Agile rates for the
  // portion of the forecast period where they already exist. Async, non-blocking.
  setActualLegendVisible(false);
  loadActualOverlay(regionCode);
}

let summaryBuilt = false;
const lastStats = { avg: null, min: null, max: null };

function buildSummarySkeleton(el) {
  el.innerHTML = `
    <h3 id="summary-title">&nbsp;</h3>
    <div class="stats">
      <div class="stat"><span class="label">Average</span><span class="value" id="stat-avg">&mdash;</span></div>
      <div class="stat"><span class="label">Minimum</span><span class="value" id="stat-min">&mdash;</span></div>
      <div class="stat"><span class="label">Maximum</span><span class="value" id="stat-max">&mdash;</span></div>
    </div>
    <p class="highlights" id="summary-highlights">&nbsp;</p>
  `;
  summaryBuilt = true;
}

function animateStat(id, from, to) {
  const el = document.getElementById(id);
  if (!el) return;
  const fmt = (v) => `${v.toFixed(1)}\u2009p`;

  if (from == null || from === to || prefersReducedMotion()) {
    el.textContent = fmt(to);
    return;
  }

  const duration = 420;
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 4); // ease-out-quart
    el.textContent = fmt(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function renderSummary(regionCode, slots) {
  const el = document.getElementById("summary");
  if (!slots.length) {
    el.innerHTML = "<p>No predictions available for this region yet.</p>";
    summaryBuilt = false;
    lastStats.avg = lastStats.min = lastStats.max = null;
    return;
  }

  if (!summaryBuilt) buildSummarySkeleton(el);

  const prices = slots.map((s) => s.pence_inc_vat);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const min = Math.min(...prices);
  const max = Math.max(...prices);

  const cheapest = slots.reduce((a, b) => (a.pence_inc_vat < b.pence_inc_vat ? a : b));
  const peakSlot = slots.reduce((a, b) => (a.pence_inc_vat > b.pence_inc_vat ? a : b));

  document.getElementById("summary-title").innerHTML =
    `Next three days &mdash; region ${regionCode}`;

  animateStat("stat-avg", lastStats.avg, avg);
  animateStat("stat-min", lastStats.min, min);
  animateStat("stat-max", lastStats.max, max);
  lastStats.avg = avg;
  lastStats.min = min;
  lastStats.max = max;

  document.getElementById("summary-highlights").innerHTML = `
    Cheapest half-hour: <strong>${longUkDate(cheapest.from)}</strong> at
    <strong>${cheapest.pence_inc_vat.toFixed(2)}&thinsp;p/kWh</strong>.<br>
    Most expensive: <strong>${longUkDate(peakSlot.from)}</strong> at
    <strong>${peakSlot.pence_inc_vat.toFixed(2)}&thinsp;p/kWh</strong>.
  `;
}

/* ---------- load ---------- */

// Dev-only: ?sample=1 renders synthesised data so the layout can be reviewed
// locally without hitting the live R2 origin (whose CORS allows only the
// production host). In production this branch never runs.
function synthesiseSample() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  // Build fake "actual" rates alongside the forecast — cover today + 36 slots
  // of tomorrow so the overlay visibly stops partway through the chart.
  sampleActuals = new Map();

  const regions = {};
  for (const [code, name] of Object.entries(REGIONS)) {
    const mult =
      code === "P" ? 1.237 :
      code === "L" ? 1.173 :
      code === "D" ? 1.124 :
      code === "J" || code === "K" ? 1.118 :
      code === "A" || code === "N" ? 1.064 :
      code === "C" ? 1.000 : 1.059;

    const dates = {};
    const actualRates = [];
    for (let day = 0; day < 3; day++) {
      const dayStart = new Date(startOfDay);
      dayStart.setDate(startOfDay.getDate() + day);
      const ymd = dayStart.toISOString().slice(0, 10);
      const slots = [];
      for (let i = 0; i < 48; i++) {
        const from = new Date(dayStart.getTime() + i * 30 * 60 * 1000);
        const to = new Date(from.getTime() + 30 * 60 * 1000);
        const h = i / 2;

        let p = 14 + 7 * Math.sin(((h - 9) * Math.PI) / 12);
        if (h >= 16.5 && h <= 19.5) p += 9 + Math.sin(((h - 18) * Math.PI) / 2) * 3;
        if (h >= 2 && h <= 5) p -= 6;
        p *= mult;
        if (day === 1 && i === 6) p -= 4;
        if (day === 2 && i === 37) p += 6;
        p += (Math.pow(Math.sin(i * 1.7 + day * 3.1), 2) - 0.5) * 2.2;
        p = Math.max(1.8, p);

        slots.push({
          from: from.toISOString(),
          to: to.toISOString(),
          pence_inc_vat: Math.round(p * 100) / 100,
          low: Math.round((p - 3.6) * 100) / 100,
          high: Math.round((p + 5.1) * 100) / 100,
        });

        // Fake "actual": forecast ± ~1.5p noise. Cover all of day 0 and
        // first 36 half-hours of day 1 (simulates published-through-~18:00).
        if (day === 0 || (day === 1 && i < 36)) {
          const noise = (Math.sin(i * 2.13 + day * 5.7) + Math.sin(i * 0.7 + day)) * 0.9;
          actualRates.push({
            valid_from: from.toISOString(),
            valid_to: to.toISOString(),
            value_inc_vat: Math.max(0.5, Math.round((p + noise) * 100) / 100),
          });
        }
      }
      dates[ymd] = { slots };
    }
    regions[code] = { region: { code, name, multiplier: mult }, dates };
    sampleActuals.set(code, actualRates);
  }

  const now = new Date().toISOString();
  return {
    meta: {
      generated_at: now,
      model: {
        type: "GradientBoostingRegressor",
        cv_r_squared: 0.88,
        cv_mae_pence: 1.9,
      },
    },
    latest: { generated_at: now, regions },
  };
}

async function loadData() {
  const useSample = new URL(window.location.href).searchParams.has("sample");

  if (useSample) {
    const { meta, latest } = synthesiseSample();
    allData = latest;
    renderMeta(meta);
    populateRegionSelect();
    renderRegion(document.getElementById("region").value);
    return;
  }

  try {
    const [meta, latest] = await Promise.all([
      fetch(`${DATA_BASE}/predictions/meta.json`, { cache: "no-cache" }).then((r) => {
        if (!r.ok) throw new Error(`meta ${r.status}`);
        return r.json();
      }),
      fetch(`${DATA_BASE}/predictions/latest.json`, { cache: "no-cache" }).then((r) => {
        if (!r.ok) throw new Error(`latest ${r.status}`);
        return r.json();
      }),
    ]);
    allData = latest;
    renderMeta(meta);
    populateRegionSelect();
    renderRegion(document.getElementById("region").value);
  } catch (err) {
    console.error("Failed to load GridAhead data", err);
    document.getElementById("meta").textContent =
      "Failed to load data \u2014 please try again in a few minutes.";
  }
}

// Re-render on colour scheme change so chart colours stay in sync
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  const select = document.getElementById("region");
  if (allData && select && select.value) renderRegion(select.value);
});

loadData();
