import test from "node:test";
import assert from "node:assert/strict";

import { enrichRoutes, resetEnrichBackoff, ICAO_TO_IATA } from "./enrich.js";

function makeFR24Response(callsign, from, to) {
  return new Response(JSON.stringify({
    results: [{
      type: "live",
      detail: { callsign, flight: callsign, schd_from: from, schd_to: to },
    }],
  }), { status: 200 });
}

function makeADSBDBResponse(origin, destination) {
  return new Response(JSON.stringify({
    response: {
      flightroute: {
        origin: { iata_code: origin, municipality: origin },
        destination: { iata_code: destination, municipality: destination },
      },
    },
  }), { status: 200 });
}

function mockCtx() {
  return { waitUntil: () => {} };
}

test("FR24 cache hit returns route without calling fetch", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;

  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return new Response("", { status: 500 }); };
  globalThis.caches = {
    default: {
      match: async (req) => {
        const url = typeof req === "string" ? req : req.url;
        if (url.includes("fr24-enrich-cache/UAL123")) {
          return new Response(JSON.stringify({
            origin: { iata: "SFO", name: "SFO" },
            destination: { iata: "LAX", name: "LAX" },
          }));
        }
        return null;
      },
      put: async () => {},
    },
  };

  t.after(() => {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
    resetEnrichBackoff();
  });

  const planes = [{ callsign: "UAL123", altFt: 35000, vRate: 0, ground: false }];
  const routeMap = await enrichRoutes(planes, {}, mockCtx());
  assert.ok(routeMap["UAL123"]);
  assert.equal(routeMap["UAL123"].origin.iata, "SFO");
  assert.equal(routeMap["UAL123"].destination.iata, "LAX");
  assert.equal(fetchCalled, false);
});

test("FR24 search success populates route and caches result", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;

  let cachePutKey = null;
  globalThis.caches = {
    default: {
      match: async () => null,
      put: async (req) => { cachePutKey = typeof req === "string" ? req : req.url; },
    },
  };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("flightradar24.com")) return makeFR24Response("DAL456", "ATL", "JFK");
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };

  t.after(() => {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
    resetEnrichBackoff();
  });

  const planes = [{ callsign: "DAL456", altFt: 30000, vRate: 0, ground: false }];
  const routeMap = await enrichRoutes(planes, {}, mockCtx());
  const entry = routeMap["DAL456"];
  assert.ok(entry);
  assert.equal(entry.origin.iata, "ATL");
  assert.equal(entry.destination.iata, "JFK");
  assert.equal(typeof entry.phase, "string");
  assert.ok(entry.display.length > 0);
  assert.ok(cachePutKey && cachePutKey.includes("fr24-enrich-cache/DAL456"));
});

test("IATA variant used in FR24 query for SWA callsign", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;

  let capturedUrl = null;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("flightradar24.com")) {
      capturedUrl = urlStr;
      return makeFR24Response("WN1087", "DAL", "HOU");
    }
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };

  t.after(() => {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
    resetEnrichBackoff();
  });

  const planes = [{ callsign: "SWA1087", altFt: 25000, vRate: 0, ground: false }];
  await enrichRoutes(planes, {}, mockCtx());
  assert.ok(capturedUrl);
  assert.ok(capturedUrl.includes("WN1087"), `Expected WN1087 in URL but got: ${capturedUrl}`);
  assert.ok(!capturedUrl.includes("SWA1087"), `Should not contain SWA1087: ${capturedUrl}`);
});

test("FR24 miss falls back to ADSBDB", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;

  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("flightradar24.com")) {
      return new Response(JSON.stringify({ results: [{ type: "schedule", detail: {} }] }), { status: 200 });
    }
    if (urlStr.includes("adsbdb.com")) return makeADSBDBResponse("ORD", "DEN");
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };

  t.after(() => {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
    resetEnrichBackoff();
  });

  const planes = [{ callsign: "UAL789", altFt: 35000, vRate: 0, ground: false }];
  const routeMap = await enrichRoutes(planes, {}, mockCtx());
  const entry = routeMap["UAL789"];
  assert.ok(entry);
  assert.equal(entry.origin.iata, "ORD");
  assert.equal(entry.destination.iata, "DEN");
});

test("FR24 rate limit triggers backoff — second call skips FR24", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;

  let fr24FetchCount = 0;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("flightradar24.com")) {
      fr24FetchCount++;
      return new Response("", { status: 429 });
    }
    if (urlStr.includes("adsbdb.com")) return makeADSBDBResponse("BOS", "MIA");
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };

  t.after(() => {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
    resetEnrichBackoff();
  });

  await enrichRoutes(
    [{ callsign: "AAL100", altFt: 30000, vRate: 0, ground: false }],
    {}, mockCtx(),
  );
  assert.equal(fr24FetchCount, 1);

  fr24FetchCount = 0;
  await enrichRoutes(
    [{ callsign: "AAL200", altFt: 30000, vRate: 0, ground: false }],
    {}, mockCtx(),
  );
  assert.equal(fr24FetchCount, 0, "second call should skip FR24 due to backoff");
});

