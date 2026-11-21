/* The board's headless contract. No app UI, map, persistence, or service worker. */
var core = window.ContrailsCore; // app-core.js:1-90, pure core aliases
Object.keys(core).forEach(function (key) {
  if (typeof core[key] === 'function')
    window[key] = core[key];
});
var WORKER_URL = 'https://contrails-api.therealgraj.workers.dev'; // app-core.js:95; deliberately no localhost switch
var FETCH_TIMEOUT_MS = 25000; // app-core.js:196
var REFRESH_MS = 5000; // app-core.js:214, watch's visible polling cadence
var SCHEDULE_CACHE_TTL = 600000; // app-core.js:278; watch's explicit ten-minute policy
var posHistory = {}; // app-core.js:269-277
var extraState = {}; // app-core.js:378
var aircraft = []; // app-core.js:352
var airportData = null; // app-core.js:284-285
var runwayData = null; // app-core.js:284-285
function adsbUrl(path) {
  return WORKER_URL + '/adsb' + path;
} // app-core.js:170
function datisUrl(iata) {
  return WORKER_URL + '/datis/' + encodeURIComponent(iata);
} // app-core.js:173
// app-core.js:197; the timeout also covers response-body consumption.
function fetchWithTimeout(url, options, timeoutMs) {
  var signal = AbortSignal.timeout(timeoutMs || FETCH_TIMEOUT_MS);
  return fetch(
    url,
    Object.assign(
      {},
      options,
      {
        signal: options && options.signal ? AbortSignal.any([signal, options.signal]) : signal
      }
    )
  );
}
// scene.js owns the displayed countdowns; computation state belongs to Feed.
var _airportCountdowns = {};

// Copied verbatim from js/data.js; both feeds take the radius in nautical miles.
function trafficUrl(lat, lng, km) {
  return adsbUrl("/lat/" + lat.toFixed(4) + "/lon/" + lng.toFixed(4) + "/dist/" + Math.ceil(km / 1.852));
}

// Copied verbatim from js/airport-board.js; the cache entry is owned by Feed.
var DATIS_CACHE_TTL = 60 * 1000;


function getCachedDatisActiveRunways(entry) {
  if (!entry || !entry.datisTs) return null;
  return Date.now() - entry.datisTs < DATIS_CACHE_TTL ? entry.datisActiveRunways : null;
}

async function fetchAirportDatisActiveRunways(iata, entry) {
  if (entry && entry.datisTs && Date.now() - entry.datisTs < DATIS_CACHE_TTL) {
    return entry.datisActiveRunways || null;
  }
  try {
    var resp = await fetchWithTimeout(datisUrl(iata));
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    var payload = await resp.json();
    var datisText = payload && (payload.datis || payload.text || payload.raw);
    var parsed = parseDatisActiveRunways(datisText);
    if (parsed) {
      entry.datisActiveRunways = parsed;
      entry.datisTs = Date.now();
      return parsed;
    }
  } catch (err) {
    console.warn("Airport D-ATIS fetch failed:", err);
  }
  entry.datisActiveRunways = null;
  entry.datisTs = Date.now();
  return null;
}
