# Emend

**Dependabot tells you a version changed. Emend tells you which of your lines break, fixes them, and proves the fix compiles and passes your tests.**

Emend diffs the published TypeScript declarations of the dependency version you
have installed against the one you'd upgrade to, intersects the changed symbols
with the call sites in your code, applies a migration, and verifies it against a
real baseline before proposing anything.

```
$ emend scan ./my-service --only zod

  zod 3.22.4 → 4.4.3
    breaking   record (signature-changed, high confidence, id 42c38dcf56ce)
      → src/schema.ts:28:15  metadata: z.record(z.string()),
    breaking   ZodError.errors (removed, high confidence, id 55028a971871)
      → src/schema.ts:41:23  return result.error.errors.map(...)
    deprecated ZodString.email (deprecated, high confidence, id 12c97d6d915a)
      → src/schema.ts:12:21  email: z.string().email(),
    + 1210 other breaking change(s) in this upgrade do not appear anywhere in your code

  Summary  2 breaking · 3 deprecated · 5 call site(s)
```

That last line is the product. zod 4 ships ~1,215 breaking changes; five touch
this repository. Everything downstream operates on those five.

---

## Quick start

Requires **Node 22.6+** (uses native TypeScript type stripping — there is no build step).

```bash
npm install

# Scaffold a demo repo with genuine dependency drift
node bin/emend.mjs demo /tmp/emend-demo

# Find what actually breaks
node bin/emend.mjs scan /tmp/emend-demo --only zod

# Migrate and verify in an isolated workspace
node bin/emend.mjs fix /tmp/emend-demo

# Browse everything in a browser
node bin/emend.mjs serve
```

`npm link` puts `emend` on your PATH if you prefer that to `node bin/emend.mjs`.

---

## How it works

```
  package.json + node_modules              npm registry
            │                                    │
            ▼                                    ▼
      installed version  ────────────►  .d.ts of BOTH versions
                                                 │
                                                 ▼
                                       public API surface diff
                                    (removed / signature / deprecated)
                                                 │
   TypeScript program over your repo             │
   (imports + type-checker resolution)           │
            │                                    │
            └──────────────► INTERSECTION ◄──────┘
                                  │
                                  ▼
                              FINDINGS  (symbol, file:line, severity)
                                  │
             ┌────────────────────┼────────────────────┐
             ▼                    ▼                    ▼
     deterministic plan     LLM agent (opt-in)     dashboard / PR
             └──────────► isolated git worktree ◄──────┘
                                  │
                    baseline → apply → verify → compare
                                  │
                                  ▼
                    verified · regression · unverified
```

### Why `.d.ts` diffing

Other approaches read version numbers (no idea what changed), OpenAPI specs (most
SDK surface isn't in them), or changelogs (prose, and frequently silent about
breaks). Type declarations are **machine-readable, versioned, exhaustive, and
already published** by nearly every TypeScript SDK — no provider cooperation
required.

### Why the intersection matters

A diff alone is noise. Crossing it with real call sites turns "1,215 breaking
changes" into a five-item work order with file and line numbers.

### Why verification is not optional

Every migration runs in a throwaway `git worktree`:

1. **baseline** — typecheck + tests *before* any edit
2. apply edits, bump the dependency
3. **post** — typecheck + tests again

Without the baseline, a repository that was already failing would have its
pre-existing failures blamed on the migration. Emend distinguishes
`verified` / `regression` / `pre-existing-failure` / `typecheck-only` /
`unverified`, and never reports the last three as success.

---

## Commands

| Command | What it does |
| --- | --- |
| `emend demo [dir]` | Scaffold a demo repo with real drift |
| `emend scan <repo>` | Find API changes that intersect your code |
| `emend fix <repo>` | Plan, apply, and verify migrations |
| `emend pr <repo> --finding <id>` | Render the pull request (dry run by default) |
| `emend serve` | Local dashboard |
| `emend models` | List models your LLM provider serves |

Useful flags: `--only pkg,pkg`, `--all`, `--json`, `--no-dev` (scan);
`--finding <id>`, `--agent`, `--keep` (fix); `--create` (pr).

---

## Running it as a service

`emend serve` becomes a hosted monitor when GitHub App credentials are present,
and stays a local dashboard when they are not.

```bash
export EMEND_GITHUB_APP_ID=...
export EMEND_GITHUB_PRIVATE_KEY="$(cat emend.private-key.pem)"   # or base64
export EMEND_GITHUB_WEBHOOK_SECRET=...

emend serve --port 8080     # POST /webhook is now live
```

Register the App with these repository permissions:

| Permission | Level | Why |
| --- | --- | --- |
| Contents | **Read and write** | Read the source tarball; create the branch and commit |
| Pull requests | **Read and write** | Open and update the draft PR |
| Checks | Read-only | Receive `check_suite` so CI results come back |
| Metadata | Read-only | Mandatory for every App |

Subscribe to `installation`, `installation repositories`, `push`, and
`check suite`.

Contents must be **write**, not read. Commits are built through the Git Data
API — blobs, a tree, a commit, a ref — and every one of those writes.

Installing it on a repository queues a scan. Pushes to the default branch queue
another. Each scan reconstructs `node_modules` from the lockfile, finds the
drift, migrates what it can, and opens a **draft** pull request per package.

### Why it can run untrusted repositories in-process

