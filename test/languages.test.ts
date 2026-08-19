import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFor, describeCoverage } from '../src/languages.ts';

test('npm reports every tier as available', () => {
  const caps = capabilitiesFor('npm');
  assert.deepEqual(caps, { inventory: true, registry: true, surface: true, callSites: true });
});

test('an ecosystem with no extractor reports the gap rather than hiding it', () => {
  const caps = capabilitiesFor('PyPI');
  assert.equal(caps.surface, false);
  assert.equal(caps.callSites, false);
});

test('the coverage line names what was not examined, and why', () => {
  // The requirement: a reader must not be able to mistake "not examined" for
  // "examined and clean".
  const line = describeCoverage('PyPI');
  assert.match(line, /not examined/);
  assert.match(line, /PyPI/);
  assert.doesNotMatch(line, /clean|no issues|nothing found/i);
});

test('a fully covered ecosystem says so without hedging', () => {
  assert.doesNotMatch(describeCoverage('npm'), /not examined/);
});
