import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichAdvisories, ordinal, rankVulnerable } from '../src/advisory.ts';
import type { FetchResponse, Fetcher } from '../src/specfetch.ts';
import type { VulnerablePackage } from '../src/osv.ts';

function fetchOf(routes: Record<string, unknown>): Fetcher & { asked: string[] } {
  const asked: string[] = [];
  const f = async (url: string): Promise<FetchResponse> => {
    asked.push(url);
    const hit = routes[url];
    if (hit === undefined) return { ok: false, status: 404, url, body: '', contentType: '' };
    return { ok: true, status: 200, url, body: JSON.stringify(hit), contentType: 'application/json' };
  };
  return Object.assign(f, { asked });
}

const advisory = (id: string) => `https://api.github.com/advisories/${id}`;

function pkg(name: string, ids: string[]): VulnerablePackage {
  return {
    name,
    ecosystem: 'npm',
    version: '1.0.0',
    vulnerabilities: ids.map((id) => ({
      id,
      aliases: [],
      cve: null,
      summary: '',
      fixedIn: '2.0.0',
      cvssVector: null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

test('an advisory is looked up by its id, not searched for', () => {
  const fetch = fetchOf({
    [advisory('GHSA-a')]: {
      severity: 'medium',
      cvss: { score: 5.3 },
      epss: { percentage: 0.07336, percentile: 0.93601 },
      cwes: [{ cwe_id: 'CWE-400' }],
    },
  });
  return enrichAdvisories(fetch, ['GHSA-a'], {}).then((byId) => {
    const one = byId.get('GHSA-a');
    assert.equal(one?.cvssScore, 5.3);
    assert.equal(one?.epssPercentile, 0.93601);
    assert.equal(one?.cwe, 'CWE-400');
    assert.deepEqual(fetch.asked, [advisory('GHSA-a')]);
  });
});

test('an advisory GitHub does not know is absent, not zero', () => {
  // A missing score and a score of zero mean opposite things. Recording the
  // second would rank a vulnerability nobody has assessed below every one that
  // has been.
  return enrichAdvisories(fetchOf({}), ['GHSA-missing'], {}).then((byId) => {
    assert.equal(byId.size, 0);
  });
});

test('a token is sent when there is one, because sixty an hour is not a budget', () => {
  const seen: Array<Record<string, string> | undefined> = [];
  const fetch: Fetcher = async (url, init) => {
    seen.push(init?.headers);
    return { ok: false, status: 404, url, body: '', contentType: '' };
  };
  return enrichAdvisories(fetch, ['GHSA-a'], { token: 'ghp_x' }).then(() => {
    assert.equal(seen[0]?.['authorization'], 'Bearer ghp_x');
  });
});

test('the number of lookups is bounded, since the budget is shared', () => {
  // A repository with two hundred advisories would exhaust an unauthenticated
  // hour three times over, and take the spec resolver's budget with it.
  const fetch = fetchOf({});
  const many = Array.from({ length: 100 }, (_, i) => `GHSA-${i}`);
  return enrichAdvisories(fetch, many, { max: 5 }).then(() => {
    assert.equal(fetch.asked.length, 5);
  });
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

test('exploitation likelihood outranks severity, which is the whole point', () => {
  // Measured on GHSA-29mw-wpgm-hmr9: CVSS 5.3, "medium", and EPSS percentile
  // 0.936. CVSS scores the worst case whether or not anyone exploits it; EPSS
  // estimates whether they do. Ranking on CVSS buries the one being exploited
  // under a theoretically worse one that nobody touches.
  const ranked = rankVulnerable(
    [pkg('quiet', ['GHSA-quiet']), pkg('exploited', ['GHSA-hot'])],
    new Map([
      ['GHSA-quiet', { severity: 'critical', cvssScore: 9.8, epssPercentile: 0.10, cwe: null }],
      ['GHSA-hot', { severity: 'medium', cvssScore: 5.3, epssPercentile: 0.94, cwe: null }],
    ]),
  );
  assert.deepEqual(ranked.map((p) => p.name), ['exploited', 'quiet']);
});

test('with no exploitation data at all, severity is what is left', () => {
  const ranked = rankVulnerable(
    [pkg('low', ['GHSA-low']), pkg('high', ['GHSA-high'])],
    new Map([
      ['GHSA-low', { severity: 'low', cvssScore: 2.0, epssPercentile: null, cwe: null }],
      ['GHSA-high', { severity: 'critical', cvssScore: 9.1, epssPercentile: null, cwe: null }],
    ]),
  );
  assert.deepEqual(ranked.map((p) => p.name), ['high', 'low']);
});

test('an unenriched package sorts last rather than first', () => {
  // Unknown is not "worst". A package nobody has scored must not displace one
  // measured to be actively exploited.
  const ranked = rankVulnerable(
    [pkg('unknown', ['GHSA-none']), pkg('known', ['GHSA-known'])],
    new Map([['GHSA-known', { severity: 'high', cvssScore: 7.5, epssPercentile: 0.5, cwe: null }]]),
  );
  assert.deepEqual(ranked.map((p) => p.name), ['known', 'unknown']);
});

test('a package is ranked by its worst advisory, not its average', () => {
  // One actively exploited advisory is the reason to act, and averaging it with
  // four quiet ones is how it stops being visible.
  const ranked = rankVulnerable(
    [pkg('mixed', ['GHSA-quiet', 'GHSA-hot']), pkg('middling', ['GHSA-mid'])],
    new Map([
      ['GHSA-quiet', { severity: 'low', cvssScore: 1, epssPercentile: 0.01, cwe: null }],
      ['GHSA-hot', { severity: 'medium', cvssScore: 5, epssPercentile: 0.99, cwe: null }],
      ['GHSA-mid', { severity: 'high', cvssScore: 7, epssPercentile: 0.5, cwe: null }],
    ]),
  );
  assert.deepEqual(ranked.map((p) => p.name), ['mixed', 'middling']);
});

test('ranking without any enrichment leaves the order alone', () => {
  const input = [pkg('a', ['x']), pkg('b', ['y'])];
  assert.deepEqual(
    rankVulnerable(input, new Map()).map((p) => p.name),
    ['a', 'b'],
  );
});

test('percentiles read as English', () => {
  assert.equal(ordinal(1), '1st');
  assert.equal(ordinal(2), '2nd');
  assert.equal(ordinal(3), '3rd');
  assert.equal(ordinal(4), '4th');
  // The exceptions that catch every naive implementation, including mine: the
  // first rendering said "91th percentile".
  assert.equal(ordinal(11), '11th');
  assert.equal(ordinal(12), '12th');
  assert.equal(ordinal(13), '13th');
  assert.equal(ordinal(21), '21st');
  assert.equal(ordinal(91), '91st');
  assert.equal(ordinal(96), '96th');
});
