"""Space weather from NOAA's Space Weather Prediction Center.

Each number comes from the smallest SWPC product that carries it, rather than
from the large history files: the 6-hour X-ray file is 160 kB to read one
value that xray-flares-latest gives in 450 bytes. Each feed is fetched on its
own, so one that fails or changes format blanks only its own numbers and the
rest keep updating.
"""
import json
import logging
import re
import time
from datetime import datetime, timedelta, timezone

from .. import fetch

log = logging.getLogger("shackwall.swpc")

BASE = "https://services.swpc.noaa.gov"

# The fastest of these feeds updates every minute, but nobody reads a solar
# flux to the minute. Five minutes keeps the display current and SWPC's load
# negligible; unchanged feeds come back as an empty 304.
INTERVAL_S = 300

state = {"updated": None, "errors": {}}


def _newest(rows, key="time_tag"):
    return max(rows, key=lambda r: r[key])


def _flux(text):
    row = _newest(json.loads(text))
    return {"sfi": row["flux"], "sfi_time": row["time_tag"]}


def _daily_solar(text):
    # Last 30 Days Daily Solar Data: the newest day is the last data line.
    #   2026 11 01   94     30       60      0    -999      *   1  0  0 ...
    rows = [l.split() for l in text.splitlines() if re.match(r"\d{4} \d\d \d\d", l)]
    y, m, d, _flux, ssn = rows[-1][:5]
    return {"ssn": int(ssn), "ssn_date": f"{y}-{m}-{d}"}


def _daily_geomag(text):
    # Last 30 Days Daily Geomagnetic Data. Today's line is all -1 until the UTC
    # day is over, so the planetary A is the newest line that has one. That
    # makes it yesterday's A, which is what the A index means: a whole day.
    # Columns: date, Fredericksburg A + 8 K, College A + 8 K, planetary A + 8 K.
    # Missing K values run together ("-1-1-1"), so splitting on spaces doesn't
    # count reliably. The planetary K values are the only ones with decimals,
    # so the planetary A is the integer just before the first of them.
    for line in reversed(text.splitlines()):
        if not re.match(r"\d{4} \d\d \d\d", line):
            continue
        m = re.search(r"(-?\d+)\s+-?\d+\.\d\d", line)
        a = int(m.group(1)) if m else -1
        if a >= 0:
            return {"a": a, "a_date": line[:10].replace(" ", "-")}
    raise ValueError("no completed day in DGD.txt")


def _kp(text):
    row = _newest(json.loads(text))
    return {"kp": row["Kp"], "kp_time": row["time_tag"]}


def _xray(text):
    row = _newest(json.loads(text))
    return {"xray": row["current_class"], "xray_time": row["time_tag"]}


def _wind(text):
    row = json.loads(text)[0]
    return {"wind_kms": row["proton_speed"], "wind_time": row["time_tag"]}


def _mag(text):
    row = json.loads(text)[0]
    return {"bt": row["bt"], "bz": row["bz_gsm"], "mag_time": row["time_tag"]}


def _scales(text):
    # "0" is now; "1".."3" are the next three days' forecasts; "-1" yesterday.
    now = json.loads(text)["0"]
    return {"scales": {k: int(now[k]["Scale"] or 0) for k in "RSG"}}


_HEADLINE = re.compile(
    r"^(ALERT|WARNING|EXTENDED WARNING|WATCH|SUMMARY|CANCEL \w+):\s*(.+)$", re.M)


def _alerts(text):
    """Alerts, warnings and watches issued in the last 24 hours, newest first."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    out = []
    for a in json.loads(text):
        issued = datetime.strptime(a["issue_datetime"][:19], "%Y-%m-%d %H:%M:%S")
        issued = issued.replace(tzinfo=timezone.utc)
        if issued < cutoff:
            continue
        m = _HEADLINE.search(a["message"])
        if not m:
            continue
        out.append({
            "issued": issued.isoformat(),
            "kind": m.group(1).title(),
            "text": m.group(2).strip(),
        })
    out.sort(key=lambda a: a["issued"], reverse=True)
    return {"alerts": out}


FEEDS = {
    "flux": ("/products/summary/10cm-flux.json", _flux),
    "sunspots": ("/text/daily-solar-indices.txt", _daily_solar),
    "a_index": ("/text/daily-geomagnetic-indices.txt", _daily_geomag),
    "kp": ("/products/noaa-planetary-k-index.json", _kp),
    "xray": ("/json/goes/primary/xray-flares-latest.json", _xray),
    "wind": ("/products/summary/solar-wind-speed.json", _wind),
    "mag": ("/products/summary/solar-wind-mag-field.json", _mag),
    "scales": ("/products/noaa-scales.json", _scales),
    "alerts": ("/products/alerts.json", _alerts),
}


async def refresh():
    for name, (path, parse) in FEEDS.items():
        try:
            state.update(parse(await fetch.get_text(BASE + path)))
            state["errors"].pop(name, None)
        except Exception as e:          # one bad feed must not stop the others
            state["errors"][name] = f"{type(e).__name__}: {e}"
            log.warning("SWPC %s: %s", name, state["errors"][name])
    state["updated"] = time.time()
