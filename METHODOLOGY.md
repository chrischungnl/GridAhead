# Methodology

How GridAhead predicts UK Octopus Agile electricity prices 3 days ahead.

This document describes the thinking behind the model — the features, the
validation approach, the trade-offs, and what the model *can't* do. It
deliberately doesn't include training code or data; the goal is to be clear
enough that someone could reimplement the approach against their own data.

## Problem framing

Octopus Agile is a half-hourly electricity tariff in the UK where the price
paid per kWh changes every 30 minutes based on day-ahead wholesale prices.
Octopus publishes the official rates for the next day around 4 pm the
preceding day. Users who can shift consumption (EV charging, heat pumps,
battery storage, dishwashers, laundry) benefit from knowing those prices
as early as possible.

The problem GridAhead solves: **predict next-3-days half-hourly Agile prices
before Octopus publishes them**, with enough accuracy to drive real
consumption decisions (battery charging windows, EV scheduling, dishwasher
start times). The model is run twice daily so the afternoon prediction can
incorporate the morning's actual market conditions.

Baseline: Octopus's own 4 pm publication of next-day rates is the definitive
source for next-day prices once it exists. GridAhead's contribution is the
longer horizon (3 days vs 1 day) and the earlier availability — predictions
are published in the morning, well before Octopus's own 4 pm release.

## Data sources

All inputs are public and free. No scraping, no PII:

- **Octopus Energy REST API** — historical Agile rates per product and tariff
  code. No auth required for public rate endpoints.
- **Elexon BMRS** — half-hourly UK grid fuel mix (CCGT, wind, nuclear, solar)
  via the FUELHH endpoint. Used as gas dispatch and renewable output proxies.
  No auth required.
- **UK Carbon Intensity API** — national generation mix forecast up to 96
  hours ahead at 30-minute resolution, plus current carbon intensity.
- **Open-Meteo** — wind speed forecasts at 10 m and 100 m AGL for 9 UK offshore
  and onshore wind farm locations (Hornsea, Dogger Bank, Moray East, etc.),
  plus national temperature. Multi-model ensemble (ECMWF IFS, GFS, UKMO) for
  uncertainty quantification.

Everything is cached in SQLite. Historical data is backfilled in chunks
during initial setup (the Elexon BMRS endpoint has a 30-day per-request
limit, so backfill is done in rolling windows).

## Feature engineering

The model uses ~40 features, grouped by purpose:

### Price history (dominant signal)

- **`price_lag_48`** — the price at the same half-hour yesterday. This is
  by far the single most predictive feature: importance 52.6% in the trained
  model. UK electricity markets have very strong day-over-day autocorrelation,
  so "yesterday at this exact half-hour" is already a decent baseline.
- **`price_lag_96`** — the price at the same half-hour two days ago. Adds
  a small amount of incremental signal (10.0%) and helps when yesterday
  was an outlier (windstorm, grid emergency, bank holiday).
- **`price_momentum_48h`** — direction of recent price movement. Captures
  whether we're in a rising or falling regime. Importance 10.3%.
- **`daily_max_prev`, `daily_min_prev`, `daily_range_prev`** — yesterday's
  price regime summary (~1% each). Helps the model distinguish "normal
  volatility" from "everything is weird today."

Together, lag and momentum features account for ~75% of the model's
predictive power. The rest is refinement.

### Wind generation (the second most important input)

UK Agile pricing is heavily influenced by wind supply — high wind produces
negative prices overnight; low wind produces spike prices during peaks.

- **`wind_national_mean`** — the average forecasted wind speed across the
  9 wind farm locations. Importance 3.5%. Correlates strongly with total
  renewable output, which is the main negative-price driver.
- **`wind_change_24h`** — is wind increasing or decreasing vs yesterday?
  Importance 3.4%. Captures ramp events.
- **`wind_power_curve`** — `wind_speed ** 3` (proportional to theoretical
  wind power output). Non-linear but the tree ensemble handles this
  natively; the explicit feature just helps the splits find thresholds
  faster.
- **`wind_x_weekend`** — interaction feature: weekend + high wind is a
  reliable negative-price indicator because demand is low AND supply is high.
  Importance 1.2%.

### Temporal features

Trees need explicit temporal encoding because they can't learn cyclical
patterns directly.

