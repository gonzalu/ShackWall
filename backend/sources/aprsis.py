"""APRS stations near the station, live from APRS-IS.

One receive-only connection to the APRS-IS filtered port (14580), logged in
the way APRS-IS documents for clients that never transmit: your callsign with
an SSID that no radio of yours uses, passcode -1, and the software's name and
version. A range filter asks the server for only the stations within
APRS_RANGE_KM, so nothing else crosses the wire.

aprs.fi is not used: its API terms allow fetching only while someone is
actively looking at the page, which a wall display never is.
"""
import asyncio
import logging
import time

from .. import aprs, config
from .pota import distance_bearing

log = logging.getLogger("shackwall.aprs")

PORT = 14580
WINDOW_S = 60 * 60          # stations not heard for an hour drop off
TRAIL_POINTS = 30           # positions kept per moving station
SUMMARY_EVERY_S = 15
SILENCE_S = 120             # servers send a comment line every ~20 s
RETRY_S = (10, 600)

state = {"updated": None, "errors": {}}
_stations = {}              # call -> latest position, plus its trail
_packets = []               # arrival times, for packets per minute


def _login():
    return (f"user {config.APRS_LOGIN} pass -1 vers ShackWall {config.VERSION} "
            f"filter r/{config.LAT:.4f}/{config.LON:.4f}/{config.APRS_RANGE_KM:.0f}\r\n")


def _ingest(line, now):
    _packets.append(now)
    p = aprs.parse(line)
    if not p:
        return
    if p.get("killed"):
        _stations.pop(p["call"], None)
        return
    old = _stations.get(p["call"])
    trail = old["trail"] if old else []
    if not trail or (trail[-1][0], trail[-1][1]) != (p["lat"], p["lon"]):
        trail.append((p["lat"], p["lon"], int(now)))
        del trail[:-TRAIL_POINTS]
    km, brg = distance_bearing(config.LAT, config.LON, p["lat"], p["lon"])
    _stations[p["call"]] = {**p, "km": round(km, 1), "bearing": round(brg),
                            "heard": int(now), "trail": trail}


def _summarise(now):
    cutoff = now - WINDOW_S
    for call in [c for c, s in _stations.items() if s["heard"] < cutoff]:
        del _stations[call]
    while _packets and _packets[0] < now - 60:
        _packets.pop(0)
    stations = sorted(_stations.values(), key=lambda s: -s["heard"])
    kinds = {}
    for s in stations:
        kinds[s["kind"]] = kinds.get(s["kind"], 0) + 1
    return {"stations": stations, "kinds": kinds, "per_minute": len(_packets),
            "range_km": config.APRS_RANGE_KM, "window_min": WINDOW_S // 60}


async def _summaries():
    while True:
        state.update(_summarise(time.time()))
        state["updated"] = time.time()
        await asyncio.sleep(SUMMARY_EVERY_S)


async def run():
    """Stay connected for as long as the backend runs, reconnecting politely."""
    if not config.CALLSIGN:
        state["errors"]["login"] = "set CALLSIGN in shackwall.env"
        return
    if not (config.LAT or config.LON):
        state["errors"]["location"] = "set LAT and LON, or GRID, in shackwall.env"
        return
    summaries = asyncio.create_task(_summaries())
    delay = RETRY_S[0]
    try:
        while True:
            writer = None
            try:
                reader, writer = await asyncio.wait_for(
                    asyncio.open_connection(config.APRS_SERVER, PORT), 30)
                await asyncio.wait_for(reader.readline(), 30)      # server banner
                writer.write(_login().encode())
                await writer.drain()
                log.info("APRS-IS: %s as %s, %g km round the station",
                         config.APRS_SERVER, config.APRS_LOGIN, config.APRS_RANGE_KM)
                state["errors"].pop("feed", None)
                while True:
                    raw = await asyncio.wait_for(reader.readline(), SILENCE_S)
                    if not raw:
                        raise ConnectionError("server closed the connection")
                    delay = RETRY_S[0]
                    line = raw.decode("latin-1").rstrip("\r\n")
                    if line.startswith("#"):
                        if "logresp" in line:
                            state["server"] = line.split()[-1]
                        continue
                    try:
                        _ingest(line, time.time())
                    except (ValueError, IndexError):
                        pass            # one odd packet isn't worth a reconnect
            except (OSError, asyncio.TimeoutError, ConnectionError) as e:
                state["errors"]["feed"] = f"{type(e).__name__}: {e}"
                log.warning("APRS-IS: %s; reconnecting in %d s", state["errors"]["feed"], delay)
            finally:
                if writer:
                    writer.close()
            await asyncio.sleep(delay)
            delay = min(delay * 2, RETRY_S[1])
    finally:
        summaries.cancel()
