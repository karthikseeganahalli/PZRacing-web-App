/*
 * Parser for PZRacing .SES session files.
 *
 * File layout:
 *  - ASCII header (CRLF lines starting with '*'), ending with a CSV-style
 *    column list line: TIME;LAT;LON;GPS;DIR;GEAR;ACC(X);...;RPM;TEMP
 *  - Binary body: fixed 52-byte big-endian records:
 *      uint32  time        (10 ms ticks)
 *      int32   latitude    (degrees * 1e7)
 *      int32   longitude   (degrees * 1e7)
 *      uint8   gpsFix      (ASCII char, 'A' = active fix)
 *      uint16  heading     (degrees * 10)
 *      uint8   gear        (ASCII char, '0' = no sensor)
 *      int16   accX, accY, accZ   (g * 100)
 *      int16   battery     (V * 100, logger internal battery)
 *      int16   power       (V * 100, external/vehicle power)
 *      int16   speed1, speed2     (wheel speeds)
 *      int16   an1..an8    (raw ADC 0-1023, calibrated via header)
 *      int16   speedGps    (km/h * 10)
 *      int16   rpm
 *      int16   temp        (C * 100)
 */

const RECORD_SIZE = 52;
const TICK_SECONDS = 0.01;
const MPH_TO_KMH = 1.60934;

function parseSES(buffer) {
  const bytes = new Uint8Array(buffer);
  const probe = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 8192)));

  const colIdx = probe.indexOf('TIME;LAT;LON');
  if (colIdx === -1) {
    // The channel-list line ("TIME;LAT;LON;…") is the one field we can't work
    // without: it marks where the ASCII header ends and the binary body begins.
    // Tailor the message to what the file looks like so the user knows why.
    const looksLikeSes = /\*REV=|\*NAME=|VEHICLE=/.test(probe);
    if (looksLikeSes) {
      throw new Error(
        'This looks like a PZRacing session, but the channel-list header line ' +
        '("TIME;LAT;LON;…") is missing, so the start of the data can\'t be located. ' +
        'The header is probably truncated or from an unsupported firmware revision. ' +
        'Try re-exporting the .SES file from the logger.'
      );
    }
    throw new Error(
      'This doesn\'t look like a PZRacing .SES file: the required channel-list ' +
      'header line ("TIME;LAT;LON;…") was not found. Make sure you selected a ' +
      '.SES session file exported by the PZRacing logger (not a .vbo, .csv, or other file).'
    );
  }
  const headerEnd = probe.indexOf('\r\n', colIdx) + 2;
  const headerText = probe.slice(0, headerEnd);

  const header = parseHeader(headerText);
  const bodyEnd = findBinaryEnd(bytes, headerEnd);
  const rawRecords = parseRecords(buffer, headerEnd, bodyEnd);

  // Speed is stored in the unit the logger was configured for (km/h or mph).
  // Normalise everything to km/h up front so all downstream code — validation,
  // lap analysis, VBO ("velocity kmh"), CSV — stays unit-correct without change.
  if (header.speedUnit === 'M') {
    for (const r of rawRecords) {
      r.speedGps *= MPH_TO_KMH;
      r.speed1 *= MPH_TO_KMH;
      r.speed2 *= MPH_TO_KMH;
    }
  }

  // (1) Validate. Corruption, truncation and firmware summary footers show up as
  // trailing records with physically impossible values. Drop the trailing run of
  // invalid records, and count any that remain in the interior. This is a safety
  // net independent of the *CLOSE FILE marker above, so unknown footer/corruption
  // shapes are still caught rather than silently exported.
  let validEnd = rawRecords.length;
  while (validEnd > 0 && !isPlausibleRecord(rawRecords[validEnd - 1])) validEnd--;
  const droppedTrailing = rawRecords.length - validEnd;
  const records = rawRecords.slice(0, validEnd);
  const interiorBad = records.reduce((n, r) => n + (isPlausibleRecord(r) ? 0 : 1), 0);

  const footerText = bodyEnd < bytes.length
    ? new TextDecoder('latin1').decode(bytes.subarray(bodyEnd))
    : '';

  const warnings = collectWarnings(header, records, {
    droppedTrailing,
    interiorBad,
    leftoverBytes: (bodyEnd - headerEnd) % RECORD_SIZE,
    footerText,
    speedUnit: header.speedUnit,
  });

  return { header, records, warnings };
}

