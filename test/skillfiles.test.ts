import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSkill, BUILT_IN_SKILLS, REVIEW_SKILL_DEFAULT } from '../src/llm/skillfiles.ts';

function skillDir(name: string, body: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'emend-skills-'));
  mkdirSync(path.join(root, name), { recursive: true });
  writeFileSync(path.join(root, name, 'SKILL.md'), body);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a skill is its file, so swapping one is swapping a file', () => {
  // The point of the format. A skill that lives in a `.ts` constant can only be
  // changed by changing Emend; one that lives in a `SKILL.md` can be changed by
  // whoever is running it, which is what makes "use a different reviewer" a
  // configuration rather than a fork.
  const f = skillDir(
    'house-style',
    `---
name: house-style
description: How we like it here.
---

# House Style

Tabs, and never apologise in a comment.
`,
  );
  try {
    const skill = loadSkill(path.join(f.root, 'house-style'));
    assert.equal(skill.name, 'house-style');
    assert.match(skill.text, /Tabs, and never apologise/);
    // The frontmatter is metadata, not instruction — it must not reach the model
    // as though it were a rule.
    assert.doesNotMatch(skill.text, /^---/);
    assert.doesNotMatch(skill.text, /description: How we like it here/);
  } finally {
    f.cleanup();
  }
});

test('a skill with no frontmatter is still a skill, named for its directory', () => {
  // Nothing about a body of instructions requires a YAML header, and refusing
  // one because it lacks metadata would mean the simplest possible skill is the
  // one Emend cannot load.
  const f = skillDir('bare', 'Just do the thing.\n');
  try {
    const skill = loadSkill(path.join(f.root, 'bare'));
    assert.equal(skill.name, 'bare');
    assert.equal(skill.text.trim(), 'Just do the thing.');
  } finally {
    f.cleanup();
  }
});

test('a skill that is not there fails loudly, naming what it looked for', () => {
  // A silently-skipped skill is a review running under rules nobody chose, and
  // reporting normally. The operator asked for a named reviewer; not having it
  // is not a reason to quietly use a different one.
  assert.throws(
    () => loadSkill('/definitely/not/a/skill/anywhere'),
    /SKILL\.md/,
  );
});

test('the built-in skills load, and the review defaults to the quality one', () => {
  // Both ship in the repository rather than being inlined, so the default and a
  // replacement are the same kind of thing — the swap has no special case.
  const names = BUILT_IN_SKILLS.map((s) => s.name).sort();
  assert.deepEqual(names, ['migration-completeness', 'thermo-nuclear-code-quality-review']);

  const review = loadSkill(REVIEW_SKILL_DEFAULT);
  assert.equal(review.name, 'thermo-nuclear-code-quality-review');
  assert.match(review.text, /code judo/i, 'the ambition rule is what this skill is for');
  assert.match(review.text, /1k lines|1000 lines/, 'and the file-size bar');
});

test('a built-in resolves by bare name, so nobody types a path to get the default', () => {
  const skill = loadSkill('migration-completeness');
  assert.equal(skill.name, 'migration-completeness');
  assert.match(skill.text, /Finish the migration first/);
});
