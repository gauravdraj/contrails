# Contrails

Live aircraft tracker on a dark interactive map. See what's flying near you in real time using ADS-B data.

Open it at **[gauravdraj.github.io/contrails](https://gauravdraj.github.io/contrails/)** — it grabs your location and shows nearby aircraft within 50 km.

## Features

- Real-time ADS-B data from [adsb.lol](https://adsb.lol) with ~3 s refresh
- Altitude-colored plane icons with type-accurate silhouettes (light, turboprop, bizjet, narrowbody, widebody, quad)
- Smooth marker interpolation between updates
- Altitude trails with fade
- Route lookups (origin → destination)
- Airline identification from callsign prefixes
- Private aircraft detection via registration patterns
- Squawk alerts for 7500 / 7600 / 7700
- Airport markers with runway overlays
- FIDS-style arrival/departure boards via FlightRadar24
- Filter toggles: private, ground, trails, airports, labels
- Bottom sheet aircraft list sorted by distance
- Mobile-first dark UI, works well as a home screen shortcut

## Architecture

The frontend is a single `index.html` served via GitHub Pages. A [Cloudflare Worker](worker/) handles API proxying:

| Worker endpoint | Proxies to | Purpose |
|---|---|---|
| `/adsb/*` | api.adsb.lol/v2 | Live aircraft positions |
| `/route/*` | api.adsb.lol/api/0 | Route lookups |
| `/schedule/<IATA>` | FlightRadar24 API | Airport schedule boards (cached 2 min) |

## Local Development

The dev server proxies adsb.lol locally so you can work on the HTML without the worker:

```bash
python3 server.py
# Open http://localhost:8766/?lat=51.5074&lng=-0.1278
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
| `index.html` | The entire app — map, UI, aircraft rendering |
| `server.py` | Local dev server with adsb.lol proxy |
| `airports.json` | Airport positions (IATA, lat, lng, name) |
| `runways.json` | Runway endpoints for overlay lines |
| `worker/` | Cloudflare Worker — API proxy + FR24 schedules |

## Credits

- Aircraft silhouettes adapted from [tar1090](https://github.com/wiedehopf/tar1090) (GPL-3.0)
- Live data from [adsb.lol](https://adsb.lol)
- Map tiles from [CARTO](https://carto.com/)
- Built with [Leaflet](https://leafletjs.com/)
