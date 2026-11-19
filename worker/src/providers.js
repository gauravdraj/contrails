// Live traffic provider failover: primary (adsb.lol) with backup (adsb.fi).
// Both use readsb-compatible payloads so the ac[] shape is identical, and both
// take the same /lat/<lat>/lon/<lon>/dist/<nm> path with a nautical-mile radius.
//
// airplanes.live was the backup until Aug 2026, when it began returning 403 to
// unregistered clients; adsb.fi's open-data v3 API replaced it.

const PRIMARY_API = "https://api.adsb.lol/v2";
const BACKUP_API = "https://opendata.adsb.fi/api/v3";
// adsb.fi only serves hex/callsign lookups on its v2 API (v3 returns 400).
const BACKUP_LOOKUP_API = "https://opendata.adsb.fi/api/v2";

const FETCH_TIMEOUT_MS = 6000;
// FR24 board payloads through the Funnel relay regularly take 3-6s.
const FR24_RELAY_TIMEOUT_MS = 12000;
const HARD_FAIL_THRESHOLD = 2;
const STALE_THRESHOLD = 3;
const RECOVERY_PROBE_MS = 30000;
const STALE_ADVANCE_MS = 2000;
const MAX_GRID_ENTRIES = 200;
// adsb.fi rejects a dist above 250 NM with a 400.
const BACKUP_MAX_RADIUS_NM = 250;

const PROXY_HEADERS = { "User-Agent": "contrails/1.0 (+https://gauravdraj.github.io/contrails/)" };

const gridState = new Map();
// Provider failures apply across locations and endpoints in this isolate. There is no cache-backed
// provider-health state; response caches remain independent. Reserve the recovery probe before awaiting
// it so concurrent requests keep using the working feed while one request tests recovery.
const providerHealth = new Map();

function probeActive(state, now) {
  return state?.probing && now - state.probeAt < 2 * FETCH_TIMEOUT_MS;
}

function providerCooling(name, now) {
  const state = providerHealth.get(name);
  return state && (probeActive(state, now) || state.retryAt > now);
}

// If the entire chain is cooling, reserve its oldest retry for this request. A live probe still owns
// its lease; cancelled Cloudflare requests lose that lease even if their promises never settle.
function oldestCoolingProvider() {
  const names = relay ? ["primary", "backup", "relay"] : ["primary", "backup"];
  const now = Date.now();
  if (!names.every(name => providerCooling(name, now))) return null;
  return names.filter(name => !probeActive(providerHealth.get(name), now))
    .sort((a, b) => providerHealth.get(a).retryAt - providerHealth.get(b).retryAt)[0] || null;
}

async function withProviderHealth(provider, attempt, forced) {
  const state = providerHealth.get(provider);
  const now = Date.now();
  if (state && (probeActive(state, now) || (state.retryAt > now && forced !== provider))) {
    throw new Error(provider + " cooling down");
  }
  const lease = state?.failures >= HARD_FAIL_THRESHOLD ? { ...state, probing: true, probeAt: now } : null;
  if (lease) providerHealth.set(provider, lease);
  try {
    const data = await attempt();
    if (!isValidPayload(data)) throw new Error(provider + " invalid payload");
    if (!lease || providerHealth.get(provider) === lease) providerHealth.delete(provider);
    return data;
  } catch (error) {
    if (!lease || providerHealth.get(provider) === lease) {
      const failures = (providerHealth.get(provider)?.failures || 0) + 1;
      providerHealth.set(provider, { failures, probing: false, probeAt: null,
        retryAt: failures >= HARD_FAIL_THRESHOLD ? Date.now() + RECOVERY_PROBE_MS : 0 });
    }
    throw error;
  }
}

export { providerHealth as _providerHealth };

function gridKey(lat, lon, dist) {
  return lat.toFixed(2) + "/" + lon.toFixed(2) + "/" + dist;
}

function getGridState(key) {
  let s = gridState.get(key);
  if (!s) {
    if (gridState.size >= MAX_GRID_ENTRIES) {
      const oldest = gridState.keys().next().value;
      gridState.delete(oldest);
    }
    s = { failCount: 0, staleCount: 0, lastNow: 0, usingBackup: false, lastProbeTs: 0 };
    gridState.set(key, s);
  }
  return s;
}

