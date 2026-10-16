// Turns a provider-agnostic "raw activity" into the normalised activity record stored in
// data/routes.json plus a published track. Every provider adapter (GPX, intervals.icu, …)
// produces the same raw shape:
//
//   { rider, source, source_label, source_activity_id, url, device, name, type,
//     points: [{lat, lon, ele, time, hr, seg}], summary: {distance_km, …} | null,
//     fallbackDate: 'YYYY-MM-DD' | null, sha256 }
//
// Statistics supplied by the provider (device-measured) win over values computed from GPS.
// Anything that cannot be measured or computed stays null; nothing is invented.

import { haversine, simplifyTo, trimEnds, bboxCenter, round } from './geo.mjs';
import { SETTINGS } from './config.mjs';

const CYCLING_TYPES = new Map([
  ['mountain_biking', 'MTB'], ['mountainbikeride', 'MTB'], ['mtb', 'MTB'], ['ciclismo de montaña', 'MTB'],
  ['emountainbikeride', 'MTB'], ['e_mountain_biking', 'MTB'],
  ['gravel_cycling', 'Gravel'], ['gravelride', 'Gravel'], ['gravel', 'Gravel'],
  ['road_biking', 'Carretera'], ['road_cycling', 'Carretera'], ['roadride', 'Carretera'],
  ['cycling', null], ['biking', null], ['ride', null], ['ebikeride', null], ['bike', null], ['1', null],
]);
const NON_CYCLING = /run|walk|hik|swim|row|ski|yoga|strength|treadmill|elliptical|virtual|indoor/i;

export function classifyType(raw) {
  if (!raw) return { cycling: true, type: null };
  const key = String(raw).trim().toLowerCase();
  if (CYCLING_TYPES.has(key)) return { cycling: true, type: CYCLING_TYPES.get(key) };
  if (NON_CYCLING.test(key)) return { cycling: false, type: null };
  return { cycling: true, type: null };
}

export function computeStats(points, { hysteresis = SETTINGS.elevationHysteresisM } = {}) {
  const timed = points.filter((p) => p.time != null).length >= points.length * 0.9;
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (a.seg !== b.seg) continue;
    const d = haversine(a, b);
    if (timed && a.time != null && b.time != null) {
      if (b.time <= a.time ? d > 50 : (d / 1000) / ((b.time - a.time) / 3_600_000) > SETTINGS.maxPlausibleSpeedKmh) continue;
    }
    distance += d;
  }

  let elevation = null;
  const eles = points.map((p) => p.ele).filter((e) => e != null);
  if (eles.length >= points.length * 0.5 && eles.length >= 2) {
    // Hysteresis: only count a climb once it exceeds the threshold above the last low point.
    let gain = 0, ref = eles[0];
    for (const e of eles) {
      if (e > ref + hysteresis) { gain += e - ref; ref = e; }
      else if (e < ref) ref = e;
    }
    elevation = gain;
  }

  let elapsed = null, moving = null, startTime = null;
  if (timed) {
    const times = points.map((p) => p.time).filter((t) => t != null);
    startTime = Math.min(...times);
    elapsed = Math.round((Math.max(...times) - startTime) / 1000);
    moving = 0;
    let anchor = points.findIndex((p) => p.time != null), acc = 0;
    for (let i = anchor + 1; i < points.length; i++) {
      const p = points[i];
      if (p.time == null) continue;
      const prev = points[i - 1];
      if (prev.seg === p.seg) acc += haversine(prev, p);
      const dt = (p.time - points[anchor].time) / 1000;
      if (dt >= SETTINGS.movingWindowS) {
        const kmh = (acc / 1000) / (dt / 3600);
        if (kmh >= SETTINGS.movingMinSpeedKmh && kmh <= SETTINGS.maxPlausibleSpeedKmh) moving += dt;
        anchor = i;
        acc = 0;
      }
    }
    moving = Math.round(moving);
  }

  const hrs = points.map((p) => p.hr).filter((h) => h != null);
  const avgHr = hrs.length >= points.length * 0.5 ? hrs.reduce((s, h) => s + h, 0) / hrs.length : null;
  return {
    distance_km: round(distance / 1000, 2),
    elevation_gain_m: elevation == null ? null : Math.round(elevation),
    moving_time_s: moving || null,
    elapsed_time_s: elapsed || null,
    avg_hr_bpm: avgHr == null ? null : Math.round(avgHr),
    start_ms: startTime,
  };
}

export function localDate(ms, timeZone = SETTINGS.timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
export function localHourMinute(ms, timeZone = SETTINGS.timezone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)).replace(':', '');
}

// Track format: { activity, start_time, points: [[lat, lon, ele|null, secondsFromStart|null], …] }
export function buildTrack(points, startMs) {
  const trimmed = trimEnds(points, SETTINGS.privacyTrimM);
  const simple = simplifyTo(trimmed, SETTINGS.maxTrackPoints);
  return simple.map((p) => [
    round(p.lat, 5),
    round(p.lon, 5),
    p.ele == null ? null : round(p.ele, 1),
    p.time == null || startMs == null ? null : Math.round((p.time - startMs) / 1000),
  ]);
}

