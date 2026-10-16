import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../scripts/lib/config.mjs';

// A loop of `km` kilometres around a centre, ridden at `kmh`, one point every `stepS` seconds.
export function loop({ start = '2026-10-18T07:00:00Z', center = [40.35, -3.52], km = 30, kmh = 18, stepS = 5, jitterM = 0, seed = 1, phase = 0, pause = null, climb = 0 }) {
  const r = km / (2 * Math.PI); // km
  const totalS = (km / kmh) * 3600;
  let rnd = seed;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const pts = [];
  let t = Date.parse(start);
  for (let s = 0; s <= totalS; s += stepS) {
    const a = phase + (s / totalS) * 2 * Math.PI;
    const jLat = (jitterM * rand()) / 111_000, jLon = (jitterM * rand()) / (111_000 * Math.cos((center[0] * Math.PI) / 180));
    pts.push({
      lat: center[0] + (r * Math.sin(a)) / 111 + jLat,
      lon: center[1] + (r * (1 - Math.cos(a))) / (111 * Math.cos((center[0] * Math.PI) / 180)) + jLon,
      ele: 600 + climb * Math.sin(a / 2),
      time: t,
      hr: 140,
    });
    t += stepS * 1000;
    if (pause && Math.abs(s - pause.atS) < stepS / 2) t += pause.forS * 1000;
  }
  return pts;
}

export function toGpx(points, { name = 'Rivas-Vaciamadrid Ciclismo de montaña', type = 'mountain_biking', creator = 'Garmin Connect', withTime = true, prefix = '' } = {}) {
  const p = prefix ? `${prefix}:` : '';
  const ns = prefix ? ` xmlns:${prefix}="http://www.topografix.com/GPX/1/1"` : ' xmlns="http://www.topografix.com/GPX/1/1"';
  const pts = points.map((pt) =>
    `<${p}trkpt lat="${pt.lat.toFixed(7)}" lon="${pt.lon.toFixed(7)}"><${p}ele>${pt.ele.toFixed(1)}</${p}ele>` +
    (withTime ? `<${p}time>${new Date(pt.time).toISOString().replace('.000', '')}</${p}time>` : '') +
    `<${p}extensions><ns3:TrackPointExtension><ns3:hr>${pt.hr}</ns3:hr></ns3:TrackPointExtension></${p}extensions></${p}trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<${p}gpx creator="${creator}" version="1.1"${ns} xmlns:ns3="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <${p}metadata><${p}time>${new Date(points[0].time).toISOString()}</${p}time></${p}metadata>
  <${p}trk><${p}name>${name.replace(/&/g, '&amp;')}</${p}name><${p}type>${type}</${p}type><${p}trkseg>
${pts}
  </${p}trkseg></${p}trk>
</${p}gpx>
`;
}

// A throwaway copy of the repository data so tests never touch the real database.
export function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadencia-'));
  for (const rel of ['data/routes.json', 'data/riders.json', 'data/schema/routes.schema.json', 'data/schema/riders.schema.json', 'data/schema/track.schema.json', 'CNAME']) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  }
  fs.mkdirSync(path.join(dir, 'imports/inbox'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data/tracks'), { recursive: true });
  return dir;
}

export function drop(dir, rider, file, gpx) {
  const p = path.join(dir, 'imports/inbox', rider, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, gpx);
  return p;
}

export const readDb = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'data/routes.json'), 'utf8'));
export const fakeGeocode = async () => 'Rivas-Vaciamadrid · Madrid';
export const silentReport = () => ({ lines: [], errors: 0, changed: false, add(l) { this.lines.push(l); }, error(l) { this.errors++; this.lines.push('ERR ' + l); }, flush() {} });
