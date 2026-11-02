"""Parks on the Air activator spots.

api.pota.app is the API behind pota.app itself. POTA publishes no terms for
it, and third-party spotting tools have read it for years, so it is read
here the way pota.app's own spot page does, from one client for all screens,
every two minutes. Its responses carry no ETag or Cache-Control.

POTA's logo needs a licence to be used in software; ShackWall shows text only.

SOTA spots are deliberately not here: the SOTA API's terms forbid software
written with AI from connecting without the SOTA Management Team's approval.
"""
import json
import logging
import math
import time
from datetime import datetime, timezone

from .. import config, fetch

log = logging.getLogger("shackwall.pota")

URL = "https://api.pota.app/spot/activator"
INTERVAL_S = 120

# Amateur bands by lower and upper edge in kHz (ITU Region 2).
BANDS = [
    ("160m", 1800, 2000), ("80m", 3500, 4000), ("60m", 5330, 5410),
    ("40m", 7000, 7300), ("30m", 10100, 10150), ("20m", 14000, 14350),
    ("17m", 18068, 18168), ("15m", 21000, 21450), ("12m", 24890, 24990),
    ("10m", 28000, 29700), ("6m", 50000, 54000), ("2m", 144000, 148000),
    ("70cm", 420000, 450000),
]

state = {"updated": None, "errors": {}}


def band(khz):
    for name, lo, hi in BANDS:
        if lo <= khz <= hi:
            return name
    return None


def distance_bearing(lat1, lon1, lat2, lon2):
    """Great-circle distance in km and initial bearing in degrees."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    km = 2 * 6371.0 * math.asin(math.sqrt(a))
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return km, (math.degrees(math.atan2(y, x)) + 360) % 360


def parse(spots):
    out = []
    for s in spots:
        if s.get("invalid"):
            continue
        try:
            khz = float(s["frequency"])
        except (TypeError, ValueError):
            continue
        spot = {
            "activator": s["activator"],
            "khz": khz,
            "band": band(khz),
            "mode": (s.get("mode") or "").upper(),
            "reference": s["reference"],
            "park": s.get("name") or s.get("parkName"),
            "location": s.get("locationDesc"),
            "grid": s.get("grid6") or s.get("grid4"),
            "time": datetime.fromisoformat(s["spotTime"]).replace(tzinfo=timezone.utc).isoformat(),
            "spots": s.get("count"),
            "comments": s.get("comments") or "",
            # An activator signing off says QRT; the spot stays up until it expires.
            "qrt": "QRT" in (s.get("comments") or "").upper(),
        }
        if s.get("latitude") is not None and (config.LAT or config.LON):
            km, brg = distance_bearing(config.LAT, config.LON, s["latitude"], s["longitude"])
            spot.update(km=round(km), bearing=round(brg), lat=s["latitude"], lon=s["longitude"])
        out.append(spot)
    out.sort(key=lambda s: s["time"], reverse=True)
    return out


async def refresh():
    try:
        state["spots"] = parse(json.loads(await fetch.get_text(URL)))
        state["errors"].pop("spots", None)
        state["updated"] = time.time()
    except Exception as e:              # keep showing the last good spots
        state["errors"]["spots"] = f"{type(e).__name__}: {e}"
        log.warning("POTA: %s", state["errors"]["spots"])
