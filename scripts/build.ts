/**
 * Bundle the CLI into plain JavaScript, for the one place the sources cannot run.
 *
 * Emend runs its TypeScript directly through Node's native type stripping, and
 * that is still how it runs from a checkout — there is no build step to do
 * development behind. But Node refuses to strip types for any file under
 * `node_modules`, without an override, so a published package that shipped only
 * `.ts` would fail on `emend --help` for every user who installed it. Measured
 * before it shipped: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, from a
 * tarball, on the first command in the README.
 *
 * So this exists for distribution and nothing else. `npm run build` before
 * packing, never during development.
 *
 *   node --experimental-strip-types scripts/build.ts
 */

import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};

/**
 * The real dependencies stay real.
 *
 * They are declared in `dependencies` and npm installs them beside the bundle,
 * so inlining them would ship a second copy that no longer dedupes and can no
 * longer be patched. `typescript` alone is the larger part of an order of
 * magnitude here, and it is loaded for its compiler API rather than for a
 * handful of helpers — exactly the kind of thing a bundler should leave alone.
 */
const external = Object.keys(manifest.dependencies ?? {});

const result = await build({
  entryPoints: [path.join(root, 'src', 'cli.ts')],
  outfile: path.join(root, 'dist', 'cli.js'),
  bundle: true,
  platform: 'node',
  // ESM, because the sources are: `package.json` says `"type": "module"`, and
  // the code uses top-level await and `import.meta`. Emitting CJS would mean
  // rewriting both into something that only exists in the shipped copy.
  format: 'esm',
  // Matches `engines.node`. Nothing is downlevelled that the floor supports, so
  // what runs from the bundle is what was written.
  target: 'node22.6',
  external,
  sourcemap: true,
  // Named after what it is when it fails: a stack trace from the bundle should
  // say `dist/cli.js`, and the source map beside it says which of the fifty
  // source files that was.
  legalComments: 'inline',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
const inputs = Object.keys(result.metafile.inputs).length;
// stderr, because `prepack` runs this and `npm pack --json` puts machine-readable
// output on stdout. Progress written there is not a second opinion about what was
// packed, it is corruption of the answer — measured, as an unparseable `--json`.
console.error(`bundled ${inputs} module(s) -> dist/cli.js (${(bytes / 1024).toFixed(0)}kB)`);
console.error(`external: ${external.join(', ') || '(none)'}`);
