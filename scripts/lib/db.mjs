// Route database (data/routes.json) operations: ingest a normalised activity, group it into
// an existing ride when confident, open a review when unsure, and the manual review commands.

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ROOT, SETTINGS } from './config.mjs';
import { compareActivities, trackToPoints, VERDICT } from './match.mjs';
import { buildPreview, buildProfile } from './activity.mjs';

export const ROUTE_STAT_FIELDS = ['distance_km', 'elevation_gain_m', 'moving_time_s', 'elapsed_time_s', 'avg_speed_kmh', 'avg_hr_bpm'];

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
// Pretty JSON, but arrays of primitives (coordinates, participant lists) stay on one line.
export function stringify(data) {
  return JSON.stringify(data, null, 2).replace(/\[\s+([^\[\]{}]*?)\s+\]/g, (_, inner) => `[${inner.replace(/\s*\n\s*/g, ' ')}]`) + '\n';
}
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringify(data));
}
// Tracks are written compactly: one point per line keeps diffs readable without bloating the file.
export function writeTrack(file, track) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = track.points.map((p) => '    ' + JSON.stringify(p)).join(',\n');
  fs.writeFileSync(file, `{\n  "activity": ${JSON.stringify(track.activity)},\n  "start_time": ${JSON.stringify(track.start_time)},\n  "points": [\n${body}\n  ]\n}\n`);
}

export class RouteDb {
  constructor({ routes, riders, root = ROOT }) {
    this.data = routes;
    this.riders = riders.riders;
    this.root = root;
    this.pendingTracks = new Map(); // relative path -> track object, written on save()
    this.deletedTracks = new Set();
  }

  static load({ routesFile = PATHS.routes, ridersFile = PATHS.riders, root = ROOT } = {}) {
    return new RouteDb({ routes: readJson(routesFile), riders: readJson(ridersFile), root });
  }

  save(routesFile = path.join(this.root, 'data', 'routes.json')) {
    for (const rel of this.deletedTracks) {
      const abs = path.join(this.root, rel);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    }
    for (const [rel, track] of this.pendingTracks) writeTrack(path.join(this.root, rel), track);
    this.data.routes.sort((a, b) => (b.start_time || b.date + 'T12').localeCompare(a.start_time || a.date + 'T12') || a.id.localeCompare(b.id));
    writeJson(routesFile, this.data);
  }

  get routes() { return this.data.routes; }
  get reviews() { return (this.data.reviews ||= []); }

  rider(id) { return this.riders.find((r) => r.id === id); }
  route(id) { return this.routes.find((r) => r.id === id); }
  allActivities() { return this.routes.flatMap((r) => r.activities.map((a) => ({ route: r, activity: a }))); }

  loadTrack(rel) {
    if (!rel) return null;
    if (this.pendingTracks.has(rel)) return this.pendingTracks.get(rel);
    const abs = path.join(this.root, rel);
    return fs.existsSync(abs) ? readJson(abs) : null;
  }
  pointsOf(activity) {
    const t = this.loadTrack(activity.track);
    return t ? trackToPoints(t.points, activity.start_time) : [];
  }

  uniqueId(base, taken) {
    let id = base, n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    return id;
  }

  /**
   * Add a normalised activity. Returns {status, route, activity, match, review}.
   * status: 'duplicate' | 'joined' | 'new' | 'new-needs-review'
   */
  async ingest(activity, track, { geocode = null } = {}) {
    const takenActivityIds = new Set(this.allActivities().map(({ activity: a }) => a.id));
    if (takenActivityIds.has(activity.id)) {
      const newId = this.uniqueId(activity.id, takenActivityIds);
      if (activity.track) activity.track = `data/tracks/${newId}.json`;
      activity.id = newId;
    }
    const pts = track ? trackToPoints(track, activity.start_time) : [];

    // Only compare against activities within a day either side; dates alone never merge anything.
    const near = this.allActivities().filter(({ activity: other }) => Math.abs(Date.parse(other.date) - Date.parse(activity.date)) <= 86_400_000);
    const results = near.map(({ route, activity: other }) => ({ route, other, ...compareActivities(activity, pts, other, this.pointsOf(other)) }));
    const rank = { [VERDICT.DUPLICATE]: 3, [VERDICT.GROUP]: 2, [VERDICT.REVIEW]: 1, [VERDICT.UNRELATED]: 0 };
    results.sort((x, y) => rank[y.verdict] - rank[x.verdict] || (y.metrics?.together_ratio ?? 0) - (x.metrics?.together_ratio ?? 0));
    const best = results[0];

    if (best?.verdict === VERDICT.DUPLICATE) {
      return { status: 'duplicate', route: best.route, activity: best.other, match: best };
    }
    if (track) this.pendingTracks.set(activity.track, { activity: activity.id, start_time: activity.start_time, points: track });

    if (best?.verdict === VERDICT.GROUP) {
      best.route.activities.push(activity);
      if (!best.route.participants.includes(activity.rider)) best.route.participants.push(activity.rider);
      this.recompute(best.route);
      return { status: 'joined', route: best.route, activity, match: best };
    }

    const route = await this.createRoute(activity, { geocode });
    const reviews = [];
    const seenRoutes = new Set();
    for (const r of results.filter((x) => x.verdict === VERDICT.REVIEW)) {
      if (seenRoutes.has(r.route.id)) continue;
      seenRoutes.add(r.route.id);
      const review = {
        id: `review-${route.id}--${r.route.id}`,
        status: 'open',
        routes: [route.id, r.route.id],
        activities: [activity.id, r.other.id],
        reason: r.reason,
        metrics: r.metrics ?? null,
        created_at: activity.imported_at,
      };
      this.reviews.push(review);
      reviews.push(review);
    }
    return { status: reviews.length ? 'new-needs-review' : 'new', route, activity, reviews };
  }

