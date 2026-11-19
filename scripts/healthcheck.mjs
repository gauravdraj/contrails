// Live health check for the Contrails Cloudflare Worker endpoints.
//
// Probes every upstream-backed route and verifies it returns usable data, so
// silent provider breakage (e.g. a third party tightening its User-Agent rules
// and returning 403) is caught here instead of by a user noticing missing data.
//
// Usage:
//   node scripts/healthcheck.mjs                 # checks the live worker
//   node scripts/healthcheck.mjs <worker-url>    # checks a custom deployment
//
// Exit code is 0 only when every required check passes, so it can drive CI,
// a cron job, or a soul-pager watcher.

const WORKER_URL = (process.argv[2] || "https://contrails-api.therealgraj.workers.dev").replace(/\/$/, "");
const TIMEOUT_MS = 20000;

// A busy area so /adsb and /nearby reliably return traffic to probe with.
const PROBE = { lat: 51.47, lng: -0.45, iata: "LHR", callsign: "BAW123" };

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? " — " + detail : ""}`);
}

async function fetchJson(path, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(WORKER_URL + path, { ...init, signal: ctrl.signal });
    const text = await resp.text();
    let data = null, validJson = false;
    try {
      data = JSON.parse(text);
      validJson = true;
    } catch {
      data = null;
    }
    return { status: resp.status, text, data, validJson };
  } finally {
    clearTimeout(timer);
  }
}

// Upstream feeds throw sporadic one-off 502s/timeouts, so a failing check is
// retried once after a pause; only a repeat failure is recorded.
const RETRY_DELAY_MS = 10000;

async function attempt(path, validate, init) {
  try {
    const res = await fetchJson(path, init);
    if (res.status !== 200) return { ok: false, detail: `HTTP ${res.status}` };
    if (!res.validJson) return { ok: false, detail: "invalid JSON" };
    const detail = validate ? validate(res) : "";
    if (detail === false) return { ok: false, detail: "unexpected payload" };
    return { ok: true, detail: detail || "ok", res };
  } catch (err) {
    return { ok: false, detail: err.name === "AbortError" ? "timeout" : err.message };
  }
}

async function check(name, path, validate, init) {
  let result = await attempt(path, validate, init);
  if (!result.ok) {
    console.log(`[RETRY] ${name} — ${result.detail}`);
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    result = await attempt(path, validate, init);
  }
  record(name, result.ok, result.detail);
  return result.res || null;
}

// Validate endpoint contracts, not traffic volume: empty arrays and documented null misses are healthy.
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const airportCode = value => typeof value === "string" && /^[A-Z0-9]{3,4}$/.test(value);
const optionalCode = value => value == null || value === "" || airportCode(value);
const identifier = value => typeof value === "string" && /^[A-Za-z0-9 -]{2,12}$/.test(value);
const timestamp = value => value == null || (Number.isFinite(value) && value > 0);

function validateTrack({ data }) {
  if (data === null) return "no trace (ok)";
  if (!Array.isArray(data) || !data.every(pt => Array.isArray(pt) && pt.length >= 5 &&
      Number.isFinite(pt[0]) && pt[0] > 0 && Number.isFinite(pt[1]) && Math.abs(pt[1]) <= 90 &&
      Number.isFinite(pt[2]) && Math.abs(pt[2]) <= 180 && (pt[3] === null || Number.isFinite(pt[3])) &&
      Number.isFinite(pt[4]) && (pt[5] == null || typeof pt[5] === "boolean"))) return false;
  return `${data.length} trace points`;
}

function validateSchedule({ data }) {
  if (!object(data) || !airportCode(data.iata)) return false;
  for (const [list, endpoint] of [[data.arrivals, "from_iata"], [data.departures, "to_iata"]]) {
    if (!Array.isArray(list) || !list.every(row => object(row) && (identifier(row.flight) || identifier(row.callsign)) &&
        optionalCode(row[endpoint]) && ["sched_dep", "sched_arr", "est_dep", "est_arr", "actual_dep", "actual_arr"]
          .every(key => timestamp(row[key])) && (row.live == null || typeof row.live === "boolean"))) return false;
  }
  return `${data.arrivals.length} arrivals, ${data.departures.length} departures`;
}

function validateFr24Search({ data }) {
  if (!object(data) || !Array.isArray(data.results) || !data.results.every(row => object(row) &&
      typeof row.id === "string" && row.id.length > 0 && typeof row.type === "string" && row.type.length > 0 &&
      (row.type !== "live" || (object(row.detail) && optionalCode(row.detail.schd_from) &&
        optionalCode(row.detail.schd_to) && [row.detail.callsign, row.detail.flight, row.detail.reg]
          .every(value => value == null || typeof value === "string"))))) return false;
  return `${data.results.length} search results`;
}

function validateRouteset({ data }) {
  const endpoint = value => value == null || (object(value) && (airportCode(value.iata) ||
    (typeof value.region === "string" && value.region.length > 0 && typeof value.display === "string" && value.display.length > 0)));
  if (!Array.isArray(data) || !data.every(row => object(row) && typeof row.callsign === "string" &&
      /^[A-Za-z0-9]{2,8}$/.test(row.callsign) && (row.origin || row.destination) &&
      endpoint(row.origin) && endpoint(row.destination) && [row.originSource, row.destSource, row.display]
        .every(value => value == null || typeof value === "string"))) return false;
  return `${data.length} routes`;
}

async function run() {
  console.log(`Contrails health check → ${WORKER_URL}\n`);

  await check("geo", "/geo", (r) => (isFinite(r.data?.lat) ? `${r.data.city || "?"} ${r.data.lat},${r.data.lng}` : false));

  const adsb = await check(
    "adsb grid",
    `/adsb/lat/${PROBE.lat.toFixed(4)}/lon/${PROBE.lng.toFixed(4)}/dist/50`,
    (r) => (Array.isArray(r.data?.ac) ? `${r.data.ac.length} aircraft` : false)
  );

  // Pull a live hex so track / photo / routeset probe a real aircraft.
  const hex = adsb?.data?.ac?.find((a) => a.hex)?.hex?.toLowerCase() || "4ca9cc";

  await check("search", `/adsb/hex/${hex}`, (r) => (Array.isArray(r.data?.ac) ? `hex ${hex} via ${r.data.source}` : false));

  await check("nearby", `/nearby?lat=${PROBE.lat}&lng=${PROBE.lng}&format=json`, (r) =>
    typeof r.data?.text === "string" ? "text returned" : false
  );

  await check("schedule", `/schedule/${PROBE.iata}`, validateSchedule);
  await check("fr24search", `/fr24search/${PROBE.callsign}`, validateFr24Search);
  await check("airport", `/airport/${PROBE.iata}?format=json`, (r) =>
    r.data?.airport?.iata ? `${r.data.airport.iata} snapshot` : false
  );
  await check("track", `/track/${hex}`, validateTrack);
  await check("aircraft", `/aircraft/${hex}`, (r) =>
    r.data === null ? `no airframe for ${hex} (ok)` : r.data?.registration || r.data?.type ? "airframe returned" : false
  );
  await check(
    "routeset",
    "/routeset",
    validateRouteset,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planes: [{ hex, callsign: PROBE.callsign }] }),
    }
  );

  // Photo is the canary: a non-200 here usually means the upstream rejected our
  // User-Agent (must include a contact URL) — the exact bug that broke photos.
  await check("photo", `/photo/${hex}`, (r) =>
    r.data === null ? `no photo for ${hex} (ok)` : r.data?.src ? "image returned" : false
  );

  // The residential relay is the Worker's last-resort egress; probe it directly
  // so a dead Pi shows up before both direct feeds happen to fail at once.
  if (process.env.ADSB_RELAY_URL) {
    try {
      const resp = await fetch(process.env.ADSB_RELAY_URL.replace(/\/+$/, "") + "/healthz", {
        signal: AbortSignal.timeout(10000),
      });
      record("relay", resp.ok, resp.ok ? "healthz ok" : `HTTP ${resp.status}`);
    } catch (err) {
      record("relay", false, err.name === "TimeoutError" ? "timeout" : err.message);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("Failing: " + failed.map((r) => r.name).join(", "));
    process.exit(1);
  }
}

// CLI entry point
run().catch((err) => {
  console.error("Health check crashed:", err);
  process.exit(1);
});
