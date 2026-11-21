# Airport watch page (`_watch/`), design and v1 build

Date: 2026-11-19. Status: v1 built on branch `claude/watch`; it is served tailnet-only from the home server.
Merging needs the owner's OK.

## The ask
"A dedicated visually beautiful page ... select an airport (start with SFO) ... a 2D diagram of where all departing
and arriving planes are in relation, kind of like the ladder view except dedicated, bespoke and beautiful to just
watch."

## Decisions
These are the binding decisions, merged from the Fable and Astra scoping specs.
- **Location: `_watch/` in this repo.**
  - GitHub Pages is a legacy Jekyll build, which never publishes `_`-prefixed directories. That keeps the page off
    the public site with no build change.
  - The real board scripts load unmodified behind `_watch/shim.js`.
  - Astra's separate-project and Node-proxy design was rejected, because the home server has no Node and the shim
    reuse is proven.
- **Data.** The browser polls the Worker directly; CORS is `*`, so no proxy is needed.
  - adsb every 5 s while visible;
  - D-ATIS every 60 s;
  - schedule every 10 min.

  Everything pauses while the page is hidden. There is no routeset, track, photo or nearby call in v1.
- **Look: one composed view.**
  - **Chart.** A north-up plan view with a compressive radial scale (`asinh`), so the runways and the ~50 NM
    approach streams fit one disc. On top of it:
    - stylised runways;
    - a vendored shoreline: US Census TIGER/Line 2023 land faces, dissolved and simplified in the chart's own fisheye
      projection (public domain; no attribution). Natural Earth 10m, used in v1, was blocky at the field (11-20);
    - aircraft darts over a ground shadow lifted by altitude.
  - **Tide strip (the ladder reborn).** Arrivals by minutes to touchdown sit on one side of a "now / runway" line,
    and departures by minutes since liftoff on the other. The same sequence numeral marks the dart and its bead.
  - **Moments:** touchdown, takeoff and go-around.
  - **Palettes:** night "Nocturne" and day "Paper", switched by sun elevation, with a manual override.
  - **Typography:** B612 / B612 Mono (OFL), vendored.
  - **Restraint:** no flashing, no radar sweep, no logos.
  - **Empty sky:** an empty-sky state for 3 a.m.
- **Motion.** `core.interpolatePlaybackPose` runs about 5 s behind real time. Canvas2D, no framework. A pure
  display-list function makes the output testable.
- **Devices.** Laptop and iPad, responsive, with a Fullscreen + wake-lock button. `?airport=SFO`; other airports
  need only data (the shoreline file is optional).
- **Hosting.** On the home server, a user LaunchAgent runs a Python static server on `127.0.0.1:8790`, and
  `tailscale serve --https=8790` publishes it. DECISIONS named `python3 -m http.server`; the build uses
  `_watch/serve.py` instead (see Hosting below).

## What was built
- **Shim and reuse.**
  - `_watch/boot.js` sets `AIRLINES_DATA` and loads, in order: `../contrails-core.js`, `shim.js`, `../js/data.js`,
    `../js/render.js`, `../js/airport-board.js`, then the watch modules.
  - `shim.js` declares only what `js/app-core.js` would: core globals, `WORKER_URL`, the state objects and
    `isPrivate`. Each one cites its app-core line.
  - Classification is the board's own code:
    - `buildAircraftSnapshot`;
    - `applyAirportScheduleMatches`;
    - `buildLiveScheduleData`;
    - countdown and sequence, done the way `syncAirportCountdowns` does them but on display time, so 0:00 coincides
      with the dart at the threshold.
- **Feed (`feed.js`).**
  - Maintains `posHistory` (the data.js tuple) and `extraState[hex].samples`.
  - Dedupes by feed report time, so a cached repeat adds no samples.
  - Clock offset via `core.updateClockOffset`.
  - Backs off with `core.trafficRetryDelayMs`, keeps one request in flight per feed, and shows an outage dot.
- **Rendering.**
  - `scene.js`: board rows become one cast with roles, plus a presentation-only "departed" set.
  - `project.js`: pure projection.
  - `display.js`: pure `buildDisplayList`, with text width injected.
  - `moments.js`, `paint.js`: two canvases, a static one and a dynamic one.
  - `theme.js`, `kiosk.js`: theme switching, plus fullscreen, wake lock, idle fade, burn-in drift and `?fps=30`.
- **URL parameters.** `?airport=SFO`, `?theme=night|day|auto`, `?fps=30`, and `?test=1`, which makes the harness
  drive time.

