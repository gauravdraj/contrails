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
export function assertBytes(actual, expected, label) {
  if (actual === expected) return;
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
