// Phase-1 proof only: create a scratch tree, mutate ONE line, rebuild the scratch
// Worker artifact, replay, restore with copies, and verify scratch AND real sources
// with cmp. No git commands, no source writes in the working tree, no network.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'board-replay-mutations-'));
const tree = join(scratch, 'repo'), backup = join(scratch, 'backup');
for (const file of ['contrails-core.js', 'airlines.json', 'airports.json', 'runways.json', 'js',
  '_watch/boot.js', '_watch/shim.js', '_watch/feed.js', 'worker/package.json', 'worker/src',
  'worker/build-board-runtime.mjs', 'worker/test-fixtures/sp-api', 'scripts/watch-fixtures.mjs',
  'scripts/board-replay', 'scripts/board-replay.test.mjs']) {
  mkdirSync(dirname(join(tree, file)), { recursive: true });
  cpSync(join(root, file), join(tree, file), { recursive: true });
}
const changedFiles = ['js/airport-board.js', 'js/data.js', 'worker/src/board-runtime.generated.js'];
for (const file of changedFiles) {
  mkdirSync(dirname(join(backup, file)), { recursive: true });
  copyFileSync(join(tree, file), join(backup, file));
}
const mutations = [
  ['a-arm', 'js/airport-board.js', 'a.altFt - fieldElev > 3000', 'a.altFt - fieldElev > 300'],
  ['b-departing', 'js/airport-board.js', ' && !approaching)', ')'],
  ['c-taxi-in', 'js/airport-board.js', 'if (taxDist > 6)', 'if (taxDist > 0.6)'],
  ['d-schedule', 'js/airport-board.js', 'if (match && applyScheduleMatch(a, match))', 'if (false && applyScheduleMatch(a, match))'],
  ['e-seen', 'js/data.js', 's.seen > 15', 's.seen > 5'],
];
const env = { ...process.env, BOARD_REPLAY_UPDATE: '0' };
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: tree, env, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { ...result, log: result.stdout + result.stderr };
}
function restore() {
  for (const file of changedFiles) {
    copyFileSync(join(backup, file), join(tree, file));
    for (const target of [join(tree, file), join(root, file)]) {
      const result = spawnSync('cmp', [join(backup, file), target], { encoding: 'utf8' });
      assert.equal(result.status, 0, `cmp failed: ${target}: ${result.stderr}`);
    }
  }
}
console.log('Scratch logs: ' + scratch);
const baseline = run(['--test', '--test-reporter=tap', 'scripts/board-replay.test.mjs']);
writeFileSync(join(scratch, 'baseline.log'), baseline.log);
assert.equal(baseline.status, 0, baseline.log);
console.log('baseline: ' + baseline.log.split('\n').filter(s => /^# (tests|pass|fail|duration_ms) /.test(s)).join('; '));
try {
  for (const [name, file, from, to] of mutations) {
    const path = join(tree, file), source = readFileSync(path, 'utf8');
    assert.equal(source.split(from).length, 2, name + ': mutation must hit exactly once');
    writeFileSync(path, source.replace(from, to));
    const build = run(['worker/build-board-runtime.mjs']);
    assert.equal(build.status, 0, build.log);
    const result = run(['--test', '--test-reporter=tap', 'scripts/board-replay.test.mjs']);
    writeFileSync(join(scratch, name + '.log'), result.log);
    assert.equal(result.status, 1, name + ': mutation SURVIVED (or test runner crashed)\n' + result.log);
    const caught = ['pwa', 'watch', 'worker'].filter(consumer =>
      new RegExp('^    not ok \\d+ - ' + consumer + '$', 'm').test(result.log));
    assert.ok(caught.length, name + ': no consumer caught mutation');
    console.log(`${name}: caught ${caught.join(', ')}; ` + result.log.split('\n')
      .filter(s => /^# (tests|pass|fail|duration_ms) /.test(s)).join('; '));
    console.log(result.log.split('\n').find(s => /tick \d+ at .*expected/.test(s))?.trim() || 'See log for first difference');
    restore();
    console.log(name + ': cmp scratch + original sources: identical');
  }
} finally { restore(); }
const final = run(['--test', '--test-reporter=tap', 'scripts/board-replay.test.mjs']);
writeFileSync(join(scratch, 'restored.log'), final.log);
assert.equal(final.status, 0, final.log);
console.log('restored: ' + final.log.split('\n').filter(s => /^# (tests|pass|fail|duration_ms) /.test(s)).join('; '));
