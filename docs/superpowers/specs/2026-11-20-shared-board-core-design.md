# Shared airport-board core (2026-11-20)

Status: built on branch `claude/board-core` (draft PR). Pure refactor plus a replay regression suite.

## Problem
The airport board's logic (`buildLiveScheduleData` and helpers in `js/airport-board.js`, plus the snapshot, route and
schedule-match helpers in `js/data.js` and `js/render.js`) read app globals. Three consumers ran it:
- the PWA, natively;
- the Worker `/board`, through `worker/build-board-runtime.mjs`, which wrapped the classic scripts into the committed
  `worker/src/board-runtime.generated.js`;
- the watch page, which loaded the classic scripts behind stub globals in `_watch/shim.js`.

Any board edit had to regenerate the Worker runtime in the same commit. The unattended auto-fixer (w71) had to remember
that rule.

## Design
- **Core.** The board computation lives in `contrails-core.js` ("Airport board" section) as pure functions. They
  receive all state explicitly:
  - the aircraft snapshot and the clock (`now`);
  - runway and airport data;
  - the route cache and evidence memo, and the schedule cache and its TTL;
  - position history and samples;
  - a board-state object (`createAirportBoardState()`: go-around tracks, runway memory, memos).

  Core never reads `Date.now()` or a global. Calls the old code made through `core.X` still go through an injectable
  helper namespace, so tests that swap `core` methods keep working.
- **PWA.** The moved functions in `js/airport-board.js`, `js/data.js` and `js/render.js` are thin adapters. They resolve
  app globals at call time and share one board-state object. The UI and IO code is unchanged.
- **Worker.** `worker/src/board.js` calls core directly with a fresh state per computation, so the board stays a
  stateless snapshot. The generator, the generated runtime and their parity test are deleted. Wrangler bundles core
  like any other import, and CI checks this with a dry run.
- **Watch page.** `_watch/boot.js` no longer loads `js/data.js`, `js/render.js` or `js/airport-board.js`. `feed.js`
  calls core with its own env. `shim.js` keeps only the globals that the watch modules still read.

## Replay regression suite
`node --test scripts/board-replay.test.mjs` runs in CI. Its goldens were generated from the pre-refactor code in a
separate commit, and the refactor reproduces them byte for byte. It replays:
- **Live corpus.** Production Worker `/adsb`, `/schedule`, `/datis` and `/routeset` sequences for SFO, LAX and DEN,
  recorded 2026-11-20, 5 s ticks. Record more with `scripts/board-replay/record.mjs`.
- **Existing fixtures.** The watch-check ticks (`scripts/watch-fixtures.mjs`) and the Worker sp-api capture (SFO, LHR).
- **Past board bugs.** Rebuilt as raw `/adsb` tick sequences on real SFO runway geometry: UA3911 "Departing" at
  touchdown, go-around, touch-and-go (airliner and light aircraft), reciprocal runway.

Each scenario is driven through every consumer's real entry point:
- the PWA classic scripts in a vm;
- the watch page's boot script list plus `Feed.ingest`;
- the Worker's `getBoard`, with a fresh cache per tick and a reverse-order run to prove that it keeps no memory.

## Rule for future board edits
Edit the board in `contrails-core.js` (or the adapters), regenerate `app.bundle.js` as for any PWA change, and run the
replay suite. If a board change is intended, regenerate the goldens with `BOARD_REPLAY_UPDATE=1` in the same commit and
explain the diff. No Worker regeneration step exists any more.
