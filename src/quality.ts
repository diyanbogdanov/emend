/**
 * Did the migration actually do what the finding said, and is the result worth
 * merging?
 *
 * Verification answers "does it still compile and pass tests". That is a lower
 * bar than it sounds. On a real recharts 2->3 upgrade Emend reported `Cell` as
 * **deprecated**, titled its commit "migrate `Cell`", and shipped a change that
 * removed no use of `Cell` at all — it fixed the type errors the version bump
 * caused and left the deprecated API in place. Every check passed, because
 * deprecated code compiles and its tests pass.
 *
 * So deprecation completeness is measured here rather than asked for in a
 * prompt. All day the same lesson: the model does what the harness measures.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Finding } from './types.ts';

export interface DeprecationGap {
  /** The symbol the finding said to stop using, e.g. `Cell`. */
  symbol: string;
  pkg: string;
  /** Repo-relative files that still import it from that package. */
  files: string[];
}

/**
 * Whether `file` still imports `symbol` from `pkg`.
 *
 * Scoped to the import statement on purpose. A bare text search for `Cell` also
 * matches this repository's table `Cell`, its `cellRenderer`, and the word in a
 * comment — reporting those as unfinished migrations would be worse than not
 * checking, because a false "still deprecated" is indistinguishable from a real
 * one to whoever reads the PR.
 */
export function importsSymbolFrom(source: string, symbol: string, pkg: string): boolean {
  // `import { a, Cell as C, b } from 'recharts'` and its multi-line form. The
  // specifier must be the package itself or a subpath of it, never a local file
  // that happens to end in the same characters.
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gs;
  for (const match of source.matchAll(importRe)) {
    const [, names = '', specifier = ''] = match;
    if (specifier !== pkg && !specifier.startsWith(`${pkg}/`)) continue;
    for (const entry of names.split(',')) {
      // `Cell as C` still uses Cell; `type Cell` does too.
      const imported = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
      if (imported === symbol) return true;
    }
  }
  return false;
}

/**
 * Deprecated symbols a migration claimed to handle and left in place.
 *
 * Only the files the finding itself named are examined. The scan already
 * decided those are where the symbol is used, and widening the search would
 * re-introduce exactly the false positives `importsSymbolFrom` avoids.
 */
export async function remainingDeprecations(
  findings: Finding[],
  dir: string,
): Promise<DeprecationGap[]> {
  const gaps: DeprecationGap[] = [];

  for (const finding of findings) {
    if (finding.change.kind !== 'deprecated') continue;
    // The leaf: a finding path may be `Cell` or `SomeNamespace.Cell`.
    const symbol = finding.change.path.split('.').pop() ?? finding.change.path;
    const files: string[] = [];

    for (const file of new Set(finding.sites.map((s) => s.file))) {
      let source: string;
      try {
        source = await readFile(path.join(dir, file), 'utf8');
      } catch {
        // Deleted or moved by the migration, which is a legitimate outcome.
        continue;
      }
      if (importsSymbolFrom(source, symbol, finding.pkg)) files.push(file);
    }

    if (files.length > 0) gaps.push({ symbol, pkg: finding.pkg, files: files.sort() });
  }

  return gaps;
}

/** One line per gap, for a prompt or a progress log. */
export function describeDeprecationGaps(gaps: DeprecationGap[]): string {
  return gaps
    .map(
      (g) =>
        `- \`${g.symbol}\` is deprecated in ${g.pkg} and is still imported by: ${g.files.join(', ')}`,
    )
    .join('\n');
}
