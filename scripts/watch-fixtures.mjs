// Fixed, raw observations. No routeset enrichment and no fabricated board rows.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../contrails-core.js');
const runways = require('../runways.json');
export const EPOCH = Date.UTC(2026, 10, 19, 22, 0, 0);
export const DATIS = {
  datis: 'SAN FRANCISCO INFORMATION ALPHA. LANDING RUNWAYS 28L AND 28R. DEPARTING RUNWAYS 01L AND 01R.'
};
const end = (r, airport = 'SFO') => core.matchRunwayDesignator(runways[airport], airport, r);
function along(r, km, airport = 'SFO', side = 0) {
  const e = end(r, airport);
  const h = core.bearingDegrees(e.thresholdLat, e.thresholdLon, e.farEndLat, e.farEndLon);
  let p = core.projectLatLng(e.thresholdLat, e.thresholdLon, h, km * 1000);
  if (side)
    p = core.projectLatLng(...p, h + 90, side * 1000);
  return { lat: p[0], lon: p[1], track: h };
}
function plane(i, pos, alt, speed = 150, rate = -650) {
  return {
    hex: (0xa00001 + i).toString(16),
    flight: 'UAL' + (123 + i),
    t: i === 4 ? 'B77W' : 'A320',
    category: 'A3',
    ...pos,
    alt_baro: alt,
    gs: speed,
    baro_rate: rate,
    seen: 0,
    seen_pos: 0
  };
}
export const SCHEDULE = {
  iata: 'SFO',
  name: 'San Francisco',
  arrivals: [0, 1, 2, 3, 4, 5, 6, 11, 12].map((i) => ({
    callsign: 'UAL' + (123 + i),
    flight: 'UA' + (123 + i),
    from_iata: ['JFK', 'LAX', 'SEA', 'ORD'][i % 4],
    from_name: 'Origin',
    live: true,
    est_arr: EPOCH / 1000 + 120 + i * 80
    ,
  })),
  departures: [8, 9, 10].map(i => ({
    callsign: 'UAL' + (123 + i),
    flight: 'UA' + (123 + i),
    to_iata: 'JFK',
    to_name: 'New York',
    live: true,
    est_dep: EPOCH / 1000 + 60
  }))
};
export function tick(index, count = 33) {
  // Tick 9 is byte-for-byte the tick 8 traffic payload, including feed time.
  const t = index === 9 ? 8 : index;
  const s = t * 5;
  const ac = [];
  for (let i = 0; i < 6; i++) {
    const distance = [9, 9.8, 19, 23, 34, 45][i] - s * .075;
    const ground = distance <= 0;
    ac.push(plane(
      i,
      along(i % 2 ? '28R' : '28L', -Math.max(-1.7, distance)),
      ground ? 'ground' : Math.max(35, distance * 170),
      ground ? 70 : 150
    ));
  }
  const down = along('28R', -12 - s * .025, 'SFO', -5);
  ac.push(plane(6, { ...down, track: (down.track + 180) % 360 }, 4500 - s * 6, 180, -360));
  ac.push(plane(7, along('30', -12 + s * .03, 'OAK'), 2100 - s * 5));
  ac.push(plane(8, along('01R', .12), 'ground', 0, 0));
  const rollKm = Math.min(18, .4 + s * .045);
  const off = s >= 35;
  ac.push(plane(9, along('01L', rollKm), off ? 150 + (s - 35) * 22 : 'ground', off ? 170 : 40 + s * 2, off ? 1320 : 0));
  ac.push(plane(10, along('01R', 3 + s * .075), 1300 + s * 20, 180, 1200));
  ac.push(plane(11, { lat: 37.615, lon: -122.388 + s * .000005, track: 80 }, 'ground', 12, 0));
  const gaDistance = Math.max(.4, 5 - s * .07);
  const gaAlt = s <= 25 ? 1100 - s * 20 : 600 + (s - 25) * 40;
  const gaPosition = along('28R', -gaDistance, 'SFO', s > 55 ? -(s - 55) * .05 : 0);
  ac.push(plane(12, gaPosition, gaAlt, 155, s <= 25 ? -1200 : 2400));
  for (let i = 13; i < count; i++) {
    const angle = i * 2.399963;
    const radius = 14 + ((i * 17) % 82);
    const p = core.projectLatLng(37.62, -122.375, angle * 180 / Math.PI, radius * 1000);
    ac.push(plane(i, { lat: p[0] + s * .00004, lon: p[1] - s * .00006, track: 305 }, 18000 + i % 12 * 1000, 360, 0));
  }
  return {
    traffic: { now: EPOCH + t * 5000, ac },
    datis: DATIS,
    schedule: SCHEDULE
  };
}
export const TICKS = Array.from({ length: 37 }, (_, i) => ({ nowMs: EPOCH + i * 5000, ...tick(i) }));
export const EMPTY = { traffic: { now: EPOCH, ac: [] }, datis: DATIS, schedule: SCHEDULE };
export function perfFixture(index) {
  const s = index * 5;
  const ac = [];
  const schedule = { ...SCHEDULE, arrivals: [], departures: [] };
  for (let i = 0; i < 20; i++) {
    const speed = 145 + i % 5 * 15;
    const distance = 18 + i * 3.5 - s * speed * .000514444;
    ac.push(plane(i, along(i % 2 ? '28R' : '28L', -distance),
      13 + distance * 170, speed, -speed * .000514444 * 170 * 60));
    schedule.arrivals.push({ callsign: 'UAL' + (123 + i), from_iata: 'JFK', live: true,
      est_arr: EPOCH / 1000 + (18 + i * 3.5) / (speed * .000514444) });
  }
  for (let i = 20; i < 35; i++) {
    const elapsed = s - (i - 22) * 30;
    const roll = Math.max(0, Math.min(30, elapsed + 30));
    const distance = .12 + .5 * .0025 * roll * roll + Math.max(0, elapsed) * .075;
    const speed = (elapsed >= 0 ? .075 : .0025 * roll) / .000514444;
    ac.push(plane(i, along(i % 2 ? '01R' : '01L', distance),
      elapsed > 0 ? 13 + elapsed * 25 : 'ground', speed, elapsed > 0 ? 1500 : 0));
    schedule.departures.push({ callsign: 'UAL' + (123 + i), to_iata: 'JFK', live: true,
      est_dep: EPOCH / 1000 + (i - 22) * 30 });
  }
  for (let i = 35; i < 95; i++) {
    const speed = i < 75 ? 0 : 8;
    const p = core.projectLatLng(37.612 + Math.floor((i - 35) / 10) * .0008,
      -122.393 + (i % 10) * .0006, 80, s * speed * .514444);
    ac.push(plane(i, { lat: p[0], lon: p[1], track: 80 }, 'ground', speed, 0));
  }
  for (let i = 95; i < 300; i++) {
    const start = core.projectLatLng(37.62, -122.375, i * 137.508, (20 + i * 17 % 75) * 1000);
    const track = i * 47 % 360;
    const speed = 180 + i % 10 * 30;
    const p = core.projectLatLng(...start, track, s * speed * .514444);
    ac.push(plane(i, { lat: p[0], lon: p[1], track }, 4000 + i % 36 * 1000, speed, 0));
  }
  return { traffic: { now: EPOCH + s * 1000, ac }, datis: DATIS, schedule };
}

// A sparse overnight-like scene: one inbound, one overflight, and a quiet apron. Still fully offline.
export const SPARSE_TICKS = TICKS.slice(0, 19).map(t => {
  const ac = t.traffic.ac.filter(a => ['a00005', 'a00009', 'a0000c', 'a0000f'].includes(a.hex));
  for (let i = 0; i < 24; i++) {
    ac.push(plane(50 + i, {
      lat: 37.613 + Math.floor(i / 6) * .0008,
      lon: -122.390 + (i % 6) * .001,
      track: 80
    }, 'ground', 0, 0));
  }
  return { ...t, traffic: { now: t.traffic.now, ac } };
});
