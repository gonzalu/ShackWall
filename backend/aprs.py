"""Just enough of the APRS packet format to put stations on a map.

Decodes the position formats nearly all stations send, following the APRS
1.0.1 specification: uncompressed and compressed positions (with or without a
timestamp), objects and items, and Mic-E, which most mobile radios use. From a
weather station's position it also reads temperature and wind. Anything else
(messages, telemetry, status) returns None, because it has no place on a map.

Written here rather than taken from a library because the one widely used
Python APRS parser is GPLv2, which doesn't sit with ShackWall's Apache licence.
"""
import re

# Symbol code on the primary table ('/') -> what the station is, for drawing.
# Overlays and the alternate table ('\\') mostly mean the same thing for codes
# listed here; anything not listed is drawn as "other".
KINDS = {
    ">": "mobile", "k": "mobile", "j": "mobile", "v": "mobile", "u": "mobile",
    "<": "mobile", "b": "mobile", "R": "mobile", "U": "mobile", "[": "mobile",
    "s": "mobile", "Y": "mobile", "a": "mobile", "f": "mobile", "O": "mobile",
    "^": "mobile", "'": "mobile",
    "-": "home", "y": "home",
    "_": "weather", "W": "weather",
    "#": "digi", "&": "igate", "r": "igate",
}


def _base91(s):
    n = 0
    for c in s:
        n = n * 91 + ord(c) - 33
    return n


def _uncompressed(body):
    """'4053.75N/07352.50W>comment' -> lat, lon, table, code, rest."""
    m = re.match(r"(\d{2})([\d ]{2}\.[\d ]{2})([NS])(.)(\d{3})([\d ]{2}\.[\d ]{2})([EW])(.)", body)
    if not m:
        return None
    # Position ambiguity: a station blanks trailing digits with spaces to be
    # vaguer about where it is. The spec says to plot the middle of the box.
    blanks = m.group(2).count(" ")
    half = (0, 0.05, 0.5, 5, 30)[min(blanks, 4)]
    lat = int(m.group(1)) + (float(m.group(2).replace(" ", "0")) + half) / 60
    lon = int(m.group(5)) + (float(m.group(6).replace(" ", "0")) + half) / 60
    if m.group(3) == "S":
        lat = -lat
    if m.group(7) == "W":
        lon = -lon
    return lat, lon, m.group(4), m.group(8), body[m.end():]


def _compressed(body):
    """'/5L!!<*e7>{?!' style: table, 4+4 base-91 lat/lon, code, course/speed."""
    if len(body) < 13 or not re.match(r"[/\\A-Za-j]", body[0]):
        return None
    lat = 90 - _base91(body[1:5]) / 380926
    lon = -180 + _base91(body[5:9]) / 190463
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    out = [lat, lon, body[0], body[9], body[13:]]
    cs = body[10:12]
    if cs[0] != " " and ord(body[12]) - 33 & 0x18 != 0x10 and "!" <= cs[0] <= "z":
        course, speed = (ord(cs[0]) - 33) * 4, 1.08 ** (ord(cs[1]) - 33) - 1
        out.append((course, speed))
    return out


def _position(body):
    p = _uncompressed(body) or _compressed(body)
    if not p:
        return None
    lat, lon, table, code, rest = p[:5]
    # The !DAO! extension adds a digit of precision to each coordinate, as a
    # decimal digit ('W') or base 91 ('w'), in thousandths of a minute.
    dao = re.search(r"!([Ww])(.)(.)!", rest)
    if dao and len(p) == 5:
        if dao.group(1) == "W" and dao.group(2).isdigit() and dao.group(3).isdigit():
            extra = (int(dao.group(2)) * 0.001, int(dao.group(3)) * 0.001)
        elif dao.group(1) == "w":
            extra = tuple((ord(c) - 33) / 91 * 0.01 for c in dao.group(2, 3))
        else:
            extra = (0, 0)
        lat += (extra[0] if lat >= 0 else -extra[0]) / 60
        lon += (extra[1] if lon >= 0 else -extra[1]) / 60
        rest = rest[:dao.start()] + rest[dao.end():]
    pos = {"lat": round(lat, 5), "lon": round(lon, 5), "table": table, "symbol": code}
    m = re.match(r"(\d{3})/(\d{3})", rest)
    if len(p) > 5:
        pos["course"], pos["speed_kn"] = round(p[5][0]), round(p[5][1])
    elif m and code != "_":
        pos["course"], pos["speed_kn"] = int(m.group(1)), int(m.group(2))
        rest = rest[7:]
    if code == "_":
        pos.update(_weather(rest))
        rest = ""
    pos["comment"] = _tidy(rest)
    return pos


