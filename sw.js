// Contrails service worker — offline app shell + instant cold starts.
//
// Strategy:
//   - Precache the same-origin app shell so the map launches offline / instantly.
//   - Cache-first (stale-while-revalidate) for the shell, including the vendored map library.
//   - Never cache live data, tiles, or weather radar — those always hit the network.
//   - Cache name is version-scoped; a bumped VERSION invalidates the old shell.
//
// Bump VERSION in lockstep with APP_VERSION in js/app-core.js so a new deploy supersedes
// the cached shell within one launch.

const VERSION = "2.43";
const CACHE = "contrails-" + VERSION;

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.bundle.js",
  "./manifest.json",
  "./airports.json",
  "./runways.json",
  "./contrails-logo-128.webp",
  "./favicon-64.png",
  "./apple-touch-icon.png",
  "./vendor/maplibre-gl-5.24.0/maplibre-gl.js",
  "./vendor/maplibre-gl-5.24.0/maplibre-gl.css",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE_ASSETS);
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

  // Live data, tiles, and radar are all cross-origin and always go straight to the network.
  if (url.origin !== self.location.origin) return;
  // Vendored libraries are pinned by version in their path, so a cached copy never needs refreshing.
  const immutable = url.pathname.includes("/vendor/");

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    if (cached) {
      if (immutable) return cached;
      event.waitUntil(
        fetch(request)
          .then((resp) => { if (resp && resp.ok) cache.put(request, resp.clone()); })
          .catch(() => {}),
      );
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