  async createRoute(activity, { geocode }) {
    let label = null;
    const first = this.loadTrack(activity.track)?.points?.[0];
    if (geocode && first) {
      try { label = await geocode(first[0], first[1]); } catch { label = null; }
    }
    const town = label ? label.split(' · ')[0] : null;
    const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const title = cleanActivityName(activity.name) || town || defaultTitle(activity.date);
    const id = this.uniqueId(`${activity.date}-${slug(town || title).slice(0, 40).replace(/-$/, '') || 'ruta'}`, new Set(this.routes.map((r) => r.id)));
    const route = {
      id,
      title,
      date: activity.date,
      start_time: activity.start_time,
      type: activity.type,
      distance_km: null, elevation_gain_m: null, moving_time_s: null, elapsed_time_s: null, duration_s: null, avg_speed_kmh: null, avg_hr_bpm: null,
      start_location: { label, lat: first ? first[0] : null, lon: first ? first[1] : null },
      map_center: null,
      track: null,
      preview: null,
      participants: [activity.rider],
      primary_activity: null,
      pin_primary: false,
      stats_locked: false,
      source_note: null,
      activities: [activity],
    };
    this.routes.push(route);
    this.recompute(route);
    return route;
  }

  // Route-level stats/map come from one representative ("primary") activity: the lower median
  // by distance, so a rider who pedalled from home does not inflate the shared ride.
  choosePrimary(route) {
    if (route.pin_primary && route.activities.some((a) => a.id === route.primary_activity)) return route.primary_activity;
    const candidates = route.activities.filter((a) => a.distance_km != null);
    const withTrack = candidates.filter((a) => a.track);
    const pool = (withTrack.length ? withTrack : candidates).sort((a, b) => a.distance_km - b.distance_km || a.id.localeCompare(b.id));
    return pool.length ? pool[Math.floor((pool.length - 1) / 2)].id : route.activities[0]?.id ?? null;
  }

  recompute(route) {
    route.primary_activity = this.choosePrimary(route);
    const primary = route.activities.find((a) => a.id === route.primary_activity);
    const starts = route.activities.map((a) => a.start_time).filter(Boolean).sort();
    if (!route.start_time && starts.length) route.start_time = starts[0];
    if (!route.stats_locked && primary) {
      for (const f of ROUTE_STAT_FIELDS) route[f] = primary[f] ?? null;
      route.duration_s = primary.moving_time_s ?? primary.elapsed_time_s ?? null;
      route.start_time = starts[0] ?? route.start_time ?? null;
      if (starts[0]) route.date = primary.date;
      if (primary.type && !route.type) route.type = primary.type;
    }
    // Maps always follow real GPS data when any activity has a track.
    const withTrack = primary?.track ? primary : route.activities.find((a) => a.track);
    if (withTrack) {
      const track = this.loadTrack(withTrack.track);
      route.track = withTrack.track;
      route.map_center = withTrack.map_center;
      route.preview = track ? buildPreview(track.points) : null;
      route.elevation_profile = track ? buildProfile(track.points) : null;
    } else {
      route.track = null;
      route.preview = null;
      route.elevation_profile = null;
    }
    route.participants = [...new Set([...(route.participants || []), ...route.activities.map((a) => a.rider).filter(Boolean)])];
    return route;
  }

  closeReviewsFor(routeId, status) {
    for (const r of this.reviews) if (r.status === 'open' && r.routes.includes(routeId)) r.status = status;
  }

