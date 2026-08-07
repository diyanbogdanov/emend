import test from 'node:test';
import assert from 'node:assert/strict';
import { dependentsOf, planRemediation } from '../src/remediate.ts';

/**
 * A realistic lockfile: npm hoists, so `qs` sits flat at `node_modules/qs`
 * rather than under the package that needs it. The install path therefore does
 * *not* name the parent — the `dependencies` map does.
 */
const LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', dependencies: { express: '^4.17.1', lodash: '4.17.15' } },
    'node_modules/express': { version: '4.17.1', dependencies: { qs: '6.7.0', 'body-parser': '1.19.0' } },
    'node_modules/body-parser': { version: '1.19.0', dependencies: { qs: '6.7.0' } },
    'node_modules/qs': { version: '6.7.0' },
    'node_modules/lodash': { version: '4.17.15' },
  },
});

const DIRECT = new Set(['express', 'lodash']);

// ---------------------------------------------------------------------------
// Who pulls a package in
// ---------------------------------------------------------------------------

test('the direct dependency whose subtree reaches the package is the one to bump', () => {
  // npm hoists, so `node_modules/qs` says nothing about who needs it. Reading
  // the install path for a parent works only for the nested minority and would
  // report almost every real transitive vulnerability as unfixable.
  assert.deepEqual(dependentsOf(LOCK, 'qs', DIRECT), ['express']);
});

test('a package pulled in through two hops still names its direct ancestor', () => {
  // `express` → `body-parser` → `qs`. Bumping `body-parser` is not something the
  // repository can do; bumping `express` is.
  const twoHop = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { express: '^4' } },
      'node_modules/express': { version: '4.17.1', dependencies: { 'body-parser': '1.19.0' } },
      'node_modules/body-parser': { version: '1.19.0', dependencies: { qs: '6.7.0' } },
      'node_modules/qs': { version: '6.7.0' },
    },
  });
  assert.deepEqual(dependentsOf(twoHop, 'qs', new Set(['express'])), ['express']);
});

test('a package nothing depends on has no dependents', () => {
  assert.deepEqual(dependentsOf(LOCK, 'unrelated', DIRECT), []);
});

test('a cycle terminates rather than walking forever', () => {
  // Circular dependencies are legal and not rare.
  const cyclic = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { a: '^1' } },
      'node_modules/a': { version: '1.0.0', dependencies: { b: '1.0.0' } },
      'node_modules/b': { version: '1.0.0', dependencies: { a: '1.0.0', bad: '1.0.0' } },
      'node_modules/bad': { version: '1.0.0' },
    },
  });
  assert.deepEqual(dependentsOf(cyclic, 'bad', new Set(['a'])), ['a']);
});

// ---------------------------------------------------------------------------
// Which rung applies
// ---------------------------------------------------------------------------

test('a direct dependency is bumped directly', () => {
  const plan = planRemediation({ name: 'lodash', version: '4.17.15', target: '4.18.0' }, DIRECT, LOCK);
  assert.deepEqual(plan, { kind: 'direct', pkg: 'lodash', to: '4.18.0' });
});

test('a transitive one is fixed by bumping whoever pulls it in', () => {
  const plan = planRemediation({ name: 'qs', version: '6.7.0', target: '6.7.3' }, DIRECT, LOCK);
  assert.equal(plan.kind, 'parent');
  assert.deepEqual(plan.kind === 'parent' ? plan.parents : [], ['express']);
  assert.equal(plan.kind === 'parent' ? plan.child : '', 'qs');
});

test('a package with no published fix gets no plan, and says why', () => {
  // An unfixable vulnerability is a real answer. Proposing a bump to a version
  // that does not exist is not a smaller failure than proposing none.
  const plan = planRemediation({ name: 'lodash', version: '4.17.15', target: null }, DIRECT, LOCK);
  assert.equal(plan.kind, 'none');
  assert.match(plan.kind === 'none' ? plan.reason : '', /no published fix/i);
});

test('a transitive package nothing reaches gets no plan rather than a guess', () => {
  // If no direct dependency's subtree contains it, bumping anything is a guess.
  // Rung three — an override — is the answer, and it is a separate decision.
  const plan = planRemediation({ name: 'orphan', version: '1.0.0', target: '2.0.0' }, DIRECT, LOCK);
  assert.equal(plan.kind, 'none');
  assert.match(plan.kind === 'none' ? plan.reason : '', /no direct dependency/i);
});

test('an unreadable lockfile yields no plan rather than a wrong one', () => {
  const plan = planRemediation({ name: 'qs', version: '6.7.0', target: '6.7.3' }, DIRECT, '<html>');
  assert.equal(plan.kind, 'none');
});
