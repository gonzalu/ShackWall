"""Where the sun is, worked out locally from the date and time.

The NOAA solar calculator's equations, accurate to well under a degree, which
is plenty to tell day from night at the station.
"""
import math
import time


def elevation(lat, lon, t=None):
    """The sun's angle above the horizon, in degrees, at lat/lon at time t."""
    t = time.time() if t is None else t
    days = t / 86400 - 10957.5                  # days since 2000-01-01 12:00 UTC
    g = math.radians((357.529 + 0.98560028 * days) % 360)   # mean anomaly
    q = (280.459 + 0.98564736 * days) % 360                 # mean longitude
    ecl_lon = math.radians(q + 1.915 * math.sin(g) + 0.020 * math.sin(2 * g))
    obliquity = math.radians(23.439 - 0.00000036 * days)
    decl = math.asin(math.sin(obliquity) * math.sin(ecl_lon))
    ra = math.degrees(math.atan2(math.cos(obliquity) * math.sin(ecl_lon),
                                 math.cos(ecl_lon)))
    gmst = (280.46061837 + 360.98564736629 * days) % 360
    hour_angle = math.radians(gmst + lon - ra)
    lat = math.radians(lat)
    return math.degrees(math.asin(
        math.sin(lat) * math.sin(decl)
        + math.cos(lat) * math.cos(decl) * math.cos(hour_angle)))
