// ShackWall display. Reads /api/state from the backend; never talks to a data
// provider directly, so any number of screens cost the providers nothing extra.

const POLL_MS = 30_000;
const PAGE_MS = 20_000;            // how long each feature page stays up

let state = null;
let firstBuild = null;
// Server time minus this screen's time. A TV's own clock can be minutes out,
// and a shack clock that disagrees with the radio's is worse than none.
let clockOffsetMs = 0;

const $ = id => document.getElementById(id);

// Much of the state is text from outside: callsigns and comments sent over the
// air, names crews type into their ships' AIS, park names, forecasts. Any of it
// could hold HTML, and an APRS comment of <script>... must show as text, not
// run on every screen. So every string in the state is escaped once, as it
// arrives, and the page puts state text in with innerHTML from then on.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeAll(v) {
  if (typeof v === 'string') return v.replace(/[&<>"']/g, c => ESCAPES[c]);
  if (Array.isArray(v)) return v.map(escapeAll);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [escapeAll(k), escapeAll(x)]));
  return v;
}

function now() { return new Date(Date.now() + clockOffsetMs); }

function hhmm(date, timeZone) {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
}

function tickClocks() {
  const t = now();
  $('utc').textContent = hhmm(t, 'UTC');
  if (state) $('local').textContent = hhmm(t, state.station.timezone || undefined);
}

function ago(seconds) {
  if (seconds < 90) return 'just now';
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

function set(id, value, cls) {
  const el = $(id);
  el.innerHTML = value ?? '—';
  el.className = 'v' + (cls ? ' ' + cls : '');
}

// NOAA's own reading of Kp: below 4 quiet, 4 active, 5 and up a storm (G1+).
function kpClass(kp) { return kp >= 5 ? 'poor' : kp >= 4 ? 'fair' : 'good'; }

// X-ray class letter: M and X flares cause HF radio blackouts on the day side.
function xrayClass(c) { return !c ? '' : c[0] === 'X' ? 'poor' : c[0] === 'M' ? 'fair' : ''; }

function scaleColour(level) { return level >= 3 ? 'var(--poor)' : level >= 1 ? 'var(--fair)' : ''; }

function renderStation(s) {
  $('call').innerHTML = s.callsign || 'Set CALLSIGN';
  $('meta').innerHTML = [s.grid, s.city, s.cq_zone && `CQ ${s.cq_zone}`, s.itu_zone && `ITU ${s.itu_zone}`]
    .filter(Boolean).join(' · ');
}

function renderSpaceWeather(sw) {
  set('sfi', sw.sfi);
  set('ssn', sw.ssn);
  set('kp', sw.kp?.toFixed(sw.kp % 1 ? 1 : 0), sw.kp != null && kpClass(sw.kp));
  set('a', sw.a);
  set('xray', sw.xray, xrayClass(sw.xray));
  set('wind', sw.wind_kms);

  $('scales').innerHTML = Object.entries(sw.scales || {}).map(([k, level]) => {
    const colour = scaleColour(level);
    return `<span class="${colour ? 'active' : ''}" style="${colour ? 'background:' + colour : ''}">${k}${level}</span>`;
  }).join('');

  const age = sw.updated ? state.server_time - sw.updated : null;
  const el = $('solar-age');
  el.textContent = age == null ? 'waiting for data' : ago(age);
  // two missed refreshes in a row means something is wrong, not just slow
  el.className = 'age' + (age == null || age > 900 ? ' stale' : '');
}

function renderBands(b, sunElevation) {
  // HAMQSL gives a day and a night call; the one for now is the one for
  // whether the sun is up at the station.
  const now = sunElevation > 0 ? 'day' : 'night';
  const cond = c => ['good', 'fair', 'poor'].includes(c?.toLowerCase()) ? c.toLowerCase() : '';
  const age = b.updated ? state.server_time - b.updated : null;
  // Fetched hourly, so two missed fetches before it's worth pointing out.
  const stale = age == null || age > 7200;
  const src = $('hf-src');
  src.innerHTML = [b.noise && `Noise ${b.noise}`, 'HAMQSL.com', stale && (age == null ? 'waiting' : ago(age))]
    .filter(Boolean).join(' · ');
  src.className = 'age' + (stale ? ' stale' : '');
  if (!b.bands?.length) return;
  $('bands').innerHTML = '<div></div>' + ['day', 'night'].map(t =>
    `<div class="h${t === now ? ' now' : ''}">${t}</div>`).join('') +
    b.bands.map(band => `<div>${band.name.replace('m-', '–')}</div>` + ['day', 'night'].map(t =>
      `<div class="c ${cond(band[t])}${t === now ? '' : ' later'}">${band[t] ?? '—'}</div>`).join('')).join('');
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = deg => deg == null ? '' : COMPASS[Math.round(deg / 22.5) % 16];
const round = v => v == null ? '—' : Math.round(v);
const ANTENNA = { ok: 'Antennas OK', watch: 'Watch antennas', lower: 'Lower antennas' };

function renderWeather(w) {
  const panel = $('wx');
  const age = w.updated ? state.server_time - w.updated : null;
  // Refreshed every two minutes; three missed in a row is worth showing.
  const stale = age == null || age > 600;
  const src = $('wx-src');
  src.innerHTML = [w.now && `NWS · ${w.now.station}`, stale && (age == null ? 'waiting' : ago(age))]
    .filter(Boolean).join(' · ');
  src.className = 'age' + (stale ? ' stale' : '');

  const n = w.now;
  if (n) {
    // Wind and gusts the way a METAR writes them: SW 10 G25 mph.
    const wind = n.wind_mph == null ? '' : n.wind_mph < 1 ? 'Calm'
      : `${compass(n.wind_dir)} ${round(n.wind_mph)}${n.gust_mph ? ' G' + round(n.gust_mph) : ''} mph`;
    // When the line is too long, the sky description gives way, not the wind.
    $('wx-now').innerHTML = `<b>${round(n.temp_f)}°</b>` +
      (n.text ? `<span class="sky">${n.text}</span>` : '') + (n.text && wind ? '<span class="sep">·</span>' : '') +
      (wind ? `<span>${wind}</span>` : '');
  } else if (w.errors?.now || w.errors?.location || w.errors?.point) {
    $('wx-now').textContent = 'No observation';
  }
  const o = w.outlook;
  if (o) $('wx-next').textContent =
    `Gusts to ${round(o.gust_mph)} mph · thunder ${round(o.thunder_pct)}%`;

  const a = w.antenna;
  panel.className = 'panel wx' + (a ? ' ' + a.level : '');
  $('wx-state').innerHTML = a
    ? `${ANTENNA[a.level]}${a.reasons.length ? ` <span class="why">${a.reasons[0]}</span>` : ''}`
    : '';
}

// Chart series take the first slots of a colour-blind-checked categorical
// palette (dark steps), in order: blue, orange, aqua.
const SERIES = ['#3987e5', '#d95926', '#199e70'];

function localHour(iso, tz) {
  return +new Date(iso).toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: tz }) % 24;
}

// A small line chart over the hourly forecast, drawn after layout at the pixel
// size its box was given, so its text stays the same rem size as the page's.
function drawChart(svg, hourly, tz, { series, min = 0, max, ref }) {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const W = svg.clientWidth, H = svg.clientHeight;
  if (!W || !H || hourly.length < 2) return;
  const left = 4 * rem, bottom = 2 * rem, top = 0.6 * rem;
  const step = (W - left) / (hourly.length - 1);
  const x = i => left + step * i;
  const y = v => top + (H - top - bottom) * (1 - (v - min) / (max - min));
  const label = (tx, ty, text, anchor) =>
    `<text x="${tx}" y="${ty}" text-anchor="${anchor}" fill="var(--dim)" font-size="${1.2 * rem}">${text}</text>`;
  let g = '';
  hourly.forEach((h, i) => {
    const hr = localHour(h.time, tz);
    // Night shading, 6 PM to 6 AM, as NWS splits its forecast periods.
    if (hr >= 18 || hr < 6)
      g += `<rect x="${x(i) - step / 2}" y="${top}" width="${step}" height="${H - top - bottom}" fill="#fff" opacity="0.035"/>`;
    if (hr % 6 === 0) g += label(x(i), H - 0.4 * rem, hr === 0
      ? new Date(h.time).toLocaleString('en-US', { weekday: 'short', timeZone: tz })
      : new Date(h.time).toLocaleString('en-US', { hour: 'numeric', timeZone: tz }), 'middle');
  });
  for (const v of [min, (min + max) / 2, max]) {
    g += `<line x1="${left}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>`;
    g += label(left - 0.6 * rem, y(v) + 0.45 * rem, Math.round(v), 'end');
  }
  if (ref) g += `<line x1="${left}" x2="${W}" y1="${y(ref.v)}" y2="${y(ref.v)}" stroke="var(--fair)" stroke-width="2" stroke-dasharray="6 5"/>` +
    label(W - 0.3 * rem, y(ref.v) - 0.4 * rem, ref.label, 'end');
  series.forEach((s, n) => {
    const pts = hourly.map((h, i) => h[s] == null ? null : `${x(i)},${y(h[s])}`).filter(Boolean).join(' ');
    g += `<polyline points="${pts}" fill="none" stroke="${SERIES[n]}" stroke-width="2" stroke-linejoin="round"/>`;
  });
  svg.innerHTML = g;
}

const chartHead = (title, names) => `<div class="head"><b>${title}</b>` +
  names.map((l, n) => `<span><i style="background:${SERIES[n]}"></i>${l}</span>`).join('') + '</div>';

const DIR8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const dir8 = az => DIR8[Math.round(az / 45) % 8];
const ms = iso => new Date(iso).getTime();