- Raw integers: `half_hour`, `hour`, `dow`, `month`
- Cyclical encodings: `hour_sin/cos`, `dow_sin/cos`, `month_sin/cos` — for
  smooth interpolation across day and year boundaries
- Demand flags: `is_peak` (17–19), `is_overnight` (00–06), `is_morning` (06–09),
  `is_evening_peak` (17–20), `is_weekend`
- `day_length` — seasonal solar generation proxy. Importance 1.7%.

### Extreme event indicators

The price distribution is heavily fat-tailed — the 99th percentile is far
above the median. To handle this, the model includes explicit "risk" features:

- **`spike_risk`** — `low_wind × is_peak × cold_temp`. Fires during winter
  peak demand with calm weather. These are the events where prices go above
  35 p/kWh.
- **`plunge_risk`** — `renewable_excess × low_demand`, seasonally adjusted.
  Captures both winter overnight negatives (wind excess + sleeping demand)
  and spring/summer midday negatives (solar excess + mild weather). Critical
  for predicting negative prices, which happen 3–5% of the time but are
  disproportionately valuable to forecast correctly.

Training uses **3× sample weight** on extreme prices (< 0 p and > 35 p) so
the loss function cares more about these outliers than their natural frequency
would suggest.

### BMRS fuel mix

- **`ccgt_mw`** — combined-cycle gas turbine output, a proxy for gas dispatch.
  When gas is on the margin, prices move with gas prices.
- **`wind_mw`** — actual wind output (not forecast). Used where available.
- **`nuclear_mw`** — nuclear output, a stable must-run baseline.
- **`solar_mw`** — solar output, strongly correlated with time of day.
- **`gas_fraction`** — `ccgt_mw / total_mw`, captures the share of generation
  currently set by gas-fired plants.

### Carbon intensity

The Carbon Intensity API provides a forecast of the national generation mix
and a derived carbon intensity metric. Raw carbon intensity and individual
fuel-mix fractions are included as features — high carbon intensity
correlates with "gas is dispatching at expensive plants," which correlates
with high prices.

## Model choice

The model is a **`GradientBoostingRegressor` from scikit-learn** with:

- 800 trees
- max depth 6
- learning rate 0.05
- subsample 0.8
- `loss="huber"` (Huber loss, more robust to outliers than squared error)

### Why not a neural network?

- **Dataset size**: ~8 years × 48 half-hours/day ≈ 140,000 training rows. Deep
  networks don't shine below ~1M rows on tabular data.
- **Feature interactions matter**: gradient-boosted trees learn feature
  interactions via splits natively and efficiently.
- **Interpretability**: feature importance from a tree model is meaningful;
  from a neural network it requires SHAP or similar, which adds complexity
  without clear benefit for this problem.
- **Training speed**: the full model retrains in ~30 seconds on a laptop,
  which makes weekly retraining trivial.
- **Deployment footprint**: a pickled GBR fits in under 5 MB; the same
  capability as a neural network would require ONNX runtime or PyTorch.

### Why not XGBoost or LightGBM?

The scikit-learn `GradientBoostingRegressor` was chosen over XGBoost/LightGBM
specifically for its **native handling of `sample_weight` with a Huber loss**,
which was important for the 3×-weighted extreme-price training strategy.
LightGBM would likely be marginally faster but the speed difference at this
dataset size is not meaningful.

## Validation

**5-fold GroupKFold by date**, not TimeSeriesSplit.

This is an important choice. The obvious validation approach for a time-series
problem is `TimeSeriesSplit`, which only uses past data to predict future
folds. But that assumes a temporal structure where "recency" is the only
thing that matters, and that isn't true for this problem:

1. UK electricity prices have **regime shifts**, not a smooth time trend.
   The 2022 gas crisis, the 2023 windfarm buildout, daylight savings
   transitions — these create discontinuities that `TimeSeriesSplit` penalises
   unfairly.
2. The features we care most about (day-of-week, time-of-day, wind level,
   gas fraction) are **not** "get better with more recent data" features —
   they're structural. A model trained on 2020 data and tested on 2024 data
   should still work if the features are the right features.

`GroupKFold` by date (each day is one group) lets the model train on days
spread across the full historical window and evaluate on held-out days,
which is a better test of generalisation than strict time ordering for this
problem. It's also a stronger test: there's no leakage within a day, and the
validation set reflects the realistic distribution of days the model will
see in production.

