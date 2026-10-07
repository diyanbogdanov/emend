import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inventoriesFor, type EcosystemInventory } from '../src/ecosystems.ts';

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
      applies: async (d) => d === dir,
      read: async () => ({
        packages: [{ name: 'serde', ecosystem: 'crates.io', version: '1.0.0' }],
        unsupported: null,
      }),
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
      applies: async () => true,
      read: async () => ({ packages: [], unsupported: null }),
      manifestSites: async () => new Map(),
    };
    const declining: EcosystemInventory = {
      id: 'declining',
      osvEcosystem: 'declining-eco',
      applies: async () => false,
      read: async () => ({ packages: [], unsupported: null }),
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
    // The line pnpm names it on. It used to fall through to line 1 —
    // `lockfileVersion` — cited with text that appears nowhere in the file.
    assert.equal(site?.line, 4);
    assert.equal(site?.text, 'qs@6.7.0:');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Real lockfiles, generated 2026-10-07 from one package.json requiring
// `minimist@1.2.8` and `@types/minimist@1.2.5` — an unscoped name and a scoped
// one, which each format quotes differently — with pnpm 10.24.0
// (--lockfile-only), yarn 1.22.22 and bun 1.3.12 (--lockfile-only). Not text
// shaped to fit the parsers: the citation has to agree with what they read.
for (const [file, lines] of [
  ['pnpm-lock.yaml', { minimist: 23, '@types/minimist': 20 }],
  ['yarn.lock', { minimist: 10, '@types/minimist': 5 }],
  ['bun.lock', { minimist: 16, '@types/minimist': 14 }],
] as const) {
  test(`a ${file} citation names the line where the lockfile names the package`, async () => {
    // Each cites the entry the parser read the version from — for bun, the
    // `"minimist@1.2.8"` package entry, not the dependency declaration above it
    // that names the same package and version.
    const dir = mkdtempSync(path.join(tmpdir(), 'emend-eco-cite-'));
    try {
      copyFileSync(path.join(import.meta.dirname, 'fixtures', 'lockfiles', file), path.join(dir, file));
      const raw = readFileSync(path.join(dir, file), 'utf8').split('\n');
      const [npm] = await inventoriesFor(dir);
      const sites = await npm?.manifestSites(dir, [
        { name: 'minimist', ecosystem: 'npm', version: '1.2.8' },
        { name: '@types/minimist', ecosystem: 'npm', version: '1.2.5' },
      ]);
      for (const [name, line] of Object.entries(lines)) {
        const site = sites?.get(`${name}@${name === 'minimist' ? '1.2.8' : '1.2.5'}`);
        assert.equal(site?.file, file);
        assert.equal(site?.line, line, `${name} in ${file}`);
        // The text shown is what is on that line, not a synthesized path.
        assert.ok(site && raw[line - 1]?.includes(site.text), `${site?.text} is not on line ${line}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('an unreadable lockfile still claims the repository, so its packages are said to be unread', async () => {
  // Claiming only when the lockfile parsed meant an unreadable one disowned the
  // repository: the vulnerability screen then did not run and said nothing,
  // which renders as a clean scan.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-eco-broken-'));
  try {
    writeFileSync(path.join(dir, 'package-lock.json'), '{ "lockfileVersion": 3, <<<<<<< HEAD');
    const [npm] = await inventoriesFor(dir);
    assert.equal(npm?.id, 'npm');
    assert.equal((await npm?.read(dir))?.unsupported, 'package-lock.json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
