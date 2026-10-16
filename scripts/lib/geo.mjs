// Geometry helpers shared by the import pipeline. Points are {lat, lon, ...}.

const R = 6371008.8; // mean Earth radius in metres
const rad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bbox(points) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

export function bboxCenter(points) {
  const b = bbox(points);
  return [round((b.minLat + b.maxLat) / 2, 5), round((b.minLon + b.maxLon) / 2, 5)];
}

export function round(n, digits) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// Perpendicular distance (metres) from p to segment a-b on a local equirectangular projection.
function segmentDistance(p, a, b) {
  const k = Math.cos(rad((a.lat + b.lat) / 2));
  const ax = a.lon * k, ay = a.lat, bx = b.lon * k, by = b.lat, px = p.lon * k, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy) * (Math.PI / 180) * R;
}

// Douglas-Peucker, iterative so long tracks cannot blow the stack.
export function simplify(points, toleranceM) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistance(points[i], points[first], points[last]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx !== -1 && maxD > toleranceM) {
      keep[idx] = 1;
      stack.push([first, idx], [idx, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export function simplifyTo(points, maxPoints, startToleranceM = 2) {
  let tol = startToleranceM;
  let out = simplify(points, tol);
  while (out.length > maxPoints) {
    tol *= 1.6;
    out = simplify(points, tol);
  }
  return out;
}

// Drop the first and last `meters` of a track so start/end points (often a rider's home) are not published.
export function trimEnds(points, meters) {
  if (!meters || points.length < 3) return points.slice();
  const cut = (arr) => {
    let acc = 0;
    for (let i = 1; i < arr.length; i++) {
      acc += haversine(arr[i - 1], arr[i]);
      if (acc >= meters) return i;
    }
    return arr.length;
  };
  const start = cut(points);
  const end = points.length - cut([...points].reverse());
  const trimmed = points.slice(start, end);
  // A track shorter than twice the privacy margin would vanish; keep nothing rather than leak the ends.
  return trimmed.length >= 2 ? trimmed : [];
}

// Minimum distance (metres) from p to any point of `track`, with a cheap latitude prefilter.
export function nearestDistance(p, track) {
  let best = Infinity;
  for (const q of track) {
    if (Math.abs(q.lat - p.lat) * 111_000 > best) continue;
    const d = haversine(p, q);
    if (d < best) best = d;
  }
  return best;
}

export function sample(points, n) {
  if (points.length <= n) return points;
  const step = points.length / n;
  return Array.from({ length: n }, (_, i) => points[Math.floor(i * step)]);
}
