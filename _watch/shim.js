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
var routeCache = {}; // app-core.js:269-277
var scheduleDataCache = {}; // app-core.js:269-277
var extraState = {}; // app-core.js:378
var aircraft = []; // app-core.js:352
var airportData = null; // app-core.js:284-285
var runwayData = null; // app-core.js:284-285
var feedClockOffsetMs = null; // app-core.js:367
function isPrivate(callsign, type, category) {
  return core.isPrivateAircraft(callsign, type, category);
} // app-core.js:415
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
// _airportElevIndex, active-runway memory and countdowns are owned by the real board, not duplicated here.
