"""Who is hearing the station's grid square, and who it hears, from PSKReporter.

Reports for one station only exist while it is on the air with a digital
mode, so ShackWall listens for the whole 4-character grid square instead:
every FT8, FT4, WSPR or CW-skimmer report with a sender or a receiver in it.
That shows where the bands are open from here whether or not your own rig is
on. Reports involving CALLSIGN itself are picked out too.

The reports come from mqtt.pskreporter.info, Tom M0LTE's live MQTT
redistribution of everything reported to pskreporter.info: no account, no
polling, one connection, filtered on the server to the two topics that name
the grid square. PSKReporter's own HTTP query API sits behind a Cloudflare bot
check that turns non-browser clients away, and ShackWall doesn't try to get
round a bot check.
"""
import asyncio
import json
import logging
import threading
import time

import paho.mqtt.client as mqtt

from .. import config
from .pota import BANDS, distance_bearing

log = logging.getLogger("shackwall.pskreporter")

HOST, PORT = "mqtt.pskreporter.info", 1884      # MQTT over TLS
# pskr/filter/v2/{band}/{mode}/{tx_call}/{rx_call}/{tx_grid}/{rx_grid}/{tx_dxcc}/{rx_dxcc}
TOPICS = ["pskr/filter/v2/+/+/+/+/{sq}/#", "pskr/filter/v2/+/+/+/+/+/{sq}/#"]
WINDOW_S = 30 * 60
SUMMARY_EVERY_S = 30
RETRY_S = (10, 600)                 # reconnect backoff, first and longest
# Points sent to the page: the most recent per grid square, band and
# direction, up to this many.
MAX_POINTS = 800
POINT_CALLS = 4         # stations named per dot

state = {"updated": None, "errors": {}}
_reports = {}           # (sender, receiver, band) -> newest report
# paho runs the connection on its own thread (asyncio-based MQTT clients need
# add_reader, which Windows' default event loop lacks); this guards _reports.
_lock = threading.Lock()


def _square():
    return config.GRID[:4].upper()


def _ingest(payload):
    s = json.loads(payload)
    if not s.get("b") or not s.get("t"):
        return
    report = {
        "t": int(s["t"]), "band": s["b"], "mode": s.get("md"), "snr": s.get("rp"),
        "sender": s.get("sc"), "receiver": s.get("rc"),
        "sender_loc": (s.get("sl") or "").upper(), "receiver_loc": (s.get("rl") or "").upper(),
    }
    with _lock:
        _reports[(s.get("sc"), s.get("rc"), s["b"])] = report


def _summarise():
    cutoff = time.time() - WINDOW_S
    with _lock:
        for k in [k for k, r in _reports.items() if r["t"] < cutoff]:
            del _reports[k]
        reports = list(_reports.values())
    sq, me = _square(), config.CALLSIGN
    points, bands, mine = {}, {}, []
    for r in reports:
        out = r["sender_loc"].startswith(sq)
        inc = r["receiver_loc"].startswith(sq)
        if out == inc:                  # both ends here (or neither): no path
            continue
        far_loc = r["receiver_loc"] if out else r["sender_loc"]
        pos = config.grid_centre(far_loc[:6] if len(far_loc) >= 6 else far_loc[:4])
        if not pos:
            continue
        km, brg = distance_bearing(config.LAT, config.LON, *pos)
        direction = "out" if out else "in"
        far = {"call": r["receiver"] if out else r["sender"], "loc": far_loc[:6],
               "km": round(km), "bearing": round(brg)}
        s = bands.setdefault(r["band"], {"band": r["band"], "out": 0, "in": 0,
                                         "far_out": None, "far_in": None})
        s[direction] += 1
        key = f"far_{direction}"
        if s[key] is None or km > s[key]["km"]:
            s[key] = far
        p = points.setdefault((direction, r["band"], far_loc[:4]), {
            "dir": direction, "band": r["band"], "square": far_loc[:4], "lat": pos[0], "lon": pos[1],
            "km": round(km), "bearing": round(brg), "n": 0, "t": 0, "calls": [], "modes": [], "snr": None})
        p["n"] += 1
        p["t"] = max(p["t"], r["t"])
        # A little about who's there, for the card a tap on the dot opens.
        if far["call"] and far["call"] not in p["calls"] and len(p["calls"]) < POINT_CALLS:
            p["calls"].append(far["call"])
        if r["mode"] and r["mode"] not in p["modes"]:
            p["modes"].append(r["mode"])
        if r["snr"] is not None and (p["snr"] is None or r["snr"] > p["snr"]):
            p["snr"] = r["snr"]
        if me and me in (r["sender"], r["receiver"]):
            mine.append({"dir": direction, "band": r["band"], "mode": r["mode"],
                         "snr": r["snr"], "t": r["t"], **far})
    order = [name for name, _, _ in BANDS]
    return {
        "square": sq,
        "window_min": WINDOW_S // 60,
        "bands": sorted(bands.values(), key=lambda s: order.index(s["band"])
                        if s["band"] in order else 99),
        "points": sorted(points.values(), key=lambda p: -p["t"])[:MAX_POINTS],
        "mine": sorted(mine, key=lambda m: -m["t"])[:50],
    }


async def _summaries():
    while True:
        state.update(_summarise())
        state["updated"] = time.time()
        await asyncio.sleep(SUMMARY_EVERY_S)


def _on_connect(client, userdata, flags, reason_code, properties):
    if reason_code.is_failure:
        state["errors"]["feed"] = f"connect refused: {reason_code}"
        return
    for topic in TOPICS:
        client.subscribe(topic.format(sq=_square()))
    state["errors"].pop("feed", None)
    log.info("PSKReporter: listening for %s on %s", _square(), HOST)


def _on_disconnect(client, userdata, flags, reason_code, properties):
    if reason_code != 0:
        state["errors"]["feed"] = f"disconnected: {reason_code}; reconnecting"
        log.warning("PSKReporter feed disconnected: %s", reason_code)


def _on_message(client, userdata, message):
    try:
        _ingest(message.payload)
    except (ValueError, TypeError):
        pass                            # one malformed spot isn't worth a fuss


async def run():
    """Stay subscribed for as long as the backend runs; paho reconnects itself."""
    if not config.GRID:
        state["errors"]["grid"] = "set GRID in shackwall.env"
        return
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.tls_set()
    client.reconnect_delay_set(*RETRY_S)
    client.on_connect, client.on_disconnect, client.on_message = _on_connect, _on_disconnect, _on_message
    client.connect_async(HOST, PORT, keepalive=60)
    client.loop_start()
    try:
        await _summaries()
    finally:
        client.loop_stop()
        client.disconnect()
