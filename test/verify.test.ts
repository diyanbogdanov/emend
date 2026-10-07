import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, countDiagnostics, verificationPassed } from '../src/verify.ts';
import type { CommandResult } from '../src/types.ts';

const pass = (command: string): CommandResult => ({
  command, ok: true, exitCode: 0, stdout: '', stderr: '',
});
const fail = (command: string): CommandResult => ({
  command, ok: false, exitCode: 1, stdout: '', stderr: 'boom',
});
const skip = (command: string, reason: string): CommandResult => ({
  command, ok: false, exitCode: null, stdout: '', stderr: '', skipped: true, skipReason: reason,
});

test('a repository that was already failing is not blamed for a regression', () => {
  // This is why the baseline exists. Without it, every red repository would be
  // told that Emend broke it, and the tool would be uninstalled on first run.
  const report = compare(
    { typecheck: pass('tsc'), test: fail('npm test') },
    { typecheck: pass('tsc'), test: fail('npm test') },
  );
  assert.equal(report.outcome, 'pre-existing-failure');
  assert.match(report.summary, /already failing/);
});

test('green baseline plus red post-change is a regression', () => {
  const report = compare(
    { typecheck: pass('tsc'), test: pass('npm test') },
    { typecheck: fail('tsc'), test: pass('npm test') },
  );
  assert.equal(report.outcome, 'regression');
});

test('green both sides is verified', () => {
  const report = compare(
    { typecheck: pass('tsc'), test: pass('npm test') },
    { typecheck: pass('tsc'), test: pass('npm test') },
  );
  assert.equal(report.outcome, 'verified');
});

test('a repo with no tests is typecheck-only, never reported as tests passing', () => {
  // Claiming "tests pass" when no tests ran is the kind of quiet dishonesty that
  // makes an automated migration tool dangerous.
  const report = compare(
    { typecheck: pass('tsc'), test: skip('npm test', 'no test script') },
    { typecheck: pass('tsc'), test: skip('npm test', 'no test script') },
  );
  assert.equal(report.outcome, 'typecheck-only');
  assert.match(report.summary, /NOT verified/);
});

test('a repo with nothing runnable is unverified, not passing', () => {
  const report = compare(
    { typecheck: skip('tsc', 'no tsconfig'), test: skip('npm test', 'no test script') },
    { typecheck: skip('tsc', 'no tsconfig'), test: skip('npm test', 'no test script') },
  );
  assert.equal(report.outcome, 'unverified');
  assert.match(report.summary, /UNVERIFIED/);
});

test('a skipped command never counts as a failure', () => {
  const report = compare(
    { typecheck: pass('tsc'), test: skip('npm test', 'no test script') },
    { typecheck: pass('tsc'), test: skip('npm test', 'no test script') },
  );
  assert.notEqual(report.outcome, 'regression');
});

test('only a verified or typecheck-only migration may open a pull request', () => {
  // Found by accident: the CLI refused to push only on `regression`, so a
  // `pre-existing-failure` — the repository was already broken, therefore nothing
  // was proven — sailed through and would have force-pushed onto a live PR whose
  // body implies verification. An allowlist fails closed if an outcome is added.
  assert.equal(verificationPassed('verified'), true);
  assert.equal(verificationPassed('typecheck-only'), true);
  assert.equal(verificationPassed('regression'), false);
  assert.equal(verificationPassed('pre-existing-failure'), false);
  assert.equal(verificationPassed('unverified'), false);
});

// ---------------------------------------------------------------------------
// Counting what the compiler objected to.
// ---------------------------------------------------------------------------

const withOutput = (stdout: string, stderr = ''): CommandResult => ({
  command: 'tsc --noEmit', ok: false, exitCode: 1, stdout, stderr,
});

test('tsc diagnostics are counted by location, in either format', () => {
  // The denominator for `Err. reduced`. It went uncounted for the life of the
  // benchmark and every engine reported reducing 0% of the errors as a result,
  // so the number this produces is the difference between that column being a
  // measurement and being a decoration.
  assert.equal(
    countDiagnostics(
      withOutput(
        [
          "src/schema.ts(28,15): error TS2554: Expected 1 arguments, but got 2.",
          "src/schema.ts(41,23): error TS2339: Property 'errors' does not exist.",
        ].join('\n'),
      ),
    ),
    2,
  );

  // The format everything that is not tsc emits.
  assert.equal(
    countDiagnostics(withOutput('src/client.ts:7:1: error: cannot find module')),
    1,
  );
});

test('one location complained about twice is one problem', () => {
  // Both patterns run over the same text, and a monorepo runner repeats a line
  // under its workspace prefix. Counting matches rather than locations roughly
  // doubles the number on exactly the repositories where it matters, and a
  // doubled denominator makes an engine look like it cleared half of what it did.
  const repeated = [
    'src/schema.ts(28,15): error TS2554: Expected 1 arguments, but got 2.',
    'src/schema.ts(28,15): error TS2554: Expected 1 arguments, but got 2.',
  ].join('\n');
  assert.equal(countDiagnostics(withOutput(repeated)), 1);
});

test('errors on stderr are counted too, since that is where some tools put them', () => {
  assert.equal(countDiagnostics(withOutput('', 'src/a.ts(1,1): error TS1005: expected')), 1);
});

test('a clean or skipped typecheck counts nothing', () => {
  assert.equal(countDiagnostics(pass('tsc')), 0);
  assert.equal(countDiagnostics(skip('tsc', 'no tsconfig.json')), 0);
  // Warnings are not errors. A count that swept them in would report a
  // repository as damaged by an upgrade that only made it noisier.
  assert.equal(countDiagnostics(withOutput('src/a.ts(1,1): warning TS6133: unused')), 0);
});

// ---------------------------------------------------------------------------
// The `verified` summary must only claim what actually ran.
// ---------------------------------------------------------------------------

test('a pass with a skipped typecheck does not claim the typecheck ran', () => {
  // `compare`'s final branch is reached whenever the tests ran and passed —
  // including when the typecheck was skipped, which happens for any repository
  // with a test script and no tsconfig.json. Its summary said "typecheck and
  // tests are green", asserting something that did not happen. The mirror case,
  // `typecheck-only`, was always careful about this: its own comment says
  // asserting one claim when another is true "is simply false".
  const skippedTypecheck = {
    typecheck: skip('tsc', 'no typecheck script and no tsconfig.json'),
    test: pass('npm test'),
  };
  const report = compare(skippedTypecheck, skippedTypecheck);
  assert.equal(report.outcome, 'verified');
  assert.doesNotMatch(report.summary, /typecheck and tests are green/);
  assert.match(report.summary, /types were not checked|typecheck did not run/i);
});

test('a pass with both steps run still says typecheck and tests are green', () => {
  // Companion to the test above: pins that the skipped-typecheck wording fix
  // did not flip the summary for the ordinary case where both steps ran.
  const bothRan = { typecheck: pass('tsc'), test: pass('npm test') };
  const report = compare(bothRan, bothRan);
  assert.equal(report.outcome, 'verified');
  assert.match(report.summary, /typecheck and tests are green/);
});
