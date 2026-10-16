// Minimal, dependency-free GPX 1.0/1.1 reader. It tolerates namespace prefixes and the
// extension blocks written by Garmin, Wahoo, Strava, Komoot and Apple Health exporters.

const decodeEntities = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .trim();

const tag = (name) => `(?:[\\w-]+:)?${name}`;
const firstText = (xml, name) => {
  const m = xml.match(new RegExp(`<${tag(name)}\\b[^>]*>([\\s\\S]*?)</${tag(name)}>`, 'i'));
  return m ? decodeEntities(m[1]) : null;
};
const attr = (attrs, name) => {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? m[1] : null;
};

export class GpxError extends Error {}

export function parseGpx(text) {
  if (typeof text !== 'string' || !/<(?:[\w-]+:)?gpx\b/i.test(text)) throw new GpxError('Not a GPX file (missing <gpx> root element)');
  const xml = text.replace(/<!--[\s\S]*?-->/g, '');
  const rootAttrs = xml.match(/<(?:[\w-]+:)?gpx\b([^>]*)>/i)?.[1] || '';
  const creator = attr(rootAttrs, 'creator');
  const metadata = xml.match(new RegExp(`<${tag('metadata')}\\b[^>]*>([\\s\\S]*?)</${tag('metadata')}>`, 'i'))?.[1] || '';
  const metadataTime = firstText(metadata, 'time');

  const tracks = [...xml.matchAll(new RegExp(`<${tag('trk')}\\b[^>]*>([\\s\\S]*?)</${tag('trk')}>`, 'gi'))].map((m) => m[1]);
  if (!tracks.length) {
    if (new RegExp(`<${tag('rte')}\\b`, 'i').test(xml)) throw new GpxError('GPX contains a planned route (<rte>), not a recorded activity (<trk>)');
    throw new GpxError('GPX has no <trk> track');
  }
  // Track name/type live before the first segment.
  const head = tracks[0].split(new RegExp(`<${tag('trkseg')}\\b`, 'i'))[0];
  const name = firstText(head, 'name');
  const type = firstText(head, 'type');

  const points = [];
  const ptRe = new RegExp(`<${tag('trkpt')}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag('trkpt')}>)`, 'gi');
  let segment = 0;
  for (const trk of tracks) {
    for (const seg of trk.split(new RegExp(`<${tag('trkseg')}\\b[^>]*>`, 'i')).slice(1)) {
      for (const m of seg.matchAll(ptRe)) {
        const lat = Number(attr(m[1], 'lat'));
        const lon = Number(attr(m[1], 'lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
        if (lat === 0 && lon === 0) continue; // common "no fix" placeholder
        const body = m[2] || '';
        const ele = Number(firstText(body, 'ele'));
        const timeText = firstText(body, 'time');
        const time = timeText ? Date.parse(timeText) : NaN;
        const hrText = firstText(body, 'hr') ?? firstText(body, 'heartrate');
        const hr = hrText == null ? NaN : Number(hrText);
        points.push({
          lat,
          lon,
          ele: firstText(body, 'ele') != null && Number.isFinite(ele) ? ele : null,
          time: Number.isFinite(time) ? time : null,
          hr: Number.isFinite(hr) && hr > 0 ? hr : null,
          seg: segment,
        });
      }
      segment++;
    }
  }
  if (points.length < 2) throw new GpxError('GPX track has fewer than two valid GPS points');
  return { name, type, creator, metadataTime: metadataTime && Number.isFinite(Date.parse(metadataTime)) ? Date.parse(metadataTime) : null, points };
}
