/**
 * The prompts are the same bytes after being restructured as they were before.
 *
 * This is the whole licence for the tasks-and-skills refactor. What a prompt is
 * worth is measured by running it, so changing one is an experiment and belongs
 * in its own commit with an eval behind it. Rearranging *where the words live*
 * is only a refactor while the words are provably identical — and "provably"
 * cannot mean a careful reading, because the four system prompts run to 13KB and
 * differ from each other in ways a reader glides over.
 *
 * The goldens were generated from the hand-written builders at the commit before
 * they moved. They are not a snapshot of current behaviour that gets refreshed
 * when it changes; they are the measured wording, and a diff here means either a
 * mistake in the restructuring or a deliberate experiment that needs its own
 * commit and its own eval run. Refreshing them to make this pass is the one
 * thing that would make the whole exercise pointless.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  composePrompts,
  MIGRATION_TASK,
  TIGHTENING_TASK,
  REVIEW_TASK,
  LINT_TASK,
  NARROWING,
  RESPONSE_SHAPE,
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
  const full = composePrompts(MIGRATION_TASK, MIGRATION_FULL);
  assert.equal(full.system, golden('system-migration'));
  assert.equal(full.user, golden('user-migration-full'));

  // The same task with every optional section absent: candidates, impact,
  // compiler output and attempt history each have to vanish completely rather
  // than leave their heading behind.
  const minimal = composePrompts(MIGRATION_TASK, MIGRATION_MINIMAL);
  assert.equal(minimal.user, golden('user-migration-minimal'));
});

test('the tightening task composes exactly what its builders produced', () => {
  const composed = composePrompts(TIGHTENING_TASK, TIGHTENING);
  assert.equal(composed.system, golden('system-tightening'));
  assert.equal(composed.user, golden('user-tightening'));
});

test('the review task composes exactly what its builders produced', () => {
  const full = composePrompts(REVIEW_TASK, REVIEW_FULL);
  assert.equal(full.system, golden('system-review'));
  assert.equal(full.user, golden('user-review-full'));

  // The deprecation block is the only doubly-nested section in any renderer —
  // gaps gate the block, candidates gate a part of it — so it gets both halves
  // of its own branch rather than only the path the full fixture takes.
  assert.equal(
    composePrompts(REVIEW_TASK, REVIEW_GAPS_NO_CANDIDATES).user,
    golden('user-review-gaps-no-candidates'),
  );
  assert.equal(composePrompts(REVIEW_TASK, REVIEW_CLEAN).user, golden('user-review-clean'));
});

test('the lint task composes exactly what its builders produced', () => {
  const composed = composePrompts(LINT_TASK, LINT);
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

test('lint states the response contract in its own words, and that is visible', () => {
  // The three repair tasks share one response-shape skill. Lint does not: its
  // prompt spells the same contract out inline, more compactly. That divergence
  // is real and is preserved byte-for-byte above — naming it here means the next
  // person to touch the parser can see there are two statements of its contract
  // to keep in step, instead of finding out from a dropped edit.
  assert.ok(MIGRATION_TASK.closing.includes(RESPONSE_SHAPE));
  assert.ok(TIGHTENING_TASK.closing.includes(RESPONSE_SHAPE));
  assert.ok(REVIEW_TASK.closing.includes(RESPONSE_SHAPE));
  assert.ok(!LINT_TASK.closing.includes(RESPONSE_SHAPE));
});