// Sky plot: the horizon is the rim, straight up the middle, north at the top.
// Each pass is its track across the sky, a dot where it rises, and a ringed
// dot for where it is now while it's up.
function skyPlot(svg, list, nowMs) {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const W = svg.clientWidth, H = svg.clientHeight, S = Math.min(W, H);
  if (!S) return;
  const cx = W / 2, cy = H / 2, R = S / 2 - 3 * rem;
  const xy = (az, el) => {
    const r = R * (90 - Math.max(el, 0)) / 90, a = az * Math.PI / 180;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  };
  let g = '';
  for (const el of [0, 30, 60]) g += `<circle cx="${cx}" cy="${cy}" r="${R * (90 - el) / 90}" fill="none" stroke="var(--line)"/>`;
  g += `<line x1="${cx - R}" x2="${cx + R}" y1="${cy}" y2="${cy}" stroke="var(--line)"/>` +
       `<line y1="${cy - R}" y2="${cy + R}" x1="${cx}" x2="${cx}" stroke="var(--line)"/>`;
  for (const [l, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
    // Outside the rim by a little more than a rising satellite's dot.
    const r = R + 1.9 * rem, a = az * Math.PI / 180, x = cx + r * Math.sin(a), y = cy - r * Math.cos(a);
    g += `<text x="${x}" y="${y + 0.45 * rem}" text-anchor="middle" fill="var(--dim)" font-size="${1.3 * rem}">${l}</text>`;
  }
  const items = [];
  list.forEach((p, n) => {
    if (!p.track) return;
    const colour = SERIES[n] || 'var(--text)';      // past the three plotted: a pass tapped in the list
    g += `<polyline points="${p.track.map(([, az, el]) => xy(az, el).join(',')).join(' ')}" fill="none" stroke="${colour}" stroke-width="2.5" stroke-linejoin="round"/>`;
    const [ax, ay] = xy(p.track[0][1], p.track[0][2]);
    g += `<circle cx="${ax}" cy="${ay}" r="${0.5 * rem}" fill="${colour}" stroke="var(--panel)" stroke-width="2"/>`;
    // The name goes on the inside of the rising point, clear of the N/E/S/W
    // letters; a pass tapped in the list has its name on its card.
    const k = 2.2 * rem / Math.max(Math.hypot(ax - cx, ay - cy), 1);
    if (SERIES[n]) g += `<text x="${ax + (cx - ax) * k}" y="${ay + (cy - ay) * k + 0.45 * rem}" text-anchor="middle" fill="var(--text)" font-size="${1.3 * rem}">${p.name}</text>`;
    // Its card points at where it is now if it's up, else where it rises; any
    // point along its track picks it.
    let at = [ax, ay];
    if (ms(p.aos) <= nowMs && nowMs < ms(p.los)) {
      const pt = p.track.reduce((a, b) => Math.abs(ms(b[0]) - nowMs) < Math.abs(ms(a[0]) - nowMs) ? b : a);
      at = xy(pt[1], pt[2]);
      g += `<circle cx="${at[0]}" cy="${at[1]}" r="${0.9 * rem}" fill="var(--text)" stroke="${colour}" stroke-width="3"/>`;
    }
    const sub = `${Math.round(p.max_el)}° high · ${dir8(p.aos_az)} → ${dir8(p.los_az)}`;
    for (const [x, y] of [at, ...p.track.map(([, az, el]) => xy(az, el))]) items.push({ x, y, id: passId(p), name: p.name, sub });
  });
  svg.innerHTML = g;
  hits = { box: svg.parentElement, rem, items };
  drawChosen(id => passDetails(list.find(p => passId(p) === id), nowMs));
}

const passId = p => `${p.norad}-${p.aos}`;

// What a pass's card says: when and where to look, and what to tune.
function passDetails(p, nowMs) {
  const tz = state.station.timezone;
  const at = iso => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  const mins = d => Math.round(d / 60000);
  const live = ms(p.aos) <= nowMs;
  const sat = (state.satellites.satellites || []).find(s => s.norad === p.norad);
  const mhz = f => f == null ? '—' : f.toFixed(3);
  const freqs = (sat?.frequencies || []).slice(0, 3).map(f => [f.description || f.mode,
    `↑${mhz(f.uplink_mhz)} ↓${mhz(f.downlink_mhz)}&nbsp;MHz · ${f.mode}${f.inverting ? ' · inverting' : ''}`, true]);
  const more = (sat?.frequencies?.length || 0) - freqs.length;
  const now = live && p.track?.reduce((a, b) => Math.abs(ms(b[0]) - nowMs) < Math.abs(ms(a[0]) - nowMs) ? b : a);
  const epoch = sat?.epoch && Math.round(state.server_time - new Date(sat.epoch + 'Z').getTime() / 1000);
  return {
    name: p.name,
    sub: live ? `Up now · ${mins(ms(p.los) - nowMs)} min left`
      : mins(ms(p.aos) - nowMs) < 60 ? `Rises in ${mins(ms(p.aos) - nowMs)} min` : `Rises at ${at(p.aos)}`,
    big: `${Math.round(p.max_el)}° high <span>${dir8(p.aos_az)}&nbsp;→&nbsp;${dir8(p.los_az)} · ${mins(ms(p.los) - ms(p.aos))}&nbsp;min</span>`,
    rows: [now && ['Now', `${dir8(now[1])} ${Math.round(now[1])}° · ${Math.round(now[2])}° up`],
           ['Rises', `${at(p.aos)} · ${dir8(p.aos_az)} ${Math.round(p.aos_az)}°`],
           p.tca && ['Highest', `${at(p.tca)} · ${Math.round(p.max_el)}°`],
           ['Sets', `${at(p.los)} · ${dir8(p.los_az)} ${Math.round(p.los_az)}°`],
           ...freqs, more > 0 && ['More', `${more} other frequenc${more === 1 ? 'y' : 'ies'}`],
           epoch != null && ['Orbit as of', ago(epoch)]].filter(Boolean),
  };
}

// Coastlines for the spot map: Natural Earth's 1:110m land (public domain), as
// TopoJSON from the world-atlas package (ISC). Loaded once, decoded to rings
// of [lon, lat].
let LAND = null;
fetch('land-110m.json').then(r => r.json()).then(topo => {
  const { scale: [kx, ky], translate: [dx, dy] } = topo.transform;
  const arcs = topo.arcs.map(arc => {
    let x = 0, y = 0;
    return arc.map(([a, b]) => [(x += a) * kx + dx, (y += b) * ky + dy]);
  });
  const ring = idx => idx.flatMap((i, n) => {
    const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
    return n ? a.slice(1) : a;
  });
  LAND = topo.objects.land.geometries.flatMap(g =>
    g.type === 'Polygon' ? g.arcs.map(ring) : g.arcs.flatMap(p => p.map(ring)));
  renderFeature();                      // a map drawn before this had no coast
}).catch(() => {});

const KM_PER_MI = 1.609344;

// Azimuthal equidistant projection round the station: every point lands at
// its true distance and great-circle bearing, the way a beam would point.
function azimuthal(home, lat, lon) {
  const r = Math.PI / 180, p1 = home[0] * r, p2 = lat * r, dl = (lon - home[1]) * r;
  const c = Math.acos(Math.max(-1, Math.min(1,
    Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl))));
  const b = Math.atan2(Math.sin(dl) * Math.cos(p2),
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
  const km = c * 6371;
  return [km * Math.sin(b), -km * Math.cos(b), km];
}

function spotMap(svg, home, spots) {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const W = svg.clientWidth, H = svg.clientHeight, S = Math.min(W, H), cx = W / 2, cy = H / 2;
  if (!S || !spots.length) return;
  // Far enough to hold nine spots in ten; the rest wait at the rim.
  const ds = spots.map(s => s.km).sort((a, b) => a - b);
  const maxKm = Math.max(1500, Math.ceil(ds[Math.floor(ds.length * 0.9)] / 500) * 500);
  const k = (S / 2 - 1.5 * rem) / maxKm;
  let g = `<clipPath id="spotclip"><circle cx="${cx}" cy="${cy}" r="${maxKm * k}"/></clipPath>` +
          `<circle cx="${cx}" cy="${cy}" r="${maxKm * k}" fill="#0f141a" stroke="var(--line)"/>`;
  if (LAND) {
    let d = '';
    for (const ring of LAND) {
      let pen = false;
      for (const [lon, lat] of ring) {
        const [x, y, km] = azimuthal(home, lat, lon);
        if (km > maxKm * 1.6) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${(cx + x * k).toFixed(1)},${(cy + y * k).toFixed(1)}`;
        pen = true;
      }
    }
    g += `<path d="${d}" fill="none" stroke="#3a4a5c" stroke-width="1.2" clip-path="url(#spotclip)"/>`;
  }
  // Range rings in round miles, every 1,000 (500 when the map is small).
  const stepMi = maxKm > 4000 ? 1000 : 500;
  for (let m = stepMi; m * KM_PER_MI < maxKm; m += stepMi) {
    const r = m * KM_PER_MI * k;
    g += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-dasharray="3 4"/>` +
         `<text x="${cx + 0.4 * rem}" y="${cy - r - 0.3 * rem}" fill="var(--dim)" font-size="${1.2 * rem}">${m.toLocaleString()} mi</text>`;
  }
  const items = [];
  for (const s of spots) {
    let [x, y, km] = azimuthal(home, s.lat, s.lon);
    const far = km > maxKm;
    if (far) { x *= maxKm / km; y *= maxKm / km; }
    g += `<circle cx="${cx + x * k}" cy="${cy + y * k}" r="${(far ? 0.5 : 0.7) * rem}" fill="${far ? 'var(--dim)' : SERIES[0]}" stroke="var(--panel)" stroke-width="1.5"/>`;
    items.push({ x: cx + x * k, y: cy + y * k, id: potaId(s), name: s.activator,
      sub: `${s.reference} · ${potaFreq(s)} ${s.mode}` });
  }
  g += `<circle cx="${cx}" cy="${cy}" r="${0.6 * rem}" fill="var(--text)"/>`;
  svg.innerHTML = g;
  hits = { box: svg.parentElement, rem, items };
  drawChosen(id => potaDetails(spots.find(s => potaId(s) === id)));
}

// An activator can be in two parks at once, or spotted twice; both ends name the spot.
const potaId = s => encodeURIComponent(`${s.activator} ${s.reference}`);
const potaFreq = s => s.khz.toFixed(1).replace(/\.0$/, '');

// What a POTA spot's card says.
function potaDetails(s) {
  const age = Math.max(0, Math.round(state.server_time - new Date(s.time).getTime() / 1000));
  // A spotter ending -# is a Reverse Beacon Network skimmer, not a person.
  const by = s.spotter?.endsWith('-#') ? `${s.spotter.slice(0, -2)} skimmer` : s.spotter;
  return {
    name: s.activator,
    sub: [s.reference, s.location].filter(Boolean).join(' · '),
    big: `${(s.khz / 1000).toFixed(3)} MHz <span>${[s.mode, s.band].filter(Boolean).join('&nbsp;·&nbsp;')}</span>`,
    rows: [s.park && ['Park', s.park, true],
           s.km != null && ['From you', `${Math.round(s.km / KM_PER_MI).toLocaleString()} mi ${dir8(s.bearing)} · beam ${s.bearing}°`],
           s.grid && ['Grid', s.grid],
           s.comments && ['Spot says', s.comments, true],
           ['Spotted', `${s.spots || 1} time${s.spots === 1 ? '' : 's'}`], by && ['Last by', by],
           ['Last spot', age < 90 ? `${age} s ago` : ago(age)]].filter(Boolean),
  };
}

// The sun's elevation, from the same NOAA equations as the backend's sun.py.
function sunElevation(lat, lon, ms) {
  const R = Math.PI / 180, days = ms / 86400000 - 10957.5;
  const g = ((357.529 + 0.98560028 * days) % 360) * R, q = (280.459 + 0.98564736 * days) % 360;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * R, e = (23.439 - 0.00000036 * days) * R;
  const decl = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / R;
  const ha = ((280.46061837 + 360.98564736629 * days) % 360 + lon - ra) * R;
  return Math.asin(Math.sin(lat * R) * Math.sin(decl) + Math.cos(lat * R) * Math.cos(decl) * Math.cos(ha)) / R;
}

// World map, equirectangular from 60°S to 80°N, fitted to the box. Night is
// shaded on a canvas underneath: deepest past -12°, fading through twilight,
// so the soft edge is the gray line.
function worldMap(box, points, nowMs) {
  const canvas = box.querySelector('canvas'), svg = box.querySelector('svg');
  const W = svg.clientWidth, H = svg.clientHeight;
  if (!W || !H) return;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const top = 80, bottom = -60, s = Math.min(W / 360, H / (top - bottom));
  const ox = (W - 360 * s) / 2, oy = (H - (top - bottom) * s) / 2;
  const fwd = (lat, lon) => [ox + (lon + 180) * s, oy + (top - lat) * s];

  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d'), step = Math.max(2, Math.round(W / 600));
  for (let y = oy; y < oy + (top - bottom) * s; y += step)
    for (let x = ox; x < ox + 360 * s; x += step) {
      const el = sunElevation(top - (y - oy) / s, (x - ox) / s - 180, nowMs);
      if (el >= 0) continue;
      ctx.fillStyle = `rgba(0,0,8,${(Math.min(1, -el / 12) * 0.55).toFixed(3)})`;
      ctx.fillRect(x, y, step, step);
    }

  const frame = `<rect x="${ox}" y="${oy}" width="${360 * s}" height="${(top - bottom) * s}"/>`;
  let g = `<clipPath id="worldclip">${frame}</clipPath>` + frame.replace('/>', ' fill="none" stroke="var(--line)"/>');
  if (LAND) {
    let d = '';
    for (const ring of LAND) {
      let prev = null;
      for (const [lon, lat] of ring) {
        const [x, y] = fwd(lat, lon);
        // A jump across the map is the antimeridian, not coastline: lift the pen.
        d += `${!prev || Math.abs(x - prev) > W / 4 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
        prev = x;
      }
    }
    g += `<path d="${d}" fill="none" stroke="#3a4a5c" stroke-width="1" clip-path="url(#worldclip)"/>`;
  }
  for (const p of points) {
    const [x, y] = fwd(p.lat, p.lon);
    g += `<circle cx="${x}" cy="${y}" r="${Math.max(2.5, 0.45 * rem)}" fill="${SERIES[p.dir === 'out' ? 0 : 1]}" opacity="0.85"/>`;
  }
  const [hx, hy] = fwd(state.station.lat, state.station.lon);
  g += `<circle cx="${hx}" cy="${hy}" r="${0.6 * rem}" fill="var(--text)" stroke="var(--panel)" stroke-width="2"/>`;
  svg.innerHTML = g;
  // A tap picks a grid square: every band and both ways at once.
  const squares = {};
  for (const p of points) if (p.square) (squares[p.square] ||= []).push(p);
  hits = { box, rem, items: Object.entries(squares).map(([sq, ps]) => {
    const [x, y] = fwd(ps[0].lat, ps[0].lon);
    return ps[0].lat <= top && ps[0].lat >= bottom && { x, y, id: sq, name: sq,
      sub: `${Math.round(ps[0].km / KM_PER_MI).toLocaleString()} mi ${dir8(ps[0].bearing)} · ${reports(ps.reduce((n, p) => n + p.n, 0))}` };
  }).filter(Boolean) };
  drawChosen(sq => pskDetails(sq, squares[sq]));
}

const reports = n => `${n} report${n === 1 ? '' : 's'}`;

// What a grid square's card says: who was heard each way, on which bands.
function pskDetails(sq, ps) {
  const me = state.psk.square, order = state.psk.bands.map(b => b.band);
  const way = dir => {
    const here = ps.filter(p => p.dir === dir).sort((a, b) => order.indexOf(a.band) - order.indexOf(b.band));
    return { bands: here.map(p => p.band).join(' · '),
             calls: [...new Set(here.flatMap(p => p.calls))].slice(0, 4).join(', ') };
  };
  const out = way('out'), inn = way('in'), snr = ps.map(p => p.snr).filter(v => v != null);
  const best = snr.length ? Math.max(...snr) : null;
  const heard = Math.max(0, Math.round(state.server_time - Math.max(...ps.map(p => p.t))));
  const n = ps.reduce((t, p) => t + p.n, 0);
  return {
    name: sq,
    sub: `${Math.round(ps[0].km / KM_PER_MI).toLocaleString()} mi ${dir8(ps[0].bearing)} · bearing ${ps[0].bearing}°`,
    big: `${reports(n)} <span>last&nbsp;${state.psk.window_min}&nbsp;min</span>`,
    rows: [out.bands && [`${me} heard there`, out.bands, true], out.calls && ['Heard by', out.calls, true],
           inn.bands && [`Heard in ${me}`, inn.bands, true], inn.calls && ['Heard from', inn.calls, true],
           ps.some(p => p.modes?.length) && ['Modes', [...new Set(ps.flatMap(p => p.modes || []))].join(', ')],
           best != null && ['Best report', `${best > 0 ? '+' : ''}${best} dB`],
           ['Last report', heard < 90 ? `${heard} s ago` : ago(heard)]].filter(Boolean),
  };
}

// APRS station kinds. Three colour slots go to the kinds worth finding at a
// glance; the rest are grey. Every kind has its own shape too, so colour is
// never the only way to tell them apart.
const APRS_KIND = {
  mobile: { colour: SERIES[0], name: 'Mobiles', shape: 'arrow' },
  weather: { colour: SERIES[1], name: 'Weather', shape: 'circle' },
  object: { colour: SERIES[2], name: 'Objects', shape: 'diamond' },
  digi: { colour: '#8b98a5', name: 'Digis and iGates', shape: 'square' },
  igate: { colour: '#8b98a5', name: 'Digis and iGates', shape: 'square' },
  home: { colour: '#8b98a5', name: 'Fixed', shape: 'dot' },
  other: { colour: '#8b98a5', name: 'Fixed', shape: 'dot' },
};

function aprsMarker(kind, x, y, r, course = 0) {
  const k = APRS_KIND[kind] || APRS_KIND.other;
  if (k.shape === 'arrow') {          // pointing the way the station is heading
    const a = course * Math.PI / 180;
    const p = (dx, dy) => `${x + dx * Math.cos(a) - dy * Math.sin(a)},${y + dx * Math.sin(a) + dy * Math.cos(a)}`;
    return `<polygon points="${p(0, -1.6 * r)} ${p(r, r)} ${p(0, 0.4 * r)} ${p(-r, r)}" fill="${k.colour}" stroke="#0b0e12" stroke-width="1.5"/>`;
  }
  if (k.shape === 'circle') return `<circle cx="${x}" cy="${y}" r="${r}" fill="${k.colour}" stroke="#0b0e12" stroke-width="1.5"/>`;
  if (k.shape === 'diamond') return `<polygon points="${x},${y - 1.2 * r} ${x + 1.2 * r},${y} ${x},${y + 1.2 * r} ${x - 1.2 * r},${y}" fill="${k.colour}" stroke="#0b0e12" stroke-width="1.5"/>`;
  if (k.shape === 'square') return `<rect x="${x - 0.8 * r}" y="${y - 0.8 * r}" width="${1.6 * r}" height="${1.6 * r}" fill="none" stroke="${k.colour}" stroke-width="2"/>`;
  return `<circle cx="${x}" cy="${y}" r="${0.5 * r}" fill="${k.colour}"/>`;
}

/* The street map under the APRS and aircraft pages: OpenStreetMap from
 * OpenFreeMap in the Dark Matter style,
 * drawn by MapLibre - the same map, library and settings as FlightBoard's
 * dashboard. Roads, railways and boundaries are switched off and the names
 * dimmed, so stations and aircraft stay the brightest things on it. The browser showing
 * the page fetches the tiles; OpenFreeMap asks for no key and sets no limits.
 * ?map=static, or anything failing to load, leaves a plain dark background
 * with everything at its true distance and bearing.
 *
 * The map is made once and kept: the page is rebuilt every poll, and the map
 * is moved into the new page rather than made again, and shared by the
 * pages that use it. */
const LIVE_MAP = new URLSearchParams(location.search).get('map') !== 'static';
const LIVE_STYLE = 'https://tiles.openfreemap.org/styles/dark';
const LIVE_LIB_JS = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.6.1/dist/maplibre-gl.js';
const LIVE_LIB_JS_SRI = 'sha384-/L1njH4bbgNt9Uk3HwJ272N9fxJzRBQCxhtwGkZiqgl+Nxpq2ETUNZhNMNV1RgyW';
const LIVE_LIB_CSS = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.6.1/dist/maplibre-gl.css';
const LIVE_LIB_CSS_SRI = 'sha384-Nq6PQ+9vJPvw7U/VfDELyrWoGQMsy0gi6QShhaSrGzkpF5KkM40csg2leky+YMTd';
const LIVE_HIDE = [
  'highway_path', 'highway_minor', 'highway_major_casing', 'highway_major_inner',
  'highway_major_subtle', 'highway_name_other', 'highway_motorway_casing',
  'highway_motorway_inner', 'highway_motorway_subtle', 'highway_name_motorway',
  'railway', 'railway_dashline', 'railway_minor', 'railway_minor_dashline',
  'railway_transit', 'railway_transit_dashline', 'building', 'road_oneway',
  'road_oneway_opposite', 'road_pier', 'road_area_pier',
  'boundary_state', 'boundary_country_z0-4', 'boundary_country_z5-',
];
const LIVE_PAINT = {
  background: ['background-color', '#111b21'],
  water: ['fill-color', '#060b0e'],
  waterway: ['line-color', '#060b0e'],
  landuse_residential: ['fill-color', '#111b21'],
  landuse_park: ['fill-color', '#162229'],
  landcover_wood: ['fill-color', '#162229'],
};
const streetMap = { div: null, map: null, ready: false, failed: !LIVE_MAP };

function loadAsset(tag, attrs) {
  return new Promise((resolve, reject) => {
    const el = Object.assign(document.createElement(tag), attrs);
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('could not load ' + (attrs.src || attrs.href)));
    document.head.appendChild(el);
  });
}

async function startStreetMap(onReady) {
  streetMap.div = Object.assign(document.createElement('div'), { className: 'gl' });
  try {
    await Promise.all([
      loadAsset('link', { rel: 'stylesheet', href: LIVE_LIB_CSS, integrity: LIVE_LIB_CSS_SRI, crossOrigin: 'anonymous' }),
      loadAsset('script', { src: LIVE_LIB_JS, integrity: LIVE_LIB_JS_SRI, crossOrigin: 'anonymous' }),
    ]);
    const map = new maplibregl.Map({
      container: streetMap.div, style: LIVE_STYLE, center: [state.station.lon, state.station.lat],
      zoom: 8, interactive: false, attributionControl: false, fadeDuration: 0,
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the map did not load')), 30000);
      map.once('load', () => { clearTimeout(timer); resolve(); });
      map.once('error', e => { clearTimeout(timer); reject(new Error(e?.error?.message || 'tiles unavailable')); });
    });
    for (const layer of map.getStyle().layers) {
      if (LIVE_HIDE.includes(layer.id)) map.setLayoutProperty(layer.id, 'visibility', 'none');
      else if (layer.id.startsWith('place_')) map.setPaintProperty(layer.id, 'text-opacity', 0.45);
      else if (LIVE_PAINT[layer.id]) map.setPaintProperty(layer.id, ...LIVE_PAINT[layer.id]);
    }
    streetMap.map = map;
    streetMap.ready = true;
  } catch (e) {
    console.warn('live map unavailable, using a plain background:', e.message);
    streetMap.failed = true;
  }
  onReady();
}

// Put the street map in a page's box and return how to place things on it.
// By default it is centred on the station with rangeKm reaching the shorter
// side; given `frame` ([south, west, north, east]) it fits that area instead.
// Without the map, the same projection is worked out by hand.
function placeStreetMap(box, rangeKm, frame = null) {
  const svg = box.querySelector('svg');
  const W = svg.clientWidth, H = svg.clientHeight;
  if (!W || !H) return null;
  const home = [state.station.lat, state.station.lon];
  const kmPerLon = 111.32 * Math.cos(home[0] * Math.PI / 180);
  // The middle of the view, and how many km the shorter side's half must hold.
  let centre = home, halfKm = rangeKm;
  if (frame) {
    const [s, w, n, e] = frame;
    centre = [(s + n) / 2, (w + e) / 2];
    // Fit both directions: the box's own shape decides which one limits.
    const kmTall = (n - s) * 110.57, kmWide = (e - w) * kmPerLon;
    halfKm = Math.max(kmTall / 2 * Math.min(W, H) / H, kmWide / 2 * Math.min(W, H) / W) * 1.1;
  }
  let project;
  if (streetMap.ready) {
    if (streetMap.div.parentNode !== box) box.prepend(streetMap.div);
    const map = streetMap.map;
    map.resize();
    const metresPerPixel = halfKm * 1000 / (Math.min(W, H) / 2);
    map.jumpTo({ center: [centre[1], centre[0]],
      zoom: Math.log2(40075016.686 * Math.cos(centre[0] * Math.PI / 180) / (512 * metresPerPixel)) });
    project = (lat, lon) => { const p = map.project([lon, lat]); return [p.x, p.y]; };
  } else {
    const k = Math.min(W, H) / 2 / halfKm;
    project = (lat, lon) => [W / 2 + (lon - centre[1]) * kmPerLon * k, H / 2 - (lat - centre[0]) * 110.57 * k];
  }
  box.querySelector('.mapcredit').hidden = !streetMap.ready;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const [hx, hy] = project(home[0], home[1]);
  const kmPx = (project(home[0], home[1] + 50 / kmPerLon)[0] - hx) / 50;
  const rings = miles => miles.map(m => {
    const rr = m * KM_PER_MI * kmPx;
    return `<circle cx="${hx}" cy="${hy}" r="${rr}" fill="none" stroke="#3a4a5c" stroke-dasharray="4 5"/>` +
           `<text x="${hx + 0.4 * rem}" y="${hy - rr - 0.3 * rem}" fill="var(--dim)" font-size="${1.2 * rem}">${m} mi</text>`;
  }).join('');
  const homeDot = `<circle cx="${hx}" cy="${hy}" r="${0.6 * rem}" fill="var(--text)" stroke="#0b0e12" stroke-width="2"/>`;
  return { svg, W, H, rem, project, rings, homeDot };
}

function drawAprs(box, a) {
  const m = placeStreetMap(box, a.range_km || 100);
  if (!m) return;
  const { svg, W, H, rem, project } = m;
  let g = m.rings([25, 50]);
  for (const s of a.stations) if (s.kind === 'mobile' && s.trail.length > 1)
    g += `<polyline points="${s.trail.map(([la, lo]) => project(la, lo).join(',')).join(' ')}" fill="none" stroke="${APRS_KIND.mobile.colour}" stroke-width="2" opacity="0.6"/>`;
  // Busy kinds first, so the ones worth finding are drawn on top.
  const order = ['home', 'other', 'digi', 'igate', 'object', 'weather', 'mobile'];
  for (const s of [...a.stations].sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind))) {
    const [x, y] = project(s.lat, s.lon);
    if (x >= 0 && y >= 0 && x <= W && y <= H) g += aprsMarker(s.kind, x, y, 0.55 * rem, s.course || 0);
  }
  svg.innerHTML = g + m.homeDot;
  hits = { box, rem, items: a.stations.map(s => {
    const [x, y] = project(s.lat, s.lon);
    return x >= 0 && y >= 0 && x <= W && y <= H && { x, y, id: aprsId(s), name: s.call,
      sub: `${APRS_LABEL[s.kind] || 'Station'} · ${miles(s.km)} mi ${dir8(s.bearing)}` };
  }).filter(Boolean) };
  drawChosen(id => aprsDetails(a.stations.find(s => aprsId(s) === id)));
}

// Calls are already escaped and may hold spaces; this survives a data-id attribute.
const aprsId = s => encodeURIComponent(s.call);
const APRS_LABEL = { mobile: 'Mobile', weather: 'Weather station', object: 'Object', digi: 'Digipeater',
  igate: 'iGate', home: 'Fixed station', other: 'Station' };

// The six-character Maidenhead locator for a position, as on a QSL card.
function gridSquare(lat, lon) {
  const x = (lon + 180) / 20, y = (lat + 90) / 10, A = 'A'.charCodeAt(0);
  const sx = (x % 1) * 10, sy = (y % 1) * 10;
  return String.fromCharCode(A + Math.floor(x), A + Math.floor(y)) + Math.floor(sx) + Math.floor(sy) +
    String.fromCharCode(A + 32 + Math.floor((sx % 1) * 24), A + 32 + Math.floor((sy % 1) * 24));
}

// What a station's card says about it.
function aprsDetails(s) {
  const heard = Math.max(0, Math.round(state.server_time - s.heard));
  let big = '';
  if (s.kind === 'weather' && s.temp_f != null)
    big = `${s.temp_f}°F${s.wind_mph != null ? ` <span>wind${s.wind_dir != null ? `&nbsp;${dir8(s.wind_dir)}` : ''}&nbsp;${s.wind_mph}&nbsp;mph` +
      `${s.gust_mph ? ` · gusts&nbsp;${s.gust_mph}` : ''}</span>` : ''}`;
  else if (s.speed_kn)
    big = `${Math.round(s.speed_kn * 1.15078)} mph${s.course != null ? ` <span>heading&nbsp;${dir8(s.course)}&nbsp;·&nbsp;${Math.round(s.course)}°</span>` : ''}`;
  const moves = s.trail.length;
  return {
    name: s.call,
    sub: APRS_LABEL[s.kind] || 'Station',
    big,
    rows: [s.comment && ['Says', s.comment, true],s.object && s.by !== s.call && ['Put up by', s.by],
           ['From you', `${miles(s.km)} mi ${dir8(s.bearing)}`], ['Grid', gridSquare(s.lat, s.lon)],
           moves > 1 && ['Moved', `${moves} positions in the last hour`],
           // The q construct in the packet's path says how it reached APRS-IS.
           ['Reached by', s.rf ? 'Radio, through an iGate' : 'Internet'],
           ['Heard', heard < 90 ? `${heard} s ago` : ago(heard)]].filter(Boolean),
  };
}

// An airliner seen from above, pointing along its track.
function planeIcon(x, y, track, r, colour) {
  const a = (track || 0) * Math.PI / 180;
  const pts = [[0, -1.6], [0.2, -0.6], [1.5, 0.1], [1.5, 0.4], [0.2, 0], [0.15, 1], [0.6, 1.4], [0.6, 1.6], [0, 1.4],
               [-0.6, 1.6], [-0.6, 1.4], [-0.15, 1], [-0.2, 0], [-1.5, 0.4], [-1.5, 0.1], [-0.2, -0.6]];
  const p = ([dx, dy]) => `${(x + r * (dx * Math.cos(a) - dy * Math.sin(a))).toFixed(1)},${(y + r * (dx * Math.sin(a) + dy * Math.cos(a))).toFixed(1)}`;
  return `<polygon points="${pts.map(p).join(' ')}" fill="${colour}" stroke="#0b0e12" stroke-width="1"/>`;
}

// Far enough to hold nine aircraft in ten, so one straggler at the edge of
// the receiver's reach doesn't shrink the rest to a cluster.
function aircraftRangeKm(planes) {
  const d = planes.map(p => p.km).sort((x, y) => x - y);
  return Math.max(20, Math.ceil((d[Math.floor(d.length * 0.9)] || 20) / 10) * 10);
}

const planeName = p => p.flight || p.registration || p.hex.toUpperCase();
const miles = km => km < 10 ? (km / KM_PER_MI).toFixed(1) : Math.round(km / KM_PER_MI);
// Flight levels from 18,000 ft, where US altimeters switch to standard pressure.
function planeAlt(p) {
  if (p.on_ground) return 'ground';
  const h = Math.round(p.alt_baro / 100);
  return h >= 180 ? `FL${h}` : `${(h * 100).toLocaleString()} ft`;
}
const planeClimb = p => p.baro_rate > 300 ? ' ↑' : p.baro_rate < -300 ? ' ↓' : '';
// The three codes a pilot sets to say something is wrong.
const SQUAWK = { 7500: 'hijack', 7600: 'radio failure', 7700: 'emergency' };

// What a plane's card says about it.
function planeDetails(p) {
  const airport = (code, city) => code ? [code, city?.replace(/\/$/, '')].filter(Boolean).join(' · ') : '—';
  const rate = p.baro_rate == null || Math.abs(p.baro_rate) <= 300 ? 'Level'
    : `${p.baro_rate > 0 ? 'Climbing' : 'Descending'} ${Math.abs(p.baro_rate).toLocaleString()} ft/min`;
  const speed = p.gs != null ? `${Math.round(p.gs)}&nbsp;kn` : '';
  const course = p.track != null && `heading&nbsp;${dir8(p.track)}&nbsp;·&nbsp;${Math.round(p.track)}°`;   // wraps whole
  return {
    name: planeName(p),
    sub: [p.airline, p.type, p.phase].filter(Boolean).join(' · ') || 'Unknown aircraft',
    big: p.on_ground ? `On the ground${speed ? ` <span>${speed}</span>` : ''}`
      : `${planeAlt(p)}${planeClimb(p)} <span>${[speed, course].filter(Boolean).join(' · ')}</span>`,
    rows: [['From', airport(p.origin, p.from_city)], ['To', airport(p.destination, p.to_city)],
           ['Vertical', p.on_ground ? '—' : rate], ['From you', `${miles(p.km)} mi ${dir8(p.bearing)}`],
           ['Tail', p.registration || '—'], ['Squawk', p.squawk ? `${p.squawk}${SQUAWK[p.squawk] ? ` · ${SQUAWK[p.squawk]}` : ''}` : '—'],
           ['ICAO', p.hex.toUpperCase()]],
  };
}

function drawAircraft(box, planes) {
  const rangeKm = aircraftRangeKm(planes);
  const m = placeStreetMap(box, rangeKm);
  if (!m) return;
  const { svg, W, H, rem, project } = m;
  const inside = (x, y) => x >= 0 && y >= 0 && x <= W && y <= H;
  let g = m.rings([10, 25, 40].filter(mi => mi * KM_PER_MI < rangeKm * 1.3));
  for (const p of [...planes].reverse()) {          // nearest drawn last, on top
    const [x, y] = project(p.lat, p.lon);
    if (inside(x, y)) g += planeIcon(x, y, p.track, 0.65 * rem, p.on_ground ? '#8b98a5' : SERIES[0]);
  }
  svg.innerHTML = g + m.homeDot;
  hits = { box, rem, items: planes.map(p => {
    const [x, y] = project(p.lat, p.lon);
    return inside(x, y) && { x, y, id: p.hex, name: planeName(p),
      sub: [planeAlt(p) + planeClimb(p), `${miles(p.km)} mi ${dir8(p.bearing)}`, p.type].filter(Boolean).join(' · ') };
  }).filter(Boolean) };
  drawChosen(id => planeDetails(planes.find(p => p.hex === id)));
}

// Ships. Three colour slots go to the kinds that fill a harbour; the rest
// are grey. Under way is a hull pointing along the heading, stopped a dot.
const SHIP_KIND = {
  cargo: { colour: SERIES[0], name: 'Cargo' },
  tanker: { colour: SERIES[1], name: 'Tankers' },
  passenger: { colour: SERIES[2], name: 'Passenger and ferries' },
  service: { colour: '#8b98a5', name: 'Other' },
  pleasure: { colour: '#8b98a5', name: 'Other' },
  other: { colour: '#8b98a5', name: 'Other' },
};
const underWay = s => (s.sog || 0) >= 0.5;
const SHIP_LABEL = { cargo: 'Cargo ship', tanker: 'Tanker', passenger: 'Passenger or ferry',
  service: 'Tug or service', pleasure: 'Pleasure craft', other: 'Other' };

// What a ship's card says about it.
function shipDetails(s) {
  const mi = km => km < 10 ? (km / KM_PER_MI).toFixed(1) : Math.round(km / KM_PER_MI);
  const heard = Math.max(0, Math.round(state.server_time - s.heard));
  const course = s.heading ?? s.cog;
  return {
    name: s.name || `MMSI ${s.mmsi}`,
    sub: [SHIP_LABEL[s.kind], s.length_m && `${s.length_m} m long`].filter(Boolean).join(' · '),
    big: underWay(s)
      ? `${s.sog.toFixed(1)} kn${course != null ? ` <span>heading ${dir8(course)} · ${Math.round(course)}°</span>` : ''}`
      : s.status ? s.status[0].toUpperCase() + s.status.slice(1) : 'Stopped',
    rows: [['Going to', s.destination || '—'], ['From you', `${mi(s.km)} mi ${dir8(s.bearing)}`],
           ['Call sign', s.callsign || '—'], ['MMSI', s.mmsi], ['Heard', heard < 90 ? `${heard} s ago` : ago(heard)]],
  };
}

function shipIcon(x, y, angle, r, colour, still) {
  if (still) return `<circle cx="${x}" cy="${y}" r="${0.55 * r}" fill="${colour}" stroke="#0b0e12" stroke-width="1.5"/>`;
  const a = angle * Math.PI / 180;
  const p = ([dx, dy]) => `${(x + r * (dx * Math.cos(a) - dy * Math.sin(a))).toFixed(1)},${(y + r * (dx * Math.sin(a) + dy * Math.cos(a))).toFixed(1)}`;
  return `<polygon points="${[[0, -1.6], [0.6, -0.6], [0.6, 1.2], [-0.6, 1.2], [-0.6, -0.6]].map(p).join(' ')}" fill="${colour}" stroke="#0b0e12" stroke-width="1.5"/>`;
}

// Where the ships are: the box holding the middle 90% of them each way, so a
// boat far up the coast doesn't pull the harbour into a corner.
function shipFrame(ships) {
  const q = (v, f) => v[Math.min(v.length - 1, Math.floor(v.length * f))];
  const lats = ships.map(s => s.lat).sort((a, b) => a - b), lons = ships.map(s => s.lon).sort((a, b) => a - b);
  const frame = [q(lats, 0.05), q(lons, 0.05), q(lats, 0.95), q(lons, 0.95)];
  // At least a few km across, so a single ship doesn't zoom to the dock.
  const pad = 0.02;
  return [frame[0] - pad, frame[1] - pad, frame[2] + pad, frame[3] + pad];
}

function drawShips(box, ships) {
  const m = placeStreetMap(box, 20, shipFrame(ships));
  if (!m) return;
  const { svg, W, H, rem, project } = m;
  const inside = (x, y) => x >= 0 && y >= 0 && x <= W && y <= H;
  let g = '';
  for (const s of ships) if (underWay(s) && s.trail.length > 1)
    g += `<polyline points="${s.trail.map(([la, lo]) => project(la, lo).join(',')).join(' ')}" fill="none" stroke="${SHIP_KIND[s.kind].colour}" stroke-width="2" opacity="0.5"/>`;
  for (const s of [...ships].sort((a, b) => underWay(a) - underWay(b))) {
    const [x, y] = project(s.lat, s.lon);
    if (inside(x, y)) g += shipIcon(x, y, s.heading ?? s.cog ?? 0, 0.6 * rem, SHIP_KIND[s.kind].colour, !underWay(s));
  }
  // Names, ships under way first and big before small; a name that would
  // land on another is left off.
  const placed = [], free = b => placed.every(q => b[0] > q[2] || b[2] < q[0] || b[1] > q[3] || b[3] < q[1]);
  const credit = box.querySelector('.mapcredit:not([hidden])');      // the map's credit stays readable
  if (credit) placed.push([credit.offsetLeft, credit.offsetTop, credit.offsetLeft + credit.offsetWidth, credit.offsetTop + credit.offsetHeight]);
  for (const s of [...ships].sort((a, b) => underWay(b) - underWay(a) || (b.length_m || 0) - (a.length_m || 0))) {
    if (!s.name) continue;
    const [x, y] = project(s.lat, s.lon);
    const box = [x + rem, y - 0.6 * rem, x + rem + s.name.length * 0.7 * 1.2 * rem, y + 0.7 * rem];   // names are capitals
    if (!inside(x, y) || box[2] > W || box[1] < 0 || box[3] > H || !free(box)) continue;
    placed.push(box);
    g += `<text x="${box[0]}" y="${y + 0.45 * rem}" fill="var(--text)" font-size="${1.2 * rem}" paint-order="stroke" stroke="#0b0e12" stroke-width="3">${s.name}</text>`;
  }
  const [hx, hy] = project(state.station.lat, state.station.lon);
  svg.innerHTML = g + (inside(hx, hy) ? m.homeDot : '');
  hits = { box, rem, items: ships.map(s => {
    const [x, y] = project(s.lat, s.lon);
    return inside(x, y) && { x, y, id: String(s.mmsi), name: s.name || `MMSI ${s.mmsi}`,
      sub: [SHIP_LABEL[s.kind], underWay(s) ? `${s.sog.toFixed(1)} kn` : s.status || 'stopped'].join(' · ') };
  }).filter(Boolean) };
  drawChosen(id => shipDetails(ships.find(s => String(s.mmsi) === id)));
}

/* Details. A tap or click on something on a map picks it: a ring goes round
 * it and a card beside it says more, kept up to date as the data refreshes.
 * Where several sit under one finger, the card lists them to pick from. The
 * rotation waits while a card is open, and starts again when it's closed or
 * after CHOSEN_MS with nobody touching it, so a screen left alone goes back
 * to cycling. */
const CHOSEN_MS = 45_000;
let hits = null;          // what the map just drew, and where: { box, rem, items: [{ x, y, id, name, sub }] }
let chosen = null;        // { page, ids, total }: one id for its details, more for a list to pick from
let chosenTimer = null;

const pageName = () => activePages()[page % activePages().length].name;

function hitsAt(clientX, clientY) {
  if (!hits || !hits.box.isConnected) return [];
  const r = hits.box.getBoundingClientRect(), x = clientX - r.left, y = clientY - r.top;
  const reach = 1.6 * hits.rem;      // about a fingertip
  return hits.items.map(h => [Math.hypot(h.x - x, h.y - y), h]).filter(([d]) => d <= reach)
    .sort((a, b) => a[0] - b[0]).map(([, h]) => h.id).filter((id, i, all) => all.indexOf(id) === i);   // a track is many points
}

// A list shows the nearest six of however many are there.
function choose(ids) {
  chosen = { page: pageName(), ids: ids.slice(0, 6), total: ids.length };
  clearInterval(pageTimer);
  pageTimer = null;
  clearTimeout(chosenTimer);
  chosenTimer = setTimeout(unchoose, CHOSEN_MS);
  renderFeature();
  schedulePoll();
}

// Let go of the choice; with `redraw` false the caller is drawing anyway.
function unchoose(redraw = true) {
  if (!chosen) return;
  chosen = null;
  clearTimeout(chosenTimer);
  clearInterval(pageTimer);
  pageTimer = setInterval(nextPage, PAGE_MS);
  if (redraw) renderFeature();
  schedulePoll();
}

// Ring what's chosen and put its card beside it, on the side with room.
function drawChosen(details) {
  const { box, rem, items } = hits;
  box.querySelector('.card')?.remove();
  if (!chosen || chosen.page !== pageName()) return;
  const picked = chosen.ids.map(id => items.find(h => h.id === id)).filter(Boolean);
  if (!picked.length) { unchoose(false); return; }    // gone from the map
  for (const row of $('feature-body').querySelectorAll(':is(.spots, .passes) [data-id]'))
    row.classList.toggle('chosen', picked.some(h => h.id === row.dataset.id));
  const svg = box.querySelector('svg');
  for (const h of picked) svg.insertAdjacentHTML('beforeend',
    `<circle cx="${h.x}" cy="${h.y}" r="${(picked.length > 1 ? 1.1 : 1.5) * rem}" fill="none" stroke="var(--accent)" stroke-width="${0.25 * rem}"/>`);
  let inner;
  if (picked.length === 1) {
    const d = details(picked[0].id);
    inner = `<div><div class="nm">${d.name}</div><div class="kd">${d.sub}</div></div>${d.big ? `<div class="big">${d.big}</div>` : ''}
      <dl>${d.rows.map(([k, v, wide]) => wide ? `<dt class="wide">${k}</dt><dd class="wide">${v}</dd>` : `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  } else {
    const many = chosen.total > picked.length ? `${chosen.total} here · the nearest ${picked.length}` : `${picked.length} here`;
    inner = `<div class="kd">${many} · tap one</div>` + picked.map(h =>
      `<div class="pick" data-id="${h.id}"><div class="nm">${h.name}</div><div class="kd">${h.sub}</div></div>`).join('');
  }
  // Beside it at full width where there's room. Squeezed beside it, the card
  // goes above or below it instead if it fits there; failing that, beside it
  // as wide as the roomier side allows.
  const at = picked[0], W = box.clientWidth, gap = 2.4 * rem, edge = 0.6 * rem;
  // The map's credit stays in sight: the card stops above it.
  const credit = box.querySelector('.mapcredit:not([hidden])');
  const H = credit ? credit.offsetTop - 0.3 * rem : box.clientHeight;
  const roomR = W - at.x - gap - edge, roomL = at.x - gap - edge;
  const card = Object.assign(document.createElement('div'), { innerHTML: `<div class="tip"></div><div class="x">×</div>${inner}` });
  box.append(card);
  const fit = () => { card.classList.remove('tight'); if (card.offsetHeight > H - 1.2 * rem) card.classList.add('tight'); return card.offsetHeight; };
  if (Math.max(roomR, roomL) < 22 * rem && W - 2 * edge >= 22 * rem) {
    const w = Math.min(28 * rem, W - 2 * edge);
    card.className = 'card';
    card.style.width = `${w}px`;
    const h = fit(), below = H - at.y - gap - edge >= h, above = at.y - gap - edge >= h;
    if (below || above) {
      const down = below && (!above || H - at.y >= at.y);
      const left = Math.min(Math.max(at.x - w / 2, edge), W - w - edge);
      card.classList.add(down ? 'below' : 'above');
      Object.assign(card.style, { left: `${left}px`, top: `${down ? at.y + gap : at.y - gap - h}px` });
      card.style.setProperty('--tip', `${Math.min(Math.max(at.x - left, rem), w - rem)}px`);
      return;
    }
  }
  const right = roomR >= 28 * rem || roomR >= roomL;
  const w = Math.min(28 * rem, right ? roomR : roomL);
  // Squeezed, each label goes above its value rather than beside it.
  card.className = `card ${right ? 'right' : 'left'}${w < 22 * rem ? ' narrow' : ''}`;
  card.style.width = `${w}px`;
  const h = fit();                    // tight: a long comment in a narrow space
  const top = Math.min(Math.max(at.y - h / 2, edge), H - h - edge);
  Object.assign(card.style, { top: `${top}px`, left: `${right ? at.x + gap : at.x - gap - w}px` });
  card.style.setProperty('--tip', `${Math.min(Math.max(at.y - top, rem), h - rem)}px`);
}

// Keep as many rows as fit in a list, then say how many more there are.
function fitList(list, total) {
  list.querySelector('.more')?.remove();     // from an earlier fit of this list
  const rows = [...list.children];
  const bottom = () => list.getBoundingClientRect().bottom;
  while (rows.length && rows[rows.length - 1].getBoundingClientRect().bottom > bottom()) rows.pop().remove();
  if (total <= rows.length) return;
  const more = document.createElement('div');
  more.className = 'more';
  more.textContent = `+${total} more`;      // measured with text in, not empty
  list.appendChild(more);
  while (rows.length && more.getBoundingClientRect().bottom > bottom()) rows.pop().remove();
  more.textContent = `+${total - rows.length} more`;
}

// The feature panel cycles through pages. Each returns its title, its body and
// the credit its data source asks for, and optionally a draw() to run once the
// body is laid out.
const PAGES = [
  function forecast() {
    const w = state.weather, tz = state.station.timezone;
    const hourly = w.outlook?.hourly || [], periods = w.forecast || [];
    const credit = 'Data: US National Weather Service';
    const title = ['Forecast', state.station.city].filter(Boolean).join(' · ');
    if (!hourly.length) return { title, credit, body: '<div class="empty">Waiting for the forecast.</div>' };
    // NWS headlines run long ("... issued ... by NWS Upton NY"); the event
    // and when it ends is what a glance needs.
    const until = iso => iso ? 'until ' + new Date(iso).toLocaleString('en-US',
      { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz }) : '';
    const alerts = (w.alerts || []).slice(0, 3).map(a => `<div class="nws-alert"><b>${a.event}</b>` +
      `<span>${until(a.ends)}</span></div>`).join('');
    const temp = p => `<span class="${p.daytime ? 'hi' : 'lo'}">${p.temp_f}°</span>`;
    const body = `<div class="fc">${alerts}<div class="charts">
        <div class="chart">${chartHead('Temperature °F', [])}<svg data-chart="temp"></svg></div>
        <div class="chart">${chartHead('Wind mph', ['Sustained', 'Gusts'])}<svg data-chart="wind"></svg></div>
        <div class="chart">${chartHead('Chance %', ['Rain', 'Thunder'])}<svg data-chart="chance"></svg></div>
      </div><div class="strip">` + periods.slice(0, 4).map(p => `<div><div class="name">${p.name}</div>
        <div class="t">${temp(p)}</div><div class="short">${p.short} · ${p.precip_pct ? p.precip_pct + '% rain' : 'Dry'}</div></div>`).join('') +
      `</div></div>`;
    const draw = el => {
      const temps = hourly.map(h => h.temp_f).filter(v => v != null);
      const watch = state.station.wind_watch_mph;
      const charts = {
        temp: { series: ['temp_f'], min: Math.floor(Math.min(...temps) / 10) * 10, max: Math.ceil(Math.max(...temps) / 10) * 10 },
        wind: { series: ['wind_mph', 'gust_mph'], max: Math.ceil(Math.max(watch + 10, ...hourly.map(h => h.gust_mph || 0)) / 10) * 10,
                ref: { v: watch, label: 'watch antennas' } },
        chance: { series: ['precip_pct', 'thunder_pct'], max: 100 },
      };
      for (const svg of el.querySelectorAll('svg[data-chart]')) drawChart(svg, hourly, tz, charts[svg.dataset.chart]);
    };
    return { title, body, credit, draw };
  },
  function satellites() {
    const sat = state.satellites, tz = state.station.timezone, nowMs = now().getTime();
    const title = 'Satellite passes · next 24 h';
    const credit = 'Orbits: CelesTrak · Frequencies: SatNOGS DB, CC BY-SA 4.0';
    const upcoming = (sat.passes || []).filter(p => ms(p.los) > nowMs);
    if (!upcoming.length) return { title, credit, body: '<div class="empty">Waiting for orbits.</div>' };
    const freqs = Object.fromEntries((sat.satellites || []).map(s => [s.norad, s.frequencies]));
    const mins = d => Math.round(d / 60000);
    const live = p => ms(p.aos) <= nowMs;
    const when = p => live(p) ? `now, ${mins(ms(p.los) - nowMs)} min left`
      : mins(ms(p.aos) - nowMs) < 60 ? `in ${mins(ms(p.aos) - nowMs)} min`
      : new Date(p.aos).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
    // The first voice frequency pair: what you'd set the radio to.
    const radio = p => {
      const f = freqs[p.norad]?.[0];
      return f ? ` · ${f.mode} ↑${f.uplink_mhz?.toFixed(3) ?? '—'} ↓${f.downlink_mhz.toFixed(3)}` : '';
    };
    const plotted = upcoming.slice(0, 3);
    // A pass tapped in the list joins the three on the plot.
    const extra = chosen?.page === 'satellites' ? upcoming.filter(p => !plotted.includes(p) && chosen.ids.includes(passId(p))) : [];
    const body = `<div class="sats"><div class="skybox"><svg class="sky"></svg></div><div class="passes">` +
      upcoming.slice(0, 7).map((p, n) => `<div class="pass" data-id="${passId(p)}"><span>${n < 3 ? `<i style="background:${SERIES[n]}"></i>` : ''}</span>
        <span class="sat">${p.name}</span><span class="${live(p) ? 'up' : ''}">${when(p)}</span><span>${Math.round(p.max_el)}°</span>
        <span class="sub">${dir8(p.aos_az)} → ${dir8(p.los_az)} · ${mins(ms(p.los) - ms(p.aos))} min${radio(p)}</span></div>`).join('') +
      `</div></div>`;
    return { title, body, credit, draw: el => skyPlot(el.querySelector('.sky'), [...plotted, ...extra], nowMs) };
  },
  function pota() {
    const st = state.station, nowMs = now().getTime();
    const spots = (state.pota.spots || []).filter(s => !s.qrt);
    const title = `POTA spots · newest first · ${spots.length} on air`;
    const credit = 'Spots: Parks on the Air · Map: Natural Earth';
    if (!spots.length) return { title, credit, body: '<div class="empty">No POTA activators spotted right now.</div>' };
    const mi = km => Math.round(km / KM_PER_MI);
    const ago = s => `${Math.max(0, Math.round((nowMs - new Date(s.time)) / 60000))} min ago`;
    const placed = spots.filter(s => s.km != null);
    const body = `<div class="pota"><div class="spotbox"><svg class="spotmap"></svg></div><div class="spots">` +
      spots.slice(0, 20).map(s => `<div class="spot" data-id="${potaId(s)}"><span class="call mono">${s.activator}</span><span class="f">${potaFreq(s)} ${s.mode}</span>
        <span class="sub"><span class="mono">${s.reference}</span> ${s.park || ''}</span>
        <span class="d">${s.km != null ? `${mi(s.km)} mi ${dir8(s.bearing)}` : ''} · ${ago(s)}</span></div>`).join('') +
      `</div></div>`;
    const draw = el => {
      spotMap(el.querySelector('.spotmap'), [st.lat, st.lon], placed);
      fitList(el.querySelector('.spots'), spots.length);
    };
    return { title, body, credit, draw };
  },
  function pskreporter() {
    const p = state.psk, sq = p.square || '';
    const title = `Band activity · ${sq} on PSKReporter`;
    const credit = 'Reports: PSKReporter, via mqtt.pskreporter.info (M0LTE) · Map: Natural Earth';
    if (!p.bands?.length) return { title, credit, body: `<div class="empty">Listening for reports to and from ${sq || 'your grid square'}…</div>` };
    const mi = km => Math.round(km / KM_PER_MI).toLocaleString();
    // 1,695 reports fit a narrow column as 1.7k.
    const count = n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n;
    // The farthest station either way. The feed names it and its square,
    // not its country.
    const far = f => f ? `${f.call} ${mi(f.km)} mi` : '—';
    const body = `<div class="psk"><div class="mapbox"><canvas></canvas><svg></svg></div>
      <div class="legend"><span><i style="background:${SERIES[0]}"></i>${sq} heard there</span>
        <span><i style="background:${SERIES[1]}"></i>Heard in ${sq}</span><span>Shaded: night · last ${p.window_min} min</span></div>
      <div class="bandrow" style="grid-template-columns:repeat(${p.bands.length},1fr)">` +
      p.bands.map(b => `<div><b>${b.band}</b><div class="n">${count(b.out)} / ${count(b.in)}</div><div class="far">${far([b.far_out, b.far_in].filter(Boolean).sort((x, y) => y.km - x.km)[0])}</div></div>`).join('') +
      `</div></div>`;
    return { title, body, credit, draw: el => worldMap(el.querySelector('.mapbox'), p.points || [], now().getTime()) };
  },
  function aprs() {
    const a = state.aprs, nowMs = now().getTime();
    const stations = a.stations || [];
    const rangeMi = Math.round((a.range_km || 100) / KM_PER_MI);
    const title = `APRS · ${stations.length} stations within ${rangeMi} mi`;
    const credit = 'Stations: APRS-IS';
    if (!stations.length) return { title, credit, body: '<div class="empty">Listening for APRS stations nearby…</div>' };
    const mi = km => km < 10 ? (km / KM_PER_MI).toFixed(1) : Math.round(km / KM_PER_MI);
    const ago = s => `${Math.max(0, Math.round((nowMs / 1000 - s.heard) / 60))} min`;
    const what = s => s.kind === 'weather' && s.temp_f != null
      ? `${s.temp_f}°F${s.wind_mph != null ? ` · wind ${s.wind_mph} mph` : ''}`
      : s.speed_kn ? `${Math.round(s.speed_kn * 1.15078)} mph ${dir8(s.course || 0)}` : (s.comment || '');
    const counts = {};
    for (const s of stations) {
      const n = (APRS_KIND[s.kind] || APRS_KIND.other).name;
      counts[n] = (counts[n] || 0) + 1;
    }
    const legend = ['mobile', 'weather', 'object', 'digi', 'home'].map(k =>
      `<span><svg viewBox="0 0 16 16">${aprsMarker(k, 8, 8, 5)}</svg> ${APRS_KIND[k].name} ${counts[APRS_KIND[k].name] || 0}</span>`).join('');
    const body = `<div class="aprs"><div class="mapgrid">
        <div class="mapbox streetmap"><svg></svg><div class="mapcredit" hidden>© OpenMapTiles © OpenStreetMap contributors</div></div>
        <div class="spots">` + stations.slice(0, 25).map(s => `<div class="station" data-id="${aprsId(s)}">
          <svg viewBox="0 0 18 18">${aprsMarker(s.kind, 9, 9, 5, s.course || 0)}</svg><span class="call mono">${s.call}</span>
          <span class="d">${mi(s.km)} mi ${dir8(s.bearing)}</span><span class="sub">${[ago(s), what(s)].filter(Boolean).join(' · ')}</span></div>`).join('') +
      `</div></div><div class="legend">${legend}<span>· last ${a.window_min} min</span></div></div>`;
    const draw = el => {
      if (!streetMap.div && !streetMap.failed) startStreetMap(renderFeature);
      drawAprs(el.querySelector('.streetmap'), a);
      fitList(el.querySelector('.spots'), stations.length);
    };
    return { title, body, credit, draw };
  },
  Object.assign(function aircraft() {
    const a = state.aircraft, planes = a.aircraft || [];
    const rangeMi = Math.round(aircraftRangeKm(planes) / KM_PER_MI);
    const title = `Aircraft · ${planes.length} within ${rangeMi} mi${a.via === 'FlightBoard' ? ' · via FlightBoard' : ''}`;
    const credit = 'Aircraft: your own ADS-B receiver';
    if (!planes.length) return { title, credit, body: '<div class="empty">No aircraft with a position right now.</div>' };
    const about = p => [p.origin && `${p.origin} → ${p.destination}`, p.airline, p.type].filter(Boolean).join(' · ');
    const body = `<div class="aprs"><div class="mapgrid">
        <div class="mapbox streetmap"><svg></svg><div class="mapcredit" hidden>© OpenMapTiles © OpenStreetMap contributors</div></div>
        <div class="spots">` + planes.slice(0, 25).map(p => `<div class="plane" data-id="${p.hex}">
          <span class="call mono">${planeName(p)}</span><span class="alt">${planeAlt(p)}${planeClimb(p)}</span>
          <span class="sub">${about(p) || '&nbsp;'}</span><span class="d">${miles(p.km)} mi ${dir8(p.bearing)}</span></div>`).join('') +
      `</div></div></div>`;
    const draw = el => {
      if (!streetMap.div && !streetMap.failed) startStreetMap(renderFeature);
      drawAircraft(el.querySelector('.streetmap'), planes);
      fitList(el.querySelector('.spots'), planes.length);
    };
    return { title, body, credit, draw };
  }, {
    // Only with a receiver to read from (AIRCRAFT_URL), and refreshed more
    // often while it's up: aircraft cover a few miles in a normal poll.
    available: () => state && !state.aircraft?.disabled,
    poll_ms: 5000,
  }),
  Object.assign(function ships() {
    const a = state.ships, ships = a.ships || [];
    const moving = ships.filter(underWay).length;
    const title = `Ships · ${ships.length} in range · ${moving} under way`;
    const credit = 'Ships: aisstream.io';
    if (!ships.length) return { title, credit, body: '<div class="empty">Listening for ships nearby…</div>' };
    const counts = {};
    for (const s of ships) counts[SHIP_KIND[s.kind].name] = (counts[SHIP_KIND[s.kind].name] || 0) + 1;
    const legend = ['cargo', 'tanker', 'passenger', 'other'].map(k =>
      `<span><svg viewBox="0 0 16 16">${shipIcon(8, 8, 0, 4.5, SHIP_KIND[k].colour, false)}</svg> ${SHIP_KIND[k].name} ${counts[SHIP_KIND[k].name] || 0}</span>`).join('') +
      `<span><svg viewBox="0 0 16 16">${shipIcon(8, 8, 0, 6, '#8b98a5', true)}</svg> stopped</span><span>· last ${a.window_min} min</span>`;
    const body = `<div class="aprs"><div class="mapbox streetmap ships"><svg></svg>
        <div class="mapcredit" hidden>© OpenMapTiles © OpenStreetMap contributors</div></div>
      <div class="legend">${legend}</div></div>`;
    const draw = el => {
      if (!streetMap.div && !streetMap.failed) startStreetMap(renderFeature);
      drawShips(el.querySelector('.streetmap'), ships);
    };
    return { title, body, credit, draw };
  }, { available: () => state && !state.ships?.disabled }),
  function alerts() {
    const list = state.spaceweather.alerts || [];
    const body = list.length
      ? '<ul class="alerts">' + list.slice(0, 6).map(a => `
          <li><div class="when mono">${hhmm(new Date(a.issued), 'UTC')}Z</div>
              <div><div class="kind">${a.kind}</div><div class="text">${a.text}</div></div></li>`).join('') + '</ul>'
      : '<div class="empty">No space weather alerts in the last 24 hours.</div>';
    return { title: 'Space weather alerts · last 24 h', body, credit: 'Data: NOAA Space Weather Prediction Center' };
  },
];

let page = 0;
// Charts and maps are drawn at the pixel size their box has when the page
// renders. If the box changes size after that (fonts arriving, an iPad turned
// round), draw them again rather than leave them stretched or off-centre.
let drawn = null;
const resized = new ResizeObserver(() => { if (drawn) drawn($('feature-body')); });

// The pages whose source is switched on; a page with no available() always is.
const activePages = () => PAGES.filter(p => !p.available || p.available());

function renderFeature() {
  if (!state) return;
  const pages = activePages();
  const p = pages[page % pages.length]();
  $('feature-title').innerHTML = p.title;
  $('feature-body').innerHTML = p.body;
  hits = null;
  resized.disconnect();
  drawn = p.draw;
  if (drawn) {
    drawn($('feature-body'));
    $('feature-body').querySelectorAll('svg').forEach(el => resized.observe(el));
  }
  $('credit').textContent = p.credit;
  $('dots').innerHTML = pages.length > 1
    ? pages.map((_, i) => `<i class="${i === page % pages.length ? 'on' : ''}"></i>`).join('')
    : '';
}

function showPage(n) {
  const count = activePages().length;
  page = ((n % count) + count) % count;
  renderFeature();
  schedulePoll();
}
function nextPage() { showPage(page + 1); }

let pageTimer = setInterval(nextPage, PAGE_MS);

// Going to a page by hand restarts the rotation from there, so the page you
// chose gets its full 20 seconds.
function goTo(n) {
  chosen = null;
  clearTimeout(chosenTimer);
  clearInterval(pageTimer);
  showPage(n);
  pageTimer = setInterval(nextPage, PAGE_MS);
}

/* By hand:
 *   swipe   left for the next page, right for the previous, anywhere on the
 *           panel
 *   edges   a tap or left click on the outer tenth of the panel: left for the
 *           previous page, right for the next. Arrows show there while a
 *           finger or the mouse is on the panel
 *   tap     anywhere else picks what's under it, on a page with things to
 *           pick, and opens its card; a tap on empty map closes it
 *   mouse   the right button is the next page, anywhere
 *   keys    the left and right arrows, Page Up and Page Down; Esc closes a card
 *   dots    a tap or click on a dot under the panel jumps to that page */
const SWIPE_PX = 40;
const EDGE = 0.1;
let pressed = null;

function edgeAt(clientX) {
  const r = $('feature').getBoundingClientRect();
  return clientX < r.left + r.width * EDGE ? -1 : clientX > r.right - r.width * EDGE ? 1 : 0;
}

function tap(e) {
  if (e.target.closest('.card')) {
    const pick = e.target.closest('.pick');
    if (pick) choose([pick.dataset.id]);
    else if (e.target.closest('.x')) unchoose();
    return;
  }
  const side = edgeAt(e.clientX);
  if (side) { goTo(page + side); return; }
  const row = e.target.closest(':is(.spots, .passes) [data-id]');     // a row of the list beside the map
  if (row) { choose([row.dataset.id]); return; }
  const found = hitsAt(e.clientX, e.clientY);
  if (found.length) choose(found);
  else unchoose();
}

// The edge arrows show for a few seconds after the last touch or movement.
let shownTimer = null;
function showEdges(e) {
  const f = $('feature');
  f.classList.add('touched');
  clearTimeout(shownTimer);
  shownTimer = setTimeout(() => f.classList.remove('touched'), 3000);
  if (e.pointerType === 'mouse')
    f.classList.toggle('pointing', !!edgeAt(e.clientX) || !!e.target.closest('.card .x, .card .pick, :is(.spots, .passes) [data-id]') ||
      (!e.target.closest('.card') && hitsAt(e.clientX, e.clientY).length > 0));
}

$('feature').addEventListener('pointermove', showEdges);
$('feature').addEventListener('pointerdown', e => {
  showEdges(e);
  if (chosen) { clearTimeout(chosenTimer); chosenTimer = setTimeout(unchoose, CHOSEN_MS); }    // still in use
  pressed = { x: e.clientX, y: e.clientY, type: e.pointerType, button: e.button };
});
$('feature').addEventListener('pointerup', e => {
  if (!pressed) return;
  const dx = e.clientX - pressed.x, dy = e.clientY - pressed.y, { type, button } = pressed;
  pressed = null;
  if (type === 'mouse' && button !== 0) return;      // the right button is the menu event below
  if (type !== 'mouse' && Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) goTo(dx < 0 ? page + 1 : page - 1);
  else if (Math.hypot(dx, dy) < SWIPE_PX) tap(e);
});
$('feature').addEventListener('pointercancel', () => { pressed = null; });
// The right mouse button: next page instead of the browser's menu.
$('feature').addEventListener('contextmenu', e => { e.preventDefault(); goTo(page + 1); });
document.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight' || e.key === 'PageDown') goTo(page + 1);
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') goTo(page - 1);
  else if (e.key === 'Escape') unchoose();
});
$('dots').addEventListener('click', e => {
  const i = [...$('dots').children].indexOf(e.target);
  if (i >= 0) goTo(i);
});

async function poll() {
  try {
    const sent = Date.now();
    const r = await fetch('/api/state', { cache: 'no-store' });
    state = escapeAll(await r.json());
    clockOffsetMs = state.server_time * 1000 - (sent + Date.now()) / 2;
    // A cast page never reloads by itself; pick up a redeployed frontend.
    if (firstBuild === null) firstBuild = state.build;
    else if (state.build !== firstBuild) location.reload();
    renderStation(state.station);
    renderSpaceWeather(state.spaceweather);
    renderBands(state.bands, state.station.sun_elevation);
    renderWeather(state.weather);
    renderFeature();
    tickClocks();
  } catch (e) {
    $('solar-age').textContent = 'backend unreachable';
    $('solar-age').className = 'age stale';
  }
}

// Poll every POLL_MS, or sooner while a page that asks for it is showing.
let pollTimer = null;
function schedulePoll() {
  clearTimeout(pollTimer);
  const pages = activePages(), showing = pages[page % pages.length];
  pollTimer = setTimeout(async () => { await poll(); schedulePoll(); }, chosen ? 5000 : showing?.poll_ms || POLL_MS);
}

setInterval(tickClocks, 1000);
tickClocks();
poll().then(schedulePoll);
