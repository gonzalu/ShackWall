import asyncio
import hashlib
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from . import config, fetch, sun
from .sources import ais, aircraft, aprsis, hamqsl, nws, pota, pskreporter, satellites, swpc

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("shackwall")

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

# Every data source is a module with a state dict and either refresh() and
# INTERVAL_S, or run() for a live connection.
# Each runs in its own loop on its own schedule, so a slow or broken provider
# never holds up the others, and the API only ever reads what they last stored.
SOURCES = {"spaceweather": swpc, "bands": hamqsl, "weather": nws,
           "satellites": satellites, "pota": pota, "psk": pskreporter,
           "aprs": aprsis, "aircraft": aircraft,
           "ships": ais}


async def _loop(name, source):
    # A source fed by a live connection rather than polled has a run() that
    # never returns; the rest are refreshed on their own interval.
    if hasattr(source, "run"):
        try:
            await source.run()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("%s stopped", name)
        return
    while True:
        try:
            await source.refresh()
        except Exception:
            log.exception("%s refresh failed", name)
        await asyncio.sleep(source.INTERVAL_S)


def _log_config():
    log.info("ShackWall %s, settings from %s, User-Agent %r",
             config.VERSION, config.CONFIG_SOURCE or "environment and defaults",
             config.user_agent())
    if not config.CALLSIGN:
        log.warning("CALLSIGN is not set. Copy shackwall.env.example to "
                    "shackwall.env and fill in your station.")
    if not config.CONTACT_EMAIL:
        log.warning("CONTACT_EMAIL is not set. Data providers see a User-Agent "
                    "with no way to reach you, which makes a block likelier "
                    "than an email if something goes wrong.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    _log_config()
    tasks = [asyncio.create_task(_loop(n, s)) for n, s in SOURCES.items()]
    yield
    for t in tasks:
        t.cancel()
    await fetch.close()


app = FastAPI(lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024)


def _build_id():
    """Fingerprint of the frontend files, so a display can notice a redeploy.

    A cast page never reloads by itself, so the page compares this with what it
    started with and reloads when it changes. Computed per request, because
    updating the frontend doesn't need a backend restart.
    """
    try:
        stamps = [f"{p.name}:{p.stat().st_mtime_ns}"
                  for p in sorted(FRONTEND_DIR.glob("*")) if p.is_file()]
    except OSError:
        return "unknown"
    return hashlib.sha1("|".join(stamps).encode()).hexdigest()[:12]


@app.get("/api/state")
async def get_state():
    return {
        "build": _build_id(),
        "server_time": time.time(),
        "station": {
            "callsign": config.CALLSIGN,
            "grid": config.GRID,
            "city": config.CITY,
            "cq_zone": config.CQ_ZONE,
            "itu_zone": config.ITU_ZONE,
            "timezone": config.TIMEZONE,
            "lat": config.LAT,
            "lon": config.LON,
            "sun_elevation": round(sun.elevation(config.LAT, config.LON), 1),
            "wind_watch_mph": config.WIND_WATCH_MPH,
        },
        **{name: source.state for name, source in SOURCES.items()},
    }


@app.middleware("http")
async def always_revalidate(request, call_next):
    # Without this a browser heuristically caches app.js and a long-running
    # display keeps rendering an old build. ETags keep it a cheap 304.
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache"
    return response


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
