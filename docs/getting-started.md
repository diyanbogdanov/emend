# Getting started

From nothing to a verified migration, in the order you'd actually do it. For how
the pieces fit together, see [architecture.md](architecture.md); for running it
as a service, [deployment.md](deployment.md).

---

## 1. Prerequisites

| | |
| --- | --- |
| **Node 22.6+** | Required. Emend runs TypeScript directly via native type stripping — there is no build step. `node --version` to check. |
| **git** | Migrations run in a throwaway `git worktree`. |
| An LLM endpoint | Optional to start, on by default when configured. Any OpenAI-compatible endpoint, including a local Ollama or vLLM. |
| `GITHUB_TOKEN` | Only for `--contracts`. Unauthenticated GitHub allows 60 requests an hour, which one scan can exhaust. |
| `opencode` | Only for `--drive` and the behaviour review. Skipped with a message if absent. |

---

## 2. Install

```bash
git clone <this repo> emend && cd emend
npm install          # two runtime dependencies: typescript, yaml
npm run typecheck    # should print nothing
npm test             # 577 tests
```

Then either invoke it directly:

```bash
node bin/emend.mjs --help
```

or put it on your `PATH`:

```bash
npm link
emend --help
```

The rest of this guide uses `emend`.

---

## 3. First run, on a repo with known drift

```bash
emend demo /tmp/emend-demo
emend scan /tmp/emend-demo --only zod
```

```
  zod 3.22.4 → 4.4.3
    breaking   record (signature-changed, high confidence, id 42c38dcf56ce)
      → src/schema.ts:28:15  metadata: z.record(z.string()),
    breaking   ZodError.errors (removed, high confidence, id 55028a971871)
      → src/schema.ts:41:23  return result.error.errors.map(...)
    + 1210 other breaking change(s) in this upgrade do not appear anywhere in your code
```

The last line is the point. zod 4 ships roughly 1,215 breaking changes and five
touch this repository.

Now migrate one and watch it get verified:

```bash
emend fix /tmp/emend-demo
```

Emend copies the repo into an isolated worktree, runs your typecheck and tests
**before** touching anything, applies the migration, runs them again, and
compares. Without that baseline, a repository that was already red would have
its pre-existing failures blamed on the migration.

---

## 4. Configure the model

Detection, localisation and verification never involve a model. Repairs the
deterministic planner declines, and the read-only review, do — and both are on
by default once a key is present.

```bash
export EMEND_LLM_PROVIDER=openrouter    # nebius | fireworks | together | groq
                                        # deepinfra | openrouter | ollama | vllm
export OPENROUTER_API_KEY=...
emend models                            # what your provider serves today
```

Each provider ships one verified default model, so that is enough. To pin a
different one:

```bash
export EMEND_LLM_MODEL=<id from `emend models`>
```

Or point at anything OpenAI-compatible, including a local runtime:

```bash
export EMEND_LLM_BASE_URL=http://localhost:11434/v1
export EMEND_LLM_MODEL=qwen3-coder:30b
```

Without a key, runs still work and say so:

```
    the model is on by default but unavailable: no API key found.
    Set one of: OPENROUTER_API_KEY, EMEND_LLM_API_KEY — pass --no-agent to stop asking
```

That message exists because "switched off" and "wanted and unreachable" used to
produce identical output, and a run that never called a model read as a model
that looked and found nothing.

---

## 5. Scan a real repository

```bash
emend scan ~/work/my-service
```

Useful from here:

| Flag | Why |
| --- | --- |
| `--only pkg,pkg` | One package at a time while you're learning what it reports |
| `--no-dev` | Skip devDependencies |
| `--vulns` | Also screen the installed tree against OSV |
| `--freshness` | Also list packages behind latest where nothing you call changed |
| `--json` | Machine-readable, for CI |

---

## 6. Check your HTTP calls

The tier no package describes. Needs network access and a GitHub token.

```bash
export GITHUB_TOKEN=ghp_...
emend scan ~/work/my-service --contracts
```

