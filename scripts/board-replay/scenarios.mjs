import { readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { TICKS } from '../watch-fixtures.mjs';
import { fixtures } from '../../worker/test-fixtures/sp-api/helpers.js';
import { bugScenarios } from './bug-fixtures.mjs';
const airports = JSON.parse(readFileSync(new URL('../../airports.json', import.meta.url), 'utf8'));
function field(iata) {
  const row = airports.find(a => a[0] === iata);
  return { iata, lat: row[1], lng: row[2], routes: [] };
}
export function scenarios() {
  return [
    ...['SFO', 'LAX', 'DEN'].map(iata => JSON.parse(brotliDecompressSync(
      readFileSync(new URL(`corpus/live-${iata}.json.br`, import.meta.url))))),
    { name: 'watch-fixtures', ...field('SFO'), ticks: TICKS.map(({ nowMs, traffic, schedule, datis }) =>
      ({ at: nowMs, traffic, schedule, datis })) },
    ...['SFO', 'LHR'].map(iata => ({ name: 'sp-api-' + iata, ...field(iata),
      ticks: [{ at: fixtures.epochMs, traffic: fixtures.airports[iata].traffic,
        schedule: fixtures.airports[iata].schedule, datis: fixtures.airports[iata].datis }] })),
    ...bugScenarios,
  ];
}
