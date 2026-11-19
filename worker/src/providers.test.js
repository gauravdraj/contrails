import test from "node:test";
import * as providers from "./providers.js";
test.beforeEach(() => { providers._providerHealth?.clear(); configureRelay({}); });
import assert from "node:assert/strict";

test('v247 round health: one 429 is a blip, two consecutive failures cool down', async t => {
  let now = 1800000000000, fail = true, primaryCalls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('adsb.lol')) {
      primaryCalls++;
      if (fail) return new Response('', { status: 429 });
    }
    return new Response(JSON.stringify({ ac: [], now }));
  });
  await fetchAircraftResilient(37, -122, 50);
  assert.ok(!(providers._providerHealth.get('primary')?.retryAt > now));
  fail = false;
  assert.equal((await fetchLookupResilient('hex', 'abc123')).source, 'primary');
  fail = true;
  await fetchAircraftResilient(37, -122, 50);
  assert.ok(!(providers._providerHealth.get('primary')?.retryAt > now), 'success resets the failure streak');
  await fetchAircraftResilient(38, -122, 50);
  assert.ok(providers._providerHealth.get('primary')?.retryAt > now);
  await fetchLookupResilient('hex', 'abc123');
  assert.equal(primaryCalls, 4);
});
test('v247 round health: a never-settling recovery probe expires after twice the fetch timeout', async t => {
  let now = 1800000000000, primaryCalls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('adsb.lol')) {
      primaryCalls++;
      if (primaryCalls <= 2) throw new Error('down');
      if (primaryCalls === 3) return new Promise(() => {});
    }
    return new Response(JSON.stringify({ ac: [], now }));
  });
  await fetchAircraftResilient(37, -122, 50);
  now += RECOVERY_PROBE_MS + 1; // Also establishes the cooldown on b26e956.
  await fetchAircraftResilient(37, -122, 50);
  now += RECOVERY_PROBE_MS + 1;
  void fetchAircraftResilient(37, -122, 50);
  await Promise.resolve();
  assert.equal(primaryCalls, 3);
  now += 11999;
  assert.equal((await fetchLookupResilient('hex', 'abc123')).source, 'backup');
  now += 1;
  assert.equal((await fetchLookupResilient('hex', 'abc123')).source, 'primary');
  assert.equal(primaryCalls, 4);
});
test('v247 round health: sticky grids try a healthy primary when their backups are cooling', async t => {
  const now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  providers._providerHealth.set('backup', { failures: 2, retryAt: now + 30000, probing: false });
  _gridState.set('37.00/-122.00/50', { failCount: 2, staleCount: 0, lastNow: 0, usingBackup: true, lastProbeTs: now });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url));
    return new Response(JSON.stringify({ ac: [], now }));
  });
  const result = await fetchTraffic('/lat/37/lon/-122/dist/50', { lat: 37, lon: -122, dist: 50 }, {});
  assert.equal(result?.source, 'primary');
  assert.equal(calls.length, 1);
});
test('v247 round health: sticky grids retry expired probes and ignore their late failures', async t => {
  let now = 1800000000000, primaryCalls = 0, rejectProbe;
  t.mock.method(Date, 'now', () => now);
  providers._providerHealth.set('primary', { failures: 2, retryAt: now, probing: false });
  _gridState.set('37.00/-122.00/50', { failCount: 2, staleCount: 0, lastNow: 0, usingBackup: true, lastProbeTs: 0 });
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('adsb.lol') && ++primaryCalls === 1) return new Promise((resolve, reject) => { rejectProbe = reject; });
    return new Response(JSON.stringify({ ac: [], now }));
  });
  const probe = fetchTraffic('/lat/37/lon/-122/dist/50', { lat: 37, lon: -122, dist: 50 }, {});
  await Promise.resolve();
  now += 12000;
  const recovered = await fetchTraffic('/lat/37/lon/-122/dist/50', { lat: 37, lon: -122, dist: 50 }, {});
  assert.equal(recovered?.source, 'primary');
  rejectProbe(new Error('cancelled request settled late'));
  await probe;
  assert.equal(providers._providerHealth.has('primary'), false, 'late failure must not replace successful recovery');
});
for (const kind of ['nearby', 'lookup', 'grid']) {
  test('v247 round health: ' + kind + ' keeps trying after 429, 403 and one relay 503', async t => {
    configureRelay({ ADSB_RELAY_URL: 'https://relay.test', ADSB_RELAY_KEY: 'test' });
    let now = 1800000000000, relayCalls = 0;
    const calls = [];
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', async url => {
      calls.push(String(url));
      if (String(url).includes('adsb.lol')) return new Response('', { status: 429 });
      if (String(url).includes('adsb.fi')) return new Response('', { status: 403 });
      if (++relayCalls === 1) return new Response('', { status: 503 });
      return new Response(JSON.stringify({ ac: [], now }));
    });
    const attempt = () => kind === 'lookup' ? fetchLookupResilient('hex', 'abc123')
      : kind === 'nearby' ? fetchAircraftResilient(37, -122, 50)
      : fetchTraffic('/lat/37/lon/-122/dist/50', { lat: 37, lon: -122, dist: 50 }, {});
    await attempt().catch(() => null);
    calls.length = 0;
    now += 1000;
    const result = await attempt();
    assert.ok(result, 'retry returns data');
    assert.ok(calls.length > 0, 'retry must reach a provider');
    assert.equal(relayCalls, 2);
  });
}
for (const kind of ['nearby', 'lookup', 'grid', 'sticky grid']) {
  test('v247 round health: ' + kind + ' tries oldest retryAt when every provider is cooling', async t => {
    const now = 1800000000000;
    t.mock.method(Date, 'now', () => now);
    configureRelay({ ADSB_RELAY_URL: 'https://relay.test', ADSB_RELAY_KEY: 'test' });
    for (const oldest of ['primary', 'backup', 'relay']) {
      for (const name of ['primary', 'backup', 'relay']) {
        providers._providerHealth.set(name, { failures: 2, retryAt: now + (name === oldest ? 1000 : 30000), probing: false });
      }
      _gridState.clear();
      if (kind === 'sticky grid') _gridState.set('37.00/-122.00/50', {
        failCount: 2, staleCount: 0, lastNow: 0, usingBackup: true, lastProbeTs: now,
      });
      const calls = [];
      t.mock.method(globalThis, 'fetch', async url => {
        calls.push(String(url));
        return new Response(JSON.stringify({ ac: [], now }));
      });
      const result = kind === 'lookup' ? await fetchLookupResilient('hex', 'abc123')
        : kind === 'nearby' ? await fetchAircraftResilient(37, -122, 50)
        : await fetchTraffic('/lat/37/lon/-122/dist/50', { lat: 37, lon: -122, dist: 50 }, {});
      assert.ok(result, oldest);
      assert.equal(calls.length, 1, oldest);
      assert.ok(calls[0].includes({ primary: 'adsb.lol', backup: 'adsb.fi', relay: 'relay.test' }[oldest]), calls[0]);
    }
  });
}

