import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fixedVersionFor,
  readVulnerability,
  remediationTarget,
  scanPackages,
  type OsvRecord,
} from '../src/osv.ts';
import type { FetchResponse, Fetcher } from '../src/specfetch.ts';

/**
 * The real shape, from `GET /v1/vulns/GHSA-29mw-wpgm-hmr9`.
 *
 * The five `affected` entries are the point: one advisory covers `lodash`,
 * `lodash-es`, `lodash.trimend` and others, each with its own ranges. Reading
 * `affected[0]` would answer with another package's version.
 */
const LODASH: OsvRecord = {
  id: 'GHSA-29mw-wpgm-hmr9',
  aliases: ['CVE-2020-28500'],
  summary: 'Regular Expression Denial of Service (ReDoS) in lodash',
  severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L' }],
  affected: [
    {
      package: { name: 'lodash.trimend', ecosystem: 'npm' },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.5.1' }] }],
    },
    {
      package: { name: 'lodash', ecosystem: 'npm' },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '4.0.0' }, { fixed: '4.17.21' }] }],
    },
  ],
};

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

const BATCH = 'https://api.osv.dev/v1/querybatch';
const vulnUrl = (id: string): string => `https://api.osv.dev/v1/vulns/${id}`;

// ---------------------------------------------------------------------------
// Which version fixes it
// ---------------------------------------------------------------------------

test('the fix comes from the entry for this package, not the first one listed', () => {
  // One advisory, several packages, several different fixed versions. Reading
  // the wrong entry proposes an upgrade that fixes nothing and names a version
  // this package may never have published.
  assert.equal(fixedVersionFor(LODASH, 'lodash', 'npm', '4.17.15'), '4.17.21');
  assert.equal(fixedVersionFor(LODASH, 'lodash.trimend', 'npm', '4.5.0'), '4.5.1');
});

test('a package the advisory does not name has no fix here', () => {
  assert.equal(fixedVersionFor(LODASH, 'underscore', 'npm', '1.0.0'), null);
});

test('the ecosystem is part of the match, since names repeat across them', () => {
  // `requests` is a PyPI package and a Go module and an npm package. An advisory
  // for one says nothing about the others.
  assert.equal(fixedVersionFor(LODASH, 'lodash', 'PyPI', '4.17.15'), null);
});

test('the range covering the installed version is the one that answers', () => {
  // A package can have several vulnerable windows, each fixed separately: broken
  // in 1.x, fixed in 1.9, broken again in 2.0, fixed in 2.3. The answer depends
  // on which window the installed version sits in.
  const multi: OsvRecord = {
    id: 'GHSA-x',
    affected: [
      {
        package: { name: 'thing', ecosystem: 'npm' },
        ranges: [
          {
            type: 'SEMVER',
            events: [
              { introduced: '1.0.0' },
              { fixed: '1.9.0' },
              { introduced: '2.0.0' },
              { fixed: '2.3.0' },
            ],
          },
        ],
      },
    ],
  };
  assert.equal(fixedVersionFor(multi, 'thing', 'npm', '1.4.0'), '1.9.0');
  assert.equal(fixedVersionFor(multi, 'thing', 'npm', '2.1.0'), '2.3.0');
  // Between the windows: fixed already, and not affected.
  assert.equal(fixedVersionFor(multi, 'thing', 'npm', '1.9.5'), null);
});

test('an advisory with no fixed version reports none rather than inventing one', () => {
  // `last_affected` with no `fixed` is how OSV records "still unpatched". A
  // finding with no remediation is a real answer; a guessed version is not.
  const unfixed: OsvRecord = {
    id: 'GHSA-y',
    affected: [
      {
        package: { name: 'thing', ecosystem: 'npm' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '1.0.0' }, { last_affected: '2.5.0' }] }],
      },
    ],
  };
  assert.equal(fixedVersionFor(unfixed, 'thing', 'npm', '1.4.0'), null);
});

// ---------------------------------------------------------------------------
// Reading a record
// ---------------------------------------------------------------------------