## Tests (`node scripts/watch-check.mjs`, in CI)
- **Board parity.** Over 37 fixture ticks, including one byte-identical repeat, the page's board rows equal a
  reference. The reference is the unmodified core, `data.js`, `render.js` and `airport-board.js` in a Node vm, with
  its own history upkeep and the board's own `syncAirportCountdowns`. Compared fields: tab, runway, runwayAssumed,
  sequence, status, goAround. Scenario assertions:
  - the parallel pair;
  - the OAK arrival is excluded;
  - the go-around;
  - touchdown;
  - takeoff;
  - holding, rolling and taxi-in.
- **Display-list snapshot.** Taken in Node at three fixed times, with deterministic text widths, so Linux fonts can't
  change it.
- **Headless Chrome against fixtures.** No real Worker is contacted. It checks:
  - zero console errors and zero unexpected requests;
  - land, water, runway and arrival pixel samples;
  - labels stay inside the frame and don't overlap, at 5 viewports;
  - moments appear and expire;
  - the empty-sky state;
  - outage and recovery (simulated by an in-page fetch rejection, so every scenario asserts zero log errors);
  - pause while hidden.
- **Budgets.**
  - Gated in CI: first-load transfer ≤ 400 kB, as the real bytes `_watch/serve.py` sends for the browser's
    cold-load request list (about 204 kB).
  - Gated in `--perf`, local on Metal:
    - scene rebuild p95 ≤ 10 ms with a representative 300-aircraft mix, as the median of 3 fresh pages (3.2 ms on
      M4);
    - frame-script p95 ≤ 4 ms (3.9 ms) and no long tasks.

    CI still measures the rebuild time and reports it, but doesn't gate on it. Shared runners measured the same
    commit at 5.9 ms and 11.2 ms, so a wall-clock threshold there only flakes. This amends the pre-declared rubric.
- **Public-site guard.** The diff against `live/main` stays within an allowlist, and existing app, core, Worker and
  relay files are byte-identical.
- **Modes:** `--perf`, `--shots DIR`, `--live --shots DIR` (for humans, never in CI) and `--update-snapshot`.

## Hosting
`scripts/deploy-watch-homeserver.sh [deploy [REF] | status | undo]`. It needs no sudo.
- **Deploy.**
  1. A `git archive` of ONLY the files the page loads. The PWA's `index.html` and `sw.js` are left out, so the app's
     service worker can never control `/_watch/`.
  2. rsync to `~/contrails-watch/`.
  3. The LaunchAgent `tech.gauravraj.contrails-watch` runs `/usr/bin/python3 _watch/serve.py --bind 127.0.0.1
     8790`. It is a 70-line stdlib `http.server` subclass, used instead of `-m http.server` because
     `tailscale serve` does not compress: it gzips text (about 570 kB becomes about 204 kB), sends `no-cache`, lists
     no directories, confines paths to the export and logs nothing per request.
  4. `tailscale serve --bg --https=8790`.
- **Safety.** A preflight runs before any change. It refuses if `:8790` is served by anything other than its own
  proxy, and it fails closed if the serve config can't be read. It never runs `serve reset`.
- **Undo.** Runs `serve --https=8790 off` (only if the handler is its own), `bootout`, and moves the export
  aside.

URL: `https://home-server.tail7af116.ts.net:8790/_watch/?airport=SFO`.

## Known residuals (from review round 2, non-blocking)
- One missed poll forgets an observed liftoff time. The departure bead then shows `EST` placement.
- Returning to the tab while an aborted schedule request is still settling can postpone the schedule refresh by up
  to 10 minutes. Traffic is unaffected.
- `_watch/scene.js` re-implements `syncAirportCountdowns` on display time. Board parity in CI guards it; a shared
  clock-parameterised helper belongs with the "lift the board" item below.
- The parallel-pair assertion runs on the reference side only. The watch side renders the pair, but nothing asserts
  it.

## Deferred
- **Lifting the board.** Move `buildLiveScheduleData` into core as a pure function shared by the board and the watch
  page. Until then, a rename in `airport-board.js` breaks the page; parity in CI catches it.
- **Data and modes.**
  - `/routeset` origins for non-scheduled traffic;
  - an airport picker UI;
  - other airports' shorelines;
  - taxiways and gates;
  - alternate modes (Orrery, Funnel);
  - sound;
  - a quiet-hours poll slowdown;
  - a recorder/replay proxy;
  - tap-for-details.
