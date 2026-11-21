// Reconstruct the named contrails-core.test.js regressions as raw ADS-B observations.
// No expected board verdicts live here; current consumer output owns the goldens.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../../contrails-core.js');
const runways = require('../../runways.json');
const airports = require('../../airports.json');
const field = airports.find(a => a[0] === 'SFO');
const EPOCH = Date.UTC(2026, 10, 18, 12);
const datis = { datis: 'SAN FRANCISCO. LANDING RUNWAY 28L. DEPARTING RUNWAY 28L.' };
const empty = { iata: 'SFO', arrivals: [], departures: [] };
// The watch-fixtures along() idea, using the real threshold and runway bearing.
function along(runway, km, side = 0) {
  const end = core.matchRunwayDesignator(runways.SFO, 'SFO', runway);
  const track = core.bearingDegrees(end.thresholdLat, end.thresholdLon, end.farEndLat, end.farEndLon);
  let p = core.projectLatLng(end.thresholdLat, end.thresholdLon, track, km * 1000);
  if (side) p = core.projectLatLng(...p, track + 90, side * 1000);
  return { lat: p[0], lon: p[1], track };
}
function plane(hex, flight, position, alt, rate = -700, overrides = {}) {
  return { hex, flight, t: 'A320', category: 'A3', ...position, alt_baro: alt,
    gs: alt === 'ground' ? 50 : 150, baro_rate: rate, seen: 0, seen_pos: 0, ...overrides };
}
function arrival(callsign, from = 'HNL') {
  return { callsign, flight: callsign.replace('UAL', 'UA'), from_iata: from, from_name: from,
    live: true, status: 'Estimated', est_arr: EPOCH / 1000 + 300, sched_arr: EPOCH / 1000 + 600 };
}
function scenario(name, frames, { schedule = empty, active = datis, routes = [], spacing = 10000 } = {}) {
  return { name, iata: 'SFO', lat: field[1], lng: field[2], routes,
    ticks: frames.map((ac, i) => ({ at: EPOCH + i * spacing,
      traffic: { ac, now: EPOCH + i * spacing }, ...(i === 0 ? { schedule, datis: active } : {}) })) };
}

// "UA3911: a plane flaring onto a runway after a descent is not 'Departing'"
// and "the board applies its own airport's schedule over a stale ADSBDB route".
const uaFrames = [[-9, 2500], [-6, 1600], [-3, 800], [-.8, 120], [.35, 40]].map(([km, alt], i) =>
  [plane('a1244b', 'UAL3911', along('28L', km), alt, i === 4 ? -100 : -900)]);
const stale = [{ callsign: 'UAL3911', origin: { iata: 'SYD' }, destination: { iata: 'LAX' },
  originSource: 'adsbdb', destSource: 'adsbdb', confidence: 'medium' }];
const ua = scenario('bug-ua3911', uaFrames, { routes: stale, schedule: { ...empty, arrivals: [arrival('UAL3911')] } });
// Exercise the history gate even when schedule matching cannot rescue the flare.
const uaUnmatched = scenario('bug-ua3911-unmatched', uaFrames, { routes: stale });

// "v248 go-around: sustained climb after descending final" and "v248 board:
// go-around stays in Landings". A second flight lands; a missing final poll tests retention.
const goAlts = [1100, 850, 600, 750, 940];
const landingAlts = [1100, 850, 600, 200, 'ground', 'ground'];
const goAround = scenario('bug-go-around', landingAlts.map((alt, i) => [
  ...(i < 5 ? [plane('abc123', 'UAL123', along('28L', -4 + i * .35), goAlts[i], i < 3 ? -1500 : 1140)] : []),
  plane('def456', 'UAL456', along('28L', [-4, -3, -2, -.7, .2, .6][i]), alt, i < 4 ? -1200 : 0),
]), { schedule: { ...empty, arrivals: [arrival('UAL123'), arrival('UAL456', 'JFK')] } });

// "v248 go-around: rejects touch-and-go": [1100,850,600,ground,200,600].
const touch = scenario('bug-touch-and-go', [1100, 850, 600, 'ground', 200, 600].map((alt, i) =>
  [plane('abc789', 'UAL789', along('28L', [-4, -3, -2, .2, .7, 1.2][i]), alt, i < 3 ? -1500 : i === 3 ? 0 : 1800)]),
{ schedule: { ...empty, arrivals: [arrival('UAL789')] } });

// "v248 review ga: a light aircraft unflagged touch-and-go never becomes a
// GO-AROUND row, at any pressure". This is its zero-pressure-offset C172/A1 case.
const lightTrack = [[-3,900],[-2.55,750],[-2.1,600],[-1.65,450],[-1.2,300],[-.75,150],[-.3,0],
  [0,0],[.25,75],[.47,125],[.69,175],[.91,250],[1.13,300],[1.35,350]];
const light = scenario('bug-light-touch-and-go', lightTrack.map(([km, alt], i) =>
  [plane('c172aa', 'N123AB', along('28L', km), alt, i < 7 ? -900 : 480, { t: 'C172', category: 'A1', gs: 70 })]),
{ spacing: 5000 });

// "review 3: runway memory removes reciprocals ... in both directions" and
// "deriveActiveRunways: direction of travel selects the correct designator".
// Two distinct flights provide arrival and departure evidence on each flow.
const reversal = scenario('bug-reciprocal-reversal', Array.from({ length: 6 }, (_, i) => {
  const r = i < 3 ? '28L' : '10R', j = i % 3;
  return [plane(i < 3 ? 'ab1001' : 'ab1003', i < 3 ? 'UAL401' : 'UAL403', along(r, .3 + j * .2), 250, -720),
    plane(i < 3 ? 'ab1002' : 'ab1004', i < 3 ? 'UAL402' : 'UAL404', along(r, 1 + j * .2), 300, 720)];
}), { active: null });

// Reciprocal matching without an active runway (v2.49 brief items 4/5): the
// reciprocal of 28L is 10R. Above the deriveActiveRunways ceiling, a descending
// 10R final must use the geometric matcher, with no D-ATIS or runway memory.
// Also reconstructs the v248 downwind reciprocal tests' underlying geometry.
const reciprocal = scenario('bug-reciprocal-unset', [3000, 2800, 2600, 2400].map((alt, i) =>
  [plane('ab1010', 'UAL410', along('10R', -8 + i * .6), alt, -1200)]),
{ active: null, schedule: { ...empty, arrivals: [arrival('UAL410')] } });

export const bugScenarios = [ua, uaUnmatched, goAround, touch, light, reversal, reciprocal];
