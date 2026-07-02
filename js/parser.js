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

function parseSES(buffer) {
  const bytes = new Uint8Array(buffer);
  const probe = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 8192)));

  const colIdx = probe.indexOf('TIME;LAT;LON');
  if (colIdx === -1) {
    throw new Error('Not a PZRacing .SES file (column list not found in header)');
  }
  const headerEnd = probe.indexOf('\r\n', colIdx) + 2;
  const headerText = probe.slice(0, headerEnd);

  const header = parseHeader(headerText);
  const records = parseRecords(buffer, headerEnd);

  return { header, records };
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
      // rawLo/rawHi/calLo/calHi/flag/name/?/unit/calLo2/calHi2/?/?
      const enabled = parts[4] !== '0';
      header.analogChannels.push({
        index,
        name: (parts[5] || `AN${index}`).trim(),
        unit: (parts[7] || '').trim(),
        rawLo: parseFloat(parts[0]),
        rawHi: parseFloat(parts[1]),
        calLo: parseFloat(parts[2]),
        calHi: parseFloat(parts[3]),
        enabled,
      });
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

function parseRecords(buffer, offset) {
  const count = Math.floor((buffer.byteLength - offset) / RECORD_SIZE);
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
function sessionStartDate(header) {
  const [d, m, y] = header.date.split('/').map(Number);
  const [hh, mm, ss] = header.time.split(':').map(Number);
  return new Date(2000 + y, m - 1, d, hh, mm, ss);
}

// Loaded as a plain script (no ES modules) so the app also works when
// index.html is opened directly from disk via file://. Functions above are
// declared at global scope and consumed by exporters.js / app.js.
