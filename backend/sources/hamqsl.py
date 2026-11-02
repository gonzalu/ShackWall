"""HF band conditions from N0NBH's solar-terrestrial feed at HAMQSL.com.

Paul N0NBH offers the feed free and asks two things: fetch it no more than
once an hour, which is how often it changes, and credit HAMQSL.com and the
people whose data it carries. His server sends no ETag or Last-Modified, so a
conditional request can't save him anything; instead the last copy is kept on
disk, and a restart within the hour reads that rather than asking again.

The solar numbers in the feed duplicate what swpc.py reads from NOAA directly,
so only what HAMQSL adds is kept: its band calls, VHF openings and noise.
"""
import logging
import time
import xml.etree.ElementTree as ET
from pathlib import Path

from .. import fetch

log = logging.getLogger("shackwall.hamqsl")

URL = "https://www.hamqsl.com/solarxml.php"
# Asked for at most once an hour. The loop looks more often than that only so a
# restart that found a 50-minute-old copy fetches 10 minutes later, not 60.
FETCH_EVERY_S = 3600
INTERVAL_S = 300
CACHE = Path(__file__).resolve().parents[2] / "data" / "hamqsl.xml"

state = {"updated": None, "errors": {}}


def _text(root, tag):
    el = root.find(tag)
    value = (el.text or "").strip() if el is not None else ""
    return value or None


def parse(xml):
    d = ET.fromstring(xml).find("solardata")
    bands = {}
    for b in d.iterfind("calculatedconditions/band"):
        bands.setdefault(b.get("name"), {})[b.get("time")] = (b.text or "").strip()
    vhf = {f"{p.get('name')}/{p.get('location')}": (p.text or "").strip()
           for p in d.iterfind("calculatedvhfconditions/phenomenon")}
    return {
        "issued": _text(d, "updated"),
        "bands": [{"name": n, **times} for n, times in bands.items()],
        "noise": _text(d, "signalnoise"),
        "geomag": _text(d, "geomagfield"),
        "muf": _text(d, "muf"),
        "vhf": vhf,
    }


async def refresh():
    try:
        age = time.time() - CACHE.stat().st_mtime
    except OSError:
        age = None
    try:
        if age is not None and age < FETCH_EVERY_S:
            xml = CACHE.read_text(encoding="utf-8")
            fetched = time.time() - age
        else:
            xml = await fetch.get_text(URL)
            parse(xml)                  # don't keep a copy we can't read
            CACHE.parent.mkdir(exist_ok=True)
            CACHE.write_text(xml, encoding="utf-8")
            fetched = time.time()
        state.update(parse(xml))
        state["updated"] = fetched
        state["errors"].pop("feed", None)
    except Exception as e:              # keep showing the last good conditions
        state["errors"]["feed"] = f"{type(e).__name__}: {e}"
        log.warning("HAMQSL: %s", state["errors"]["feed"])
