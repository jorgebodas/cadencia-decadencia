#!/usr/bin/env node
// Processes every GPX file in imports/inbox/<rider>/ into data/routes.json + data/tracks/.
// Successfully processed (or duplicate) files are removed from the inbox; files that fail are
// moved to imports/failed/<rider>/ next to a .error.txt explaining why.
//
//   node scripts/import.mjs            # process the inbox
//   GEOCODE=off node scripts/import.mjs  # skip reverse geocoding (offline)

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ROOT } from './lib/config.mjs';
import { RouteDb, nominatimGeocode } from './lib/db.mjs';
import { normalizeActivity } from './lib/activity.mjs';
import { gpxToRawActivity } from './providers/gpx.mjs';
import { Report, describeResult } from './lib/report.mjs';

function listGpx(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listGpx(p);
    return /\.gpx$/i.test(e.name) ? [p] : [];
  }).sort();
}

export async function runImport({ root = ROOT, geocode = nominatimGeocode, report = new Report('GPX import') } = {}) {
  const inbox = path.join(root, path.relative(ROOT, PATHS.inbox));
  const failedDir = path.join(root, path.relative(ROOT, PATHS.failed));
  const files = listGpx(inbox);
  if (!files.length) return report;

  const db = RouteDb.load({ routesFile: path.join(root, 'data/routes.json'), ridersFile: path.join(root, 'data/riders.json'), root });
  for (const file of files) {
    const rel = path.relative(inbox, file);
    const label = `\`${rel}\``;
    const rider = rel.split(path.sep).length > 1 ? rel.split(path.sep)[0].toLowerCase() : null;
    try {
      if (!rider) throw new Error('GPX must be inside a rider folder, e.g. imports/inbox/jorge/ride.gpx');
      const riderInfo = db.rider(rider);
      if (!riderInfo) throw new Error(`Unknown rider folder "${rider}". Add the rider to data/riders.json first.`);
      const raw = gpxToRawActivity(fs.readFileSync(file, 'utf8'), { rider, fileName: file });
      const { activity, track } = normalizeActivity(raw, { riders: db.riders, shareHeartRate: !!riderInfo.share_heart_rate });
      const res = await db.ingest(activity, track, { geocode });
      report.add(describeResult(res, label));
      fs.unlinkSync(file);
      report.changed = true;
    } catch (err) {
      report.error(`${label}: ${err.message}`);
      const dest = path.join(failedDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(file, dest);
      fs.writeFileSync(dest + '.error.txt', `${err.message}\n\nFix the file (or data/riders.json) and move it back to imports/inbox/.\n`);
      report.changed = true;
    }
  }
  db.save(path.join(root, 'data/routes.json'));
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runImport();
  report.flush();
  // Errors are reported through GITHUB_OUTPUT so the workflow can still commit good imports first.
  if (report.errors && !process.env.GITHUB_OUTPUT) process.exitCode = 1;
}
