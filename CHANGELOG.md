# Changelog

All notable changes to Emend are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] — 2026-08-14

### Fixed

- `emend --version` (and `-v`, and `version`) printed the usage and exited 1, so
  an install check like `emend --version >/dev/null` reported a working install
  as broken. The version is read from the manifest rather than held as a
  constant, so `npm version` cannot leave it stale.

### Changed

- README restructured around the scan output, with a `npx` quick start that needs
  no API key. Reference depth moved to `docs/limitations.md` and
  `docs/evaluating-the-agent.md` rather than removed.
- Design decisions (atomic version bumps, version-aware signature filtering, the
  planner's refusal to guess, draft-by-default PRs) moved into
  `docs/architecture.md` §9.

### Added

- `docs/limitations.md` — every measured case where Emend can be wrong or silent.
- `docs/evaluating-the-agent.md` — the scored corpus and what its columns mean.
- Issue templates, and a social preview image.

## [0.1.0] — 2026-08-13

First published release. MVP / proof of concept: TypeScript + npm + GitHub only.

### Added

- **`emend scan`** — diffs the published `.d.ts` surface of the installed
  dependency version against the target version, and intersects the changed
  symbols with real call sites resolved through the TypeScript type checker.
  Fully deterministic; no model involved.
- **`emend fix`** — plans and applies migrations in a throwaway `git worktree`,
  with baseline verification before any edit so pre-existing failures are never
  blamed on the migration. Reports `verified` / `regression` /
  `pre-existing-failure` / `typecheck-only` / `unverified`, and never treats the
  last three as success.
- **Read-only behaviour review** — a second model pass that asks whether a
  verified change still means the same thing. Its own edits are re-verified and
  reverted wholesale if they do not hold.
- **`--contracts`** — resolves each vendor's own published OpenAPI description
  and reports outbound HTTP calls reaching routes it no longer contains, guarded
  by provenance, currency and coverage checks.
- **`--vulns`** — screens the installed tree against OSV and proposes the single
  bump that clears the most advisories per package.
- **`emend pins`** — repairs version pins duplicated into Dockerfiles, CI
  matrices and `.nvmrc`. Refuses to arbitrate where no authority exists. No model
  involved.
- **`emend pr`** — evidence-rich pull request rendering. Dry run by default;
  refuses to open a PR for a change that did not verify.
- **`emend mcp`** — serves seven tools over MCP stdio so a coding agent can drive
  Emend. Every tool returns what was measured, never a judgement.
- **`emend serve`** — local dashboard, or a hosted GitHub App monitor when App
  credentials are present.
- **`emend eval`** — scores the agent against a corpus of real migrations,
  reporting `Pass` and `Clean` as deliberately separate columns.
- **`emend demo`** — scaffolds a repository with genuine dependency drift.
- Honesty rules enforced in code: `unanalyzable` ≠ clean, `unverified` ≠ passing,
  no test script means `typecheck-only`, skipped ≠ clean, and a run that cannot
  reach a model repairs nothing and says so.

[Unreleased]: https://github.com/diyanbogdanov/emend/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/diyanbogdanov/emend/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/diyanbogdanov/emend/releases/tag/v0.1.0
