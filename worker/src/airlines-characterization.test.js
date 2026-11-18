import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import fixture from "./airlines-characterization.json" with { type: "json" };

// Expose the original private helpers without changing production exports. Relative imports still load
// the real module dependencies; this also works against untouched c67a18a sources in the red-test scratch.
async function inspectModule(file, names) {
  const url = new URL(file, import.meta.url);
  const source = (await readFile(url, "utf8")).replace(/from "(\.[^"]+)"/g,
    (_, path) => 'from "' + new URL(path, url).href + '"');
  return import("data:text/javascript;base64," + Buffer.from(source + "\nexport { " + names + " };").toString("base64"));
}

test("airline characterization: all Worker copies preserve the shared fixture", async () => {
  const nearby = await inspectModule("./nearby.js", "nearbyAirlineName, isLikelyPrivate");
  const airport = await inspectModule("./airport.js", "nearbyAirlineName, isLikelyPrivate");
  const routes = await inspectModule("./routes.js", "isLikelyPrivateCallsign");
  for (const original of fixture.cases) {
    const row = { ...original, ...original.regionalFix };
    for (const [name, mod] of Object.entries({ nearby, airport })) {
      assert.deepEqual([mod.nearbyAirlineName(row.callsign), mod.isLikelyPrivate(row.callsign)], row[name], name + ": " + row.callsign);
    }
    assert.equal(routes.isLikelyPrivateCallsign(row.callsign), row.routes, "routes: " + row.callsign);
  }
});


test("regional flights: Worker names and classifiers use the explicit fixture changes", async () => {
  const nearby = await inspectModule("./nearby.js", "nearbyAirlineName, isLikelyPrivate");
  const airport = await inspectModule("./airport.js", "nearbyAirlineName, isLikelyPrivate");
  for (const row of fixture.cases.filter(row => row.regionalFix)) {
    for (const [name, mod] of Object.entries({ nearby, airport })) {
      const expected = row.regionalFix[name] || row[name];
      assert.deepEqual([mod.nearbyAirlineName(row.callsign), mod.isLikelyPrivate(row.callsign)], expected, name + ": " + row.callsign);
    }
  }
});
