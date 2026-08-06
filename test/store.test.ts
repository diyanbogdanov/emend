import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';
import type { VerificationReport } from '../src/types.ts';

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