// Hard sanity bounds for a single record. Only physically impossible values are
// rejected, so legitimate pre-GPS-fix samples (lat/lon 0, speed 0) are never
// mistaken for corruption.
function isPlausibleRecord(r) {
  return (
    Number.isFinite(r.t) && r.t >= 0 && r.t < 6 * 3600 && // session under 6 h
    Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180 &&
    r.speedGps >= -1 && r.speedGps <= 500 &&              // km/h
    r.rpm >= 0 && r.rpm <= 30000
  );
}

// Build human-readable warnings so anything the parser drops or distrusts is
// surfaced to the user instead of silently affecting the export.
function collectWarnings(header, records, diag) {
  const warnings = [];
  const plural = (n) => (n > 1 ? 's' : '');
  const were = (n) => (n > 1 ? 'were' : 'was');

  // Speed logged in mph and normalised to km/h — tell the user so a converted
  // value is never mistaken for the original reading.
  if (diag.speedUnit === 'M') {
    warnings.push('Speeds were logged in mph and converted to km/h in all outputs.');
  }

  // Channels the firmware marked active but whose calibration didn't parse.
  const unreadable = header.analogChannels
    .filter((c) => c.unreadable)
    .map((c) => c.name || `AN${c.index}`);
  if (unreadable.length) {
    warnings.push(
      `${unreadable.length} channel${plural(unreadable.length)} (${unreadable.join(', ')}) ` +
      `had unreadable calibration and ${were(unreadable.length)} skipped.`
    );
  }

  // (3) Header vs output disagreement: real (named, non-placeholder) channels
  // exist but none came through as active — a likely firmware-flag mismatch.
  const named = header.analogChannels.filter(
    (c) => c.name && !/^ANALOG\s*\d+$/i.test(c.name) && !/^AN\d+$/i.test(c.name)
  );
  const active = header.analogChannels.filter((c) => c.enabled);
  if (named.length && active.length === 0) {
    warnings.push(
      `${named.length} named channel${plural(named.length)} found ` +
      `(${named.map((c) => c.name).join(', ')}) but none are marked active — ` +
      `possible firmware-version mismatch; channels were not exported.`
    );
  }

  // (1) Records dropped/flagged by validation.
  if (diag.droppedTrailing > 0) {
    warnings.push(
      `${diag.droppedTrailing} trailing record${plural(diag.droppedTrailing)} had implausible ` +
      `values and ${were(diag.droppedTrailing)} dropped (likely a firmware summary footer or truncated data).`
    );
  }
  if (diag.interiorBad > 0) {
    warnings.push(
      `${diag.interiorBad} record${plural(diag.interiorBad)} in the session contain implausible ` +
      `values; the data may be partially corrupt.`
    );
  }
  if (diag.leftoverBytes > 0) {
    warnings.push(
      `${diag.leftoverBytes} leftover byte${plural(diag.leftoverBytes)} after the last complete ` +
      `record ${were(diag.leftoverBytes)} ignored.`
    );
  }

  // (2) Cross-check computed peaks against the logger's own summary footer, which
  // reports SP MAX / RPM MAX per lap. The test is one-directional: a raw sample
  // peak can legitimately sit *above* the device's filtered peak (e.g. a single
  // ignition-pickup RPM spike), so only a computed peak well *below* what the
  // device recorded is meaningful — it means the export is missing data.
  if (diag.footerText && records.length) {
    const reportedMax = (re) => {
      const vals = [...diag.footerText.matchAll(re)].map((m) => parseFloat(m[1]));
      return vals.length ? Math.max(...vals) : NaN;
    };
    const undershoot = (label, reported, computed, fmt) => {
      if (reported > 0 && computed < reported * 0.85) {
        warnings.push(
          `Computed max ${label} (${fmt(computed)}) is well below the logger's reported ` +
          `${fmt(reported)} — the export may be missing data.`
        );
      }
    };
    const kmh = (v) => `${v.toFixed(1)} km/h`;
    const rpm = (v) => `${Math.round(v)} rpm`;
    // The footer's SP MAX is in the logger's unit; convert to km/h to match the
    // (already normalised) record speeds before comparing.
    const spFactor = diag.speedUnit === 'M' ? MPH_TO_KMH : 1;
    undershoot('speed', reportedMax(/SP MAX:\s*([\d.]+)/g) * spFactor, Math.max(...records.map((r) => r.speedGps)), kmh);
    undershoot('RPM', reportedMax(/RPM MAX:\s*(\d+)/g), Math.max(...records.map((r) => r.rpm)), rpm);
  }

  return warnings;
}

