// Phase 1: BOARD_REPLAY_UPDATE=1 node --test scripts/board-replay.test.mjs
// Phase 2 must keep these goldens fixed and reproduce the raw JSON.stringify bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { scenarios } from './board-replay/scenarios.mjs';
import * as drivers from './board-replay/drivers.mjs';
import { compress } from './board-replay/record.mjs';
import { assertBytes, coincidences } from './board-replay/golden.mjs';

const update = process.env.BOARD_REPLAY_UPDATE === '1';
const directory = new URL('./board-replay/goldens/', import.meta.url);
if (update) mkdirSync(directory, { recursive: true });
for (const scenario of scenarios()) {
  await test(scenario.name, async t => {
    const file = new URL(scenario.name + '.json.br', directory);
    const expected = update ? null : JSON.parse(brotliDecompressSync(readFileSync(file)));
    const outputs = {};
    let completed = 0;
    for (const consumer of ['pwa', 'watch', 'worker']) {
      await t.test(consumer, async () => {
        const actual = outputs[consumer] = await drivers[consumer](scenario);
        assert.equal(actual.length, scenario.ticks.length);
        if (consumer === 'worker') {
          const reverse = await drivers.worker(scenario, true);
          for (let i = 0; i < actual.length; i++)
            assertBytes(reverse[i], actual[i], `${scenario.name}/worker reverse tick ${i}`);
        }
        if (!update) {
          assert.equal(expected[consumer].length, actual.length, `${consumer} golden tick count`);
          for (let i = 0; i < actual.length; i++)
            assertBytes(actual[i], expected[consumer][i], `${scenario.name}/${consumer} tick ${i} at ${scenario.ticks[i].at}`);
        }
        completed++;
      });
    }
    await t.test('coincidences', () => {
      const actual = coincidences(outputs);
      if (!update) assertBytes(JSON.stringify(actual), JSON.stringify(expected.coincidences), scenario.name + '/coincidences');
      outputs.coincidences = actual;
    });
    // Full strings for ALL consumers, so every mismatch has a readable first difference.
    if (update) {
      assert.ok(completed === 3 && outputs.coincidences, 'Do not write incomplete goldens');
      writeFileSync(file, compress(outputs));
    }
  });
}
