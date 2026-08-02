import test from 'node:test';
import assert from 'node:assert/strict';
import { compare } from '../src/verify.ts';
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
