# contrails Worker API for soul-pager (Track A, step 1)

Status: built on branch `claude/sp-api` (draft PR); not merged. Step 2 (the soul-pager release) consumes this
contract after the Worker is live.
Binding scope: `~/src/contrails-review-2026-11-18/scope-2026-11-19/DECISIONS.md` ("Track A").

## Architecture

The contrails Worker owns all aviation logic. It exposes three REST endpoints and a read-only remote MCP endpoint on
the same origin (`https://contrails-api.therealgraj.workers.dev`). soul-pager adds a URL MCP entry, a keyword row
and a small watcher rule; it implements no aviation logic.

**The board is the PWA's real board code.** Workers forbid `eval`, so `worker/build-board-runtime.mjs` wraps the
unmodified classic scripts (`js/data.js`, `js/render.js`, `js/airport-board.js`, plus the `core.*` globals from
`js/app-core.js`) in an ES-module factory, `worker/src/board-runtime.generated.js` (committed, like
`app.bundle.js`). Each board build makes a fresh runtime, so nothing carries over between requests. A vm parity test
checks that the generated strict module gives the same output as the sloppy-mode scripts.

**Coupling to note:** an edit to any of those four `js/` files must be followed by
`node worker/build-board-runtime.mjs`. CI fails until it is. The regenerated file is under `worker/`, so the merge
redeploys the Worker.

## Endpoints

All JSON responses carry CORS `*`. Times are UTC ISO-8601 or null. Airport codes are checked against `airports.json`.

### `GET /board/:iata?dir=&limit=&size=&types=`
A **stateless snapshot**, labelled `kind: "snapshot"`, with `capabilities: { history: false, goAroundDetection:
false, runwayMemory: false }`. It never claims "no go-around" or a confirmed landing from missing history.
- `recent[]` holds rows on or near the runway. An airborne row there has `state: "over-runway"` and is not landed.
- Inputs:
  - ADS-B traffic, 75 NM, from the shared 3 s grid cache;
  - the airport schedule, from the shared 300 s cache with the existing FR24 backoff;
  - D-ATIS runways, from the shared 60 s cache.
- Route matching is **schedule-first**, using the PWA's own `applyAirportScheduleMatches`. Board generation makes
  **zero FR24 search calls**.
- The whole board is cached 20 s per airport, and concurrent misses coalesce. Filters apply after the cache.
- Response sections:
  - `arrivals[]`: ETA, runway, sequence, delay.
  - `departures[]`: status and runway.
  - `scheduled.{arrivals,departures}[]`: upcoming schedule rows not yet live, so the board can answer "next A380"
    hours ahead.

### `GET /flight/:ident?airport=&eta=`
Returns status, phase, position, schedule times, delay, ETA (`etaSource: board|schedule`), `milestone` and
`watchUrl`.
- With `airport`, resolution is schedule-first and uses no FR24 search.
- Without it, the endpoint makes one cached FR24 search and accepts only an exact flight or callsign match, so
  codeshares are rejected.

### `GET /flight/:ident/watch?airport=&eta=&until=` (text/plain)
One line that changes **only at a milestone**:
```
contrails-watch v1 | UA837 | 1/3 departed | delayed-30
```
- Rungs: `0/3 waiting`, then `1/3 departed`, then `2/3 within-<eta>`, then `3/3 landed`.
- Terminal outcomes are `landed`, `cancelled`, `diverted` and `expired` (once `until` has passed). Each adds a second
  line, `SP-WATCH: done`.
- Every token comes from the URL, the rank or the delay flag: no ETA minutes, times or positions.
- `until` (unix seconds) is required. A missing value, or one more than 48 h ahead, gives 400. `track_flight` mints it
  as (estArr, else schedArr, else now) + 3 h, capped at now + 24 h. Consumers use the URL exactly as given.