import {
  buildBackupPath,
  isValidPayload,
  isFresh,
  normalizePayload,
  fetchTraffic,
  fetchAircraftResilient,
  configureRelay,
  fetchLookupResilient,
  _gridState,
  HARD_FAIL_THRESHOLD,
  STALE_THRESHOLD,
  RECOVERY_PROBE_MS,
} from "./providers.js";

test("isValidPayload accepts object with ac array", () => {
  assert.ok(isValidPayload({ ac: [] }));
  assert.ok(isValidPayload({ ac: [{ hex: "abc123" }], now: 1000 }));
});

test("isValidPayload rejects missing or malformed payloads", () => {
  assert.ok(!isValidPayload(null));
  assert.ok(!isValidPayload(undefined));
  assert.ok(!isValidPayload({}));
  assert.ok(!isValidPayload({ ac: "string" }));
  assert.ok(!isValidPayload(42));
});

test("isFresh treats first fetch as fresh", () => {
  assert.ok(isFresh({ now: 5000 }, { lastNow: 0 }));
});

test("isFresh detects stale when now does not advance", () => {
  assert.ok(!isFresh({ now: 1000 }, { lastNow: 1000 }));
  assert.ok(!isFresh({ now: 1001 }, { lastNow: 1000 }));
});

test("isFresh accepts sufficient advancement", () => {
  assert.ok(isFresh({ now: 3000 }, { lastNow: 1000 }));
  assert.ok(isFresh({ now: 3001 }, { lastNow: 1000 }));
});