// REV 6.3 appends an ASCII summary footer ("*CLOSE FILE:USB CON." followed by
// "#LAP…" lines) after the binary records. Without trimming it, those bytes get
// read as bogus 52-byte records. Return the offset where the footer begins, or
// the end of the buffer if there is none (e.g. REV 4.4, which has no footer).
function findBinaryEnd(bytes, offset) {
  const marker = '*CLOSE FILE'; // ASCII; bytes map 1:1 to char codes
  outer: for (let i = offset; i <= bytes.length - marker.length; i++) {
    if (bytes[i] !== 0x2a) continue; // '*'
    for (let j = 1; j < marker.length; j++) {
      if (bytes[i + j] !== marker.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return bytes.length;
}

function parseHeader(text) {
  const lines = text.split('\r\n').filter((l) => l.startsWith('*'));
  const header = {
    rev: '',
    name: '',
    vehicle: '',
    date: '',
    time: '',
    track: '',
    speedUnit: 'K', // 'K' = km/h, 'M' = mph (from the *SP GPS unit field)
    analogChannels: [], // { index, name, unit, rawLo, rawHi, calLo, calHi, enabled }
    finishLine: null,
    splits: [],
  };

  for (const line of lines) {
    const body = line.slice(1);

    if (body.startsWith('REV=')) {
      header.rev = body.slice(4).trim();
    } else if (body.startsWith('NAME=')) {
      // *NAME=VOCINO   VEHICLE=R3       DATE=05/06/20 TIME=10:02:48 FS=+120 TRACK=MISANO
      header.name = (body.match(/NAME=(.{0,9})/) || [])[1]?.trim() || '';
      header.vehicle = (body.match(/VEHICLE=(.{0,9})/) || [])[1]?.trim() || '';
      header.date = (body.match(/DATE=(\S+)/) || [])[1] || '';
      header.time = (body.match(/TIME=(\S+)/) || [])[1] || '';
      header.track = (body.match(/TRACK=(.*)$/) || [])[1]?.trim() || '';
    } else if (/^A[1-8]=/.test(body)) {
      const index = parseInt(body[1], 10);
      const parts = body.slice(3).split('/');
      // rawLo/rawHi/calLo/calHi/flag/name/?/unit/calLo2/calHi2/active/?
      // The reliable "logged" flag is the 11th field (parts[10] === '1'), which
      // holds across firmware revisions. Older firmware (REV 4.4) also set the
      // 5th field (parts[4]) to '4' for active channels, but REV 6.3 leaves it
      // '0' for every channel, so parts[4] alone silently drops all channels.
      // Fall back to the old heuristic only when parts[10] is absent.
      const flagEnabled = parts[10] !== undefined ? parts[10] === '1' : parts[4] !== '0';
      const rawLo = parseFloat(parts[0]);
      const rawHi = parseFloat(parts[1]);
      const calLo = parseFloat(parts[2]);
      const calHi = parseFloat(parts[3]);
      // A channel the firmware marked active but whose calibration didn't parse
      // (missing fields, or an unexpected/newer line layout) would otherwise
      // export as NaN for every sample. Treat it as unreadable: exclude it from
      // output (enabled = false) and flag it so the UI can report it.
      const calValid = [rawLo, rawHi, calLo, calHi].every(Number.isFinite);
      header.analogChannels.push({
        index,
        name: (parts[5] || `AN${index}`).trim(),
        unit: (parts[7] || '').trim(),
        rawLo,
        rawHi,
        calLo,
        calHi,
        enabled: flagEnabled && calValid,
        unreadable: flagEnabled && !calValid,
      });
    } else if (body.startsWith('SP GPS=')) {
      // *SP GPS=flag/UNIT/calLo/calHi/... — UNIT is 'K' (km/h) or 'M' (mph).
      // This is the unit the GPS speed (and wheel speeds) are stored in.
      header.speedUnit = (body.slice(7).split('/')[1] || 'K').trim().toUpperCase();
    } else if (body.startsWith('FL=')) {
      const [lat, lon] = body.slice(3).split('/').map(parseFloat);
      header.finishLine = { lat, lon };
    } else if (/^I[1-9]=/.test(body)) {
      const [lat, lon] = body.slice(3).split('/').map(parseFloat);
      header.splits.push({ lat, lon });
    }
  }

  return header;
}

function parseRecords(buffer, offset, end = buffer.byteLength) {
  const count = Math.floor((end - offset) / RECORD_SIZE);
  const dv = new DataView(buffer);
  const records = new Array(count);

  for (let i = 0; i < count; i++) {
    const o = offset + i * RECORD_SIZE;
    records[i] = {
      t: dv.getUint32(o) * TICK_SECONDS, // seconds from session start
      lat: dv.getInt32(o + 4) / 1e7,
      lon: dv.getInt32(o + 8) / 1e7,
      fix: String.fromCharCode(dv.getUint8(o + 12)),
      heading: dv.getUint16(o + 13) / 10,
      gear: String.fromCharCode(dv.getUint8(o + 15)),
      accX: dv.getInt16(o + 16) / 100,
      accY: dv.getInt16(o + 18) / 100,
      accZ: dv.getInt16(o + 20) / 100,
      battery: dv.getInt16(o + 22) / 100,
      power: dv.getInt16(o + 24) / 100,
      speed1: dv.getInt16(o + 26),
      speed2: dv.getInt16(o + 28),
      an: [
        dv.getInt16(o + 30),
        dv.getInt16(o + 32),
        dv.getInt16(o + 34),
        dv.getInt16(o + 36),
        dv.getInt16(o + 38),
        dv.getInt16(o + 40),
        dv.getInt16(o + 42),
        dv.getInt16(o + 44),
      ],
      speedGps: dv.getInt16(o + 46) / 10,
      rpm: dv.getInt16(o + 48),
      temp: dv.getInt16(o + 50) / 100,
    };
  }

  return records;
}

// Map a raw ADC value through a channel's linear calibration.
function calibrate(channel, raw) {
  const { rawLo, rawHi, calLo, calHi } = channel;
  if (rawHi === rawLo) return calLo;
  return calLo + ((raw - rawLo) / (rawHi - rawLo)) * (calHi - calLo);
}

// Session start as a Date. PZRacing dates are DD/MM/YY (Italian).
// DATE/TIME can be absent from the header; when a component is missing we fall
// back to a fixed, valid base (2000-01-01 00:00:00) so exported timestamps stay
// well-formed. Only the absolute wall-clock origin is arbitrary in that case —
// relative sample times (and therefore lap timing) are unaffected.
function sessionStartDate(header) {
  const [d, m, y] = (header.date || '').split('/').map(Number);
  const [hh, mm, ss] = (header.time || '').split(':').map(Number);
  return new Date(
    Number.isFinite(y) ? 2000 + y : 2000,
    Number.isFinite(m) ? m - 1 : 0,
    Number.isFinite(d) ? d : 1,
    Number.isFinite(hh) ? hh : 0,
    Number.isFinite(mm) ? mm : 0,
    Number.isFinite(ss) ? ss : 0
  );
}

// Loaded as a plain script (no ES modules) so the app also works when
// index.html is opened directly from disk via file://. Functions above are
// declared at global scope and consumed by exporters.js / app.js.
