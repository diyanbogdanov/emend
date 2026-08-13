/**
 * Where Emend's own files are, asked in a way that survives being bundled.
 *
 * Three things ship beside the code and are read at runtime: `skills/`, which a
 * review is composed from, `fixtures/`, which `emend demo` and the corpus copy
 * from, and `bin/`, which is how a child process re-enters the CLI. Every one of
 * them was found by counting `..` from the module that wanted it — `src/llm/`
 * needs two, `src/` needs one — which is correct exactly as long as the module
 * stays where it was written.
 *
 * A bundle moves it. `dist/cli.js` is one file at one depth, and the same
 * `'..', '..', 'skills'` that resolves inside the repository resolves *above*
 * the package once the code arrives there. The count is not the answer to the
 * question; it is an encoding of one layout, and there are now two.
 *
 * So the question is asked directly instead. `package.json` is what marks the
 * root of an installed package, and it is there in both layouts.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The package's own root directory.
 *
 * Resolved from this module's location rather than the working directory: Emend
 * spends its life running inside repositories that are not itself, and `cwd` is
 * reliably somebody else's.
 *
 * Computed once. It cannot change while the process lives, and every caller is
 * on a path where a stat per lookup would be waste.
 */
export const PACKAGE_ROOT: string = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  // Bounded rather than "until the filesystem root": an unbounded walk from a
  // module in the wrong place finds whatever package.json is nearest above it
  // and confidently reads another project's directories as Emend's own. The
  // walk starts from *this* module, which is one level down in both layouts —
  // `src/paths.ts` and, once bundled into it, `dist/cli.js` — so two is the
  // real requirement and the extra two are slack. A miss is an error, not a
  // guess.
  for (let up = 0; up < 4; up++) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `could not locate Emend's package root from ${fileURLToPath(import.meta.url)} — ` +
      'no package.json within four directories above it',
  );
})();

/** A path inside the package, e.g. `emendPath('skills')`. */
export function emendPath(...segments: string[]): string {
  return path.join(PACKAGE_ROOT, ...segments);
}
