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
  el.textContent = value ?? '—';
  el.className = 'v' + (cls ? ' ' + cls : '');
}

// NOAA's own reading of Kp: below 4 quiet, 4 active, 5 and up a storm (G1+).
function kpClass(kp) { return kp >= 5 ? 'poor' : kp >= 4 ? 'fair' : 'good'; }

// X-ray class letter: M and X flares cause HF radio blackouts on the day side.
function xrayClass(c) { return !c ? '' : c[0] === 'X' ? 'poor' : c[0] === 'M' ? 'fair' : ''; }

function scaleColour(level) { return level >= 3 ? 'var(--poor)' : level >= 1 ? 'var(--fair)' : ''; }

function renderStation(s) {
  $('call').textContent = s.callsign || 'Set CALLSIGN';
  $('meta').textContent = [s.grid, s.city, s.cq_zone && `CQ ${s.cq_zone}`, s.itu_zone && `ITU ${s.itu_zone}`]
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
  src.textContent = [b.noise && `Noise ${b.noise}`, 'HAMQSL.com', stale && (age == null ? 'waiting' : ago(age))]
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
  src.textContent = [w.now && `NWS · ${w.now.station}`, stale && (age == null ? 'waiting' : ago(age))]
    .filter(Boolean).join(' · ');
  src.className = 'age' + (stale ? ' stale' : '');

  const n = w.now;
  if (n) {
    // Wind and gusts the way a METAR writes them: SW 10 G25 mph.
    const wind = n.wind_mph < 1 ? 'Calm'
      : `${compass(n.wind_dir)} ${round(n.wind_mph)}${n.gust_mph ? ' G' + round(n.gust_mph) : ''} mph`;
    // When the line is too long, the sky description gives way, not the wind.
    $('wx-now').innerHTML = `<b>${round(n.temp_f)}°</b>` +
      (n.text ? `<span class="sky">${n.text}</span><span class="sep">·</span>` : '') + `<span>${wind}</span>`;
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
  const S = Math.min(svg.clientWidth, svg.clientHeight);
  if (!S) return;
  const c = S / 2, R = c - 3 * rem;
  const xy = (az, el) => {
    const r = R * (90 - Math.max(el, 0)) / 90, a = az * Math.PI / 180;
    return [c + r * Math.sin(a), c - r * Math.cos(a)];
  };
  let g = '';
  for (const el of [0, 30, 60]) g += `<circle cx="${c}" cy="${c}" r="${R * (90 - el) / 90}" fill="none" stroke="var(--line)"/>`;
  g += `<line x1="${c - R}" x2="${c + R}" y1="${c}" y2="${c}" stroke="var(--line)"/>` +
       `<line y1="${c - R}" y2="${c + R}" x1="${c}" x2="${c}" stroke="var(--line)"/>`;
  for (const [l, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
    // Outside the rim by a little more than a rising satellite's dot.
    const r = R + 1.9 * rem, a = az * Math.PI / 180, x = c + r * Math.sin(a), y = c - r * Math.cos(a);
    g += `<text x="${x}" y="${y + 0.45 * rem}" text-anchor="middle" fill="var(--dim)" font-size="${1.3 * rem}">${l}</text>`;
  }
  list.forEach((p, n) => {
    if (!p.track) return;
    g += `<polyline points="${p.track.map(([, az, el]) => xy(az, el).join(',')).join(' ')}" fill="none" stroke="${SERIES[n]}" stroke-width="2.5" stroke-linejoin="round"/>`;
    const [ax, ay] = xy(p.track[0][1], p.track[0][2]);
    g += `<circle cx="${ax}" cy="${ay}" r="${0.5 * rem}" fill="${SERIES[n]}" stroke="var(--panel)" stroke-width="2"/>`;
    // The name goes on the inside of the rising point, clear of the N/E/S/W letters.
    const k = 2.2 * rem / Math.max(Math.hypot(ax - c, ay - c), 1);
    g += `<text x="${ax + (c - ax) * k}" y="${ay + (c - ay) * k + 0.45 * rem}" text-anchor="middle" fill="var(--text)" font-size="${1.3 * rem}">${p.name}</text>`;
    if (ms(p.aos) <= nowMs && nowMs < ms(p.los)) {
      const pt = p.track.reduce((a, b) => Math.abs(ms(b[0]) - nowMs) < Math.abs(ms(a[0]) - nowMs) ? b : a);
      const [x, y] = xy(pt[1], pt[2]);
      g += `<circle cx="${x}" cy="${y}" r="${0.9 * rem}" fill="var(--text)" stroke="${SERIES[n]}" stroke-width="3"/>`;
    }
  });
  svg.setAttribute('viewBox', `0 0 ${S} ${S}`);
  svg.innerHTML = g;
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
  for (const s of spots) {
    let [x, y, km] = azimuthal(home, s.lat, s.lon);
    const far = km > maxKm;
    if (far) { x *= maxKm / km; y *= maxKm / km; }
    g += `<circle cx="${cx + x * k}" cy="${cy + y * k}" r="${(far ? 0.5 : 0.7) * rem}" fill="${far ? 'var(--dim)' : SERIES[0]}" stroke="var(--panel)" stroke-width="1.5"/>`;
  }
  g += `<circle cx="${cx}" cy="${cy}" r="${0.6 * rem}" fill="var(--text)"/>`;
  svg.innerHTML = g;
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
}

// Keep as many rows as fit in a list, then say how many more there are.
function fitList(list, total) {
  const rows = [...list.children];
  const bottom = () => list.getBoundingClientRect().bottom;
  while (rows.length && rows[rows.length - 1].getBoundingClientRect().bottom > bottom()) rows.pop().remove();
  if (total <= rows.length) return;
  const more = document.createElement('div');
  more.className = 'more';
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
    const body = `<div class="sats"><svg class="sky"></svg><div class="passes">` +
      upcoming.slice(0, 7).map((p, n) => `<div class="pass"><span>${n < 3 ? `<i style="background:${SERIES[n]}"></i>` : ''}</span>
        <span class="sat">${p.name}</span><span class="${live(p) ? 'up' : ''}">${when(p)}</span><span>${Math.round(p.max_el)}°</span>
        <span class="sub">${dir8(p.aos_az)} → ${dir8(p.los_az)} · ${mins(ms(p.los) - ms(p.aos))} min${radio(p)}</span></div>`).join('') +
      `</div></div>`;
    return { title, body, credit, draw: el => skyPlot(el.querySelector('.sky'), plotted, nowMs) };
  },
  function pota() {
    const st = state.station, nowMs = now().getTime();
    const spots = (state.pota.spots || []).filter(s => !s.qrt);
    const title = `POTA spots · newest first · ${spots.length} on air`;
    const credit = 'Spots: Parks on the Air · Map: Natural Earth';
    if (!spots.length) return { title, credit, body: '<div class="empty">No POTA activators spotted right now.</div>' };
    const mi = km => Math.round(km / KM_PER_MI);
    const freq = s => s.khz.toFixed(1).replace(/\.0$/, '');
    const ago = s => `${Math.max(0, Math.round((nowMs - new Date(s.time)) / 60000))} min ago`;
    const placed = spots.filter(s => s.km != null);
    const body = `<div class="pota"><svg class="spotmap"></svg><div class="spots">` +
      spots.slice(0, 20).map(s => `<div class="spot"><span class="call mono">${s.activator}</span><span class="f">${freq(s)} ${s.mode}</span>
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
    // The farthest station either way. The feed names it and its square,
    // not its country.
    const far = f => f ? `${f.call} ${mi(f.km)} mi` : '—';
    const body = `<div class="psk"><div class="mapbox"><canvas></canvas><svg></svg></div>
      <div class="legend"><span><i style="background:${SERIES[0]}"></i>${sq} heard there</span>
        <span><i style="background:${SERIES[1]}"></i>Heard in ${sq}</span><span>Shaded: night · last ${p.window_min} min</span></div>
      <div class="bandrow" style="grid-template-columns:repeat(${p.bands.length},1fr)">` +
      p.bands.map(b => `<div><b>${b.band}</b><div class="n">${b.out} / ${b.in}</div><div class="far">${far([b.far_out, b.far_in].filter(Boolean).sort((x, y) => y.km - x.km)[0])}</div></div>`).join('') +
      `</div></div>`;
    return { title, body, credit, draw: el => worldMap(el.querySelector('.mapbox'), p.points || [], now().getTime()) };
  },
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

function renderFeature() {
  if (!state) return;
  const p = PAGES[page % PAGES.length]();
  $('feature-title').textContent = p.title;
  $('feature-body').innerHTML = p.body;
  resized.disconnect();
  drawn = p.draw;
  if (drawn) {
    drawn($('feature-body'));
    $('feature-body').querySelectorAll('svg').forEach(el => resized.observe(el));
  }
  $('credit').textContent = p.credit;
  $('dots').innerHTML = PAGES.length > 1
    ? PAGES.map((_, i) => `<i class="${i === page % PAGES.length ? 'on' : ''}"></i>`).join('')
    : '';
}

function nextPage() { page = (page + 1) % PAGES.length; renderFeature(); }

let pageTimer = setInterval(nextPage, PAGE_MS);
// On a touch screen a tap moves on, and the rotation restarts from there.
$('feature').addEventListener('click', () => {
  clearInterval(pageTimer);
  nextPage();
  pageTimer = setInterval(nextPage, PAGE_MS);
});

async function poll() {
  try {
    const sent = Date.now();
    const r = await fetch('/api/state', { cache: 'no-store' });
    state = await r.json();
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

setInterval(tickClocks, 1000);
tickClocks();
poll();
setInterval(poll, POLL_MS);
