import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanRepo } from '../src/analyze.ts';
import { walkDir } from '../src/callsites.ts';
import { inventoryFor } from '../src/ecosystems.ts';
import { readLockfile } from '../src/lockfile.ts';
import { pythonInventory } from '../src/python/inventory.ts';

// The hosted App clones repositories it has no reason to trust, and git
// records symlinks faithfully. A repository that commits
// `requirements.txt -> /etc/passwd` had that file parsed as requirements — each
// line a "package", printed back in warnings, the dashboard, a pull request.
// Every file below is a link from inside a repository to a file outside it,
// and none of their contents may be read.

const sandbox = await mkdtemp(path.join(tmpdir(), 'emend-links-'));
test.after(() => rm(sandbox, { recursive: true, force: true }));

/** A file outside every repository, whose content must never surface. */
const secret = path.join(sandbox, 'secret.txt');
await writeFile(secret, 'leaked==1.0\n');

async function repo(files: Record<string, string>, links: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(sandbox, 'repo-'));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  for (const [rel, target] of Object.entries(links)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await symlink(target, path.join(dir, rel));
  }
  return dir;
}

test('a Python manifest linked outside the repository is not read, and says so', async () => {
  const dir = await repo({}, { 'requirements.txt': secret });
  const info = await pythonInventory().declared(dir);
  assert.deepEqual(info.dependencies, []);
  assert.ok(info.warnings.some((w) => /requirements\.txt.*outside the repository/.test(w)), info.warnings.join(' | '));
  // Not "no packages": the vulnerability detector renders that as clean.
  assert.equal((await pythonInventory().read(dir)).unsupported, 'requirements.txt');
});

test('an npm lockfile linked outside the repository is not read', async () => {
  // A lockfile that parses, so the only thing that can keep it out is where it is.
  const lockfile = path.join(sandbox, 'package-lock.json');
  await writeFile(
    lockfile,
    JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/leaked': { version: '1.0.0' } } }),
  );
  const dir = await repo({ 'package.json': '{"name":"app","dependencies":{}}' }, { 'package-lock.json': lockfile });
  const lock = await readLockfile(dir);
  assert.equal(lock.tree.size, 0);
  assert.equal(lock.unsupported, 'package-lock.json');
});

test('a package.json linked outside the repository fails the scan by name', async () => {
  // Failing loud is what an unreadable package.json already does; a link out
  // of the checkout is one more way for it to be unreadable.
  const dir = await repo({}, { 'package.json': secret });
  await assert.rejects(() => inventoryFor('npm')!.declared(dir), /package\.json.*outside the repository/);
});

test('the file walk leaves out links that lead outside the repository, and names them', async () => {
  // Every reader of walked files — pins, detectors, lint tools, call-site
  // resolvers — reads whatever the walk returns, so the walk is where to stop it.
  const outsideDir = path.join(sandbox, 'elsewhere');
  await mkdir(outsideDir, { recursive: true });
  await writeFile(path.join(outsideDir, 'creds.ts'), 'export const key = "not yours";\n');
  const dir = await repo(
    { 'src/app.ts': 'export {};\n', 'src/real.sh': 'echo\n' },
    { Dockerfile: secret, 'src/vendored': outsideDir, 'src/alias.sh': 'real.sh' },
  );

  const escaped: string[] = [];
  const walked = walkDir(dir, ['.ts', '.sh', 'Dockerfile'], escaped).map((f) => path.relative(dir, f)).sort();
  // A link that stays inside the repository is still the repository's own file.
  assert.deepEqual(walked, ['src/alias.sh', 'src/app.ts', 'src/real.sh']);
  assert.deepEqual(escaped.sort(), ['Dockerfile', 'src/vendored']);
});

test('a scan says which links out of the repository it left unread', async () => {
  // Leaving them out silently would be a Dockerfile, a script or a source file
  // the scan never read, reported as though the repository had none.
  const dir = await repo({ 'package.json': '{"name":"app"}' }, { Dockerfile: secret });
  const report = await scanRepo(dir);
  assert.ok(
    report.warnings.some((w) => /Dockerfile/.test(w) && /outside the repository/.test(w)),
    report.warnings.join(' | '),
  );
});

test('a manifest refused for linking outside is said once, not once per reader', async () => {
  // Both the dependency list and the vulnerability screen read the manifest;
  // a warning repeated is a warning a reader starts skipping.
  const dir = await repo({}, { 'requirements.txt': secret });
  const report = await scanRepo(dir, { vulnerabilities: { scan: async () => [] } });
  const said = report.warnings.filter((w) => /requirements\.txt is a link/.test(w));
  assert.equal(said.length, 1, report.warnings.join(' | '));
});
