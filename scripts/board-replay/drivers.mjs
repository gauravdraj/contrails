// Public consumer entry points only. The runtime factory is deliberately not imported:
// phase 2 may remove it while these adapters and their byte contracts stay unchanged.
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getBoard } from '../../worker/src/board.js';
import { memoryCache } from '../../worker/test-fixtures/sp-api/helpers.js';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const airports = JSON.parse(read('airports.json'));
const runways = JSON.parse(read('runways.json'));
const airlines = JSON.parse(read('airlines.json'));
const scripts = new Map();
function load(context, file) {
  if (!scripts.has(file)) scripts.set(file, new vm.Script(read(file), { filename: file }));
  scripts.get(file).runInContext(context);
}
const forbidden = () => { throw new Error('Replay attempted network or randomness'); };
const bindings = read('js/app-core.js').split('\n').filter(line => /^const \w+ = core\.\w+;$/.test(line)).join('\n');
assert.ok(bindings.length, 'app-core bindings missing');

function browser(clock) {
  const context = vm.createContext({
    console, AIRLINES_DATA: airlines, fetch: forbidden,
    document: { hidden: false, addEventListener() {} },
    localStorage: { getItem() { return null; }, setItem() {} },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock()])); }
      static now() { return clock(); }
    },
  });
  context.window = context;
  vm.runInContext('Math.random = () => { throw new Error("Replay attempted randomness"); };', context);
  return context;
}

// Seed the stored shape of mergeRoutesetEntries without starting its FR24 network
// enrichment. Validation still happens in the real schedule/board entry points.
function seedRoutes(context, routes, at) {
  for (const r of structuredClone(routes)) {
    if (!r.callsign || (!r.origin && !r.destination)) continue;
    const dest = r.destination;
    const parts = [r.origin?.iata, dest ? dest.region ? dest.display : dest.iata : null].filter(Boolean);
    context.routeCache[r.callsign] = {
      display: r.display || parts.join(' to '), iata: parts.join(' to '), origin: r.origin || null,
      destination: dest || null, originSource: r.originSource || null, destSource: r.destSource || null,
      confidence: r.confidence || null, phase: r.phase || null, fetchedAt: at,
    };
  }
}
function routeState(context, board) {
  const routes = {};
  for (const row of [...board.arrivals, ...board.departures, ...board.landed]) {
    const r = context.routeCache[row.callsign];
    if (r && !Object.hasOwn(routes, row.callsign)) routes[row.callsign] = {
      origin: r.origin ? { iata: r.origin.iata } : null,
      destination: r.destination ? { iata: r.destination.iata } : null,
      originSource: r.originSource, destSource: r.destSource, confidence: r.confidence,
    };
  }
  return routes;
}

export function pwa(scenario) {
  let now = scenario.ticks[0].at;
  const context = browser(() => now);
  load(context, 'contrails-core.js');
  Object.assign(context, {
    core: context.ContrailsCore, isPrivate: context.ContrailsCore.isPrivateAircraft,
    posHistory: {}, routeCache: {}, scheduleDataCache: {}, extraState: {}, aircraft: [],
    airportData: airports, runwayData: runways, feedClockOffsetMs: null,
    FETCH_TIMEOUT_MS: 25000, SCHEDULE_CACHE_TTL: 300000,
  });
  vm.runInContext(bindings, context);
  for (const file of ['js/data.js', 'js/render.js', 'js/airport-board.js']) load(context, file);
  seedRoutes(context, scenario.routes, now);
  const originals = {}, seen = {}, lastSeen = {};
  let schedule = null, datis = null;
  return scenario.ticks.map(input => {
    const tick = structuredClone(input);
    now = tick.at;
    const feed = tick.traffic;
    const feedNow = Number.isFinite(feed.now) ? feed.now : now;
    context.feedClockOffsetMs = context.core.updateClockOffset(context.feedClockOffsetMs, now, feedNow);
    const snapshot = context.buildAircraftSnapshot(feed.ac, { includeProximity: false, now,
      positionNow: Math.min(now, feedNow + context.feedClockOffsetMs) });
    // Independent history upkeep from scripts/watch-check.mjs reference(). Do not
    // call Feed here: two consumers sharing that implementation would mask regressions.
    for (const a of snapshot.aircraft) {
      const hex = a.icao24;
      const report = feedNow - Math.max(0, a.seenPos || 0) * 1000;
      lastSeen[hex] = now;
      if (seen[hex] != null && report <= seen[hex]) { Object.assign(a, originals[hex]); continue; }
      seen[hex] = report;
      originals[hex] = { ...a };
      const history = context.posHistory[hex] ||= [];
      const old = history.at(-1);
      const broken = !!old && (a.reportTs - old[2] > 30000 || context.core.haversineKm(old[0], old[1], a.lat, a.lng) > 10);
      history.push([a.lat, a.lng, a.reportTs, a.altFt, a.ground, broken, false]);
      if (history.length > 120) history.splice(0, history.length - 120);
      const entry = context.extraState[hex] ||= { samples: [] };
      if (broken) entry.samples = [];
      entry.samples.push({ lat: a.lat, lng: a.lng, ts: a.reportTs, spdMs: (a.speedKts || 0) * .514444,
        trackDeg: a.track, altFt: a.altFt, ground: a.ground });
      if (entry.samples.length > 120) entry.samples.shift();
    }
    for (const hex of Object.keys(lastSeen)) if (now - lastSeen[hex] > 360000) {
      delete context.posHistory[hex]; delete context.extraState[hex]; delete seen[hex];
      delete originals[hex]; delete lastSeen[hex];
    }
    if (Object.hasOwn(tick, 'schedule')) {
      schedule = tick.schedule;
      context.scheduleDataCache[scenario.iata] = { data: schedule, ts: now };
    }
    if (Object.hasOwn(tick, 'datis')) datis = tick.datis;
    context.aircraft = snapshot.aircraft;
    context.applyAirportScheduleMatches(scenario.iata, schedule, snapshot.aircraft);
    const active = context.core.parseDatisActiveRunways(datis && (datis.datis || datis.text || datis.raw));
    const board = context.buildLiveScheduleData(scenario.iata, scenario.lat, scenario.lng, snapshot.aircraft, active);
    return JSON.stringify({ board, routes: routeState(context, board) });
  });
}

