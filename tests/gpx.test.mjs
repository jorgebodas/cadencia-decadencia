import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseGpx, GpxError } from '../scripts/lib/gpx.mjs';
import { computeStats, normalizeActivity, classifyType } from '../scripts/lib/activity.mjs';
import { gpxToRawActivity } from '../scripts/providers/gpx.mjs';
import { haversine } from '../scripts/lib/geo.mjs';
import { loop, toGpx } from './helpers.mjs';

const riders = JSON.parse(fs.readFileSync(new URL('../data/riders.json', import.meta.url))).riders;

test('parses a Garmin Connect GPX fixture (namespaces, extensions, HR)', () => {
  const gpx = parseGpx(fs.readFileSync(new URL('./fixtures/garmin-connect.gpx', import.meta.url), 'utf8'));
  assert.equal(gpx.name, 'Rivas-Vaciamadrid Ciclismo de montaña');
  assert.equal(gpx.type, 'mountain_biking');
  assert.equal(gpx.creator, 'Garmin Connect');
  assert.equal(gpx.points.length, 6);
  assert.deepEqual(gpx.points[0], { lat: 40.3512, lon: -3.5201, ele: 590.4, time: Date.parse('2026-10-18T07:02:11Z'), hr: 98, seg: 0 });
  assert.equal(gpx.points[5].seg, 1, 'second <trkseg> is tracked');
});

test('parses prefixed GPX (gpx:trkpt) and files without timestamps', () => {
  const pts = loop({ km: 5 });
  const a = parseGpx(toGpx(pts, { prefix: 'gpx' }));
  assert.equal(a.points.length, pts.length);
  const b = parseGpx(toGpx(pts, { withTime: false }));
  assert.ok(b.points.every((p) => p.time === null));
});

test('rejects invalid input with clear errors', () => {
  assert.throws(() => parseGpx('<html></html>'), GpxError);
  assert.throws(() => parseGpx('<gpx><rte><rtept lat="1" lon="1"/></rte></gpx>'), /planned route/);
  assert.throws(() => parseGpx('<gpx><trk><trkseg><trkpt lat="40" lon="-3"/></trkseg></trk></gpx>'), /fewer than two/);
});

test('distance, elevation, moving and elapsed time from GPS data', () => {
  const pts = loop({ km: 30, kmh: 18, stepS: 5, climb: 100, pause: { atS: 1800, forS: 900 } });
  const s = computeStats(pts.map((p) => ({ ...p, seg: 0 })));
  assert.ok(Math.abs(s.distance_km - 30) < 0.3, `distance ${s.distance_km}`);
  assert.equal(s.elapsed_time_s, 6000 + 900);
  assert.ok(Math.abs(s.moving_time_s - 6000) <= 30, `moving ${s.moving_time_s}`);
  assert.ok(Math.abs(s.elevation_gain_m - 100) <= 5, `elevation ${s.elevation_gain_m}`);
});

test('elevation hysteresis ignores sensor noise', () => {
  const flat = Array.from({ length: 500 }, (_, i) => ({ lat: 40 + i * 1e-4, lon: -3, ele: 600 + (i % 2 ? 1.5 : -1.5), time: i * 1000, hr: null, seg: 0 }));
  assert.equal(computeStats(flat).elevation_gain_m, 0);
});

test('GPS glitches (impossible jumps) do not inflate distance', () => {
  const pts = loop({ km: 10, stepS: 5 }).map((p) => ({ ...p, seg: 0 }));
  pts.splice(100, 0, { ...pts[100], lat: pts[100].lat + 0.5 }); // 55 km jump in 0 s
  assert.ok(Math.abs(computeStats(pts).distance_km - 10) < 0.2);
});

test('normalised activity: no invented values, privacy trim, HR opt-in', () => {
  const pts = loop({ km: 20 });
  const raw = gpxToRawActivity(toGpx(pts), { rider: 'jorge', fileName: 'x.gpx' });
  const { activity, track } = normalizeActivity(raw, { riders });
  assert.equal(activity.id, 'jorge-20261018-0900');
  assert.equal(activity.date, '2026-10-18');
  assert.equal(activity.start_time, '2026-10-18T07:00:00Z');
  assert.equal(activity.type, 'MTB');
  assert.equal(activity.avg_hr_bpm, null, 'heart rate is not published unless the rider opts in');
  assert.equal(activity.source_label, 'GPX · Garmin');
  assert.ok(activity.computed.includes('distance_km'));
  assert.ok(track.length <= 1500 && track.length >= 2);
  // Published track starts at least ~200 m away from the real start.
  assert.ok(haversine(pts[0], { lat: track[0][0], lon: track[0][1] }) >= 150);
  const withHr = normalizeActivity(raw, { riders, shareHeartRate: true }).activity;
  assert.equal(withHr.avg_hr_bpm, 140);
});

test('missing timestamps: date from file name, no times invented; otherwise rejected', () => {
  const gpx = toGpx(loop({ km: 8 }), { withTime: false });
  const raw = gpxToRawActivity(gpx, { rider: 'javi', fileName: '2026-09-27-torres.gpx' });
  raw.fallbackDate = '2026-09-27';
  const { activity } = normalizeActivity(raw, { riders });
  assert.equal(activity.date, '2026-09-27');
  assert.equal(activity.start_time, null);
  assert.equal(activity.moving_time_s, null);
  assert.equal(activity.avg_speed_kmh, null);
  const noDate = gpxToRawActivity(gpx.replace(/<metadata>.*<\/metadata>/, ''), { rider: 'javi', fileName: 'ride.gpx' });
  assert.throws(() => normalizeActivity(noDate, { riders }), /no timestamps and no date/);
});

test('non-cycling activities and unknown riders are rejected', () => {
  assert.equal(classifyType('running').cycling, false);
  assert.equal(classifyType('cycling').cycling, true);
  const raw = gpxToRawActivity(toGpx(loop({ km: 5 }), { type: 'running' }), { rider: 'jorge', fileName: 'r.gpx' });
  assert.throws(() => normalizeActivity(raw, { riders }), /not a cycling activity/);
  const raw2 = gpxToRawActivity(toGpx(loop({ km: 5 })), { rider: 'stranger', fileName: 'r.gpx' });
  assert.throws(() => normalizeActivity(raw2, { riders }), /Unknown rider/);
});

test('Garmin Connect export file name provides the source activity id', () => {
  const raw = gpxToRawActivity(toGpx(loop({ km: 5 })), { rider: 'jorge', fileName: 'imports/inbox/jorge/activity_24732819976.gpx' });
  assert.equal(raw.source_activity_id, '24732819976');
  assert.equal(gpxToRawActivity(toGpx(loop({ km: 5 }), { creator: 'StravaGPX' }), { rider: 'jorge', fileName: 'activity_24732819976.gpx' }).source_activity_id, null);
});
