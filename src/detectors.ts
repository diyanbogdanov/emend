/**
 * The seam between "something drifted" and everything that acts on it.
 *
 * Emend detects drift from more than one source now — a package's published
 * declarations, a version copied into a Dockerfile, a wire API pinned in a
 * constructor — and each of those was growing its own path to the surface. Pin
 * conflicts in particular lived beside the findings rather than among them, so
 * they were never stored, never tracked across scans, never rendered into a pull
 * request and never shown on the dashboard. Everything downstream consumes
 * `Finding`; anything that is not one is invisible to all of it.
 *
 * A detector's whole contract is: given a repository, produce findings. What it
 * reads, and whether it needs the network, is its own business.
 */

import { createHash } from 'node:crypto';
import { extractPins, findPinConflicts, resolvedVersions, PIN_FILES } from './pins.ts';
import type { Detector, Finding, InstalledDependency } from './types.ts';

/**
 * What every detector is given.
 *
 * `read` rather than a directory, so a detector is a pure function of what it
 * is handed and can be tested without a filesystem. `sourceFiles` is supplied
 * rather than walked, because the call-site pass already walks the repository
 * and doing it again per detector is the kind of cost that accumulates quietly.
 */
export interface DetectorContext {
  repoDir: string;
  dependencies: InstalledDependency[];
  /** Repo-relative source files, already discovered by the caller. */
  sourceFiles: string[];
  read: (file: string) => Promise<string | null>;
}

export interface DetectorFailure {
  detector: string;
  reason: string;
}

export interface DetectorRun {
  findings: Finding[];
  /**
   * Detectors that threw, and why.
   *
   * Returned rather than swallowed. A detector reaching the network or the
   * filesystem will fail sometimes, and a scan that loses every other result
   * because one adapter threw is worse than one that reports what it has — but
   * a scan that hides the failure is worse than both, because a missing finding
   * is indistinguishable from a clean result.
   */
  failures: DetectorFailure[];
}

/** Stable across scans, so the store tracks a finding rather than duplicating it. */
function pinFindingId(subject: string, from: string, to: string, file: string): string {
  return createHash('sha256')
    .update(`version-pin|${subject}|${from}|${to}|${file}`)
    .digest('hex')
    .slice(0, 12);
}

async function readPinFiles(ctx: DetectorContext): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const file of [...PIN_FILES, ...ctx.sourceFiles]) {
    if (files.has(file)) continue;
    const source = await ctx.read(file);
    if (source !== null) files.set(file, source);
  }
  return files;
}

/**
 * Versions the repository copied out of its lockfile into places nothing keeps
 * honest.
 *
 * Only conflicts with an authority become findings. A finding asserts a target
 * version, and three files declaring three versions with nothing to arbitrate
 * has no target — reporting the disagreement is honest, inventing a winner is
 * the guess `plan.ts` refuses to make.
 */
export const versionPinDetector: Detector = {
  id: 'version-pin',

  async applies(ctx: DetectorContext): Promise<boolean> {
    for (const file of PIN_FILES) {
      if ((await ctx.read(file)) !== null) return true;
    }
    return false;
  },

  async detect(ctx: DetectorContext): Promise<Finding[]> {
    const pins = extractPins(await readPinFiles(ctx));
    const conflicts = findPinConflicts(pins, resolvedVersions(ctx.dependencies));

    return conflicts
      .filter((c) => c.expected !== null)
      .flatMap((conflict) =>
        conflict.pins.map((pin): Finding => {
          const to = conflict.expected as string;
          return {
            id: pinFindingId(conflict.subject, pin.version, to, pin.file),
            detector: 'version-pin',
            pkg: conflict.subject,
            fromVersion: pin.version,
            toVersion: to,
            change: {
              path: conflict.subject,
              kind: 'version-drift',
              severity: 'drift',
              confidence: 'high',
              before: pin.version,
              after: to,
              guidance: `${conflict.authority} says ${to}`,
            },
            // The pin itself is the call site. A finding without one is not a
            // finding, and here the evidence is exact: file, line, and the text
            // a repair has to match.
            sites: [{ file: pin.file, line: pin.line, column: 1, text: pin.text, via: 'import' }],
            confidence: 'high',
          };
        }),
      );
  },
};

export const DETECTORS: Detector[] = [versionPinDetector];

/**
 * Run every detector that applies, keeping what succeeds and naming what does not.
 *
 * `applies` is a precondition rather than a hint: a detector that has to read
 * the whole repository before discovering it has no work is one nobody registers.
 */
export async function runDetectors(
  detectors: Detector[],
  ctx: DetectorContext,
): Promise<DetectorRun> {
  const findings: Finding[] = [];
  const failures: DetectorFailure[] = [];

  for (const detector of detectors) {
    try {
      if (!(await detector.applies(ctx))) continue;
      findings.push(...(await detector.detect(ctx)));
    } catch (err) {
      failures.push({ detector: detector.id, reason: (err as Error).message });
    }
  }

  return { findings, failures };
}