// Parse the actual boot list each time this module starts. New nonvisual adapters
// inserted before feed.js are automatically exercised after the refactor.
const bootList = /for\s*\(var src of\s*(\[[\s\S]*?\])\s*\)/.exec(read('_watch/boot.js'));
assert.ok(bootList, 'Cannot find watch boot script array');
const watchScripts = vm.runInNewContext(bootList[1]);
const feedIndex = watchScripts.indexOf('feed.js');
assert.ok(feedIndex >= 0, 'feed.js missing from boot list');
const visual = new Set(['scene.js', 'display.js', 'paint.js', 'theme.js', 'moments.js', 'kiosk.js', 'project.js']);
export function watch(scenario) {
  let now = scenario.ticks[0].at;
  const context = browser(() => now);
  for (const file of watchScripts.slice(0, feedIndex + 1)) {
    if (visual.has(file)) continue;
    load(context, '_watch/' + file);
  }
  context.airportData = airports;
  context.runwayData = runways;
  const row = airports.find(a => a[0] === scenario.iata);
  const field = { iata: scenario.iata, lat: row[1], lng: row[2], name: row[4] || row[3], elev: row[6] || 0 };
  let captured;
  context.Watch.Scene = { syncCountdowns(board) { captured = JSON.stringify(board); } };
  const feed = new context.Watch.Feed(field, () => {}, () => now);
  return scenario.ticks.map(input => {
    const { at, ...payload } = structuredClone(input);
    now = at;
    captured = undefined;
    feed.ingest(payload, at); // Absent D-ATIS refreshes must remain absent.
    assert.equal(typeof captured, 'string', 'Feed did not call syncCountdowns');
    return captured;
  });
}

export async function worker(scenario, reverse = false) {
  let schedule = null, datis = null;
  const inputs = scenario.ticks.map(tick => {
    if (Object.hasOwn(tick, 'schedule')) schedule = tick.schedule;
    if (Object.hasOwn(tick, 'datis')) datis = tick.datis;
    return { ...tick, schedule, datis };
  });
  const saved = Object.fromEntries(['caches', 'fetch'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const dateNow = Date.now, random = Math.random;
  const output = new Array(inputs.length);
  try {
    globalThis.fetch = forbidden;
    Math.random = forbidden;
    const order = inputs.map((_, i) => i);
    if (reverse) order.reverse();
    for (const index of order) {
      const tick = structuredClone(inputs[index]);
      Date.now = () => tick.at;
      globalThis.caches = { default: memoryCache() };
      // Missing optional endpoints mirror loaded(): error + null. Foreign D-ATIS
      // coverage is handled by getBoard itself, returning none without a loader call.
      const loaded = data => data == null ? { status: 'error', data: null } : { status: 'ok', data };
      output[index] = JSON.stringify(await getBoard(scenario.iata, {}, { waitUntil() {} }, {
        loadTraffic: async () => loaded(tick.traffic),
        loadSchedule: async () => loaded(tick.schedule),
        loadDatis: async () => loaded(tick.datis),
      }));
    }
  } finally {
    Date.now = dateNow; Math.random = random;
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
  return output;
}
