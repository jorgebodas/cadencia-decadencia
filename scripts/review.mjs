#!/usr/bin/env node
// Manual review of group-ride matching. Also exposed as the "Review routes" GitHub workflow.
//
//   node scripts/review.mjs list
//   node scripts/review.mjs merge  <route-id> <into-route-id>   # same ride recorded twice -> one card
//   node scripts/review.mjs split  <activity-id>                # wrongly grouped -> its own card
//   node scripts/review.mjs dismiss <review-id>                 # keep both routes separate
//   node scripts/review.mjs rename <route-id> "<new title>"

import { RouteDb, nominatimGeocode } from './lib/db.mjs';
import { Report } from './lib/report.mjs';

export async function runReview(argv, { db = RouteDb.load(), geocode = nominatimGeocode, report = new Report('Route review') } = {}) {
  const [command, a, b] = argv;
  switch (command) {
    case 'list': {
      const open = db.reviews.filter((r) => r.status === 'open');
      if (!open.length) report.add('No open reviews.');
      for (const r of open) report.add(`\`${r.id}\`: \`${r.routes[0]}\` ↔ \`${r.routes[1]}\` — ${r.reason}${r.metrics ? ' ' + JSON.stringify(r.metrics) : ''}`);
      return report;
    }
    case 'merge': {
      const route = db.merge(a, b);
      report.add(`Merged \`${a}\` into \`${route.id}\` "${route.title}" — riders: ${route.participants.join(', ') || '—'}`);
      break;
    }
    case 'split': {
      const route = await db.split(a, { geocode });
      report.add(`Moved activity \`${a}\` to its own route \`${route.id}\` "${route.title}"`);
      break;
    }
    case 'dismiss': {
      db.dismiss(a);
      report.add(`Dismissed review \`${a}\`; routes stay separate.`);
      break;
    }
    case 'rename': {
      const route = db.rename(a, b);
      report.add(`Renamed \`${route.id}\` to "${route.title}"`);
      break;
    }
    default:
      throw new Error(`Unknown command "${command}". Use list | merge | split | dismiss | rename.`);
  }
  report.changed = true;
  db.save();
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    (await runReview(process.argv.slice(2))).flush();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
