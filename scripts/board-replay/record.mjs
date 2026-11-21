// Offline: node scripts/board-replay/record.mjs --from-raw raw.json [--start-tick 0] [--ticks N] [--out file.br]
// Live (explicit only): node scripts/board-replay/record.mjs --live SFO 37.62 -122.375 [--ticks 48]
// Wire requests follow .astra/capture/capture.mjs. Replay never invokes live mode.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

// Exhaustive reads of isUsableTrafficRow + buildAircraftSnapshot, including fallback headings,
// ancillary snapshot fields and stale/invalid rows. Row order and numeric precision stay intact.
const FIELDS = new Set(('hex lat lon alt_baro t category seen track true_heading mag_heading flight '
  + 'squawk emergency dir r gs baro_rate mach ias oat wd ws nav_altitude_mcp nav_altitude_fms seen_pos roll').split(' '));
export const compress = value => brotliCompressSync(Buffer.from(JSON.stringify(value)), {
  params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
});
export function trimCapture(raw, limit = raw.traffic.length, start = 0) {
  const traffic = raw.traffic.slice(start, start + limit);
  if (!traffic.length) throw new Error('No traffic ticks');
  for (const item of traffic) {
    if (item.status !== 200 || !Array.isArray(item.body?.ac) || !Number.isFinite(item.receivedAt))
      throw new Error('Cannot silently discard a failed traffic tick');
  }
  const ticks = traffic.map(({ receivedAt, body }) => ({ at: receivedAt, traffic: {
    ac: body.ac.map(row => row && typeof row === 'object'
      ? Object.fromEntries(Object.entries(row).filter(([key]) => FIELDS.has(key))) : row),
    now: body.now,
  } }));
  for (const kind of ['schedule', 'datis']) {
    const items = raw[kind] || [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // Attach refreshes to the traffic tick AFTER which they were received, not the next
      // traffic response. The initial responses always ride on tick zero. Ignore the raw
      // recorder's final schedule refresh, which was received after the replay finished.
      if (i > 0 && item.receivedAt > traffic.at(-1).receivedAt && kind === 'schedule') continue;
      if (i > 0 && item.receivedAt >= raw.traffic[start + limit]?.receivedAt) continue;
      let index = i === 0 ? 0 : ticks.findLastIndex(t => t.at <= item.receivedAt);
      if (index < 0) index = 0;
      const body = item.status === 200 ? item.body : null;
      // Schedule rows are intentionally whole: selector, ETA, labels and scheduledRows
      // all consume them. D-ATIS consumers read these three text aliases only.
      ticks[index][kind] = kind === 'datis' && body
        ? Object.fromEntries(['datis', 'text', 'raw'].filter(k => Object.hasOwn(body, k)).map(k => [k, body[k]]))
        : body;
    }
  }
  return { name: 'live-' + raw.iata, iata: raw.iata, lat: raw.lat, lng: raw.lng,
    routes: (raw.routes || []).flatMap(r => r.status === 200 && Array.isArray(r.body) ? r.body : [])
      .filter(r => r.origin || r.destination), ticks };
}

async function capture(iata, lat, lng, count) {
  const base = 'https://contrails-api.therealgraj.workers.dev';
  const raw = { iata, lat, lng, schedule: [], datis: [], traffic: [], routes: [] };
  async function request(path, init) {
    try {
      const r = await fetch(base + path, { ...init, signal: AbortSignal.timeout(25000) });
      return { status: r.status, receivedAt: Date.now(), body: r.ok ? await r.json() : null };
    } catch (error) { return { status: 0, receivedAt: Date.now(), error: String(error) }; }
  }
  const side = async kind => raw[kind].push(await request('/' + kind + '/' + iata));
  await Promise.all([side('schedule'), side('datis')]);
  const start = Date.now();
  const path = `/adsb/lat/${lat.toFixed(4)}/lon/${lng.toFixed(4)}/dist/${Math.ceil(120 / 1.852)}`;
  for (let i = 0; i < count; i++) {
    await delay(Math.max(0, start + i * 5000 - Date.now()));
    const res = await request(path);
    raw.traffic.push(res);
    if (i === 0 && res.body) {
      const planes = res.body.ac.filter(a => typeof a.flight === 'string' && a.flight.trim() && a.lat != null)
        .map(a => ({ a, d: Math.hypot(a.lat - lat, (a.lon - lng) * Math.cos(lat * Math.PI / 180)) }))
        .sort((a, b) => a.d - b.d).slice(0, 80).map(({ a }) => ({ callsign: a.flight.trim(), hex: a.hex,
          lat: a.lat, lng: a.lon, track: a.track ?? null, altFt: typeof a.alt_baro === 'number' ? a.alt_baro : null,
          vRate: a.baro_rate ?? null, ground: a.alt_baro === 'ground' }));
      for (let b = 0; b < planes.length; b += 20) raw.routes.push(await request('/routeset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planes: planes.slice(b, b + 20) }),
      }));
    }
    if (i === Math.floor(count / 2)) await side('datis');
  }
  return raw;
}

async function main(args) {
  const options = {};
  let live;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--live') { live = args.slice(i + 1, i + 4); i += 3; }
    else if (['--from-raw', '--out', '--ticks', '--start-tick'].includes(args[i])) options[args[i]] = args[++i];
    else throw new Error('Unknown argument: ' + args[i]);
  }
  if (!!live === !!options['--from-raw']) throw new Error('Choose --from-raw FILE or --live IATA LAT LNG');
  const count = options['--ticks'] == null ? undefined : Number(options['--ticks']);
  const start = Number(options['--start-tick'] || 0);
  if (count !== undefined && (!Number.isInteger(count) || count < 1)) throw new Error('Invalid tick count');
  if (!Number.isInteger(start) || start < 0 || (live && start !== 0)) throw new Error('Invalid start tick (offline only)');
  if (live && (!/^[A-Z]{3}$/.test(live[0]) || !Number.isFinite(Number(live[1])) || !Number.isFinite(Number(live[2]))))
    throw new Error('Invalid airport/coordinates');
  const raw = live ? await capture(live[0], Number(live[1]), Number(live[2]), count ?? 48)
    : JSON.parse(await readFile(options['--from-raw'], 'utf8'));
  const corpus = trimCapture(raw, count, start);
  const output = options['--out'] || fileURLToPath(new URL(`corpus/${corpus.name}.json.br`, import.meta.url));
  const bytes = compress(corpus), gzip = gzipSync(JSON.stringify(corpus), { level: 9 });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes);
  console.log(`${corpus.name}: ${corpus.ticks.length} ticks, ${corpus.routes.length} routes; brotli ${bytes.length} B, gzip ${gzip.length} B -> ${output}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
