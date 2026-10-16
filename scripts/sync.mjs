#!/usr/bin/env node
// Pulls recent activities from connected provider accounts and ingests them exactly like GPX
// imports. Credentials only ever come from the environment (a GitHub Actions secret):
//
//   INTERVALS_ACCOUNTS='[{"rider":"jorge","api_key":"…","athlete_id":"0"}]' node scripts/sync.mjs
//
// Without INTERVALS_ACCOUNTS it does nothing.

import { RouteDb, nominatimGeocode } from './lib/db.mjs';
import { normalizeActivity } from './lib/activity.mjs';
import { fetchRecent } from './providers/intervals.mjs';
import { Report, describeResult } from './lib/report.mjs';

export async function runSync({ accounts, db = RouteDb.load(), fetchImpl = globalThis.fetch, geocode = nominatimGeocode, days = 14, report = new Report('Provider sync') } = {}) {
  if (!accounts?.length) {
    report.add('No provider accounts configured (secret INTERVALS_ACCOUNTS is empty).');
    return report;
  }
  const known = new Set(db.allActivities().map(({ activity }) => `${activity.source}:${activity.source_activity_id}`));
  for (const acc of accounts) {
    const rider = db.rider(acc.rider);
    if (!rider) { report.error(`intervals.icu account for unknown rider "${acc.rider}"`); continue; }
    let raws;
    try {
      raws = await fetchRecent({ rider: rider.id, apiKey: acc.api_key, athleteId: acc.athlete_id || '0', days, fetchImpl });
    } catch (err) {
      // Never echo the key; the error text only contains the endpoint path and status.
      report.error(`${rider.name}: ${err.message}`);
      continue;
    }
    for (const raw of raws) {
      if (known.has(`intervals:${raw.source_activity_id}`)) continue;
      const label = `${rider.name} · intervals.icu ${raw.source_activity_id}`;
      try {
        const { activity, track } = normalizeActivity(raw, { riders: db.riders, shareHeartRate: !!rider.share_heart_rate });
        const res = await db.ingest(activity, track, { geocode });
        report.add(describeResult(res, label));
        report.changed = true;
      } catch (err) {
        report.error(`${label}: ${err.message}`);
      }
    }
  }
  if (report.changed) db.save();
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let accounts = [];
  try {
    accounts = process.env.INTERVALS_ACCOUNTS ? JSON.parse(process.env.INTERVALS_ACCOUNTS) : [];
  } catch {
    console.error('❌ INTERVALS_ACCOUNTS is not valid JSON');
    process.exit(1);
  }
  const report = await runSync({ accounts, days: Number(process.env.SYNC_DAYS || 14) });
  report.flush();
  if (report.errors && !process.env.GITHUB_OUTPUT) process.exitCode = 1;
}
