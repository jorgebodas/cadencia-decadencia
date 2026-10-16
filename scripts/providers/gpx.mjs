// GPX file adapter: file on disk -> raw activity (see scripts/lib/activity.mjs).

import crypto from 'node:crypto';
import path from 'node:path';
import { parseGpx } from '../lib/gpx.mjs';

const CREATOR_LABELS = [
  [/garmin/i, 'Garmin'], [/wahoo/i, 'Wahoo'], [/strava/i, 'Strava'], [/komoot/i, 'Komoot'],
  [/apple|healthfit|workoutdoors|rungap/i, 'Apple Watch'], [/coros/i, 'Coros'], [/suunto/i, 'Suunto'], [/polar/i, 'Polar'],
];

export function gpxToRawActivity(text, { rider, fileName }) {
  const gpx = parseGpx(text);
  const label = CREATOR_LABELS.find(([re]) => re.test(gpx.creator || ''))?.[1] ?? null;
  const dateInName = path.basename(fileName).match(/(20\d\d)-(\d\d)-(\d\d)/);
  const metaDate = gpx.metadataTime ? new Date(gpx.metadataTime).toISOString().slice(0, 10) : null;
  return {
    rider,
    source: 'gpx',
    source_label: label ? `GPX · ${label}` : 'GPX',
    // Garmin Connect names exports "activity_<id>.gpx"; keeping the id catches re-exports.
    source_activity_id: label === 'Garmin' ? path.basename(fileName).match(/activity_(\d{6,})/)?.[1] ?? null : null,
    url: null,
    device: gpx.creator ? gpx.creator.slice(0, 60) : null,
    name: gpx.name ? gpx.name.slice(0, 80) : null,
    type: gpx.type,
    points: gpx.points,
    summary: null,
    fallbackDate: dateInName ? dateInName.slice(1).join('-') : metaDate,
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
  };
}
