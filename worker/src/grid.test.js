import test from "node:test";
import assert from "node:assert/strict";

import { snapAdsbGrid } from "./index.js";

test("snaps lat 51.527 to nearest 0.05", () => {
  const { lat } = snapAdsbGrid(51.527, 0, 25);
  assert.equal(parseFloat(lat.toFixed(2)), 51.55);
});

test("snaps lon -0.083 to nearest 0.05", () => {
  const { lon } = snapAdsbGrid(0, -0.083, 25);
  assert.equal(parseFloat(lon.toFixed(2)), -0.1);
});

test("snaps dist 180 up to nearest 25", () => {
  const { dist } = snapAdsbGrid(0, 0, 180);
  assert.equal(dist, 200);
});

test("keeps dist 200 unchanged (exact multiple)", () => {
  const { dist } = snapAdsbGrid(0, 0, 200);
  assert.equal(dist, 200);
});

test("handles negative lat/lon correctly", () => {
  const { lat, lon } = snapAdsbGrid(-33.87, 151.21, 25);
  assert.equal(parseFloat(lat.toFixed(2)), -33.85);
  assert.equal(parseFloat(lon.toFixed(2)), 151.2);
});

test("snaps dist 1 up to minimum grid cell of 25", () => {
  const { dist } = snapAdsbGrid(0, 0, 1);
  assert.equal(dist, 25);
});
