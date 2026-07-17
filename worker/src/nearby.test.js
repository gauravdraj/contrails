import test from "node:test";
import assert from "node:assert/strict";

import handler from "./index.js";
import { __nearbyTest } from "./nearby.js";

test("nearby JSON includes structured plane data for widgets", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;

  globalThis.caches = undefined;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /api\.adsb\.lol\/v2\/lat\/37\.6200\/lon\/-122\.3800\/dist\/25/);
    return new Response(JSON.stringify({
      ac: [{
        hex: "aabbcc",
        flight: "UAL238 ",
        t: "A320",
        r: "N123UA",
        lat: 37.63,
        lon: -122.39,
        alt_baro: 8700,
        gs: 240,
        baro_rate: -500,
        track: 140,
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  });

  const response = await handler.fetch(
    new Request("https://worker.test/nearby?lat=37.62&lng=-122.38&format=json"),
    {},
    { waitUntil: () => {} },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.anyAircraftDetected, true);
  assert.equal(body.mapUrl, "https://gauravdraj.github.io/contrails/?lat=37.62&lng=-122.38&zoom=12");
  assert.equal(body.planes.length, 1);
  assert.equal(body.planes[0].name, "United 238");
  assert.equal(body.planes[0].icao24, "aabbcc");
  assert.equal(body.planes[0].type, "A320");
  assert.equal(body.planes[0].registration, "N123UA");
  assert.equal(body.planes[0].altitude, "8.7k ft");
  assert.equal(body.planes[0].vertical, "descending");
  assert.match(body.planes[0].detail, /8\.7k ft/);
  assert.match(body.text, /United 238 \(A320\) \[N123UA\]/);
});

test("nearby falls back to airplanes.live when adsb.lol fails", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;

  globalThis.caches = undefined;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("api.adsb.lol")) return new Response("", { status: 502 });
    if (u.includes("api.airplanes.live")) {
      assert.match(u, /api\.airplanes\.live\/v2\/point\/37\.62\/-122\.38\/25/);
      return new Response(JSON.stringify({
        ac: [{
          hex: "aabbcc",
          flight: "UAL238 ",
          t: "A320",
          r: "N123UA",
          lat: 37.63,
          lon: -122.39,
          alt_baro: 8700,
          gs: 240,
          baro_rate: -500,
          track: 140,
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  });

  const response = await handler.fetch(
    new Request("https://worker.test/nearby?lat=37.62&lng=-122.38&format=json"),
    {},
    { waitUntil: () => {} },
  );

  assert.equal(response.status, 200, "should recover via backup instead of 502");
  const body = await response.json();
  assert.equal(body.anyAircraftDetected, true);
  assert.equal(body.planes[0].icao24, "aabbcc");
});

test("nearby JSON includes empty planes array when no aircraft are visible", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;

  globalThis.caches = undefined;
  globalThis.fetch = async () => new Response(JSON.stringify({ ac: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  });

  const response = await handler.fetch(
    new Request("https://worker.test/nearby?lat=37.62&lng=-122.38&format=json"),
    {},
    { waitUntil: () => {} },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.anyAircraftDetected, false);
  assert.deepEqual(body.planes, []);
  assert.equal(body.text, "No aircraft detected nearby.");
  assert.match(body.mapUrl, /zoom=11$/);
});

test("nearby display exposes photo-friendly identifiers", () => {
  const summary = __nearbyTest.buildNearbyDisplay(1, {
    callsign: "BAW456",
    icao24: "abc123",
    type: "B772",
    registration: "G-YMMN",
    lat: 51.5,
    lng: -0.1,
    altFt: 35000,
    speedKts: 470,
    vRate: 0,
    squawk: null,
    track: 270,
    slantKm: 12.4,
    elevDeg: 38,
    cardinal: "W",
    vertical: "level",
    priv: false,
    airline: "British Airways",
  }, { display: "London Heathrow -> New York JFK" });

  assert.equal(summary.plane.name, "British Airways 456");
  assert.equal(summary.plane.icao24, "abc123");
  assert.equal(summary.plane.registration, "G-YMMN");
  assert.equal(summary.plane.contrailLikely, true);
  assert.equal(summary.plane.routeLine, "London Heathrow -> New York JFK");
  assert.match(summary.text, /British Airways 456 \(B772\) \[G-YMMN\]/);
});