**Reported metrics**:
- CV R² ≈ 0.88
- CV MAE ≈ 1.90 p/kWh

(These are rounded; the exact numbers shift slightly with each weekly retrain.)

## Online adaptation: Kalman price regime tracker

The weekly retrained model provides the base prediction. On top of that, an
online adaptation layer tracks model residuals in real time using a
**per-half-hour Kalman filter** with 48 independent state slots — one per
half-hour of the day.

For each half-hour, the filter maintains an estimate of the additive
offset between the model's prediction and the actual observed price:

```
offset_t+1 = offset_t + process_noise
residual_t = actual_t - prediction_t
offset_t+1 = offset_t + K × (residual_t - offset_t)
```

The Kalman gain `K` balances how much to trust the latest residual vs the
accumulated estimate. Process noise reflects "how fast does the price regime
change?" — set empirically from the residual variance in historical data.

This is a classical control-theory technique, not a machine-learning one. It
catches regime changes (a new price cap, a mid-week grid emergency) that the
weekly-retrained base model hasn't seen yet. The state is bootstrapped from
the last 30 days of historical residuals and updated nightly during
reconciliation when actual prices become available.

## System price conditioning

After ~12 pm UK time, Elexon publishes that day's system imbalance prices,
which are a real-time signal of how close the predicted prices are to
reality. GridAhead uses these as a **same-day blending signal**:

- For today's remaining half-hours: blend 80% observed-system-price with
  20% model prediction (the observed price is far more reliable for the
  current day than the model)
- For tomorrow's predictions: apply a regime-shift nudge based on the ratio
  of today's system prices to today's earlier predictions

This is a hybrid: the model is the primary mechanism, but it defers to
ground truth when ground truth is available.

## What the model can't do

Honesty about limitations:

- **Black swan events**: if the UK grid loses 3 GW of nuclear unexpectedly,
  or if an interconnector trips, or if there's a war-driven gas price jump,
  the model has no signal for that. The Kalman filter will adapt *after*
  the first residuals come in, but the initial predictions during the event
  will be wrong.
- **Extreme negative prices**: while the model captures many negative-price
  events, the magnitude of deep negatives (down to -20 p/kWh) is
  under-predicted. The natural distribution has heavy left-tail outliers
  that the 3× sample weight only partially compensates for.
- **Bank holidays**: the model sees "weekend" but not "bank holiday." On
  Easter Monday or May Day, the demand pattern looks like a Sunday but the
  date features say Monday. Predictions on these days are meaningfully
  worse than normal.
- **Multi-day forecasts**: accuracy degrades with horizon. Today and tomorrow
  are well-predicted; day+2 is noticeably worse because weather ensemble
  spread grows non-linearly.
- **Regional specificity**: the model is trained on region C (London / South
  East) and scaled to other DNO regions via static multipliers based on the
  DUoS component of the Octopus product. This is accurate in aggregate but
  doesn't capture region-specific market dynamics (e.g., Scottish grid
  constraints affecting region P).

## How often the model retrains

- **Base GBR model**: weekly, Sundays 02:00 UK time. Uses all historical
  data up to that point.
- **Kalman state**: nightly during reconciliation (when actual prices arrive).
- **Predictions published**: twice daily at 11:05 and 13:05 UK time.

The twice-daily schedule exists because the 11:05 run catches most of the
day's weather forecast refresh, and the 13:05 run adds the benefit of the
system price conditioning after Elexon's noon settlement publication.

## References

- Octopus Energy: [Agile Octopus tariff](https://octopus.energy/smart/agile/)
- Elexon BMRS: [FUELHH endpoint docs](https://bmrs.elexon.co.uk/api-documentation/endpoint/datasets/FUELHH)
- UK Carbon Intensity API: [carbonintensity.org.uk](https://api.carbonintensity.org.uk)
- Open-Meteo: [open-meteo.com](https://open-meteo.com)
- scikit-learn GBR: [`GradientBoostingRegressor`](https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.GradientBoostingRegressor.html)

## Feedback

If you spot an issue with the predictions or the methodology, open an issue
on the [GitHub repository](https://github.com/chrischungnl/GridAhead/issues).
The training code is not open-sourced, but the model's *approach* — the
features, the validation, the control-theory layer — is fully described
here. That's clear enough to reimplement the approach against any equivalent
dataset.
