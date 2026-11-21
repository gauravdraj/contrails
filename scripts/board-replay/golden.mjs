import { createHash } from 'node:crypto';

const short = value => {
  const s = value === undefined ? '<missing>' : JSON.stringify(value);
  return s.length > 240 ? s.slice(0, 240) + '…' : s;
};
function difference(expected, actual, path = '$') {
  if (Object.is(expected, actual)) return null;
  if (!expected || !actual || typeof expected !== 'object' || typeof actual !== 'object')
    return `${path}: expected ${short(expected)}, actual ${short(actual)}`;
  const ek = Object.keys(expected), ak = Object.keys(actual);
  for (let i = 0; i < Math.max(ek.length, ak.length); i++) {
    if (ek[i] !== ak[i]) return `${path}: key/order expected ${short(ek[i])}, actual ${short(ak[i])}`;
    const key = ek[i];
    const diff = difference(expected[key], actual[key], path + (Array.isArray(expected) ? `[${key}]` : '.' + key));
    if (diff) return diff;
  }
  return null;
}
// Goldens were generated on Node 24. V8's Math.sin/cos/atan2 can differ from older majors in the last bits, so under
// another major (CI runs Node 22) numbers may differ by a few ulps: compare structure and key order exactly and numbers
// to a 1e-9 relative tolerance there. On the generating major the comparison stays byte-for-byte.
export const GOLDEN_NODE_MAJOR = 24;
const strict = Number(process.versions.node.split('.')[0]) === GOLDEN_NODE_MAJOR;
function close(expected, actual) {
  if (typeof expected === 'number' && typeof actual === 'number')
    return Object.is(expected, actual) || Math.abs(expected - actual) <= 1e-9 * Math.max(1, Math.abs(expected), Math.abs(actual));
  if (!expected || !actual || typeof expected !== 'object' || typeof actual !== 'object') return Object.is(expected, actual);
  const ek = Object.keys(expected), ak = Object.keys(actual);
  return ek.length === ak.length && Array.isArray(expected) === Array.isArray(actual) &&
    ek.every((key, i) => key === ak[i] && close(expected[key], actual[key]));
}
export function assertBytes(actual, expected, label) {
  if (actual === expected) return;
  if (!strict && typeof actual === 'string' && typeof expected === 'string' && close(JSON.parse(expected), JSON.parse(actual))) return;
  if (typeof actual !== 'string' || typeof expected !== 'string')
    throw new Error(`${label}: missing JSON bytes; expected ${short(expected)}, actual ${short(actual)}`);
  let at = 0;
  while (at < Math.min(actual.length, expected.length) && actual[at] === expected[at]) at++;
  const hash = s => createHash('sha256').update(s).digest('hex');
  throw new Error(`${label}: ${difference(JSON.parse(expected), JSON.parse(actual)) || 'JSON encoding/order differs'}\n`
    + `SHA-256 expected ${hash(expected)}, actual ${hash(actual)}\n`
    + `first byte difference ${Buffer.byteLength(actual.slice(0, at))}\n`
    + `expected …${expected.slice(Math.max(0, at - 70), at + 170)}\nactual   …${actual.slice(Math.max(0, at - 70), at + 170)}`);
}

// PWA's route-cache envelope is extra output; only its board can coincide with
// another consumer's board. Record both equality and inequality at every tick.
export function coincidences(outputs) {
  const pwaBoards = outputs.pwa.map(s => JSON.stringify(JSON.parse(s).board));
  return Object.fromEntries([
    ['pwa.board=watch', pwaBoards, outputs.watch],
    ['pwa.board=worker', pwaBoards, outputs.worker],
    ['watch=worker', outputs.watch, outputs.worker],
  ].map(([key, left, right]) => [key, left.map((s, i) => s === right[i])]));
}