test("isFresh handles missing now field", () => {
  assert.ok(!isFresh({}, { lastNow: 1000 }));
  assert.ok(isFresh({}, { lastNow: 0 }));
});

test("normalizePayload preserves ac array and metadata", () => {
  const ac = [{ hex: "abc123", lat: 37.6, lon: -122.4 }];
  const result = normalizePayload({ ac, now: 5000 }, "primary");
  assert.deepEqual(result.ac, ac);
  assert.equal(result.now, 5000);
  assert.equal(result.source, "primary");
});

test("normalizePayload defaults missing ac to empty array", () => {
  const result = normalizePayload({}, "backup");
  assert.deepEqual(result.ac, []);
  assert.equal(result.source, "backup");
});

test("normalizePayload preserves ctime when present", () => {
  const result = normalizePayload({ ac: [], now: 1000, ctime: 999 }, "primary");
  assert.equal(result.ctime, 999);
});

test("normalizePayload defaults now and ctime when both are missing", () => {
  const before = Date.now();
  const result = normalizePayload({ ac: [{ hex: "aaa" }] }, "primary");
  assert.ok(result.now >= before);
  assert.ok(result.ctime >= before);
  assert.equal(result.source, "primary");
});

test("buildBackupPath mirrors the primary path and caps the radius", () => {
  assert.equal(
    buildBackupPath({ lat: 37.6, lon: -122.4, dist: 200 }),
    "/lat/37.60/lon/-122.40/dist/200",
  );
  assert.equal(
    buildBackupPath({ lat: 37.6, lon: -122.4, dist: 500 }),
    "/lat/37.60/lon/-122.40/dist/250",
  );
});

test("fetchTraffic returns primary data on success", async (t) => {
  _gridState.clear();
  const originalFetch = globalThis.fetch;
  const payload = { ac: [{ hex: "abc123" }], now: Date.now() };

  globalThis.fetch = async () =>
    new Response(JSON.stringify(payload), { status: 200 });

  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await fetchTraffic(
    "/lat/37.60/lon/-122.40/dist/200",
    { lat: 37.60, lon: -122.40, dist: 200 },
    {},
  );
  assert.ok(result);
  assert.equal(result.source, "primary");
  assert.equal(result.ac.length, 1);
  assert.equal(result.ac[0].hex, "abc123");
});