def _tidy(comment):
    """Drop the machine-readable extensions (altitude, PHG, range) from a
    comment, leaving what the operator wrote."""
    comment = re.sub(r"/A=-?\d{6}|PHG\d{4}/?|RNG\d{4}|DFS\d{4}", " ", comment)
    return re.sub(r"\s+", " ", comment).strip(" /")[:80]


def _weather(rest):
    """Wind direction/speed, gust and temperature from a weather report."""
    w = {}
    m = re.match(r"(\d{3}|\.{3})/(\d{3}|\.{3})", rest)
    if m and m.group(1).isdigit():
        w["wind_dir"] = int(m.group(1))
    if m and m.group(2).isdigit():
        w["wind_mph"] = int(m.group(2))
    for key, pattern in (("gust_mph", r"g(\d{3})"), ("temp_f", r"t(-?\d{2,3})")):
        found = re.search(pattern, rest)
        if found:
            w[key] = int(found.group(1))
    return w


def _mic_e(dest, info):
    """Mic-E: latitude in the destination callsign, the rest in the info field."""
    dest = dest.split("-")[0]
    if len(dest) < 6 or len(info) < 9:
        return None
    digits = []
    for c in dest[:6]:
        if c.isdigit():
            digits.append(int(c))
        elif "A" <= c <= "J":
            digits.append(ord(c) - ord("A"))
        elif "P" <= c <= "Y":
            digits.append(ord(c) - ord("P"))
        elif c in "KLZ":
            digits.append(0)
        else:
            return None
    lat = digits[0] * 10 + digits[1] + (digits[2] * 10 + digits[3] + (digits[4] * 10 + digits[5]) / 100) / 60
    north = "P" <= dest[3] <= "Z"
    offset = "P" <= dest[4] <= "Z"
    west = "P" <= dest[5] <= "Z"
    d = ord(info[1]) - 28 + (100 if offset else 0)
    if 180 <= d <= 189:
        d -= 80
    elif 190 <= d <= 199:
        d -= 190
    m = ord(info[2]) - 28
    if m >= 60:
        m -= 60
    h = ord(info[3]) - 28
    lon = d + (m + h / 100) / 60
    sp, dc, se = ord(info[4]) - 28, ord(info[5]) - 28, ord(info[6]) - 28
    speed = sp * 10 + dc // 10
    course = (dc % 10) * 100 + se
    if speed >= 800:
        speed -= 800
    if course >= 400:
        course -= 400
    if not (0 <= lat <= 90 and 0 <= lon <= 180):
        return None
    # The comment can start with a radio-type byte and a base-91 altitude
    # ("xxx}"), and end with a code naming the radio's maker: not for people.
    comment = re.sub(r"^[`'>\]]", "", info[9:])
    comment = re.sub(r"^.{3}\}", "", comment)
    comment = re.sub(r'(_[ "%)(0-9]|[=^]|_)$', "", comment.rstrip())
    return {"lat": round(lat if north else -lat, 5), "lon": round(-lon if west else lon, 5),
            "table": info[8], "symbol": info[7], "course": course, "speed_kn": speed,
            "comment": _tidy(comment)}


def parse(line):
    """A TNC2-format line -> {"call", "via", ...position} or None."""
    head, sep, info = line.partition(":")
    if not sep or ">" not in head or not info:
        return None
    src, _, path = head.partition(">")
    dest, *via = path.split(",")
    kind = info[0]
    pos, call = None, src
    if kind in "!=":
        pos = _position(info[1:])
    elif kind in "/@":
        pos = _position(info[8:])
    elif kind == ";" and len(info) > 18:
        call = info[1:10].strip()
        if info[10] == "_":                 # a killed object: gone from the map
            return {"call": call, "killed": True}
        pos = _position(info[18:])
    elif kind == ")":
        m = re.match(r"\)([^!_]{3,9})([!_])", info)
        if m:
            call = m.group(1)
            if m.group(2) == "_":
                return {"call": call, "killed": True}
            pos = _position(info[m.end():])
    elif kind in "`'":
        pos = _mic_e(dest, info)
    if not pos:
        return None
    pos["call"] = call
    pos["object"] = call != src
    pos["by"] = src
    # q constructs name how the packet reached APRS-IS: qAR/qAo through an
    # IGate that heard it on RF, qAC/qAS/qAX straight from the internet.
    q = next((v for v in via if v.startswith("qA")), "")
    pos["rf"] = q in ("qAR", "qAr", "qAo", "qAO")
    pos["kind"] = "object" if pos["object"] else KINDS.get(pos["symbol"], "other")
    return pos
