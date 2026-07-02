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