// Elevation profile for the home cards: `samples` altitudes at equal distance steps along the track.
export function buildProfile(trackPoints, samples = 48) {
  const pts = trackPoints.filter(([, , ele]) => ele != null).map(([lat, lon, ele]) => ({ lat, lon, ele }));
  if (pts.length < 10 || pts.length < trackPoints.length * 0.5) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
  const total = cum.at(-1);
  if (!total) return null;
  const out = [];
  for (let k = 0, j = 0; k < samples; k++) {
    const d = (total * k) / (samples - 1);
    while (j < pts.length - 2 && cum[j + 1] < d) j++;
    const span = cum[j + 1] - cum[j] || 1;
    out.push(pts[j].ele + ((pts[j + 1].ele - pts[j].ele) * (d - cum[j])) / span);
  }
  // Light smoothing so sensor noise does not read as terrain.
  return out.map((_, i) => Math.round(out.slice(Math.max(0, i - 1), i + 2).reduce((s, v, __, a) => s + v / a.length, 0)));
}

export function buildPreview(trackPoints) {
  const pts = trackPoints.map(([lat, lon]) => ({ lat, lon }));
  return simplifyTo(pts, SETTINGS.maxPreviewPoints, 8).map((p) => [p.lat, p.lon]);
}

export class ActivityError extends Error {}

/**
 * @returns {{activity: object, track: Array|null}}
 */
export function normalizeActivity(raw, { riders, shareHeartRate = false } = {}) {
  if (!raw.rider) throw new ActivityError('Activity has no rider');
  if (riders && !riders.some((r) => r.id === raw.rider)) throw new ActivityError(`Unknown rider "${raw.rider}" (add it to data/riders.json)`);
  const kind = classifyType(raw.type);
  if (!kind.cycling) throw new ActivityError(`Activity type "${raw.type}" is not a cycling activity`);

  const points = raw.points || [];
  const computed = points.length >= 2 ? computeStats(points) : {};
  const summary = raw.summary || {};
  const pick = (key) => (summary[key] != null ? { value: summary[key], computed: false } : { value: computed[key] ?? null, computed: computed[key] != null });

  const startMs = summary.start_time ? Date.parse(summary.start_time) : computed.start_ms ?? null;
  const date = startMs != null ? localDate(startMs) : raw.fallbackDate;
  if (!date) throw new ActivityError('Activity has no timestamps and no date (name the file YYYY-MM-DD-….gpx)');

  const fields = ['distance_km', 'elevation_gain_m', 'moving_time_s', 'elapsed_time_s', 'avg_hr_bpm'];
  const stats = {}, computedFields = [];
  for (const f of fields) {
    const { value, computed: c } = pick(f);
    stats[f] = value;
    if (c && value != null) computedFields.push(f);
  }
  if (!shareHeartRate) {
    stats.avg_hr_bpm = null;
    const i = computedFields.indexOf('avg_hr_bpm');
    if (i !== -1) computedFields.splice(i, 1);
  }
  let avgSpeed = summary.avg_speed_kmh ?? null;
  if (avgSpeed == null && stats.distance_km && (stats.moving_time_s || stats.elapsed_time_s)) {
    avgSpeed = round(stats.distance_km / ((stats.moving_time_s || stats.elapsed_time_s) / 3600), 2);
    computedFields.push('avg_speed_kmh');
  }

  const track = points.length >= 2 ? buildTrack(points, startMs) : null;
  const id = `${raw.rider}-${date.replace(/-/g, '')}${startMs != null ? '-' + localHourMinute(startMs) : ''}`;
  const activity = {
    id,
    rider: raw.rider,
    source: raw.source,
    source_label: raw.source_label ?? null,
    source_activity_id: raw.source_activity_id ?? null,
    url: raw.url ?? null,
    device: raw.device ?? null,
    name: raw.name ?? null,
    type: kind.type,
    date,
    start_time: startMs != null ? new Date(startMs).toISOString().replace('.000Z', 'Z') : null,
    distance_km: stats.distance_km,
    elevation_gain_m: stats.elevation_gain_m,
    moving_time_s: stats.moving_time_s,
    elapsed_time_s: stats.elapsed_time_s,
    avg_speed_kmh: avgSpeed,
    avg_hr_bpm: stats.avg_hr_bpm,
    computed: computedFields,
    track: track && track.length >= 2 ? `data/tracks/${id}.json` : null,
    map_center: track && track.length >= 2 ? bboxCenter(track.map(([lat, lon]) => ({ lat, lon }))) : null,
    sha256: raw.sha256 ?? null,
    imported_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  return { activity, track: track && track.length >= 2 ? track : null };
}
