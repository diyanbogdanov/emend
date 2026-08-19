/**
 * Python's verification runner: claims a repository only when mypy or pyright
 * is configured.
 *
 * Python has no compile step. mypy and pyright are optional tools that are
 * often absent from a Python repository; pytest is usually not. A runner that
 * claimed on tests alone would make "pytest ran" the entire proof behind a
 * migration, for a language with no static safety net — a materially weaker
 * bar than TypeScript's runner clears today, where the typecheck is most of
 * what `compare` leans on to tell a real pass from a lucky one.
 *
 * Three designs were considered for a Python repository that has tests but no
 * typechecker: accept a new "tests-only" outcome; add that outcome but refuse
 * it in `verificationPassed`; or claim the repository with nothing at all.
 * The first two were rejected because both run through the same `compare` and
 * `verificationPassed` that TypeScript uses — either one would change what a
 * TypeScript repository can earn too, for repositories Emend already verifies
 * today. This module is the third design: it does not claim such a repository
 * at all. `runnerFor` moves on to find nothing else claims it either,
 * `runPhase` returns two skipped results, `compare` reports `unverified`, and
 * `verificationPassed` rejects it.
 *
 * That is a deliberate refusal to act, not an oversight: Emend does nothing
 * for a Python repository with tests and no type checking, on purpose. Do not
 * "fix" this by loosening the gate below or by inventing a weaker passing
 * outcome for that case — both were the rejected designs above.
 */

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { runCommand, skipped } from '../commands.ts';
import type { CommandResult } from '../types.ts';
import type { DiagnosticParser, VerifyRunner } from '../verify.ts';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readIfExists(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Escapes `s` for literal use inside a `RegExp`.
 *
 * Every name passed to `hasToolTable`/`hasIniSection` below is a string
 * literal this file wrote, not user input — but `pytest.ini_options`'s dot is
 * still a regex metacharacter, and leaving it unescaped would make the check
 * match on any single character in that position rather than a literal dot.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `content` (a `pyproject.toml`) configures `[tool.<name>]`.
 *
 * Anchored to the header appearing at the start of a line, not a raw
 * substring search over the whole file. `dependencies = ["mypy"]` names the
 * mypy package as something to install; it does not configure it, and a
 * naive `content.includes(name)` cannot tell those two apart — it claims on
 * that dependency entry alone. "a pyproject.toml with no [tool.mypy] section
 * does not claim" in test/pythonverify.test.ts exists to pin exactly this
 * difference between naming a tool and configuring it.
 */
function hasToolTable(content: string, name: string): boolean {
  return new RegExp(`^\\s*\\[tool\\.${escapeRegExp(name)}\\]`, 'm').test(content);
}

/** Whether `content` (an INI file: `setup.cfg`) has a bare `[<name>]` section. */
function hasIniSection(content: string, name: string): boolean {
  return new RegExp(`^\\s*\\[${escapeRegExp(name)}\\]`, 'm').test(content);
}

type Typechecker = 'mypy' | 'pyright';

/**
 * Which typechecker, if any, this repository has configured — the entire
 * claiming decision for `pythonRunner`, and this module's whole reason to
 * exist (see the module doc).
 *
 * mypy wins when a repository configures both: `pythonParser` below only
 * knows how to read mypy's diagnostic format, so preferring pyright here
 * would run a typecheck whose output nothing downstream can count.
 *
 * `pyproject.toml` is read once and the content reused for both the mypy and
 * pyright table checks, rather than reading it again for each.
 */
async function detectTypechecker(dir: string): Promise<Typechecker | undefined> {
  if (await exists(path.join(dir, 'mypy.ini'))) return 'mypy';

  const pyproject = await readIfExists(path.join(dir, 'pyproject.toml'));
  if (pyproject && hasToolTable(pyproject, 'mypy')) return 'mypy';

  const setupCfg = await readIfExists(path.join(dir, 'setup.cfg'));
  if (setupCfg && hasIniSection(setupCfg, 'mypy')) return 'mypy';

  if (await exists(path.join(dir, 'pyrightconfig.json'))) return 'pyright';
  if (pyproject && hasToolTable(pyproject, 'pyright')) return 'pyright';

  return undefined;
}

/**
 * Whether pytest is configured, or conventionally present, in `dir`.
 *
 * Unlike `detectTypechecker`, this never gates `applies` — a repository with
 * only this and no typechecker is still left unclaimed, per the module doc.
 * It decides only how `run` tests: an actual `pytest` invocation when this is
 * true, a stated skip reason when it is false.
 */
async function hasPytestConfigured(dir: string): Promise<boolean> {
  const pyproject = await readIfExists(path.join(dir, 'pyproject.toml'));
  if (pyproject && hasToolTable(pyproject, 'pytest.ini_options')) return true;
  if (await exists(path.join(dir, 'pytest.ini'))) return true;
  if (await exists(path.join(dir, 'tox.ini'))) return true;
  if (await exists(path.join(dir, 'tests'))) return true;
  return false;
}

async function runPythonTypecheck(dir: string): Promise<CommandResult> {
  const typechecker = await detectTypechecker(dir);
  if (typechecker === 'mypy') return runCommand('mypy', ['.'], dir);
  if (typechecker === 'pyright') return runCommand('pyright', [], dir);
  // Unreached through `runnerFor`, which already gated on `detectTypechecker`
  // inside `applies` below — kept so calling `run` directly on a repository
  // this would never claim degrades honestly instead of throwing, the same
  // fallback shape `runTypecheck` keeps for npm.
  return skipped('typecheck', 'no typechecker configured');
}

async function runPythonTests(dir: string): Promise<CommandResult> {
  if (await hasPytestConfigured(dir)) return runCommand('pytest', [], dir);
  return skipped('pytest', 'no pytest configuration or tests/ directory found');
}

export function pythonRunner(): VerifyRunner {
  return {
    id: 'python',

    applies: async (dir) => (await detectTypechecker(dir)) !== undefined,

    async run(dir, options) {
      return {
        typecheck: await runPythonTypecheck(dir),
        test: options.skipTests
          ? skipped('pytest', 'tests are not run by the hosted analyser; your CI runs them')
          : await runPythonTests(dir),
      };
    },
  };
}

/**
 * `path/to/file.py:28: error: ...` — mypy's default output.
 *
 * Checked by actually running mypy (`mypy --version` reports 2.3.1), not
 * assumed from its docs: the default format omits the column entirely —
 * `file:line: error:`, not `file:line:col: error:` — unless
 * `--show-column-numbers` is passed, which the plain `mypy .` this runner
 * invokes does not. verify.ts's generic `COLON_DIAGNOSTIC` requires a column
 * and so matches none of mypy's default output; see that file's
 * `DiagnosticParser` doc, corrected alongside this module once this was
 * checked. The trailing `(?:\d+:)?` tolerates a column on the rare repository
 * that does turn `--show-column-numbers` on for itself, without depending on
 * it — either way, the location this counts by is file and line.
 */
const MYPY_DIAGNOSTIC = /^\s*(\S+?):(\d+):(?:\d+:)?\s*error\b/gm;

/**
 * How many distinct file:line locations mypy complained about.
 *
 * Follows `countDiagnostics`'s own shape — skip short-circuits to 0, a `Set`
 * dedupes against `${result.stdout}\n${result.stderr}` — rather than
 * inventing a different one, but keys on file and line only: mypy's default
 * output has no column to add to that key.
 */
function countMypyDiagnostics(result: CommandResult): number {
  if (result.skipped) return 0;
  const seen = new Set<string>();
  const pattern = MYPY_DIAGNOSTIC;
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(`${result.stdout}\n${result.stderr}`)) !== null) {
    const [, file, line] = match;
    if (file) seen.add(`${file}:${line}`);
  }
  return seen.size;
}

export function pythonParser(): DiagnosticParser {
  return { handles: (id) => id === 'python', count: countMypyDiagnostics };
}