Emend reads outbound HTTP calls out of your source, resolves each vendor's own
published OpenAPI description, and reports calls reaching routes the description
no longer contains.

| Flag | Why |
| --- | --- |
| `--max-hosts n` | Default 8. Each host is outbound requests; the scan says how many it skipped. |
| `--github-org stripe.com=stripe` | For vendors whose own records don't link back to their API domain. Per vendor deliberately — one org for all of them would credit the wrong provider. |
| `--since[=days]` | Compare a description against itself a year ago. The **only** way to see a deprecation or a newly available capability, since both are still in today's copy. |

A finding here is a lead to verify, not a proof. Providers do serve endpoints
they never described, which is why the wording is *not described by* rather than
*removed*.

---

## 7. Fix, review, and open a PR

```bash
emend fix ~/work/my-service --finding <id>
```

What runs, in order:

1. deterministic plan for rename-class changes
2. the model, for findings the planner declines
3. verification against the baseline
4. the **behaviour review** — a read-only model reads the repository and asks
   whether the change still means the same thing

Step 4 is the one a green build cannot replace. A call redirected from
`/audiences/{id}/contacts` to `/contacts` typechecks perfectly, returns the same
type, and sends your broadcast to everyone in the account.

```bash
emend pr ~/work/my-service --finding <id>            # dry run, prints the body
emend pr ~/work/my-service --finding <id> --create   # pushes a branch, opens a DRAFT PR
```

Turn passes off deliberately when you need to:

```bash
emend fix ~/work/my-service --no-agent --no-review   # offline, reproducible
```

---

## 8. Environment reference

**Model** — all optional; the provider preset supplies the rest.

| Variable | Default |
| --- | --- |
| `EMEND_LLM_PROVIDER` | — |
| `EMEND_LLM_MODEL` | the provider's verified default |
| `EMEND_LLM_BASE_URL` | the provider's URL |
| `EMEND_LLM_API_KEY` | falls back to the provider's own key variable |
| `EMEND_LLM_TEMPERATURE` | `0` |
| `EMEND_LLM_MAX_TOKENS` | `32000` |
| `EMEND_LLM_MAX_ATTEMPTS` | `3` |

Provider keys read directly: `OPENROUTER_API_KEY`, `NEBIUS_API_KEY`,
`FIREWORKS_API_KEY`, `TOGETHER_API_KEY`, `GROQ_API_KEY`, `DEEPINFRA_API_KEY`.

**Everything else**

| Variable | What for |
| --- | --- |
| `GITHUB_TOKEN` / `GH_TOKEN` | `--contracts` resolution and `emend pr --create` |
| `EMEND_CACHE` | Where tarballs and descriptions are cached |
| `EMEND_DB` | SQLite path for stored findings |
| `EMEND_REGISTRY` | An alternative npm registry |
| `EMEND_DEBUG` | Verbose internals |
| `EMEND_GITHUB_APP_ID`, `EMEND_GITHUB_PRIVATE_KEY`, `EMEND_GITHUB_WEBHOOK_SECRET` | The GitHub App — see [github-app-setup.md](github-app-setup.md) |

---

## 9. When something looks wrong

**"No findings" on a repo you expect drift in.** Check the caveat lines under
the summary. Emend counts what it could not read — unreadable URLs, hosts over
budget, unresolvable descriptions — precisely so that silence is never mistaken
for coverage. If the counts are high, that is the answer.

**A scan reports a route as missing that you know works.** Believe your
knowledge. Providers serve endpoints they never put in their OpenAPI; GitHub has
served `GET /repositories/{id}` for years without describing it. This is a
documented limitation, not a bug.

**A migration reports `unverified` or `typecheck-only`.** Emend never reports
those as success. Usually it means your test script did not run — in an
untrusted-mode run, tests are deliberately suppressed.

**The behaviour review says "unreviewed".** `opencode` is missing, or the
session did not answer. Could not review is not reviewed and clean, and that
distinction decides whether an edit should ship.

**Everything is slower than expected.** The review is a real model reading real
files. `--no-review` skips it; know that you are skipping the only pass that
reads what a change means rather than what it says.
