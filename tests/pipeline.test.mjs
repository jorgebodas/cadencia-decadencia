import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runImport } from '../scripts/import.mjs';
import { runReview } from '../scripts/review.mjs';
import { runSync } from '../scripts/sync.mjs';
import { RouteDb } from '../scripts/lib/db.mjs';
import { validateRepo } from '../scripts/validate.mjs';
import { loop, toGpx, tempRepo, drop, readDb, fakeGeocode, silentReport } from './helpers.mjs';

const importInto = (dir) => runImport({ root: dir, geocode: fakeGeocode, report: silentReport() });
const newRoutes = (dir) => readDb(dir).routes.filter((r) => !r.id.startsWith('salud-'));

test('single GPX -> new route with real track, inbox emptied, database valid', async () => {
  const dir = tempRepo();
  drop(dir, 'jorge', 'ride.gpx', toGpx(loop({ km: 30 })));
  const rep = await importInto(dir);
  assert.equal(rep.errors, 0, rep.lines.join('\n'));
  const [r] = newRoutes(dir);
  assert.equal(r.id, '2026-10-18-rivas-vaciamadrid');
  assert.equal(r.title, 'Rivas-Vaciamadrid');
  assert.equal(r.start_location.label, 'Rivas-Vaciamadrid · Madrid');
  assert.deepEqual(r.participants, ['jorge']);
  assert.ok(Math.abs(r.distance_km - 30) < 0.3);
  assert.equal(r.duration_s, r.moving_time_s);
  assert.ok(r.preview.length >= 2 && r.preview.length <= 120);
  assert.ok(fs.existsSync(path.join(dir, r.track)));
  assert.equal(fs.readdirSync(path.join(dir, 'imports/inbox/jorge')).length, 0);
  const v = validateRepo(dir);
  assert.deepEqual(v.errors, []);
});

test('same file twice, or the same ride re-exported, is detected as a duplicate', async () => {
  const dir = tempRepo();
  const pts = loop({ km: 25 });
  drop(dir, 'jorge', 'a.gpx', toGpx(pts));
  await importInto(dir);
  drop(dir, 'jorge', 'a-again.gpx', toGpx(pts));
  // Same ride exported from Strava: different file, slightly different start and creator.
  drop(dir, 'jorge', 'b-strava.gpx', toGpx(pts.slice(3), { creator: 'StravaGPX', name: 'Morning Ride', type: 'cycling' }));
  const rep = await importInto(dir);
  assert.equal(rep.errors, 0);
  assert.equal(rep.lines.filter((l) => l.includes('duplicate')).length, 2, rep.lines.join('\n'));
  assert.equal(newRoutes(dir).length, 1);
  assert.equal(newRoutes(dir)[0].activities.length, 1);
});

test('four riders recording the same outing -> one route, four participants, originals kept', async () => {
  const dir = tempRepo();
  const riders = ['tochi', 'david', 'jorge', 'javi'];
  riders.forEach((rider, i) => {
    // Same ride, different devices: each starts recording a bit later, samples at its own rate
    // and has its own GPS noise.
    const pts = loop({ km: 40, stepS: [1, 3, 5, 4][i], jitterM: 15, seed: i + 7 }).filter((p) => p.time >= Date.parse('2026-10-18T07:00:00Z') + i * 60_000);
    drop(dir, rider, `${rider}.gpx`, toGpx(pts, { creator: ['Garmin Connect', 'Wahoo ELEMNT', 'Garmin Connect', 'HealthFit'][i] }));
  });
  const rep = await importInto(dir);
  assert.equal(rep.errors, 0, rep.lines.join('\n'));
  const routes = newRoutes(dir);
  assert.equal(routes.length, 1, rep.lines.join('\n'));
  const [r] = routes;
  assert.deepEqual([...r.participants].sort(), [...riders].sort());
  assert.equal(r.activities.length, 4);
  assert.equal(new Set(r.activities.map((a) => a.track)).size, 4, 'each rider keeps their own track');
  assert.ok(r.activities.some((a) => a.source_label === 'GPX · Wahoo'));
  assert.ok(r.activities.some((a) => a.source_label === 'GPX · Apple Watch'));
  assert.equal(r.start_time, '2026-10-18T07:00:00Z', 'ride starts with the earliest rider');
  assert.deepEqual(validateRepo(dir).errors, []);
});

