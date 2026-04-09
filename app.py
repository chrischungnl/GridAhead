"""GridAhead API

3-day ahead half-hourly Agile Octopus electricity price predictions
for all 14 UK DNO regions.

Usage:
    python app.py                          # Development (localhost:8090)
    gunicorn app:app -b 0.0.0.0:8090      # Production

Environment variables:
    DB_PATH:     Path to predictions SQLite database (required)
    CONFIG_PATH: Path to config.json with API keys (default: ./config.json)
    PORT:        Server port (default: 8090)
"""

import hashlib
import hmac
import json
import logging
import os
import sqlite3
import time as _time
from datetime import date, datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
from zoneinfo import ZoneInfo

from flask import Flask, request, jsonify

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DB_PATH = os.environ.get("DB_PATH", "/data/predictions.db")
CONFIG_PATH = os.environ.get("CONFIG_PATH", Path(__file__).parent / "config.json")
LONDON_TZ = ZoneInfo("Europe/London")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
)
logger = logging.getLogger("agile-api")

app = Flask(__name__)


# ---------------------------------------------------------------------------
# Request logging (excludes health pings)
# ---------------------------------------------------------------------------

_usage_log = []  # In-memory log, persisted to DB if available
PING_PATHS = {"/api/v1/health", "/ping", "/"}


@app.after_request
def log_usage(response):
    """Log API usage, excluding pings and health checks."""
    if request.path in PING_PATHS:
        return response
    entry = {
        "time": datetime.now(timezone.utc).isoformat(),
        "path": request.path,
        "region": request.args.get("region", ""),
        "status": response.status_code,
        "key_prefix": (request.headers.get("X-API-Key") or "")[:8] + "..." if request.headers.get("X-API-Key") else "",
    }
    _usage_log.append(entry)
    # Keep last 10000 entries in memory
    if len(_usage_log) > 10000:
        _usage_log.pop(0)
    logger.info("API %s %s region=%s status=%d", request.method, request.path,
                entry["region"], response.status_code)
    return response


def _load_api_config():
    """Load API configuration."""
    path = Path(CONFIG_PATH)
    if not path.exists():
        return {}
    with open(path) as f:
        return json.load(f)


def _get_db():
    """Get a read-only SQLite connection to the prediction database."""
    path = Path(DB_PATH)
    if not path.exists():
        raise FileNotFoundError(f"Database not found: {path}")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _parse_timestamp(ts_str):
    """Parse a timestamp string to timezone-aware datetime in Europe/London.

    Handles ISO formats with and without timezone info.
    Returns (local_dt, local_iso_str).
    """
    ts_str = str(ts_str).strip()
    try:
        # Try parsing with timezone
        if "+" in ts_str or ts_str.endswith("Z"):
            dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        else:
            # Assume UTC if no timezone
            dt = datetime.fromisoformat(ts_str).replace(tzinfo=timezone.utc)
        local = dt.astimezone(LONDON_TZ)
        return local
    except (ValueError, TypeError):
        # Fallback: return as-is
        return datetime.fromisoformat(ts_str)


# ---------------------------------------------------------------------------
# Regional pricing
# ---------------------------------------------------------------------------

# Multipliers: ratio of each region's Agile rate to region C (base model).
# Derived from Octopus Agile rates. Stable (DUoS-driven), updated annually.
# Last computed: 2026-04-09 from AGILE-24-10-01 product.
REGIONS = {
    "A": {"name": "Eastern England",          "multiplier": 1.0642},
    "B": {"name": "East Midlands",            "multiplier": 1.0101},
    "C": {"name": "London / South East",      "multiplier": 1.0000},
    "D": {"name": "Merseyside & North Wales", "multiplier": 1.1235},
    "E": {"name": "West Midlands",            "multiplier": 1.0592},
    "F": {"name": "North Eastern England",    "multiplier": 1.0592},
    "G": {"name": "North Western England",    "multiplier": 1.0592},
    "H": {"name": "Southern England",         "multiplier": 1.0592},
    "J": {"name": "South Eastern England",    "multiplier": 1.1184},
    "K": {"name": "Southern Wales",           "multiplier": 1.1184},
    "L": {"name": "South Western England",    "multiplier": 1.1726},
    "M": {"name": "Yorkshire",                "multiplier": 1.0050},
    "N": {"name": "Southern Scotland",        "multiplier": 1.0642},
    "P": {"name": "Northern Scotland",        "multiplier": 1.2369},
}


# ---------------------------------------------------------------------------
# Authentication and rate limiting
# ---------------------------------------------------------------------------

_api_keys_cache = {"hashes": None, "time": 0}
_rate_limits = {}

RATE_LIMIT_PER_MINUTE = 30
RATE_LIMIT_PER_DAY = 1000
KEY_CACHE_TTL = 300


