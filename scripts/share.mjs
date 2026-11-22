#!/usr/bin/env node
// Share pages: one small page per route at rutas/<id>/ with Open Graph tags and a preview image
// (rutas/<id>/card.jpg), so a link pasted into WhatsApp, Telegram, iMessage… shows a tile of the
// route. Link-preview crawlers do not run JavaScript and ignore #fragments, which is why every
// route needs its own URL. People who open the page are sent on to the route in the site viewer.
//
//   node scripts/share.mjs              # write the pages and render missing/outdated images
//   SHARE_IMAGES=off node scripts/share.mjs   # pages only (no browser needed)
//
// Rendering needs a Chromium-based browser through playwright-core (installed by the Share pages
// workflow, which uses the runner's Chrome) and network access to the map tiles and Google Fonts.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './lib/config.mjs';

export const SHARE_DIR = 'rutas';
const IMAGE = { width: 1200, height: 630, file: 'card.jpg', latest: 'ultima.jpg' };
// Bump when the image design changes so every card is rendered again.
const DESIGN_VERSION = 1;
const CARTO_KEY = 'cb1_4mgd_1_fce905e396f871e304b436f6'; // public browser key, already in index.html
const SITE_NAME = 'Cadencia / Decadencia';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtKm = (n) => (n == null ? '—' : new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(n));
const fmtElev = (n) => (n == null ? '—' : new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n)));
const fmtDur = (n) => { if (!n) return null; const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60); return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`; };
const fmtDate = (s) => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${s}T12:00:00Z`));
const durationOf = (r) => r.duration_s ?? r.moving_time_s ?? r.elapsed_time_s ?? null;

export function siteOrigin(root = ROOT) {
  try { const host = fs.readFileSync(path.join(root, 'CNAME'), 'utf8').trim(); if (host) return `https://${host}`; } catch {}
  return 'https://decadencia.es';
}

export function shareText(r) {
  const parts = [r.distance_km != null && `${fmtKm(r.distance_km)} km`, r.elevation_gain_m != null && `+${fmtElev(r.elevation_gain_m)} m`, fmtDur(durationOf(r))].filter(Boolean);
  return { title: `${r.title} · ${fmtDate(r.date)}`, description: `${parts.join(' · ')} — ${r.type || 'MTB'} con ${SITE_NAME}.` };
}

