// A real SFO evening rush, recorded from the public Worker on 2026-11-20 (Friday, ~18:00 PST) at the page's own
// 5 s traffic cadence. Raw feed payloads only: no fabricated rows, nothing enriched. D-ATIS appears every 60 s, as the page
// polls it; the schedule appears on the first tick and again only if it changed. Per-aircraft receiver telemetry (rssi, nic, mlat, ...) was dropped.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const raw = JSON.parse(gunzipSync(readFileSync(new URL('./watch-busy-sfo.json.gz', import.meta.url))).toString('utf8'));
export const BUSY_RECORDED = raw.recorded;
export const BUSY_TICKS = raw.ticks;
// The fixture keeps its own absolute clock, so schedule ETAs and feed times stay consistent.
export const BUSY_AT = BUSY_TICKS[BUSY_TICKS.length - 1].nowMs;
