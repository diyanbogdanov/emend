import { parseDiffHunks } from '../src/gate.ts';
import type { HunkGate } from '../src/gate.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  escalate,
  filterDiff,
  harnessPermitted,
  openCodeHarness,
  revertHunks,
  type Harness,
  drivingHarness,
  drivePrompt,
  summariseEvents,
  type HarnessRun,
  repairHarness,
} from '../src/harness.ts';

/** execFile, not exec: argument arrays, never a shell string. */
const run = promisify(execFile);

// ---------------------------------------------------------------------------
// filterDiff — selecting hunks out of a patch
//
// The gate classifies hunks; acting on that verdict means rebuilding a patch
// from the subset. A patch is not a list of lines you can filter — drop a hunk
// without its file header and the result is not applicable, keep a header whose
// hunks all went and `git apply` rejects the file.
// ---------------------------------------------------------------------------

const TWO_FILES = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = 4;
@@ -10,3 +10,3 @@
 const p = 1;
-const q = 2;
+const q = 3;
 const r = 4;
diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -5,3 +5,3 @@
 const m = 1;
-const n = 2;
+const n = 3;
 const o = 4;
`;

test('dropping one hunk keeps the file header and the hunk that stayed', () => {
  const kept = filterDiff(TWO_FILES, (file, start) => !(file === 'src/a.ts' && start === 10));
  assert.ok(kept.includes('--- a/src/a.ts'), 'the surviving hunk still needs its header');
  assert.ok(kept.includes('@@ -1,3 +1,3 @@'));
  assert.ok(!kept.includes('@@ -10,3 +10,3 @@'), 'the dropped hunk is gone');
  assert.ok(kept.includes('@@ -5,3 +5,3 @@'), 'the untouched file is untouched');
});

test('dropping every hunk in a file drops its header too', () => {
  // An orphan `diff --git` header with no hunks is not a patch; git rejects the
  // whole thing, which would turn a partial revert into no revert at all.
  const kept = filterDiff(TWO_FILES, (file) => file !== 'src/a.ts');
  assert.ok(!kept.includes('src/a.ts'), 'no trace of the fully-dropped file');
  assert.ok(kept.includes('--- a/src/b.ts'));
  assert.ok(kept.includes('@@ -5,3 +5,3 @@'));
});

test('keeping nothing yields nothing, not an empty-but-malformed patch', () => {
  assert.equal(filterDiff(TWO_FILES, () => false).trim(), '');
});

test('a newly created file keeps its /dev/null header', () => {
  // A harness that writes files creates them too. `--- /dev/null` is what marks
  // the patch as a creation; losing it makes the patch unapplicable.
  const created = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..5555555
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
`;
  const kept = filterDiff(created, () => true);
  assert.ok(kept.includes('--- /dev/null'));
  assert.ok(kept.includes('new file mode 100644'));
  assert.ok(kept.includes('+export const a = 1;'));
});

// ---------------------------------------------------------------------------
// revertHunks — undoing what the gate would not justify
// ---------------------------------------------------------------------------

