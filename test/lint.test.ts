import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hadolintAdapter, shellcheckAdapter } from '../src/lint.ts';

function scratch(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-lint-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A stand-in that prints a fixed report and exits the way real linters do. */
function fakeTool(stdout: string, exitCode: number): { bin: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-linter-'));
  const bin = path.join(dir, 'fake-linter');
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "1.0.0"; exit 0; fi
cat <<'REPORT'
${stdout}
REPORT
exit ${exitCode}
`,
    { mode: 0o755 },
  );
  return { bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// The trap
// ---------------------------------------------------------------------------

test('a linter exiting non-zero because it found things is not a failure', async () => {
  // Measured on both tools: `hadolint -f json` and `shellcheck --format=json1`
  // exit 1 with a full report on stdout. Treating that as an error discards
  // every finding, and the tool then looks like it ran and found nothing —
  // which is the worst possible way for a check to fail.
  const report = JSON.stringify([
    { code: 'DL3006', column: 1, file: 'Dockerfile', level: 'warning', line: 1, message: 'Always tag' },
  ]);
  const tool = fakeTool(report, 1);
  const s = scratch({ Dockerfile: 'FROM node\n' });
  try {
    const result = await hadolintAdapter({ bin: tool.bin }).run(s.dir, ['Dockerfile']);
    assert.equal(result.findings.length, 1);
    assert.equal(result.error, undefined);
    assert.equal(result.findings[0]?.code, 'DL3006');
  } finally {
    tool.cleanup();
    s.cleanup();
  }
});

test('a non-zero exit with nothing parseable is a failure, and says so', async () => {
  const tool = fakeTool('hadolint: command failed', 127);
  const s = scratch({ Dockerfile: 'FROM node\n' });
  try {
    const result = await hadolintAdapter({ bin: tool.bin }).run(s.dir, ['Dockerfile']);
    assert.deepEqual(result.findings, []);
    assert.ok(result.error, 'a genuine failure is reported rather than read as clean');
  } finally {
    tool.cleanup();
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Two tools, two envelopes
// ---------------------------------------------------------------------------

test('shellcheck’s report is wrapped, unlike hadolint’s bare array', async () => {
  // Confirmed live. Assuming one shape for both parses nothing for the other.
  const report = JSON.stringify({
    comments: [
      { file: 'deploy.sh', line: 3, column: 6, level: 'info', code: 2086, message: 'Double quote' },
    ],
  });
  const tool = fakeTool(report, 1);
  const s = scratch({ 'deploy.sh': '#!/bin/sh\n' });
  try {
    const result = await shellcheckAdapter({ bin: tool.bin }).run(s.dir, ['deploy.sh']);
    assert.equal(result.findings.length, 1);
    // Numeric on the wire, `SC2086` in its own documentation and in every
    // suppression directive anybody will paste.
    assert.equal(result.findings[0]?.code, 'SC2086');
    assert.equal(result.findings[0]?.line, 3);
  } finally {
    tool.cleanup();
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// What each tool is asked about
// ---------------------------------------------------------------------------

test('each tool is offered only the files it has an opinion about', () => {
  const files = ['Dockerfile', 'api.Dockerfile', 'Dockerfile.prod', 'deploy.sh', 'src/app.ts', 'run.bash'];
  assert.deepEqual(hadolintAdapter().applies(files), ['Dockerfile', 'api.Dockerfile', 'Dockerfile.prod']);
  assert.deepEqual(shellcheckAdapter().applies(files), ['deploy.sh', 'run.bash']);
});

test('a repository with nothing to lint costs no process at all', async () => {
  const s = scratch({});
  try {
    const result = await hadolintAdapter({ bin: 'definitely-not-installed-xyz' }).run(s.dir, []);
    assert.deepEqual(result.findings, []);
    assert.equal(result.error, undefined);
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Absence
// ---------------------------------------------------------------------------

test('a tool that is not installed is named, never treated as clean', async () => {
  const status = await hadolintAdapter({ bin: 'definitely-not-installed-xyz' }).available();
  assert.equal(status.ok, false);
  assert.match(status.ok === false ? status.reason : '', /definitely-not-installed-xyz/);
});