Analysis never executes anything from the repository or its dependency tree:

- Dependencies are **symlinked from a tarball cache**, not installed.
- The dependency bump passes `--ignore-scripts`, so no lifecycle hook runs.
- The repository's **test script is never invoked**.

That is what makes a per-job container unnecessary. It is a property, not a
convention — anything added to this path that executes repository code brings
the isolation requirement back with it.

The cost is that hosted verification is **typecheck-only**. Emend says so on the
pull request rather than implying more, and reads the real verdict back from the
`check_suite` webhook when your CI runs the tests on the branch. Your CI is the
better verifier anyway: it runs them in the environment they were written for.

---

## The optional LLM agent

The deterministic core handles detection, localisation, rename-class migrations,
and verification with **no model involved**. The agent only runs where the
deterministic planner declines — and only if you ask.

It works with **any OpenAI-compatible endpoint**:

```bash
export EMEND_LLM_PROVIDER=nebius     # or fireworks, together, groq,
                                     # deepinfra, openrouter, ollama, vllm
export NEBIUS_API_KEY=...
emend models                         # see what your provider serves today
export EMEND_LLM_MODEL=<id from above>

emend fix ./my-service --agent
```

Or point it anywhere directly:

```bash
export EMEND_LLM_BASE_URL=http://localhost:11434/v1   # local Ollama
export EMEND_LLM_MODEL=qwen3-coder:30b
```

### How the agent is constrained

The model never touches your filesystem or a shell. It is given the API contract
diff, the located call sites, the source, and the list of symbols that actually
exist in the new version — then returns `find`/`replace` pairs as JSON. Emend
locates them and **rejects anything missing or ambiguous**, so a hallucinated
edit fails closed rather than corrupting source. If verification fails, the
compiler's own errors are fed back and it retries, bounded.

This design follows the literature rather than the intuition: Byam
(arXiv 2505.07522) found end-to-end LLM migration fully repaired only **27%** of
builds, improving markedly when given API diffs, failing lines, and compiler
feedback; BigBag (arXiv 2606.24446) found one reusable validated transformation
beats improvising per repository.

A full sandboxed harness (OpenHands and similar) is the right tool for
open-ended, repo-wide restructuring — see
[`docs/research/llm-harness.md`](docs/research/llm-harness.md) for the provider
and harness analysis, including why Emend doesn't start there.

---

## Honesty rules

These are enforced in code, not convention:

- A package with no type declarations is **`unanalyzable`**, never "clean".
- A truncated surface walk **suppresses removal reporting** — absence past a
  cutoff is not deletion.
- Verification that didn't run is **`unverified`**, never "passing".
- No test script means **`typecheck-only`**, never "tests pass".
- Breaking changes detected but not located in your code are **counted and
  reported**, not silently dropped — static analysis cannot see `client[name]()`.
- Skipped packages are counted separately from analyzed ones. Skipped ≠ clean.

---

## Design decisions worth knowing

**A version bump is atomic.** All findings for one package are fixed together in
one workspace and land as one PR. Fixing them separately would make each look
like a regression (alone, each *is* insufficient) and produce conflicting PRs.

**Signature-change filtering is version-aware.** Within a major version a changed
signature is unusual and probably deliberate, so it's reported. Across a major
version, an internal rewrite changes nearly every signature string without
changing any contract — so Emend demands the one signal it can trust, a newly
*required* parameter. Without this filter the zod 3→4 scan reported 2,100+
"breaking" changes, essentially all noise.

**The planner refuses to guess.** If two replacement symbols match equally well,
or the only candidate is itself deprecated, it produces no plan rather than a
coin flip.

**PRs are drafts, and `emend pr` is a dry run by default.** Opening a PR requires
`--create`, and Emend refuses to open one for a change that didn't verify.

---

## Project layout

```
src/
  registry.ts    npm metadata, tarball download + cache
  lockfile.ts    package-lock.json -> resolved versions + install tree
  vendor.ts      reconstruct node_modules from the lockfile, no install
  surface.ts     .d.ts → public API surface (breadth-first, canonical paths)
  diff.ts        surface × surface → classified changes
  inventory.ts   repo → installed dependency versions
  callsites.ts   repo → where package symbols are used (import + type resolution)
  analyze.ts     the scan pipeline
  plan.ts        deterministic rename planning
  apply.ts       isolated workspace, edit application, rollback
  verify.ts      baseline/post command running and comparison
  fix.ts         the fix pipeline (per-package)
  pr.ts          evidence-rich PR rendering + gh integration
  store.ts       node:sqlite persistence
  server.ts      dashboard + webhook endpoint
  cli.ts         command surface
  github/        App auth, webhook intake, job runner, API pull requests
  llm/           optional agent: providers, client, repair loop
docs/
  specs/emend-mvp.md          design spec
  research/llm-harness.md     provider + harness research
fixtures/demo-repo/           demo template with real drift
```

Run `npm run typecheck` and `npm test` to verify.

---

## Status

MVP / proof of concept. TypeScript + npm + GitHub only. Scanning, migration and
pull requests are exercised against a real private repository; the GitHub App
token exchange is the one link only a registered App can validate. See
[`docs/specs/emend-mvp.md`](docs/specs/emend-mvp.md) §10 for what is deliberately
out of scope, and its Appendix A for the product decisions still open.
