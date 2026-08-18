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
