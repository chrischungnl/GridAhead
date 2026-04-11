// GridAhead demo — fetches static JSON from the R2 public bucket and renders
// a Chart.js line chart with low/high confidence band for the selected region.
//
// The entire page is a single HTTPS GET of two JSON files and a Chart.js
// render. There is no backend, no build step, no framework.

"use strict";

const DATA_BASE = "https://data.gridahead.chrischung.nl";

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

function populateRegions() {
  const select = document.getElementById("region");
  for (const [code, name] of Object.entries(REGIONS)) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `${code} — ${name}`;
    if (code === "C") opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => renderRegion(select.value));
}

function renderMeta(meta) {
  const el = document.getElementById("meta");
  const updated = new Date(meta.generated_at);
  const mins = Math.max(0, Math.round((Date.now() - updated.getTime()) / 60000));
  const when = mins < 60
    ? `${mins} min ago`
    : `${Math.round(mins / 60)} h ago`;
  el.textContent = `Last updated ${when} · Model: ${meta.model.type} · CV R² ${meta.model.cv_r_squared} · MAE ${meta.model.cv_mae_pence}p`;
}

function renderRegion(regionCode) {
  if (!allData) return;
  const region = allData.regions[regionCode];
  if (!region) return;

  const labels = [];
  const prices = [];
  const lows = [];
  const highs = [];

  const sortedDates = Object.keys(region.dates).sort();
  for (const dateStr of sortedDates) {
    const slots = region.dates[dateStr].slots || [];
    for (const slot of slots) {
      const t = new Date(slot.from);
      labels.push(t.toLocaleString("en-GB", {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/London",
      }));
      prices.push(slot.pence_inc_vat);
      lows.push(slot.low ?? null);
      highs.push(slot.high ?? null);
    }
  }

  if (chartInstance) chartInstance.destroy();

  const ctx = document.getElementById("chart").getContext("2d");
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const gridColor = isDark ? "rgba(148, 163, 184, 0.15)" : "rgba(100, 116, 139, 0.15)";
  const textColor = isDark ? "#cbd5e1" : "#334155";
  const accent = isDark ? "#60a5fa" : "#2563eb";
  const accentFaint = isDark ? "rgba(96, 165, 250, 0.15)" : "rgba(37, 99, 235, 0.12)";

  chartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "90th percentile",
          data: highs,
          borderColor: accentFaint,
          backgroundColor: accentFaint,
          borderWidth: 0,
          pointRadius: 0,
          fill: "+1",
          tension: 0.25,
        },
        {
          label: "10th percentile",
          data: lows,
          borderColor: accentFaint,
          backgroundColor: accentFaint,
          borderWidth: 0,
          pointRadius: 0,
          fill: false,
          tension: 0.25,
        },
        {
          label: "Predicted (p/kWh inc. VAT)",
          data: prices,
          borderColor: accent,
          backgroundColor: accent,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          fill: false,
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        title: {
          display: true,
          text: `Region ${regionCode} — ${REGIONS[regionCode]}`,
          color: textColor,
          font: { size: 14, weight: "600" },
        },
        legend: {
          position: "top",
          labels: {
            color: textColor,
            filter: (item) => item.text.startsWith("Predicted"),
          },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1) ?? "—"} p`,
          },
        },
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 12, color: textColor },
          grid: { color: gridColor },
        },
        y: {
          title: {
            display: true,
            text: "Pence / kWh (inc. VAT)",
            color: textColor,
          },
          ticks: { color: textColor },
          grid: { color: gridColor },
        },
      },
    },
  });

  renderSummary(regionCode, region);
}

function renderSummary(regionCode, region) {
  const el = document.getElementById("summary");
  const allSlots = Object.values(region.dates).flatMap((d) => d.slots || []);

  if (allSlots.length === 0) {
    el.innerHTML = "<p>No predictions available for this region yet.</p>";
    return;
  }

  const prices = allSlots.map((s) => s.pence_inc_vat);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const min = Math.min(...prices);
  const max = Math.max(...prices);

  const cheapest = allSlots.reduce((a, b) =>
    a.pence_inc_vat < b.pence_inc_vat ? a : b
  );
  const mostExpensive = allSlots.reduce((a, b) =>
    a.pence_inc_vat > b.pence_inc_vat ? a : b
  );

  const fmt = (iso) =>
    new Date(iso).toLocaleString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/London",
    });

  el.innerHTML = `
    <h3>Next 3 days &mdash; region ${regionCode}</h3>
    <div class="stats">
      <div class="stat"><span class="label">Average</span><span class="value">${avg.toFixed(1)} p</span></div>
      <div class="stat"><span class="label">Min</span><span class="value">${min.toFixed(1)} p</span></div>
      <div class="stat"><span class="label">Max</span><span class="value">${max.toFixed(1)} p</span></div>
      <div class="stat"><span class="label">Slots</span><span class="value">${allSlots.length}</span></div>
    </div>
    <p class="highlights">
      Cheapest half-hour: <strong>${fmt(cheapest.from)}</strong> at
      <strong>${cheapest.pence_inc_vat.toFixed(1)} p/kWh</strong>.<br>
      Most expensive: <strong>${fmt(mostExpensive.from)}</strong> at
      <strong>${mostExpensive.pence_inc_vat.toFixed(1)} p/kWh</strong>.
    </p>
  `;
}

async function loadData() {
  try {
    const [meta, latest] = await Promise.all([
      fetch(`${DATA_BASE}/predictions/meta.json`).then((r) => {
        if (!r.ok) throw new Error(`meta.json HTTP ${r.status}`);
        return r.json();
      }),
      fetch(`${DATA_BASE}/predictions/latest.json`).then((r) => {
        if (!r.ok) throw new Error(`latest.json HTTP ${r.status}`);
        return r.json();
      }),
    ]);
    allData = latest;
    renderMeta(meta);
    populateRegions();
    renderRegion(document.getElementById("region").value);
  } catch (err) {
    console.error("Failed to load data", err);
    document.getElementById("meta").textContent =
      "Failed to load data — please try again in a few minutes.";
  }
}

// Re-render on colour scheme change so chart colours stay in sync
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  const select = document.getElementById("region");
  if (select && select.value) renderRegion(select.value);
});

loadData();
