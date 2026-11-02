"""Weather, forecasts and warnings from the US National Weather Service.

api.weather.gov is open data, free for any use. It asks for a User-Agent that
names the application and a way to reach its author, and sets a Cache-Control
max-age on every response that fetch.py honours, so each product is only
fetched as often as it changes: the location lookup daily, the forecasts
hourly, the latest observation and alerts every few minutes.

There is no live lightning feed: Blitzortung's data is only for people who run
a detector. Thunder comes from the forecast's probability of thunder and from
NWS warnings instead.
"""
import json
import logging
import re
import time
from datetime import datetime, timedelta, timezone

from .. import config, fetch

log = logging.getLogger("shackwall.nws")

API = "https://api.weather.gov"
# Alerts are what make this worth checking often. The rest is cached by fetch
# for as long as NWS says it stays current.
INTERVAL_S = 120
# A station that hasn't reported for this long is skipped for the next one.
OBS_MAX_AGE_S = 2 * 3600
LOOKAHEAD = timedelta(hours=24)

# Warnings that mean get the antennas down, and watches and advisories that
# mean keep an eye on them. Matched against the alert's event name.
LOWER_EVENTS = {
    "Tornado Warning", "Severe Thunderstorm Warning", "Extreme Wind Warning",
    "High Wind Warning", "Hurricane Warning", "Tropical Storm Warning",
}
WATCH_EVENTS = {
    "Tornado Watch", "Severe Thunderstorm Watch", "High Wind Watch",
    "Wind Advisory", "Hurricane Watch", "Tropical Storm Watch",
}
THUNDER_WATCH_PCT = 30

state = {"updated": None, "errors": {}}


def _kmh_to_mph(v):
    return None if v is None else v / 1.609344


def _c_to_f(v):
    return None if v is None else v * 9 / 5 + 32


def _value(props, key):
    return (props.get(key) or {}).get("value")


async def _json(url):
    return json.loads(await fetch.get_text(url))


