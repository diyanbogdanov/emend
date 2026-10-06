import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Finding } from '../src/types.ts';

// The vulnerability detector decided whether a package is imported by reading
// JavaScript and TypeScript imports only, so every Python vulnerability read
// "not imported from this repository's source" — on a repository whose own
// app.py said `import yaml`. That sentence is the finding's load-bearing
// negative: it is what tells a reader a vulnerable package is only reached
// through someone else's code.
//
// Import names come from each package's wheel, so the cache is sandboxed before
// anything is imported (see pypisafety.test.ts) and PyPI is served from a stub.
const sandbox = await mkdtemp(path.join(tmpdir(), 'emend-pyreach-'));
process.env.EMEND_CACHE = path.join(sandbox, 'cache');
const { vulnerabilityDetector } = await import('../src/detectors.ts');

/** A wheel of stored (uncompressed) entries — the shape is the point, not the compression. */
function wheelOf(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [entry, text] of Object.entries(files)) {
    const name = Buffer.from(entry);
    const body = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(body.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(dir, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length / 2, 8);
  eocd.writeUInt16LE(central.length / 2, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, eocd]);
}

const wheels: Record<string, Buffer> = {
  'PyYAML/5.4.1': wheelOf({ 'yaml/__init__.py': 'def load(stream, Loader=None):\n    pass\n' }),
  'idna/2.10': wheelOf({ 'idna/__init__.py': 'def encode(s):\n    pass\n' }),
  // mystery/1.0 is never served: PyPI answers 404 for it.
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  for (const [coordinates, wheel] of Object.entries(wheels)) {
    const wheelUrl = `https://files.pythonhosted.org/${coordinates}.whl`;
    if (url === wheelUrl) return new Response(new Uint8Array(wheel));
    if (url === `https://pypi.org/pypi/${coordinates}/json`) {
      const sha256 = createHash('sha256').update(wheel).digest('hex');
      return new Response(
        JSON.stringify({
          urls: [
            {
              filename: `${coordinates.replace('/', '-')}-py3-none-any.whl`,
              packagetype: 'bdist_wheel',
              url: wheelUrl,
              size: wheel.length,
              digests: { sha256 },
            },
          ],
        }),
      );
    }
  }
  return new Response('not found', { status: 404 });
}) as typeof fetch;

test.after(async () => {
  globalThis.fetch = realFetch;
  await rm(sandbox, { recursive: true, force: true });
});

let findings: Promise<Finding[]> | undefined;
async function finding(pkg: string): Promise<Finding> {
  findings ??= (async () => {
    const dir = await mkdtemp(path.join(sandbox, 'repo-'));
    await writeFile(path.join(dir, 'requirements.txt'), 'PyYAML==5.4.1\nidna==2.10\nmystery==1.0\n');
    await writeFile(path.join(dir, 'app.py'), 'import yaml\n\nconfig = yaml.load(open("c.yml"))\n');
    const detector = vulnerabilityDetector({
      scan: async (packages) =>
        packages.map((p) => ({
          ...p,
          vulnerabilities: [
            { id: `GHSA-${p.name}`, aliases: [], cve: null, summary: '', fixedIn: null, cvssVector: null },
          ],
        })),
    });
    const result = await detector.detect({
      repoDir: dir,
      dependencies: [],
      sourceFiles: ['requirements.txt', 'app.py'],
      read: async (file: string): Promise<string | null> => {
        try {
          return await (await import('node:fs/promises')).readFile(path.join(dir, file), 'utf8');
        } catch {
          return null;
        }
      },
    });
    return result.findings;
  })();
  const found = (await findings).find((f) => f.pkg === pkg);
  assert.ok(found, `no finding for ${pkg}`);
  return found;
}

test('a Python vulnerability is reported where the repository imports it, under its module name', async () => {
  const yaml = await finding('PyYAML');
  assert.match(yaml.change.guidance ?? '', /imported at 1 site/);
  assert.deepEqual(yaml.sites.map((s) => `${s.file}:${s.line}`), ['app.py:1']);
});

test('a Python package nothing imports is still said to be unimported', async () => {
  // The control: the negative is only worth anything if it still holds when true.
  assert.match((await finding('idna')).change.guidance ?? '', /not imported/);
});

test('a package whose import names cannot be read is never called unimported', async () => {
  // Without the wheel there is nothing to say what `mystery` is imported as.
  // "Not imported" would be a claim nobody checked.
  const mystery = (await finding('mystery')).change.guidance ?? '';
  assert.doesNotMatch(mystery, /not imported/);
  assert.match(mystery, /could not be checked/);
});
