"""Aircraft overhead, from your own ADS-B receiver.

AIRCRAFT_URL points at either of two things on your network:

- FlightBoard's /api/aircraft, which merges several receivers and adds the
  route, airline and aircraft type it has looked up; or
- the aircraft.json any dump1090, readsb or tar1090 receiver serves
  (for example http://piaware.local/skyaware/data/aircraft.json).

Both are your own data on your own network, so it is read every few seconds.
Without AIRCRAFT_URL the page is simply left out.
"""
import json
import logging
import time

from .. import config, fetch
from .pota import distance_bearing

log = logging.getLogger("shackwall.aircraft")

INTERVAL_S = 5
# A receiver keeps an aircraft it last heard a minute ago; that's history,
# not traffic.
STALE_S = 60

state = {"updated": None, "errors": {}}


def _plain(a):
    """The fields the page uses, from either format."""
    out = {k: a.get(k) for k in ("hex", "lat", "lon", "alt_baro", "gs", "track",
                                 "baro_rate", "squawk", "category")}
    out["flight"] = (a.get("flight") or "").strip() or None
    if out["alt_baro"] == "ground":
        out["alt_baro"], out["on_ground"] = 0, True
    else:
        out["on_ground"] = bool(a.get("on_ground"))
    route = a.get("route") or {}
    info = a.get("aircraft_info") or {}
    out.update({
        "origin": route.get("origin"), "destination": route.get("destination"),
        "airline": route.get("airline") or info.get("owner"),
        "from_city": (route.get("from") or {}).get("city"),
        "to_city": (route.get("to") or {}).get("city"),
        "phase": route.get("phase"),
        "type": info.get("type_code") or a.get("t"),
        "registration": info.get("registration") or a.get("r"),
    })
    return out


def parse(data):
    planes = []
    for a in data.get("aircraft", []):
        if a.get("lat") is None or a.get("lon") is None:
            continue                    # heard, but no position to draw
        if (a.get("seen_pos") or 0) > STALE_S:
            continue
        p = _plain(a)
        km, brg = distance_bearing(config.LAT, config.LON, p["lat"], p["lon"])
        p["km"], p["bearing"] = round(km, 1), round(brg)
        planes.append(p)
    planes.sort(key=lambda p: p["km"])
    return {"aircraft": planes, "via": "FlightBoard" if "max_range_nm" in data else "receiver"}


async def refresh():
    if not config.AIRCRAFT_URL:
        state["disabled"] = True
        return
    try:
        state.update(parse(json.loads(await fetch.get_text(config.AIRCRAFT_URL))))
        state["errors"].pop("feed", None)
        state["updated"] = time.time()
    except Exception as e:              # keep the last good list
        state["errors"]["feed"] = f"{type(e).__name__}: {e}"
        log.warning("aircraft: %s", state["errors"]["feed"])