def _interval(valid_time):
    """'2026-11-02T05:00:00+00:00/PT6H' -> (start, end)."""
    start, duration = valid_time.split("/")
    m = re.fullmatch(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?", duration)
    d, h, mins = (int(x or 0) for x in m.groups())
    start = datetime.fromisoformat(start)
    return start, start + timedelta(days=d, hours=h, minutes=mins)


def _peak(series, now):
    """Largest value in a gridpoint series over the next 24 hours, and when."""
    best = None
    for v in series.get("values", []):
        start, end = _interval(v["validTime"])
        if end <= now or start >= now + LOOKAHEAD or v["value"] is None:
            continue
        if best is None or v["value"] > best[0]:
            best = (v["value"], max(start, now))
    return best


async def _observation(stations_url):
    """The latest observation from the nearest station that's reporting."""
    stations = (await _json(stations_url))["features"]
    for s in stations[:3]:
        sid = s["properties"]["stationIdentifier"]
        o = (await _json(f"{API}/stations/{sid}/observations/latest"))["properties"]
        # NWS sometimes publishes a report with its readings blanked (they
        # failed its quality checks). Then the newest of the station's last
        # few reports that has a temperature stands in.
        if _value(o, "temperature") is None:
            recent = (await _json(f"{API}/stations/{sid}/observations?limit=4"))["features"]
            o = next((r["properties"] for r in recent
                      if _value(r["properties"], "temperature") is not None), o)
        taken = datetime.fromisoformat(o["timestamp"])
        if (datetime.now(timezone.utc) - taken).total_seconds() > OBS_MAX_AGE_S:
            continue
        if _value(o, "temperature") is None:
            continue
        return {
            "station": sid,
            "station_name": s["properties"]["name"],
            "time": o["timestamp"],
            "text": o.get("textDescription"),
            "temp_f": _c_to_f(_value(o, "temperature")),
            "dewpoint_f": _c_to_f(_value(o, "dewpoint")),
            "humidity": _value(o, "relativeHumidity"),
            "wind_mph": _kmh_to_mph(_value(o, "windSpeed")),
            "wind_dir": _value(o, "windDirection"),
            "gust_mph": _kmh_to_mph(_value(o, "windGust")),
            "pressure_inhg": (_value(o, "barometricPressure") or 0) / 3386.389 or None,
        }
    raise ValueError("no nearby station has reported in the last two hours")


def _outlook(grid):
    now = datetime.now(timezone.utc)
    gust = _peak(grid.get("windGust", {}), now)
    thunder = _peak(grid.get("probabilityOfThunder", {}), now)
    return {
        "hourly": _hourly(grid),
        "gust_mph": _kmh_to_mph(gust[0]) if gust else None,
        "gust_at": gust[1].isoformat() if gust else None,
        "thunder_pct": thunder[0] if thunder else None,
        "thunder_at": thunder[1].isoformat() if thunder else None,
    }


# Hourly series for the forecast page's chart, two days ahead.
HOURLY_HOURS = 48
HOURLY = {
    "temp_f": ("temperature", _c_to_f),
    "gust_mph": ("windGust", _kmh_to_mph),
    "wind_mph": ("windSpeed", _kmh_to_mph),
    "precip_pct": ("probabilityOfPrecipitation", lambda v: v),
    "thunder_pct": ("probabilityOfThunder", lambda v: v),
}


def _hourly(grid):
    """The grid's variable-length intervals laid out as one row per hour."""
    start = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    hours = [start + timedelta(hours=i) for i in range(HOURLY_HOURS)]
    rows = [{"time": h.isoformat()} for h in hours]
    for key, (name, convert) in HOURLY.items():
        for v in grid.get(name, {}).get("values", []):
            a, b = _interval(v["validTime"])
            for h, row in zip(hours, rows):
                if a <= h < b and v["value"] is not None:
                    row[key] = round(convert(v["value"]), 1)
    return rows


def _forecast(fc):
    return [{
        "name": p["name"],
        "start": p["startTime"],
        "daytime": p["isDaytime"],
        "temp_f": p["temperature"],
        "wind": f'{p["windDirection"]} {p["windSpeed"]}',
        "short": p["shortForecast"],
        "detail": p["detailedForecast"],
        "precip_pct": _value(p, "probabilityOfPrecipitation"),
    } for p in fc["properties"]["periods"][:8]]


def _alerts(data):
    return [{
        "event": a["properties"]["event"],
        "severity": a["properties"]["severity"],
        "headline": a["properties"].get("headline"),
        "ends": a["properties"].get("ends") or a["properties"].get("expires"),
    } for a in data["features"]]


def _antenna(now_obs, outlook, alerts):
    """'ok', 'watch' or 'lower', with the reasons, from warnings and wind."""
    lower, watch = [], []
    for a in alerts:
        if a["event"] in LOWER_EVENTS:
            lower.append(a["event"])
        elif a["event"] in WATCH_EVENTS:
            watch.append(a["event"])
    gust_now = (now_obs or {}).get("gust_mph") or (now_obs or {}).get("wind_mph")
    if gust_now is not None and gust_now >= config.WIND_LOWER_MPH:
        lower.append(f"Gusts {gust_now:.0f} mph now")
    gust = outlook.get("gust_mph")
    if gust is not None and gust >= config.WIND_WATCH_MPH:
        watch.append(f"Gusts to {gust:.0f} mph forecast")
    thunder = outlook.get("thunder_pct")
    if thunder is not None and thunder >= THUNDER_WATCH_PCT:
        watch.append(f"Thunder {thunder:.0f}% chance")
    level = "lower" if lower else "watch" if watch else "ok"
    return {"level": level, "reasons": lower + watch}


async def refresh():
    if not (config.LAT or config.LON):
        state["errors"]["location"] = "set LAT and LON, or GRID, in shackwall.env"
        return
    state["errors"].pop("location", None)
    try:
        point = (await _json(f"{API}/points/{config.LAT:.4f},{config.LON:.4f}"))["properties"]
    except Exception as e:
        state["errors"]["point"] = f"{type(e).__name__}: {e}"
        log.warning("NWS points: %s", state["errors"]["point"])
        return
    state["errors"].pop("point", None)
    state["office"] = point.get("cwa")

    feeds = {
        "now": lambda: _observation(point["observationStations"]),
        "outlook": lambda: _json(point["forecastGridData"]),
        "forecast": lambda: _json(point["forecast"]),
        "alerts": lambda: _json(f"{API}/alerts/active?point={config.LAT:.4f},{config.LON:.4f}"),
    }
    parse = {"now": lambda x: x, "outlook": lambda x: _outlook(x["properties"]),
             "forecast": _forecast, "alerts": _alerts}
    for name, get in feeds.items():
        try:
            state[name] = parse[name](await get())
            state["errors"].pop(name, None)
        except Exception as e:          # one bad product must not stop the others
            state["errors"][name] = f"{type(e).__name__}: {e}"
            log.warning("NWS %s: %s", name, state["errors"][name])
    state["antenna"] = _antenna(state.get("now"), state.get("outlook", {}),
                                state.get("alerts", []))
    state["updated"] = time.time()
