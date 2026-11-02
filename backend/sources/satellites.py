"""Amateur satellite passes over the station, predicted locally.

Orbits come from CelesTrak's amateur group, in the OMM JSON format CelesTrak
recommends now that catalogue numbers are outgrowing the old TLE columns.
CelesTrak checks for new data every two hours and blocks clients that ask
more often, so the last download is kept on disk and only replaced once it is
older than ORBITS_EVERY_S, restarts included.

Frequencies come from the SatNOGS DB, crowd-sourced and published under CC
BY-SA 4.0 (credited on the page). Its list of active transmitters is one
request, kept on disk and refreshed daily.

The passes themselves are computed here with Skyfield's SGP4, every few
minutes, from those two files. No pass service is asked anything.
"""
import json
import logging
import re
import time
from datetime import timedelta
from pathlib import Path

from skyfield.api import EarthSatellite, load, wgs84

from .. import config, fetch

log = logging.getLogger("shackwall.satellites")

ORBITS_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=json"
TRANSMITTERS_URL = "https://db.satnogs.org/api/transmitters/?status=active&format=json"
DATA = Path(__file__).resolve().parents[2] / "data"
ORBITS_FILE = DATA / "celestrak-amateur.json"
TRANSMITTERS_FILE = DATA / "satnogs-transmitters.json"
# The amateur group's elements change two or three times a day; six hours
# keeps an ISS pass right to a few seconds without making CelesTrak work.
ORBITS_EVERY_S = 6 * 3600
TRANSMITTERS_EVERY_S = 24 * 3600

INTERVAL_S = 300
HOURS_AHEAD = 24
# Passes that get a sky track for the page's plot; the rest are listed only.
TRACKED_PASSES = 6
TRACK_STEP_S = 20

# Ham-radio voice and linear modes. Digipeaters and telemetry beacons are left
# out of the frequency line: they are not what you'd point a handheld at.
VOICE_MODES = {"FM", "USB", "LSB", "CW", "SSB"}

ts = load.timescale(builtin=True)       # bundled leap seconds; nothing downloaded
state = {"updated": None, "errors": {}}


# A failed download isn't retried for this long: CelesTrak counts failed
# requests toward a block just as it counts successful ones.
RETRY_S = 2 * 3600
_last_try = {}


async def _cached(url, path, max_age):
    """The body at url, from disk if the copy there is younger than max_age.

    When a download is due but fails, or failed less than RETRY_S ago, the
    older copy on disk is used, if there is one.
    """
    try:
        age = time.time() - path.stat().st_mtime
    except OSError:
        age = None
    due = age is None or age >= max_age
    if due and time.time() - _last_try.get(url, 0) >= RETRY_S:
        _last_try[url] = time.time()
        try:
            body = await fetch.get_text(url)
            json.loads(body)            # don't keep a copy we can't read
            path.parent.mkdir(exist_ok=True)
            path.write_text(body, encoding="utf-8")
            return body
        except Exception:
            if age is None:
                raise
            log.warning("%s: download failed, using the copy from %.1f h ago",
                        url, age / 3600, exc_info=True)
    if age is None:
        raise RuntimeError(f"no copy of {url} yet; next try within {RETRY_S // 3600} h")
    return path.read_text(encoding="utf-8")


# OSCAR numbers CelesTrak's names leave out.
OSCAR = {43017: "AO-91"}


def short_name(name, norad=None):
    """'SAUDISAT 1C (SO-50)' -> 'SO-50', 'ISS (ZARYA)' -> 'ISS'."""
    if norad in OSCAR:
        return OSCAR[norad]
    if name.startswith("ISS"):
        return "ISS"
    m = re.search(r"\(([A-Z]+-\d+\w*)\)", name) or re.match(r"([A-Z]+-\d+)", name)
    return m.group(1) if m else name