// Everything the image depends on; a changed hash means the card must be rendered again.
export function imageHash(r) {
  const input = JSON.stringify([DESIGN_VERSION, r.title, r.date, r.distance_km, r.elevation_gain_m, durationOf(r), r.preview, r.elevation_profile, r.map_center]);
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function sharePage(r, { origin, hash }) {
  const { title, description } = shareText(r);
  const url = `${origin}/${SHARE_DIR}/${r.id}/`;
  const image = `${origin}/${SHARE_DIR}/${r.id}/${IMAGE.file}?v=${hash}`;
  const target = `../../#ruta/${encodeURIComponent(r.id)}`;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — ${SITE_NAME}</title>
<meta name="description" content="${esc(description)}">
<meta name="share-image-hash" content="${hash}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:locale" content="es_ES">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:secure_url" content="${esc(image)}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="${IMAGE.width}">
<meta property="og:image:height" content="${IMAGE.height}">
<meta property="og:image:alt" content="Mapa de la ruta ${esc(r.title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="theme-color" content="#151714">
<meta http-equiv="refresh" content="0; url=${esc(target)}">
<script>location.replace(${JSON.stringify(target)})</script>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#151714;color:#f1f1ed;font:16px/1.4 'Helvetica Neue',Arial,sans-serif}a{color:#cefb11}</style>
</head>
<body><p><a href="${esc(target)}">Ver ${esc(r.title)} en ${SITE_NAME}</a></p></body>
</html>
`;
}

// ---------- image template (rendered by a headless browser) ----------

function project(lat, lon, z) { const n = 256 * 2 ** z, rad = (lat * Math.PI) / 180; return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n]; }

function mapLayer(r, box) {
  const pts = r.preview?.length > 1 ? r.preview : null;
  const center = pts ? null : r.map_center;
  // Largest whole zoom where the track fits, then a scale (1–2×, the @2x tiles stay sharp) to fill the box.
  let z = 13, k = 1, cx, cy;
  if (pts) {
    let spanX, spanY;
    for (z = 16; z >= 6; z--) {
      const xy = pts.map((p) => project(p[0], p[1], z)), xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
      spanX = Math.max(...xs) - Math.min(...xs); spanY = Math.max(...ys) - Math.min(...ys);
      cx = (Math.min(...xs) + Math.max(...xs)) / 2; cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      if (spanX <= box.w - 2 * box.pad && spanY <= box.h - 2 * box.pad) break;
    }
    k = Math.min(1.9, Math.max(1, Math.min((box.w - 2 * box.pad) / Math.max(spanX, 1), (box.h - 2 * box.pad) / Math.max(spanY, 1))));
  } else if (center) {
    [cx, cy] = project(center[0], center[1], z);
  } else return '';
  // Scaled world pixel of the canvas' top-left corner, so the track's centre lands in the middle of the box.
  const T = 256 * k, ox = cx * k - (box.x + box.w / 2), oy = cy * k - (box.y + box.h / 2), n = 2 ** z;
  const at = (lat, lon) => { const [x, y] = project(lat, lon, z); return [x * k - ox, y * k - oy]; };
  let tiles = '';
  for (let tx = Math.floor(ox / T); tx <= Math.floor((ox + IMAGE.width) / T); tx++) {
    for (let ty = Math.floor(oy / T); ty <= Math.floor((oy + IMAGE.height) / T); ty++) {
      if (ty < 0 || ty >= n) continue;
      const src = `https://basemaps.cartocdn.com/rastertiles/dark_all/${z}/${(tx + n) % n}/${ty}@2x.png?key=${CARTO_KEY}`;
      tiles += `<img class="tile" src="${src}" style="left:${(tx * T - ox).toFixed(2)}px;top:${(ty * T - oy).toFixed(2)}px;width:${(T + 0.5).toFixed(2)}px;height:${(T + 0.5).toFixed(2)}px" alt="">`;
    }
  }
  let track = '';
  if (pts) {
    const d = pts.map((p, i) => { const [x, y] = at(p[0], p[1]); return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`; }).join('');
    const [sx, sy] = at(pts[0][0], pts[0][1]);
    track = `<svg class="track" width="${IMAGE.width}" height="${IMAGE.height}"><path class="casing" d="${d}"/><path class="line" d="${d}"/><circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="9"/></svg>`;
  }
  return tiles + track;
}

function profileSvg(r) {
  const p = r.elevation_profile;
  if (!Array.isArray(p) || p.length < 5) return '';
  const W = 360, H = 120, top = 26, min = Math.min(...p), max = Math.max(...p), span = Math.max(max - min, 1);
  const xy = p.map((v, i) => [(i / (p.length - 1)) * W, top + (1 - (v - min) / span) * (H - top - 4)]);
  const line = xy.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join('');
  const peak = xy[p.indexOf(max)];
  return `<svg class="profile" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><defs><linearGradient id="pf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#141a0f" stop-opacity=".24"/><stop offset="1" stop-color="#141a0f" stop-opacity="0"/></linearGradient></defs><path d="${line}L${W} ${H}L0 ${H}Z" fill="url(#pf)"/><path d="${line}" fill="none" stroke="#141a0f" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${peak[0].toFixed(1)}" cy="${peak[1].toFixed(1)}" r="5.5" fill="#141a0f" stroke="#cefb11" stroke-width="3"/><text x="${Math.min(Math.max(peak[0], 34), W - 34).toFixed(1)}" y="${(peak[1] - 14).toFixed(1)}" text-anchor="middle">${fmtElev(max)} m</text></svg>`;
}

export function cardHtml(r) {
  const panel = { w: 430, gap: 28 };
  const box = { x: 0, y: 0, w: IMAGE.width - panel.w - panel.gap, h: IMAGE.height, pad: 70 };
  const dur = fmtDur(durationOf(r));
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=block">
<style>
*{box-sizing:border-box;margin:0}
html,body{width:${IMAGE.width}px;height:${IMAGE.height}px;overflow:hidden}
body{position:relative;background:#1d211c;font-family:Inter,'Helvetica Neue',Arial,sans-serif;color:#141a0f}
.tile{position:absolute;filter:saturate(.72) contrast(1.07)}
.track{position:absolute;inset:0;overflow:visible}
.track path{fill:none;stroke-linecap:round;stroke-linejoin:round}
.track .casing{stroke:#0a100d;stroke-opacity:.7;stroke-width:12}
.track .line{stroke:#cefb11;stroke-width:6}
.track circle{fill:#141a0f;stroke:#cefb11;stroke-width:5}
.credit{position:absolute;left:22px;bottom:16px;font-size:13px;color:#fff;opacity:.75;text-shadow:0 1px 4px #000a}
.panel{position:absolute;top:${panel.gap}px;right:${panel.gap}px;bottom:${panel.gap}px;width:${panel.w}px;border-radius:34px;background:#cefb11;padding:36px 36px 32px;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(0,0,0,.35)}
.brand{font-size:17px;font-weight:700;letter-spacing:.06em}
.title{margin-top:34px;font-size:38px;line-height:1.08;font-weight:600;letter-spacing:-.035em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.date{margin-top:10px;font-size:21px;color:#4d5c1a;letter-spacing:-.01em}
.dist{margin-top:auto;font-size:104px;line-height:.9;font-weight:400;letter-spacing:-.065em;white-space:nowrap}
.dist small{font-size:.42em;letter-spacing:-.03em}
.profile{display:block;margin-top:20px;overflow:visible}
.profile text{font:600 17px Inter,sans-serif;fill:#141a0f}
.foot{display:flex;justify-content:space-between;align-items:center;margin-top:22px;padding-top:18px;border-top:2px solid #51631840;font-size:22px}
.foot span{color:#4d5c1a}.foot strong{font-weight:600}
</style></head><body>
${mapLayer(r, box)}
<div class="credit">© OpenStreetMap · © CARTO</div>
<div class="panel">
<div class="brand">CADENCIA / DECADENCIA</div>
<div class="title">${esc(r.title)}</div>
<div class="date">${esc(fmtDate(r.date))}</div>
<div class="dist">${fmtKm(r.distance_km)}<small> km</small></div>
${profileSvg(r)}
<div class="foot"><span>${r.elevation_gain_m != null ? `<strong>+${fmtElev(r.elevation_gain_m)} m</strong> de subida` : ''}</span><span>${dur ? `<strong>${dur}</strong>` : ''}</span></div>
</div>
</body></html>`;
}

async function launchBrowser() {
  let pw;
  try { pw = await import('playwright-core'); } catch { try { pw = await import('playwright'); } catch { return null; } }
  const chromium = pw.chromium || pw.default?.chromium;
  for (const opts of [{ channel: 'chrome' }, {}, { executablePath: '/opt/pw-browsers/chromium' }]) {
    try { return await chromium.launch(opts); } catch {}
  }
  return null;
}

export async function renderCard(browser, r, file, { route } = {}) {
  const page = await browser.newPage({ viewport: { width: IMAGE.width, height: IMAGE.height }, deviceScaleFactor: 1 });
  try {
    if (route) await page.route('**/*', route);
    await page.setContent(cardHtml(r), { waitUntil: 'networkidle', timeout: 60000 });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((ok) => { img.onload = img.onerror = ok; }))));
    });
    const missing = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).length);
    if (missing) throw new Error(`${missing} map tile(s) did not load`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 86 });
  } finally { await page.close(); }
}

export async function buildShare({ root = ROOT, images = process.env.SHARE_IMAGES !== 'off', route, log = console.log } = {}) {
  const db = JSON.parse(fs.readFileSync(path.join(root, 'data/routes.json'), 'utf8'));
  const origin = siteOrigin(root);
  const base = path.join(root, SHARE_DIR);
  const ids = new Set(db.routes.map((r) => r.id));
  const result = { pages: 0, rendered: 0, removed: 0, pending: [] };
  let browser = null, browserTried = false;

  for (const r of db.routes) {
    const dir = path.join(base, r.id), hash = imageHash(r), img = path.join(dir, IMAGE.file), pageFile = path.join(dir, 'index.html');
    fs.mkdirSync(dir, { recursive: true });
    const old = fs.existsSync(pageFile) ? fs.readFileSync(pageFile, 'utf8').match(/name="share-image-hash" content="([^"]+)"/)?.[1] : null;
    let current = fs.existsSync(img) && old === hash;
    if (!current && images) {
      if (!browserTried) { browserTried = true; browser = await launchBrowser(); if (!browser) log('No browser available: share images not rendered.'); }
      if (browser) {
        try { await renderCard(browser, r, img, { route }); current = true; result.rendered++; log(`Rendered ${SHARE_DIR}/${r.id}/${IMAGE.file}`); }
        catch (err) { log(`Could not render ${r.id}: ${err.message}`); }
      }
    }
    if (!current) result.pending.push(r.id);
    // Keep the old hash (and so a stale image) until the new card exists, so the next run retries.
    const html = sharePage(r, { origin, hash: current ? hash : (old || 'pending') });
    if (!fs.existsSync(pageFile) || fs.readFileSync(pageFile, 'utf8') !== html) fs.writeFileSync(pageFile, html);
    result.pages++;
  }
  if (browser) await browser.close();

  // Pages of routes that no longer exist (merged, renamed id…) are removed.
  if (fs.existsSync(base)) {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (e.isDirectory() && !ids.has(e.name)) { fs.rmSync(path.join(base, e.name), { recursive: true }); result.removed++; }
    }
  }
  // The home page previews with the most recent route's card.
  const latest = [...db.routes].sort((a, b) => `${b.date}${b.start_time || ''}`.localeCompare(`${a.date}${a.start_time || ''}`))[0];
  const latestImg = latest && path.join(base, latest.id, IMAGE.file);
  if (latestImg && fs.existsSync(latestImg)) {
    const dest = path.join(base, IMAGE.latest);
    if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(fs.readFileSync(latestImg))) fs.copyFileSync(latestImg, dest);
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = await buildShare();
  console.log(`Share pages: ${res.pages} page(s), ${res.rendered} image(s) rendered, ${res.removed} removed${res.pending.length ? `, without a current image: ${res.pending.join(', ')}` : ''}.`);
  if (res.pending.length && process.env.SHARE_IMAGES !== 'off') process.exitCode = 1;
}
