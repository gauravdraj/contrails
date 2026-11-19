// Natural Earth, public domain. Offline asset preparation; not a page or CI build step.
// node scripts/build-watch-geo.mjs /path/to/ne_10m_land.geojson [output.json]
import { readFile, writeFile } from 'node:fs/promises';
const source = process.argv[2];
if (!source)
  throw new Error('Supply the Natural Earth land GeoJSON path');
// Just beyond the disc. Long bbox edges are fill boundaries, never coastline.
const bbox = [-123.875, 36.42, -120.875, 38.82];
function clip(points, axis, bound, greater) {
  let out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[(i + points.length - 1) % points.length];
    const b = points[i];
    const ina = greater ? a[axis] >= bound : a[axis] <= bound;
    const inb = greater ? b[axis] >= bound : b[axis] <= bound;
    if (ina !== inb) {
      const f = (bound - a[axis]) / (b[axis] - a[axis]);
      out.push([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]);
    }
    if (inb)
      out.push(b);
  }
  return out;
}
function simplify(p, eps) {
  if (p.length < 3)
    return p;
  const a = p[0];
  const b = p[p.length - 1];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const sq = dx * dx + dy * dy;
  let max = 0;
  let index = 0;
  for (let i = 1; i < p.length - 1; i++) {
    let t = sq ? Math.max(0, Math.min(1, ((p[i][0] - a[0]) * dx + (p[i][1] - a[1]) * dy) / sq)) : 0;
    let d = Math.hypot(p[i][0] - a[0] - t * dx, p[i][1] - a[1] - t * dy);
    if (d > max) {
      max = d;
      index = i;
    }
  }
  return max > eps
    ? simplify(p.slice(0, index + 1), eps).slice(0, -1).concat(simplify(p.slice(index), eps))
    : [a, b];
}
const input = JSON.parse(await readFile(source, 'utf8'));
const polygons = [];
for (const f of input.features) {
  const groups = f.geometry.type === 'MultiPolygon'
    ? f.geometry.coordinates
    : f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : [];
  for (const poly of groups) {
    const rings = [];
    for (let ring of poly) {
      for (const [axis, b, g] of [
        [0, bbox[0], true], [0, bbox[2], false], [1, bbox[1], true], [1, bbox[3], false]
      ])
        ring = clip(ring, axis, b, g);
      if (ring.length > 3) {
        ring = simplify(ring, .0004).map(p => p.map(v => +v.toFixed(5)));
        if (ring.length > 3)
          rings.push(ring);
      }
    }
    if (rings.length)
      polygons.push(rings);
  }
}
const out = JSON.stringify({
  source: 'Natural Earth 1:10m land · ne_10m_land.geojson',
  license: 'public domain',
  bbox,
  polygons
}) + '\n';
if (Buffer.byteLength(out) > 40000)
  throw new Error('Geography exceeds 40 kB');
const dest = process.argv[3] || '_watch/geo/SFO.json';
await writeFile(dest, out);
console.log(dest + ': ' + Buffer.byteLength(out) + ' bytes; ' + polygons.length +
  ' clipped land polygons; public domain');
