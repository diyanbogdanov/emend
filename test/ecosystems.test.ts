import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inventoriesFor, type EcosystemInventory } from '../src/ecosystems.ts';
import { readRepo } from '../src/inventory.ts';
import { pythonInventory } from '../src/python/inventory.ts';

test('a repository with no npm lockfile is still claimed by whoever understands it', async () => {
  // The bug this guards: `applies` gated on package-lock.json, so a repository
  // in any other ecosystem was never scanned at all — and the detector reported
  // nothing, which reads exactly like having checked and found nothing.
  // Written against a fake adapter so it outlives whichever languages ship.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-eco-'));
  try {
    writeFileSync(path.join(dir, 'Cargo.lock'), '[[package]]\nname = "serde"\n');

    const cargo: EcosystemInventory = {
      id: 'cargo',
      osvEcosystem: 'crates.io',
      manifests: ['Cargo.toml', 'Cargo.lock'],
      applies: async (d) => d === dir,
      read: async () => ({
        packages: [{ name: 'serde', ecosystem: 'crates.io', version: '1.0.0' }],
        unsupported: null,
        incomplete: null,
      }),
      declared: async (d) => ({ dir: d, name: 'cargo', dependencies: [], scripts: {}, warnings: [], workspaces: [''] }),
      manifestSites: async () => new Map(),
    };

    const claimed = await inventoriesFor(dir, [cargo]);
    assert.deepEqual(claimed.map((i) => i.id), ['cargo']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unclaimed repository yields no inventory rather than an empty one', async () => {
  // "Nobody understands this repository" and "this repository has no
  // dependencies" are different answers and must not collapse into one.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-eco-none-'));
  try {
    const claimed = await inventoriesFor(dir, []);
    assert.deepEqual(claimed, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inventoriesFor filters out a declining inventory, not just returns a claiming one', async () => {
  // A reviewer mutated `inventoriesFor` to drop the `if (await inventory.applies(...))`
  // check entirely — returning every registered inventory unconditionally —
  // and every test above still passed: the fake in the first test always
  // claims, the registry in the second is empty so the loop body never runs,
  // and nothing paired a claiming adapter with a declining one. The filter is
  // the one behaviour this seam exists to provide, so it needs a case where
  // getting it wrong is actually visible.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-eco-filter-'));
  try {
    const claiming: EcosystemInventory = {
      id: 'claiming',
      osvEcosystem: 'claiming-eco',
      manifests: ['claiming.manifest'],
      applies: async () => true,
      read: async () => ({ packages: [], unsupported: null, incomplete: null }),
      declared: async (d) => ({ dir: d, name: 'claiming', dependencies: [], scripts: {}, warnings: [], workspaces: [''] }),
      manifestSites: async () => new Map(),
    };
    const declining: EcosystemInventory = {
      id: 'declining',
      osvEcosystem: 'declining-eco',
      manifests: ['declining.manifest'],
      applies: async () => false,
      read: async () => ({ packages: [], unsupported: null, incomplete: null }),
      declared: async (d) => ({ dir: d, name: 'declining', dependencies: [], scripts: {}, warnings: [], workspaces: [''] }),
      manifestSites: async () => new Map(),
    };

    const claimed = await inventoriesFor(dir, [claiming, declining]);
    assert.deepEqual(claimed.map((i) => i.id), ['claiming']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pnpm-only repository is cited by its own lockfile, not a fabricated package-lock.json', async () => {
  // The previous manifestSite cited package-lock.json for a repository that
  // had none at all — a read failure fell through to an empty string rather
  // than "nothing to cite", and lockfileSite happily built a site pointing at
  // a file that was never on disk. A fabricated citation is worse than no
  // citation at all, which is the whole reason a summary is worth reading
  // here. `readLockfile` records which lockfile it actually parsed
  // (`lock.kind`); manifestSites now cites that file, not a hardcoded one.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-eco-pnpm-'));
  try {
    writeFileSync(
      path.join(dir, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\n\npackages:\n  qs@6.7.0:\n    resolution: {integrity: sha512-fake==}\n",
    );

    const [npm] = await inventoriesFor(dir);
    assert.equal(npm?.id, 'npm');
    const sites = await npm?.manifestSites(dir, [{ name: 'qs', ecosystem: 'npm', version: '6.7.0' }]);
    const site = sites?.get('qs@6.7.0');
    assert.equal(site?.file, 'pnpm-lock.yaml');
    // pnpm install paths are synthesized by readLockfile, not read off the
    // page, so the quoted search misses and falls through to line 1 — an
    // honest "named in this file, line not pinpointed" rather than an artifact.
    assert.equal(site?.line, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- read()'s `incomplete`: a manifest with nothing to resolve it from -----
//
// The bug this guards: `applies()` claims a repository on package.json alone,
// with no lockfile requirement — necessary so readRepo still works before a
// repository's first install. But read() feeds the vulnerability detector,
// and a package.json with real dependencies and no lockfile resolves zero
// packages the same way a genuinely dependency-free repository does. Without
// `incomplete`, both report {packages: [], unsupported: null} —
// indistinguishable from having been screened and found clean.

test('read() marks itself incomplete when package.json declares dependencies but no lockfile exists', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-eco-npm-nolock-'));
  try {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { lodash: '4.17.15' } }),
    );

    const [npm] = await inventoriesFor(dir);
    assert.equal(npm?.id, 'npm');
    const result = await npm?.read(dir);
    assert.deepEqual(result?.packages, []);
    assert.equal(result?.unsupported, null);
    assert.match(result?.incomplete ?? '', /no lockfile/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read() is not incomplete when a lockfile resolved the tree', async () => {
  // The no-regression case: a repository that was actually screened must not
  // carry a caveat saying it was not.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-eco-npm-lock-'));
  try {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { lodash: '4.17.15' } }),
    );
    writeFileSync(
      path.join(dir, 'package-lock.json'),
      JSON.stringify({
        name: 'x',
        lockfileVersion: 3,
        packages: {
          '': { name: 'x' },
          'node_modules/lodash': { version: '4.17.15' },
        },
      }),
    );

    const [npm] = await inventoriesFor(dir);
    const result = await npm?.read(dir);
    assert.deepEqual(result?.packages, [{ name: 'lodash', ecosystem: 'npm', version: '4.17.15' }]);
    assert.equal(result?.incomplete, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read() is not incomplete when package.json genuinely declares no dependencies', async () => {
  // Distinct from the case above: nothing was declared, so there is nothing a
  // lockfile could have resolved either. Flagging this as incomplete would be
  // the opposite dishonesty this task exists to prevent — manufacturing doubt
  // about a repository that has none.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-eco-npm-empty-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));

    const [npm] = await inventoriesFor(dir);
    const result = await npm?.read(dir);
    assert.deepEqual(result?.packages, []);
    assert.equal(result?.incomplete, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a repository no inventory claims is told what was looked for', async () => {
  // `readRepo` threw `no readable package.json at ...` for every non-npm
  // repository, before any seam could be consulted. The message named npm
  // specifically, which is the wrong claim once more than one ecosystem exists.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-declared-none-'));
  try {
    await assert.rejects(() => readRepo(dir), /no recognised manifest/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the npm inventory supplies the declared view', async () => {
  // `declared()` answers a different question from `read()`: direct dependencies
  // with the ranges the manifest states, rather than the whole transitive tree
  // flattened for vulnerability screening.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-declared-npm-'));
  try {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { zod: '^3.22.0' } }),
    );
    const info = await readRepo(dir);
    assert.equal(info.name, 'x');
    assert.deepEqual(
      info.dependencies.map((d) => [d.name, d.declared]),
      [['zod', '^3.22.0']],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('declared() reports an exact package.json pin as installed, not as an inferred range', async () => {
  // The bug this guards: "lodash": "4.17.21" is an exact pin, not a range —
  // but with no node_modules and no lockfile to resolve it, declared() used to
  // fall through to versionFromRange and report source: 'range', which
  // InstalledDependency.source's own doc says "may name a version that was
  // never published — callers must not present it as a fact read from the
  // repository". That understates what package.json actually states, and (via
  // resolvedVersions() in pins.ts, which does not trust 'range') excluded an
  // exactly-pinned dependency from pin-conflict detection it should
  // participate in. Asserted here via readRepo/RepoInfo, the same end-to-end
  // path pin-conflict detection and every other caller of declared() reads.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-npm-declared-pin-'));
  try {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { lodash: '4.17.21' } }),
    );
    const info = await readRepo(dir);
    assert.deepEqual(info.dependencies, [
      {
        name: 'lodash',
        ecosystem: 'npm',
        declared: '4.17.21',
        dev: false,
        installed: '4.17.21',
        // Not 'lockfile': no resolver produced this, the manifest states it
        // outright. Not 'range': nothing was inferred. See
        // InstalledDependency.source's own doc.
        source: 'pinned',
        declaredIn: [''],
      },
    ]);
    // A pin is not a guess, so it must not trigger the "inferred from range" caveat.
    assert.deepEqual(info.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('declared() treats "=" and "v" prefixes as exact pins too', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-npm-declared-pinprefix-'));
  try {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'x',
        dependencies: { 'eq-pin': '=4.17.21', 'v-pin': 'v4.17.21' },
      }),
    );
    const info = await readRepo(dir);
    assert.deepEqual(
      info.dependencies.map((d) => [d.name, d.installed, d.source]).sort(),
      [
        ['eq-pin', '4.17.21', 'pinned'],
        ['v-pin', '4.17.21', 'pinned'],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('declared() does not mistake a range, wildcard, tag or alias for a pin', async () => {
  // Each of these contains version-shaped digits somewhere, which is exactly
  // why exactPin anchors to the whole specifier rather than searching for a
  // substring — an unanchored check would wrongly call every one of these
  // exact. caret/tilde/gte/alias still resolve to a guessed version via the
  // pre-existing versionFromRange fallback; xrange/globstar/star/tag resolve
  // to nothing, because no x.y.z triplet appears anywhere in them either.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-npm-declared-notpin-'));
  try {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'x',
        dependencies: {
          caret: '^4.17.21',
          tilde: '~4.17.21',
          gte: '>=4.17.21',
          xrange: '4.x',
          globstar: '4.17.*',
          star: '*',
          tag: 'latest',
          alias: 'npm:lodash-es@^4.17.21',
        },
      }),
    );
    const info = await readRepo(dir);
    assert.deepEqual(
      info.dependencies.map((d) => [d.name, d.installed, d.source]).sort(),
      [
        ['alias', '4.17.21', 'range'],
        ['caret', '4.17.21', 'range'],
        ['globstar', null, 'none'],
        ['gte', '4.17.21', 'range'],
        ['star', null, 'none'],
        ['tag', null, 'none'],
        ['tilde', '4.17.21', 'range'],
        ['xrange', null, 'none'],
      ],
    );
    // None of the above is a pin, so 'pinned' must not appear anywhere.
    assert.ok(!info.dependencies.some((d) => d.source === 'pinned'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('declared() never treats a URL, git+, file: or workspace: specifier as a pin', async () => {
  // These are excluded from `dependencies` entirely, before exactPin ever
  // sees them — local and git dependencies have no registry version to diff
  // against (the existing `continue` a few lines above in declared()). Each
  // value here ends in digits that look exactly like a pin, so this is the
  // check that a pin classifier reached for greedily (e.g. by moving after
  // that exclusion, or by matching a substring) would fail.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-npm-declared-nonregistry-'));
  try {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'x',
        dependencies: {
          fromUrl: 'https://example.com/lodash-4.17.21.tgz',
          fromGit: 'git+https://github.com/lodash/lodash.git#4.17.21',
          fromFile: 'file:../local-lodash',
          fromWorkspace: 'workspace:4.17.21',
        },
      }),
    );
    const info = await readRepo(dir);
    assert.deepEqual(info.dependencies, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lockfile wins over an exact package.json pin, which is not consulted for the version', async () => {
  // Mirrors "a lockfile wins over requirements.txt" on the Python side: the
  // lockfile (4.17.20) deliberately disagrees with the pin (4.17.21) so the
  // two are distinguishable in the result — if precedence broke and the pin
  // were consulted, this would read '4.17.21'/'pinned' instead.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-npm-declared-pinorder-'));
  try {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { lodash: '4.17.21' } }),
    );
    writeFileSync(
      path.join(dir, 'package-lock.json'),
      JSON.stringify({
        name: 'x',
        lockfileVersion: 3,
        packages: {
          '': { name: 'x' },
          'node_modules/lodash': {
            version: '4.17.20',
            resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz',
          },
        },
      }),
    );
    const info = await readRepo(dir);
    assert.deepEqual(
      info.dependencies.map((d) => [d.name, d.installed, d.source]),
      [['lodash', '4.17.20', 'lockfile']],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the "no recognised manifest" message names only what the registry actually looks for', async () => {
  // The message used to hardcode a wishlist of Python filenames — pyproject.toml,
  // requirements.txt and the rest — before any Python adapter existed to read
  // them, which was exactly the "nobody looked" claim this codebase refuses to
  // make elsewhere. The message must be built from the registry, not a
  // hand-kept copy of it, so it can only ever name what some registered
  // inventory actually checks for. Now that a Python inventory is registered
  // (src/python/inventory.ts), pyproject.toml and requirements.txt genuinely
  // are among the things `applies()` checks, so the message naming them is
  // this test passing for the reason it always meant to: the message tracks
  // the registry, growing the moment a new inventory joins it rather than
  // needing to be told.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-declared-registry-'));
  try {
    let message = '';
    try {
      await readRepo(dir);
      assert.fail('expected readRepo to reject');
    } catch (err) {
      message = (err as Error).message;
    }
    assert.match(message, /package\.json/);
    assert.match(message, /pyproject\.toml/);
    assert.match(message, /requirements\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- pythonInventory() -------------------------------------------------
//
// manifests.ts's own tests (test/pythonmanifests.test.ts) prove the parsers
// against real fixtures; these prove the inventory layer built on top of
// them — which manifest wins, what a range vs. a resolution reports, and the
// warnings a caller sees — so small hand-written manifest snippets are used
// here rather than the full real fixtures.

test('applies() claims a repository with only requirements.txt', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-py-applies-req-'));
  try {
    writeFileSync(path.join(dir, 'requirements.txt'), 'requests>=2.31.0\n');
    assert.equal(await pythonInventory().applies(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applies() claims a repository with only pyproject.toml, though declared() cannot read it', async () => {
  // A real Python project before its first `uv lock` / `poetry lock` run is
  // still a Python project — not claiming it would be the same "nobody
  // looked" gap this whole seam exists to close.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-py-applies-pyproject-'));
  try {
    writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "demo"\n');
    assert.equal(await pythonInventory().applies(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applies() declines a repository with none of the six Python signals', async () => {
  // The negative path: an empty directory, or one that only happens to
  // contain unrelated files, must not be claimed.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-py-applies-none-'));
  try {
    writeFileSync(path.join(dir, 'README.md'), '# not python\n');
    assert.equal(await pythonInventory().applies(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('declared() reports a lockfile-resolved dependency as installed, not guessed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-py-declared-lock-'));
  try {
    writeFileSync(
      path.join(dir, 'uv.lock'),
      'version = 1\nrequires-python = ">=3.11"\n\n[[package]]\nname = "requests"\nversion = "2.31.0"\nsource = { registry = "https://pypi.org/simple" }\n',
    );
    const info = await pythonInventory().declared(dir);
    assert.deepEqual(info.dependencies, [
      {
        name: 'requests',
        ecosystem: 'PyPI',
        declared: '2.31.0',
        dev: false,
        installed: '2.31.0',
        source: 'lockfile',
        declaredIn: [''],
      },
    ]);
    assert.deepEqual(info.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('declared() reports a requirements.txt range as a range, never as an installed fact', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-py-declared-range-'));
  try {
    writeFileSync(path.join(dir, 'requirements.txt'), 'requests>=2.31.0\n');
    const info = await pythonInventory().declared(dir);
    assert.deepEqual(info.dependencies, [
      {
        name: 'requests',
        ecosystem: 'PyPI',
        declared: '>=2.31.0',
        dev: false,
        installed: null,
        source: 'range',
        declaredIn: [''],
      },
    ]);
    assert.equal(info.warnings.length, 1);
    assert.match(info.warnings[0] ?? '', /requirements\.txt declares ranges/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('declared() reports an exact == pin as installed, not as an unresolved range', async () => {
  // The bug this guards: three exactly-pinned dependencies used to be
  // discarded entirely (installed: null, source: 'range') because
  // requirements.txt was treated as ranges-only regardless of what its lines
  // actually specified.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-py-declared-pin-'));
  try {
    writeFileSync(path.join(dir, 'requirements.txt'), 'requests==2.31.0\n');
    const info = await pythonInventory().declared(dir);
    assert.deepEqual(info.dependencies, [
      {
        name: 'requests',
        ecosystem: 'PyPI',
        declared: '2.31.0',
        dev: false,
        installed: '2.31.0',
        // Not 'lockfile': no resolver produced this, the manifest states it
        // outright. Not 'range': nothing was inferred. See
        // InstalledDependency.source's own doc.
        source: 'pinned',
        declaredIn: [''],
      },
    ]);
    // Nothing here is a range, so the "declares ranges" caveat must not fire.
    assert.deepEqual(info.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('declared() on a mixed requirements.txt resolves the pin and ranges the rest, with one caveat', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-py-declared-mixed-'));
  try {
    writeFileSync(path.join(dir, 'requirements.txt'), 'requests==2.31.0\nurllib3>=2.0.2\n');
    const info = await pythonInventory().declared(dir);
    assert.deepEqual(
      info.dependencies.map((d) => [d.name, d.installed, d.source]).sort(),
      [
        ['requests', '2.31.0', 'pinned'],
        ['urllib3', null, 'range'],
      ],
    );
    // One warning, naming the file once — not one per unresolved package —
    // and it must fire, since urllib3's range genuinely could not be resolved.
    assert.equal(info.warnings.length, 1);
    assert.match(info.warnings[0] ?? '', /requirements\.txt declares ranges/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lockfile wins over requirements.txt, which is not consulted at all', async () => {
  // The risk the task text calls out by name: mixing a resolution for one
  // package with a range for another would report one installed version
  // carrying the other's provenance. Here requirements.txt disagrees with
  // uv.lock outright (a different version) — if it were consulted at all,
  // that disagreement would be visible in the result below.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-py-declared-order-'));
  try {
    writeFileSync(
      path.join(dir, 'uv.lock'),
      'version = 1\nrequires-python = ">=3.11"\n\n[[package]]\nname = "requests"\nversion = "2.31.0"\nsource = { registry = "https://pypi.org/simple" }\n',
    );
    writeFileSync(path.join(dir, 'requirements.txt'), 'requests==9.9.9\n');

    const info = await pythonInventory().declared(dir);
    assert.deepEqual(
      info.dependencies.map((d) => [d.name, d.installed, d.source]),
      [['requests', '2.31.0', 'lockfile']],
    );
    // Not the "declares ranges" warning requirements.txt alone would produce —
    // proof requirements.txt was never opened, not just that its answer lost.
    assert.deepEqual(info.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('declared() with only pyproject.toml reports no dependencies, with a warning naming why', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-py-declared-pyproject-'));
  try {
    writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "demo"\n');
    const info = await pythonInventory().declared(dir);
    assert.deepEqual(info.dependencies, []);
    assert.equal(info.warnings.length, 1);
    assert.match(info.warnings[0] ?? '', /pyproject\.toml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read() with only pyproject.toml marks itself incomplete, the same exposure npm has', async () => {
  // The same gap as ecosystems.ts's npm `incomplete` tests, on the Python
  // side: applies() claims this repository on pyproject.toml alone, and
  // read() would otherwise answer {packages: [], unsupported: null} — silent,
  // and indistinguishable from a repository with no dependencies at all.
  // Unlike npm's read(), there is no cheaper manifest here to re-check for
  // "genuinely zero": this adapter never parses pyproject.toml's own
  // [project.dependencies] (module doc), so — like declared()'s warning just
  // above — this fires unconditionally whenever only pyproject.toml exists.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-py-read-pyproject-'));
  try {
    writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "demo"\n');
    const result = await pythonInventory().read(dir);
    assert.deepEqual(result.packages, []);
    assert.equal(result.unsupported, null);
    assert.match(result.incomplete ?? '', /pyproject\.toml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read() offers the whole resolved tree, ecosystem-tagged PyPI', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-py-read-'));
  try {
    writeFileSync(
      path.join(dir, 'poetry.lock'),
      '[[package]]\nname = "requests"\nversion = "2.31.0"\ndescription = ""\noptional = false\npython-versions = "*"\nfiles = []\n',
    );
    const result = await pythonInventory().read(dir);
    assert.deepEqual(result, {
      packages: [{ name: 'requests', ecosystem: 'PyPI', version: '2.31.0' }],
      unsupported: null,
      incomplete: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read() offers nothing for a requirements.txt-only repository, rather than a guessed version', async () => {
  // A known consequence of never guessing: a repository with no lockfile and
  // only ranges gets no vulnerability screening from this inventory at all,
  // because there is no resolved version to screen — see
  // src/python/inventory.ts's read() doc. Not `incomplete`: requirements.txt
  // was found and parsed fine, and declared() already warns separately that
  // its ranges could not be resolved — this is the accepted "never guess"
  // limitation, not the "nobody looked" gap this task's `incomplete` guards.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-py-read-range-only-'));
  try {
    writeFileSync(path.join(dir, 'requirements.txt'), 'requests>=2.31.0\n');
    const result = await pythonInventory().read(dir);
    assert.deepEqual(result, { packages: [], unsupported: null, incomplete: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read() offers an exactly-pinned requirements.txt dependency for vulnerability screening', async () => {
  // Unlike a range, an exact == pin is a resolved version by the same
  // definition uv.lock/poetry.lock/etc. use — it belongs in `versions`, and
  // read() screens everything in `versions` regardless of which manifest
  // produced it. Leaving a pinned package unscreened would be the same
  // "nobody looked" gap declared()'s fix closes, on the vulnerability side.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-py-read-pin-'));
  try {
    writeFileSync(path.join(dir, 'requirements.txt'), 'requests==2.31.0\n');
    const result = await pythonInventory().read(dir);
    assert.deepEqual(result, {
      packages: [{ name: 'requests', ecosystem: 'PyPI', version: '2.31.0' }],
      unsupported: null,
      incomplete: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifestSites cites the line naming the package in the manifest that was actually read', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-py-sites-'));
  try {
    const lock =
      '[[package]]\nname = "certifi"\nversion = "2024.2.2"\n\n[[package]]\nname = "requests"\nversion = "2.31.0"\n';
    writeFileSync(path.join(dir, 'poetry.lock'), lock);

    const sites = await pythonInventory().manifestSites(dir, [
      { name: 'requests', ecosystem: 'PyPI', version: '2.31.0' },
    ]);
    const site = sites.get('requests@2.31.0');
    assert.equal(site?.file, 'poetry.lock');
    assert.equal(site?.line, lock.split('\n').findIndex((l) => l === 'name = "requests"') + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readRepo routes a Python repository through pythonInventory, end to end', async () => {
  // The integration this whole task exists for: a real Python repository,
  // with no package.json anywhere, produces a real dependency list rather
  // than readRepo's "no recognised manifest" rejection.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-py-readrepo-'));
  try {
    writeFileSync(
      path.join(dir, 'uv.lock'),
      'version = 1\nrequires-python = ">=3.11"\n\n[[package]]\nname = "requests"\nversion = "2.31.0"\nsource = { registry = "https://pypi.org/simple" }\n',
    );
    const info = await readRepo(dir);
    assert.deepEqual(
      info.dependencies.map((d) => d.name),
      ['requests'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable lockfile is reported as unsupported, by both declared() and read()', async () => {
  // The negative path for `readBestManifest`'s "existence, not content quality,
  // decides which manifest is best": uv.lock exists, so it is the one read —
  // and its content does not parse, so that failure must surface, not be
  // swallowed as "zero dependencies" (declared) or silently skipped in favour
  // of some other file (there is no other file here to fall back to anyway).
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-py-unsupported-'));
  try {
    writeFileSync(path.join(dir, 'uv.lock'), 'this is not a lockfile at all\n');

    const info = await pythonInventory().declared(dir);
    assert.deepEqual(info.dependencies, []);
    assert.equal(info.warnings.length, 1);
    assert.match(info.warnings[0] ?? '', /uv\.lock/);

    const result = await pythonInventory().read(dir);
    assert.deepEqual(result, { packages: [], unsupported: 'uv.lock', incomplete: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
