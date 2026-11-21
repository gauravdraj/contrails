// Offline asset preparation for the watch page's shoreline; not a page or CI build step. Zero npm packages.
// Source: US Census Bureau TIGER/Line 2023 FACES (US Government work, public domain; no attribution required).
// FACES is TIGER's topological face layer: every face carries LWFLAG (L = land, P = perennial water) and adjacent faces share
// identical vertices, so dissolving the land faces is exact edge cancellation, with no polygon boolean library.
//
//   node scripts/build-watch-geo.mjs counties cb_2023_us_county_500k.shp
//     Prints the county GEOIDs whose extent meets the bbox. Every one is needed: a missing land county would leave a
//     land/no-data seam that is then stroked as fake shoreline.
//   node scripts/build-watch-geo.mjs build DIR [output.json]
//     DIR holds the unzipped tl_2023_<GEOID>_faces.{shp,dbf} for those counties.
//     https://www2.census.gov/geo/tiger/TIGER2023/FACES/tl_2023_<GEOID>_faces.zip
//
// Simplification runs in the page's own fisheye projection (`_watch/project.js`), so detail is kept where the chart
// magnifies it (near the field, ~10 m per device pixel) and dropped at the rim (~300 m per pixel).
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const Project = require('../_watch/project.js');
const FIELD = { lat: 37.62, lng: -122.375 };
// Just beyond the 100 km disc. Long bbox edges are fill closures, never coastline (display.js skips them).
const bbox = [-123.6, 36.68, -121.15, 38.56];
// Output of `counties` for this bbox (cb_2023_us_county_500k). The build refuses a partial or different set.
const COUNTIES = ['06001', '06013', '06041', '06047', '06053', '06055', '06067', '06069', '06075',
  '06077', '06081', '06085', '06087', '06095', '06097', '06099', '06113'];
// Reference view: the largest chart radius (iPad portrait, 527 CSS px) at device-pixel ratio 2.
const REF = { radius: 1, k: 2.1, dMax: 100, cx: 0, cy: 0, field: FIELD };
const DEVICE_PX = 1 / (527 * 2);
const TOLERANCE = .6 * DEVICE_PX;
const MIN_AREA = 40 * DEVICE_PX * DEVICE_PX;
// Water that cannot read at the chart scale is drawn as land: sloughs, creeks, salt ponds and delta channels
// narrower than ~4 device px (2 * area / perimeter) or smaller than ~20 x 20 device px, when at least half of their
// edge borders land. The Bay, the ocean, the large reservoirs and everything magnified near the field keep their
// true shoreline, and narrow Bay strips cut off by bridges stay water.
const MIN_WATER_WIDTH = 4 * DEVICE_PX;
const MIN_WATER_AREA = 400 * DEVICE_PX * DEVICE_PX;

function shapes(buf) {
  const out = [];
  for (let o = 100; o < buf.length;) {
    const words = buf.readInt32BE(o + 4);
    const c = o + 8;
    const type = buf.readInt32LE(c);
    if (type === 5 || type === 15) {
      const parts = buf.readInt32LE(c + 36);
      const points = buf.readInt32LE(c + 40);
      const starts = [];
      for (let i = 0; i < parts; i++) starts.push(buf.readInt32LE(c + 44 + i * 4));
      const base = c + 44 + parts * 4;
      const rings = starts.map((s, i) => {
        const e = i + 1 < parts ? starts[i + 1] : points;
        const ring = [];
        for (let j = s; j < e; j++) ring.push([buf.readDoubleLE(base + j * 16), buf.readDoubleLE(base + j * 16 + 8)]);
        return ring;
      });
      out.push({ box: [0, 1, 2, 3].map(i => buf.readDoubleLE(c + 4 + i * 8)), rings });
    }
    else
      out.push({ box: null, rings: [] });
    o = c + words * 2;
  }
  return out;
}
function dbf(buf) {
  const n = buf.readUInt32LE(4);
  const headerLength = buf.readUInt16LE(8);
  const recordLength = buf.readUInt16LE(10);
  const fields = [];
  for (let o = 32, at = 1; buf[o] !== 0x0d; o += 32) {
    const length = buf[o + 16];
    fields.push({ name: buf.toString('latin1', o, o + 11).replace(/\0.*$/, ''), at, length });
    at += length;
  }
  const rows = [];
  for (let i = 0; i < n; i++) {
    const r = headerLength + i * recordLength;
    rows.push(Object.fromEntries(fields.map(f => [f.name, buf.toString('latin1', r + f.at, r + f.at + f.length).trim()])));
  }
  return rows;
}
const meets = b => b && b[0] <= bbox[2] && b[2] >= bbox[0] && b[1] <= bbox[3] && b[3] >= bbox[1];