test("FR24 network error falls back to ADSBDB", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;

  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("flightradar24.com")) throw new Error("network failure");
    if (urlStr.includes("adsbdb.com")) return makeADSBDBResponse("SEA", "PDX");
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };

  t.after(() => {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
    resetEnrichBackoff();
  });

  const planes = [{ callsign: "ASA300", altFt: 15000, vRate: -500, ground: false }];
  const routeMap = await enrichRoutes(planes, {}, mockCtx());
  const entry = routeMap["ASA300"];
  assert.ok(entry);
  assert.equal(entry.origin.iata, "SEA");
  assert.equal(entry.destination.iata, "PDX");
});

test("both FR24 and ADSBDB miss — callsign absent from routeMap", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;

  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("flightradar24.com")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (urlStr.includes("adsbdb.com")) {
      return new Response(JSON.stringify({ response: {} }), { status: 200 });
    }
    return new Response("", { status: 500 });
  };

  t.after(() => {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
    resetEnrichBackoff();
  });

  const planes = [{ callsign: "XYZ999", altFt: 35000, vRate: 0, ground: false }];
  const routeMap = await enrichRoutes(planes, {}, mockCtx());
  assert.equal("XYZ999" in routeMap, false);
});

test("private planes are skipped — no fetches made", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;

  let fetchCalled = false;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async () => { fetchCalled = true; return new Response("", { status: 500 }); };

  t.after(() => {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
    resetEnrichBackoff();
  });

  const planes = [
    { callsign: "N12345", altFt: 8000, vRate: 0, ground: false, priv: true },
    { callsign: "N67890", altFt: 5000, vRate: -500, ground: false, priv: true },
  ];
  const routeMap = await enrichRoutes(planes, {}, mockCtx());
  assert.deepEqual(Object.keys(routeMap), []);
  assert.equal(fetchCalled, false);
});

test("planes with null callsign are skipped", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;

  let fetchCalled = false;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async () => { fetchCalled = true; return new Response("", { status: 500 }); };

  t.after(() => {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
    resetEnrichBackoff();
  });

  const planes = [
    { callsign: null, altFt: 10000, vRate: 0, ground: false },
    { callsign: "", altFt: 5000, vRate: 0, ground: false },
  ];
  const routeMap = await enrichRoutes(planes, {}, mockCtx());
  assert.deepEqual(Object.keys(routeMap), []);
  assert.equal(fetchCalled, false);
});

test("empty planes array returns empty routeMap", async (t) => {
  t.after(() => resetEnrichBackoff());
  const routeMap = await enrichRoutes([], {}, mockCtx());
  assert.deepEqual(Object.keys(routeMap), []);
});

test("ICAO_TO_IATA map covers major airlines", () => {
  assert.equal(ICAO_TO_IATA.SWA, "WN");
  assert.equal(ICAO_TO_IATA.UAL, "UA");
  assert.equal(ICAO_TO_IATA.DAL, "DL");
  assert.equal(ICAO_TO_IATA.AAL, "AA");
  assert.equal(ICAO_TO_IATA.JBU, "B6");
  assert.equal(ICAO_TO_IATA.NKS, "NK");
  assert.equal(ICAO_TO_IATA.ASA, "AS");
});

test("detectPhase and formatRouteLabel produce phase and display fields", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;

  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("flightradar24.com")) return makeFR24Response("UAL500", "EWR", "SFO");
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };

  t.after(() => {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
    resetEnrichBackoff();
  });

  const planes = [{ callsign: "UAL500", altFt: 3000, vRate: -800, ground: false }];
  const routeMap = await enrichRoutes(planes, {}, mockCtx());
  const entry = routeMap["UAL500"];
  assert.ok(entry);
  assert.equal(typeof entry.phase, "string");
  assert.ok(entry.phase.length > 0);
  assert.equal(typeof entry.display, "string");
  assert.ok(entry.display.length > 0);
});

test("FR24 403 triggers backoff same as 429", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;

  let fr24FetchCount = 0;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("flightradar24.com")) {
      fr24FetchCount++;
      return new Response("", { status: 403 });
    }
    if (urlStr.includes("adsbdb.com")) return makeADSBDBResponse("LAX", "SFO");
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };

  t.after(() => {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
    resetEnrichBackoff();
  });

  await enrichRoutes(
    [{ callsign: "NKS100", altFt: 30000, vRate: 0, ground: false }],
    {}, mockCtx(),
  );
  assert.equal(fr24FetchCount, 1);

  fr24FetchCount = 0;
  await enrichRoutes(
    [{ callsign: "NKS200", altFt: 30000, vRate: 0, ground: false }],
    {}, mockCtx(),
  );
  assert.equal(fr24FetchCount, 0, "FR24 should be skipped after 403 backoff");
});

test("callsign is trimmed and uppercased for routeMap key", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;

  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("flightradar24.com")) return makeFR24Response("UAL999", "DEN", "ORD");
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };

  t.after(() => {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
    resetEnrichBackoff();
  });

  const planes = [{ callsign: "  ual999  ", altFt: 35000, vRate: 0, ground: false }];
  const routeMap = await enrichRoutes(planes, {}, mockCtx());
  assert.ok(routeMap["UAL999"]);
  assert.equal(routeMap["UAL999"].origin.iata, "DEN");
});
