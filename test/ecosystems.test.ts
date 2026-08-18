import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inventoriesFor, type EcosystemInventory } from '../src/ecosystems.ts';

test('a repository with no npm lockfile is still claimed by whoever understands it', async () => {
  // The bug this guards: `applies` gated on package-lock.json, so a repository
  // in any other ecosystem was never scanned at all — and the detector reported
  // nothing, which reads exactly like having checked and found nothing.
  // Written against a fake adapter so it outlives whichever languages ship.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-eco-'));
  writeFileSync(path.join(dir, 'Cargo.lock'), '[[package]]\nname = "serde"\n');

  const cargo: EcosystemInventory = {
    id: 'cargo',
    osvEcosystem: 'crates.io',
    applies: async (d) => d === dir,
    read: async () => ({
      packages: [{ name: 'serde', ecosystem: 'crates.io', version: '1.0.0' }],
      unsupported: null,
    }),
    manifestSite: async () => null,
  };

  const claimed = await inventoriesFor(dir, [cargo]);
  assert.deepEqual(claimed.map((i) => i.id), ['cargo']);
});

test('an unclaimed repository yields no inventory rather than an empty one', async () => {
  // "Nobody understands this repository" and "this repository has no
  // dependencies" are different answers and must not collapse into one.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-eco-none-'));
  const claimed = await inventoriesFor(dir, []);
  assert.deepEqual(claimed, []);
});

test('a pnpm-only repository is cited by its own lockfile, not a fabricated package-lock.json', async () => {
  // The previous manifestSite cited package-lock.json for a repository that
  // had none at all — a read failure fell through to an empty string rather
  // than "nothing to cite", and lockfileSite happily built a site pointing at
  // a file that was never on disk. A fabricated citation is worse than no
  // citation at all, which is the whole reason a summary is worth reading
  // here. `readLockfile` records which lockfile it actually parsed
  // (`lock.kind`); manifestSite now cites that file, not a hardcoded one.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-eco-pnpm-'));
  writeFileSync(
    path.join(dir, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\n\npackages:\n  qs@6.7.0:\n    resolution: {integrity: sha512-fake==}\n",
  );

  const [npm] = await inventoriesFor(dir);
  assert.equal(npm?.id, 'npm');
  const site = await npm?.manifestSite(dir, { name: 'qs', ecosystem: 'npm', version: '6.7.0' });
  assert.equal(site?.file, 'pnpm-lock.yaml');
  // pnpm install paths are synthesized by readLockfile, not read off the
  // page, so the quoted search misses and falls through to line 1 — an
  // honest "named in this file, line not pinpointed" rather than an artifact.
  assert.equal(site?.line, 1);
});