test("fetchTraffic returns null on single primary failure when backup also down", async (t) => {
  _gridState.clear();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => { throw new Error("connection refused"); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await fetchTraffic(
    "/lat/37.60/lon/-122.40/dist/200",
    { lat: 37.60, lon: -122.40, dist: 200 },
    {},
  );
  assert.equal(result, null);
});

test("fetchTraffic serves backup on the first primary failure without going sticky", async (t) => {
  _gridState.clear();
  const originalFetch = globalThis.fetch;
  const backupPayload = { ac: [{ hex: "def456" }], now: Date.now() };

  globalThis.fetch = async (url) => {
    if (typeof url === "string" && url.includes("opendata.adsb.fi")) {
      return new Response(JSON.stringify(backupPayload), { status: 200 });
    }
    throw new Error("primary down");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const snapped = { lat: 37.60, lon: -122.40, dist: 200 };
  const gridPath = "/lat/37.60/lon/-122.40/dist/200";

  // A single primary blip must immediately serve the backup, not a 502.
  const first = await fetchTraffic(gridPath, snapped, {});
  assert.ok(first);
  assert.equal(first.source, "backup");
  assert.equal(first.ac[0].hex, "def456");
  assert.equal(_gridState.get("37.60/-122.40/200").usingBackup, false);
});

test("fetchTraffic switches to sticky backup after consecutive hard failures", async (t) => {
  _gridState.clear();
  const originalFetch = globalThis.fetch;
  const backupPayload = { ac: [{ hex: "def456" }], now: Date.now() };

  globalThis.fetch = async (url) => {
    if (typeof url === "string" && url.includes("opendata.adsb.fi")) {
      return new Response(JSON.stringify(backupPayload), { status: 200 });
    }
    throw new Error("primary down");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const snapped = { lat: 37.60, lon: -122.40, dist: 200 };
  const gridPath = "/lat/37.60/lon/-122.40/dist/200";

  let result;
  for (let i = 0; i < HARD_FAIL_THRESHOLD; i++) {
    result = await fetchTraffic(gridPath, snapped, {});
    assert.ok(result, `attempt ${i + 1} should still serve backup data`);
    assert.equal(result.source, "backup");
  }

  // After crossing the threshold the grid flips to sticky backup mode.
  assert.equal(_gridState.get("37.60/-122.40/200").usingBackup, true);
});

test("fetchTraffic falls back to backup after invalid payloads", async (t) => {
  _gridState.clear();
  const originalFetch = globalThis.fetch;
  const backupPayload = { ac: [{ hex: "bbb111" }], now: Date.now() };

  globalThis.fetch = async (url) => {
    if (typeof url === "string" && url.includes("opendata.adsb.fi")) {
      return new Response(JSON.stringify(backupPayload), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "bad" }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const snapped = { lat: 10, lon: 20, dist: 50 };
  const gridPath = "/lat/10.00/lon/20.00/dist/50";

  for (let i = 0; i < HARD_FAIL_THRESHOLD - 1; i++) {
    await fetchTraffic(gridPath, snapped, {});
  }

  const result = await fetchTraffic(gridPath, snapped, {});
  assert.ok(result);
  assert.equal(result.source, "backup");
});

test("fetchTraffic falls back to backup after stale primary data", async (t) => {
  _gridState.clear();
  const originalFetch = globalThis.fetch;
  const staleNow = 100000;
  const backupPayload = { ac: [{ hex: "ccc222" }], now: 200000 };

  globalThis.fetch = async (url) => {
    if (typeof url === "string" && url.includes("opendata.adsb.fi")) {
      return new Response(JSON.stringify(backupPayload), { status: 200 });
    }
    return new Response(JSON.stringify({ ac: [{ hex: "aaa111" }], now: staleNow }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const snapped = { lat: 40, lon: -74, dist: 100 };
  const gridPath = "/lat/40.00/lon/-74.00/dist/100";

  const first = await fetchTraffic(gridPath, snapped, {});
  assert.equal(first.source, "primary");

  for (let i = 0; i < STALE_THRESHOLD - 1; i++) {
    const r = await fetchTraffic(gridPath, snapped, {});
    assert.equal(r.source, "primary", `stale attempt ${i + 1} still returns primary`);
  }

  const result = await fetchTraffic(gridPath, snapped, {});
  assert.ok(result);
  assert.equal(result.source, "backup");
});

test("fetchTraffic keeps stale primary data when backup is unavailable", async (t) => {
  _gridState.clear();
  const originalFetch = globalThis.fetch;
  const staleNow = 100000;

  globalThis.fetch = async (url) => {
    if (typeof url === "string" && url.includes("opendata.adsb.fi")) {
      throw new Error("backup down");
    }
    return new Response(JSON.stringify({ ac: [{ hex: "aaa" }], now: staleNow }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const snapped = { lat: 40, lon: -74, dist: 100 };
  const gridPath = "/lat/40.00/lon/-74.00/dist/100";

  await fetchTraffic(gridPath, snapped, {});
  for (let i = 0; i < STALE_THRESHOLD + 2; i++) {
    const r = await fetchTraffic(gridPath, snapped, {});
    assert.equal(r.source, "primary", "should keep returning stale primary without backup");
    assert.equal(r.ac.length, 1);
  }
  assert.equal(_gridState.get("40.00/-74.00/100").usingBackup, false);
});

test("fetchTraffic recovers from backup to primary", async (t) => {
  _gridState.clear();
  const originalFetch = globalThis.fetch;

  const key = "37.60/-122.40/200";
  _gridState.set(key, {
    failCount: 2,
    staleCount: 0,
    lastNow: 1000,
    usingBackup: true,
    lastProbeTs: 0,
  });

  const freshPayload = { ac: [{ hex: "recovered" }], now: 5000 };
  globalThis.fetch = async (url) => {
    if (typeof url === "string" && url.includes("adsb.lol")) {
      return new Response(JSON.stringify(freshPayload), { status: 200 });
    }
    throw new Error("should not reach backup");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await fetchTraffic(
    "/lat/37.60/lon/-122.40/dist/200",
    { lat: 37.60, lon: -122.40, dist: 200 },
    {},
  );
  assert.equal(result.source, "primary");
  assert.equal(result.ac[0].hex, "recovered");

  const state = _gridState.get(key);
  assert.equal(state.usingBackup, false);
  assert.equal(state.failCount, 0);
});

test("fetchTraffic stays on backup when recovery probe fails", async (t) => {
  _gridState.clear();
  const originalFetch = globalThis.fetch;

  const key = "37.60/-122.40/200";
  _gridState.set(key, {
    failCount: 2,
    staleCount: 0,
    lastNow: 1000,
    usingBackup: true,
    lastProbeTs: 0,
  });

  const backupPayload = { ac: [{ hex: "still-backup" }], now: 5000 };
  globalThis.fetch = async (url) => {
    if (typeof url === "string" && url.includes("adsb.lol")) {
      throw new Error("still down");
    }
    return new Response(JSON.stringify(backupPayload), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await fetchTraffic(
    "/lat/37.60/lon/-122.40/dist/200",
    { lat: 37.60, lon: -122.40, dist: 200 },
    {},
  );
  assert.equal(result.source, "backup");
  assert.equal(result.ac[0].hex, "still-backup");
  assert.equal(_gridState.get(key).usingBackup, true);
});

test("fetchTraffic skips recovery probe when interval not elapsed", async (t) => {
  _gridState.clear();
  const originalFetch = globalThis.fetch;

  const key = "37.60/-122.40/200";
  _gridState.set(key, {
    failCount: 2,
    staleCount: 0,
    lastNow: 1000,
    usingBackup: true,
    lastProbeTs: Date.now(),
  });

  let primaryCalled = false;
  const backupPayload = { ac: [{ hex: "backup-only" }], now: 5000 };
  globalThis.fetch = async (url) => {
    if (typeof url === "string" && url.includes("adsb.lol")) {
      primaryCalled = true;
      return new Response(JSON.stringify({ ac: [], now: 9000 }), { status: 200 });
    }
    return new Response(JSON.stringify(backupPayload), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await fetchTraffic(
    "/lat/37.60/lon/-122.40/dist/200",
    { lat: 37.60, lon: -122.40, dist: 200 },
    {},
  );
  assert.equal(primaryCalled, false, "should not probe primary when interval not elapsed");
  assert.equal(result.source, "backup");
});

test("fetchTraffic resets fail count on healthy primary response", async (t) => {
  _gridState.clear();
  const originalFetch = globalThis.fetch;

  const key = "40.00/-74.00/100";
  _gridState.set(key, {
    failCount: 1,
    staleCount: 0,
    lastNow: 0,
    usingBackup: false,
    lastProbeTs: 0,
  });

  const payload = { ac: [{ hex: "healthy" }], now: 5000 };
  globalThis.fetch = async () =>
    new Response(JSON.stringify(payload), { status: 200 });
  t.after(() => { globalThis.fetch = originalFetch; });

  await fetchTraffic(
    "/lat/40.00/lon/-74.00/dist/100",
    { lat: 40, lon: -74, dist: 100 },
    {},
  );

  const state = _gridState.get(key);
  assert.equal(state.failCount, 0);
  assert.equal(state.lastNow, 5000);
});

test("fetchTraffic primary HTTP error counts as hard failure", async (t) => {
  _gridState.clear();
  const originalFetch = globalThis.fetch;
  const backupPayload = { ac: [{ hex: "http-err-backup" }], now: Date.now() };

  globalThis.fetch = async (url) => {
    if (typeof url === "string" && url.includes("opendata.adsb.fi")) {
      return new Response(JSON.stringify(backupPayload), { status: 200 });
    }
    return new Response("rate limited", { status: 429 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const snapped = { lat: 51.5, lon: -0.1, dist: 150 };
  const gridPath = "/lat/51.50/lon/-0.10/dist/150";

  for (let i = 0; i < HARD_FAIL_THRESHOLD - 1; i++) {
    await fetchTraffic(gridPath, snapped, {});
  }

  const result = await fetchTraffic(gridPath, snapped, {});
  assert.ok(result);
  assert.equal(result.source, "backup");
});

test("fetchTraffic stays on backup when recovery probe returns stale data", async (t) => {
  _gridState.clear();
  const originalFetch = globalThis.fetch;

  const key = "37.60/-122.40/200";
  _gridState.set(key, {
    failCount: 2,
    staleCount: 0,
    lastNow: 5000,
    usingBackup: true,
    lastProbeTs: 0,
  });

  const backupPayload = { ac: [{ hex: "bkp999" }], now: 9000 };
  globalThis.fetch = async (url) => {
    if (typeof url === "string" && url.includes("adsb.lol")) {
      return new Response(JSON.stringify({ ac: [{ hex: "stale" }], now: 5000 }), { status: 200 });
    }
    return new Response(JSON.stringify(backupPayload), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await fetchTraffic(
    "/lat/37.60/lon/-122.40/dist/200",
    { lat: 37.60, lon: -122.40, dist: 200 },
    {},
  );
  assert.equal(result.source, "backup");
  assert.equal(result.ac[0].hex, "bkp999");
  assert.equal(_gridState.get(key).usingBackup, true);
});

test("grid state evicts oldest entry when capacity exceeded", async (t) => {
  _gridState.clear();
  const originalFetch = globalThis.fetch;
  const payload = { ac: [], now: Date.now() };

  globalThis.fetch = async () =>
    new Response(JSON.stringify(payload), { status: 200 });
  t.after(() => { globalThis.fetch = originalFetch; });

  for (let i = 0; i < 200; i++) {
    _gridState.set(`pad-${i}`, { failCount: 0, staleCount: 0, lastNow: 0, usingBackup: false, lastProbeTs: 0 });
  }
  assert.equal(_gridState.size, 200);

  await fetchTraffic(
    "/lat/99.00/lon/99.00/dist/25",
    { lat: 99, lon: 99, dist: 25 },
    {},
  );
  assert.ok(_gridState.size <= 200, "grid state should not grow beyond capacity");
  assert.ok(_gridState.has("99.00/99.00/25"), "new key should exist");
  assert.ok(!_gridState.has("pad-0"), "oldest entry should be evicted");
});

test("fetchTraffic returns null when both providers fail and keeps probing primary", async (t) => {
  _gridState.clear();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => { throw new Error("everything is down"); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const snapped = { lat: 37.60, lon: -122.40, dist: 200 };
  const gridPath = "/lat/37.60/lon/-122.40/dist/200";

  let result = null;
  for (let i = 0; i < HARD_FAIL_THRESHOLD; i++) {
    result = await fetchTraffic(gridPath, snapped, {});
  }

  assert.equal(result, null);
  const state = _gridState.get("37.60/-122.40/200");
  assert.equal(state.usingBackup, false);
});

test("fetchAircraftResilient returns primary data on success", async (t) => {
  const originalFetch = globalThis.fetch;
  const payload = { ac: [{ hex: "prim01" }], now: Date.now() };
  let primaryUrl = null;

  globalThis.fetch = async (url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("api.adsb.lol")) {
      primaryUrl = u;
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    throw new Error("backup should not be called on primary success");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await fetchAircraftResilient(37.62, -122.38, 65);
  assert.equal(result.source, "primary");
  assert.equal(result.ac[0].hex, "prim01");
  assert.ok(primaryUrl.includes("/lat/37.6200/lon/-122.3800/dist/65"));
});

test("fetchAircraftResilient falls back to adsb.fi when primary fails", async (t) => {
  const originalFetch = globalThis.fetch;
  const backupPayload = { ac: [{ hex: "bkp01" }], now: Date.now() };
  let backupUrl = null;

  globalThis.fetch = async (url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("opendata.adsb.fi")) {
      backupUrl = u;
      return new Response(JSON.stringify(backupPayload), { status: 200 });
    }
    return new Response("", { status: 502 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await fetchAircraftResilient(51.47, -0.45, 25);
  assert.equal(result.source, "backup");
  assert.equal(result.ac[0].hex, "bkp01");
  assert.ok(backupUrl.includes("/lat/51.47/lon/-0.45/dist/25"));
});

test("fetchAircraftResilient caps the backup radius at 250 NM", async (t) => {
  const originalFetch = globalThis.fetch;
  let backupUrl = null;

  globalThis.fetch = async (url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("opendata.adsb.fi")) {
      backupUrl = u;
      return new Response(JSON.stringify({ ac: [] }), { status: 200 });
    }
    throw new Error("primary down");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await fetchAircraftResilient(40, -74, 9000);
  assert.ok(backupUrl.endsWith("/250"));
});

test("fetchAircraftResilient throws when both providers fail", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 500 });
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(() => fetchAircraftResilient(37.62, -122.38, 65));
});

test("fetchAircraftResilient uses the relay when both direct providers fail", async (t) => {
  const originalFetch = globalThis.fetch;
  let relayUrl = null;
  let relayKey = null;
  globalThis.fetch = async (url, init) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.startsWith("https://relay.test/")) {
      relayUrl = u;
      relayKey = init.headers["X-Relay-Key"];
      return new Response(JSON.stringify({ ac: [{ hex: "rly01" }], now: Date.now() }), { status: 200 });
    }
    return new Response("", { status: u.includes("adsb.fi") ? 403 : 429 });
  };
  configureRelay({ ADSB_RELAY_URL: "https://relay.test/", ADSB_RELAY_KEY: "k1" });
  t.after(() => { globalThis.fetch = originalFetch; configureRelay({}); });

  const result = await fetchAircraftResilient(37.62, -122.38, 65);
  assert.equal(result.ac[0].hex, "rly01");
  assert.equal(relayUrl, "https://relay.test/adsb/lat/37.62/lon/-122.38/dist/65");
  assert.equal(relayKey, "k1");
});

test("configureRelay stays off unless both URL and key are set", async (t) => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response("", { status: 500 });
  };
  configureRelay({ ADSB_RELAY_URL: "https://relay.test" });
  t.after(() => { globalThis.fetch = originalFetch; configureRelay({}); });

  await assert.rejects(() => fetchAircraftResilient(37.62, -122.38, 65));
  assert.ok(seen.every((u) => !u.startsWith("https://relay.test")));
});

test("fetchLookupResilient walks adsb.lol, adsb.fi v2, then the relay", async (t) => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.startsWith("https://relay.test/")) {
      return new Response(JSON.stringify({ ac: [{ hex: "a1b2c3" }], now: 1 }), { status: 200 });
    }
    return new Response("", { status: 429 });
  };
  configureRelay({ ADSB_RELAY_URL: "https://relay.test", ADSB_RELAY_KEY: "k" });
  t.after(() => { globalThis.fetch = originalFetch; configureRelay({}); });

  const result = await fetchLookupResilient("hex", "a1b2c3");
  assert.equal(result.source, "relay");
  assert.deepEqual(seen, [
    "https://api.adsb.lol/v2/hex/a1b2c3",
    "https://opendata.adsb.fi/api/v2/hex/a1b2c3",
    "https://relay.test/adsb/hex/a1b2c3",
  ]);
});

test("fetchLookupResilient returns primary data without touching fallbacks", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ ac: [], now: 1 }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await fetchLookupResilient("callsign", "UAL1");
  assert.equal(result.source, "primary");
  assert.equal(calls, 1);
});

test("fetchAircraftResilient falls through to the relay when the backup returns 200 with an error body", async (t) => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes("api.adsb.lol")) return new Response("", { status: 500 });
    if (u.includes("adsb.fi")) return new Response(JSON.stringify({ error: "rate limited" }), { status: 200 });
    if (u.startsWith("https://relay.test/")) {
      return new Response(JSON.stringify({ ac: [{ hex: "rly02" }], now: Date.now() }), { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  configureRelay({ ADSB_RELAY_URL: "https://relay.test", ADSB_RELAY_KEY: "k" });
  t.after(() => { globalThis.fetch = originalFetch; configureRelay({}); });

  const result = await fetchAircraftResilient(37.62, -122.38, 65);
  assert.equal(result.ac[0].hex, "rly02");
  assert.equal(seen.length, 3, "primary, backup, then relay");
  assert.ok(seen[2].startsWith("https://relay.test/adsb/"));
});

test('v247 provider health: nearby, new grids and lookups skip failing primary until a recovery probe', async (t) => {
  const calls = [];
  let now = 1800000000000, healthy = false;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url));
    if (String(url).includes('adsb.lol') && !healthy) throw new Error('primary down');
    return new Response(JSON.stringify({ ac: [], now }));
  });
  assert.equal((await fetchAircraftResilient(37, -122, 50)).source, 'backup');
  await fetchAircraftResilient(37, -122, 50);
  await fetchAircraftResilient(37, -122, 50);
  calls.length = 0;
  await fetchAircraftResilient(38, -122, 50);
  await fetchTraffic('/lat/39/lon/-122/dist/50', { lat: 39, lon: -122, dist: 50 }, {});
  await fetchLookupResilient('hex', 'abc123');
  assert.ok(calls.length > 0);
  assert.ok(calls.every(url => !url.includes('adsb.lol')), calls.join('\n'));
  healthy = true;
  now += RECOVERY_PROBE_MS + 1;
  assert.equal((await fetchAircraftResilient(37, -122, 50)).source, 'primary');
  assert.equal((await fetchLookupResilient('hex', 'abc123')).source, 'primary');
});

test('v247 provider health: a failed recovery probe renews cooldown; malformed data is failure', async (t) => {
  let now = 1800000000000, primaryCalls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('adsb.lol')) { primaryCalls++; return new Response('{}'); }
    return new Response(JSON.stringify({ ac: [], now }));
  });
  await fetchLookupResilient('hex', 'abc123');
  now += RECOVERY_PROBE_MS + 1;
  await fetchAircraftResilient(37, -122, 50);
  await fetchLookupResilient('callsign', 'UAL3911');
  assert.equal(primaryCalls, 2);
});

test('v247 provider health: only one recovery probe runs while other requests use backup', async (t) => {
  let now = 1800000000000, primaryCalls = 0, resolveProbe;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('adsb.lol')) {
      primaryCalls++;
      if (primaryCalls <= 2) throw new Error('down');
      if (primaryCalls > 3) return new Response(JSON.stringify({ ac: [], now }));
      return new Promise(resolve => { resolveProbe = () => resolve(new Response(JSON.stringify({ ac: [], now }))); });
    }
    return new Response(JSON.stringify({ ac: [], now }));
  });
  await fetchAircraftResilient(37, -122, 50);
  await fetchAircraftResilient(37, -122, 50);
  now += RECOVERY_PROBE_MS + 1;
  const probe = fetchAircraftResilient(37, -122, 50);
  // Allow the async attempt to enter fetch, then a different endpoint must not join that stalled provider.
  await Promise.resolve();
  const fallback = await fetchLookupResilient('hex', 'abc123');
  assert.equal(fallback.source, 'backup');
  assert.equal(primaryCalls, 3);
  resolveProbe();
  assert.equal((await probe).source, 'primary');
});

test('v247 provider health: a working relay bypasses both failed direct feeds during cooldown', async (t) => {
  configureRelay({ ADSB_RELAY_URL: 'https://relay.test', ADSB_RELAY_KEY: 'test' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url));
    if (!String(url).startsWith('https://relay.test')) throw new Error('direct feed down');
    return new Response(JSON.stringify({ ac: [], now: Date.now() }));
  });
  await fetchAircraftResilient(37, -122, 50);
  await fetchAircraftResilient(37, -122, 50);
  calls.length = 0;
  await fetchAircraftResilient(38, -122, 50);
  assert.equal((await fetchLookupResilient('hex', 'abc123')).source, 'relay');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => url.startsWith('https://relay.test')));
});
