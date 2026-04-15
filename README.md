# Contrails

[![CI](https://github.com/gauravdraj/contrails/actions/workflows/ci.yml/badge.svg)](https://github.com/gauravdraj/contrails/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<p align="center">
  <img src="contrails-logo.png" alt="Contrails logo" width="120">
</p>

Live aircraft tracker on a dark interactive map. Browse what is flying in the current map view in real time using ADS-B data.

Contrails is built for the "what plane is that?" moment: open the map, see what is overhead in the current view, jump to a flight quickly, and share a direct link back to a specific aircraft.

Open it at **[gauravdraj.github.io/contrails](https://gauravdraj.github.io/contrails/)**. The site uses your location when available, falls back to an approximate network area when precise location is unavailable, and also supports entering coordinates manually.

## Highlights

### Tracking
- Viewport-based aircraft browsing with ~5 s refresh
- Smooth marker interpolation between updates
- Seeded and live altitude trails with fade
- Altitude-colored plane icons with type-accurate silhouettes (light, turboprop, bizjet, narrowbody, widebody, quad)
- Route lookups when the current view is zoomed in enough
- Airport markers with runway overlays whenever they are in view
- FIDS-style arrival/departure boards via FlightRadar24
- Airline identification from callsign prefixes, private-aircraft heuristics, and squawk alerts for 7500 / 7600 / 7700

### Search and Sharing
- Exact search by flight, airline code alias, or ICAO hex
- Shareable plane links that reopen and refocus the live map
- Filter toggles: private, ground, trails, labels

### Mobile UX
- Mobile-first dark UI that also works well as a home screen shortcut
- Approximate IP-based fallback area when browser geolocation is unavailable
- Manual coordinate entry when you want to browse somewhere else

## iPhone Home Screen

For the best iPhone experience, install Contrails from Safari:

1. Open **[gauravdraj.github.io/contrails](https://gauravdraj.github.io/contrails/)** in Safari.
2. Tap **Share**.
3. Tap **Add to Home Screen**.
4. Launch Contrails from the Home Screen for the true edge-to-edge view.

The normal Safari tab keeps browser chrome visible, so the Home Screen launch is the version that feels most app-like.

## Architecture

The app stays GitHub Pages-friendly. The static frontend lives at the repo root, while a small Cloudflare Worker handles API proxying, caching, and third-party lookups that should not happen directly in the browser:

- `index.html` handles the UI shell, styles, and HTML structure.
- `app.js` contains all browser-side application logic (map setup, data fetching, rendering).
- `contrails-core.js` contains shared pure helpers for viewport policy, geometry, airline lookups, and HTML escaping.
- A [Cloudflare Worker](worker/) handles API proxying, with the nearby, FR24, ADSBDB, and HTTP response helpers split into focused modules under `worker/src/`.

| Worker endpoint | Proxies to | Purpose |
|---|---|---|
| `GET /adsb/*` | adsb.lol (primary) / airplanes.live (backup) | Live aircraft positions with per-grid failover |
| `GET,POST /route/*` | api.adsb.lol/api/0 | Route lookups |
| `POST /routeset` | ADSBDB + OpenSky | Batch route + track lookup for up to 20 planes |
| `GET /track/<hex>` | OpenSky Network | Full flight track path |
| `GET /schedule/<IATA>` | FlightRadar24 API | Airport schedule boards (cached 5 min) |
| `GET /fr24search/<query>` | FlightRadar24 API | Flight search by callsign |
| `GET /airport/<IATA>` | api.adsb.lol/v2 | Airport-centered traffic snapshot |
| `GET /nearby?lat=&lng=` | api.adsb.lol/v2 + route API | Siri plane spotter (text, json, or html) |
| `GET /photo/<hex>` | Planespotters API | Aircraft photo lookup (cached 24 h) |
| `GET /geo` | Cloudflare request geodata | Approximate initial map area |

## Local Development

The local dev server serves the app and proxies live ADS-B, route, and schedule lookups. It also returns a fixed default browse area for `/api/geo` so the non-location fallback path can be exercised locally:

```bash
python3 server.py
# Open http://localhost:8766/?lat=51.5074&lng=-0.1278
```

If you omit `lat` and `lng`, the page will try browser geolocation first and then show fallback browse options if location is unavailable.

## Verification

These checks run automatically via GitHub Actions on every push and pull request. To run them locally:

```bash
node --test contrails-core.test.js
node --test worker/src/*.test.js
node smoke-boot.mjs
```

Manual iPhone checks:

- Compare the normal Safari tab against the Home Screen launch.
- Verify the Home Screen icon/title look right.
- Check portrait and landscape on a notched iPhone.
- Focus the coordinate inputs and confirm Safari no longer zooms the page.

## Siri Shortcut: "What Plane Is That?"

The Worker exposes a `/nearby` endpoint that returns a plain-text list of aircraft near a given location, sorted by 3D slant distance (line-of-sight, factoring in altitude). It includes airline names, routes, landing/departing context, elevation angles, contrail likelihood, and squawk alerts.

Create a Shortcut named **"What Plane Is That"** with three actions:

| # | Action | Configuration |
|---|--------|---------------|
| 1 | **Get Current Location** | (no config needed) |
| 2 | **Get Contents of URL** | `https://contrails-api.<account>.workers.dev/nearby?lat=[Latitude]&lng=[Longitude]` — insert the Location variables from step 1 |
| 3 | **Show Result** | (shows the text inline; the map link at the bottom is tappable) |

Example output:

```
2 aircraft nearby:

1. British Airways 456 (A320) [G-EUPH]
   Landing at Heathrow — from New York JFK
   2 mi ↑73° SE — 4,200 ft, descending

2. Ryanair 1234 (B738)
   Dublin → Barcelona
   7.7 mi ↑29° NW — 35,000 ft, level — likely contrail

https://gauravdraj.github.io/contrails/?lat=51.5074&lng=-0.1278&zoom=11
```

## Deploying the Worker

Requires a free [Cloudflare](https://dash.cloudflare.com/sign-up) account and Node.js:

```bash
cd worker
npm install
npx wrangler deploy
```

Then set the `WORKER_URL` constant in `app.js` to your worker's URL.

## OpenSky Track Proxy (optional)

Track data comes from [OpenSky Network](https://opensky-network.org/), which rate-limits aggressively and blocks many cloud IPs. The Worker tries OpenSky directly for batch route lookups, but for reliable individual track fetches the app supports an optional self-hosted proxy.

The `local-proxy/` directory contains a small Node.js server and a setup script for deploying it on a Raspberry Pi (or any always-on box) behind a Cloudflare Tunnel:

```bash
cd local-proxy
# Follow setup-pi.sh to install the proxy, create a tunnel, and get a public URL
```

Once running, set `OPENSKY_PROXY` in `app.js` to your proxy's URL. The proxy handles its own rate-limit backoff and serves stale-while-revalidate cached tracks.

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell, styles, and HTML structure |
| `app.js` | Browser application logic (map, rendering, data fetching) |
| `contrails-core.js` | Shared pure helpers (geometry, policy, airlines, escaping) used by the app and tests |
| `contrails-core.test.js` | Unit tests for shared helper logic |
| `smoke-boot.mjs` | Local smoke check for page boot with fixed coordinates |
| `server.py` | Local dev server with ADS-B, route, and schedule proxying |
| `airports.json` | Airport positions (IATA, lat, lng, name) |
| `runways.json` | Runway endpoints for overlay lines |
| `worker/src/index.js` | Cloudflare Worker entrypoint and route wiring |
| `worker/src/providers.js` | Traffic failover: adsb.lol primary, airplanes.live backup |
| `worker/src/opensky.js` | OpenSky track fetching, route merging, phase detection |
| `worker/src/enrich.js` | Route enrichment from track + ADSBDB data |
| `worker/src/nearby.js` | Siri nearby-aircraft endpoint and formatting |
| `worker/src/airport.js` | Airport-centered traffic endpoint |
| `worker/src/adsbdb.js` | Shared ADSBDB route lookup helpers |
| `worker/src/fr24.js` | FlightRadar24 schedule shaping helpers |
| `worker/src/fr24-backoff.js` | FR24 rate-limit backoff and cached search |
| `worker/src/regions.js` | Geographic region classification |
| `worker/src/http.js` | Shared Worker response/CORS helpers |
| `worker/src/geo.js` | Haversine, bearing, and cardinal helpers for the worker |
| `worker/src/airports.js` | Major airport list for landing heuristics in `/nearby` |
| `local-proxy/server.js` | Self-hosted OpenSky track proxy with rate-limit backoff |
| `local-proxy/setup-pi.sh` | Raspberry Pi deployment script (systemd + Cloudflare Tunnel) |

## Credits

- Aircraft silhouettes adapted from [tar1090](https://github.com/wiedehopf/tar1090) (GPL-3.0)
- Live data from [adsb.lol](https://adsb.lol), backup feed from [airplanes.live](https://airplanes.live)
- Track data from [OpenSky Network](https://opensky-network.org/)
- Map tiles from [CARTO](https://carto.com/)
- Built with [Leaflet](https://leafletjs.com/)
