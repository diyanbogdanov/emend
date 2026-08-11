import test from 'node:test';
import { needsSourceRepair } from '../src/fix.ts';
import assert from 'node:assert/strict';
import { detectorsFor, groupByDetector } from '../src/detectors.ts';
import type { Finding } from '../src/types.ts';

function finding(detector: string, severity: Finding['change']['severity'] = 'breaking'): Finding {
  return {
    id: `${detector}-1`,
    detector,
    pkg: 'thing',
    fromVersion: 'a',
    toVersion: 'b',
    change: { path: 'x', kind: 'removed', severity, confidence: 'high', before: 'a', after: null },
    sites: [{ file: 'src/a.ts', line: 1, column: 1, text: '', via: 'import' }],
    confidence: 'high',
  };
}

// ---------------------------------------------------------------------------
// Which detectors run
// ---------------------------------------------------------------------------

test('the contract detector is off unless a resolver is supplied', () => {
  // It is the only detector that reaches the network. A scan that quietly began
  // making outbound requests to every host in someone's source tree is not a
  // thing to switch on for them, so the resolver has to be handed over
  // deliberately.
  const ids = detectorsFor({}).map((d) => d.id);
  assert.deepEqual(ids, ['version-pin']);
});

test('supplying a resolver turns it on', () => {
  const ids = detectorsFor({ contracts: { resolve: async () => [] } }).map((d) => d.id);
  assert.deepEqual(ids.sort(), ['http-contract', 'version-pin']);
});

// ---------------------------------------------------------------------------
// How findings reach the report
// ---------------------------------------------------------------------------

test('findings are grouped by the detector that produced them', () => {
  // They were all filed under "version pins", which was true when there was one
  // detector and became a lie the moment there were two. A reader seeing a
  // vanished Stripe endpoint listed under version pins learns the wrong thing
  // about where to look.
  const groups = groupByDetector([
    finding('version-pin', 'drift'),
    finding('http-contract'),
    finding('http-contract'),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.pkg, g.findings.length]),
    [
      ['version pins', 1],
      ['http contracts', 2],
    ],
  );
});

test('an unknown detector is labelled by its own id rather than mislabelled', () => {
  // A new detector that nobody remembered to name here should say what it is,
  // not borrow the name of an unrelated one.
  const groups = groupByDetector([finding('freshness')]);
  assert.equal(groups[0]?.pkg, 'freshness');
});

test('no findings means no group, rather than an empty heading', () => {
  assert.deepEqual(groupByDetector([]), []);
});

test('a group carries no version pair, because a detector finding is not an upgrade', () => {
  const group = groupByDetector([finding('http-contract')])[0];
  assert.equal(group?.fromVersion, null);
  assert.equal(group?.toVersion, null);
});

// ---------------------------------------------------------------------------
// Routing a finding to something that can repair it
// ---------------------------------------------------------------------------

test('a wire-contract finding does not name an npm package', () => {
  // `Finding.pkg` carries whatever the detector is about, and for `http-contract`
  // that is a host. Routing it to the package path made `emend fix` ask
  // registry.npmjs.org for `api.github.com` and fail with a 404 — the same
  // nonsense `version-pin` is already excluded to avoid, one detector later.
  //
  // There is no version to bump here. The repair is a source edit at the call
  // sites, which is the agent's job, and the routing has to say so rather than
  // reach for a registry.
  const finding: Finding = {
    id: '45b3a8770413',
    detector: 'http-contract',
    pkg: 'api.github.com',
    fromVersion: 'in use',
    toVersion: 'official-github',
    change: {
      path: 'GET /repos/{}/{}/git/refs/heads/{}',
      kind: 'removed',
      severity: 'breaking',
      confidence: 'medium',
      before: 'present',
      after: null,
    },
    sites: [{ file: 'src/gh.ts', line: 25, column: 5, text: 'axios.get(', via: 'import' }],
    confidence: 'medium',
  };
  assert.equal(needsSourceRepair(finding), true);
  assert.equal(needsSourceRepair({ ...finding, detector: 'api-drift' }), false);
});
