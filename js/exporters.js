/*
 * Exporters: RaceLogic .vbo (for RaceChrono Pro import) and generic .csv.
 * Plain script (no ES modules); relies on calibrate() and sessionStartDate()
 * defined globally in parser.js.
 */

// Channels present in every export, beyond the VBO standard columns.
function activeChannels(header) {
  return header.analogChannels.filter((c) => c.enabled);
}

function pad(n, width, decimals = 0) {
  const neg = n < 0;
  let s = Math.abs(n).toFixed(decimals);
  const target = neg ? width - 1 : width;
  while (s.length < target) s = '0' + s;
  return (neg ? '-' : '') + s;
}

// VBO position format: signed, zero-padded integer part, 5 decimals, matching
// RaceLogic/RaceBox output. Latitude uses 5 integer digits, longitude 6.
function fmtCoord(valueMinutes, intDigits) {
  const neg = valueMinutes < 0;
  const [intp, decp] = Math.abs(valueMinutes).toFixed(5).split('.');
  return (neg ? '-' : '+') + intp.padStart(intDigits, '0') + '.' + decp;
}
const fmtLat = (m) => fmtCoord(m, 5);
const fmtLon = (m) => fmtCoord(m, 6);

// Convert a lat/lon (degrees) to VBO minutes with positive-West longitude.
const latToMin = (lat) => lat * 60;
const lonToMin = (lon) => -lon * 60;

