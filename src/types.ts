/**
 * Core domain types for Emend.
 *
 * These are deliberately plain data — every module in the pipeline consumes and
 * produces values of these shapes, which is what lets each stage be tested in
 * isolation without standing up the stage before it.
 */

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'property'
  | 'type'
  | 'enum'
  | 'variable'
  | 'unknown';

export interface ApiSymbol {
  /** Dotted path from the module root, e.g. "Stripe.charges.create". */
  path: string;
  kind: SymbolKind;
  /** Normalised type text. Compared as a string by the differ. */
  signature: string;
  /** True when the declaration carries an `@deprecated` JSDoc tag. */
  deprecated: boolean;
  optional: boolean;
}

export interface ApiSurface {
  pkg: string;
  version: string;
  symbols: Record<string, ApiSymbol>;
  /**
   * Secondary index: `"OwnerTypeName.member"` -> canonical symbol path.
   *
   * Exists because call sites are written against *values*, not export paths.
   * Given `const c = new Stripe(k); c.charges.create()`, the checker reports the
   * type of `c.charges` as `ChargesResource`, so the only thing we can look up is
   * `ChargesResource.create` — while the surface calls it `Stripe.charges.create`.
   * This index bridges the two.
   */
  byTypeMember: Record<string, string>;
  /**
   * Alternate path -> canonical path, for symbols reachable by more than one
   * route. `zod` exports `record` at the top level *and* as `z.record`; only one
   * becomes canonical, but source code may reference either, so call-site
   * matching needs to resolve the one it sees.
   */
  aliases: Record<string, string>;
  /**
   * Resolved `.d.ts` entry point, or null when the package ships no types.
   * Null is meaningful: it means "unanalyzable", never "clean". See honesty
   * rules in the spec (§9).
   */
  entry: string | null;
  /**
   * True when the walk hit its symbol budget. A truncated surface must never be
   * used to claim a symbol was removed — absence may just be the cutoff.
   */
  truncated?: boolean;
  /** Populated when extraction hit a problem worth surfacing to the user. */
  note?: string;
}

export type ChangeKind = 'removed' | 'signature-changed' | 'deprecated' | 'added';
export type Severity = 'breaking' | 'deprecation' | 'feature' | 'safe';
export type Confidence = 'high' | 'medium';

export interface SurfaceChange {
  path: string;
  kind: ChangeKind;
  severity: Severity;
  confidence: Confidence;
  before: string | null;
  after: string | null;
}

export interface SurfaceDiff {
  pkg: string;
  fromVersion: string;
  toVersion: string;
  changes: SurfaceChange[];
  /** True when either side had no type declarations — results are not trustworthy. */
  unanalyzable: boolean;
  note?: string;
}

export interface CallSite {
  /** Repo-relative POSIX path. */
  file: string;
  /** 1-indexed. */
  line: number;
  /** 1-indexed. */
  column: number;
  /** The source line, trimmed — shown as evidence in reports and PRs. */
  text: string;
  /** How the symbol was resolved. See spec §6. */
  via: 'import' | 'type';
}

export interface Finding {
  /** Stable fingerprint; see spec §4.1. Excludes file/line by design. */
  id: string;
  pkg: string;
  fromVersion: string;
  toVersion: string;
  change: SurfaceChange;
  sites: CallSite[];
  confidence: Confidence;
}

/** A single concrete text edit the planner is confident about. */
export interface PlannedEdit {
  file: string;
  line: number;
  column: number;
  /** Exact text expected at that position — apply refuses if it does not match. */
  find: string;
  replace: string;
  reason: string;
}

export interface MigrationPlan {
  findingId: string;
  pkg: string;
  fromVersion: string;
  toVersion: string;
  kind: 'rename';
  edits: PlannedEdit[];
  /** Human-readable description of what this plan does and why. */
  rationale: string;
}

export type VerifyOutcome =
  | 'verified'
  | 'regression'
  | 'pre-existing-failure'
  | 'typecheck-only'
  | 'unverified';

export interface CommandResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  skipped?: boolean;
  skipReason?: string;
}

export interface VerificationReport {
  outcome: VerifyOutcome;
  baseline: { typecheck: CommandResult; test: CommandResult };
  post: { typecheck: CommandResult; test: CommandResult };
  summary: string;
}

/** One dependency as declared and installed in the target repo. */
export interface InstalledDependency {
  name: string;
  /** The version actually resolved on disk (from node_modules), when available. */
  installed: string | null;
  /** The range declared in package.json, e.g. "^3.22.0". */
  declared: string;
  dev: boolean;
}

export type PackageStatus = 'analyzed' | 'unanalyzable' | 'up-to-date' | 'error';

export interface PackageReport {
  pkg: string;
  status: PackageStatus;
  fromVersion: string | null;
  toVersion: string | null;
  findings: Finding[];
  /**
   * Breaking/deprecation changes detected in the diff for which no call site
   * could be located. Not findings (no evidence), but never hidden either —
   * static analysis cannot see dynamic access like `client[method]()`.
   */
  unlocatedBreaking: number;
  /** Always populated for non-`analyzed` statuses. Honesty rule: never silent. */
  note?: string;
}

export interface ScanReport {
  repo: string;
  startedAt: string;
  finishedAt: string;
  packages: PackageReport[];
  /** Non-fatal problems that limited analysis. Surfaced in every summary. */
  warnings: string[];
  counts: {
    packagesAnalyzed: number;
    packagesSkipped: number;
    breaking: number;
    deprecation: number;
    callSites: number;
  };
}