test('rider who pedals from home joins the group; group stats use the shared ride', async () => {
  const dir = tempRepo();
  const group = loop({ km: 30, start: '2026-10-18T07:30:00Z' });
  // Javi rides 9 km to the meeting point first, then the same loop with the group.
  const center = [40.35, -3.52];
  const approach = Array.from({ length: 360 }, (_, i) => ({ lat: center[0] - 0.08 + (0.08 * i) / 359, lon: center[1], ele: 600, hr: 140, time: Date.parse('2026-10-18T07:00:00Z') + i * 5000 }));
  drop(dir, 'jorge', 'jorge.gpx', toGpx(group));
  drop(dir, 'javi', 'javi.gpx', toGpx([...approach, ...group.map((p) => ({ ...p, time: p.time + 1000 }))]));
  const rep = await importInto(dir);
  const routes = newRoutes(dir);
  assert.equal(routes.length, 1, rep.lines.join('\n'));
  assert.ok(Math.abs(routes[0].distance_km - 30) < 0.5, `route distance ${routes[0].distance_km}`);
  const javi = routes[0].activities.find((a) => a.rider === 'javi');
  assert.ok(javi.distance_km > 38, 'Javi keeps his own longer distance');
});

test('same day and same loop but different hours are NOT merged', async () => {
  const dir = tempRepo();
  drop(dir, 'jorge', 'morning.gpx', toGpx(loop({ km: 30, start: '2026-10-18T07:00:00Z' })));
  drop(dir, 'david', 'evening.gpx', toGpx(loop({ km: 30, start: '2026-10-18T15:00:00Z' })));
  await importInto(dir);
  assert.equal(newRoutes(dir).length, 2);
  assert.equal(readDb(dir).reviews.length, 0);
});

test('same time but different places are NOT merged', async () => {
  const dir = tempRepo();
  drop(dir, 'jorge', 'rivas.gpx', toGpx(loop({ km: 30 })));
  drop(dir, 'tochi', 'sierra.gpx', toGpx(loop({ km: 30, center: [40.75, -4.0] })));
  await importInto(dir);
  assert.equal(newRoutes(dir).length, 2);
  assert.equal(readDb(dir).reviews.length, 0);
});

test('partial overlap goes to manual review, then merge / split / dismiss work', async () => {
  const dir = tempRepo();
  const a = loop({ km: 40, kmh: 20 });
  // Tochi rides with Jorge for the first ~40 % and then splits off on his own loop.
  const together = a.slice(0, Math.floor(a.length * 0.4));
  const last = together.at(-1);
  const away = loop({ km: 30, kmh: 20, center: [last.lat + 0.1, last.lon + 0.1], start: new Date(last.time + 5000).toISOString() });
  drop(dir, 'jorge', 'jorge.gpx', toGpx(a));
  drop(dir, 'tochi', 'tochi.gpx', toGpx([...together, ...away]));
  const rep = await importInto(dir);
  let db = readDb(dir);
  assert.equal(newRoutes(dir).length, 2, rep.lines.join('\n'));
  const open = db.reviews.filter((r) => r.status === 'open');
  assert.equal(open.length, 1, rep.lines.join('\n'));
  assert.match(rep.lines.join('\n'), /needs review/);

  const [newId, otherId] = open[0].routes;
  await runReview(['merge', newId, otherId], { db: RouteDb.load({ routesFile: path.join(dir, 'data/routes.json'), ridersFile: path.join(dir, 'data/riders.json'), root: dir }), report: silentReport() })
    .then(() => {});
  db = readDb(dir);
  assert.equal(newRoutes(dir).length, 1);
  assert.equal(db.reviews[0].status, 'merged');
  assert.deepEqual([...newRoutes(dir)[0].participants].sort(), ['jorge', 'tochi']);
  assert.deepEqual(validateRepo(dir).errors, []);

  const tochiAct = newRoutes(dir)[0].activities.find((x) => x.rider === 'tochi').id;
  const load = () => RouteDb.load({ routesFile: path.join(dir, 'data/routes.json'), ridersFile: path.join(dir, 'data/riders.json'), root: dir });
  await runReview(['split', tochiAct], { db: load(), geocode: fakeGeocode, report: silentReport() });
  assert.equal(newRoutes(dir).length, 2);
  assert.ok(newRoutes(dir).every((r) => r.participants.length === 1));
  await runReview(['rename', newRoutes(dir)[0].id, 'Vuelta a la laguna'], { db: load(), report: silentReport() });
  assert.ok(newRoutes(dir).some((r) => r.title === 'Vuelta a la laguna'));
  assert.deepEqual(validateRepo(dir).errors, []);
});

test('no timestamps: never merged on date alone, only suggested', async () => {
  const dir = tempRepo();
  drop(dir, 'jorge', '2026-10-18-a.gpx', toGpx(loop({ km: 30 }), { withTime: false }));
  drop(dir, 'david', '2026-10-18-b.gpx', toGpx(loop({ km: 30, jitterM: 10 }), { withTime: false }));
  await importInto(dir);
  assert.equal(newRoutes(dir).length, 2);
  assert.equal(readDb(dir).reviews.filter((r) => r.status === 'open').length, 1);
});

