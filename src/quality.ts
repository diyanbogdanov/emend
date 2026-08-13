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

import { readFile, readdir } from 'node:fs/promises';
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
 * Whether `source` still accesses `member` as a property.
 *
 * A member deprecation is never a named import — `ZodString.uuid` is reached as
 * `z.string().uuid()`, so `importsSymbolFrom` cannot see it at all. The dot is
 * what makes this safe to search for: bare `uuid` also matches the `uuid`
 * package, a local variable, and the word in a comment, while `.uuid` is a
 * property access on something.
 */
function usesMemberAccess(source: string, member: string): boolean {
  return new RegExp(`\\.\\s*${member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(source);
}

/**
 * Whether a deprecation is still outstanding in this source.
 *
 * Deliberately *not* used by `remainingDeprecations`, which reports to a human.
 * The two callers want opposite failure directions:
 *
 *  - Reporting a gap that is not real tells a reviewer the migration is
 *    unfinished when it is finished, and a false "still deprecated" is
 *    indistinguishable from a true one to whoever reads the pull request. So
 *    that path stays import-scoped and errs toward silence.
 *  - The evidence gate uses this to decide whether an edit at a deprecation's
 *    call site is requested. Missing a real deprecation there withholds the
 *    migration itself; claiming one that is not real merely permits an edit that
 *    verification still judges. So this errs toward presence.
 *
 * Top-level exports keep the import check, because `.Cell` never appears even
 * when `Cell` is very much in use.
 */
export function deprecationStillPresent(symbolPath: string, pkg: string, source: string): boolean {
  const dot = symbolPath.lastIndexOf('.');
  const leaf = dot === -1 ? symbolPath : symbolPath.slice(dot + 1);
  return dot === -1 ? importsSymbolFrom(source, leaf, pkg) : usesMemberAccess(source, leaf);
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

// ---------------------------------------------------------------------------
// Did the migration finish?
// ---------------------------------------------------------------------------

/**
 * What "finished" means for one symbol, expressed as something that can run.
 *
 * Not "the symbol is absent", which reports a *finished* migration as unfinished
 * and the corpus holds the counter-example: `z.string().uuid()` becomes
 * `z.uuid()`, so searching for `.uuid` finds the correct answer. `z.record` is
 * the same from the other side — it still exists in zod 4 with a different arity,
 * so its presence proves nothing — and `ZodError.errors` -> `.issues` is a member
 * rename rather than a removal.
 *
 * Resolved means the *pre-migration form* is gone, which is checkable only if the
 * old form is declared. Two kinds cover it:
 *
 *  - `import` for a top-level named import, which is what `importsSymbolFrom`
 *    already answers and is already tested.
 *  - `absent` for a call chain, which is never imported and is invisible to the
 *    other kind — the blind spot `RECHARTS_CASE` records for zod.
 */
export type ResolutionCheck =
  | { symbol: string; kind: 'import'; pkg: string }
  | { symbol: string; kind: 'absent'; pattern: string };

export interface Resolution {
  check: ResolutionCheck;
  /**
   * `unknown` is its own state, never folded into either other one.
   *
   * The cardinal rule, turned on the thing that measures: a file that could not
   * be read is not evidence that the migration finished, and scoring it as
   * `resolved` is the same claim Emend refuses to make about a call site it
   * could not parse.
   */
  state: 'resolved' | 'unresolved' | 'unknown';
  /** Repo-relative files still holding the pre-migration form. */
  files: string[];
  /** Why the check could not run, when it could not. */
  reason?: string;
}

/**
 * Whether this source still holds the check's pre-migration form.
 *
 * The single primitive behind both the completeness measurement and the corpus's
 * baseline-fires test. One function on purpose: if the test asked a different
 * question than the measurement, it would prove nothing about it.
 *
 * Throws on a pattern that will not compile — an authoring error in the corpus,
 * which should be loud rather than a check that quietly never matches.
 */
export function checkFires(check: ResolutionCheck, source: string): boolean {
  if (check.kind === 'import') return importsSymbolFrom(source, check.symbol, check.pkg);
  if (check.kind === 'absent') return new RegExp(check.pattern).test(source);
  // `loadCases` casts parsed JSON straight to `EvalCase[]`, so an external corpus
  // can hand this anything. Throwing makes it `unknown` a few lines down, where a
  // fallthrough would have made it `resolved` — a check nobody can run reported as
  // a migration that finished.
  throw new Error(`unrecognised completeness check kind: ${JSON.stringify(check)}`);
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** Every source file under `dir`, repo-relative. Vendored trees are not the migration. */
async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(dir, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(rel);
      else if (entry.isFile() && SOURCE_FILE.test(entry.name)) found.push(rel);
    }
  };
  await walk('');

  return found.sort();
}

/**
 * Which of a case's completeness checks the migration actually resolved.
 *
 * Reads the whole source tree rather than a finding's own sites, because a case
 * declares these against the migration and not against a finding — the work may
 * legitimately land somewhere the scan never named.
 *
 * A tree with no readable source at all makes every check `unknown`. That is the
 * state this distinguishes: the migration was not measured, which is not the same
 * as measured and complete.
 */
export async function resolveChecks(
  checks: readonly ResolutionCheck[],
  dir: string,
): Promise<Resolution[]> {
  if (checks.length === 0) return [];

  const files = await sourceFiles(dir);
  const read = await Promise.all(
    files.map(async (file): Promise<[string, string] | null> => {
      try {
        return [file, await readFile(path.join(dir, file), 'utf8')];
      } catch {
        // Unreadable: it contributes nothing either way, and an empty map below
        // is what turns "nothing could be read" into `unknown`, not `resolved`.
        return null;
      }
    }),
  );
  const sources = new Map(read.filter((entry) => entry !== null));

  // Hoisted: whether anything could be read is a property of the tree, not of a
  // check, and asking it once says so. Every check is `unknown` together or none
  // is.
  if (sources.size === 0) {
    return checks.map((check) => ({
      check,
      state: 'unknown' as const,
      files: [],
      reason: 'no source files could be read',
    }));
  }

  return checks.map((check): Resolution => {
    try {
      const files = [...sources]
        .filter(([, source]) => checkFires(check, source))
        .map(([file]) => file);
      return files.length > 0
        ? { check, state: 'unresolved', files }
        : { check, state: 'resolved', files: [] };
    } catch (err) {
      return {
        check,
        state: 'unknown',
        files: [],
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
