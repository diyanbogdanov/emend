/**
 * PEP 440 ordering, which is not semver.
 *
 * `osv.ts` decides whether an installed version sits below an advisory's fixed
 * version by comparing them, so getting this wrong reports vulnerabilities that
 * do not exist and hides ones that do — in that order of visibility, which is the
 * worse way round.
 *
 * Four ways PEP 440 differs from semver, each of which semver gets silently wrong
 * rather than loudly:
 *
 * - **Epochs.** `1!1.0` outranks `2.0`. An epoch exists so a project can restart
 *   its numbering, so height below it is irrelevant. Semver has no `!` concept:
 *   `parseInt('1!1', 10)` stops at the `!` and returns `1`, so semver reads
 *   `1!1.0` as major version 1 and ranks it *below* `2.0` — the wrong direction,
 *   not a NaN or a tie.
 * - **Post-releases.** `1.0.post1` outranks `1.0`. Semver splits on `-`, finds no
 *   prerelease, and calls them equal.
 * - **Dev releases.** `1.0.dev1` is below `1.0a1`, which is below `1.0`.
 * - **Local versions.** `1.0+local` outranks `1.0`.
 *
 * Deliberately not a full PEP 440 implementation: normalisation of alternative
 * spellings (`1.0-alpha`, `1.0.a1`, `rev`/`r` as post-release aliases) is not
 * done. Those forms are rare on PyPI and handling them would be guessing at
 * inputs nobody has measured. An unparseable version sorts lowest rather than
 * throwing, so one malformed package cannot abort a scan — and lowest means it is
 * never proposed as an upgrade target.
 */

import type { VersionScheme } from './versions.ts';

/**
 * Ordering of release phases, lowest to highest.
 *
 * `dev` sorts below every lettered pre-release, even `a0`: PEP 440 treats a bare
 * `.devN` (no `a`/`b`/`rc`, no `.postN`) as a preview of the release itself, not
 * of any numbered pre-release, so it has to rank below all of them, not just
 * below the release. `post` outranks the plain release: a `.postN` is a
 * packaging fix layered on a release that already shipped, not a step toward one.
 */
const PHASE = { dev: 0, a: 1, b: 2, rc: 3, release: 4, post: 5 } as const;

type Phase = keyof typeof PHASE;

/**
 * Matches `[N!]N(.N)*[{a|b|rc}N][.postN][.devN][+local]` in one pass — see the
 * module doc for why normalising alternate spellings first is deliberately not
 * done.
 */
const PEP440_RE =
  /^(?:(\d+)!)?(\d+(?:\.\d+)*)(?:(a|b|rc)(\d+))?(?:\.post(\d+))?(?:\.dev(\d+))?(?:\+([a-zA-Z0-9._-]+))?$/;

interface Parsed {
  epoch: number;
  release: number[];
  phase: Phase;
  phaseNumber: number;
  /**
   * The `.devN` number, kept separately from `phase`/`phaseNumber` rather than
   * folded into the `dev` phase bucket. A dev release can preview a pre-release
   * or a post-release (`1.0a1.dev1`, `1.0.post1.dev1`), and those need to sort
   * below the thing they preview without changing which phase bucket they are
   * in. `undefined` means no `.devN` at all, which must outrank having one.
   */
  dev: number | undefined;
  local: string | undefined;
}

