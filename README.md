# GridAhead

**3-day-ahead half-hourly UK Octopus Agile electricity price predictions,
for all 14 DNO regions.**

Predictions are regenerated twice daily (11:05 and 13:05 UK time) and are
available before Octopus publishes the official next-day rates — giving
downstream tools a head start on planning battery charging, EV scheduling,
and dishwasher timing.

- **Live demo**: https://gridahead.chrischung.nl
- **Methodology**: [METHODOLOGY.md](METHODOLOGY.md) — how the model is built and validated
- **Data feed**: `https://data.gridahead.chrischung.nl/predictions/latest.json`
- **Source**: this repo
- **License**: MIT

## Quick start

Fetch all 14 regions for the next 3 days:

```bash
curl https://data.gridahead.chrischung.nl/predictions/latest.json
```

Fetch a single region (smaller response, use this if you don't need all 14):

```bash
curl https://data.gridahead.chrischung.nl/predictions/C.json
```

No API keys. No rate limits at the HTTP layer. No user agent required.
Cloudflare's edge CDN caches every response globally, so even heavy usage
hits the origin at most once per 5 minutes.

Python:

```python
import requests
data = requests.get("https://data.gridahead.chrischung.nl/predictions/C.json").json()
for date_str, day in data["dates"].items():
    for slot in day["slots"]:
        print(slot["from"], slot["pence_inc_vat"])
```

JavaScript:

```javascript
const res = await fetch("https://data.gridahead.chrischung.nl/predictions/C.json");
const data = await res.json();
console.log(data.dates);
```

## Data feed

All files are hosted as static JSON on a Cloudflare R2 public bucket,
fronted by the custom domain `data.gridahead.chrischung.nl`. There is no
backend server. Updates are pushed from a private origin twice daily.

### Endpoints

| URL | Contents | Approx. size (gzipped) |
|---|---|---|
| `/predictions/latest.json` | All 14 regions, next 3 days | ~50 KB |
| `/predictions/{A..P}.json` | Single region, next 3 days | ~5 KB |
| `/predictions/meta.json` | Forecast run metadata + regional multiplier table | <1 KB |

### Regions

Each region corresponds to a UK DNO. The model is trained on region C
(London / South East) and scaled to other regions by static multipliers
derived from the Octopus Agile product's DUoS component.

| Code | Region | vs base (C) |
|---|---|---|
| A | Eastern England | +6.4% |
| B | East Midlands | +1.0% |
| **C** | **London / South East** | **base** |
| D | Merseyside & North Wales | +12.4% |
| E | West Midlands | +5.9% |
| F | North Eastern England | +5.9% |
| G | North Western England | +5.9% |
| H | Southern England | +5.9% |
| J | South Eastern England | +11.8% |
| K | Southern Wales | +11.8% |
| L | South Western England | +17.3% |
| M | Yorkshire | +0.5% |
| N | Southern Scotland | +6.4% |
| P | Northern Scotland | +23.7% |

These multipliers are stable and updated annually when Octopus updates its
Agile product. The live list is in
[`predictions/meta.json`](https://data.gridahead.chrischung.nl/predictions/meta.json).

### Schema

A per-region file (`predictions/{code}.json`) looks like this:

```json
{
  "generated_at": "2026-04-11T11:05:42.318000+00:00",
  "region": {
    "code": "C",
    "name": "London / South East",
    "multiplier": 1.0
  },
  "dates": {
    "2026-04-11": {
      "slots": [
        {
          "from": "2026-04-11T11:30:00+01:00",
          "to":   "2026-04-11T12:00:00+01:00",
          "pence_inc_vat": 18.42,
          "low":  14.12,
          "high": 22.70
        }
      ],
      "summary": {
        "avg": 16.76,
        "min": 14.85,
        "max": 18.42,
        "count": 48
      }
    }
  }
}
```

Per-slot fields:

- **`from`**, **`to`** — half-hour interval boundaries in `Europe/London`
  time (ISO 8601 with timezone offset).
- **`pence_inc_vat`** — the predicted price in pence per kWh, already
  including the 5% VAT used by Octopus Agile.
- **`low`**, **`high`** — 10th / 90th percentile confidence band from the
  model's uncertainty estimate. Use these to bound your decisions when
  price uncertainty matters (e.g., "only charge the battery if even the
  90th percentile stays below 10 p").

The all-regions file (`predictions/latest.json`) is the same structure
wrapped in a `regions` object keyed by region code:

```json
{
  "generated_at": "2026-04-11T11:05:42.318000+00:00",
  "regions": {
    "A": { ... same shape as per-region file ... },
    "B": { ... },
    ...
    "P": { ... }
  }
}
```

The metadata file (`predictions/meta.json`) contains forecast run ID, model
stats, and the region multiplier table:

```json
{
  "generated_at": "2026-04-11T11:05:42.318000+00:00",
  "forecast_run": "2026-04-11T11:05:42.318000+00:00",
  "model": {
    "type": "GradientBoostingRegressor",
    "cv_r_squared": 0.88,
    "cv_mae_pence": 1.90,
    "blended_with": "AgilePredict (50/50)",
    "retrained": "weekly (Sundays 02:00)"
  },
  "regions": [ ... ],
  "schema_version": 1
}
```

Full sample payloads are in [`sample/`](sample/) so you can inspect the
schema without hitting the live feed.

## How it works

The full technical description lives in [METHODOLOGY.md](METHODOLOGY.md).
The short version:

1. A GradientBoostingRegressor with ~40 features is trained on ~8 years of
   UK electricity market data (Octopus rates, Elexon BMRS fuel mix, Carbon
   Intensity API, Open-Meteo wind forecasts for 9 UK wind farms). CV R² ≈
   0.88, MAE ≈ 1.90 p/kWh.
2. Validation is 5-fold **GroupKFold by date**, not `TimeSeriesSplit` —
   the market has regime shifts, not smooth time trends, so day-grouped
   cross-validation is a truer test of generalisation.
3. A **per-half-hour Kalman filter** (48 slots, one per half-hour of day)
   tracks the model's residuals and applies an additive regime offset. This
   is the online-adaptation layer that catches price regime changes the
   weekly-retrained base model hasn't seen yet.
4. After noon, **system prices from Elexon are blended in** at 80/20 for
   same-day predictions and as a regime-shift nudge for tomorrow. The model
   is willing to defer to ground truth when ground truth exists.
5. The final output is **blended 50/50 with AgilePredict** as a published
   baseline. Two independent predictors averaged reliably outperform either
   alone.
6. The model is retrained weekly (Sundays 02:00 UK time) and predictions
   are regenerated twice daily (11:05 and 13:05).

The training code and input data are not public (they live in a private
monorepo that also holds personal telemetry). The methodology, features,
and validation approach are fully described in `METHODOLOGY.md` — clear
enough that you could reimplement the approach against your own data.

## Attribution and data sources

GridAhead stands on the shoulders of several public data sources. All of
them are free and publicly accessible:

- **Octopus Energy** — historical Agile rates ([API docs](https://developer.octopus.energy/rest/guides/api-basics))
- **Elexon BMRS** — UK grid half-hourly fuel mix ([API docs](https://bmrs.elexon.co.uk/api-documentation))
- **UK Carbon Intensity API** — national generation mix forecast ([docs](https://api.carbonintensity.org.uk))
- **Open-Meteo** — weather ensemble forecasts ([docs](https://open-meteo.com/en/docs))
- **AgilePredict** — independent Agile price prediction service, used as a
  blending baseline ([agilepredict.com](https://agilepredict.com))

If you use this data in your own project, please mention GridAhead — it
helps signal there's demand for a public Agile prediction feed.

## Questions, issues, feedback

Open an issue on this repo. The data is free and the methodology is public
— if you think a feature or approach would make the model better, I want
to hear about it.

## Disclaimer

Predictions are for informational purposes only and are not financial or
energy-market advice. Actual Agile prices are set by Octopus Energy from
wholesale market settlement data; GridAhead is an independent forecast and
has no affiliation with Octopus. Use responsibly.
