import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBackupPath,
  isValidPayload,
  isFresh,
  normalizePayload,
  fetchTraffic,
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

test("buildBackupPath converts kilometers to capped nautical miles", () => {
  assert.equal(
    buildBackupPath({ lat: 37.6, lon: -122.4, dist: 200 }),
    "/point/37.60/-122.40/108",
  );
  assert.equal(
    buildBackupPath({ lat: 37.6, lon: -122.4, dist: 500 }),
    "/point/37.60/-122.40/250",
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

test("fetchTraffic returns null on single primary failure before backup threshold", async (t) => {
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

test("fetchTraffic falls back to backup after consecutive hard failures", async (t) => {
  _gridState.clear();
  const originalFetch = globalThis.fetch;
  const backupPayload = { ac: [{ hex: "def456" }], now: Date.now() };

  globalThis.fetch = async (url) => {
    if (typeof url === "string" && url.includes("api.airplanes.live")) {
      return new Response(JSON.stringify(backupPayload), { status: 200 });
    }
    throw new Error("primary down");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const snapped = { lat: 37.60, lon: -122.40, dist: 200 };
  const gridPath = "/lat/37.60/lon/-122.40/dist/200";

  for (let i = 0; i < HARD_FAIL_THRESHOLD - 1; i++) {
    const r = await fetchTraffic(gridPath, snapped, {});
    assert.equal(r, null, `attempt ${i + 1} before threshold should be null`);
  }

  const result = await fetchTraffic(gridPath, snapped, {});
  assert.ok(result);
  assert.equal(result.source, "backup");
  assert.equal(result.ac[0].hex, "def456");
});

test("fetchTraffic falls back to backup after invalid payloads", async (t) => {
  _gridState.clear();
  const originalFetch = globalThis.fetch;
  const backupPayload = { ac: [{ hex: "bbb111" }], now: Date.now() };

  globalThis.fetch = async (url) => {
    if (typeof url === "string" && url.includes("api.airplanes.live")) {
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
    if (typeof url === "string" && url.includes("api.airplanes.live")) {
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
    if (typeof url === "string" && url.includes("api.airplanes.live")) {
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
    if (typeof url === "string" && url.includes("api.airplanes.live")) {
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
