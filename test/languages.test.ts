import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFor, describeCoverage } from '../src/languages.ts';

test('npm reports every tier as available', () => {
  const caps = capabilitiesFor('npm');
  assert.deepEqual(caps, { inventory: true, registry: true, surface: true, callSites: true });
});

test('an ecosystem with no extractor reports the gap rather than hiding it', () => {
  // Not PyPI: Task 8 registered a Python extractor, so PyPI now clears the
  // surface tier (see pythonsurface.test.ts) and is no longer an example of
  // "nothing claims this ecosystem". crates.io still is, on every tier.
  const caps = capabilitiesFor('crates.io');
  assert.equal(caps.surface, false);
  assert.equal(caps.callSites, false);
});

test('the coverage line names what was not examined, and why', () => {
  // The requirement: a reader must not be able to mistake "not examined" for
  // "examined and clean".
  // Not PyPI: Task 9 registered a Python call-site resolver, so PyPI now
  // clears every tier (see the capabilities test above) and is no longer an
  // example of "something was not examined". crates.io still is, on every tier.
  const line = describeCoverage('crates.io');
  assert.match(line, /not examined/);
  assert.match(line, /crates\.io/);
  assert.doesNotMatch(line, /clean|no issues|nothing found/i);
});

test('a fully covered ecosystem says so without hedging', () => {
  assert.doesNotMatch(describeCoverage('npm'), /not examined/);
});