def _get_valid_key_hashes():
    """Load and cache API key hashes. Re-reads config every 5 minutes."""
    now = _time.time()
    if _api_keys_cache["hashes"] is None or now - _api_keys_cache["time"] > KEY_CACHE_TTL:
        config = _load_api_config()
        keys = config.get("api_keys", [])
        _api_keys_cache["hashes"] = [
            hashlib.sha256(k.encode()).hexdigest() for k in keys
        ]
        _api_keys_cache["time"] = now
    return _api_keys_cache["hashes"]


def _check_rate_limit(key_hash):
    """Returns True if request is within rate limits."""
    now = _time.time()
    if key_hash not in _rate_limits:
        _rate_limits[key_hash] = {"minute": [1, now], "day": [1, now]}
        return True

    lim = _rate_limits[key_hash]
    m_count, m_start = lim["minute"]
    d_count, d_start = lim["day"]

    minute_ok = (now - m_start > 60) or (m_count < RATE_LIMIT_PER_MINUTE)
    day_ok = (now - d_start > 86400) or (d_count < RATE_LIMIT_PER_DAY)

    if not (minute_ok and day_ok):
        return False

    if now - m_start > 60:
        lim["minute"] = [1, now]
    else:
        lim["minute"][0] += 1

    if now - d_start > 86400:
        lim["day"] = [1, now]
    else:
        lim["day"][0] += 1

    return True


def require_api_key(f):
    """Require valid API key via X-API-Key header or api_key parameter."""
    @wraps(f)
    def decorated(*args, **kwargs):
        api_key = request.headers.get("X-API-Key") or request.args.get("api_key")
        if not api_key:
            return jsonify({"error": "Missing API key. Provide via X-API-Key header."}), 401

        valid_hashes = _get_valid_key_hashes()
        if not valid_hashes:
            return jsonify({"error": "API not configured."}), 503

        incoming_hash = hashlib.sha256(api_key.encode()).hexdigest()
        key_valid = any(hmac.compare_digest(incoming_hash, vh) for vh in valid_hashes)

        if not key_valid:
            return jsonify({"error": "Invalid API key."}), 403

        if not _check_rate_limit(incoming_hash[:16]):
            return jsonify({"error": "Rate limit exceeded. Max 30/min, 1000/day."}), 429

        return f(*args, **kwargs)
    return decorated


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------

@app.route("/api/v1/predictions")
@require_api_key
def get_predictions():
    """Get half-hourly Agile price predictions.

    Query params:
        region:    Region letter A-P. Omit for all regions.
        date:      Single date YYYY-MM-DD.
        date_from: Start date (default: tomorrow).
        date_to:   End date (default: date_from + 2 days).

    Returns half-hourly predictions in pence/kWh inc. VAT.
    """
    try:
        conn = _get_db()
    except FileNotFoundError:
        return jsonify({"error": "Prediction database not available."}), 503

    try:
        region = request.args.get("region", "").upper()
        if region and region not in REGIONS:
            return jsonify({
                "error": f"Invalid region '{region}'. Valid: {', '.join(sorted(REGIONS))}",
            }), 400
        regions = [region] if region else sorted(REGIONS)

        date_from = request.args.get("date_from") or request.args.get("date")
        date_to = request.args.get("date_to") or request.args.get("date")

        if not date_from:
            tomorrow = date.today() + timedelta(days=1)
            date_from = tomorrow.isoformat()
            date_to = (tomorrow + timedelta(days=2)).isoformat()

        if not date_to:
            date_to = date_from

        try:
            dt_from = datetime.strptime(date_from, "%Y-%m-%d").date()
            dt_to = datetime.strptime(date_to, "%Y-%m-%d").date()
        except (ValueError, TypeError):
            return jsonify({"error": "Invalid date format. Use YYYY-MM-DD."}), 400

        if dt_to < dt_from:
            return jsonify({"error": "date_to must be on or after date_from."}), 400
        if (dt_to - dt_from).days > 7:
            return jsonify({"error": "Maximum date range is 7 days."}), 400
        if dt_from < date.today():
            return jsonify({"error": "Cannot request predictions for past dates."}), 400

        result = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "model": {"type": "LightGBM stacking ensemble", "cv_mae_pence": 1.66},
            "regions": {},
        }

        for rgn in regions:
            multiplier = REGIONS[rgn]["multiplier"]
            region_data = {"code": rgn, "name": REGIONS[rgn]["name"], "dates": {}}

            current_date = dt_from
            while current_date <= dt_to:
                ds = current_date.isoformat()
                slots, meta = _get_slots(conn, ds, multiplier)
                if slots:
                    prices = [s["pence_inc_vat"] for s in slots]
                    region_data["dates"][ds] = {
                        "slots": slots,
                        "summary": {
                            "avg": round(sum(prices) / len(prices), 2),
                            "min": round(min(prices), 2),
                            "max": round(max(prices), 2),
                            "count": len(slots),
                        },
                        **meta,
                    }
                else:
                    region_data["dates"][ds] = {"slots": [], "note": "No predictions available."}
                current_date += timedelta(days=1)

            result["regions"][rgn] = region_data

        conn.close()
        return jsonify(result)

    except Exception:
        logger.exception("Prediction API error")
        return jsonify({"error": "Internal server error."}), 500


