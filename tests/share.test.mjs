import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildShare, sharePage, imageHash, shareText } from '../scripts/share.mjs';

const route = {
  id: '2026-11-22-rivas-vaciamadrid', title: 'Rivas – Cerro de los Ángeles <&>', date: '2026-11-22', type: 'MTB',
  distance_km: 49.39, elevation_gain_m: 344, moving_time_s: 11211, duration_s: 11211,
  preview: [[40.35, -3.52], [40.31, -3.68]], elevation_profile: [600, 620, 650, 630, 610], map_center: [40.33, -3.6],
};

test('share page carries Open Graph tags with an absolute image URL and sends people to the route', () => {
  const html = sharePage(route, { origin: 'https://decadencia.es', hash: 'abc123' });
  assert.match(html, /<meta property="og:title" content="Rivas – Cerro de los Ángeles &lt;&amp;&gt; · 22 de noviembre de 2026">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/decadencia\.es\/rutas\/2026-11-22-rivas-vaciamadrid\/card\.jpg\?v=abc123">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/decadencia\.es\/rutas\/2026-11-22-rivas-vaciamadrid\/">/);
  assert.match(html, /location\.replace\("\.\.\/\.\.\/#ruta\/2026-11-22-rivas-vaciamadrid"\)/);
  assert.ok(!html.includes('<&>'), 'title is escaped');
  assert.equal(shareText(route).description, '49,39 km · +344 m · 3h 06m — MTB con Cadencia / Decadencia.');
});

test('image hash changes with what the card shows, not with unrelated fields', () => {
  const h = imageHash(route);
  assert.equal(imageHash({ ...route, source_note: 'x', activities: [] }), h);
  assert.notEqual(imageHash({ ...route, title: 'Otro' }), h);
  assert.notEqual(imageHash({ ...route, distance_km: 50 }), h);
});

test('buildShare writes one page per route, keeps them stable and removes pages of deleted routes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'share-'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'CNAME'), 'decadencia.es\n');
  fs.writeFileSync(path.join(root, 'data/routes.json'), JSON.stringify({ routes: [route] }));
  fs.mkdirSync(path.join(root, 'rutas/old-route'), { recursive: true });

  const res = await buildShare({ root, images: false, log: () => {} });
  assert.equal(res.pages, 1);
  assert.equal(res.removed, 1);
  assert.deepEqual(res.pending, [route.id]);
  assert.ok(!fs.existsSync(path.join(root, 'rutas/old-route')));
  const page = path.join(root, 'rutas', route.id, 'index.html');
  const first = fs.readFileSync(page, 'utf8');
  assert.match(first, /og:image/);

  // A card rendered for the current data is picked up and the page then points at it.
  fs.writeFileSync(path.join(root, 'rutas', route.id, 'card.jpg'), 'jpg');
  fs.writeFileSync(page, first.replace(/content="pending"/, `content="${imageHash(route)}"`));
  const again = await buildShare({ root, images: false, log: () => {} });
  assert.deepEqual(again.pending, []);
  assert.match(fs.readFileSync(page, 'utf8'), new RegExp(`card\\.jpg\\?v=${imageHash(route)}`));
  assert.equal(fs.readFileSync(path.join(root, 'rutas/ultima.jpg'), 'utf8'), 'jpg');
});
