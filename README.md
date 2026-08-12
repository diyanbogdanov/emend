# Emend

**Dependabot tells you a version changed. Emend tells you which of your lines break, fixes them, and proves the fix compiles and passes your tests.**

Emend diffs the published TypeScript declarations of the dependency version you
have installed against the one you'd upgrade to, intersects the changed symbols
with the call sites in your code, applies a migration, and verifies it against a
real baseline before proposing anything.

```
$ emend scan ./my-service --only zod

  zod 3.22.4 → 4.4.3
    breaking record (signature-changed, high confidence, id 42c38dcf56ce)
      → src/schema.ts:28:15  metadata: z.record(z.string()),
    breaking ZodError.errors (removed, high confidence, id 55028a971871)
      → src/schema.ts:41:23  return result.error.errors.map((issue) => ...)
    deprecated ZodString.email (deprecated, high confidence, id 12c97d6d915a)
      Use `z.email()` instead.
      → src/schema.ts:12:21  email: z.string().email(),
    + 1212 other breaking change(s) in this upgrade do not appear anywhere in your code

  Summary  4 breaking · 3 deprecated · 7 call site(s)
           1 package(s) analyzed, 0 skipped (skipped ≠ clean)
```

That last line is the product. zod 4 ships roughly 1,219 breaking changes; seven
call sites in this repository touch any of them. Everything downstream operates
on those seven — and on the second line, which says how much of the repository
went unexamined, because a summary that cannot be wrong about its own coverage
is the only kind worth reading.

*(That is the real output of `emend demo /tmp/d && emend scan /tmp/d --only zod`,
not an illustration.)*