test('a GPX on the same date as a legacy (stats-only) route is flagged, not merged', async () => {
  const dir = tempRepo();
  drop(dir, 'jorge', 'oct10.gpx', toGpx(loop({ km: 50, start: '2026-10-10T07:00:00Z' })));
  const rep = await importInto(dir);
  const db = readDb(dir);
  assert.equal(db.routes.length, 4);
  assert.equal(db.reviews[0].routes[1], 'salud-2026-10-10');
  assert.match(db.reviews[0].reason, /same date only/);
  // Merging keeps the reviewed legacy numbers (stats_locked) but adds the real GPS map.
  const load = RouteDb.load({ routesFile: path.join(dir, 'data/routes.json'), ridersFile: path.join(dir, 'data/riders.json'), root: dir });
  await runReview(['merge', db.reviews[0].routes[0], 'salud-2026-10-10'], { db: load, report: silentReport() });
  const legacy = readDb(dir).routes.find((r) => r.id === 'salud-2026-10-10');
  assert.equal(legacy.distance_km, 52.21);
  assert.equal(legacy.duration_s, 11700);
  assert.ok(legacy.track && legacy.preview.length > 2);
  assert.deepEqual(legacy.participants, ['jorge']);
  assert.ok(rep.lines.length);
});

test('broken files are moved to imports/failed with an explanation; good files still import', async () => {
  const dir = tempRepo();
  drop(dir, 'jorge', 'good.gpx', toGpx(loop({ km: 20 })));
  drop(dir, 'jorge', 'bad.gpx', '<html>not a gpx</html>');
  fs.writeFileSync(path.join(dir, 'imports/inbox/loose.gpx'), toGpx(loop({ km: 10 })));
  const rep = await importInto(dir);
  assert.equal(rep.errors, 2);
  assert.ok(fs.existsSync(path.join(dir, 'imports/failed/jorge/bad.gpx.error.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'imports/failed/loose.gpx')));
  assert.equal(newRoutes(dir).length, 1);
});

test('intervals.icu sync (mocked API): ingests rides, skips Strava-sourced and non-cycling, dedups', async () => {
  const dir = tempRepo();
  const pts = loop({ km: 30, stepS: 5 });
  const start = '2026-10-18T07:00:00Z';
  const acts = [
    { id: 'i101', type: 'MountainBikeRide', source: 'GARMIN_CONNECT', name: 'Rivas MTB', start_date: start, start_date_local: '2026-10-18T09:00:00', distance: 30120.5, moving_time: 6000, elapsed_time: 6300, total_elevation_gain: 412.4, average_heartrate: 141, device_name: 'Instinct 3 Solar' },
    { id: 'i102', type: 'Ride', source: 'STRAVA', start_date: start },
    { id: 'i103', type: 'Run', source: 'GARMIN_CONNECT', start_date: start },
  ];
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    assert.match(opts.headers.Authorization, /^Basic /);
    const body = url.includes('/activities?')
      ? acts
      : [{ type: 'latlng', data: pts.map((p) => p.lat), data2: pts.map((p) => p.lon) }, { type: 'time', data: pts.map((_, i) => i * 5) }, { type: 'altitude', data: pts.map((p) => p.ele) }];
    return { ok: true, status: 200, json: async () => body };
  };
  const load = () => RouteDb.load({ routesFile: path.join(dir, 'data/routes.json'), ridersFile: path.join(dir, 'data/riders.json'), root: dir });
  const accounts = [{ rider: 'jorge', api_key: 'secret-key' }];
  const rep = await runSync({ accounts, db: load(), fetchImpl, geocode: fakeGeocode, report: silentReport(), days: 7 });
  assert.equal(rep.errors, 0, rep.lines.join('\n'));
  assert.equal(calls.filter((u) => u.includes('/streams')).length, 1, 'only the Garmin ride is fetched');
  const [r] = newRoutes(dir);
  assert.equal(r.distance_km, 30.12, 'device distance wins over GPS-computed distance');
  assert.equal(r.elevation_gain_m, 412);
  assert.equal(r.moving_time_s, 6000);
  assert.equal(r.avg_hr_bpm, null, 'HR stays private by default');
  assert.equal(r.activities[0].source_label, 'intervals.icu · Garmin Connect');
  assert.ok(!JSON.stringify(readDb(dir)).includes('secret-key'));
  // A second run does not duplicate anything.
  await runSync({ accounts, db: load(), fetchImpl, geocode: fakeGeocode, report: silentReport(), days: 7 });
  assert.equal(newRoutes(dir).length, 1);
  assert.equal(newRoutes(dir)[0].activities.length, 1);
  assert.deepEqual(validateRepo(dir).errors, []);
});

test('device boilerplate names become short card titles', async () => {
  const { cleanActivityName } = await import('../scripts/lib/db.mjs');
  assert.equal(cleanActivityName('Rivas-Vaciamadrid Ciclismo de montaña'), 'Rivas-Vaciamadrid');
  assert.equal(cleanActivityName('Morning Ride'), null);
  assert.equal(cleanActivityName('Bicicleta por la mañana'), null);
  assert.equal(cleanActivityName('Vuelta al Cerro de los Ángeles'), 'Vuelta al Cerro de los Ángeles');
});