def _frequencies(transmitters, norad):
    out = []
    for t in transmitters:
        if t.get("norad_cat_id") != norad or t.get("mode") not in VOICE_MODES:
            continue
        if t["type"] not in ("Transceiver", "Transponder") or not t.get("downlink_low"):
            continue
        out.append({
            "description": t["description"],
            "mode": t["mode"],
            "uplink_mhz": t["uplink_low"] / 1e6 if t.get("uplink_low") else None,
            "downlink_mhz": t["downlink_low"] / 1e6,
            "inverting": bool(t.get("invert")),
        })
    return out


def _passes(sat, here, t0, t1):
    """Rise, culmination and set of each pass, at the horizon."""
    times, events = sat.find_events(here, t0, t1, altitude_degrees=0)
    out, current = [], None
    for t, e in zip(times, events):
        if e == 0:
            current = {"aos": t}
        elif e == 1 and current is not None:
            current["tca"] = t
        elif e == 2:
            if current is None:         # already above the horizon at t0
                current = {"aos": t0}
            current["los"] = t
            if "tca" in current:
                out.append(current)
            current = None
    return out


def _look(sat, here, t):
    alt, az, _ = (sat - here).at(t).altaz()
    return round(az.degrees, 1), round(alt.degrees, 1)


def predict(orbits, transmitters, now=None):
    here = wgs84.latlon(config.LAT, config.LON)
    t0 = ts.now() if now is None else ts.from_datetime(now)
    t1 = t0 + timedelta(hours=HOURS_AHEAD)
    wanted = set(config.SATELLITES)
    passes, sats = [], []
    for omm in orbits:
        norad = omm["NORAD_CAT_ID"]
        if norad not in wanted:
            continue
        sat = EarthSatellite.from_omm(ts, omm)
        name = short_name(omm["OBJECT_NAME"], norad)
        sats.append({"norad": norad, "name": name, "epoch": omm["EPOCH"],
                     "frequencies": _frequencies(transmitters, norad)})
        for p in _passes(sat, here, t0, t1):
            az_aos, _ = _look(sat, here, p["aos"])
            az_los, _ = _look(sat, here, p["los"])
            _, max_el = _look(sat, here, p["tca"])
            if max_el < config.SAT_MIN_ELEVATION:
                continue
            passes.append({"norad": norad, "name": name,
                           "aos": p["aos"].utc_iso(), "tca": p["tca"].utc_iso(),
                           "los": p["los"].utc_iso(), "max_el": max_el,
                           "aos_az": az_aos, "los_az": az_los, "_sat": sat, "_t": p})
    passes.sort(key=lambda p: p["aos"])
    for p in passes[:TRACKED_PASSES]:
        a, b = p["_t"]["aos"], p["_t"]["los"]
        n = max(2, int((b - a) * 86400 / TRACK_STEP_S) + 1)
        times = ts.linspace(a, b, n)
        alt, az, _ = (p["_sat"] - here).at(times).altaz()
        p["track"] = [[t.utc_iso(), round(z, 1), round(e, 1)]
                      for t, z, e in zip(times, az.degrees, alt.degrees)]
    for p in passes:
        del p["_sat"], p["_t"]
    missing = wanted - {s["norad"] for s in sats}
    return {"satellites": sats, "passes": passes, "missing": sorted(missing)}


async def refresh():
    if not (config.LAT or config.LON):
        state["errors"]["location"] = "set LAT and LON, or GRID, in shackwall.env"
        return
    try:
        orbits = json.loads(await _cached(ORBITS_URL, ORBITS_FILE, ORBITS_EVERY_S))
        state["errors"].pop("orbits", None)
    except Exception as e:
        state["errors"]["orbits"] = f"{type(e).__name__}: {e}"
        log.warning("CelesTrak: %s", state["errors"]["orbits"])
        return
    try:
        transmitters = json.loads(await _cached(TRANSMITTERS_URL, TRANSMITTERS_FILE, TRANSMITTERS_EVERY_S))
        state["errors"].pop("transmitters", None)
    except Exception as e:
        state["errors"]["transmitters"] = f"{type(e).__name__}: {e}"
        log.warning("SatNOGS: %s", state["errors"]["transmitters"])
        transmitters = []
    state.update(predict(orbits, transmitters))
    state["updated"] = time.time()
