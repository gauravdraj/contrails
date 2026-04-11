import test from "node:test";
import assert from "node:assert/strict";

import { buildRouteAirports, buildRouteEntry, normalizeCallsign } from "./adsbdb.js";

test("normalizeCallsign trims and uppercases callsigns", () => {
  assert.equal(normalizeCallsign("  ual123 "), "UAL123");
  assert.equal(normalizeCallsign(""), null);
  assert.equal(normalizeCallsign(null), null);
});

test("buildRouteEntry keeps concise origin and destination details", () => {
  const entry = buildRouteEntry("UAL123", {
    origin: {
      iata_code: "SFO",
      municipality: "San Francisco",
      name: "San Francisco Intl",
    },
    destination: {
      iata_code: "ORD",
      municipality: "Chicago",
      name: "Chicago O'Hare",
    },
    airline: {
      name: "United Airlines",
    },
  });

  assert.deepEqual(entry, {
    callsign: "UAL123",
    origin: {
      iata: "SFO",
      name: "San Francisco",
    },
    destination: {
      iata: "ORD",
      name: "Chicago",
    },
    airline: "United Airlines",
  });
});

test("buildRouteAirports preserves location and coordinates", () => {
  const airports = buildRouteAirports({
    origin: {
      iata_code: "LAX",
      municipality: "Los Angeles",
      latitude: 33.94,
      longitude: -118.4,
    },
    destination: {
      iata_code: "JFK",
      name: "John F Kennedy Intl",
      latitude: 40.64,
      longitude: -73.78,
    },
  });

  assert.deepEqual(airports, [
    {
      iata: "LAX",
      location: "Los Angeles",
      lat: 33.94,
      lon: -118.4,
    },
    {
      iata: "JFK",
      location: "John F Kennedy Intl",
      lat: 40.64,
      lon: -73.78,
    },
  ]);
});
