// Live traffic provider failover: primary (adsb.lol) with backup (airplanes.live).
// Both use readsb-compatible payloads so the ac[] shape is identical.

const PRIMARY_API = "https://api.adsb.lol/v2";
const BACKUP_API = "https://api.airplanes.live/v2";

const FETCH_TIMEOUT_MS = 6000;
const HARD_FAIL_THRESHOLD = 2;
const STALE_THRESHOLD = 3;
const RECOVERY_PROBE_MS = 30000;
const STALE_ADVANCE_MS = 2000;
const MAX_GRID_ENTRIES = 200;
const KM_PER_NM = 1.852;
const BACKUP_MAX_RADIUS_NM = 250;

const PROXY_HEADERS = { "User-Agent": "contrails/1.0 (+https://gauravdraj.github.io/contrails/)" };

const gridState = new Map();

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

async function fetchFromPrimary(gridPath) {
  const resp = await fetch(PRIMARY_API + gridPath, {
    method: "GET",
    headers: PROXY_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.json();
}

export function buildBackupPath(snapped) {
  const radiusNm = Math.max(1, Math.min(BACKUP_MAX_RADIUS_NM, Math.ceil(snapped.dist / KM_PER_NM)));
  return "/point/" + snapped.lat.toFixed(2) + "/" + snapped.lon.toFixed(2) + "/" + radiusNm;
}

async function fetchFromBackupPath(path) {
  const resp = await fetch(BACKUP_API + path, {
    method: "GET",
    headers: PROXY_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error("Backup HTTP " + resp.status);
  return resp.json();
}

async function fetchFromBackup(snapped) {
  return fetchFromBackupPath(buildBackupPath(snapped));
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

async function tryBackup(snapped, state) {
  try {
    const data = await fetchFromBackup(snapped);
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
async function backupOnce(snapped) {
  try {
    const data = await fetchFromBackup(snapped);
    if (isValidPayload(data)) return normalizePayload(data, "backup");
  } catch (_) {}
  return null;
}

// Resilient point lookup for callers that don't need the grid's sticky failover
// (airport / nearby snapshots). Tries adsb.lol, then airplanes.live on any
// failure, and throws only when both providers are unusable. radiusNm is passed
// straight through to both providers' radius parameter.
export async function fetchAircraftResilient(lat, lon, radiusNm) {
  const primaryPath = "/lat/" + lat.toFixed(4) + "/lon/" + lon.toFixed(4) + "/dist/" + radiusNm;
  try {
    const data = await fetchFromPrimary(primaryPath);
    if (isValidPayload(data)) return normalizePayload(data, "primary");
  } catch (_) {
    // fall through to the backup provider
  }

  const radius = Math.max(1, Math.min(BACKUP_MAX_RADIUS_NM, Math.ceil(radiusNm)));
  const backupPath = "/point/" + lat.toFixed(2) + "/" + lon.toFixed(2) + "/" + radius;
  const data = await fetchFromBackupPath(backupPath);
  if (isValidPayload(data)) return normalizePayload(data, "backup");
  throw new Error("Traffic data unavailable");
}

export async function fetchTraffic(gridPath, snapped, env) {
  const key = gridKey(snapped.lat, snapped.lon, snapped.dist);
  const state = getGridState(key);
  const now = Date.now();
  const hasBackup = true;

  if (state.usingBackup) {
    if (now - state.lastProbeTs >= RECOVERY_PROBE_MS) {
      state.lastProbeTs = now;
      try {
        const data = await fetchFromPrimary(gridPath);
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
        const data = await fetchFromBackup(snapped);
        if (isValidPayload(data)) return normalizePayload(data, "backup");
      } catch (_) {}
    }
    state.usingBackup = false;
    return null;
  }

  let data = null;
  let primaryOk = false;
  try {
    data = await fetchFromPrimary(gridPath);
    primaryOk = isValidPayload(data);
  } catch (_) {
    primaryOk = false;
  }

  if (!primaryOk) {
    state.failCount++;
    // Once the primary has hard-failed enough times, switch to the backup
    // stickily so we stop paying the primary timeout on every request.
    if (state.failCount >= HARD_FAIL_THRESHOLD && hasBackup) {
      const sticky = await tryBackup(snapped, state);
      if (sticky) return sticky;
      return null;
    }
    // Transient blip: serve the backup for this one request without going
    // sticky, so a single primary failure never becomes a user-visible 502.
    if (hasBackup) return backupOnce(snapped);
    return null;
  }

  if (!isFresh(data, state)) {
    state.staleCount++;
    if (state.staleCount >= STALE_THRESHOLD && hasBackup) {
      const backupResult = await tryBackup(snapped, state);
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
