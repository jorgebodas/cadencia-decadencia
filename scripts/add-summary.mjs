#!/usr/bin/env node
// Adds (or updates) a ride from a verified activity summary when no GPS file is available yet,
// e.g. stats read from Garmin Connect. Idempotent: re-running with the same file changes nothing.
// The GPX/FIT can be imported later through imports/inbox/<rider>/; it is attached to this record
// (matched by Garmin activity id or same rider + start time) instead of creating a second route.
//
//   node scripts/add-summary.mjs path/to/summary.json
//
// summary.json: { "route": { "id", "title", "date", "start_time", "type", "distance_km",
//   "elevation_gain_m", "duration_s", "avg_speed_kmh", "location_label", "source_note" },
//   "activity": { "id", "rider", "source", "source_label", "source_activity_id", "device", "name" } }

import fs from 'node:fs';
import { RouteDb } from './lib/db.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/add-summary.mjs <summary.json>');
  process.exit(1);
}
const db = RouteDb.load();
const res = db.upsertSummary(JSON.parse(fs.readFileSync(file, 'utf8')));
db.save();
console.log(`${res.status}: route ${res.route.id} "${res.route.title}" — activity ${res.activity.id}`);
