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
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: resp.status, text, data };
  } finally {
    clearTimeout(timer);
  }
}

async function check(name, path, validate, init) {
  try {
    const res = await fetchJson(path, init);
    if (res.status !== 200) {
      record(name, false, `HTTP ${res.status}`);
      return null;
    }
    const detail = validate ? validate(res) : "";
    record(name, detail !== false, detail === false ? "unexpected payload" : detail || "ok");
    return res;
  } catch (err) {
    record(name, false, err.name === "AbortError" ? "timeout" : err.message);
    return null;
  }
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

  await check("nearby", `/nearby?lat=${PROBE.lat}&lng=${PROBE.lng}&format=json`, (r) =>
    typeof r.data?.text === "string" ? "text returned" : false
  );

  await check("schedule", `/schedule/${PROBE.iata}`, (r) => (r.data ? "board returned" : false));
  await check("fr24search", `/fr24search/${PROBE.callsign}`, (r) => (r.data ? "search returned" : false));
  await check("airport", `/airport/${PROBE.iata}?format=json`, (r) =>
    r.data?.airport?.iata ? `${r.data.airport.iata} snapshot` : false
  );
  await check("track", `/track/${hex}`, () => `hex ${hex}`);
  await check("aircraft", `/aircraft/${hex}`, (r) =>
    r.data === null ? `no airframe for ${hex} (ok)` : r.data?.registration || r.data?.type ? "airframe returned" : false
  );
  await check(
    "routeset",
    "/routeset",
    (r) => (r.data ? "routes returned" : false),
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

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("Failing: " + failed.map((r) => r.name).join(", "));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Health check crashed:", err);
  process.exit(1);
});