async function counties(shp) {
  const s = shapes(await readFile(shp));
  const rows = dbf(await readFile(shp.replace(/\.shp$/, '.dbf')));
  const hit = rows.filter((r, i) => meets(s[i].box)).map(r => r.GEOID + ' ' + r.NAME).sort();
  console.log(hit.join('\n'));
}

// Undirected edge cancellation: an edge shared by two land faces is interior. What survives is the land boundary.
function dissolve(faces) {
  const key = p => p[0].toFixed(7) + ',' + p[1].toFixed(7);
  const edges = new Map();
  for (const ring of faces)
    for (let i = 0; i + 1 < ring.length; i++) {
      const a = key(ring[i]);
      const b = key(ring[i + 1]);
      if (a === b) continue;
      const k = a < b ? a + '|' + b : b + '|' + a;
      const e = edges.get(k);
      if (e) e.count++;
      else edges.set(k, { count: 1, a, b, pa: ring[i], pb: ring[i + 1] });
    }
  // Directed adjacency of surviving edges; face rings share one orientation, so boundaries chain head to tail.
  const next = new Map();
  for (const e of edges.values())
    if (e.count === 1) {
      if (!next.has(e.a)) next.set(e.a, []);
      next.get(e.a).push(e);
    }
  const rings = [];
  for (const [start, list] of next)
    while (list.length) {
      let e = list.pop();
      const ring = [e.pa];
      let guard = 0;
      while (e.b !== start && guard++ < 5e6) {
        ring.push(e.pb);
        const out = next.get(e.b);
        // A boundary that does not close means the faces were not topological; never invent a closing edge.
        if (!out || !out.length)
          throw new Error('Open land boundary at ' + e.b + ' (incomplete or inconsistent FACES input)');
        e = out.pop();
      }
      if (e.b !== start)
        throw new Error('Land boundary walk did not close from ' + start);
      ring.push(ring[0]);
      if (ring.length > 3) rings.push(ring);
    }
  return rings;
}
function clip(points, axis, bound, greater) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[(i + points.length - 1) % points.length];
    const b = points[i];
    const ina = greater ? a[axis] >= bound : a[axis] <= bound;
    const inb = greater ? b[axis] >= bound : b[axis] <= bound;
    if (ina !== inb) {
      const f = (bound - a[axis]) / (b[axis] - a[axis]);
      out.push([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]);
    }
    if (inb) out.push(b);
  }
  return out;
}
const fish = p => {
  const q = Project.project(p[1], p[0], REF);
  return [q.x, q.y];
};
// Douglas-Peucker on fisheye coordinates; returns the kept geographic points.
function simplify(points, eps) {
  const q = points.map(fish);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [ax, ay] = q[s];
    const dx = q[e][0] - ax;
    const dy = q[e][1] - ay;
    const sq = dx * dx + dy * dy;
    let max = 0;
    let index = -1;
    for (let i = s + 1; i < e; i++) {
      const t = sq ? Math.max(0, Math.min(1, ((q[i][0] - ax) * dx + (q[i][1] - ay) * dy) / sq)) : 0;
      const d = Math.hypot(q[i][0] - ax - t * dx, q[i][1] - ay - t * dy);
      if (d > max) {
        max = d;
        index = i;
      }
    }
    if (max > eps) {
      keep[index] = 1;
      stack.push([s, index], [index, e]);
    }
  }
  return points.filter((p, i) => keep[i]);
}
function perimeter(ring) {
  const q = ring.map(fish);
  let p = 0;
  for (let i = 0; i + 1 < q.length; i++) p += Math.hypot(q[i + 1][0] - q[i][0], q[i + 1][1] - q[i][1]);
  return p;
}
function area(ring) {
  const q = ring.map(fish);
  let a = 0;
  for (let i = 0; i + 1 < q.length; i++) a += q[i][0] * q[i + 1][1] - q[i + 1][0] * q[i][1];
  return Math.abs(a / 2);
}