- `landed` needs one of two kinds of evidence. It is never inferred from a plane disappearing.
  - A schedule actual arrival.
  - A fresh ADS-B ground report within 6 km of the destination. When the flight's hex or registration is known, the
    report must match it, so a different aircraft on the same callsign can't end the watch.
- If an upstream error could have raised the rank, the endpoint answers **503** `contrails-watch unavailable`, never a
  lower line.
  - Upstream errors include: an incomplete schedule (page 2 failed), error-shaped 200 bodies, and FR24 backoff.
  - Expect runs of 503 lasting a whole schedule-cache or backoff window (up to ~5 min), not single blips.
- The Worker keeps **no milestone memory**: no cache, no isolate state. Non-regression is the consumer's job, using the
  reference fold `foldWatchLines` in `worker/src/flight.js`. The fold keeps the max rank, latches `delayed`, treats
  `done` as terminal, and fires only when the folded state advances.

### `POST /mcp`
A stateless MCP server: JSON-RPC 2.0 over streamable HTTP, no session id.
- Methods: `initialize` (version negotiation over 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05), `ping`,
  `tools/list`, `tools/call`.
- Notifications get 202. `GET` gets 405.
- On any request other than `initialize`, an unsupported `Mcp-Protocol-Version` header gives HTTP 400. Request ids
  must be a string or an integer.
- Media-type checks are deliberately lenient.
- Conformance is proven in CI with the official TypeScript SDK client (1.32.2) plus raw-protocol tests. The
  cursor-agent client has not been tested yet.
- All tools are read-only and return short text plus `structuredContent`:

| Tool | Args | Notes |
|---|---|---|
| `airport_board` | `iata`, `direction?`, `limit?` | snapshot board |
| `flight_status` | `ident`, `airport?` | |
| `planes_nearby` | `lat`, `lng` | rounded to 0.01°; the caller supplies the phone fix |
| `next_big` | `iata`, `direction?`, `types?` | big = widebody or quadjet incl. cargo; named types override |
| `track_flight` | `ident`, `airport?`, `eta_min?` | returns `watch: {url, every: "1m", doneMarker, prompt}`; runs nothing |

## What the soul-pager release (step 2) must do
0. First, smoke-test cursor-agent itself against the deployed `/mcp`: run `initialize` and `tools/list`, then call one
   tool. Do this before writing any soul-pager code.
1. Add a `contrails` URL entry to `~/.cursor/mcp.available.json`:
   `{"url": "https://contrails-api.therealgraj.workers.dev/mcp"}`. This is a deploy step.
2. Add a keyword row in `mcp_select.py`.
3. Add a capability Feature.
4. Gate access: `track_flight` and location-based tools are owner-only. Tenants may get the public read tools.
5. Apply the watcher rules for watches on the contrails host only:
   - **done**: silently disable the watcher after the poll whose body has `SP-WATCH: done`;
   - **non-regression**: apply the fold, and fire only when it advances;
   - **503**: a contrails 503 does not count toward the five-failure disable.
6. Keep at most 3 concurrent flight watches. Add no standing board watches in v1.

## Load
| Path | Upstream cost |
|---|---|
| `/board` | 1 grid fetch (shared 3 s cache), schedule (2 FR24 pages per 300 s, shared with the site), D-ATIS (60 s), zero FR24 searches; the response is cached 20 s |
| watch at 1/min with `airport` | ADS-B lookup (5 s cache) each poll, schedule shared, the destination board only within 120 km; zero FR24 searches |
| `flight_status` without `airport` | 1 FR24 search per ident per 300 s (cached, backoff respected) |
| `planes_nearby` | the existing `/nearby` path: 1 grid fetch, plus route enrichment for up to 5 planes (cached FR24 searches, ADSBDB fallback) |

## Health
New endpoints get contract tests in CI only (`worker/src/*.test.js`, including an official MCP SDK client test).
They are **not** in `scripts/healthcheck.mjs`, because a red scheduled healthcheck triggers the unattended
auto-fixer. Promote them later, with tolerance for an empty board.
