import test from "node:test";
import assert from "node:assert/strict";

import { buildFlightRow, buildSchedulePayload } from "./fr24.js";

test("buildFlightRow preserves arrival origin metadata", () => {
  const row = buildFlightRow({
    flight: {
      identification: {
        number: { default: "BAW123" },
        callsign: "BAW123",
      },
      status: {
        text: "Landed",
        live: false,
        generic: { status: { color: "green" } },
      },
      aircraft: {
        model: { code: "A320", text: "Airbus A320" },
        registration: "G-ABCD",
      },
      airline: {
        short: "BA",
        name: "British Airways",
        code: { iata: "BA", icao: "BAW" },
      },
      airport: {
        origin: {
          code: { iata: "JFK" },
          name: "New York JFK",
        },
      },
      time: {
        scheduled: { departure: 100, arrival: 200 },
        estimated: { arrival: 210 },
        real: { arrival: 220 },
      },
    },
  }, "arrival");

  assert.equal(row.flight, "BAW123");
  assert.equal(row.callsign, "BAW123");
  assert.equal(row.airline, "BA");
  assert.equal(row.airline_iata, "BA");
  assert.equal(row.airline_icao, "BAW");
  assert.equal(row.ac_code, "A320");
  assert.equal(row.from_iata, "JFK");
  assert.equal(row.from_name, "New York JFK");
  assert.equal(row.est_arr, 210);
  assert.equal(row.actual_arr, 220);
});

test("buildFlightRow defaults airline codes to empty when code object is missing", () => {
  const row = buildFlightRow({
    flight: {
      identification: { number: { default: "RYR456" }, callsign: "RYR456" },
      airline: { short: "Ryanair" },
      status: { text: "En Route" },
    },
  }, "departure");

  assert.equal(row.airline, "Ryanair");
  assert.equal(row.airline_iata, "");
  assert.equal(row.airline_icao, "");
});

test("buildSchedulePayload shapes arrivals and departures from FR24 plugin data", () => {
  const payload = buildSchedulePayload({
    result: {
      response: {
        airport: {
          pluginData: {
            details: { name: "Heathrow" },
            schedule: {
              arrivals: {
                data: [{
                  flight: {
                    identification: { number: { default: "DLH902" }, callsign: "DLH902" },
                    airport: { origin: { code: { iata: "FRA" }, name: "Frankfurt" } },
                    status: { text: "Landed" },
                  },
                }],
              },
              departures: {
                data: [{
                  flight: {
                    identification: { number: { default: "AFR1681" }, callsign: "AFR1681" },
                    airport: { destination: { code: { iata: "CDG" }, name: "Paris CDG" } },
                    status: { text: "Boarding" },
                  },
                }],
              },
            },
          },
        },
      },
    },
  }, "LHR");

  assert.equal(payload.iata, "LHR");
  assert.equal(payload.name, "Heathrow");
  assert.equal(payload.arrivals.length, 1);
  assert.equal(payload.arrivals[0].from_iata, "FRA");
  assert.equal(payload.departures.length, 1);
  assert.equal(payload.departures[0].to_iata, "CDG");
});
