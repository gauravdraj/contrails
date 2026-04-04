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
- FIDS-style arrival/departure boards (requires local dev server + FlightRadar24 API)
- Filter toggles: private, ground, trails, airports, labels
- Bottom sheet aircraft list sorted by distance
- Mobile-first dark UI, works well as a home screen shortcut

## Usage

### GitHub Pages

Deploy this repo with GitHub Pages (Settings → Pages → Deploy from branch). The map is a single `index.html` that calls the adsb.lol API directly — no build step, no server required.

Pass coordinates via URL params to center the map on a specific location:

```
https://gauravdraj.github.io/contrails/?lat=51.5074&lng=-0.1278
```

Without params it uses your browser's geolocation.

### Local Development

The dev server proxies adsb.lol to avoid CORS issues and optionally serves FR24 schedule data:

```bash
python3 server.py
# Open http://localhost:8766/?lat=51.5074&lng=-0.1278
```

For airport schedule boards, install the optional dependency:

```bash
pip install FlightRadar24
```

## Files

| File | Purpose |
|------|---------|
| `index.html` | The entire app — map, UI, aircraft rendering |
| `server.py` | Dev server with API proxy and optional FR24 schedules |
| `airports.json` | Airport positions (IATA, lat, lng, name) |
| `runways.json` | Runway endpoints for overlay lines |

## Credits

- Aircraft silhouettes adapted from [tar1090](https://github.com/wiedehopf/tar1090) (GPL-3.0)
- Live data from [adsb.lol](https://adsb.lol)
- Map tiles from [CARTO](https://carto.com/)
- Built with [Leaflet](https://leafletjs.com/)