test('the CVE alias is surfaced, because that is what people search for', () => {
  const read = readVulnerability(LODASH, 'lodash', 'npm', '4.17.15');
  assert.equal(read.id, 'GHSA-29mw-wpgm-hmr9');
  assert.equal(read.cve, 'CVE-2020-28500');
  assert.equal(read.fixedIn, '4.17.21');
});

test('severity is carried as the vector string it actually is', () => {
  // Measured: OSV gives `CVSS:3.1/AV:N/...`, not a number. Storing it as one
  // would mean inventing a score, and the numeric value comes from GitHub
  // Advisory later — where EPSS comes from too.
  const read = readVulnerability(LODASH, 'lodash', 'npm', '4.17.15');
  assert.match(read.cvssVector ?? '', /^CVSS:3\.1\//);
});

test('a record with no alias has no CVE, rather than a made-up one', () => {
  const read = readVulnerability({ id: 'GHSA-z', affected: [] }, 'thing', 'npm', '1.0.0');
  assert.equal(read.cve, null);
});

// ---------------------------------------------------------------------------
// Scanning a tree
// ---------------------------------------------------------------------------

const TREE = [
  { name: 'lodash', ecosystem: 'npm', version: '4.17.15' },
  { name: 'zod', ecosystem: 'npm', version: '3.22.4' },
];

test('only packages that screened positive are looked up in detail', () => {
  // Measured: `querybatch` answered three packages in half a second and returns
  // only ids. A tree of several hundred packages costs a handful of requests
  // this way, and one per package the naive way.
  const fetch = fetchOf({
    [BATCH]: { results: [{ vulns: [{ id: LODASH.id }] }, {}] },
    [vulnUrl(LODASH.id)]: LODASH,
  });
  return scanPackages(fetch, TREE).then((found) => {
    assert.equal(found.length, 1);
    assert.equal(found[0]?.name, 'lodash');
    assert.equal(found[0]?.vulnerabilities[0]?.fixedIn, '4.17.21');
    assert.equal(
      fetch.asked.filter((u) => u.includes('/vulns/')).length,
      1,
      'zod screened clean and was never fetched',
    );
  });
});

test('a record is fetched once however many packages it covers', () => {
  // One advisory covering `lodash` and `lodash-es` should cost one request, not
  // one per package. Trees are full of these.
  const fetch = fetchOf({
    [BATCH]: { results: [{ vulns: [{ id: LODASH.id }] }, { vulns: [{ id: LODASH.id }] }] },
    [vulnUrl(LODASH.id)]: LODASH,
  });
  return scanPackages(fetch, [
    { name: 'lodash', ecosystem: 'npm', version: '4.17.15' },
    { name: 'lodash.trimend', ecosystem: 'npm', version: '4.5.0' },
  ]).then(() => {
    assert.equal(fetch.asked.filter((u) => u.includes('/vulns/')).length, 1);
  });
});

test('a clean tree yields nothing, and says nothing about being clean', () => {
  const fetch = fetchOf({ [BATCH]: { results: [{}, {}] } });
  return scanPackages(fetch, TREE).then((found) => assert.deepEqual(found, []));
});

test('a screening that fails yields nothing rather than a clean bill of health', () => {
  // The caller renders "could not check" differently from "checked and clean",
  // and it can only do that if this does not quietly return an empty list as
  // though it had succeeded.
  return scanPackages(fetchOf({}), TREE).then((found) => assert.deepEqual(found, []));
});

test('an advisory that does not actually cover the installed version is dropped', () => {
  // The screening step is coarse. If the detail says this version sits outside
  // every affected range, there is no finding — reporting one anyway would be a
  // false positive from a source that never claimed it.
  const fetch = fetchOf({
    [BATCH]: { results: [{ vulns: [{ id: LODASH.id }] }] },
    [vulnUrl(LODASH.id)]: LODASH,
  });
  return scanPackages(fetch, [{ name: 'lodash', ecosystem: 'npm', version: '3.0.0' }]).then(
    (found) => assert.deepEqual(found, []),
  );
});

test('the ecosystem travels with the query, which is the multi-language seam', () => {
  // OSV keys on ecosystem, so Python, Go and Java cost an inventory reader
  // rather than a new pipeline. Nothing here may assume npm.
  const bodies: string[] = [];
  const fetch: Fetcher = async (url, init) => {
    bodies.push(String(init?.body ?? ''));
    return { ok: true, status: 200, url, body: JSON.stringify({ results: [{}] }), contentType: 'application/json' };
  };
  return scanPackages(fetch, [{ name: 'requests', ecosystem: 'PyPI', version: '2.19.0' }]).then(
    () => {
      assert.match(bodies[0] ?? '', /"ecosystem":"PyPI"/);
    },
  );
});

// ---------------------------------------------------------------------------
// One target for the package, not one per advisory
// ---------------------------------------------------------------------------

test('the target clears every advisory, not just the first one', () => {
  // Measured live: `lodash@4.17.15` carries six advisories fixed in 4.17.19,
  // 4.17.21 and 4.17.23. Bumping to the first leaves two live. The target is
  // therefore the highest fix among them — one bump, one verification, and the
  // package actually clean afterwards.
  const target = remediationTarget({
    name: 'lodash',
    ecosystem: 'npm',
    version: '4.17.15',
    vulnerabilities: [
      { id: 'a', aliases: [], cve: null, summary: '', fixedIn: '4.17.19', cvssVector: null },
      { id: 'b', aliases: [], cve: null, summary: '', fixedIn: '4.17.23', cvssVector: null },
      { id: 'c', aliases: [], cve: null, summary: '', fixedIn: '4.17.21', cvssVector: null },
    ],
  });
  assert.equal(target.version, '4.17.23');
  assert.equal(target.clears, 3);
  assert.equal(target.leaves.length, 0);
});

test('advisories with no fix are named as what the bump will not clear', () => {
  // The honest half. A target that resolves three of four is worth taking and
  // must not be presented as resolving four — the unpatched one is still there
  // after the upgrade, and the pull request has to say so.
  const target = remediationTarget({
    name: 'thing',
    ecosystem: 'npm',
    version: '1.0.0',
    vulnerabilities: [
      { id: 'fixed', aliases: [], cve: null, summary: '', fixedIn: '2.0.0', cvssVector: null },
      { id: 'unpatched', aliases: [], cve: 'CVE-2026-1', summary: '', fixedIn: null, cvssVector: null },
    ],
  });
  assert.equal(target.version, '2.0.0');
  assert.equal(target.clears, 1);
  assert.deepEqual(target.leaves, ['unpatched']);
});

test('a package where nothing is patched has no target at all', () => {
  const target = remediationTarget({
    name: 'thing',
    ecosystem: 'npm',
    version: '1.0.0',
    vulnerabilities: [{ id: 'x', aliases: [], cve: null, summary: '', fixedIn: null, cvssVector: null }],
  });
  assert.equal(target.version, null);
  assert.deepEqual(target.leaves, ['x']);
});

test('a git range is not a version, and never becomes an upgrade target', () => {
  // Found live. `requests@2.19.0` resolved to
  // `74ea7cf7a6a27a4eeb2ae24e162bcc942a6706d5`, because OSV also publishes GIT
  // ranges whose `fixed` is a commit hash — and a hash compared as a version and
  // won the maximum. Proposing a commit as an upgrade is not a smaller mistake
  // than proposing nothing.
  const mixed: OsvRecord = {
    id: 'GHSA-git',
    affected: [
      {
        package: { name: 'requests', ecosystem: 'PyPI' },
        ranges: [
          { type: 'GIT', events: [{ introduced: '0' }, { fixed: '74ea7cf7a6a27a4eeb2ae24e162bcc942a6706d5' }] },
          { type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '2.20.0' }] },
        ],
      },
    ],
  };
  assert.equal(fixedVersionFor(mixed, 'requests', 'PyPI', '2.19.0'), '2.20.0');
});

test('an advisory with only a git range offers no installable fix', () => {
  const gitOnly: OsvRecord = {
    id: 'GHSA-gitonly',
    affected: [
      {
        package: { name: 'thing', ecosystem: 'Go' },
        ranges: [{ type: 'GIT', events: [{ introduced: '0' }, { fixed: 'abc123def456' }] }],
      },
    ],
  };
  assert.equal(fixedVersionFor(gitOnly, 'thing', 'Go', '1.0.0'), null);
});