def _get_slots(conn, date_str, multiplier):
    """Fetch half-hourly predictions for a date, apply regional multiplier."""
    rows = conn.execute(
        "SELECT interval_start, predicted_pence, prediction_low, prediction_high, "
        "forecast_run FROM agile_price_predictions "
        "WHERE interval_start LIKE ? AND forecast_run = ("
        "  SELECT forecast_run FROM agile_price_predictions "
        "  WHERE interval_start LIKE ? "
        "  AND forecast_run NOT LIKE 'backprediction-%' "
        "  AND forecast_run NOT LIKE 'walkforward-%' "
        "  ORDER BY forecast_run DESC LIMIT 1"
        ") ORDER BY interval_start",
        (date_str + "%", date_str + "%"),
    ).fetchall()

    if not rows:
        return [], {}

    slots = []
    forecast_run = rows[0]["forecast_run"]

    for r in rows:
        local = _parse_timestamp(r["interval_start"])
        local_end = local + timedelta(minutes=30)

        slot = {
            "from": local.isoformat(),
            "to": local_end.isoformat(),
            "pence_inc_vat": round(float(r["predicted_pence"]) * multiplier, 2),
        }
        if r["prediction_low"] is not None:
            slot["low"] = round(float(r["prediction_low"]) * multiplier, 2)
        if r["prediction_high"] is not None:
            slot["high"] = round(float(r["prediction_high"]) * multiplier, 2)
        slots.append(slot)

    # Staleness check
    meta = {"forecast_run": forecast_run}
    try:
        run_dt = _parse_timestamp(forecast_run)
        hours_old = (datetime.now(timezone.utc) - run_dt.astimezone(timezone.utc)).total_seconds() / 3600
        if hours_old > 12:
            meta["stale"] = True
            meta["hours_since_update"] = round(hours_old, 1)
    except Exception:
        pass

    return slots, meta


@app.route("/api/v1/regions")
def list_regions():
    """List all UK Agile regions. No auth required."""
    return jsonify({
        "base_region": "C",
        "regions": [
            {"code": k, "name": v["name"], "multiplier": v["multiplier"]}
            for k, v in sorted(REGIONS.items())
        ],
    })


@app.route("/api/v1/health")
def health():
    """Health check. No auth required."""
    try:
        conn = _get_db()
        row = conn.execute(
            "SELECT MAX(forecast_run) FROM agile_price_predictions "
            "WHERE forecast_run NOT LIKE 'backprediction-%' "
            "AND forecast_run NOT LIKE 'walkforward-%'"
        ).fetchone()
        latest = row[0] if row else None

        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        count = conn.execute(
            "SELECT COUNT(*) FROM agile_price_predictions "
            "WHERE interval_start LIKE ? "
            "AND forecast_run NOT LIKE 'backprediction-%' "
            "AND forecast_run NOT LIKE 'walkforward-%'",
            (tomorrow + "%",),
        ).fetchone()[0]
        conn.close()

        return jsonify({
            "status": "healthy" if count > 0 else "degraded",
            "latest_forecast": latest,
            "tomorrow_slots": count,
        })
    except Exception:
        logger.exception("Health check failed")
        return jsonify({"status": "error"}), 500


@app.route("/ping")
def ping():
    """Lightweight keep-alive endpoint for UptimeRobot. No logging."""
    return "ok", 200


@app.route("/api/v1/usage")
@require_api_key
def usage_stats():
    """API usage stats (excludes pings). Requires API key."""
    total = len(_usage_log)
    by_path = {}
    by_region = {}
    for entry in _usage_log:
        by_path[entry["path"]] = by_path.get(entry["path"], 0) + 1
        if entry["region"]:
            by_region[entry["region"]] = by_region.get(entry["region"], 0) + 1
    return jsonify({
        "total_requests": total,
        "by_endpoint": by_path,
        "by_region": by_region,
        "recent": _usage_log[-20:],
    })


@app.route("/")
def index():
    """API documentation."""
    return jsonify({
        "name": "GridAhead API",
        "version": "1.0",
        "endpoints": {
            "GET /api/v1/predictions": "Half-hourly price predictions (requires API key)",
            "GET /api/v1/regions": "List UK Agile regions",
            "GET /api/v1/health": "Service health check",
            "GET /api/v1/usage": "API usage stats (requires API key)",
            "GET /ping": "Keep-alive for uptime monitors",
        },
        "auth": "Pass API key via X-API-Key header",
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8090))
    app.run(host="0.0.0.0", port=port, debug=False)
