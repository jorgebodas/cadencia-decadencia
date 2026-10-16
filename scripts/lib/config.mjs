import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PATHS = {
  routes: path.join(ROOT, 'data', 'routes.json'),
  riders: path.join(ROOT, 'data', 'riders.json'),
  tracksDir: path.join(ROOT, 'data', 'tracks'),
  inbox: path.join(ROOT, 'imports', 'inbox'),
  failed: path.join(ROOT, 'imports', 'failed'),
  schemaDir: path.join(ROOT, 'data', 'schema'),
};

// Tunables for statistics and matching. Kept in one place so they are easy to review.
export const SETTINGS = {
  timezone: 'Europe/Madrid',
  // Metres removed from both ends of every published track (stats still use the full track).
  privacyTrimM: Number(process.env.PRIVACY_TRIM_M ?? 200),
  maxTrackPoints: 1500,
  maxPreviewPoints: 120,
  // Elevation gain: ignore oscillations smaller than this (barometric/GPS noise).
  elevationHysteresisM: 3,
  // Moving time: a window of at least `movingWindowS` counts as moving above this speed.
  movingMinSpeedKmh: 2,
  movingWindowS: 10,
  // Discard GPS jumps faster than this between two timestamped points.
  maxPlausibleSpeedKmh: 110,
  match: {
    sampleEveryS: 30,
    togetherWithinM: 250,
    gapToleranceS: 300,
    minOverlapS: 10 * 60,
    groupMinRatio: 0.6,
    groupMinTogetherS: 20 * 60,
    groupMinShareOfShorter: 0.4,
    reviewMinRatio: 0.25,
    reviewMinTogetherS: 10 * 60,
    spatialWithinM: 150,
    spatialReviewRatio: 0.5,
    duplicateMaxStartDiffS: 5 * 60,
    duplicateMinTimeOverlap: 0.5,
  },
  geocode: process.env.GEOCODE !== 'off',
  geocodeUserAgent: 'cadencia-decadencia-route-importer/1.0 (+https://decadencia.es)',
};