The same question, asked of the HTTP calls no package describes, is
[`--contracts`](#calls-to-apis-you-dont-have-a-package-for). How it all fits
together is in [docs/architecture.md](docs/architecture.md).

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

**[docs/getting-started.md](docs/getting-started.md)** walks the whole thing:
configuring a model, scanning a real repository, checking your HTTP calls, and
what to do when something looks wrong.

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
     deterministic plan     LLM agent (default)    dashboard / PR
             └──────────► isolated git worktree ◄──────┘
                                  │
                    baseline → apply → verify → compare
                                  │
                                  ▼
                    behaviour review (read-only model)
                                  │
                                  ▼
             verified · regression · unverified · unreviewed
```

That is the typed-package path. A second one runs beside it for HTTP calls,
which no `.d.ts` describes — see [Calls to APIs you don't have a package
for](#calls-to-apis-you-dont-have-a-package-for).

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

## Calls to APIs you don't have a package for

Half the contracts a service depends on are not packages at all:

```ts
const res = await fetch(`https://api.vendor.com/v1/audiences/${id}/contacts`);
```

There is no `.d.ts` here, no lockfile entry, and no type — a URL is a string
that compiles whatever it says. When the vendor retires that route, nothing in
your toolchain notices until production does.

`emend scan <repo> --contracts` reads outbound HTTP calls out of your source,
resolves each vendor's **own** published OpenAPI description, and reports calls
that reach a route the description no longer contains.

```
  api.github.com
    drift      GET /repos/{owner}/{repo}/git/refs/{ref}
      → packages/pieces/github/src/lib/common/index.ts:88
      not described by github/rest-api-description (fetched today)

  3 host(s) resolved · 1,173 calls read · 412 unreadable (URL built at runtime)
```

Three guards keep that from becoming a rumour mill, and they are the reason this
is worth trusting rather than a grep for stale URLs:

- **Provenance.** A description found under some random GitHub account is not
  the vendor speaking. Emend walks the provider's own origin, their `apis.json`,
  and their GitHub organisation, and refuses anything it cannot trace back to
  them.
- **Currency.** First-party is not the same as current. `slackapi/slack-api-specs`
  is unimpeachably Slack's and last changed in 2020. A stored copy that has not
  moved in a year asserts nothing; one served live from the vendor's domain
  needs no date, because being served *is* the evidence.
- **Coverage.** One host commonly serves several APIs. Xero's accounting
  description says nothing about `/projects.xro`. Where the description names
  nothing under the same top-level path, the path is reported **unchecked**
  rather than broken.

A finding here is a **lead to verify, not a proof** — providers do serve
endpoints they never wrote down, and the finding says *not described by* rather
than *removed* for exactly that reason. See [Known
limitations](#known-limitations).

`--since` compares a description against itself as it stood a year ago, which is
the only way to see a **deprecation** or a **newly available capability** —
both are still in today's copy, so reading it alone can never surface either.

A newly offered parameter is reported and never written into your code, because
adopting a filter changes which records come back and that is a decision rather
than a repair. One kind is treated differently: a **pagination control** showing
up on an endpoint you call without paging is not a capability, it is the vendor
disclosing that you have been taking the default and calling it the whole
answer. Measured across two vendors, 5 of 11 offered parameters were that.

---

## Commands

| Command | What it does |
| --- | --- |
| `emend demo [dir]` | Scaffold a demo repo with real drift |
| `emend scan <repo>` | Find API changes that intersect your code |
| `emend fix <repo>` | Plan, apply, and verify migrations |
| `emend pr <repo> --finding <id>` | Render the pull request (dry run by default) |
| `emend pins <repo>` | Repair drifted version pins — no model involved |
| `emend eval` | Measure the agent against a corpus |
| `emend serve` | Local dashboard |
| `emend models` | List models your LLM provider serves |

Useful flags: `--only pkg,pkg`, `--all`, `--json`, `--no-dev`, `--contracts` (scan);
`--finding <id>`, `--no-agent`, `--no-review`, `--drive`, `--keep` (fix);
`--create` (pr); `--model a,b`, `--repeat n`, `--cases <file>` (eval).

---

## Versions your repo writes down twice

A dependency version lives in the lockfile, where the package manager keeps it
honest. The same version copied into a Dockerfile tag, an `.nvmrc` or a CI matrix
is a copy, and nothing keeps a copy honest.

```
$ emend pins ./my-service

  drift      node → 22 (the declared engines.node)
    → Dockerfile:1  node:18-alpine
    → .github/workflows/ci.yml:6  node-version: '22'

  VERIFIED  2 edit(s) applied of 1 repairable conflict(s)
```

Two authorities and no others. For a package you install, the resolved version is
the fact and the tag is the stale copy. For node, `engines` is your own statement
of intent. Three files declaring three versions with nothing to arbitrate are
reported as disagreeing and **not** repaired — picking a winner would be guessing,
and that decision is yours.

**Wire-protocol versions** are the same shape and a different problem. A vendor
versions its HTTP API separately from the SDK that calls it: `stripe@18` and
`apiVersion: '2024-06-20'` move independently, and upgrading the package does not
touch the pin. Emend reads these by convention rather than by vendor —

```ts
headers: { 'Notion-Version': '2022-06-28' }   // the key names the vendor
new AWS.SES({ apiVersion: '2010-12-01' })     // the import names it
fetch(`${url}?api-version=2023-05-15`)        // the host names it
```

— so vendors nobody wrote down work the same as the ones that did. Where the
source names nobody, the pin is reported **unattributed** rather than guessed at.
That matters more than it sounds: a dated `apiVersion` is a shape eight vendors
share, and an earlier version read every one of them as Stripe's. Sampled across
160 real files, that mislabelled 8 pins in 9 — and since the label is the key the
vendor's published version is looked up by, an AWS pin from 2010 was being
compared against Stripe's current API version and reported as behind.

---

## Measuring the agent

Prompt changes are cheap to make and hard to judge. `emend eval` runs a corpus of
real migrations and scores them:

```
$ emend eval --model z-ai/glm-5.2,qwen/qwen3-coder --repeat 3

| Model | Cases | Runs | Pass | Clean | Edit ratio | Withheld | ... |
```

**`Pass` and `Clean` are deliberately different columns.** A green build says the
migration compiles and the tests pass. It says nothing about whether the model
changed things nobody asked about, bought the green with `any`, or shipped a
commit titled *"migrate `Cell`"* without removing a single use of `Cell`. Every
failure this project has actually hit lived in that gap.

Migrations vary between runs, so `--repeat` is how you tell a real change from
noise.

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

Step-by-step registration, including tunnelling webhooks to a local server,
verifying the loop end to end, and making the App public:
[`docs/github-app-setup.md`](docs/github-app-setup.md). Sizing, hosting options
and the systemd/TLS setup: [`docs/deployment.md`](docs/deployment.md).

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

## The LLM agent

The deterministic core handles detection, localisation, rename-class migrations,
and verification with **no model involved** — those are the parts whose answers
have to be reproducible and auditable.

The model runs where the answer is a judgement: findings the planner declines,
and the read-only review that asks whether a verified change still *means* the
same thing. **Both are on by default.** A finding Emend will not attempt is a
finding somebody repairs by hand; `--no-agent` and `--no-review` are there for
runs that must stay offline or byte-for-byte reproducible.

It also writes the **What to look at** section of a pull request — one or two
sentences on what the change does in your codebase's terms, and which of the
call sites is the one worth reading. Every other section of the body reports
what happened; facts do not prioritise themselves. It is never a verdict: the
verification table is the verdict, and it comes from commands that actually ran.

A `path` the model names that appears in neither the call sites nor the diff
sinks the whole summary rather than being quietly dropped. A model confident
enough to invent a filename has said what the rest of its prose is worth.

Without a key configured, the run still works and says so, rather than quietly
delivering the deterministic half as though that were everything.

It works with **any OpenAI-compatible endpoint**:

```bash
export EMEND_LLM_PROVIDER=nebius     # or fireworks, together, groq,
                                     # deepinfra, openrouter, ollama, vllm
export NEBIUS_API_KEY=...
emend models                         # see what your provider serves today
export EMEND_LLM_MODEL=<id from above>

emend fix ./my-service
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
  surface.ts      .d.ts → public API surface (breadth-first, canonical paths)
  diff.ts         surface × surface → classified changes
  specs.ts        resolve a vendor's OpenAPI description, with provenance
  specdiff.ts     description × description → route changes
  callsites.ts    repo → where package symbols are used (type resolution)
  httpsites.ts    repo → outbound HTTP calls, and which are unreadable
  detectors.ts    every tier → one finding shape
  analyze.ts      the scan pipeline
  plan.ts         deterministic rename planning
  apply.ts        isolated workspace, edit application, rollback
  verify.ts       baseline/post command running and comparison
  fix.ts          the fix pipeline (per-package)
  harness.ts      opencode escalation, with the evidence gate
  reviewharness.ts read-only repo-wide and behaviour reviews
  pr.ts           evidence-rich PR rendering + gh integration
  mcp.ts          MCP server, so a coding agent can drive Emend
  cli.ts          command surface
  github/         App auth, webhook intake, job runner, API pull requests
  llm/            providers, client, structured repair loop
docs/
  architecture.md             how it fits together, and why
  deployment.md               running it as a service
  github-app-setup.md         the App, step by step
  specs/emend-mvp.md          design spec
fixtures/demo-repo/           demo template with real drift
```

**[docs/architecture.md](docs/architecture.md) is the full map** — the three
tiers of evidence, the provenance and currency gates, where the model
participates and where it deliberately does not, and the rules that were each
learned by shipping the opposite.

Run `npm run typecheck` and `npm test` to verify.

`npm run audit:removals` cross-examines every reported removal across 18 real
SDK upgrades, resolving each path the way a consumer would rather than trusting
Emend's own index. It exists because the one bug class that matters most here —
a confident finding that is simply wrong — is invisible to unit tests and was
caught only when someone read a pull request and asked why the diff was empty.

---

## Status

MVP / proof of concept. TypeScript + npm + GitHub only. Scanning, migration and
pull requests are exercised against a real private repository; the GitHub App
token exchange is the one link only a registered App can validate. See
[`docs/specs/emend-mvp.md`](docs/specs/emend-mvp.md) §10 for what is deliberately
out of scope, and its Appendix A for the product decisions still open.

---

## Licence

**AGPL-3.0-only** — see [LICENSE](./LICENSE).

The clause that matters here is §13, Remote Network Interaction: run a modified
Emend as a service for other people and you owe them its source. Run it privately
and nothing is required of you.

A separate commercial licence is available for anyone who wants to embed Emend
without AGPL obligations. That is only possible because contributions are
collected under a [CLA](./CLA.md) — see [CONTRIBUTING.md](./CONTRIBUTING.md) for
why, and for the reason it is collected before the first merge rather than after.

## Known limitations

Measured, not hypothetical. Each of these is a case where Emend can be wrong or
silent, and knowing which is which is the point.

**A vendor's published description can omit an endpoint that works.** Emend
checks a raw HTTP call against the description the provider publishes, and some
providers do not describe everything they serve. `openrouter.ai` documents
`GET /api/v1/auth/key` while its `openapi.json` lists only `/auth/keys`; GitHub
has served `GET /repositories/{id}` for years without ever putting it in its
OpenAPI. Emend cannot tell that from a removal, so it says what it actually
checked — *not described by* the resolved description — rather than claiming the
endpoint is gone. **Treat a Tier 3 finding as a lead to verify against the
vendor's documentation, not as proof.** Two of two findings in a sweep of nine
public repositories were this.

**One host can serve several APIs.** Xero's accounting description says nothing
about `/projects.xro`, and GitHub's REST description says nothing about
`/graphql`. Emend refuses to claim a removal where the description names nothing
under the same top-level path, and reports those paths as unchecked instead.

**A description can be first-party and still dead.** `slackapi/slack-api-specs`
last changed in 2020 and still lists endpoints Slack has retired. Provenance and
currency are separate checks; a stored copy that has not moved in a year asserts
nothing.

**Only some calls can be read.** A URL assembled at runtime — `this.baseUrl`,
`process.env.API_URL ?? ''` — is recorded as unreadable rather than skipped, and
the count is shown. About a third of outbound calls in a typical repository are
readable; the rest genuinely do not exist until the process runs.

**Type-level findings are compared as text, and say so.** Package surfaces are
diffed by comparing declaration signatures. Two things that comparison can
demonstrate are reported as **breaking**: a symbol that is no longer there, and
a new required parameter — value or type — because every existing call is then
short an argument.

Every other signature edit is reported as **drift**: something moved under you,
with its call sites, and Emend cannot tell whether it bites. Spending the word
"breaking" on those is what makes it ignorable on the ones that deserve it.

All 41 drift findings from one large repository, read individually:

| what actually changed | n | is it a break? |
| --- | --- | --- |
| a parameter's name, or its destructuring pattern | 4 | **no — now suppressed** |
| a type alias inlined or renamed (`QueryKey` → `readonly unknown[]`) | ~9 | **no — now suppressed** |
| an optional parameter or member added | 5 | no — a widening |
| the return type narrowed (`ReactNode` → `ReactElement`) | 3 | no — returns are covariant |
| `any` → a specific type on a parameter | 7 | technically yes, in practice rarely |
| the result set narrowed (`(A \| B)[]` → `A[]`) | 3 | **type-safe, behaviour-changing** |
| generics too large to adjudicate by text | ~10 | unknown, honestly |

The alias row needed the type checker rather than string comparison, and it was
the largest: on `@tanstack/react-query` 5.51 → 5.101 alone it was **40 findings**,
because a library rewriting `type QueryKey = ReadonlyArray<unknown>` as a
conditional changes nothing about the type and everything about how it prints.
An alias is substituted only where both versions agree what it means, so it can
collapse a difference the printer invented and never create one.

The row that matters most is the smallest. A return type narrowing from
`(A | B)[]` to `A[]` is *safe* to the compiler and means the call now returns
fewer kinds of thing. No type-level analysis will ever catch that one; it is why
the behaviour review exists.
