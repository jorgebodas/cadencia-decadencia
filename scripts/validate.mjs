#!/usr/bin/env node
// Validates the route database before anything is published:
// JSON schemas, referential integrity, track files, deploy config (CNAME).

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/config.mjs';
import { validate } from './lib/schema.mjs';

const read = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

export function validateRepo(root = ROOT) {
  const errors = [], warnings = [];
  const schemas = {
    routes: read(root, 'data/schema/routes.schema.json'),
    riders: read(root, 'data/schema/riders.schema.json'),
    track: read(root, 'data/schema/track.schema.json'),
  };
  let db, riders;
  try { db = read(root, 'data/routes.json'); } catch (e) { return { errors: [`data/routes.json: ${e.message}`], warnings }; }
  try { riders = read(root, 'data/riders.json'); } catch (e) { return { errors: [`data/riders.json: ${e.message}`], warnings }; }
  errors.push(...validate(schemas.routes, db).map((e) => `routes.json ${e}`));
  errors.push(...validate(schemas.riders, riders).map((e) => `riders.json ${e}`));
  if (errors.length) return { errors, warnings };

  const riderIds = new Set(riders.riders.map((r) => r.id));
  if (riderIds.size !== riders.riders.length) errors.push('riders.json: duplicate rider ids');
  const routeIds = new Set(), activityIds = new Set(), referencedTracks = new Set();
  for (const r of db.routes) {
    if (routeIds.has(r.id)) errors.push(`route ${r.id}: duplicate id`);
    routeIds.add(r.id);
    if (Number.isNaN(Date.parse(r.date))) errors.push(`route ${r.id}: invalid date ${r.date}`);
    for (const p of r.participants) if (!riderIds.has(p)) errors.push(`route ${r.id}: unknown participant "${p}"`);
    if (r.primary_activity && !r.activities.some((a) => a.id === r.primary_activity)) errors.push(`route ${r.id}: primary_activity "${r.primary_activity}" is not one of its activities`);
    if (r.track && !r.activities.some((a) => a.track === r.track)) errors.push(`route ${r.id}: track ${r.track} does not belong to any of its activities`);
    if (r.preview && r.preview.length < 2) errors.push(`route ${r.id}: preview needs at least two points`);
    for (const a of r.activities) {
      if (activityIds.has(a.id)) errors.push(`activity ${a.id}: duplicate id`);
      activityIds.add(a.id);
      if (a.rider && !riderIds.has(a.rider)) errors.push(`activity ${a.id}: unknown rider "${a.rider}"`);
      if (a.rider && !r.participants.includes(a.rider)) errors.push(`route ${r.id}: rider "${a.rider}" recorded activity ${a.id} but is not a participant`);
      if (a.track) {
        referencedTracks.add(a.track);
        const abs = path.join(root, a.track);
        if (!fs.existsSync(abs)) { errors.push(`activity ${a.id}: missing track file ${a.track}`); continue; }
        let t;
        try { t = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { errors.push(`${a.track}: ${e.message}`); continue; }
        errors.push(...validate(schemas.track, t).map((e) => `${a.track} ${e}`));
        if (t.activity !== a.id) errors.push(`${a.track}: belongs to "${t.activity}", expected "${a.id}"`);
        if (t.points?.some(([lat, lon]) => Math.abs(lat) > 90 || Math.abs(lon) > 180)) errors.push(`${a.track}: coordinates out of range`);
      }
    }
  }
  for (const v of db.reviews) {
    if (v.status === 'open') for (const id of v.routes) if (!routeIds.has(id)) errors.push(`review ${v.id}: route "${id}" does not exist`);
  }
  const tracksDir = path.join(root, 'data/tracks');
  if (fs.existsSync(tracksDir)) {
    for (const f of fs.readdirSync(tracksDir).filter((f) => f.endsWith('.json'))) {
      if (!referencedTracks.has(`data/tracks/${f}`)) warnings.push(`data/tracks/${f} is not referenced by any activity`);
    }
  }
  const cname = fs.existsSync(path.join(root, 'CNAME')) ? fs.readFileSync(path.join(root, 'CNAME'), 'utf8').trim() : null;
  if (cname !== 'decadencia.es') errors.push(`CNAME must contain "decadencia.es" (found ${JSON.stringify(cname)})`);
  const open = db.reviews.filter((v) => v.status === 'open');
  if (open.length) warnings.push(`${open.length} possible group-ride match(es) waiting for review: ${open.map((v) => v.id).join(', ')}`);
  return { errors, warnings, stats: { routes: db.routes.length, activities: activityIds.size } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { errors, warnings, stats } = validateRepo();
  for (const w of warnings) console.warn(`⚠️  ${w}`);
  for (const e of errors) console.error(`❌ ${e}`);
  if (errors.length) {
    console.error(`\nValidation failed with ${errors.length} error(s).`);
    process.exit(1);
  }
  console.log(`✅ Route database valid: ${stats.routes} routes, ${stats.activities} activities.`);
}
