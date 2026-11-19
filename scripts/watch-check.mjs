// Offline watch acceptance harness. Node >=22; zero npm packages; ephemeral loopback ports.
// --perf: 60 seconds on Chrome's real GPU. --shots DIR: deterministic PNGs.
// --live --shots DIR [--seconds N]: only the three Worker endpoints may reach the network.
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm, cp, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { resolve, join, sep, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { EPOCH, DATIS, SCHEDULE, TICKS, EMPTY, SPARSE_TICKS, perfFixture } from './watch-fixtures.mjs';
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const core = require('../contrails-core.js');
const args = process.argv.slice(2);
const perf = args.includes('--perf');
const live = args.includes('--live');
const update = args.includes('--update-snapshot');
let shots = args.includes('--shots') ? resolve(args[args.indexOf('--shots') + 1] || '') : null;
const seconds = Number(args[args.indexOf('--seconds') + 1]) || 20;
for (let i = 0; i < args.length; i++) {
  if (['--shots', '--seconds'].includes(args[i])) {
    i++;
    continue;
  }
  if (!['--perf', '--live', '--update-snapshot'].includes(args[i]))
    throw new Error('Unknown option: ' + args[i]);
}
if (live && !shots)
  throw new Error('--live requires --shots DIR');
const errors = [];
const unexpectedRequests = [];
let stopping = false;
let browser;
let cdp;
let profile;
let server;
let host;
let exportRoot;
let hostOutput = "";
let hostFailure;
let coldAssets = [];
const logErrors = [];
const network = [];
const pendingNetwork = new Set();
let chromeStderr = '';
let chromeFailure = null;
let watchdog;
const sockets = new Set();
const requests = [];
let fixture = TICKS[0];
function percentile(values, p) {
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(s.length * p) - 1)] || 0;
}
async function check(name, fn) {
  try {
    const detail = await fn();
    assert.deepEqual(errors, [], 'Runtime console errors / exceptions');
    assert.deepEqual(logErrors, [], 'CDP Log errors');
    console.log('PASS ' + name + (detail ? ': ' + detail : ''));
  }
  catch (e) {
    console.error('FAIL ' + name + ': ' + e.message);
    throw e;
  }
}
async function until(name, predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  do {
    if (chromeFailure)
      throw new Error(chromeFailure);
    const result = await predicate();
    if (result)
      return result;
    await delay(70);
  } while (Date.now() < end);
  throw new Error('Timed out: ' + name);
}
async function findChrome() {
  const names = process.env.CHROME
    ? [process.env.CHROME]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : [
        "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"
      ];
  for (const name of names) {
    const paths = name.includes(sep)
      ? [resolve(name)]
      : (process.env.PATH || "").split(delimiter).map(dir => join(dir, name));
    for (const path of paths) {
      try {
        await access(path, constants.X_OK);
        return path;
      }
      catch { }
    }
  }
  throw new Error("Chrome not found. Set CHROME to a Chrome/Chromium executable (Node >=22 required).");
}
function listen(server, port) {
  return new Promise((resolve, reject) => {
    const failed = error => {
      server.removeListener("listening", listening);
      reject(error);
    };
    const listening = () => {
      server.removeListener("error", failed);
      resolve(server.address().port);
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen(port, "127.0.0.1");
  });
}
class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener(
      "message",
      event => {
        const message = JSON.parse(event.data);
        if (message.id) {
          const pending = this.pending.get(message.id);
          if (!pending)
            return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error)
            pending.reject(Object.assign(new Error(pending.method + ": " + message.error.message), {
              code: message.error.code
            }));
          else
            pending.resolve(message.result);
        }
        else {
          for (const fn of this.listeners.get(message.method) || []) {
            Promise.resolve().then(() => fn(message.params, message.sessionId)).catch(error => {
              if (!stopping)
                errors.push("CDP " + message.method + ": " + error.message);
            });
          }
        }
      }
    );
    socket.addEventListener(
      "close",
      () => {
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error("Chrome disconnected: " + p.method));
        }
        this.pending.clear();
      }
    );
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    const client = new CDP(socket);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("DevTools WebSocket connection timed out"));
      }, 10000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Cannot connect to DevTools WebSocket"));
        },
        { once: true }
      );
    });
    return client;
  }
  on(method, fn) {
    if (!this.listeners.has(method))
      this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP timed out: " + method));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
}
const boardFiles = [
  'contrails-core.js', 'js/data.js', 'js/render.js', 'js/airport-board.js'
];
function reference() {
  let now = EPOCH;
  let offset = null;
  const originals = {};
  const seen = {};
  const lastSeen = {};
  const context = vm.createContext({
    console,
    Date: class extends Date {
      constructor(...args) {
        super(...(args.length ? args : [now]));
      }
      static now() {
        return now;
      }
    },
    AIRLINES_DATA: require('../airlines.json'),
    document: { addEventListener() { } },
    FETCH_TIMEOUT_MS: 25000,
    airportData: require('../airports.json'),
    runwayData: require('../runways.json'),
    routeCache: {},
    posHistory: {},
    extraState: {},
    scheduleDataCache: {},
    SCHEDULE_CACHE_TTL: 600000,
    aircraft: []
  });
  context.window = context;
  context.localStorage = {
    getItem() {
      return null;
    }
  };
  // Execute the unchanged core, then expose exactly its exported functions as app globals.
  return (async () => {
    vm.runInContext(await readFile(join(ROOT, boardFiles[0]), 'utf8'), context, { filename: boardFiles[0] });
    context.core = context.ContrailsCore;
    Object.assign(context, context.core);
    context.isPrivate = context.core.isPrivateAircraft;
    for (const file of boardFiles.slice(1))
      vm.runInContext(await readFile(join(ROOT, file), 'utf8'), context, { filename: file });
    for (const name of ['project', 'theme', 'scene', 'moments', 'display'])
      vm.runInContext(
        await readFile(join(ROOT, '_watch/' + name + '.js'), 'utf8'),
        context,
        { filename: '_watch/' + name + '.js' }
      );
    let previous = null;
    return {
      context,
      ingest(payload, time) {
        now = time;
        const feed = payload.traffic;
        const feedNow = feed.now;
        offset = context.core.updateClockOffset(offset, now, feedNow);
        const snapshot = context.buildAircraftSnapshot(
          feed.ac,
          { includeProximity: false, now, positionNow: Math.min(now, feedNow + offset) }
        );
        // Independent history upkeep, deliberately not imported from the watch feed adapter.
        for (const a of snapshot.aircraft) {
          const hex = a.icao24;
          const report = feedNow - Math.max(0, a.seenPos || 0) * 1000;
          lastSeen[hex] = now;
          if (seen[hex] != null && report <= seen[hex]) {
            Object.assign(a, originals[hex]);
            continue;
          }
          seen[hex] = report;
          originals[hex] = { ...a };
          const history = context.posHistory[hex] ||= [];
          const old = history.at(-1);
          const broken = !!old && (a.reportTs - old[2] > 30000 ||
            context.haversineKm(old[0], old[1], a.lat, a.lng) > 10);
          history.push([a.lat, a.lng, a.reportTs, a.altFt, a.ground, broken, false]);
          if (history.length > 120)
            history.splice(0, history.length - 120);
          let entry = context.extraState[hex] ||= { samples: [] };
          if (broken)
            entry.samples = [];
          entry.samples.push({
            lat: a.lat,
            lng: a.lng,
            ts: a.reportTs,
            spdMs: (a.speedKts || 0) * .514444,
            trackDeg: a.track,
            altFt: a.altFt,
            ground: a.ground
          });
          if (entry.samples.length > 120)
            entry.samples.shift();
        }
        for (const hex of Object.keys(lastSeen))
          if (now - lastSeen[hex] > 360000) {
            delete context.posHistory[hex];
            delete context.extraState[hex];
            delete seen[hex];
            delete originals[hex];
            delete lastSeen[hex];
          }
        context.scheduleDataCache.SFO = { data: payload.schedule, ts: now };
        context.aircraft = snapshot.aircraft;
        context.applyAirportScheduleMatches('SFO', payload.schedule, snapshot.aircraft);
        const datis = context.parseDatisActiveRunways(payload.datis.datis);
        const board = context.buildLiveScheduleData('SFO', 37.62, -122.375, snapshot.aircraft, datis);
        const delayMs = context.computePlaybackDelayMs(5000, 0, { minMs: 3200, maxMs: 8000 });
        // Real board sync, run on display time. The reference does not call the watch countdown adapter.
        now =
          time - delayMs;
        context.syncAirportCountdowns(board);
        now = time;
        const field = { iata: 'SFO', lat: 37.62, lng: -122.375, name: 'San Francisco', elev: 13 };
        const scene = context.Watch.Scene.build(board, snapshot.aircraft, previous, field, time, delayMs, datis);
        context.Watch.Moments.update(previous, scene);
        previous = scene;
        return { board, scene };
      }
    };
  })();
}
function boardRows(board) {
  return ['arrivals', 'departures', 'landed'].flatMap(tab => board[tab].map(r => ({
    hex: r.hex,
    tab,
    runway: r.runway ?? null,
    runwayAssumed: !!r.runwayAssumed,
    seq: r.sequence ?? null,
    status: r.status ?? null,
    goAround: !!r.goAround
  }))).sort((a, b) => a.hex.localeCompare(b.hex) || a.tab.localeCompare(b.tab));
}
function round(value) {
  if (typeof value === 'number')
    return Math.round(value * 10) / 10;
  if (Array.isArray(value))
    return value.map(round);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, round(v)]));
  return value;
}
function finite(value) {
  if (typeof value === 'number')
    assert.ok(Number.isFinite(value), 'non-finite display value');
  else if (value && typeof value === 'object')
    Object.values(value).forEach(finite);
}
async function snapshots() {
  const ref = await reference();
  const frames = [];
  for (let i = 0; i < TICKS.length; i++) {
    const r = ref.ingest(TICKS[i], TICKS[i].nowMs);
    if ([0, 12, 24].includes(i)) {
      const W = ref.context.Watch;
      const v = W.Project.view(1440, 900, r.scene.field);
      v.palette = W.Theme.palettes.night;
      v.runways = require('../runways.json').SFO;
      const display = W.Display.buildDisplayList(r.scene, v, TICKS[i].nowMs, (text, size) => text.length * size * .68);
      finite(display);
      frames.push({ time: TICKS[i].nowMs, display: round(display) });
    }
  }
  const file = join(ROOT, '_watch/test/display-snapshot.json');
  if (update) {
    await writeFile(file, JSON.stringify(frames, null, 2) + '\n');
    console.log('UPDATED _watch/test/display-snapshot.json');
  }
  else
    assert.deepEqual(JSON.parse(JSON.stringify(frames)), JSON.parse(await readFile(file, 'utf8')));
  return '3 fixed epochs, deterministic text widths, rounded to 0.1 px';
}
const deployPaths = ['_watch', ...boardFiles, 'airlines.json', 'airports.json', 'runways.json'];
async function setup() {
  exportRoot = await mkdtemp(join(tmpdir(), 'contrails-watch-export-'));
  for (const path of deployPaths) {
    await mkdir(resolve(exportRoot, path, '..'), { recursive: true });
    await cp(join(ROOT, path), join(exportRoot, path), { recursive: true });
  }
  host = spawn('python3', ['_watch/serve.py', '--bind', '127.0.0.1', '0'],
    { cwd: exportRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  host.on('error', e => { hostFailure = e.code === 'ENOENT'
    ? 'python3 is required for the hosted transfer gate; install Python 3.9 or newer.' : e.message; });
  host.stdout.on('data', b => { hostOutput += b; });
  host.stderr.on('data', b => { hostFailure = String(b); });
  host.on('exit', (code, signal) => {
    if (!stopping) hostFailure = 'Python host exited: ' + (signal || code) + ' ' + (hostFailure || '');
  });
  const hostPort = await until('Python export host', () => {
    if (hostFailure) throw new Error(hostFailure);
    return Number(hostOutput.trim()) || false;
  });
  const origin = 'http://127.0.0.1:' + hostPort;
  // The host serves only the deployment export; a separate proxy denies browser background egress.
  server = http.createServer((_req, res) => res.writeHead(502).end('External network disabled'));
  server.on('connection', s => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on(
    'connect',
    (_req, s) => {
      s.on('error', () => { });
      s.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    }
  );
  const port = await listen(server, 0);
  const proxy = 'http://127.0.0.1:' + port;
  profile = await mkdtemp(join(tmpdir(), 'contrails-watch-'));
  browser = spawn(
    await findChrome(),
    [
      '--headless=new',
      '--no-sandbox',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      '--user-data-dir=' + profile,
      ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
      '--ignore-gpu-blocklist',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-domain-reliability',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-quic',
      '--dns-prefetch-disable',
      '--disable-dev-shm-usage',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--proxy-server=' + proxy,
      '--proxy-bypass-list=127.0.0.1',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--window-size=1440,900',
      'about:blank'
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  browser.stderr.on('data', chunk => {
    chromeStderr = (chromeStderr + chunk).slice(-12000);
  });
  browser.on('error', e => {
    chromeFailure = e.message;
  });
  browser.on(
    'exit',
    (code, signal) => {
      if (!stopping)
        chromeFailure = 'Chrome exited ' + (signal || code) + ' ' + chromeStderr;
    }
  );
  const devport = await until(
    'Chrome launch',
    async () => {
      const content = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
      return Number(content.split('\n')[0]) ||
        Number(/DevTools listening on ws:\/\/127.0.0.1:(\d+)/.exec(chromeStderr)?.[1]);
    },
    60000
  );
  const target = await until(
    'page target',
    async () => {
      const r = await fetch('http://127.0.0.1:' + devport + '/json');
      return (await r.json()).find(t => t.type === 'page');
    }
  );
  cdp = await CDP.connect(target.webSocketDebuggerUrl);
  cdp.on(
    'Runtime.exceptionThrown',
    ({ exceptionDetails: e }) => errors.push(e.exception?.description || e.text)
  );
  cdp.on(
    'Runtime.consoleAPICalled',
    ({ type, args }) => {
      if (type === 'error')
        errors.push(args.map(a => a.description || a.value).join(' '));
    }
  );
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'error') logErrors.push(entry);
  });
  cdp.on('Network.requestWillBeSent', e => {
    network.push(e);
    pendingNetwork.add(e.requestId);
  });
  cdp.on('Network.loadingFinished', e => pendingNetwork.delete(e.requestId));
  cdp.on('Network.loadingFailed', e => pendingNetwork.delete(e.requestId));
  cdp.on('Network.responseReceived', ({ response }) => {
    if (response.url.startsWith(origin) && response.status >= 400)
      unexpectedRequests.push('static ' + response.status + ' ' + response.url);
  });
  cdp.on(
    'Fetch.requestPaused',
    async ({ requestId, request, networkId }) => {
      const url = new URL(request.url);
      if (url.origin === origin) {
        await cdp.send('Fetch.continueRequest', { requestId });
        return;
      }
      let payload;
      let kind;
      const worker = request.method === 'GET' && !url.search &&
        url.origin === 'https://contrails-api.therealgraj.workers.dev';
      if (worker && url.pathname === '/adsb/lat/37.6200/lon/-122.3750/dist/65') {
        payload = fixture.traffic;
        kind = 'traffic';
      }
      else if (worker && url.pathname === '/datis/SFO') {
        payload = fixture.datis;
        kind = 'datis';
      }
      else if (worker && url.pathname === '/schedule/SFO') {
        payload = fixture.schedule;
        kind = 'schedule';
      }
      else {
        unexpectedRequests.push(request.url);
        await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
        return;
      }
      requests.push({ kind, at: Date.now() });
      if (live) {
        const response = await fetch(request.url, { signal: AbortSignal.timeout(25000) });
        await cdp.send(
          'Fetch.fulfillRequest',
          {
            requestId,
            responseCode: response.status,
            responseHeaders: [
              { name: 'Content-Type', value: 'application/json' },
              { name: 'Access-Control-Allow-Origin', value: '*' }
            ],
            body: Buffer.from(await response.arrayBuffer()).toString('base64')
          }
        );
        return;
      }
      await cdp.send(
        'Fetch.fulfillRequest',
        {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Access-Control-Allow-Origin', value: '*' }
          ],
          body: Buffer.from(JSON.stringify(payload)).toString('base64')
        }
      );
    }
  );
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'http*' }] });
  await size(1440, 900);
  await navigate(origin, '', true);
  await until('cold load network settled', () => pendingNetwork.size === 0);
  await cdp.evaluate('document.fonts.ready.then(() => true)');
  await delay(250);
  coldAssets = network.filter(e => new URL(e.request.url).origin === origin).map(e => e.request.url);
  await cdp.evaluate('__watch.stop()');
  await navigate(origin);
  return origin;
}
async function size(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
}
async function navigate(origin, extra = '', automatic = false) {
  // Page.navigate can resolve before the old execution context is gone. Its ready flag must not satisfy the wait.
  await cdp.evaluate('if (window.__watch) window.__watch.ready = false');
  await cdp.send(
    'Page.navigate',
    {
      url: origin + '/_watch/?theme=night' + (live || automatic ? '' : '&test=1') + extra
    }
  );
  await until('watch ready', () => cdp.evaluate('!!window.__watch?.ready'));
}
// Serializing a function keeps browser-side checks readable and makes their inputs explicit.
function inPage(fn, ...args) {
  return cdp.evaluate('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
}
async function ingest(t) {
  return inPage((tick, now) => {
    __watch.ingest(tick, now);
    __watch.frame(now);
    return {
      board: __watch.lastBoard,
      moments: __watch.scene.moments,
      lengths: Object.fromEntries(Object.entries(extraState).map(([k, v]) => [k, v.samples.length]))
    };
  }, t, t.nowMs ?? EPOCH);
}
async function parity() {
  const ref = await reference();
  let pair = false;
  let ga = false;
  let landed = false;
  let off = false;
  let previousLengths;
  for (let i = 0; i < TICKS.length; i++) {
    const t = TICKS[i];
    const expected = ref.ingest(t, t.nowMs);
    const actual = await ingest(t);
    if (i === 0) {
      assert.equal(actual.board.departures.find(r => r.hex === 'a00009')?.status, 'Holding');
      assert.equal(actual.board.departures.find(r => r.hex === 'a0000a')?.status, 'Departing');
      assert.ok(actual.board.landed.some(r => r.hex === 'a0000c' && r.taxiingIn));
      assert.ok(actual.board.arrivals.some(r => r.hex === 'a00007' && r.runwayAssumed));
    }
    assert.deepEqual(
      boardRows(actual.board),
      boardRows(JSON.parse(JSON.stringify(expected.board))),
      'tick ' + i
    );
    assert.ok(!actual.board.arrivals.some(r => r.hex === 'a00008'), 'OAK aircraft entered SFO arrivals');
    pair ||=
      expected.scene.ladder.pairs.some(p => [p.a, p.b].includes('a00001') && [p.a, p.b].includes('a00002'));
    ga ||= actual.board.arrivals.some(r => r.hex === 'a0000d' && r.goAround && !r.sequence);
    landed ||= actual.board.landed.some(r => r.hex === 'a00001');
    off ||= actual.moments.some(m => m.type === 'takeoff' && m.hex === 'a0000a');
    if (i === 9)
      assert.deepEqual(actual.lengths, previousLengths, 'cached payload added samples');
    previousLengths = actual.lengths;
  }
  assert.ok(pair && ga && landed && off, JSON.stringify({ pair, ga, landed, off }));
  assert.equal(JSON.stringify(TICKS[8].traffic), JSON.stringify(TICKS[9].traffic));
  return '37 ticks × every board row; pair, OAK exclusion, go-around, touchdown, takeoff; cached tick adds 0 samples';
}
async function displayChecks(origin) {
  await navigate(origin);
  for (const t of TICKS.slice(0, 19)) await ingest(t);
  for (const [w, h] of [[1440, 900], [1280, 800], [1920, 1080], [1024, 1366], [1366, 1024]]) {
    await size(w, h);
    const list = await cdp.evaluate(`__watch.resize();__watch.frame(${EPOCH + 90000})`);
    finite(list);
    const labels = list.filter(p => p.kind === 'label' || p.kind === 'runwayLabel');
    const ends = labels.filter(p => p.kind === 'runwayLabel');
    assert.equal(ends.length, 8, 'all eight runway ends must remain readable');
    assert.ok(labels.length >= 14, 'cast labels missing');
    for (let i = 0; i < labels.length; i++) {
      const a = labels[i];
      assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= w && a.y + a.h <= h, 'label outside frame');
      for (let j = i + 1; j < labels.length; j++) {
        const b = labels[j];
        assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y,
          'labels overlap ' + a.text + ' / ' + b.text);
      }
    }
  }
  await size(1440, 900);
  await cdp.evaluate(`__watch.resize();__watch.frame(${EPOCH + 90000})`);
  const pixels = await inPage(() => {
    const a = __watch.displayList.find(p => p.kind === 'dart' && p.role === 'arrival' && p.seq === 1);
    const runways = __watch.staticList.filter(p => p.semantic === 'runway');
    const r = runways[0];
    const ctx = document.getElementById('traffic').getContext('2d');
    const bg = document.getElementById('chart').getContext('2d');
    function sample(c, x, y) {
      return Array.from(c.getImageData(Math.round(x), Math.round(y), 1, 1).data);
    }
    return {
      arrival: sample(ctx, a.x, a.y),
      runway: sample(bg, (r.points[0][0] + r.points[1][0]) / 2, (r.points[0][1] + r.points[1][1]) / 2),
      background: sample(bg, 10, 10),
      lengths: runways.slice(0, 2).map(p => Math.hypot(
        p.points[0][0] - p.points[1][0], p.points[0][1] - p.points[1][1]))
    };
  });
  assert.ok(pixels.arrival[3] > 100 && pixels.arrival[0] > pixels.arrival[2] + 30, JSON.stringify(pixels));
  assert.ok(pixels.runway[0] > 40 && pixels.runway[1] > 50, JSON.stringify(pixels));
  assert.ok(pixels.background[0] < 30 && pixels.background[1] < 45, JSON.stringify(pixels));
  assert.ok(pixels.lengths.every(n => n >= 110 && n <= 140), 'long runway lengths: ' + pixels.lengths);
  const geography = [];
  for (const theme of ['night', 'day']) {
    const samples = await inPage(mode => {
      __watch.setTheme(mode);
      const v = __watch.view;
      const ctx = document.getElementById('chart').getContext('2d');
      function sample(lat, lng) {
        const p = Watch.Project.project(lat, lng, v);
        return Array.from(ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data).slice(0, 3);
      }
      const geo = __watch.staticList.find(p => p.kind === 'geography');
      const rim = [];
      for (let i = 0; i < 24; i++) {
        const angle = i / 24 * Math.PI * 2;
        const x = v.cx + Math.cos(angle) * (geo.r + 3);
        const y = v.cy + Math.sin(angle) * (geo.r + 3);
        if (y > 170 && y < v.chartH - 5) {
          rim.push(Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data).slice(0, 3));
        }
      }
      return {
theme: mode, bay: sample(37.60, -122.25), peninsula: sample(37.55, -122.40),
        palette: v.palette, rim, tracking: getComputedStyle(document.getElementById('local-time')).letterSpacing
};
    }, theme);
    const rgb = hex => hex.slice(1).match(/../g).map(n => parseInt(n, 16));
    const near = (a, b) => a.every((value, i) => Math.abs(value - b[i]) <= 3);
    assert.ok(near(samples.bay, rgb(samples.palette.water)), 'Bay must be water: ' + JSON.stringify(samples));
    assert.ok(near(samples.peninsula, rgb(samples.palette.land)), 'peninsula must be land: ' + JSON.stringify(samples));
    assert.ok(samples.rim.every(p => near(p, rgb(samples.palette.bg))), 'geography leaked beyond the disc');
    assert.ok(['normal', '0px'].includes(samples.tracking), 'clock must not use tracking');
    geography.push({ theme, bay: samples.bay, peninsula: samples.peninsula });
  }
  console.log(JSON.stringify({ geographyPixels: geography, runwayLengthsPx: pixels.lengths.map(n => +n.toFixed(1)) }));
  await cdp.evaluate("__watch.setTheme('night')");
  // Observed transitions appear on display time, never early; all three expire.
  const events = await cdp.evaluate('__watch.scene.moments');
  assert.ok(events.some(e => e.type === 'go-around'));
  assert.ok(events.some(e => e.type === 'takeoff'));
  for (const t of TICKS.slice(19, 27)) await ingest(t);
  const all = await cdp.evaluate('__watch.scene.moments');
  assert.ok(all.some(e => e.type === 'touchdown'));
  for (const e of all) {
    const count = (time, hex) => {
      return __watch.frame(time).filter(p => p.semantic === 'moment' && p.hex === hex).length;
    };
    assert.equal(await inPage(count, e.atMs + 5250 - 1, e.hex), 0);
    assert.equal(await inPage(count, e.atMs + 5250 + 500, e.hex), 1);
    assert.equal(await inPage(count, e.atMs + 5250 + e.duration, e.hex), 0);
  }
  return '5 viewports; flight + runway labels separated; land/water/rim pixels; runway scale; 3 moment types + expiry';
}
async function emptyChecks(origin) {
  await navigate(origin);
  await ingest(EMPTY);
  const state = await inPage(() => ({
    quiet: __watch.scene.quiet,
    note: document.getElementById('sky-note').textContent,
    list: __watch.displayList,
    hidden: document.getElementById('empty').hidden
  }));
  finite(state.list);
  assert.ok(state.quiet && !state.hidden && /Quiet sky.*Next expected/.test(state.note));
  return state.note;
}
async function expiryChecks(origin) {
  await navigate(origin);
  await ingest({ ...TICKS[0], datis: { datis: 'LANDING RUNWAY 19L. DEPARTING RUNWAY 19R.' } });
  assert.deepEqual(await cdp.evaluate('__watch.feed.datis.arriving_runways'), ['19L']);
  await cdp.evaluate(`__watch.ingest({}, ${EPOCH + 59999})`);
  assert.ok(await cdp.evaluate('!!__watch.feed.datis'));
  await cdp.evaluate(`__watch.ingest({}, ${EPOCH + 60000})`);
  assert.equal(await cdp.evaluate('__watch.feed.datis'), null);
  assert.ok(!(await cdp.evaluate('__watch.lastBoard.activeArrivalRunways')).includes('19L'));
  // A null network refresh replaces the old override, rather than pinning it indefinitely.
  await ingest({ ...TICKS[0], nowMs: EPOCH + 61000,
    datis: { datis: 'LANDING RUNWAY 19L. DEPARTING RUNWAY 19R.' } });
  await cdp.evaluate(`__watch.frame(${EPOCH + 121000})`);
  assert.ok(await cdp.evaluate('!!__watch.feed.datis'));
  fixture = { ...TICKS[0], datis: null };
  await cdp.evaluate('__watch.feed.refresh("datis")');
  assert.equal(await cdp.evaluate('__watch.feed.datis'), null);
  assert.deepEqual(await cdp.evaluate('__watch.scene.departureRunways'), []);
  fixture = TICKS[0];
  await cdp.evaluate(`__watch.frame(${EPOCH + 181000});__watch.feed.refresh('datis')`);
  assert.deepEqual(await cdp.evaluate('__watch.feed.datis.arriving_runways'), ['28L', '28R']);
  return 'override valid at TTL−1; expired at 60 s; null refresh clears it; successful refresh recovers';
}
async function timingChecks(origin) {
  await navigate(origin);
  await ingest(TICKS[0]);
  const first = await cdp.evaluate('__watch.scene.items.find(a=>a.hex==="a0000b")');
  assert.equal(first.departureAtMs, null, 'first seen airborne must not invent liftoff');
  for (const t of TICKS.slice(1, 13)) await ingest(t);
  const result = await inPage(time => {
    const scene = __watch.scene;
    const v = __watch.view;
    const displayTime = time - scene.delay;
    const list = __watch.frame(time);
    const departures = ['a0000a', 'a0000b'].map(hex => {
      const a = scene.items.find(a => a.hex === hex);
      const pose = core.interpolatePlaybackPose(a.samples, displayTime, { maxExtrapolationMs: 0 });
      const alt = pose.prev.altFt + (pose.next.altFt - pose.prev.altFt) * pose.progress;
      const dart = list.find(p => p.kind === 'dart' && p.hex === hex && p.semantic !== 'bead');
      const shadow = list.find(p => p.semantic === 'shadow' && p.hex === hex);
      const bead = list.find(p => p.semantic === 'bead' && p.hex === hex);
      return { hex, atMs: a.departureAtMs, alt, rawAlt: a.altFt, beadY: bead.y,
        expectedY: v.height - 61 - Math.min(1, Math.sqrt(alt / 10000)) * Math.max(30, v.height - 61 - (v.chartH + 44)),
        lift: shadow.y - dart.y, expectedLift: Math.min(14, Math.sqrt(Math.max(0, alt - scene.field.elev)) * .16),
        label: list.find(p => p.kind === 'label' && p.zone === 'strip' && p.hex === hex)?.text };
    });
    const a = structuredClone(scene.items.find(a => a.role === 'arrival' && a.seq === 1));
    a.states = [];
    const small = { ...scene, items: [a], lastNew: time, moments: [] };
    const draw = t => Watch.Display.buildDisplayList(small, v, t + scene.delay, (text, size) => text.length * size * .68);
    a.countdown = core.updateArrivalCountdown(null, displayTime + 145000, displayTime);
    const before = draw(displayTime).find(p => p.kind === 'label' && p.zone === 'chart').text;
    a.countdown = core.updateArrivalCountdown(a.countdown, displayTime + 260000, displayTime);
    const coarseList = draw(displayTime);
    const after = draw(displayTime + 30000);
    const bead = coarseList.find(p => p.semantic === 'bead');
    return { departures, before, coarse: a.countdown.coarse,
      chart: coarseList.find(p => p.kind === 'label' && p.zone === 'chart').text,
      strip: coarseList.find(p => p.kind === 'label' && p.zone === 'strip').text,
      beadMinutes: (v.width * .74 - bead.x) / (v.width * .74 - 58) * 15,
      after: after.find(p => p.kind === 'label' && p.zone === 'chart').text,
      boardText: formatLandingEta(260 / 60) };
  }, EPOCH + 60000);
  assert.equal(result.departures[0].atMs, EPOCH + 35000);
  assert.equal(result.departures[1].atMs, null);
  assert.match(result.departures[1].label, /EST/);
  for (const d of result.departures) {
    assert.notEqual(d.alt, d.rawAlt, 'must exercise delayed altitude');
    assert.ok(Math.abs(d.beadY - d.expectedY) < .00001, 'bead must share playback altitude');
    assert.ok(Math.abs(d.lift - d.expectedLift) < .00001, 'dart must share playback altitude');
  }
  assert.match(result.before, /2:25/);
  assert.equal(result.coarse, true);
  assert.ok(result.chart.endsWith(result.boardText) && result.strip.endsWith(result.boardText));
  assert.ok(Math.abs(result.beadMinutes - 4) < .000001);
  assert.match(result.after, /3:50/);
  return '2:25 → ~4min for 30 s → 3:50; coarse bead at 4 min; first-seen airborne EST; observed liftoff + playback altitude';
}
async function kioskChecks(origin) {
  await navigate(origin);
  const result = await inPage(async () => {
    const stats = { requests: 0, releases: 0, active: 0, maxActive: 0 };
    const pending = [];
    const locks = [];
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: {
      request() {
        stats.requests++;
        return new Promise(resolve => pending.push(() => {
          const lock = new EventTarget();
          lock.released = false;
          stats.active++;
          stats.maxActive = Math.max(stats.maxActive, stats.active);
          lock.release = async () => {
            if (lock.released) return;
            lock.released = true;
            stats.releases++;
            stats.active--;
            lock.dispatchEvent(new Event('release'));
          };
          locks.push(lock);
          resolve(lock);
        }));
      }
    } });
    const button = document.getElementById('fullscreen');
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    const visibility = () => document.dispatchEvent(new Event('visibilitychange'));
    const steps = [];
    for (const fullscreen of [undefined, async () => { throw new Error('Fullscreen unavailable'); }]) {
      document.documentElement.requestFullscreen = fullscreen;
      button.click();
      await settle();
      visibility(); visibility();
      steps.push(pending.length);
      pending.shift()();
      await settle();
      visibility(); visibility();
      steps.push(stats.active, pending.length);
      button.click();
      await settle();
      steps.push(stats.active, button.getAttribute('aria-pressed'));
    }
    // Turning off while acquisition is pending releases the late sentinel immediately.
    button.click(); await settle();
    button.click(); await settle();
    pending.shift()(); await settle();
    steps.push(stats.active, button.getAttribute('aria-pressed'));
    button.click(); await settle();
    pending.shift()(); await settle();
    await locks.at(-1).release();
    visibility(); visibility(); await settle();
    steps.push(pending.length);
    pending.shift()(); await settle();
    button.click(); await settle();
    return { ...stats, steps };
  });
  assert.deepEqual(result.steps, [1, 1, 0, 0, 'false', 1, 1, 0, 0, 'false', 0, 'false', 1]);
  assert.deepEqual([result.requests, result.releases, result.active, result.maxActive], [5, 5, 0, 1]);
  return 'fullscreen absent/rejected; pending-acquire toggle-off; visibility reacquire; 5 locks released, max concurrent = 1';
}
async function widthCacheChecks(origin) {
  await navigate(origin);
  await ingest(TICKS[0]);
  const result = await inPage(() => {
    const p = new Watch.Paint.Painter(document.createElement('canvas'), document.createElement('canvas'));
    const scene = structuredClone(__watch.scene);
    scene.items = scene.items.filter(a => a.hex === 'a00001');
    scene.items[0].states = [];
    for (let i = 0; i < 650; i++) {
      scene.items[0].callsign = 'TEST' + i;
      p.draw(scene, __watch.view, null, __watch.frameTime);
    }
    return { size: p.widths.size, obsolete: [...p.widths.keys()].some(k => k.includes('TEST0')),
      current: [...p.widths.keys()].some(k => k.includes('TEST649')) };
  });
  assert.ok(result.size <= 512 && !result.obsolete && result.current, JSON.stringify(result));
  return '650 changing callsigns: ≤512 cached widths; obsolete entries evicted';
}
async function outageChecks(origin) {
  await navigate(origin);
  await ingest(TICKS[0]);
  // The outage is simulated in-page: the page's own fetch rejects traffic requests, exactly as a dropped network
  // would surface to the feed, without producing browser network-error log entries. Every scenario therefore
  // asserts zero Log/Runtime errors with no exemption (rubric R2).
  await cdp.evaluate(`(() => {
    window.__realFetch = window.fetch;
    window.fetch = (url, options) => /\\/adsb\\//.test(String(url))
      ? Promise.reject(new TypeError('simulated outage'))
      : window.__realFetch(url, options);
  })()`);
  await cdp.evaluate('__watch.feed.refresh("traffic")');
  assert.equal(await cdp.evaluate('__watch.feed.failures'), 1);
  await cdp.evaluate('__watch.feed.refresh("traffic")');
  assert.equal(await cdp.evaluate('__watch.feed.failures'), 2);
  const baseline = await cdp.evaluate(`__watch.frame(${EPOCH + 14000});__watch.displayList.find(p=>p.kind==='dart')`);
  const held = await inPage(time => {
    __watch.frame(time);
    return {
dart: __watch.displayList.find(p => p.kind === 'dart'),
      health: document.getElementById('health').dataset.state
};
  }, EPOCH + 50000);
  assert.equal(held.health, 'stale');
  assert.equal(baseline.x, held.dart.x);
  assert.equal(baseline.y, held.dart.y);
  assert.ok(held.dart.alpha < baseline.alpha);
  await cdp.evaluate('window.fetch = window.__realFetch');
  fixture = TICKS[11];
  await cdp.evaluate(`__watch.frame(${fixture.nowMs});__watch.feed.refresh('traffic')`);
  await cdp.evaluate(`__watch.frame(${fixture.nowMs + 1000})`);
  assert.equal(await cdp.evaluate('document.getElementById("health").dataset.state'), 'live');
  assert.equal(await cdp.evaluate('__watch.feed.failures'), 0);
  await until('outage network settled', () => pendingNetwork.size === 0);
  return 'two failed polls (in-page fetch rejection) -> stale dot; darts hold/fade; same-document recovery';
}
async function lifecycleChecks(origin) {
  const start = requests.length;
  fixture = TICKS[0];
  await navigate(origin, '', true);
  await until('initial three feeds', () => requests.length >= start + 3);
  await until('settled feeds', () => cdp.evaluate('Object.keys(__watch.feed.pending).length===0'));
  const before = await inPage(() => {
    window.__hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    document.dispatchEvent(new Event('visibilitychange'));
    return __watch.frameTime;
  });
  const hiddenCount = requests.length;
  await delay(5200);
  assert.equal(requests.length, hiddenCount, 'poll while hidden');
  assert.equal(await cdp.evaluate('__watch.frameTime'), before, 'render while hidden');
  await cdp.evaluate("__hidden=false;document.dispatchEvent(new Event('visibilitychange'))");
  await until('visibility return refresh', () => requests.length >= hiddenCount + 3);
  await delay(150);
  assert.equal(requests.length, hiddenCount + 3, 'visibility refresh burst');
  assert.ok(await cdp.evaluate('__watch.frameTime') > before, 'render did not resume');
  await until('settled return feeds', () => cdp.evaluate('Object.keys(__watch.feed.pending).length===0'));
  const single = requests.length;
  await cdp.evaluate("Promise.all(Array.from({length:6},()=>__watch.feed.refresh('traffic')))");
  assert.equal(requests.length, single + 1, 'concurrent traffic requests');
  await cdp.evaluate('__watch.stop()');
  return 'all feeds + rendering pause for 5.2 s; one refresh/feed on return; one request in flight';
}
async function budgets(origin) {
  await navigate(origin);
  const ticks = Array.from({ length: 45 }, (_, i) => ({ nowMs: EPOCH + i * 5000, ...perfFixture(i) }));
  assert.equal(ticks[0].traffic.ac.length, 300);
  assert.equal(ticks[0].schedule.arrivals.length, 20);
  assert.equal(ticks[0].schedule.departures.length, 15);
  assert.equal(ticks[0].traffic.ac.slice(35, 95).filter(a => a.alt_baro === 'ground').length, 60);
  for (let i = 1; i < ticks.length; i++) {
    for (let j = 0; j < 300; j++) {
      const a = ticks[i - 1].traffic.ac[j], b = ticks[i].traffic.ac[j];
      const distance = core.haversineKm(a.lat, a.lon, b.lat, b.lon) * 1000;
      assert.ok(Math.abs(distance - (a.gs + b.gs) / 2 * .514444 * 5) < .2,
        'perf displacement disagrees with speed: ' + b.hex);
      if (distance > 1)
        assert.ok(core.angleDiffDeg(core.bearingDegrees(a.lat, a.lon, b.lat, b.lon), b.track) < 1,
          'perf displacement disagrees with track: ' + b.hex);
    }
  }
  // Shared CI runners are noisy: one cold page's p95 of 45 samples is decided by a stray GC/JIT pause. The gate is
  // the median of three fresh-page p95s (the repo's perf rule: compare medians of >= 3 runs); the budget is unchanged.
  const runP95s = [];
  for (let run = 0; run < 3; run++) {
    if (run)
      await navigate(origin);
    const samples = await inPage((ticks, time) => {
      const samples = [];
      for (const t of ticks) {
        const start = performance.now();
        __watch.ingest(t, t.nowMs);
        samples.push(performance.now() - start);
      }
      __watch.frame(time);
      return samples;
    }, ticks, EPOCH + 220000);
    runP95s.push(percentile(samples, .95));
  }
  const p95 = percentile(runP95s, .5);
  assert.ok(p95 <= 10, 'scene rebuild p95 (median of 3 runs ' + JSON.stringify(runP95s) + ') ' + p95 + ' ms exceeds 10 ms');
  const roles = await cdp.evaluate('Object.fromEntries(["arrival","departure","taxi","landed","other"].map(r=>[r,__watch.scene.items.filter(a=>a.role===r).length]))');
  const histories = await cdp.evaluate('Math.min(...Object.values(extraState).map(e=>e.samples.length))');
  assert.equal(histories, 45, 'every perf aircraft must have a real 220-second history');
  console.log(JSON.stringify({
    aircraft: 300,
    sceneRebuildP95Ms: +p95.toFixed(3),
    sceneRebuildRunP95sMs: runP95s.map(v => +v.toFixed(3)),
    roles, historyPointsPerAircraft: histories
  }));
  return '20 arrivals / 15 departures / 60 apron / 205 overflights; speed/track verified; 220 s histories; p95 ≤ 10 ms';
}
function rawRequest(url, gzip = true) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { 'Accept-Encoding': gzip ? 'gzip' : 'identity' } }, response => {
      const chunks = [];
      response.on('data', b => chunks.push(b));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks) }));
      response.on('error', reject);
    }).on('error', reject);
  });
}
async function transferChecks(origin) {
  assert.ok(coldAssets.length >= 20, 'cold network log is incomplete');
  let total = 0;
  const assets = [];
  for (const url of coldAssets) {
    const response = await rawRequest(url);
    assert.equal(response.status, 200, url);
    assert.equal(response.headers['cache-control'], 'no-cache');
    assert.equal(Number(response.headers['content-length']), response.body.length);
    let path = new URL(url).pathname;
    if (path.endsWith('/')) path += 'index.html';
    const original = await readFile(join(exportRoot, path));
    const compressed = /\.(js|json|css|html|webmanifest|txt)$/.test(path);
    assert.equal(response.headers['content-encoding'], compressed ? 'gzip' : undefined, path);
    if (compressed) assert.equal(response.headers.vary, 'Accept-Encoding');
    assert.deepEqual(compressed ? gunzipSync(response.body) : response.body, original);
    if (path.endsWith('.woff2')) assert.equal(response.headers['content-type'], 'font/woff2');
    if (path.endsWith('.webmanifest')) assert.equal(response.headers['content-type'], 'application/manifest+json');
    total += response.body.length;
    assets.push({ path, bytes: response.body.length });
  }
  const plain = await rawRequest(origin + '/_watch/boot.js', false);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(plain.body, await readFile(join(exportRoot, '_watch/boot.js')));
  const redirect = await rawRequest(origin + '/_watch');
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.location, '/_watch/');
  for (const path of ['/', '/js/', '/_watch/fonts/', '/index.html', '/sw.js'])
    assert.equal((await rawRequest(origin + path)).status, 404, path + ' must be absent / unlisted');
  for (const path of ['index.html', 'sw.js'])
    await assert.rejects(access(join(exportRoot, path)), { code: 'ENOENT' });
  assert.equal(hostFailure, undefined, 'Python host must be quiet per request');
  assert.match(hostOutput, /^\d+\n$/, 'Python host only prints its bound port, never requests');
  assert.ok(total <= 400000, 'actual hosted first-load body bytes ' + total + ' exceeds 400000');
  console.log(JSON.stringify({ firstLoadTransferredBodyBytes: total, budgetBytes: 400000, assets }));
  return 'Python export; browser-derived cold assets; gzip/identity + MIME + length + no-cache; directory/index/SW 404';
}
async function perfRun(origin) {
  await navigate(origin);
  const seeded = Array.from({ length: 19 }, (_, i) => ({ nowMs: EPOCH + i * 5000, ...perfFixture(i) }));
  await inPage((ticks, time) => {
    for (const t of ticks) __watch.ingest(t, t.nowMs);
    __watch.frame(time);
  }, seeded, EPOCH + 90000);
  const startEpoch = EPOCH + 90000;
  const ticks = Array.from({ length: 13 }, (_, i) => ({ nowMs: startEpoch + i * 5000, ...perfFixture(i + 18) }));
  await inPage((ticks, epoch) => {
    window.__perf = { frames: [], long: [], start: performance.now(), ticks, poll: -1 };
    const s = __perf;
    s.observer = new PerformanceObserver(l => s.long.push(...l.getEntries().map(e => e.duration)));
    s.observer.observe({ type: 'longtask' });
    function frame() {
      const elapsed = performance.now() - s.start;
      if (elapsed >= 60000) {
        s.done = true;
        return;
      }
      const index = Math.floor(elapsed / 5000);
      if (index !== s.poll) {
        __watch.ingest(s.ticks[index], epoch + index * 5000);
        s.poll = index;
      }
      __watch.frame(epoch + elapsed);
      s.frames.push(__watch.frameMs);
      s.raf = requestAnimationFrame(frame);
    }
    frame();
  }, ticks, startEpoch);
  console.log('Measuring 60 seconds, 300 aircraft, default GPU (no SwiftShader)…');
  await until('60 second performance run', () => cdp.evaluate('!!__perf.done'), 70000);
  const result = await inPage(() => {
    __perf.observer.disconnect();
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      frames: __perf.frames,
      longTasks: __perf.long,
      maxHistoryPoints: Math.max(...Object.values(extraState).map(e => e.samples.length)),
      renderer: gl ? gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : 'Canvas2D; WebGL unavailable'
    };
  });
  // 19 seeded observations plus 11 new polls (the initial perf poll repeats the last seed).
  assert.ok(
    result.maxHistoryPoints >= 30,
    'perf polls did not advance history: ' + result.maxHistoryPoints
  );
  const report = {
    mode: 'perf',
    durationSeconds: 60,
    aircraft: 300,
    seededTrailSeconds: 90,
    maxHistoryPoints: result.maxHistoryPoints,
    frames: result.frames.length,
    frameScriptP95Ms: +percentile(result.frames, .95).toFixed(3),
    frameScriptP50Ms: +percentile(result.frames, .5).toFixed(3),
    longTasksOver50Ms: result.longTasks,
    renderer: result.renderer,
    platform: process.platform
  };
  report.meetsLocalTargets = report.frameScriptP95Ms <= 4 && !report.longTasksOver50Ms.length;
  console.log(JSON.stringify(report, null, 2));
}
async function screenshot(name) {
  // Test time is stopped; explicitly allow the compositor to present the canvas before capturing it.
  await inPage(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await mkdir(shots, { recursive: true });
  const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = join(shots, name + '.png');
  await writeFile(file, Buffer.from(result.data, 'base64'));
  console.log('SHOT ' + file);
}
async function shotRun(origin) {
  async function views(prefix) {
    for (const [w, h] of [[1440, 900], [1024, 1366]]) {
      await size(w, h);
      for (const theme of ['night', 'day']) {
        await inPage((theme, time) => {
          __watch.resize();
          __watch.setTheme(theme);
          __watch.frame(time || Date.now());
          return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }, theme, live ? null : EPOCH + 90000);
        await screenshot(prefix + theme + '-' + w + 'x' + h);
      }
    }
  }
  if (live) {
    console.log('Live observation for ' + seconds + ' seconds');
    await delay(seconds * 1000);
  } else {
    await navigate(origin);
    for (const t of TICKS.slice(0, 19)) await ingest(t);
  }
  await views('');
  if (!live) {
    await navigate(origin);
    for (const t of SPARSE_TICKS) await ingest(t);
    await views('sparse-');
    await navigate(origin);
    await ingest(EMPTY);
    await size(1440, 900);
    await cdp.evaluate(`__watch.resize();__watch.frame(${EPOCH})`);
    await screenshot('empty-1440x900');
    for (const type of ['touchdown', 'takeoff', 'go-around']) {
      await navigate(origin);
      for (let i = 0; i < TICKS.length - 2; i++) {
        const state = await ingest(TICKS[i]);
        const event = state.moments.find(e => e.type === type);
        if (!event) continue;
        // Buffer both sides of the observed event, just as live playback does.
        await ingest(TICKS[i + 1]);
        await ingest(TICKS[i + 2]);
        await cdp.evaluate(`__watch.frame(${event.atMs + 5250 + 2500})`);
        await screenshot('moment-' + type + '-1440x900');
        break;
      }
    }
  }
}

function guard() {
  let ref;
  for (const r of ['live/main', 'origin/main'])
    try {
      execFileSync('git', ['rev-parse', '--verify', r], { cwd: ROOT, stdio: 'pipe' });
      ref = r;
      break;
    }
    catch { }
  if (!ref) {
    throw new Error('Isolation baseline missing: provide live/main or origin/main before running watch-check (no network fetch is performed).');
  }
  const allowed = p => p.startsWith('_watch/') || [
    'scripts/watch-check.mjs',
    'scripts/watch-fixtures.mjs',
    'scripts/build-watch-geo.mjs',
    'scripts/deploy-watch-homeserver.sh',
    '.github/workflows/ci.yml',
    'docs/superpowers/specs/2026-11-19-airport-watch-design.md'
  ].includes(p);
  // Check both merge-base history and the working-tree comparison (uncommitted changes matter here).
  for (const range of [ref + '...', ref]) {
    const paths = execFileSync('git', ['diff', '--name-only', range], { cwd: ROOT, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
    assert.ok(paths.every(allowed), 'public-site files changed: ' + paths.filter(p => !allowed(p)).join(','));
  }
  const prohibited = execFileSync(
    'git',
    [
      'diff',
      '--name-only',
      ref,
      '--',
      'contrails-core.js',
      'js',
      'worker',
      'relay',
      'index.html',
      'sw.js',
      'app.bundle.js',
      'manifest.json',
      'styles.css'
    ],
    { cwd: ROOT, encoding: 'utf8' }
  ).trim();
  assert.equal(prohibited, '');
  return ref + '; existing app/core/worker/relay byte-identical';
}
async function cleanup() {
  stopping = true;
  clearTimeout(watchdog);
  if (cdp) {
    await cdp.evaluate('__watch?.stop()').catch(() => { });
    cdp.socket.close();
  }
  if (browser) {
    browser.kill('SIGTERM');
    await Promise.race([new Promise(r => browser.once('exit', r)), delay(1500)]);
    if (browser.exitCode == null && browser.signalCode == null)
      browser.kill('SIGKILL');
  }
  for (const s of sockets)
    s.destroy();
  if (server)
    await new Promise(r => server.close(r));
  if (host?.pid && host.exitCode == null && host.signalCode == null) {
    const exited = new Promise(r => host.once('exit', r));
    host.kill('SIGTERM');
    await exited;
  }
  if (exportRoot)
    await rm(exportRoot, { recursive: true, force: true });
  if (profile)
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
try {
  watchdog =
    setTimeout(
      () => {
        console.error('FAIL watchdog exceeded 180 seconds');
        cleanup().finally(() => process.exit(1));
      },
      180000
    );
  await check('R5/R6 public-site guard', guard);
  if (!live)
    await check('Node display-list snapshot', snapshots);
  const origin = await setup();
  console.log('PASS Chrome boot on Python export host ' + origin);
  await check('R3 actual hosted first-load transfer', () => transferChecks(origin));
  if (live) {
    await shotRun(origin);
  }
  else {
    await check('R1 independent board parity', parity);
    await check('Browser display, pixels, moments', () => displayChecks(origin));
    await check('R4 empty sky', () => emptyChecks(origin));
    await check('D-ATIS override expiry', () => expiryChecks(origin));
    await check('Countdown and departure playback', () => timingChecks(origin));
    await check('Kiosk awake toggle', () => kioskChecks(origin));
    await check('Bounded text-width cache', () => widthCacheChecks(origin));
    await check('Feed outage and recovery', () => outageChecks(origin));
    await check('Visibility and request lifecycle', () => lifecycleChecks(origin));
    await check('R3 scene rebuild budget', () => budgets(origin));
    if (perf)
      await perfRun(origin);
    if (shots)
      await shotRun(origin);
    await navigate(origin, '&airport=ZZZ');
    assert.equal(await cdp.evaluate('__watch.unknown'), true);
  }
  await check('R2 all scenarios: zero unexpected Log / Runtime errors', () => assert.deepEqual(errors, []));
  await check(
    'R2 zero unexpected requests',
    () => {
      assert.deepEqual(unexpectedRequests, []);
      return requests.length + ' fixture/live feed requests; deny-all browser proxy';
    }
  );
}
catch (error) {
  process.exitCode = 1;
  console.error(error.stack);
  if (errors.length)
    console.error('Browser errors:', JSON.stringify(errors));
  if (unexpectedRequests.length)
    console.error('Unexpected requests:', JSON.stringify(unexpectedRequests));
}
finally {
  await cleanup();
  process.exit(process.exitCode || 0);
}