function parse(version: string): Parsed | null {
  const m = PEP440_RE.exec(version);
  if (!m) return null;
  const [, epochStr, releaseStr, preLetter, preNumStr, postStr, devStr, local] = m;
  // The release segment is mandatory in PEP440_RE, so a successful match always
  // captures it. This check exists only because `noUncheckedIndexedAccess` can't
  // see that from the regex — it is not a real "unparseable" path, so it is not
  // separately tested; it is here instead of a `!` so a future edit that breaks
  // that guarantee fails safe (sorts lowest) rather than crashing or lying.
  if (releaseStr === undefined) return null;

  const dev = devStr === undefined ? undefined : Number.parseInt(devStr, 10);

  let phase: Phase;
  let phaseNumber: number;
  if (preLetter === 'a' || preLetter === 'b' || preLetter === 'rc') {
    if (preNumStr === undefined) return null; // same reasoning as releaseStr above
    phase = preLetter;
    phaseNumber = Number.parseInt(preNumStr, 10);
  } else if (postStr !== undefined) {
    phase = 'post';
    phaseNumber = Number.parseInt(postStr, 10);
  } else if (dev !== undefined) {
    phase = 'dev';
    phaseNumber = dev;
  } else {
    phase = 'release';
    phaseNumber = 0;
  }

  return {
    epoch: epochStr === undefined ? 0 : Number.parseInt(epochStr, 10),
    release: releaseStr.split('.').map((n) => Number.parseInt(n, 10)),
    phase,
    phaseNumber,
    dev,
    local,
  };
}

/** Numeric, not lexical, and the shorter side pads with zeroes: `1.0` == `1.0.0`. */
function compareReleaseSegments(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Local segments compare as plain strings, not PEP 440's alphanumeric/numeric
 * segment-wise rules. The only claim this codebase relies on is "having a local
 * segment outranks not having one" (tested below); nothing here compares two
 * different local versions of the same release against each other, so the fuller
 * rule would be unmeasured complexity.
 */
function compareLocal(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return a < b ? -1 : 1;
}

function compare(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) {
    // Neither side has more claim to "lowest" than the other when both fail to
    // parse; only one side failing breaks the tie. See the module doc for why
    // failing to parse sorts low instead of throwing.
    if (pa === null && pb === null) return 0;
    return pa === null ? -1 : 1;
  }

  if (pa.epoch !== pb.epoch) return pa.epoch - pb.epoch;

  const releaseDiff = compareReleaseSegments(pa.release, pb.release);
  if (releaseDiff !== 0) return releaseDiff;

  if (pa.phase !== pb.phase) return PHASE[pa.phase] - PHASE[pb.phase];
  if (pa.phaseNumber !== pb.phaseNumber) return pa.phaseNumber - pb.phaseNumber;

  // Same phase and number: whichever side has a `.devN` is a preview of the
  // other and sorts lower. No `.devN` beats any `.devN` (`Infinity` beats every
  // finite dev number), and the `!==` guard keeps `Infinity - Infinity` — which
  // is `NaN`, and would compare as neither less, equal, nor greater — from ever
  // being evaluated.
  const aDev = pa.dev ?? Number.POSITIVE_INFINITY;
  const bDev = pb.dev ?? Number.POSITIVE_INFINITY;
  if (aDev !== bDev) return aDev - bDev;

  return compareLocal(pa.local, pb.local);
}

function isPrereleaseVersion(version: string): boolean {
  const parsed = parse(version);
  // Unparseable counts as a prerelease, not a plain release. The module doc
  // promises an unparseable version is never proposed as an upgrade target, and
  // sorting lowest only keeps that promise when something else is in the
  // running — if a garbage string were the only version on record, calling it a
  // normal release would make it the fallback target by default.
  if (parsed === null) return true;
  // `dev` alone makes a version a preview, even under a `post` phase — a
  // `1.0.post1.dev1` files under the `post` bucket in `compare` (see `Parsed`'s
  // `dev` field doc) but is still a preview of `1.0.post1`, not a finished
  // release, so this checks `dev` directly rather than reusing the `phase`
  // bucket threshold.
  if (parsed.dev !== undefined) return true;
  return parsed.phase === 'a' || parsed.phase === 'b' || parsed.phase === 'rc';
}

/**
 * PEP 440 as `versions.ts`'s registry consumes it. `handles` claims only `PyPI`,
 * so registering this ahead of the semver floor cannot change any other
 * ecosystem's ordering.
 */
export function pep440Scheme(): VersionScheme {
  return {
    id: 'pep440',
    handles: (ecosystem) => ecosystem === 'PyPI',
    compare,
    isPrerelease: isPrereleaseVersion,
  };
}