// Build a start/finish gate (two points spanning the track) from the SES
// finish-line point, oriented perpendicular to the direction of travel where
// the vehicle actually crosses it. RaceChrono matches this line against its
// track database to auto-detect the venue on import.
function startFinishGate(header, records, halfWidthM = 20) {
  const fl = header.finishLine;
  if (!fl) return null;

  // Nearest recorded position to the finish-line point.
  let best = null;
  let bestD = Infinity;
  const cosLat = Math.cos((fl.lat * Math.PI) / 180);
  for (const r of records) {
    const dLat = (r.lat - fl.lat) * 111320;
    const dLon = (r.lon - fl.lon) * 111320 * cosLat;
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  if (!best) return null;

  // Perpendicular to heading, offset ±halfWidth in metres → degrees.
  const perp = ((best.heading + 90) * Math.PI) / 180;
  const dN = (Math.cos(perp) * halfWidthM) / 111320;
  const dE = (Math.sin(perp) * halfWidthM) / (111320 * cosLat);

  const p1 = { lat: fl.lat + dN, lon: fl.lon + dE };
  const p2 = { lat: fl.lat - dN, lon: fl.lon - dE };
  return [p1, p2];
}

// Fraction (0..1) along segment P0->P1 where it crosses segment A->B, or null if
// they don't intersect. Planar coordinates (metres) — fine at track scale.
function segmentCrossFraction(p0, p1, a, b) {
  const rx = p1.x - p0.x, ry = p1.y - p0.y;
  const sx = b.x - a.x, sy = b.y - a.y;
  const denom = rx * sy - ry * sx;
  if (denom === 0) return null; // parallel
  const qpx = a.x - p0.x, qpy = a.y - p0.y;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

// Lap analysis from GPS crossings of the start/finish gate. Works for any
// firmware revision (needs only the header finish line + GPS records), unlike
// the REV 6.3 "#LAP" footer. Returns overall max speed plus, when a finish line
// and at least one completed lap exist, the lap count, best lap time, and the
// average speed over that best lap.
function computeLaps(header, records, minLapSeconds = 15) {
  const maxSpeed = records.length ? Math.max(...records.map((r) => r.speedGps)) : 0;
  const empty = { maxSpeed, lapCount: 0, bestLapTime: null, bestLapAvgSpeed: null };

  const fl = header.finishLine;
  const gate = startFinishGate(header, records);
  if (!fl || !gate || records.length < 2) return empty;

  const cosLat = Math.cos((fl.lat * Math.PI) / 180);
  const toXY = (r) => ({ x: (r.lon - fl.lon) * 111320 * cosLat, y: (r.lat - fl.lat) * 111320 });
  const A = toXY(gate[0]);
  const B = toXY(gate[1]);

  // Only trust points with an active GPS fix (skips pre-fix 0,0 samples).
  const fixed = records.filter((r) => r.fix === 'A' && (Math.abs(r.lat) > 0.001 || Math.abs(r.lon) > 0.001));

  const crossings = [];
  for (let i = 1; i < fixed.length; i++) {
    const frac = segmentCrossFraction(toXY(fixed[i - 1]), toXY(fixed[i]), A, B);
    if (frac === null) continue;
    const t = fixed[i - 1].t + frac * (fixed[i].t - fixed[i - 1].t);
    // Debounce: ignore a re-crossing that happens implausibly soon after the last.
    if (!crossings.length || t - crossings[crossings.length - 1] > minLapSeconds) crossings.push(t);
  }
  if (!crossings.length) return empty;

  // Laps are the crossing-to-crossing intervals. PZRacing sometimes starts
  // logging as the vehicle crosses the start/finish line, in which case the run
  // from session start to the first crossing is also a full lap; but a recording
  // that began mid-track leaves a short partial there instead. Count the leading
  // segment only when its duration is consistent with the crossing-to-crossing
  // laps. The partial after the last crossing is always the in-lap and dropped.
  const boundaries = [...crossings];
  const interior = crossings.slice(1).map((t, i) => t - crossings[i]);
  const lead = crossings[0] - fixed[0].t;
  if (interior.length) {
    const lo = Math.min(...interior);
    const hi = Math.max(...interior);
    if (lead >= 0.9 * lo && lead <= 1.25 * hi) boundaries.unshift(fixed[0].t);
  } else if (lead >= minLapSeconds) {
    boundaries.unshift(fixed[0].t);
  }

  const laps = [];
  for (let i = 1; i < boundaries.length; i++) {
    laps.push({ start: boundaries[i - 1], end: boundaries[i], time: boundaries[i] - boundaries[i - 1] });
  }
  if (!laps.length) return empty;

  const best = laps.reduce((a, b) => (b.time < a.time ? b : a));
  const inBest = records.filter((r) => r.t >= best.start && r.t <= best.end);
  const bestLapAvgSpeed = inBest.length
    ? inBest.reduce((s, r) => s + r.speedGps, 0) / inBest.length
    : null;

  return { maxSpeed, lapCount: laps.length, bestLapTime: best.time, bestLapAvgSpeed, laps };
}

// VBO time-of-day: HHMMSS.SS (UTC-agnostic; RaceChrono treats it as wall time)
function vboTime(startDate, tSeconds) {
  const ms = startDate.getTime() + tSeconds * 1000;
  const d = new Date(ms);
  const frac = (tSeconds % 1).toFixed(2).slice(1); // ".xx"
  return (
    String(d.getHours()).padStart(2, '0') +
    String(d.getMinutes()).padStart(2, '0') +
    String(d.getSeconds()).padStart(2, '0') +
    frac
  );
}

function toVBO(session) {
  const { header, records } = session;
  const start = sessionStartDate(header);
  const channels = activeChannels(header);

  const chanNames = channels.map((c) => c.name.toLowerCase().replace(/\s+/g, '_'));
  const extraNames = ['rpm', 'accel_x', 'accel_y', 'accel_z', 'voltage', ...chanNames];

  const dd = String(start.getDate()).padStart(2, '0');
  const mm = String(start.getMonth() + 1).padStart(2, '0');
  const yyyy = start.getFullYear();

  const lines = [];
  lines.push(`File created on ${dd}/${mm}/${yyyy} @ ${header.time.slice(0, 5)}`);
  lines.push('');
  lines.push('[header]');
  lines.push('satellites');
  lines.push('time');
  lines.push('latitude');
  lines.push('longitude');
  lines.push('velocity kmh');
  lines.push('heading');
  lines.push('height');
  for (const name of extraNames) lines.push(name);
  lines.push('');
  lines.push('[channel units]');
  lines.push('');
  lines.push('[comments]');
  lines.push('Converted from PZRacing .SES');
  lines.push(`Rider : ${header.name}  Vehicle : ${header.vehicle}`);
  if (header.track) lines.push(`Venue : ${header.track}`);
  lines.push('');

  // Start/finish line, so RaceChrono can auto-detect the track on import.
  const gate = startFinishGate(header, records);
  if (gate) {
    const [p1, p2] = gate;
    const coords =
      fmtLat(latToMin(p1.lat)) + ' ' + fmtLon(lonToMin(p1.lon)) + ' ' +
      fmtLat(latToMin(p2.lat)) + ' ' + fmtLon(lonToMin(p2.lon));
    lines.push('[laptiming]');
    lines.push('Start'.padEnd(13) + coords + ' ¬   Start / Finish');
    lines.push('');
  }

  lines.push('[column names]');
  lines.push(['sats', 'time', 'lat', 'long', 'velocity', 'heading', 'height', ...extraNames].join(' '));
  lines.push('');
  lines.push('[data]');

  for (const r of records) {
    const sats = r.fix === 'A' ? '008' : '000';

    const row = [
      sats,
      vboTime(start, r.t),
      fmtLat(latToMin(r.lat)),
      fmtLon(lonToMin(r.lon)),
      pad(r.speedGps, 7, 3),
      pad(r.heading, 6, 2),
      '+' + pad(0, 9, 2),
      String(r.rpm),
      r.accX.toFixed(2),
      r.accY.toFixed(2),
      r.accZ.toFixed(2),
      r.power.toFixed(2),
      ...channels.map((c) => calibrate(c, r.an[c.index - 1]).toFixed(2)),
    ];
    lines.push(row.join(' '));
  }

  return lines.join('\r\n') + '\r\n';
}

function toCSV(session) {
  const { header, records } = session;
  const start = sessionStartDate(header);
  const channels = activeChannels(header);

  const cols = [
    'time_s',
    'utc_time',
    'latitude',
    'longitude',
    'speed_gps_kmh',
    'heading_deg',
    'rpm',
    'accel_x_g',
    'accel_y_g',
    'accel_z_g',
    'power_v',
    ...channels.map((c) => `${c.name.toLowerCase().replace(/\s+/g, '_')}${c.unit ? '_' + c.unit : ''}`),
  ];

  const lines = [cols.join(',')];

  for (const r of records) {
    const ts = new Date(start.getTime() + r.t * 1000);
    const wall =
      String(ts.getHours()).padStart(2, '0') +
      ':' +
      String(ts.getMinutes()).padStart(2, '0') +
      ':' +
      String(ts.getSeconds()).padStart(2, '0') +
      (r.t % 1).toFixed(2).slice(1);

    const row = [
      r.t.toFixed(2),
      wall,
      r.lat.toFixed(7),
      r.lon.toFixed(7),
      r.speedGps.toFixed(1),
      r.heading.toFixed(1),
      r.rpm,
      r.accX.toFixed(2),
      r.accY.toFixed(2),
      r.accZ.toFixed(2),
      r.power.toFixed(2),
      ...channels.map((c) => calibrate(c, r.an[c.index - 1]).toFixed(2)),
    ];
    lines.push(row.join(','));
  }

  return lines.join('\r\n') + '\r\n';
}
