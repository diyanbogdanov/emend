# Changelog

All notable changes to Emend are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-10-07

0.1.1 was tagged but never published to npm, so its fixes — `emend --version`
answering rather than printing the usage, and the corrected `bin` path — reach
npm with this release.

### Added

- **Python support in `emend scan`.** A repository with `uv.lock`,
  `poetry.lock`, `pdm.lock`, `Pipfile.lock` or `requirements.txt` is scanned
  the way an npm one is: dependencies are screened against OSV, each package's
  public API is diffed between versions, and the changes are located in the
  repository's own code. Versions are ordered by PEP 440, not semver.
  - Lockfiles give exact versions. `requirements.txt` gives its `==` pins and
    its ranges, including hashed `pip-compile` output, and its `-r` and `-c`
    includes are followed — inside the repository only.
  - A package's API is read statically from its published wheel; nothing in it
    runs. A package that publishes only an sdist is skipped rather than built,
    as is a wheel PyPI lists at over 256 MiB.
  - Call sites are found through imports, under the module names a wheel
    installs — PyYAML is `import yaml`. A method call is reported as a lead,
    since nothing resolves the type of what it is called on.
  - A vulnerable package is reported as imported where the repository imports
    it, and as "could not be checked" — never "not imported" — when its import
    names could not be read.
  - Verification runs mypy or pyright, then pytest. A repository with neither
    type checker configured is `unverified`: passing tests alone are not taken
    as proof.
  - `emend fix` migrates npm packages only, and refuses a Python finding rather
    than running `npm install` for it.

### Changed

- Relicensed from AGPL-3.0-only to MIT. The contributor licence agreement and the
  commercial-licence offer are removed with it: both existed only to support dual
  licensing, and MIT already permits everything the commercial licence sold.
- `emend scan` ends its summary with a coverage line per ecosystem, saying what
  this scan actually examined — `npm: examined 4 package(s) — …` — or
  `npm: no dependencies were analysed.` when it examined nothing.
- When no verification runner recognises a repository, its skipped phases are
  labelled `typecheck` and `test`, with the reason, where they were labelled
  `npm test`. That label is what a pull request's verification table prints.
  The outcome is unchanged: `unverified`.

### Removed

- Go vulnerability scanning and symbol-level reachability. Go was Emend's second
  OSV ecosystem; it is removed ahead of Python and Rust support, which are built
  on a language seam rather than on branches in the detector.

### Fixed

- A vulnerable package that nothing imports cited `package-lock.json` as its
  site even in a pnpm, yarn or bun repository that has none — line 1 of a file
  that does not exist. It now cites the lockfile that was actually read.
- A migration whose tests passed while its typecheck was skipped was summarised
  as "typecheck and tests are green". It now says the tests pass and types were
  not checked.
- A finding in a pnpm, yarn or bun repository cited line 1 of its lockfile,
  with text that appears nowhere in it. It now cites the line the lockfile
  names the package on.
- An unreadable lockfile — a merge-conflict marker in `package-lock.json`, or a
  `bun.lockb` alone — made a repository look as though it had no lockfile, so
  `--vulns` screened nothing and said nothing. It now says the lockfile could
  not be read.

## [0.1.1] — 2026-08-14

### Fixed

- `emend --version` (and `-v`, and `version`) printed the usage and exited 1, so
  an install check like `emend --version >/dev/null` reported a working install
  as broken. The version is read from the manifest rather than held as a
  constant, so `npm version` cannot leave it stale.
- The `bin` path dropped its `./` prefix. npm rejects the prefixed form and was
  silently correcting it on every publish, so the published manifest was one npm
  had rewritten rather than the one in the repository.

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

[Unreleased]: https://github.com/diyanbogdanov/emend/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/diyanbogdanov/emend/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/diyanbogdanov/emend/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/diyanbogdanov/emend/releases/tag/v0.1.0
