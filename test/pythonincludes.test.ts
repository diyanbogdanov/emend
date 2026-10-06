import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pythonInventory } from '../src/python/inventory.ts';
import type { RepoInfo } from '../src/types.ts';

// `-r other.txt` and `-c constraints.txt` were skipped as option lines, so a
// requirements.txt that only includes others — the common split into base,
// prod and dev files — read as a repository with no dependencies at all.

const sandbox = await mkdtemp(path.join(tmpdir(), 'emend-pyinc-'));
test.after(() => rm(sandbox, { recursive: true, force: true }));

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(sandbox, 'repo-'));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  return dir;
}

const read = (info: RepoInfo): string[] =>
  info.dependencies.map((d) => `${d.name}@${d.installed ?? d.declared}`).sort();

test('a requirements file that only includes others still reads their packages', async () => {
  // Nested, and each include relative to the file that names it, as pip
  // resolves them: prod.txt's `base.txt` is requirements/base.txt.
  const dir = await repo({
    'requirements.txt': '-r requirements/prod.txt\n',
    'requirements/prod.txt': '--requirement base.txt\nrequests==2.31.0\n',
    'requirements/base.txt': 'idna==3.7\n',
  });
  assert.deepEqual(read(await pythonInventory().declared(dir)), ['idna@3.7', 'requests@2.31.0']);
  const { packages, incomplete } = await pythonInventory().read(dir);
  assert.deepEqual(packages.map((p) => `${p.name}@${p.version}`).sort(), ['idna@3.7', 'requests@2.31.0']);
  assert.equal(incomplete, null);
});

test('a constraints file pins what is required, and adds nothing that is not', async () => {
  // pip's own meaning of -c: it decides which version gets installed, never
  // whether a package does. urllib3 here is installed by nothing.
  const dir = await repo({
    'requirements.txt': 'requests>=2.0\n-c constraints.txt\n',
    'constraints.txt': 'Requests==2.31.0\nurllib3==2.0.0\n',
  });
  const info = await pythonInventory().declared(dir);
  assert.deepEqual(read(info), ['requests@2.31.0']);
  assert.equal(info.dependencies[0]?.source, 'pinned');
});

test('an include outside the repository is not read, and says so', async () => {
  // A repository names its own include paths, and the hosted App scans
  // repositories it has no reason to trust. `-r ../x` and a committed symlink
  // out of the checkout would read whatever file they point at as
  // requirements — and print its lines back as dependency names.
  await writeFile(path.join(sandbox, 'outside.txt'), 'leaked==1.0\n');
  const dir = await repo({ 'requirements.txt': '-r ../outside.txt\n-r link.txt\nidna==3.7\n' });
  await symlink(path.join(sandbox, 'outside.txt'), path.join(dir, 'link.txt'));

  const info = await pythonInventory().declared(dir);
  assert.deepEqual(read(info), ['idna@3.7']);
  assert.equal(info.warnings.filter((w) => /outside the repository/.test(w)).length, 2);
  const { incomplete } = await pythonInventory().read(dir);
  assert.match(incomplete ?? '', /outside the repository/);
});

test('an include that cannot be followed is named, never dropped in silence', async () => {
  const dir = await repo({
    'requirements.txt': '-r missing.txt\n-r https://example.com/r.txt\nidna==3.7\n',
  });
  const info = await pythonInventory().declared(dir);
  assert.ok(info.warnings.some((w) => w.includes('missing.txt')), info.warnings.join(' | '));
  assert.ok(info.warnings.some((w) => w.includes('https://example.com/r.txt')), info.warnings.join(' | '));
});

test('includes that loop back are each read once', async () => {
  const dir = await repo({
    'requirements.txt': '-r a.txt\n',
    'a.txt': '-r b.txt\nidna==3.7\n',
    'b.txt': '-r a.txt\n-r requirements.txt\nrequests==2.31.0\n',
  });
  assert.deepEqual(read(await pythonInventory().declared(dir)), ['idna@3.7', 'requests@2.31.0']);
});