  // Manual review commands ------------------------------------------------------------------
  merge(fromId, intoId) {
    const from = this.route(fromId), into = this.route(intoId);
    if (!from) throw new Error(`Route "${fromId}" not found`);
    if (!into) throw new Error(`Route "${intoId}" not found`);
    if (from === into) throw new Error('Cannot merge a route into itself');
    into.activities.push(...from.activities);
    into.participants = [...new Set([...into.participants, ...from.participants])];
    if (!into.source_note && from.source_note) into.source_note = from.source_note;
    // A stats-only route (no location yet) inherits the place found from the GPS track.
    const loc = into.start_location || (into.start_location = { label: null, lat: null, lon: null });
    if (!loc.label && from.start_location?.label) loc.label = from.start_location.label;
    if (loc.lat == null && from.start_location?.lat != null) { loc.lat = from.start_location.lat; loc.lon = from.start_location.lon; }
    this.data.routes = this.routes.filter((r) => r !== from);
    for (const r of this.reviews) {
      if (r.status === 'open' && r.routes.includes(fromId) && r.routes.includes(intoId)) r.status = 'merged';
      r.routes = r.routes.map((id) => (id === fromId ? intoId : id));
    }
    return this.recompute(into);
  }

  async split(activityId, { geocode = null } = {}) {
    const route = this.routes.find((r) => r.activities.some((a) => a.id === activityId));
    if (!route) throw new Error(`Activity "${activityId}" not found`);
    if (route.activities.length === 1) throw new Error(`Activity "${activityId}" is already alone in route "${route.id}"`);
    const activity = route.activities.find((a) => a.id === activityId);
    route.activities = route.activities.filter((a) => a !== activity);
    if (!route.activities.some((a) => a.rider === activity.rider)) route.participants = route.participants.filter((p) => p !== activity.rider);
    if (route.primary_activity === activityId) route.pin_primary = false;
    this.recompute(route);
    return this.createRoute(activity, { geocode });
  }

  dismiss(reviewId) {
    const review = this.reviews.find((r) => r.id === reviewId);
    if (!review) throw new Error(`Review "${reviewId}" not found`);
    review.status = 'dismissed';
    return review;
  }

  rename(routeId, title) {
    const route = this.route(routeId);
    if (!route) throw new Error(`Route "${routeId}" not found`);
    if (!title || !title.trim()) throw new Error('Title cannot be empty');
    route.title = title.trim().slice(0, 80);
    return route;
  }
}

// Device apps name activities "<Town> Ciclismo de montaña", "Morning Ride", "Bicicleta por la tarde"…
// Keep the meaningful part as a card title, drop the generic boilerplate.
const SPORT_SUFFIX = /\s*[-–·]?\s*(ciclismo de montaña|ciclismo en carretera|ciclismo de gravel|ciclismo|bicicleta de montaña|mountain bik(e|ing)( ride)?|road cycling|gravel( ride)?|cycling|mtb|ride|bike)$/i;
const GENERIC = /^(morning|lunch|afternoon|evening|night)?\s*(ride|cycling|mountain bike ride|bike ride)$|^(salida en |bicicleta |ciclismo )?(por la )?(mañana|tarde|noche|mediodía)$|^(bicicleta|ciclismo|salida en bici(cleta)?)( (matutina|vespertina|nocturna|por la (mañana|tarde|noche)))?$/i;
export function cleanActivityName(name) {
  if (!name) return null;
  const trimmed = name.replace(SPORT_SUFFIX, '').trim();
  return !trimmed || GENERIC.test(trimmed) || GENERIC.test(name.trim()) ? null : trimmed.slice(0, 60);
}

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export function defaultTitle(date) {
  const [, m, d] = date.split('-').map(Number);
  return `Salida del ${d} de ${MONTHS[m - 1]}`;
}

// Reverse geocoding through OpenStreetMap Nominatim (free, 1 req/s, identifies itself).
// Returns a municipality-level label like "Rivas-Vaciamadrid · Madrid", or null.
export async function nominatimGeocode(lat, lon, fetchImpl = globalThis.fetch) {
  if (!SETTINGS.geocode) return null;
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=es&lat=${lat}&lon=${lon}`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': SETTINGS.geocodeUserAgent }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const a = (await res.json()).address || {};
  const town = a.city || a.town || a.village || a.municipality || a.hamlet || null;
  const region = (a.province || a.county || a.state || '').replace(/^Comunidad de /, '') || null;
  await new Promise((r) => setTimeout(r, 1100));
  return town ? [town, region].filter(Boolean).join(' · ') : null;
}
