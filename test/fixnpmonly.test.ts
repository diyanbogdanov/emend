import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Finding } from '../src/types.ts';

// `emend fix` bumps through `bumpDependency`, which runs npm, pnpm, yarn or bun
// and nothing else. Since Python joined the scan, a PyPI finding reaching it
// ran `npm install <pypi-name>` — whatever unrelated npm package shares the
// name, install scripts included unless --untrusted — and the requirements
// file stayed exactly as it was.
//
// A stand-in `npm` goes first on PATH, so the property is measured directly
// (was npm ever run?) and a regression can never install anything real. The
// cache is sandboxed for the reason pypisafety.test.ts gives, and fetch fails,
// so nothing here reaches the network either.
const sandbox = await mkdtemp(path.join(tmpdir(), 'emend-fixnpm-'));
process.env.EMEND_CACHE = path.join(sandbox, 'cache');
const npmLog = path.join(sandbox, 'npm-invocations.log');
const fakeBin = path.join(sandbox, 'bin');
await mkdir(fakeBin);
await writeFile(path.join(fakeBin, 'npm'), `#!/bin/sh\necho "$@" >> "${npmLog}"\nexit 1\n`);
await chmod(path.join(fakeBin, 'npm'), 0o755);
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response('offline', { status: 503 })) as typeof fetch;

const { assertNpmPackage, fixFreshness, fixPackage, fixVulnerability } = await import('../src/fix.ts');

test.after(async () => {
  globalThis.fetch = realFetch;
  await rm(sandbox, { recursive: true, force: true });
});

async function npmRuns(): Promise<string> {
  return existsSync(npmLog) ? readFile(npmLog, 'utf8') : '';
}

async function pythonRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(sandbox, 'py-'));
  await writeFile(path.join(dir, 'requirements.txt'), 'idna==2.10\n');
  await writeFile(path.join(dir, 'app.py'), 'import idna\n');
  return dir;
}

function finding(detector: string): Finding {
  return {
    id: `${detector}-idna`,
    detector,
    pkg: 'idna',
    fromVersion: '2.10',
    toVersion: '3.7',
    change: {
      path: 'idna.encode',
      kind: 'signature-changed',
      severity: 'breaking',
      confidence: 'high',
      before: null,
      after: null,
    },
    sites: [],
    confidence: 'high',
  };
}

test('a PyPI vulnerability finding is refused before npm is ever run', async () => {
  // The remediation is planned from directs that readRepo answers in PyPI
  // names, so idna reads as a direct dependency and the plan is `npm install`.
  await rm(npmLog, { force: true });
  const dir = await pythonRepo();
  await assert.rejects(
    () => fixVulnerability(dir, finding('vulnerability')),
    /npm packages only/,
  );
  assert.equal(await npmRuns(), '');
});

test('a PyPI freshness finding is refused before npm is ever run', async () => {
  await rm(npmLog, { force: true });
  const dir = await pythonRepo();
  await assert.rejects(
    () => fixFreshness(dir, finding('freshness')),
    /npm packages only/,
  );
  assert.equal(await npmRuns(), '');
});

test('a PyPI surface finding is refused before anything is fetched or run', async () => {
  await rm(npmLog, { force: true });
  const dir = await pythonRepo();
  await assert.rejects(
    () => fixPackage(dir, [finding('pypi-surface')]),
    /npm packages only/,
  );
  assert.equal(await npmRuns(), '');
});

test('in a repository npm and Python both claim, only npm packages pass', async () => {
  // The control. A vulnerability fix bumps packages the lockfile installs but
  // package.json never names, so "declared" alone would refuse real npm fixes;
  // and the vulnerability detector screens every ecosystem that claims the
  // repository, so a PyPI finding can arrive here while npm owns readRepo.
  const dir = await mkdtemp(path.join(sandbox, 'both-'));
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'both', dependencies: { 'left-pad': '^1.3.0' } }),
  );
  await writeFile(
    path.join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'both',
      lockfileVersion: 3,
      packages: {
        '': { name: 'both', dependencies: { 'left-pad': '^1.3.0' } },
        'node_modules/left-pad': { version: '1.3.0' },
        'node_modules/wrappy': { version: '1.0.2' },
      },
    }),
  );
  await writeFile(path.join(dir, 'requirements.txt'), 'idna==2.10\n');

  await assertNpmPackage(dir, 'left-pad'); // declared
  await assertNpmPackage(dir, 'wrappy'); // installed, never declared
  await assert.rejects(() => assertNpmPackage(dir, 'idna'), /npm packages only/);
});
