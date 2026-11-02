import os
import re
from pathlib import Path

# Settings are read from three places, first match wins:
#
#   1. the real environment  - a systemd unit, a container, `export` in a shell
#   2. shackwall.env         - a file of KEY=value lines beside this checkout
#   3. the defaults below
#
# The file is the format systemd's EnvironmentFile= reads, so the installed
# service and a manual `uvicorn` run share one file. Copy shackwall.env.example
# to shackwall.env to start. It holds your location and API keys, so it is
# gitignored.
ENV_FILE = Path(
    os.environ.get(
        "SHACKWALL_ENV_FILE",
        Path(__file__).resolve().parent.parent / "shackwall.env",
    )
)


def _load_env_file(path):
    """Parse KEY=value lines. Not a shell: no expansion, no multi-line values."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}                       # absent is the normal case, not an error
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):  # tolerated: people paste these from a shell
            line = line[7:].lstrip()
        key, sep, value = line.partition("=")
        if not sep:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


_from_file = _load_env_file(ENV_FILE)


def _get(name, default=""):
    """Environment, then the file, then the built-in default."""
    if name in os.environ:
        return os.environ[name]
    if name in _from_file:
        return _from_file[name]
    return default


def _float(name, default=0.0):
    try:
        return float(_get(name, default) or default)
    except ValueError:
        return default


CONFIG_SOURCE = str(ENV_FILE) if _from_file else None

VERSION = "0.1"
HOMEPAGE = "https://github.com/gonzalu/ShackWall"

CALLSIGN = _get("CALLSIGN").upper()
GRID = _get("GRID")
LICENCE_CLASS = _get("LICENCE_CLASS")
CITY = _get("CITY")
CQ_ZONE = _get("CQ_ZONE")
ITU_ZONE = _get("ITU_ZONE")


def grid_centre(grid):
    """(lat, lon) of the middle of a Maidenhead square, 4 or 6 characters."""
    g = grid.strip().upper()
    if not re.fullmatch(r"[A-R]{2}\d\d([A-X]{2})?", g):
        return None
    lon = (ord(g[0]) - 65) * 20 - 180 + int(g[2]) * 2
    lat = (ord(g[1]) - 65) * 10 - 90 + int(g[3])
    if len(g) == 6:
        lon += (ord(g[4]) - 65) / 12 + 1 / 24
        lat += (ord(g[5]) - 65) / 24 + 1 / 48
    else:
        lon += 1
        lat += 0.5
    return round(lat, 4), round(lon, 4)


# Your position. When LAT and LON are blank the middle of the grid square
# stands in: a 6-character square is about 5 x 4 km, close enough for day and
# night and the gray line, though not for a weather forecast.
LAT = _float("LAT")
LON = _float("LON")
if not (LAT or LON) and grid_centre(GRID):
    LAT, LON = grid_centre(GRID)
TIMEZONE = _get("TIMEZONE", "UTC")

# Wind gusts, in mph, at which the weather panel says to keep an eye on the
# antennas and to lower them. What your antennas can take is yours to judge.
WIND_WATCH_MPH = _float("WIND_WATCH_MPH", 30)
WIND_LOWER_MPH = _float("WIND_LOWER_MPH", 45)

# Satellites to predict passes for, by NORAD catalogue number. The default is
# the ISS and the FM and linear birds most hams work: SO-50, AO-27, AO-123,
# RS-44, AO-7, FO-29, JO-97, AO-73 and AO-91 (Fox-1B).
SATELLITES = [int(n) for n in re.findall(r"\d+", _get("SATELLITES")
              or "25544,27607,22825,61781,44909,7530,24278,43803,39444,43017")]
# Passes that never climb above this many degrees are left out.
SAT_MIN_ELEVATION = _float("SAT_MIN_ELEVATION", 10)

# APRS: a receive-only APRS-IS connection. The login must be unique across
# APRS, so it is your callsign with an SSID none of your radios uses.
# APRS_SERVER is a rotating address that picks a nearby server in your region:
# noam (North America), euro, asia, aunz or soam, or rotate for anywhere.
APRS_LOGIN = (_get("APRS_LOGIN") or (f"{CALLSIGN}-SW" if CALLSIGN else "")).upper()
APRS_SERVER = _get("APRS_SERVER") or "rotate.aprs2.net"
APRS_RANGE_KM = _float("APRS_RANGE_KM", 100)

# Aircraft from your own ADS-B receiver: FlightBoard's /api/aircraft, or the
# aircraft.json of any dump1090, readsb or tar1090. Blank leaves the page out.
AIRCRAFT_URL = _get("AIRCRAFT_URL")

# Sent in every request's User-Agent, so a data provider who sees a problem
# can write to you instead of blocking you.
CONTACT_EMAIL = _get("CONTACT_EMAIL")

AISSTREAM_API_KEY = _get("AISSTREAM_API_KEY")


def user_agent():
    contact = f"; {CONTACT_EMAIL}" if CONTACT_EMAIL else ""
    return f"ShackWall/{VERSION} (+{HOMEPAGE}{contact})"
