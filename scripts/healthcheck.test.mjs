import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Capture the actual endpoint callbacks without running CLI/network code, including on the v2.46 base.
async function validators() {
  const source = readFileSync(new URL('./healthcheck.mjs', import.meta.url), 'utf8')
    .split('\n// CLI entry point')[0].split('\nrun().catch')[0];
  const captured = {};
  const context = vm.createContext({ process: { argv: [], env: {} }, console: { log() {} },
    capture(name, path, validate) { captured[name] = validate; return null; } });
  vm.runInContext(source + '\ncheck = capture;', context);
  await vm.runInContext('run()', context);
  return captured;
}
const checks = await validators();
test('v247 round validators: schedule strings may be empty and airport codes are strings or null', () => {
  for (const code of ['', null, 'PRIVATE FIELD', 'x']) {
    assert.notEqual(checks.schedule({ data: { iata: code, arrivals: [{ flight: '', callsign: '', from_iata: code }],
      departures: [{ flight: '', callsign: '', to_iata: code }] } }), false);
  }
  assert.equal(checks.schedule({ data: { iata: 'SFO', arrivals: [{ flight: 42, callsign: '', from_iata: null }], departures: [] } }), false);
});
test('v247 round validators: FR24 ids accept strings or numbers', () => {
  for (const id of [123, 0, '', 'abc']) {
    assert.notEqual(checks.fr24search({ data: { results: [{ id, type: 'live', detail: { callsign: '', schd_from: 'PRIVATE FIELD', schd_to: null } }] } }), false);
  }
  assert.equal(checks.fr24search({ data: { results: [{ id: {}, type: 'live', detail: {} }] } }), false);
});
test('v247 round validators: ADSBDB empty iata and empty callsign are valid types', () => {
  for (const iata of ['', null, 'PRIVATE FIELD']) {
    assert.notEqual(checks.routeset({ data: [{ callsign: '', origin: { iata }, destination: null, originSource: 'adsbdb' }] }), false);
  }
  assert.equal(checks.routeset({ data: [{ callsign: 123, destination: { iata: '' } }] }), false);
});
test('v247 round CI: healthcheck unit tests run in CI', () => {
  assert.match(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'), /run: node --test scripts\/healthcheck\.test\.mjs/);
});
const apt = { iata: 'SFO', name: 'San Francisco' };
const cases = {
  track: {
    good: [null, [], [[1700000000, 37.6, -122.3, 450, 280, false], [1700000010, 37.61, -122.35, null, 280, false]]],
    bad: [{}, true, { error: 'upstream' }, { path: 'bad' }, [[1, null, -122, 10]], [[1, 100, 200, 10]], [[1, 37, -122, 'bad', 280, false]]]
  },
  schedule: {
    good: [{ iata: 'LHR', name: 'Heathrow', arrivals: [], departures: [] }, { iata: 'LHR', name: 'Heathrow', arrivals: [{ flight: 'BA1', callsign: '', from_iata: '', sched_arr: null }], departures: [{ callsign: 'BAW2', to_iata: 'JFK', sched_dep: 1700000000 }] }],
    bad: [null, {}, true, [], { error: 'upstream' }, { iata: 'LHR', arrivals: [{}], departures: [] }, { iata: 'LHR', arrivals: [], departures: 'bad' }, { iata: 'LHR', arrivals: [], departures: [{ flight: 'BA1', to_iata: 'JFK', sched_dep: 'tomorrow' }] }]
  },
  fr24search: {
    good: [{ results: [] }, { results: [{ id: '123', type: 'live', detail: { callsign: 'BAW1', schd_from: 'LHR', schd_to: 'JFK' } }, { id: 'LHR', type: 'airport', detail: {} }] }, { results: [{ id: '123', type: 'live', detail: { callsign: 'N12345' } }] }],
    bad: [null, {}, [], true, { error: 'upstream' }, { results: [null] }, { results: [{}] }, { results: [{ type: 'live', id: 'a', detail: { schd_from: 42 } }] }]
  },
  routeset: {
    good: [[], [{ callsign: 'UAL1', origin: apt, destination: null, originSource: 'track' }], [{ callsign: 'UAL1', origin: null, destination: { region: 'Bay Area', display: 'Landing in Bay Area' } }]],
    bad: [null, {}, true, { error: 'upstream' }, [null], [{}], [{ callsign: 'UAL1' }], [{ callsign: 'UAL1', origin: { iata: 42 } }], [{ callsign: 'UAL1', destination: {} }]]
  }
};
for (const [name, fixture] of Object.entries(cases)) {
  test('v247 health validator: ' + name + ' rejects broken content and accepts legitimate empties', () => {
    for (const data of fixture.good) assert.notEqual(checks[name]({ data }), false, 'valid: ' + JSON.stringify(data));
    for (const data of fixture.bad) assert.equal(checks[name]({ data }), false, 'invalid: ' + JSON.stringify(data));
  });
}

// Exercise retry behavior without launching Chrome; base code lacks this launch policy.
function launchPolicy() {
  const source = readFileSync(new URL('./browser-check.mjs', import.meta.url), 'utf8');
  const helper = source.match(/^async function launchChromeWithRetry\([^]*?^}/m)?.[0];
  assert.ok(helper, 'Chrome launch has no timeout/relaunch policy');
  return vm.runInNewContext(helper + '\nlaunchChromeWithRetry', { report() {} });
}
test('v247 Chrome launch: 60 seconds and one clean relaunch on timeout', async () => {
  const retry = launchPolicy();
  let launches = 0, resets = 0;
  const result = await retry(async timeout => {
    assert.equal(timeout, 60000);
    if (++launches === 1) throw Object.assign(new Error('slow launch'), { code: 'CHROME_LAUNCH_TIMEOUT' });
    assert.equal(resets, 1);
    return 'connected';
  }, async () => { resets++; });
  assert.equal(result, 'connected');
  assert.equal(launches, 2);
});
test('v247 Chrome launch: repeated timeout and real errors remain failures', async () => {
  const retry = launchPolicy();
  for (const code of ['CHROME_LAUNCH_TIMEOUT', 'ENOENT', 'CDP_ERROR']) {
    let launches = 0, resets = 0;
    const error = Object.assign(new Error(code), { code });
    await assert.rejects(retry(async () => { launches++; throw error; }, async () => { resets++; }), e => e === error);
    assert.equal(launches, code === 'CHROME_LAUNCH_TIMEOUT' ? 2 : 1);
    assert.equal(resets, code === 'CHROME_LAUNCH_TIMEOUT' ? 1 : 0);
  }
});

test('v247 health validator: malformed JSON cannot masquerade as an empty track', async () => {
  const source = readFileSync(new URL('./healthcheck.mjs', import.meta.url), 'utf8')
    .split('\n// CLI entry point')[0].split('\nrun().catch')[0];
  for (const body of ['<html>upstream error</html>', '', 'not JSON']) {
    const context = vm.createContext({ process: { argv: [], env: {} }, console, AbortController, setTimeout, clearTimeout,
      validate: checks.track, fetch: async () => ({ status: 200, text: async () => body }) });
    const result = await vm.runInContext(source + "\nattempt('/track/abc123', validate)", context);
    assert.equal(result.ok, false, body);
  }
});
