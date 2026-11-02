"""Ships near the station, live from aisstream.io.

One WebSocket connection, from the server only: aisstream's rules forbid
browser connections and keep the API key on the server, so the screens only
ever see what this module passes on. It subscribes once, with compression
on, to a box AIS_RANGE_KM round the station and to the four message types
that carry positions and names. An account allows three connections at once,
so this uses one, and waits longer before each reconnect when the service is
having trouble (it has no SLA).

Without AISSTREAM_API_KEY the page is left out.
"""
import asyncio
import json
import logging
import math
import re
import time

import websockets

from .. import config
from .pota import distance_bearing

log = logging.getLogger("shackwall.ais")

URL = "wss://stream.aisstream.io/v0/stream"
TYPES = ["PositionReport", "StandardClassBPositionReport", "ShipStaticData", "StaticDataReport"]
# A moored ship reports every few minutes, a moving one every few seconds;
# one not heard for half an hour has gone.
WINDOW_S = 30 * 60
TRAIL_POINTS = 30
SUMMARY_EVERY_S = 15
SILENCE_S = 300             # the harbour is never this quiet: reconnect
RETRY_S = (30, 900)

state = {"updated": None, "errors": {}}
_ships = {}                 # mmsi -> what we know


def kind(type_code):
    """The AIS ship-type code as one of a few kinds a map can show."""
    t = type_code or 0
    if 70 <= t <= 79:
        return "cargo"
    if 80 <= t <= 89:
        return "tanker"
    if 60 <= t <= 69:
        return "passenger"
    if t in (31, 32, 50, 51, 52, 53, 54, 55, 58):
        return "service"            # tugs, pilots, rescue, police
    if t in (36, 37):
        return "pleasure"
    return "other"


NAV_STATUS = {1: "at anchor", 5: "moored", 6: "aground", 2: "not under command",
              3: "restricted", 7: "fishing"}


def _box():
    dlat = config.AIS_RANGE_KM / 111.0
    dlon = config.AIS_RANGE_KM / (111.0 * max(math.cos(math.radians(config.LAT)), 0.1))
    return [[[config.LAT - dlat, config.LON - dlon], [config.LAT + dlat, config.LON + dlon]]]


def _clean(s):
    return (s or "").replace("@", " ").strip() or None


def _destination(text):
    """A destination as the crew typed it, or None if it is only codes.

    Crews type anything: "NEW YORK CITY", "USNYC>USORF" (from one UN port
    code to another), or strings like "US^0MEE>0YEC" that only their own
    systems read. The arrow is kept as an arrow; anything with the
    characters those codes use is dropped.
    """
    text = _clean(text)
    if not text or re.search(r"[\^~@#*]", text):
        return None
    return re.sub(r"\s*>\s*", " → ", text)


def _ingest(m, now):
    meta = m.get("MetaData") or {}
    mmsi = meta.get("MMSI")
    kind_ = m.get("MessageType")
    body = (m.get("Message") or {}).get(kind_) or {}
    if not mmsi or not body:
        return
    s = _ships.setdefault(mmsi, {"mmsi": mmsi, "trail": []})
    if meta.get("ShipName", "").strip():
        s["name"] = _clean(meta["ShipName"])
    if kind_ in ("PositionReport", "StandardClassBPositionReport"):
        lat, lon = body.get("Latitude"), body.get("Longitude")
        if lat is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return
        s.update(lat=round(lat, 5), lon=round(lon, 5), heard=int(now),
                 sog=body.get("Sog") if (body.get("Sog") or 0) < 102.3 else None,
                 cog=body.get("Cog") if (body.get("Cog") or 0) < 360 else None,
                 heading=body.get("TrueHeading") if body.get("TrueHeading", 511) < 360 else None)
        if "NavigationalStatus" in body:
            s["status"] = NAV_STATUS.get(body["NavigationalStatus"])
        if not s["trail"] or s["trail"][-1][:2] != [s["lat"], s["lon"]]:
            s["trail"].append([s["lat"], s["lon"]])
            del s["trail"][:-TRAIL_POINTS]
        km, brg = distance_bearing(config.LAT, config.LON, lat, lon)
        s["km"], s["bearing"] = round(km, 1), round(brg)
    elif kind_ == "ShipStaticData":
        dim = body.get("Dimension") or {}
        s.update(name=_clean(body.get("Name")) or s.get("name"), type=body.get("Type"),
                 callsign=_clean(body.get("CallSign")), destination=_destination(body.get("Destination")),
                 length_m=(dim.get("A") or 0) + (dim.get("B") or 0) or None)
    elif kind_ == "StaticDataReport":
        a, b = body.get("ReportA") or {}, body.get("ReportB") or {}
        if a.get("Valid") and _clean(a.get("Name")):
            s["name"] = _clean(a["Name"])
        if b.get("Valid"):
            dim = b.get("Dimension") or {}
            s.update(type=b.get("ShipType") or s.get("type"), callsign=_clean(b.get("CallSign")),
                     length_m=(dim.get("A") or 0) + (dim.get("B") or 0) or s.get("length_m"))
    s["kind"] = kind(s.get("type"))


def _summarise(now):
    for mmsi in [k for k, s in _ships.items() if s.get("heard", now) < now - WINDOW_S]:
        del _ships[mmsi]
    ships = [s for s in _ships.values() if "lat" in s]
    ships.sort(key=lambda s: s["km"])
    kinds = {}
    for s in ships:
        kinds[s["kind"]] = kinds.get(s["kind"], 0) + 1
    return {"ships": ships, "kinds": kinds, "range_km": config.AIS_RANGE_KM,
            "window_min": WINDOW_S // 60}


async def _summaries():
    while True:
        state.update(_summarise(time.time()))
        state["updated"] = time.time()
        await asyncio.sleep(SUMMARY_EVERY_S)


async def run():
    if not config.AISSTREAM_API_KEY:
        state["disabled"] = True
        return
    if not (config.LAT or config.LON):
        state["errors"]["location"] = "set LAT and LON, or GRID, in shackwall.env"
        return
    summaries = asyncio.create_task(_summaries())
    delay = RETRY_S[0]
    try:
        while True:
            try:
                async with websockets.connect(URL, compression="deflate", open_timeout=30,
                                              user_agent_header=config.user_agent()) as ws:
                    await ws.send(json.dumps({"APIKey": config.AISSTREAM_API_KEY,
                                              "BoundingBoxes": _box(), "FilterMessageTypes": TYPES}))
                    log.info("aisstream: subscribed to %g km round the station", config.AIS_RANGE_KM)
                    while True:
                        m = json.loads(await asyncio.wait_for(ws.recv(), SILENCE_S))
                        if "error" in m:
                            raise ConnectionError(m["error"])
                        if m.get("MessageType") == "SubscriptionConfirmation":
                            state["errors"].pop("feed", None)
                            delay = RETRY_S[0]
                            continue
                        try:
                            _ingest(m, time.time())
                        except (TypeError, ValueError, KeyError):
                            pass        # one odd message isn't worth a reconnect
            except (OSError, asyncio.TimeoutError, ConnectionError,
                    websockets.exceptions.WebSocketException) as e:
                state["errors"]["feed"] = f"{type(e).__name__}: {e}"
                log.warning("aisstream: %s; reconnecting in %d s", state["errors"]["feed"], delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, RETRY_S[1])
    finally:
        summaries.cancel()