async function fetchFromPrimary(gridPath, forced) {
  return withProviderHealth("primary", () => fetchJsonFrom(PRIMARY_API + gridPath, PROXY_HEADERS, "Primary"), forced);
}

export function buildBackupPath(snapped) {
  return buildTrafficPath(snapped.lat, snapped.lon, snapped.dist, 2);
}

function buildTrafficPath(lat, lon, radiusNm, precision) {
  const radius = Math.max(1, Math.min(BACKUP_MAX_RADIUS_NM, Math.ceil(radiusNm)));
  return "/lat/" + lat.toFixed(precision) + "/lon/" + lon.toFixed(precision) + "/dist/" + radius;
}

// Optional last-resort relay on a residential IP. adsb.lol rate-limits (429) and
// adsb.fi rejects (403) Cloudflare's shared egress, so when both direct feeds
// fail the same path is fetched through the relay instead.
let relay = null;

export function configureRelay(env) {
  relay = env && env.ADSB_RELAY_URL && env.ADSB_RELAY_KEY
    ? { url: env.ADSB_RELAY_URL.replace(/\/+$/, ""), key: env.ADSB_RELAY_KEY }
    : null;
}

async function fetchFromRelay(path, forced) {
  return withProviderHealth("relay", () => fetchJsonFrom(relay.url + "/adsb" + path,
    { ...PROXY_HEADERS, "X-Relay-Key": relay.key }, "Relay"), forced);
}

// Fetch an allowlisted FR24 URL through the relay. Returns null when the relay
// is off or unreachable so callers keep their direct-response handling.
export async function fetchFr24ViaRelay(targetUrl) {
  if (!relay) return null;
  try {
    return await fetch(relay.url + "/fr24?u=" + encodeURIComponent(targetUrl), {
      method: "GET",
      headers: { ...PROXY_HEADERS, "X-Relay-Key": relay.key },
      signal: AbortSignal.timeout(FR24_RELAY_TIMEOUT_MS),
    });
  } catch (_) {
    return null;
  }
}

async function fetchFromBackupPath(path, forced) {
  try {
    return await withProviderHealth("backup", () => fetchJsonFrom(BACKUP_API + path, PROXY_HEADERS, "Backup"), forced);
  } catch (err) {
    if (!relay) throw err;
    return fetchFromRelay(path, forced);
  }
}

async function fetchFromBackup(snapped, forced) {
  return fetchFromBackupPath(buildBackupPath(snapped), forced);
}

export function isValidPayload(data) {
  return data != null && typeof data === "object" && Array.isArray(data.ac);
}

export function isFresh(data, state) {
  const now = typeof data.now === "number" ? data.now : 0;
  if (!state.lastNow) return true;
  return now - state.lastNow >= STALE_ADVANCE_MS;
}

export function normalizePayload(data, source) {
  const fallbackNow = Date.now();
  return {
    ac: Array.isArray(data.ac) ? data.ac : [],
    now: data.now || fallbackNow,
    ctime: data.ctime || data.now || fallbackNow,
    source: source,
  };
}

async function tryBackup(snapped, state, forced) {
  try {
    const data = await fetchFromBackup(snapped, forced);
    if (isValidPayload(data)) {
      state.usingBackup = true;
      state.lastProbeTs = Date.now();
      return normalizePayload(data, "backup");
    }
  } catch (_) {}
  return null;
}

// Serve the backup for a single request without flipping the grid into the
// sticky "usingBackup" state. Used to absorb a transient primary blip so a
// single upstream hiccup doesn't surface as a 502.
async function backupOnce(snapped, forced) {
  try {
    const data = await fetchFromBackup(snapped, forced);
    if (isValidPayload(data)) return normalizePayload(data, "backup");
  } catch (_) {}
  return null;
}

// Resilient point lookup (airport / nearby snapshots), sharing provider cooldowns
// with grids and lookups. Tries adsb.lol, then adsb.fi on any failure, and
// throws only when both providers are unusable. radiusNm is passed straight
// through to both providers' radius parameter.
export async function fetchAircraftResilient(lat, lon, radiusNm) {
  const forced = oldestCoolingProvider();
  const primaryPath = "/lat/" + lat.toFixed(4) + "/lon/" + lon.toFixed(4) + "/dist/" + radiusNm;
  try {
    const data = await fetchFromPrimary(primaryPath, forced);
    if (isValidPayload(data)) return normalizePayload(data, "primary");
  } catch (_) {
    // fall through to the backup provider
  }

  const data = await fetchFromBackupPath(buildTrafficPath(lat, lon, radiusNm, 2), forced);
  if (isValidPayload(data)) return normalizePayload(data, "backup");
  throw new Error("Traffic data unavailable");
}

