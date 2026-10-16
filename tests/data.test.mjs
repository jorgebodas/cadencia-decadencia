import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateRepo } from '../scripts/validate.mjs';
import { validate } from '../scripts/lib/schema.mjs';

const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));

test('repository route database passes schema and integrity validation', () => {
  const { errors } = validateRepo();
  assert.deepEqual(errors, []);
});

test('the three original routes are preserved with their exact values', () => {
  const legacy = read('./fixtures/legacy-routes.json'); // copied verbatim from the old inline GARMIN_ROUTES
  const db = read('../data/routes.json');
  assert.equal(legacy.length, 3);
  for (const old of legacy) {
    const r = db.routes.find((x) => x.id === old.id);
    assert.ok(r, `route ${old.id} exists`);
    assert.equal(r.title, old.title);
    assert.equal(r.date, old.date);
    assert.equal(r.distance_km, old.distance);
    assert.equal(r.elevation_gain_m, old.elevation);
    assert.equal(r.duration_s, old.duration_s);
    assert.equal(r.type, old.type);
    assert.equal(r.avg_speed_kmh, old.avg_speed);
    assert.equal(r.avg_hr_bpm, old.avg_hr);
    assert.deepEqual(r.map_center, old.center);
    assert.equal(r.start_location.label, old.locationLabel);
    assert.equal(r.source_note, old.sourceNote);
    assert.equal(r.stats_locked, true, 'reviewed numbers are protected from recomputation');
    const original = r.activities.find((a) => a.id === r.primary_activity);
    assert.equal(original.device, old.device);
    assert.equal(original.source_label, old.origin);
  }
});

test('schema validator catches bad data', () => {
  const schema = read('../data/schema/routes.schema.json');
  const db = read('../data/routes.json');
  db.routes[0].distance_km = 'far';
  db.routes[0].participants = ['Not An Id'];
  delete db.routes[1].title;
  db.routes[2].extra = 1;
  const errors = validate(schema, db);
  assert.ok(errors.some((e) => e.includes('distance_km')));
  assert.ok(errors.some((e) => e.includes('participants[0]')));
  assert.ok(errors.some((e) => e.includes('missing "title"')));
  assert.ok(errors.some((e) => e.includes('unexpected property "extra"')));
});
