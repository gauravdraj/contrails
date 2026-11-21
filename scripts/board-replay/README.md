# Board replay

Run with Node 22 or newer, without dependencies or external requests:

```
node --test scripts/board-replay.test.mjs
TZ=UTC node --test scripts/board-replay.test.mjs
TZ=America/Los_Angeles node --test scripts/board-replay.test.mjs
```

Only phase 1 may regenerate the current-code baseline:

```
BOARD_REPLAY_UPDATE=1 node --test scripts/board-replay.test.mjs
```

Each compressed golden contains the exact JSON.stringify strings for **all three
consumers at every tick**, plus per-tick equality/inequality of their boards. PWA
also includes the selected route-cache fields for its board's flights. Comparisons
use strings, including key and row order; structural inspection is only for error
messages. Failures identify the scenario, consumer, tick, JSON path, SHA-256 pair,
and the first differing byte's surrounding text. Worker ticks also run backwards
with fresh caches to detect request-to-request state leaks.

The public boundaries are PWA snapshot/schedule/board entry points, Watch.Feed.ingest,
and Worker getBoard. The watch script list comes from boot.js; visual modules are
skipped and syncCountdowns is replaced with a pre-countdown capture. PWA aliases
come exclusively from app-core.js bindings. Keep these boundaries when replacing
the internal board engine. No harness import depends on the generated factory.

Live source captures were recorded 2026-11-20, around 17:56 PST. The committed
corpora keep raw indices **4..25 inclusive**, 22 contiguous receive timestamps per
airport, to fit the disk budget with full goldens. Schedule and initial D-ATIS ride
on tick 0; the mid-run D-ATIS rides on tick 20, followed by tick 21. Routes are the
original tick-zero routeset pass and are seeded only into PWA. No traffic rows
are discarded; only unread fields are removed. Schedule rows remain whole.

To reproduce a corpus locally (raw captures are not needed by CI):

```
node scripts/board-replay/record.mjs --from-raw .astra/capture/raw-SFO.json --start-tick 4 --ticks 22
```

Repeat for LAX and DEN. Brotli quality 11 was smaller than gzip level 9 on all three.
The existing 37-tick watch fixture and SFO/LHR API fixtures are imported at test
time. Seven small bug sequences reconstruct the tests named in bug-fixtures.mjs
using real SFO runway geometry, without prescribing expected verdicts.

The recorder's optional `--live IATA LAT LNG --ticks N --out FILE` mode performs
the original production capture request sequence. It is never used by tests and
was not run to build this baseline. Its only wall clock is acquisition time;
replay clocks and randomness are controlled independently in each driver.

The shared-core mutation proof is repeatable:

```
node scripts/board-replay/mutations.mjs
```

It copies a minimal tree to the OS temporary directory, verifies a green baseline,
applies the same five mutations one at a time to `contrails-core.js`, checks for
red consumer tests, then restores with file copies and verifies both scratch and
original sources using cmp. PWA and watch must catch every shared mutation; Worker
must still catch every mutation it caught before the refactor. Logs remain in the
printed temporary directory. The normal replay suite and its goldens are unchanged.