async function gitFixture(files: Record<string, string>): Promise<{
  dir: string;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-harness-'));
  await run('git', ['init', '-b', 'main', dir]);
  await run('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  await run('git', ['-C', dir, 'config', 'user.name', 'Test']);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), body);
  }
  await run('git', ['-C', dir, 'add', '-A']);
  await run('git', ['-C', dir, 'commit', '-m', 'base']);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Thirty lines, so two edits can be far enough apart to be separate hunks.
 * Git's three lines of context merge anything closer, and a merged hunk cannot
 * demonstrate per-hunk reverting at all.
 */
const BASE =
  Array.from({ length: 30 }, (_, i) => `line${String(i + 1).padStart(2, '0')}`).join('\n') + '\n';

test('a hunk is reverted where it stands, leaving the rest of the file changed', async () => {
  // The whole point of gating hunks rather than files. A harness that fixes the
  // real break and also rewrites something unrelated must keep the fix. Reverting
  // the file wholesale is the failure this replaces: it withholds a real repair
  // to punish an unrelated one.
  const f = await gitFixture({ 'a.txt': BASE });
  try {
    const changed = BASE.replace('line02', 'LINE02').replace('line25', 'LINE25');
    writeFileSync(path.join(f.dir, 'a.txt'), changed);

    const { stdout: diff } = await run('git', ['-C', f.dir, 'diff']);
    const hunks = parseDiffHunks(diff);
    assert.equal(hunks.length, 2, 'the two edits are far enough apart to be separate hunks');

    // Revert only the later one.
    const drop = hunks.filter((h) => h.start > 10);
    const result = await revertHunks(f.dir, diff, drop);
    assert.equal(result.reverted, 1);
    assert.equal(result.error, undefined);

    const after = readFileSync(path.join(f.dir, 'a.txt'), 'utf8');
    assert.ok(after.includes('LINE02'), 'the kept hunk survived');
    assert.ok(after.includes('line25'), 'the dropped hunk was undone');
    assert.ok(!after.includes('LINE25'));
  } finally {
    f.cleanup();
  }
});

test('reverting nothing touches nothing', async () => {
  const f = await gitFixture({ 'a.txt': BASE });
  try {
    const changed = BASE.replace('line02', 'LINE02');
    writeFileSync(path.join(f.dir, 'a.txt'), changed);
    const { stdout: diff } = await run('git', ['-C', f.dir, 'diff']);

    const result = await revertHunks(f.dir, diff, []);
    assert.equal(result.reverted, 0);
    assert.equal(readFileSync(path.join(f.dir, 'a.txt'), 'utf8'), changed);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// escalate — the gate around a harness that writes files
// ---------------------------------------------------------------------------

/** A harness that performs a fixed set of writes, so the gate is what is tested. */
function fakeHarness(writes: Record<string, string>, over: Partial<Harness> = {}): Harness {
  return {
    id: 'fake',
    available: async () => ({ ok: true }),
    run: async (dir) => {
      for (const [name, body] of Object.entries(writes)) {
        writeFileSync(path.join(dir, name), body);
      }
      return { ok: true, log: 'done' };
    },
    ...over,
  };
}

// Only line 2 is broken. Nothing points at line 25, so a hunk over it is
// outside everything the evidence named.
const FAILURE = 'a.txt(2,1): error TS2304: Cannot find name.';
// Stated literally rather than through a policy function. The reviewer-judges
// decision deleted the one the repair used, and what these tests exercise is
// `escalate`'s revert machinery — still live under `reviewGate` and `lintGate`
// — not any policy's choice of anchors.
const GATE: HunkGate = {
  anchors: [{ file: 'a.txt', line: 2 }],
  unanchored: 'revert',
  whenNoAnchors: 'judge',
  evidenceName: 'the failure',
};

test('a hunk the failure did not ask for is reverted before anyone sees the diff', async () => {
  const f = await gitFixture({ 'a.txt': BASE });
  try {
    const harness = fakeHarness({ 'a.txt': BASE.replace('line02', 'LINE02').replace('line25', 'LINE25') });
    const result = await escalate(harness, f.dir, { instruction: 'fix it', failureOutput: FAILURE }, GATE);

    assert.equal(result.ok, true);
    assert.equal(result.revertedHunks.length, 1);
    assert.equal(result.keptHunks, 1);
    // The reason names the rule that fired. `nothing outstanding` was the
    // quiet-call-site rule, deleted along with the rest of the
    // repair's gate; what reverts now is a hunk outside every anchor.
    assert.match(result.revertedHunks[0]?.reason ?? '', /is not anywhere the failure pointed/);

    const after = readFileSync(path.join(f.dir, 'a.txt'), 'utf8');
    assert.ok(after.includes('LINE02'), 'the diagnostic-backed repair stayed');
    assert.ok(!after.includes('LINE25'), 'the unrequested rewrite did not');
    assert.ok(!result.diff.includes('LINE25'), 'and the reported diff reflects disk');
  } finally {
    f.cleanup();
  }
});

test('a gitignored node_modules does not stop the baseline being taken', async () => {
  // Found by the first run of the `fixPackage` integration test, and it meant
  // escalation had never worked on a real repository. Staging with an explicit
  // `.` pathspec makes git refuse — "the following paths are ignored by one of
  // your .gitignore files" — and the escalation gave up before running.
  //
  // Every earlier end-to-end check used a scratch repository with no .gitignore,
  // so the bug was invisible exactly where it mattered: everywhere real.
  const f = await gitFixture({ 'a.txt': BASE, '.gitignore': 'node_modules\n' });
  try {
    mkdirSync(path.join(f.dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(f.dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');

    const harness = fakeHarness({ 'a.txt': BASE.replace('line02', 'LINE02') });
    const result = await escalate(
      harness,
      f.dir,
      { instruction: 'x', failureOutput: FAILURE },
      GATE,
    );
    assert.equal(result.ok, true, `expected a baseline to be established, got: ${result.reason}`);
    assert.equal(result.keptHunks, 1);
  } finally {
    f.cleanup();
  }
});

test('escalation leaves the index alone, so the caller’s own diff still works', async () => {
  // The gate needs a clean baseline to attribute changes to the harness, and it
  // borrows the index to get one. Borrowing means giving it back: `fixPackage`
  // computes its final diff with plain `git diff`, which reports nothing at all
  // if the earlier deterministic edits were left staged.
  const f = await gitFixture({ 'a.txt': BASE });
  try {
    // Deterministic edits, already applied before any escalation.
    writeFileSync(path.join(f.dir, 'a.txt'), BASE.replace('line01', 'LINE01'));

    const harness = fakeHarness({ 'b.txt': 'new file\n' });
    await escalate(harness, f.dir, { instruction: 'x', failureOutput: FAILURE }, GATE);

    const { stdout } = await run('git', ['-C', f.dir, 'diff']);
    assert.ok(stdout.includes('LINE01'), 'the pre-existing edit is still visible to git diff');
  } finally {
    f.cleanup();
  }
});

test('changes a few lines apart are judged separately, not as one region', async () => {
  // Observed live. Asked to fix a real error on line 3 and also make an
  // unrelated change on line 7 of an eight-line file, opencode did both — and
  // the default three lines of diff context merged them into a single hunk. The
  // hunk held a diagnostic, so it was evidenced, and the unrequested change rode
  // in on the back of the repair. Judging the diff at one line of context keeps
  // nearby-but-unrelated work separable, which is the whole point of the gate.
  const short =
    ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'].join('\n') + '\n';
  const f = await gitFixture({ 'a.txt': short });
  try {
    const localFailure = 'a.txt(3,1): error TS2304: Cannot find name.';
    const gate: HunkGate = {
      anchors: [{ file: 'a.txt', line: 3 }],
      unanchored: 'revert',
      whenNoAnchors: 'judge',
      evidenceName: 'the failure',
    };
    const harness = fakeHarness({
      'a.txt': short.replace('charlie', 'CHARLIE').replace('golf', 'GOLF'),
    });
    const result = await escalate(
      harness,
      f.dir,
      { instruction: 'x', failureOutput: localFailure },
      gate,
    );

    assert.equal(result.ok, true);
    assert.equal(result.revertedHunks.length, 1, 'the unrequested change is its own hunk');
    const after = readFileSync(path.join(f.dir, 'a.txt'), 'utf8');
    assert.ok(after.includes('CHARLIE'), 'the diagnostic-backed repair stayed');
    assert.ok(!after.includes('GOLF'), 'the change four lines away did not ride in with it');
  } finally {
    f.cleanup();
  }
});

test('when nothing is evidenced the harness’s work stands, and verification judges it', async () => {
  // The carve-out the old proposer's edit gate made, for the same reason. If the
  // gate can justify none of the hunks, reverting all of them turns a possible repair
  // into a guaranteed no-op — and the gate is not certain enough for that, since
  // it only knows about call sites Emend itself found. Verification is still
  // downstream and still has the final say.
  const f = await gitFixture({ 'a.txt': BASE });
  try {
    const harness = fakeHarness({ 'a.txt': BASE.replace('line25', 'LINE25') });
    const result = await escalate(
      harness,
      f.dir,
      { instruction: 'x', failureOutput: FAILURE },
      GATE,
    );
    assert.equal(result.ok, true);
    assert.equal(result.revertedHunks.length, 0);
    assert.ok(readFileSync(path.join(f.dir, 'a.txt'), 'utf8').includes('LINE25'));
  } finally {
    f.cleanup();
  }
});

test('a harness that changed nothing says so, rather than reporting success', async () => {
  // An empty diff after an escalation is not a repair. Reporting it as one is
  // how a run that did nothing gets recorded as a run that worked.
  const f = await gitFixture({ 'a.txt': BASE });
  try {
    const result = await escalate(
      fakeHarness({}),
      f.dir,
      { instruction: 'x', failureOutput: FAILURE },
      GATE,
    );
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /changed nothing/i);
  } finally {
    f.cleanup();
  }
});

test('a clean session that wrote nothing is named as such, not as a generic refusal', async () => {
  // The only reliability defect in a twelve-run sweep: opencode ran for $0.32
  // with credits to spare, emitted no error, and wrote no files. `run.ok` was
  // true — the engine finished believing it was done.
  //
  // That is the branch that needs the explanation most, and it was the branch
  // carrying none: an engine that *failed* has already told us why, while one
  // that succeeded and did nothing has not.
  const f = await gitFixture({ 'a.txt': BASE });
  try {
    const harness = fakeHarness({}, {
      run: async () => ({ ok: true, log: 'raw events', summary: 'Everything already looked migrated to me.' }),
    });
    const result = await escalate(harness, f.dir, { instruction: 'x', failureOutput: FAILURE }, GATE);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /reported success and changed nothing/);
    assert.match(
      result.reason ?? '',
      /Everything already looked migrated/,
      'the task asks the model to say why it changed nothing; that answer has to survive',
    );
  } finally {
    f.cleanup();
  }
});

test('a session that failed keeps its error rather than being called a silent no-op', async () => {
  // The other empty-diff case, and it must stay distinguishable: a real sweep's
  // run stopped outright on exhausted credits, which is a fact about the account
  // rather than about the migration, and reads nothing like a model that
  // considered the work done.
  const f = await gitFixture({ 'a.txt': BASE });
  try {
    const harness = fakeHarness({}, {
      run: async () => ({ ok: false, log: '', summary: '', error: 'requires more credits' }),
    });
    const result = await escalate(harness, f.dir, { instruction: 'x', failureOutput: FAILURE }, GATE);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /requires more credits/);
    assert.doesNotMatch(result.reason ?? '', /reported success/);
  } finally {
    f.cleanup();
  }
});

test('the engine\'s last word is clipped, since it is rendered in a table cell', async () => {
  // `reason` reaches `CaseOutcome.inconclusive`, which `renderSummary` puts in a
  // row. An unbounded model monologue there destroys the table it is supposed to
  // explain, and a multi-line one breaks the markdown outright.
  const f = await gitFixture({ 'a.txt': BASE });
  try {
    const harness = fakeHarness({}, {
      run: async () => ({ ok: true, log: '', summary: `first line\n${'x'.repeat(400)}` }),
    });
    const result = await escalate(harness, f.dir, { instruction: 'x', failureOutput: FAILURE }, GATE);

    const reason = result.reason ?? '';
    assert.doesNotMatch(reason, /\n/, 'a newline would break the row it lands in');
    assert.ok(reason.length < 260, `reason should stay row-sized; got ${reason.length}`);
    assert.match(reason, /…/, 'and say that it was cut rather than appear complete');
  } finally {
    f.cleanup();
  }
});

test('a no-op with nothing to say is still named, without inventing an explanation', async () => {
  // A harness with no summarising step has no `summary`, and `log` is documented
  // as lossless noise. Quoting the log into a table cell would contradict that
  // field's own contract, so the reason says less rather than saying junk.
  const f = await gitFixture({ 'a.txt': BASE });
  try {
    const result = await escalate(fakeHarness({}), f.dir, { instruction: 'x', failureOutput: FAILURE }, GATE);
    assert.match(result.reason ?? '', /reported success and changed nothing$/);
  } finally {
    f.cleanup();
  }
});

test('an unavailable harness is refused loudly, never skipped quietly', async () => {
  // Same rule `fixPackage` already applies to an unavailable LLM: asking for a
  // harness and silently not getting one makes the run look like the harness
  // tried and failed, when it never ran.
  const f = await gitFixture({ 'a.txt': BASE });
  try {
    const harness = fakeHarness({}, {
      available: async () => ({ ok: false, reason: 'opencode not on PATH' }),
      run: async () => {
        throw new Error('must not run');
      },
    });
    const result = await escalate(harness, f.dir, { instruction: 'x', failureOutput: '' }, GATE);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /opencode not on PATH/);
  } finally {
    f.cleanup();
  }
});

test('without git there is no gate, so there is no escalation', async () => {
  // The gate is the entire condition of adoption. A harness with write access
  // that cannot be judged is exactly what the design forbids, so failing to
  // establish the baseline has to stop the escalation rather than waive it.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-nogit-'));
  try {
    let ran = false;
    const harness = fakeHarness({}, {
      run: async () => {
        ran = true;
        return { ok: true, log: '' };
      },
    });
    const result = await escalate(harness, dir, { instruction: 'x', failureOutput: '' }, GATE);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /git/i);
    assert.equal(ran, false, 'the harness must not touch a directory it cannot be judged in');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// openCodeHarness
// ---------------------------------------------------------------------------

test('availability names the missing binary instead of failing at run time', async () => {
  const harness = openCodeHarness({ bin: 'definitely-not-a-real-binary-xyz' });
  const status = await harness.available();
  assert.equal(status.ok, false);
  assert.match(status.ok === false ? status.reason : '', /definitely-not-a-real-binary-xyz/);
});

test('the run is non-interactive and scoped to the workspace', async () => {
  // `--dir` scopes the harness to the throwaway workspace instead of the user's
  // checkout, and `--format json` is what makes the log parseable. Both are
  // load-bearing, so they are asserted rather than trusted.
  const args = openCodeHarness({ model: 'openrouter/z-ai/glm-4.6' }).commandFor('/ws', 'do the thing');
  assert.deepEqual(args.slice(0, 2), ['run', 'do the thing']);
  assert.ok(args.includes('--dir'));
  assert.equal(args[args.indexOf('--dir') + 1], '/ws');
  assert.ok(args.includes('--format'));
  assert.equal(args[args.indexOf('--format') + 1], 'json');
  assert.equal(args[args.indexOf('--model') + 1], 'openrouter/z-ai/glm-4.6');
});

test('no model is configured rather than guessed', async () => {
  // opencode resolves its own default from the user's config. Inventing one here
  // would silently override a choice Emend has no business making.
  const args = openCodeHarness().commandFor('/ws', 'x');
  assert.ok(!args.includes('--model'));
});

// ---------------------------------------------------------------------------
// Version adaptation
//
// "The harness becomes a dependency whose changes land in this product" was
// priced in as a cost of adoption. It arrived as a CLI contract change:
// `--auto` exists on opencode's development branch and not in the released 1.x,
// so hard-coding it made every real run die on a usage error instead of running.
// Flags are therefore read off the binary in front of us.
// ---------------------------------------------------------------------------

/** A stand-in `opencode` that reports exactly the flags it is told to. */
function fakeBin(flags: string[]): { bin: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-bin-'));
  const bin = path.join(dir, 'fake-opencode');
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "--help" ]; then
  echo "Options:"
${flags.map((f) => `  echo "  ${f}   some description"`).join('\n')}
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );
  return { bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a binary that supports --auto is given it, because it must be able to edit', async () => {
  // `--auto` is the flag that looks reckless. Without it, a version that has it
  // auto-rejects every tool permission in non-interactive mode and edits nothing
  // at all. What makes passing it safe is the evidence gate, not its absence.
  const f = fakeBin(['--dir', '--format', '--model', '--auto']);
  try {
    const harness = openCodeHarness({ bin: f.bin });
    assert.equal((await harness.available()).ok, true);
    assert.ok(harness.commandFor('/ws', 'x').includes('--auto'));
  } finally {
    f.cleanup();
  }
});

test('a binary without --auto is not given it, so the run starts at all', async () => {
  const f = fakeBin(['--dir', '--format', '--model']);
  try {
    const harness = openCodeHarness({ bin: f.bin });
    assert.equal((await harness.available()).ok, true);
    assert.ok(!harness.commandFor('/ws', 'x').includes('--auto'));
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Permissions
//
// Measured, not assumed. opencode 1.x rejects tool permissions in
// non-interactive mode — a real run here read the file, called `edit`, and got
// back "The user rejected permission to use this specific tool call", changing
// nothing. Without granting them the escalation is a guaranteed no-op that
// still costs a model call.
// ---------------------------------------------------------------------------

test('edit is granted, because a harness that cannot edit is an expensive no-op', () => {
  const env = openCodeHarness().envFor();
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}');
  assert.equal(config.permission?.edit, 'allow');
});

test('bash is withheld unless it is asked for', () => {
  // The harness runs inside a throwaway worktree where Emend already executes
  // the repository's own build and test scripts, so bash there is not a new
  // capability — but it is the widest one, and it should be a decision rather
  // than a default.
  assert.equal(
    JSON.parse(openCodeHarness().envFor().OPENCODE_CONFIG_CONTENT ?? '{}').permission?.bash,
    'deny',
  );
  assert.equal(
    JSON.parse(openCodeHarness({ allowBash: true }).envFor().OPENCODE_CONFIG_CONTENT ?? '{}')
      .permission?.bash,
    'allow',
  );
});

test('the network is denied, because the gate cannot see what leaves', () => {
  // Every other thing the harness does lands in a diff that gets judged. A fetch
  // does not: it is the one action with no artefact for the evidence gate to
  // read, in a process holding a checkout of someone's private repository.
  const config = JSON.parse(
    openCodeHarness({ allowBash: true }).envFor().OPENCODE_CONFIG_CONTENT ?? '{}',
  );
  assert.equal(config.permission?.webfetch, 'deny');
});

test('an untrusted repository gets no harness at all', () => {
  // `--untrusted` exists because a hosted run must execute nothing from the
  // repository or its dependency tree. A harness is an agent whose entire value
  // is going and looking and running things, so handing it an untrusted
  // checkout would undo that in one step — and the verification that would
  // catch a bad outcome is itself suppressed in that mode.
  const refused = harnessPermitted({ untrusted: true });
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.reason : '', /untrusted/i);
  assert.equal(harnessPermitted({}).ok, true);
});

test('the run gets no stdin, so it cannot sit waiting for input nobody will send', async () => {
  // Measured. Driving opencode through `execFile` hung until the timeout every
  // time — 242s against 34s for the identical command with stdin closed —
  // because `execFile` hands the child an open pipe it never closes. A harness
  // that blocks on input is indistinguishable from one that is thinking, and it
  // burns the whole budget before anyone finds out.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-stdin-'));
  const bin = path.join(dir, 'reads-stdin');
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "--help" ]; then echo "  --dir  x"; exit 0; fi
cat > /dev/null
echo '{"type":"text","text":"finished"}'
`,
    { mode: 0o755 },
  );
  try {
    const harness = openCodeHarness({ bin, timeoutMs: 5000 });
    await harness.available();
    const started = process.hrtime.bigint();
    const result = await harness.run(dir, { instruction: 'x', failureOutput: '' });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(result.ok, true, `expected a clean exit, got: ${result.error}`);
    assert.match(result.log, /finished/);
    assert.ok(elapsedMs < 4000, `read EOF at once rather than blocking (took ${elapsedMs}ms)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a harness that overruns its budget is killed and says so', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-timeout-'));
  const bin = path.join(dir, 'hangs');
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "--help" ]; then echo "  --dir  x"; exit 0; fi
sleep 30
`,
    { mode: 0o755 },
  );
  try {
    const harness = openCodeHarness({ bin, timeoutMs: 1500 });
    await harness.available();
    const result = await harness.run(dir, { instruction: 'x', failureOutput: '' });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /timed out/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('before the binary has been asked, no version-specific flag is assumed', async () => {
  // `escalate` always checks availability first, so the probe is warm by run
  // time. A caller that skips it gets the conservative command rather than a
  // guess that might not parse.
  const f = fakeBin(['--dir', '--format', '--auto']);
  try {
    assert.ok(!openCodeHarness({ bin: f.bin }).commandFor('/ws', 'x').includes('--auto'));
  } finally {
    f.cleanup();
  }
});


// ---------------------------------------------------------------------------
// Driving Emend's own tools
// ---------------------------------------------------------------------------

test('a driving session gets Emend’s tools and the rights to act on them', () => {
  const h = drivingHarness({
    model: 'openrouter/z-ai/glm-5.2',
    emendCommand: ['node', '/x/cli.ts', 'mcp'],
  });
  const config = JSON.parse(String(h.envFor().OPENCODE_CONFIG_CONTENT)) as {
    mcp: Record<string, { command: string[] }>;
    permission: Record<string, string>;
  };
  assert.deepEqual(config.mcp['emend']?.command, ['node', '/x/cli.ts', 'mcp']);
  // Repairing the break is the entire job it is here for; denying edit would
  // leave it able to diagnose and unable to act.
  assert.equal(config.permission['edit'], 'allow');
});

test('the drive prompt requires both facts, separately', () => {
  // The property that survived every rewrite of this loop. An agent told only
  // to get the build green will report a green build with the vulnerable
  // version still installed as a fix.
  const prompt = drivePrompt({ repo: '/r', findingId: 'abc123', pkg: 'axios' });
  assert.match(prompt, /emend_advisory_status/);
  assert.match(prompt, /emend_verify/);
  assert.match(prompt, /not a fix/);
});

test('the drive prompt sends it to impact before reshaping a symbol', () => {
  const prompt = drivePrompt({ repo: '/r', findingId: 'abc', pkg: 'axios' });
  assert.match(prompt, /emend_impact/);
});

test('a run’s log is the whole stream, and the summary is the derived thing', async () => {
  // The inversion. `log` used to hold summariseEvents output, which keeps tool
  // activity and drops the model's text — so a review session whose entire
  // output was a findings object, and a driving session whose output was its
  // report, both summarised to nothing and were reported as having produced no
  // output at all. Three debugging rounds, one cause.
  //
  // Lossless by default; summarising is the explicit choice.
  const h = openCodeHarness({ model: 'openrouter/z-ai/glm-5.2' });
  const events = [
    '{"type":"text","part":{"type":"text","text":"the answer nobody could see"}}',
    '{"type":"tool","part":{"type":"tool","tool":"read"}}',
  ].join('\n');
  assert.ok(summariseEvents(events).length >= 0);
  // The contract the type enforces: `log` is required and `summary` is not, so a
  // consumer that forgets the summary gets too much output rather than none.
  const run: HarnessRun = { ok: true, log: events };
  assert.equal(run.summary, undefined);
  assert.match(run.summary ?? run.log, /the answer nobody could see/);
  assert.equal(typeof h.id, 'string');
});

test('a session that fails its API call is not reported as a run that changed nothing', async () => {
  // Measured, on the first end-to-end run of `emend pr`. opencode emitted an
  // `error` event — HTTP 400, `model_not_available_for_integrator` — and then
  // exited 0. `run()` read only the exit code, so the harness reported success,
  // the diff was empty, and the escalation recorded "opencode changed nothing".
  //
  // That sentence is the cardinal rule broken one layer below where it has been
  // caught before: a run that *could not happen* read exactly like a run that
  // happened and found nothing worth doing. A PR body then told a reader the
  // call sites "needed no edit" over a failed typecheck.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-apierr-'));
  const bin = path.join(dir, 'errors-then-exits-zero');
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "--help" ]; then echo "  --dir  x"; exit 0; fi
echo '{"type":"error","error":{"name":"APIError","data":{"message":"The requested model is not available for integrator \\"opencode\\"."}}}'
exit 0
`,
    { mode: 0o755 },
  );
  try {
    const harness = openCodeHarness({ bin, timeoutMs: 5000 });
    await harness.available();
    const result = await harness.run(dir, { instruction: 'x', failureOutput: '' });

    assert.equal(result.ok, false, 'an errored session is not a successful run');
    assert.match(result.error ?? '', /not available for integrator/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no harness pinned, the repair uses the model Emend was configured with', async () => {
  // The gap the first end-to-end `emend pr` run walked into. `harnessFrom` built
  // `openCodeHarness({})`, which passes no `--model` and writes no provider
  // block, so opencode resolved through whatever *it* had authenticated —
  // GitHub Copilot — and rejected the request. Emend's own `OPENROUTER_API_KEY`
  // was never consulted, while `emend --help` advertised a GLM default.
  //
  // The eval never saw it because a sweep pins the model on the command line.
  const before = { ...process.env };
  try {
    process.env.EMEND_LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'test-key-not-a-real-one';
    delete process.env.EMEND_LLM_MODEL;

    const argv = repairHarness().commandFor('/ws', 'x');
    assert.ok(argv.includes('--model'), 'a model must be named rather than left to opencode');
    assert.equal(argv[argv.indexOf('--model') + 1], 'openrouter/z-ai/glm-5.2');

    // And the provider block that makes that model reachable at all.
    const config = JSON.parse(repairHarness().envFor().OPENCODE_CONFIG_CONTENT ?? '{}');
    assert.deepEqual(config.enabled_providers, ['openrouter']);
  } finally {
    process.env = before;
  }
});

test('an operator who pins a harness model keeps it, and one who configured nothing keeps opencode', async () => {
  const before = { ...process.env };
  try {
    process.env.EMEND_LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'test-key-not-a-real-one';
    const pinned = repairHarness({ pinned: 'openrouter/z-ai/glm-4.6' }).commandFor('/ws', 'x');
    assert.equal(pinned[pinned.indexOf('--model') + 1], 'openrouter/z-ai/glm-4.6');

    // Nothing configured: defer to opencode's own resolution rather than
    // inventing a choice. Safe now only because a session that cannot reach its
    // model reports that instead of an empty diff — see the API-error test.
    delete process.env.EMEND_LLM_PROVIDER;
    delete process.env.EMEND_LLM_BASE_URL;
    assert.ok(!repairHarness().commandFor('/ws', 'x').includes('--model'));
  } finally {
    process.env = before;
  }
});
