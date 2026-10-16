// intervals.icu adapter (EXPERIMENTAL — written against the public API documentation and
// covered by fixture tests, but not yet exercised against a live account).
//
// Why intervals.icu: it is free, has official automatic sync from Garmin Connect, Wahoo,
// Coros, Suunto and Polar, and each athlete can create a personal API key. It therefore
// gives "Garmin -> our site" automation without a Garmin business developer licence and
// without the Strava API (whose terms forbid showing one athlete's data to other people).
// Activities that intervals.icu itself received from Strava are skipped for that reason.
//
// Auth: HTTP Basic, username "API_KEY", password = the athlete's key. Athlete id "0" means
// "the athlete who owns this key".

const BASE = 'https://intervals.icu/api/v1';
const CYCLING = new Set(['Ride', 'MountainBikeRide', 'GravelRide', 'EBikeRide', 'EMountainBikeRide']);
const TYPE_LABEL = { MountainBikeRide: 'mountain_biking', EMountainBikeRide: 'mountain_biking', GravelRide: 'gravel', Ride: 'cycling', EBikeRide: 'cycling' };

function client(apiKey, fetchImpl) {
  const auth = 'Basic ' + Buffer.from(`API_KEY:${apiKey}`).toString('base64');
  return async (pathAndQuery) => {
    const res = await fetchImpl(`${BASE}${pathAndQuery}`, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`intervals.icu ${pathAndQuery.split('?')[0]} -> HTTP ${res.status}`);
    return res.json();
  };
}

// Streams come back as [{type:'latlng', data:[lat…], data2:[lon…]}, {type:'time', data:[s…]}, …].
export function streamsToPoints(streams, startIso) {
  const byType = Object.fromEntries((streams || []).map((s) => [s.type, s]));
  const ll = byType.latlng;
  if (!ll?.data?.length) return [];
  const start = Date.parse(startIso);
  const lat = ll.data, lon = ll.data2 || ll.data.map(() => null);
  const time = byType.time?.data, alt = byType.altitude?.data || byType.fixed_altitude?.data, hr = byType.heartrate?.data;
  const pts = [];
  for (let i = 0; i < lat.length; i++) {
    if (lat[i] == null || lon[i] == null) continue;
    pts.push({
      lat: lat[i],
      lon: lon[i],
      ele: alt?.[i] ?? null,
      time: time && Number.isFinite(start) ? start + time[i] * 1000 : null,
      hr: hr?.[i] || null,
      seg: 0,
    });
  }
  return pts;
}

export function activityToRaw(act, points, rider) {
  return {
    rider,
    source: 'intervals',
    source_label: act.source && act.source !== 'UPLOAD' ? `intervals.icu · ${act.source.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}` : 'intervals.icu',
    source_activity_id: String(act.id),
    url: null, // intervals.icu activity pages are private to the athlete
    device: act.device_name || null,
    name: act.name || null,
    type: TYPE_LABEL[act.type] ?? act.type,
    points,
    summary: {
      start_time: act.start_date ? new Date(act.start_date).toISOString() : null,
      distance_km: act.distance != null ? Math.round(act.distance / 10) / 100 : null,
      elevation_gain_m: act.total_elevation_gain != null ? Math.round(act.total_elevation_gain) : null,
      moving_time_s: act.moving_time ?? null,
      elapsed_time_s: act.elapsed_time ?? null,
      avg_hr_bpm: act.average_heartrate ?? null,
    },
    fallbackDate: act.start_date_local ? act.start_date_local.slice(0, 10) : null,
    sha256: null,
  };
}

/** Fetch recent cycling activities for one rider account as raw activities. */
export async function fetchRecent({ rider, apiKey, athleteId = '0', days = 14, fetchImpl = globalThis.fetch, now = new Date() }) {
  const get = client(apiKey, fetchImpl);
  const oldest = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const newest = now.toISOString().slice(0, 10);
  const list = await get(`/athlete/${encodeURIComponent(athleteId)}/activities?oldest=${oldest}&newest=${newest}`);
  const out = [];
  for (const act of list) {
    if (!CYCLING.has(act.type)) continue;
    if (act.source === 'STRAVA') continue; // Strava API terms: not ours to republish
    const streams = await get(`/activity/${encodeURIComponent(act.id)}/streams?types=latlng,time,altitude,heartrate`);
    out.push(activityToRaw(act, streamsToPoints(streams, act.start_date), rider));
  }
  return out;
}
