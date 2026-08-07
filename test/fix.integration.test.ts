import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixPackage } from '../src/fix.ts';
import { scanRepo } from '../src/analyze.ts';
import { materialiseCase, DEMO_CASE } from '../src/eval.ts';
import type { Harness, HarnessTask } from '../src/harness.ts';
import type { Finding } from '../src/types.ts';

/**
 * The escalation wiring inside `fixPackage`, which nothing covered.
 *
 * `escalate` was tested in isolation against a fake harness, and the decision of
 * *whether to escalate at all* — the part that reads the verification outcome and
 * the trust setting — was not. That is the seam where a harness could be run on
 * an untrusted repository, or run after a migration had already succeeded.
 *
 * These need the registry, because `fixPackage` resolves the target version's
 * declarations before it does anything else. When it is unreachable the test
 * skips and says so: a vacuous pass on the one integration test in the suite is
 * worse than no test, because it reads as coverage.
 */

/** A harness that records whether it was asked, and optionally repairs the build. */
function spyHarness(repair?: (dir: string) => Promise<void>): Harness & { calls: HarnessTask[] } {
  const calls: HarnessTask[] = [];
  return {
    id: 'spy',
    calls,
    available: async () => ({ ok: true }),
    run: async (dir: string, task: HarnessTask) => {
      calls.push(task);
      if (repair) await repair(dir);
      return { ok: true, log: 'spy ran' };
    },
  };
}

async function prepare(): Promise<{ dir: string; findings: Finding[] } | null> {
  let dir: string;
  try {
    dir = await materialiseCase(DEMO_CASE);
  } catch {
    return null;
  }
  try {
    const scan = await scanRepo(dir, { only: [DEMO_CASE.pkg] });
    const findings = scan.packages.flatMap((p) => p.findings);
    if (findings.length === 0) {
      await rm(dir, { recursive: true, force: true });
      return null;
    }
    return { dir, findings };
  } catch {
    await rm(dir, { recursive: true, force: true });
    return null;
  }
}

test('an untrusted repository is never handed to a harness', async (t) => {
  // `--untrusted` exists so a hosted run executes nothing from the repository. A
  // harness is an agent whose entire value is going and running things, and the
  // verification that would catch a bad outcome is suppressed in that mode too —
  // so nothing downstream would notice if this rule leaked.
  const prepared = await prepare();
  if (!prepared) {
    t.skip('the registry was unreachable, so fixPackage could not be exercised');
    return;
  }
  const harness = spyHarness();
  try {
    const result = await fixPackage(prepared.dir, prepared.findings, {
      untrusted: true,
      harness,
      onProgress: () => {},
    });

    assert.equal(harness.calls.length, 0, 'the harness must not have been invoked');
    // Refused, and said so. Silence here would be indistinguishable from a run
    // that escalated and found nothing.
    if (result.harness) {
      assert.equal(result.harness.ok, false);
      assert.match(result.harness.reason ?? '', /untrusted/i);
    }
  } finally {
    await rm(prepared.dir, { recursive: true, force: true });
  }
});

test('a migration that already verified is not escalated', async (t) => {
  // The harness is the last resort and the most expensive step in the pipeline.
  // Running it after the deterministic path already succeeded would spend a model
  // call, and worse, invite edits nothing asked for into a green migration.
  const prepared = await prepare();
  if (!prepared) {
    t.skip('the registry was unreachable, so fixPackage could not be exercised');
    return;
  }
  const harness = spyHarness();
  try {
    const result = await fixPackage(prepared.dir, prepared.findings, {
      harness,
      onProgress: () => {},
    });

    if (result.verification.outcome === 'verified' || result.verification.outcome === 'typecheck-only') {
      assert.equal(harness.calls.length, 0, 'a settled migration must not escalate');
      assert.equal(result.harness, undefined);
    } else {
      // The other half of the same rule: it was still red, so it *did* escalate.
      assert.equal(harness.calls.length, 1, 'a red migration must escalate exactly once');
      assert.equal(result.harness?.id, 'spy');
      assert.match(harness.calls[0]?.instruction ?? '', new RegExp(DEMO_CASE.pkg));
    }
  } finally {
    await rm(prepared.dir, { recursive: true, force: true });
  }
});

test('what a harness leaves behind is re-verified, not taken on trust', async (t) => {
  // The property the whole escalation rests on: the worktree, the baseline and
  // the verdict vocabulary do not care who wrote the bytes. A harness that breaks
  // the build must produce a failing verdict, not a passing one with its edits in.
  const prepared = await prepare();
  if (!prepared) {
    t.skip('the registry was unreachable, so fixPackage could not be exercised');
    return;
  }
  // Writes syntactically invalid TypeScript into a file the migration touches.
  const vandal = spyHarness(async (dir) => {
    const file = path.join(dir, 'src/schema.ts');
    const before = await readFile(file, 'utf8').catch(() => '');
    await writeFile(file, `${before}\nexport const broken: = ;\n`, 'utf8');
  });
  try {
    const result = await fixPackage(prepared.dir, prepared.findings, {
      harness: vandal,
      onProgress: () => {},
    });

    if (vandal.calls.length === 0) {
      t.skip('the deterministic path settled this migration, so nothing escalated');
      return;
    }
    assert.notEqual(
      result.verification.outcome,
      'verified',
      'a harness that broke the build must not yield a verified result',
    );
  } finally {
    await rm(prepared.dir, { recursive: true, force: true });
  }
});
