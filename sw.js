// Contrails service worker — offline app shell + instant cold starts.
//
// Strategy:
//   - Precache the same-origin app shell so the map launches offline / instantly.
//   - Cache-first (stale-while-revalidate) for the shell and immutable CDN libs.
//   - Never cache live data, tiles, or weather radar — those always hit the network.
//   - Cache name is version-scoped; a bumped VERSION invalidates the old shell.
//
// Bump VERSION in lockstep with APP_VERSION in js/app-core.js so a new deploy supersedes
// the cached shell within one launch.

const VERSION = "2.35";
const CACHE = "contrails-" + VERSION;

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./js/app-core.js",
  "./js/map.js",
  "./js/features.js",
  "./js/data.js",
  "./js/render.js",
  "./js/geolocation.js",
  "./js/airport-board.js",
  "./js/controls.js",
  "./js/boot.js",
  "./contrails-core.js",
  "./manifest.json",
  "./airports.json",
  "./runways.json",
  "./contrails-logo-128.webp",
  "./favicon-64.png",
  "./apple-touch-icon.png",
];

// Immutable, version-pinned CDN libraries worth keeping for offline launches.
const CDN_ASSETS = [
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/leaflet-doubletapdrag@0.1.2/Leaflet.DoubleTapDrag.js",
  "https://unpkg.com/leaflet-doubletapdragzoom@0.3.2/Leaflet.DoubleTapDragZoom.js",
  "https://unpkg.com/@luomus/leaflet-smooth-wheel-zoom@1.0.0/SmoothWheelZoom.js",
  "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css",
  "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js",
  "https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.4/leaflet-maplibre-gl.js",
];

// Live data / heavy tile sets — always straight to network, never cached here.
const BYPASS_HOSTS = new Set([
  "contrails-api.therealgraj.workers.dev",
  "basemaps.cartocdn.com",
  "a.basemaps.cartocdn.com",
  "b.basemaps.cartocdn.com",
  "c.basemaps.cartocdn.com",
  "d.basemaps.cartocdn.com",
  "mesonet.agron.iastate.edu",
  "tilecache.rainviewer.com",
  "api.rainviewer.com",
]);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE_ASSETS);
    // CDN assets are best-effort: don't fail the install if unpkg is unreachable.
    await Promise.allSettled(CDN_ASSETS.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key.startsWith("contrails-") && key !== CACHE).map((key) => caches.delete(key)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }

  if (BYPASS_HOSTS.has(url.hostname)) return;

  // App launches: serve the cached shell instantly, refresh it in the background.
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match("./index.html");
      const network = fetch(request)
        .then((resp) => {
          if (resp && resp.ok) cache.put("./index.html", resp.clone());
          return resp;
        })
        .catch(() => null);
      return cached || (await network) || Response.error();
    })());
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const isPinnedCdn = url.hostname === "unpkg.com";
  if (!sameOrigin && !isPinnedCdn) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    if (cached) {
      if (sameOrigin) {
        event.waitUntil(
          fetch(request)
            .then((resp) => { if (resp && resp.ok) cache.put(request, resp.clone()); })
            .catch(() => {}),
        );
      }
      return cached;
    }
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok) cache.put(request, fresh.clone());
      return fresh;
    } catch (_) {
      return Response.error();
    }
  })());
});
