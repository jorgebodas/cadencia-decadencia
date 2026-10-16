// Decides whether two activities are the same recording, the same group ride, possibly
// related (manual review) or unrelated. A shared date is never enough on its own.

import { haversine, nearestDistance, sample } from './geo.mjs';
import { SETTINGS } from './config.mjs';

export const VERDICT = { DUPLICATE: 'duplicate', GROUP: 'group', REVIEW: 'review', UNRELATED: 'unrelated' };

// Stored track ([lat, lon, ele, dt]) -> points with absolute times (ms) when available.
export function trackToPoints(track, startTime) {
  const start = startTime ? Date.parse(startTime) : null;
  return (track || []).map(([lat, lon, , dt]) => ({ lat, lon, time: start != null && dt != null ? start + dt * 1000 : null }));
}

const isTimed = (pts) => pts.length >= 2 && pts.every((p) => p.time != null);

// Position at time t by linear interpolation; null when t falls in a recording gap.
function positionAt(pts, t, gapMs) {
  let lo = 0, hi = pts.length - 1;
  if (t < pts[0].time || t > pts[hi].time) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].time <= t) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  if (b.time - a.time > gapMs) {
    // Inside a long gap: only trust it when the rider did not move (a stop).
    if (haversine(a, b) > SETTINGS.match.togetherWithinM) return null;
  }
  const f = b.time === a.time ? 0 : (t - a.time) / (b.time - a.time);
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}

export function coLocation(aPts, bPts) {
  const m = SETTINGS.match;
  const start = Math.max(aPts[0].time, bPts[0].time);
  const end = Math.min(aPts.at(-1).time, bPts.at(-1).time);
  const overlapS = Math.max(0, (end - start) / 1000);
  let samples = 0, together = 0;
  if (overlapS > 0) {
    for (let t = start; t <= end; t += m.sampleEveryS * 1000) {
      const pa = positionAt(aPts, t, m.gapToleranceS * 1000);
      const pb = positionAt(bPts, t, m.gapToleranceS * 1000);
      if (!pa || !pb) continue;
      samples++;
      if (haversine(pa, pb) <= m.togetherWithinM) together++;
    }
  }
  return {
    overlap_s: Math.round(overlapS),
    samples,
    together_ratio: samples ? Math.round((together / samples) * 100) / 100 : 0,
    together_s: together * m.sampleEveryS,
  };
}

export function spatialOverlap(aPts, bPts) {
  const m = SETTINGS.match;
  const frac = (x, y) => {
    const s = sample(x, 200);
    return s.filter((p) => nearestDistance(p, y) <= m.spatialWithinM).length / s.length;
  };
  const ab = frac(aPts, bPts), ba = frac(bPts, aPts);
  return { a_on_b: Math.round(ab * 100) / 100, b_on_a: Math.round(ba * 100) / 100 };
}

const durationS = (act) => act.elapsed_time_s || act.moving_time_s || null;

/**
 * Compare a new activity against an existing one.
 * @param a,b activity records; aPts/bPts their track points (from trackToPoints), may be empty.
 */
export function compareActivities(a, aPts, b, bPts) {
  const m = SETTINGS.match;
  if (a.sha256 && b.sha256 && a.sha256 === b.sha256) return { verdict: VERDICT.DUPLICATE, reason: 'identical file' };
  if (a.source_activity_id && a.source === b.source && a.source_activity_id === b.source_activity_id) {
    return { verdict: VERDICT.DUPLICATE, reason: `same ${a.source} activity id` };
  }

  const aStart = a.start_time ? Date.parse(a.start_time) : null;
  const bStart = b.start_time ? Date.parse(b.start_time) : null;

  // Same rider, overlapping time window: one person cannot ride twice at once -> re-export of the same ride.
  if (a.rider && a.rider === b.rider && aStart != null && bStart != null) {
    const aEnd = aStart + (durationS(a) || 0) * 1000, bEnd = bStart + (durationS(b) || 0) * 1000;
    const overlap = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart)) / 1000;
    const shorter = Math.min(durationS(a) || Infinity, durationS(b) || Infinity);
    if (Math.abs(aStart - bStart) / 1000 <= m.duplicateMaxStartDiffS || (Number.isFinite(shorter) && overlap / shorter >= m.duplicateMinTimeOverlap)) {
      return { verdict: VERDICT.DUPLICATE, reason: 'same rider, overlapping time' };
    }
  }

  const haveTracks = aPts.length >= 2 && bPts.length >= 2;
  if (haveTracks && isTimed(aPts) && isTimed(bPts)) {
    const co = coLocation(aPts, bPts);
    if (co.overlap_s < m.minOverlapS) return { verdict: VERDICT.UNRELATED, reason: 'no meaningful time overlap', metrics: co };
    const shorter = Math.min(durationS(a) || co.overlap_s, durationS(b) || co.overlap_s);
    const enough = co.together_s >= Math.max(m.groupMinTogetherS, m.groupMinShareOfShorter * shorter);
    if (co.together_ratio >= m.groupMinRatio && enough) return { verdict: VERDICT.GROUP, reason: 'rode together (time + GPS)', metrics: co };
    if (co.together_ratio >= m.reviewMinRatio || co.together_s >= m.reviewMinTogetherS) {
      return { verdict: VERDICT.REVIEW, reason: 'partly together (time + GPS)', metrics: co };
    }
    return { verdict: VERDICT.UNRELATED, reason: 'same time, different places', metrics: co };
  }

  // Without timestamps on both sides we can only ever suggest, never merge.
  if (a.date !== b.date) return { verdict: VERDICT.UNRELATED, reason: 'different dates' };
  if (haveTracks) {
    const sp = spatialOverlap(aPts, bPts);
    if (Math.max(sp.a_on_b, sp.b_on_a) >= m.spatialReviewRatio) {
      return { verdict: VERDICT.REVIEW, reason: 'same date and similar path, but no timestamps to confirm', metrics: sp };
    }
    return { verdict: VERDICT.UNRELATED, reason: 'same date, different paths', metrics: sp };
  }
  return { verdict: VERDICT.REVIEW, reason: 'same date only (no GPS track to compare)' };
}
