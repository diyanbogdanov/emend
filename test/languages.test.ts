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
  //
  // The analysed count passed here is irrelevant to this case (a missing tier
  // is a capability fact, not an observation) and is 0 only because that is
  // the simplest value to pass.
  const line = describeCoverage('crates.io', 0);
  assert.match(line, /not examined/);
  assert.match(line, /crates\.io/);
  assert.doesNotMatch(line, /clean|no issues|nothing found/i);
});

test('a fully covered ecosystem with packages examined names the count, not a blanket claim', () => {
  const line = describeCoverage('npm', 5);
  assert.doesNotMatch(line, /not examined/);
  assert.match(line, /\b5\b/);
  assert.match(line, /all ran/);
});

test('a fully covered ecosystem with nothing examined does not claim any tier ran', () => {
  // The defect this pins: every tier being *registered* is not the same claim
  // as this scan having *run* them on something. A repository whose
  // dependencies were all unresolved ranges used to hit "fully examined ...
  // all ran" having analysed zero packages — this is the case that must not
  // recur, on an ecosystem (npm) where every tier genuinely is registered.
  const line = describeCoverage('npm', 0);
  assert.doesNotMatch(line, /fully examined/);
  assert.doesNotMatch(line, /all ran/);
  assert.match(line, /no dependencies were analysed/);
});
