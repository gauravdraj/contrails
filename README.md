# Contrails

Live aircraft tracker on a dark interactive map. Browse what is flying in the current map view in real time using ADS-B data.

Open it at **[gauravdraj.github.io/contrails](https://gauravdraj.github.io/contrails/)**. The site uses your location when available, falls back to an approximate network area when precise location is unavailable, and also supports entering coordinates manually or picking a reference point on the map.

## Features

- Viewport-based aircraft browsing with ~3 s refresh
- Altitude-colored plane icons with type-accurate silhouettes (light, turboprop, bizjet, narrowbody, widebody, quad)
- Smooth marker interpolation between updates
- Seeded and live altitude trails with fade
- Route lookups when the current view is zoomed in enough
- Airline identification from callsign prefixes
- Private aircraft detection via registration patterns
- Squawk alerts for 7500 / 7600 / 7700
- Airport markers with runway overlays whenever they are in view
- FIDS-style arrival/departure boards via FlightRadar24
- Filter toggles: private, ground, trails, labels
- Dock-based planes list sorted by distance to the current reference point
- Approximate IP-based fallback area when browser geolocation is unavailable
- Mobile-first dark UI that also works well as a home screen shortcut

## Architecture

The app stays GitHub Pages-friendly:

- `index.html` handles the UI shell, Leaflet map, and browser-side rendering.
- `contrails-core.js` contains shared pure helpers for viewport policy, geometry, and parsing.
- A [Cloudflare Worker](worker/) handles API proxying.

| Worker endpoint | Proxies to | Purpose |
|---|---|---|
| `/adsb/*` | api.adsb.lol/v2 | Live aircraft positions |
| `/route/*` | api.adsb.lol/api/0 | Route lookups |
| `/geo` | Cloudflare request geodata | Approximate initial map area |
| `/schedule/<IATA>` | FlightRadar24 API | Airport schedule boards (cached 2 min) |
| `/nearby?lat=&lng=` | api.adsb.lol/v2 + route API | Siri plane spotter (text/plain) |

## Local Development

The local dev server serves the app and proxies live ADS-B, route, and schedule lookups. It also returns a fixed default browse area for `/api/geo` so the non-location fallback path can be exercised locally:

```bash
python3 server.py
# Open http://localhost:8766/?lat=51.5074&lng=-0.1278
```

If you omit `lat` and `lng`, the page will try browser geolocation first and then show fallback browse options if location is unavailable.

## Verification

Run the lightweight checks with Node:

```bash
node --test contrails-core.test.js
node smoke-boot.mjs
```

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
   3.2 km ↑73° SE — 4,200 ft, descending

2. Ryanair 1234 (B738)
   Dublin → Barcelona
   12.4 km ↑29° NW — 35,000 ft, level — likely contrail

https://gauravdraj.github.io/contrails/?lat=51.5074&lng=-0.1278&zoom=11
```

## Deploying the Worker

Requires a free [Cloudflare](https://dash.cloudflare.com/sign-up) account and Node.js:

```bash
cd worker
npx wrangler deploy
```

Then set the `WORKER_URL` constant in `index.html` to your worker's URL.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Main app shell, map, and UI |
| `contrails-core.js` | Shared pure helpers used by the app and tests |
| `contrails-core.test.js` | Unit tests for shared helper logic |
| `smoke-boot.mjs` | Local smoke check for page boot with fixed coordinates |
| `server.py` | Local dev server with ADS-B, route, and schedule proxying |
| `airports.json` | Airport positions (IATA, lat, lng, name) |
| `runways.json` | Runway endpoints for overlay lines |
| `worker/` | Cloudflare Worker — API proxy + FR24 schedules |

## Credits

- Aircraft silhouettes adapted from [tar1090](https://github.com/wiedehopf/tar1090) (GPL-3.0)
- Live data from [adsb.lol](https://adsb.lol)
- Map tiles from [CARTO](https://carto.com/)
- Built with [Leaflet](https://leafletjs.com/)
