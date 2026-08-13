/**
 * Every word of every prompt, pinned.
 *
 * What a prompt is worth is measured by running it, so changing one is an
 * experiment. These goldens make an accidental change impossible and a
 * deliberate one visible: the four system prompts run to 13KB and differ from
 * each other in ways a reader glides over, so "provably unchanged" cannot mean a
 * careful reading.
 *
 * They were first taken from the hand-written builders, and held byte-identical
 * across the tasks-and-skills restructuring — which is what made that a refactor
 * rather than an experiment. The one-writer decision then changed the engine
 * underneath them: an agent that writes files cannot be told to emit a JSON
 * edit set, so the rules that said so had to go. **That regeneration is the
 * experiment the eval exists to judge**, and what is on trial is the engine,
 * measured on the corpus.
 *
 * A diff here is therefore one of two things: a mistake, or a change that owes
 * an eval run. Refreshing them to get to green, without knowing which, is the
 * one action that makes the whole exercise pointless.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  systemPrompt,
  MIGRATION_TASK,
  TIGHTENING_TASK,
  REVIEW_TASK,
  LINT_TASK,
  NARROWING,
  WRITE_AND_REPORT,
} from '../src/harness.ts';
import {
  MIGRATION_FULL,
  MIGRATION_MINIMAL,
  TIGHTENING,
  REVIEW_FULL,
  REVIEW_GAPS_NO_CANDIDATES,
  REVIEW_CLEAN,
  LINT,
} from './fixtures/prompt-contexts.ts';

const DIR = join(import.meta.dirname, 'fixtures/prompts');

function golden(name: string): string {
  const text = readFileSync(join(DIR, `${name}.txt`), 'utf8');
  // A golden that went missing or empty would let every assertion below pass by
  // comparing nothing to nothing, which is the failure mode a snapshot test dies
  // of quietly.
  assert.ok(text.length > 200, `golden ${name} is too small to be the real prompt`);
  return text;
}

test('the migration task composes exactly what its builders produced', () => {
  const full = { system: systemPrompt(MIGRATION_TASK), user: MIGRATION_TASK.render(MIGRATION_FULL) };
  assert.equal(full.system, golden('system-migration'));
  assert.equal(full.user, golden('user-migration-full'));

  // The same task with every optional section absent: candidates, impact,
  // compiler output and attempt history each have to vanish completely rather
  // than leave their heading behind.
  const minimal = { system: systemPrompt(MIGRATION_TASK), user: MIGRATION_TASK.render(MIGRATION_MINIMAL) };
  assert.equal(minimal.user, golden('user-migration-minimal'));
});

test('the tightening task composes exactly what its builders produced', () => {
  const composed = { system: systemPrompt(TIGHTENING_TASK), user: TIGHTENING_TASK.render(TIGHTENING) };
  assert.equal(composed.system, golden('system-tightening'));
  assert.equal(composed.user, golden('user-tightening'));
});

test('the review task composes exactly what its builders produced', () => {
  const full = { system: systemPrompt(REVIEW_TASK), user: REVIEW_TASK.render(REVIEW_FULL) };
  assert.equal(full.system, golden('system-review'));
  assert.equal(full.user, golden('user-review-full'));

  // The deprecation block is the only doubly-nested section in any renderer —
  // gaps gate the block, candidates gate a part of it — so it gets both halves
  // of its own branch rather than only the path the full fixture takes.
  assert.equal(
    REVIEW_TASK.render(REVIEW_GAPS_NO_CANDIDATES),
    golden('user-review-gaps-no-candidates'),
  );
  assert.equal(REVIEW_TASK.render(REVIEW_CLEAN), golden('user-review-clean'));
});

test('the lint task composes exactly what its builders produced', () => {
  const composed = { system: systemPrompt(LINT_TASK), user: LINT_TASK.render(LINT) };
  assert.equal(composed.system, golden('system-lint'));
  assert.equal(composed.user, golden('user-lint'));
});

// ---------------------------------------------------------------------------
// What the restructuring is FOR
//
// Byte-identity proves nothing was lost. These prove something was gained: the
// relationships between the four jobs are now expressed as the presence or
// absence of a named thing, which is checkable, rather than as prose repeated in
// four files, which is not.
// ---------------------------------------------------------------------------

test('the narrowing rule is one object shared by the tasks that can meet a union', () => {
  // By identity, not by substring. A substring check passes just as happily on
  // two copies that have started to drift, which is the exact bug this replaces:
  // the rule lived in the tightening prompt alone, so a migration that had to
  // narrow a union wrote `Number(value)` unguided and rendered `$NaN` in a chart
  // that typechecked and passed every test.
  assert.ok(MIGRATION_TASK.rules.includes(NARROWING));
  assert.ok(TIGHTENING_TASK.rules.includes(NARROWING));
});

test('the review task deliberately excludes the narrowing rule', () => {
  // Not an oversight to be tidied up later. Review is a restructuring pass over
  // code that already compiles; it is not narrowing anything, and every rule it
  // does not need is context spent on something it must ignore. Recording the
  // exclusion is the point of naming the skill — otherwise the difference
  // between "decided against" and "forgot" is invisible.
  assert.ok(!REVIEW_TASK.rules.includes(NARROWING));
  assert.ok(!LINT_TASK.rules.includes(NARROWING));
});

test('all four tasks share one statement of how a writing job reports', () => {
  // Lint used to spell the same contract out inline, in its own words, because
  // the two were kept in step by hand and nobody had noticed they were the same
  // requirement. There was a parser for them to disagree about; the one-writer
  // decision removed it,
  // and with it the reason to have two.
  for (const closing of [
    MIGRATION_TASK.closing,
    TIGHTENING_TASK.closing,
    REVIEW_TASK.closing,
    LINT_TASK.closing,
  ]) {
    assert.ok(closing.includes(WRITE_AND_REPORT));
  }
});

test('no task asks a writing agent for a JSON edit set', () => {
  // The failure this prevents is quiet and total: told to emit JSON, an agent
  // with write access describes the change instead of making it, the diff is
  // empty, and the run reports that there was nothing to repair.
  const composed = [
    systemPrompt(MIGRATION_TASK),
    systemPrompt(TIGHTENING_TASK),
    systemPrompt(REVIEW_TASK),
    systemPrompt(LINT_TASK),
  ];
  // Matching the *ask*, not the word. The skill that replaced these says "do
  // not print ... a JSON object", so a looser pattern flags the fix as the bug.
  const asks = /Output ONLY a JSON|Reply with JSON only|return an empty "edits"|"find" MUST be an exact substring/i;
  for (const text of composed) {
    assert.ok(!asks.test(text), text.slice(0, 60));
  }
});
