/**
 * Core domain types for Emend.
 *
 * These are deliberately plain data — every module in the pipeline consumes and
 * produces values of these shapes, which is what lets each stage be tested in
 * isolation without standing up the stage before it.
 */

import type { PinConflict, VersionPin } from './pins.ts';

export type { PinConflict, VersionPin } from './pins.ts';

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

/**
 * One of a declaration's type parameters, and whether a caller may omit it.
 *
 * Recorded because the signature cannot say. `checker.typeToString()` prints
 * type parameters by name and never by declaration, so `Config<D>` becoming
 * `Config<D, P>` gives no clue whether `P` has a default — and that is the
 * whole difference between a widening every existing use survives and a break.
 * The answer exists only where the declaration does, so it is taken there.
 */
export interface TypeParam {
  name: string;
  /** True when the declaration gives it a default, so it may be left out. */
  defaulted: boolean;
}

export interface ApiSymbol {
  /** Dotted path from the module root, e.g. "Stripe.charges.create". */
  path: string;
  kind: SymbolKind;
  /** Normalised type text. Compared as a string by the differ. */
  signature: string;
  /** True when the declaration carries an `@deprecated` JSDoc tag. */
  deprecated: boolean;
  /**
   * The declaration's own prose, captured only for deprecated symbols.
   *
   * A deprecation frequently says what to use instead, and often that
   * replacement is not another symbol at all — recharts 3 deprecates `Cell` in
   * favour of a `shape` prop, which no symbol table can express. Reading the
   * `@deprecated` tag as a boolean and discarding the sentence beside it throws
   * away the half of the declaration that says what to do.
   */
  doc?: string;
  optional: boolean;
  /** Present only where the declaration takes type parameters. */
  typeParams?: TypeParam[];
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
   * Non-generic type aliases, mapped to what the checker says they are.
   *
   * Recorded because the printer's choice of alias-or-expansion is not stable
   * across versions: a plain `type QueryKey = ReadonlyArray<unknown>` prints as
   * `QueryKey`, and the same alias rewritten as a conditional prints as
   * `readonly unknown[]`, so the same type renders two ways. The differ
   * substitutes an alias only where both versions agree what it means.
   */
  typeAliases?: Record<string, string>;
  /**
   * Type name -> the declared default for each of its type parameters, `''`
   * where a parameter has none.
   *
   * Recorded because `typeToString` spells a default out in some renderings and
   * elides it in others, so `QueryFilters` and `QueryFilters<readonly
   * unknown[]>` are one type printed two ways. The differ drops a trailing
   * argument that restates its default, at positions both versions declare
   * the same.
   */
  typeDefaults?: Record<string, string[]>;
  /**
   * Resolved `.d.ts` entry point, or null when the package ships no types.
   * Null is meaningful: it means "unanalyzable", never "clean". See the
   * honesty rules in the README.
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

export type ChangeKind =
  | 'removed'
  | 'signature-changed'
  | 'deprecated'
  | 'added'
  /** A version written down in one file disagreeing with its source of truth. */
  | 'version-drift'
  /** An external tool's objection to a line, in a file with no type checker. */
  | 'lint';
export type Severity =
  | 'breaking'
  | 'deprecation'
  | 'feature'
  | 'safe'
  /**
   * A pin that has drifted from what the repository installs or declares.
   *
   * Its own severity rather than `breaking`, because the headline count is what
   * makes a scan worth reading. A stale Dockerfile tag is real and is not a
   * change in anybody's public API; counting it as breaking would overstate both
   * and blunt the one number that carries the product.
   */
  | 'drift'
  /**
   * A known vulnerability in an installed package.
   *
   * Its own class for the same reason `drift` is. `axios@0.21.0` alone carries
   * twenty-five advisories, measured, and folding those into `breaking` would
   * put a number in front of a reader that means something entirely different
   * — and would bury every API change in the scan underneath one package.
   */
  | 'vulnerability'
  /**
   * Something an external linter objects to in a Dockerfile or a shell script.
   *
   * Its own class for the same reason the others have one. A shellcheck warning
   * is real and is not a change in anybody's public API, and a repository with
   * three scripts can produce dozens — folding them into `breaking` would put a
   * number in front of a reader that means something else entirely.
   */
  | 'lint'
  /**
   * A dependency that is simply behind, with nothing in this repository that
   * the upgrade would break.
   *
   * Excluded from the headline count by design: these are unbounded —
   * every repository has some, and producing them requires no analysis at all.
   * Pouring them in beside proven findings inverts the signal-to-noise ratio
   * that makes a scan worth reading, which the alert-fatigue literature names as
   * the main cause of people disengaging from exactly this kind of tool.
   */
  | 'freshness';
export type Confidence = 'high' | 'medium';

export interface SurfaceChange {
  path: string;
  kind: ChangeKind;
  /**
   * What sort of declaration this is, when the differ knew.
   *
   * Distinct from `kind`, which is what *happened* to it. Recorded because an
   * addition's usefulness depends on it: a new function is a capability, a new
   * type is a helper for someone else's generics. Optional, so an absent value
   * means "not recorded" rather than "not a value" — see `features.ts`.
   */
  symbolKind?: SymbolKind;
  severity: Severity;
  confidence: Confidence;
  before: string | null;
  after: string | null;
  /**
   * What the new declaration says to do instead. Deprecations only.
   *
   * Carried no further than that on purpose: every symbol has documentation and
   * almost none of it is a migration instruction, so attaching it to unrelated
   * changes would spend the prompt's budget on prose the model must ignore.
   */
  guidance?: string;
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
  /** How the symbol was resolved: through an import binding, or through the
   * type checker on a receiver's type. `callsites.ts` explains the split. */
  via: 'import' | 'type';
}

export interface Finding {
  /**
   * Stable fingerprint of (package, version pair, symbol path, change kind) —
   * `findingId` in analyze.ts. Excludes file/line by design: the same drift
   * must keep its identity when code moves, or every rebase would reopen what
   * the last scan dismissed.
   */
  id: string;
  /**
   * Which detector produced this, and the discriminator for everything
   * downstream.
   *
   * An earlier design proposed a `Subject` union instead. With the code in front
   * of you all four of its variants are `{name, from, to}` plus a tag, which is
   * what the three fields below already carry — so the union would rename
   * fields across two dozen sites to express what this one field expresses.
   */
  detector: string;
  /**
   * What the finding is about: an npm package, a tool pinned in a Dockerfile, a
   * vendor whose wire API is pinned in source.
   */
  pkg: string;
  fromVersion: string;
  toVersion: string;
  change: SurfaceChange;
  sites: CallSite[];
  confidence: Confidence;
}

/**
 * A source of drift.
 *
 * The contract is deliberately narrow: given a repository, produce findings.
 * What a detector reads, and whether it needs the network, is its own business —
 * which is what lets the surface diff, the version pins and anything added later
 * share one pipeline instead of each growing a private path to the surface.
 */
export interface Detector {
  id: string;
  /** Cheap precondition. Answering it must not cost what detecting costs. */
  applies(ctx: unknown): Promise<boolean>;
  /**
   * Findings, and anything the detector looked at but could not conclude about.
   *
   * The notes matter as much as the findings. A contract check that located a
   * vendor's description and found it not authoritative has *not* established
   * that the integration is fine, and returning only an empty finding list
   * renders as exactly that. "I could not check" and "I checked and it is fine"
   * are different answers and only one is safe to show as a clean scan.
   */
  detect(ctx: unknown): Promise<{ findings: Finding[]; notes?: string[] }>;
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
  /**
   * Where `installed` came from. `range` means it was inferred from the declared
   * semver range and may name a version that was never published — callers must
   * not present it as a fact read from the repository.
   */
  source: 'node_modules' | 'lockfile' | 'range' | 'none';
  /**
   * Workspace directories whose manifest declares this dependency, relative to
   * the repository root. `''` is the root manifest itself.
   *
   * A monorepo declares almost nothing at the root, so a migration has to edit
   * the manifest that actually names the package — bumping at the root would
   * add a dependency the repository never had.
   */
  declaredIn: string[];
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
  /**
   * Versions the repository writes down that disagree with what it installs, or
   * with each other.
   *
   * Kept beside `packages` rather than folded into their findings: a Dockerfile
   * tag that has drifted from the lockfile is not a change in anybody's public
   * API, and counting it among the breaking changes would overstate both.
   */
  pinConflicts: PinConflict[];
  /**
   * Wire-protocol versions the repository pins in source.
   *
   * Reported, never repaired. A vendor versions its HTTP API separately from the
   * SDK, so no declaration diff can see this drift — and knowing whether the pin
   * is stale needs a vendor registry Emend does not have. Naming the pin is
   * honest; inventing a target would not be.
   */
  apiVersionPins: VersionPin[];
  counts: {
    packagesAnalyzed: number;
    packagesSkipped: number;
    breaking: number;
    deprecation: number;
    callSites: number;
    /** Reported separately. A drifted pin is not an API break. */
    pinConflicts: number;
    /** Reported separately too. A CVE is not a change in anybody's public API. */
    vulnerabilities: number;
    /** An external tool's objection is not an API break either. */
    lint: number;
    /**
     * Packages simply behind, where nothing this repository calls changed.
     *
     * Never in the headline: unbounded, requiring no analysis to
     * produce, and counting them beside proven findings is what makes a scan
     * stop being read.
     */
    freshness: number;
    /**
     * Packages that gained a new top-level export.
     *
     * Never in the headline, and for a stronger reason than freshness: this
     * class asserts nothing about the repository at all.
     */
    features: number;
  };
}
