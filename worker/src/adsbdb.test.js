import test from "node:test";
import assert from "node:assert/strict";

import { buildAircraftEntry, buildRouteAirports, buildRouteEntry, normalizeCallsign } from "./adsbdb.js";

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

test("buildAircraftEntry maps ADSBDB airframe fields to a clean entry", () => {
  const entry = buildAircraftEntry("3C6566", {
    type: "A330 343X",
    icao_type: "A333",
    manufacturer: "Airbus",
    mode_s: "3C6566",
    registration: "D-AIKF",
    registered_owner_country_iso_name: "DE",
    registered_owner_country_name: "Germany",
    registered_owner_operator_flag_code: "DLH",
    registered_owner: "Lufthansa",
  });

  assert.deepEqual(entry, {
    hex: "3c6566",
    registration: "D-AIKF",
    type: "A330 343X",
    typeCode: "A333",
    manufacturer: "Airbus",
    operator: "Lufthansa",
    countryIso: "DE",
    countryName: "Germany",
  });
});

test("buildAircraftEntry returns null for unknown / empty airframes", () => {
  assert.equal(buildAircraftEntry("abc123", null), null);
  assert.equal(buildAircraftEntry("abc123", "unknown aircraft"), null);
  assert.equal(buildAircraftEntry("abc123", {}), null);
});

test("buildAircraftEntry keeps partial records with missing fields as null", () => {
  const entry = buildAircraftEntry("A12345", {
    registration: "N12345",
    icao_type: "C172",
  });
  assert.equal(entry.registration, "N12345");
  assert.equal(entry.typeCode, "C172");
  assert.equal(entry.type, null);
  assert.equal(entry.operator, null);
  assert.equal(entry.manufacturer, null);
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