async function build(dir, dest) {
  const files = (await readdir(dir)).filter(f => /_faces\.shp$/.test(f)).sort();
  const found = files.map(f => (f.match(/^tl_2023_(\d{5})_faces\.shp$/) || [])[1]).filter(Boolean);
  if (found.join() !== COUNTIES.join() || found.length !== files.length)
    throw new Error('Expected exactly tl_2023_{' + COUNTIES.join(',') + '}_faces.shp in ' + dir + '; found ' + files.join(' '));
  const faces = [];
  for (const f of files) {
    const s = shapes(await readFile(join(dir, f)));
    const rows = dbf(await readFile(join(dir, f.replace(/\.shp$/, '.dbf'))));
    rows.forEach((r, i) => {
      if (meets(s[i].box) && s[i].rings.length)
        faces.push({ rings: s[i].rings, water: r.LWFLAG !== 'L' });
    });
    console.log(f + ': ' + rows.length + ' faces');
  }
  // How much of each water face's edge it shares with other water: a slough segment touches water only at its
  // short ends, while a narrow strip of Bay split off by a bridge touches open water along both long sides.
  const ek = (p, q) => {
    const a = p[0].toFixed(7) + ',' + p[1].toFixed(7);
    const b = q[0].toFixed(7) + ',' + q[1].toFixed(7);
    return a < b ? a + '|' + b : b + '|' + a;
  };
  const waterEdges = new Map();
  for (const face of faces)
    if (face.water)
      for (const ring of face.rings)
        for (let i = 0; i + 1 < ring.length; i++) {
          const k = ek(ring[i], ring[i + 1]);
          waterEdges.set(k, (waterEdges.get(k) || 0) + 1);
        }
  const land = [];
  let absorbed = 0;
  for (const face of faces) {
    let isLand = !face.water;
    if (!isLand) {
      // Shapefile ring order carries no exterior-first guarantee: the exterior is the ring with the largest area.
      const outer = face.rings.reduce((best, r) => area(r) > area(best) ? r : best);
      const a = area(outer);
      if (a < MIN_WATER_AREA || 2 * a / perimeter(outer) < MIN_WATER_WIDTH) {
        let shared = 0;
        let total = 0;
        for (let i = 0; i + 1 < outer.length; i++) {
          const length = Math.hypot(outer[i + 1][0] - outer[i][0], outer[i + 1][1] - outer[i][1]);
          total += length;
          if (waterEdges.get(ek(outer[i], outer[i + 1])) > 1)
            shared += length;
        }
        isLand = shared < total * .5;
      }
      absorbed += isLand;
    }
    if (isLand)
      land.push(...face.rings);
  }
  console.log(faces.length + ' faces in bbox; ' + absorbed + ' unreadable water faces drawn as land');
  const rings = [];
  let raw = 0;
  for (let ring of dissolve(land)) {
    raw += ring.length;
    ring.pop();
    for (const [axis, b, g] of [[0, bbox[0], true], [0, bbox[2], false], [1, bbox[1], true], [1, bbox[3], false]])
      ring = clip(ring, axis, b, g);
    if (ring.length < 3) continue;
    ring.push(ring[0]);
    if (area(ring) < MIN_AREA) continue;
    ring = simplify(ring, TOLERANCE).map(p => p.map(v => +v.toFixed(5)));
    if (ring.length > 3) rings.push(ring);
  }
  // Even-odd fill: one polygon entry with every boundary ring draws land, lakes and islands correctly.
  const out = JSON.stringify({
    source: 'US Census Bureau TIGER/Line 2023 FACES (land faces dissolved); counties ' + COUNTIES.join(' '),
    license: 'public domain (US Government work)',
    bbox,
    polygons: [rings]
  }) + '\n';
  const points = rings.reduce((t, r) => t + r.length, 0);
  await writeFile(dest, out);
  console.log(dest + ': ' + Buffer.byteLength(out) + ' bytes, ' + gzipSync(out).length + ' gzipped; ' + rings.length +
    ' rings, ' + points + ' points (from ' + raw + ')');
}

const [mode, a, b] = process.argv.slice(2);
if (mode === 'counties' && a)
  await counties(a);
else if (mode === 'build' && a)
  await build(a, b || '_watch/geo/SFO.json');
else
  throw new Error('Usage: build-watch-geo.mjs counties CB_COUNTY.shp | build FACES_DIR [output.json]');