async function fetchJsonFrom(url, headers, label) {
  const resp = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(label + " HTTP " + resp.status);
  return resp.json();
}

// Hex / callsign lookup with the same provider chain as traffic:
// adsb.lol, then adsb.fi, then the relay. kind is "hex" or "callsign".
export async function fetchLookupResilient(kind, value) {
  const forced = oldestCoolingProvider();
  const path = "/" + kind + "/" + encodeURIComponent(value);
  const attempts = [
    () => fetchFromPrimary(path, forced).then((d) => [d, "primary"]),
    () => withProviderHealth("backup", () => fetchJsonFrom(BACKUP_LOOKUP_API + path, PROXY_HEADERS, "Backup"), forced).then((d) => [d, "backup"]),
  ];
  if (relay) {
    attempts.push(() => fetchFromRelay(path, forced)
      .then((d) => [d, "relay"]));
  }
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const [data, source] = await attempt();
      if (isValidPayload(data)) return normalizePayload(data, source);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error("Lookup unavailable" + (lastError ? ": " + lastError.message : ""));
}

export async function fetchTraffic(gridPath, snapped, env) {
  const forced = oldestCoolingProvider();
  const key = gridKey(snapped.lat, snapped.lon, snapped.dist);
  const state = getGridState(key);
  const now = Date.now();
  const hasBackup = true;

  if (state.usingBackup) {
    const primaryHealth = providerHealth.get("primary");
    const expiredProbe = primaryHealth?.probing && !probeActive(primaryHealth, now);
    const backupsCooling = (relay ? ["backup", "relay"] : ["backup"]).every(name => providerCooling(name, now));
    if (forced === "primary" || expiredProbe || backupsCooling || now - state.lastProbeTs >= RECOVERY_PROBE_MS) {
      state.lastProbeTs = now;
      try {
        const data = await fetchFromPrimary(gridPath, forced);
        if (isValidPayload(data) && isFresh(data, state)) {
          state.failCount = 0;
          state.staleCount = 0;
          state.usingBackup = false;
          state.lastNow = typeof data.now === "number" ? data.now : 0;
          return normalizePayload(data, "primary");
        }
      } catch (_) {}
    }
    if (hasBackup) {
      try {
        const data = await fetchFromBackup(snapped, forced);
        if (isValidPayload(data)) return normalizePayload(data, "backup");
      } catch (_) {}
    }
    state.usingBackup = false;
    return null;
  }

  let data = null;
  let primaryOk = false;
  try {
    data = await fetchFromPrimary(gridPath, forced);
    primaryOk = isValidPayload(data);
  } catch (_) {
    primaryOk = false;
  }

  if (!primaryOk) {
    state.failCount++;
    // Once the primary has hard-failed enough times, switch to the backup
    // stickily so we stop paying the primary timeout on every request.
    if (state.failCount >= HARD_FAIL_THRESHOLD && hasBackup) {
      const sticky = await tryBackup(snapped, state, forced);
      if (sticky) return sticky;
      return null;
    }
    // Transient blip: serve the backup for this one request without going
    // sticky, so a single primary failure never becomes a user-visible 502.
    if (hasBackup) return backupOnce(snapped, forced);
    return null;
  }

  if (!isFresh(data, state)) {
    state.staleCount++;
    if (state.staleCount >= STALE_THRESHOLD && hasBackup) {
      const backupResult = await tryBackup(snapped, state, forced);
      if (backupResult) return backupResult;
    }
    return normalizePayload(data, "primary");
  }

  state.failCount = 0;
  state.staleCount = 0;
  state.lastNow = typeof data.now === "number" ? data.now : 0;
  return normalizePayload(data, "primary");
}

export { gridState as _gridState, HARD_FAIL_THRESHOLD, STALE_THRESHOLD, RECOVERY_PROBE_MS };
