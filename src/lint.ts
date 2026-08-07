/**
 * External linters, as detectors.
 *
 * A Dockerfile and a shell script are as much a part of "does this repository
 * still work" as its TypeScript, and neither has a type checker. hadolint and
 * shellcheck are the mature answers, so Emend adapts them rather than
 * reimplementing their rule sets.
 *
 * The trap, measured on both: **a linter exits non-zero when it finds
 * something.** `hadolint -f json` and `shellcheck --format=json1` both exit 1
 * with a full report on stdout, so treating a non-zero exit as failure silently
 * discards every finding — the tool looks like it ran and found nothing. Output
 * is parsed regardless of the exit code, and the code is only consulted when
 * there is nothing to parse.
 *
 * A tool that is not installed is reported as absent, never as clean. The same
 * rule the harness follows: asking for a check and silently not getting one is
 * worse than not asking.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface LintFinding {
  /** Repo-relative. */
  file: string;
  line: number;
  column: number;
  /** `DL3006`, `SC2086` — stable, searchable, and what the tool's docs use. */
  code: string;
  /** `error`, `warning`, `info`, `style`. The tool's own word. */
  level: string;
  message: string;
  tool: string;
}

export type LintAvailability = { ok: true } | { ok: false; reason: string };

export interface LintAdapter {
  id: string;
  available(): Promise<LintAvailability>;
  /** Which of these files this tool has an opinion about. */
  applies(files: string[]): string[];
  run(dir: string, files: string[]): Promise<{ findings: LintFinding[]; error?: string }>;
}

/**
 * Run a linter and read its report whatever it exits with.
 *
 * `execFile` rejects on a non-zero exit, and both tools exit 1 precisely when
 * they have something to say — so the rejection carries the report.
 */
async function runTool(
  bin: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; failed: boolean }> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return { stdout, stderr, failed: false };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', failed: true };
  }
}

async function probe(bin: string, versionArg = '--version'): Promise<LintAvailability> {
  try {
    await execFileAsync(bin, [versionArg], { timeout: 15_000 });
    return { ok: true };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `\`${bin}\` is not available — ${why}` };
  }
}

/** Dockerfile, Dockerfile.prod, api.Dockerfile — the conventions people use. */
const DOCKERFILE = /(^|\/)(Dockerfile|Containerfile)(\.[\w.-]+)?$|\.(Dockerfile|dockerfile)$/;

/**
 * hadolint over the repository's Dockerfiles.
 *
 * Output shape confirmed live: a flat array of
 * `{code, column, file, level, line, message}`, exit 1 when non-empty.
 */
export function hadolintAdapter(options: { bin?: string } = {}): LintAdapter {
  const bin = options.bin ?? 'hadolint';
  return {
    id: 'hadolint',
    available: () => probe(bin),
    applies: (files) => files.filter((f) => DOCKERFILE.test(f)),

    async run(dir, files) {
      if (files.length === 0) return { findings: [] };
      const { stdout, stderr, failed } = await runTool(bin, ['-f', 'json', ...files], dir);
      let raw: Array<Record<string, unknown>>;
      try {
        raw = JSON.parse(stdout) as Array<Record<string, unknown>>;
      } catch {
        // Nothing parseable *and* a non-zero exit is a real failure, as opposed
        // to the ordinary case where the exit code just means "found things".
        return failed
          ? { findings: [], error: stderr.trim() || 'hadolint produced no readable output' }
          : { findings: [] };
      }
      if (!Array.isArray(raw)) return { findings: [] };

      return {
        findings: raw.flatMap((entry): LintFinding[] => {
          const file = typeof entry['file'] === 'string' ? entry['file'] : '';
          const code = typeof entry['code'] === 'string' ? entry['code'] : '';
          if (!file || !code) return [];
          return [
            {
              file,
              line: typeof entry['line'] === 'number' ? entry['line'] : 1,
              column: typeof entry['column'] === 'number' ? entry['column'] : 1,
              code,
              level: typeof entry['level'] === 'string' ? entry['level'] : 'warning',
              message: typeof entry['message'] === 'string' ? entry['message'] : '',
              tool: 'hadolint',
            },
          ];
        }),
      };
    },
  };
}

/**
 * shellcheck over the repository's shell scripts.
 *
 * A different envelope from hadolint's, confirmed live: `{comments: [...]}`
 * rather than a bare array, and a numeric `code` that its own documentation and
 * every directive spells `SC2086`.
 */
export function shellcheckAdapter(options: { bin?: string } = {}): LintAdapter {
  const bin = options.bin ?? 'shellcheck';
  return {
    id: 'shellcheck',
    available: () => probe(bin),
    applies: (files) => files.filter((f) => /\.(sh|bash|ksh)$/.test(f)),

    async run(dir, files) {
      if (files.length === 0) return { findings: [] };
      const { stdout, stderr, failed } = await runTool(bin, ['--format=json1', ...files], dir);
      let doc: { comments?: Array<Record<string, unknown>> };
      try {
        doc = JSON.parse(stdout) as typeof doc;
      } catch {
        return failed
          ? { findings: [], error: stderr.trim() || 'shellcheck produced no readable output' }
          : { findings: [] };
      }
      const comments = doc?.comments;
      if (!Array.isArray(comments)) return { findings: [] };

      return {
        findings: comments.flatMap((entry): LintFinding[] => {
          const file = typeof entry['file'] === 'string' ? entry['file'] : '';
          if (!file) return [];
          const code = typeof entry['code'] === 'number' ? `SC${entry['code']}` : '';
          if (!code) return [];
          return [
            {
              file,
              line: typeof entry['line'] === 'number' ? entry['line'] : 1,
              column: typeof entry['column'] === 'number' ? entry['column'] : 1,
              code,
              level: typeof entry['level'] === 'string' ? entry['level'] : 'warning',
              message: typeof entry['message'] === 'string' ? entry['message'] : '',
              tool: 'shellcheck',
            },
          ];
        }),
      };
    },
  };
}

export const LINT_ADAPTERS: LintAdapter[] = [hadolintAdapter(), shellcheckAdapter()];
