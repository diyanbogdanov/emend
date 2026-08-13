import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';
import type { ScanReport, VerificationReport } from '../src/types.ts';

function tempDb(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-store-'));
  return { file: path.join(dir, 'emend.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ok = { command: 'tsc --noEmit', ok: true, exitCode: 0, stdout: '', stderr: '' };
const REPORT: VerificationReport = {
  outcome: 'verified',
  baseline: { typecheck: ok, test: ok },
  post: { typecheck: ok, test: ok },
  summary: 'verified',
};

test('a run records which model produced it', () => {
  // Outcome alone cannot attribute quality. Two models both verify and still
  // differ in what they leave behind, so a regression caused by changing
  // EMEND_LLM_MODEL is untraceable unless the model is stored with the run.
  const { file, cleanup } = tempDb();
  try {
    const store = new Store(file);
    store.recordRun('finding-1', '/repo', REPORT, null, null, {
      model: 'z-ai/glm-5.2',
      provider: 'OpenRouter',
    });
    const [run] = store.listRuns('finding-1');
    assert.equal(run?.agent?.model, 'z-ai/glm-5.2');
    assert.equal(run?.agent?.provider, 'OpenRouter');
    store.close();
  } finally {
    cleanup();
  }
});

test('a planner-only run is null, not an unknown model', () => {
  // The deterministic planner running unaided is a real, different fact from an
  // agent whose model was not captured. Collapsing them would make the column
  // useless for exactly the comparison it exists to support.
  const { file, cleanup } = tempDb();
  try {
    const store = new Store(file);
    store.recordRun('finding-2', '/repo', REPORT, 'renamed errors to issues', null);
    const [run] = store.listRuns('finding-2');
    assert.equal(run?.agent, null);
    store.close();
  } finally {
    cleanup();
  }
});

test('a database written before the column exists still opens and reads', () => {
  // The failure this guards: `CREATE TABLE IF NOT EXISTS` is a no-op on an
  // existing table, so without an explicit ALTER every deployed database would
  // throw "no such column: agent_model" on the first insert after upgrading.
  const { file, cleanup } = tempDb();
  try {
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE runs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        finding_id     TEXT NOT NULL,
        repo_dir       TEXT NOT NULL,
        outcome        TEXT NOT NULL,
        summary        TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        report_json    TEXT,
        plan_rationale TEXT,
        diff           TEXT
      );
    `);
    old.prepare(
      `INSERT INTO runs (finding_id, repo_dir, outcome, summary, created_at)
       VALUES ('legacy', '/repo', 'verified', 'from before the column', '2026-01-01T00:00:00.000Z')`,
    ).run();
    old.close();

    const store = new Store(file);

    // The pre-existing row survives, and reports null rather than inventing a model.
    const [legacy] = store.listRuns('legacy');
    assert.equal(legacy?.summary, 'from before the column');
    assert.equal(legacy?.agent, null);

    // And the upgraded database accepts new rows that use the column.
    store.recordRun('finding-3', '/repo', REPORT, null, null, {
      model: 'deepseek/deepseek-v4-pro',
      provider: 'OpenRouter',
    });
    assert.equal(store.listRuns('finding-3')[0]?.agent?.model, 'deepseek/deepseek-v4-pro');
    store.close();
  } finally {
    cleanup();
  }
});

test('migrating twice is a no-op rather than an error', () => {
  // Every process start re-runs #migrate, so re-adding a present column must not
  // throw. SQLite has no ADD COLUMN IF NOT EXISTS to lean on.
  const { file, cleanup } = tempDb();
  try {
    new Store(file).close();
    const second = new Store(file);
    second.recordRun('finding-4', '/repo', REPORT, null, null, {
      model: 'moonshotai/kimi-k3',
      provider: 'OpenRouter',
    });
    assert.equal(second.listRuns('finding-4')[0]?.agent?.model, 'moonshotai/kimi-k3');
    second.close();
  } finally {
    cleanup();
  }
});

test('a fixed vulnerability is remembered, so a revert is not a new finding', () => {
  // The regression guard's memory. Without it a revert, a bad merge, or a
  // lockfile regenerated from a stale branch arrives looking brand new, and the
  // fact that it was already dealt with is lost.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-store-'));
  try {
    const store = new Store(path.join(dir, 'emend.db'));
    store.recordVulnerabilityFixed('/repo', 'lodash', '4.18.0', ['GHSA-a', 'GHSA-b']);
    const fixed = store.fixedVulnerabilities('/repo');
    assert.equal(fixed.length, 1);
    assert.equal(fixed[0]?.fixedAt, '4.18.0');
    assert.deepEqual(fixed[0]?.advisories, ['GHSA-a', 'GHSA-b']);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixing the same package again updates the record rather than duplicating it', () => {
  // Two rows for one package would make the guard compare against whichever it
  // read first, which is a coin toss.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-store-'));
  try {
    const store = new Store(path.join(dir, 'emend.db'));
    store.recordVulnerabilityFixed('/repo', 'lodash', '4.18.0', ['GHSA-a']);
    store.recordVulnerabilityFixed('/repo', 'lodash', '4.19.0', ['GHSA-c']);
    const fixed = store.fixedVulnerabilities('/repo');
    assert.equal(fixed.length, 1);
    assert.equal(fixed[0]?.fixedAt, '4.19.0');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('another repository’s fixes are not this one’s', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-store-'));
  try {
    const store = new Store(path.join(dir, 'emend.db'));
    store.recordVulnerabilityFixed('/other', 'lodash', '4.18.0', []);
    assert.deepEqual(store.fixedVulnerabilities('/repo'), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// What changed since last time
// ---------------------------------------------------------------------------

function scanOf(repo: string, ids: string[]): ScanReport {
  return {
    repo,
    startedAt: '2026-08-07T00:00:00.000Z',
    finishedAt: '2026-08-07T00:01:00.000Z',
    counts: { packages: 1, findings: ids.length, breaking: 0 },
    warnings: [],
    packages: [
      {
        name: 'app',
        findings: ids.map((id) => ({
          id,
          pkg: 'lodash',
          fromVersion: '4.17.15',
          toVersion: '4.17.21',
          severity: 'vulnerability',
          change: { path: id, kind: 'vulnerable' },
          sites: [],
        })),
      },
    ],
  } as unknown as ScanReport;
}

test('the first scan is a baseline, not a pile of news', () => {
  // A scheduled scan is only worth reading if it says what changed. Reporting 63
  // advisories as "new" on the run that established the baseline is technically
  // true and trains the reader to ignore the next one, which is the actual
  // failure mode of security tooling.
  const { file, cleanup } = tempDb();
  try {
    const store = new Store(file);
    const delta = store.recordScan(scanOf('/repo', ['a', 'b']), 'app');
    assert.equal(delta.first, true);
    assert.deepEqual(delta.added, []);
    store.close();
  } finally {
    cleanup();
  }
});

test('a finding that was not open last time is new', () => {
  const { file, cleanup } = tempDb();
  try {
    const store = new Store(file);
    store.recordScan(scanOf('/repo', ['a']), 'app');
    const delta = store.recordScan(scanOf('/repo', ['a', 'b']), 'app');
    assert.equal(delta.first, false);
    assert.deepEqual(delta.added, ['b'], 'a was already open; only b is news');
    assert.deepEqual(delta.resolved, []);
    store.close();
  } finally {
    cleanup();
  }
});

test('a finding that has gone is reported as resolved', () => {
  const { file, cleanup } = tempDb();
  try {
    const store = new Store(file);
    store.recordScan(scanOf('/repo', ['a', 'b']), 'app');
    const delta = store.recordScan(scanOf('/repo', ['a']), 'app');
    assert.deepEqual(delta.resolved, ['b']);
    assert.deepEqual(delta.added, []);
    store.close();
  } finally {
    cleanup();
  }
});

test('a finding that comes back is a regression, not a discovery', () => {
  // A revert or a stale-branch merge brings a fixed finding back. Filing it
  // under "new" loses the fact that it was already dealt with once — which is
  // the single most useful thing to know about it.
  const { file, cleanup } = tempDb();
  try {
    const store = new Store(file);
    store.recordScan(scanOf('/repo', ['a']), 'app');
    store.recordScan(scanOf('/repo', []), 'app');
    const delta = store.recordScan(scanOf('/repo', ['a']), 'app');
    assert.deepEqual(delta.returned, ['a']);
    assert.deepEqual(delta.added, [], 'it is not a discovery; it was found before');
    store.close();
  } finally {
    cleanup();
  }
});

test('one repository’s scan is not news about another', () => {
  const { file, cleanup } = tempDb();
  try {
    const store = new Store(file);
    store.recordScan(scanOf('/repo-a', ['x']), 'a');
    const delta = store.recordScan(scanOf('/repo-b', ['y']), 'b');
    assert.equal(delta.first, true, '/repo-b has never been scanned');
    store.close();
  } finally {
    cleanup();
  }
});

test('a finding stays resolved once, not on every scan afterwards', () => {
  // The row survives with status 'fixed', so a resolved-set built from every
  // prior row rather than the open ones re-announces the same fix forever. That
  // is the same alert fatigue this delta exists to prevent, arriving from the
  // good-news side.
  const { file, cleanup } = tempDb();
  try {
    const store = new Store(file);
    store.recordScan(scanOf('/repo', ['a']), 'app');
    assert.deepEqual(store.recordScan(scanOf('/repo', []), 'app').resolved, ['a']);
    assert.deepEqual(
      store.recordScan(scanOf('/repo', []), 'app').resolved,
      [],
      'it was already reported resolved; saying so again is noise',
    );
    store.close();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// What is stored, and getting rid of it
// ---------------------------------------------------------------------------

test('stored repositories are listed with enough to decide what to delete', () => {
  // The dashboard's repo dropdown is `SELECT DISTINCT repo_dir FROM scans`, and
  // it only ever grows: 55 paths and 111 scans accumulated locally, most of them
  // throwaway temp directories from eval runs and debugging sessions that no
  // longer exist on disk.
  //
  // A count alone is not enough to decide what to delete. Whether the path still
  // exists is the thing that separates "a repo I work on" from "a tmpdir from a
  // sweep three weeks ago", so it is reported rather than left to be guessed.
  const { file, cleanup } = tempDb();
  try {
    const store = new Store(file);
    store.recordScan(scanOf('/repo/live', ['a']), 'live-app');
    store.recordScan(scanOf('/repo/live', ['a', 'b']), 'live-app');
    store.recordScan(scanOf('/tmp/gone-1234', ['c']), 'throwaway');

    const rows = store.listStoredRepos();
    assert.equal(rows.length, 2, 'one row per distinct path, not per scan');

    const live = rows.find((r) => r.repoDir === '/repo/live');
    assert.equal(live?.scans, 2);
    assert.equal(live?.findings, 2, 'distinct findings across its scans');
    assert.equal(live?.repoName, 'live-app');
    assert.ok(live?.lastScanned, 'when it was last seen decides what is stale');
    store.close();
  } finally {
    cleanup();
  }
});

test('pruning one repository leaves every other repository untouched', () => {
  // The point of naming a path: clearing a fixture directory must not take the
  // repository you actually work on with it.
  const { file, cleanup } = tempDb();
  try {
    const store = new Store(file);
    store.recordScan(scanOf('/repo/keep', ['a']), 'keep');
    store.recordScan(scanOf('/repo/drop', ['b']), 'drop');

    const removed = store.pruneRepo('/repo/drop');
    assert.ok(removed.scans > 0, 'it reports what it deleted rather than succeeding silently');

    const left = store.listStoredRepos();
    assert.deepEqual(left.map((r) => r.repoDir), ['/repo/keep']);
    assert.equal(store.listFindings('/repo/drop').length, 0);
    assert.equal(store.listFindings('/repo/keep').length, 1, 'the neighbour is intact');
    store.close();
  } finally {
    cleanup();
  }
});

test('pruning a path that was never stored deletes nothing and says so', () => {
  // A typo in a path must not read like a successful clear. Reporting zero is
  // the difference between "there was nothing there" and "it is gone now".
  const { file, cleanup } = tempDb();
  try {
    const store = new Store(file);
    store.recordScan(scanOf('/repo/keep', ['a']), 'keep');

    const removed = store.pruneRepo('/repo/typo');
    assert.equal(removed.scans, 0);
    assert.equal(removed.findings, 0);
    assert.equal(store.listStoredRepos().length, 1);
    store.close();
  } finally {
    cleanup();
  }
});

test('pruning everything clears scan history and spares the GitHub App', () => {
  // Two different things live in one database. Scan history is local clutter;
  // installations, tracked repos, queued jobs and opened pull requests are the
  // hosted service's operational state, and wiping those to tidy a dropdown
  // would unregister the App and lose the record of every PR it opened.
  //
  // So the default clears what the dropdown shows and nothing else. Taking the
  // App with it has to be asked for.
  const { file, cleanup } = tempDb();
  try {
    const store = new Store(file);
    store.recordScan(scanOf('/repo/a', ['a']), 'a');
    store.recordScan(scanOf('/repo/b', ['b']), 'b');
    store.upsertInstallation(42, 'acme');
    store.upsertRepo({ repoKey: 'acme/app', installationId: 42, owner: 'acme', name: 'app', defaultBranch: 'main' });

    const removed = store.pruneAll();
    assert.ok(removed.scans >= 2);
    assert.equal(store.listStoredRepos().length, 0, 'the dropdown is empty');
    assert.equal(store.listRepos().length, 1, 'the App still knows the repo it tracks');

    store.pruneAll({ includeApp: true });
    assert.equal(store.listRepos().length, 0, 'and only now is it forgotten');
    store.close();
  } finally {
    cleanup();
  }
});
