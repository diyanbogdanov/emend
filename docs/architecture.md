# Architecture

How Emend is put together, and why it is put together that way. If you are
looking for how to *use* it, start with the [README](../README.md); this is for
people changing the code.

**This describes; it does not decide.** The specs under
[`specs/`](./specs/) are authoritative, and the code is meant to be their image
— design first, then conform. The current pair is
[`2026-08-06-self-maintaining-mvp.md`](./specs/2026-08-06-self-maintaining-mvp.md)
and [`2026-08-12-model-boundary.md`](./specs/2026-08-12-model-boundary.md). If
this file and a spec disagree, the spec is right and this file is stale.

---

## 1. The problem, stated precisely

A dependency changes. Somewhere in your repository, some lines stop being
correct. Almost every existing tool answers a question adjacent to that one:

| Tool | Question it answers |
| --- | --- |
| Dependabot / Renovate | Did a version number change? |
| `npm audit` / OSV | Does an installed version carry a known CVE? |
| Changelogs | What did the maintainer choose to write down? |

None of them answers **which of your lines break**. That question needs three
things at once: what the dependency's contract *was*, what it *is*, and where
your code *touches it*. Emend is the intersection of those three, plus a proof
that the repair works.

Everything else in this document follows from one commitment:

> **Could not check is not the same as checked and clean.**

A tool that reports "no findings" when it failed to read half your call sites
is worse than no tool, because it converts an unknown into a false assurance.
Every silence in Emend has to be a measured silence. Where it cannot check
something, it says so and counts it.

---

## 2. Three tiers of evidence

A "contract" between your code and something else takes three forms, and each
supports a different strength of claim. They are separate subsystems because
they are separately *provable*, not because they are separately implemented.

### Tier 1 — the typed package surface

**Source of truth:** the `.d.ts` files npm already publishes for both versions.

Emend downloads both tarballs, extracts the public API surface from each
(`surface.ts`), and diffs them (`diff.ts`). Type declarations are
machine-readable, versioned, exhaustive, and published by nearly every
TypeScript SDK — no cooperation from the vendor is required.

What it can prove, and the wording is deliberate:

- **breaking** — a symbol is gone, or gained a required parameter. Every
  existing call is now short an argument. This is demonstrable from the text.
- **deprecation** — the declaration carries a `@deprecated` marker.
- **drift** — the signature changed in some other way. Something moved under
  you; Emend cannot tell from a string comparison whether it bites.

That last distinction is the whole point of the tier: calling a widening
"breaking" is what makes the word ignorable on the changes that deserve it.

Reading all 41 drift findings from one large repository individually, most were
not changes to the contract at all but changes to how it was *rendered*: a
parameter's name or destructuring pattern, a type alias the printer expanded in
one version and named in the other, a union whose members it ordered differently,
its own disambiguating suffix. Each is normalised away before comparing —
`positionalParams`, the agreed-alias table, `canonicalType` (which also drops a
type argument that only restates its default), `withoutPrinterSuffixes` — and
together they removed 101 findings across five real package pairs while adding
none. The full table is in the README's known
limitations.

### Tier 2 — known vulnerabilities

**Source of truth:** the OSV database (`osv.ts`, `advisory.ts`).

The narrowest tier and the least interesting architecturally: a lookup keyed by
package and version. It earns its place because the *remediation* is shared with
Tier 1 — a CVE fix is a version bump that has to survive the same verification.

### Tier 3 — the HTTP contract

**Source of truth:** the OpenAPI description the provider publishes.

This is the tier no `.d.ts` can reach. When your code calls
`fetch('https://api.vendor.com/v1/things/' + id)`, there is no package, no
type, and no lockfile entry — just a string that compiles whatever it says.
Emend reads the call out of the source (`httpsites.ts`), resolves the vendor's
own description (`specs.ts`, `specfetch.ts`), and asks whether the route the
call reaches is one the description contains.

Three things make this hard, and each has a named guard:

**Whose description is it?** A description found on GitHub under some random
account is not the vendor speaking. `specs.ts` walks the provider's own origin,
their `apis.json`, and their GitHub organisation, and refuses anything it cannot
trace back to them. `PROVENANCE_RANK` orders how directly a copy came from the
vendor; `PROVIDER_CONTROLLED` decides who is even allowed to assert.

**Is it still true?** Provenance and currency are separate questions.
`slackapi/slack-api-specs` is unimpeachably first-party and last changed in
2020, listing endpoints Slack has since retired. `canAssertBreakage` requires a
stored copy to have moved within a year. A description served live from the
vendor's own domain needs no date — being served *is* the evidence.

**Does the description cover this path at all?** One host commonly serves
several APIs. Xero's accounting description says nothing about `/projects.xro`;
GitHub's REST description says nothing about `/graphql`. Emend refuses to claim
a removal where the description names nothing under the same top-level path, and
reports those paths as *unchecked*.

Even with all three, a Tier 3 finding is a **lead, not a proof** — providers do
serve endpoints they never described. The finding says *not described by* rather
than *removed*, because that is what was actually checked.

Comparing a description against its own past (`--since`) surfaces two more
things, and they are routed apart because they want opposite handling. A route
that went away is a repair. A parameter newly offered is not: adopting a filter
changes which records come back, so it is reported and never written. The
exception is a pagination control, which is not a capability — its appearance
says the endpoint pages, and a caller that never pages has been treating the
first page as the whole answer.

---

## 3. The pipeline

```
                    ┌──────────────── DETECT ─────────────────┐
                    │                                          │
  package.json      │  npm registry          vendor's own      │
  + node_modules    │  (.d.ts, both          OpenAPI           │
        │           │   versions)            description       │
        ▼           │       │                     │            │
  installed version─┼───────┤                     │            │
                    │       ▼                     ▼            │
                    │  surface diff          route set         │
                    └───────┬─────────────────────┬────────────┘
                            │                     │
   ┌──── LOCATE ────────────┼─────────────────────┼────────────┐
   │  TypeScript program    │   raw HTTP calls    │            │
   │  over your repo        │   read from source  │            │
   │  (imports + resolution)│                     │            │
   └────────────┬───────────┴──────────┬──────────┘            │
                │                      │                       │
                └──────► INTERSECTION ◄┘                       │
                              │                                 │
                              ▼                                 │
              FINDINGS  (what, where, how strong, why)          │
                              │                                 │
        ┌─────────────────────┼─────────────────────┐           │
        ▼                     ▼                     ▼           │
  deterministic plan     LLM agent            drive session     │
  (rename-class)         (structured edits)   (opencode + MCP)  │
        └─────────────────────┼─────────────────────┘           │
                              ▼                                 │
                    isolated git worktree                       │
                              │                                 │
              baseline → apply → verify → compare               │
                              │                                 │
                              ▼                                 │
                    behaviour review (read-only)                │
                              │                                 │
                              ▼                                 │
         verified · regression · unverified · unreviewed  ──────┘
```

### Detect

`analyze.ts` orchestrates. `detectors.ts` assembles findings from every tier
into one shape, so downstream code never asks which tier a finding came from —
only what it claims and how strongly.

### Locate

Two locators, because the two kinds of contract live in different places.

`callsites.ts` builds a real TypeScript program and uses the type checker's own
resolution. It does not grep for identifiers: a name means what the checker says
it means, or Emend does not claim to have found it.

`httpsites.ts` reads outbound HTTP calls. It resolves base URLs across modules
by *name plus an actual import statement* — never by resolving module paths,
because a name that happens to match is not evidence. A URL assembled at runtime
(`this.baseUrl`, `process.env.API_URL ?? ''`) is recorded as **unreadable**, not
skipped. About a third of outbound calls in a typical repository are readable;
the rest genuinely do not exist until the process runs, and the count is
reported so nobody reads silence as coverage.

### Verify

Every migration runs in a throwaway `git worktree` (`apply.ts`), and the order
is the load-bearing part (`verify.ts`):

1. **baseline** — typecheck and tests run *before* any edit
2. apply the edits; bump the dependency
3. **post** — typecheck and tests again
4. **compare**

Without step 1, a repository that was already failing has its pre-existing
failures attributed to the migration. The outcomes are `verified`,
`regression`, `pre-existing-failure`, `typecheck-only` and `unverified`, and
only the first is reported as success.

### Review

A green build proves the code compiles and the tests that exist still pass. It
proves nothing about whether the change still *means* the same thing. A call
redirected from `/audiences/{id}/contacts` to `/contacts` typechecks perfectly,
returns the same `Contact[]`, and now sends your broadcast to everyone in the
account.

`reviewharness.ts` runs a read-only model over the repository — not the diff —
and asks whether the behaviour survived: did the set of returned rows change,
the pagination, the ordering, the error signalling; was a guard removed
alongside the URL. On the fixture above it followed the call into its consumer
and reported the leak for half a cent.

**Read-only is enforced by evidence, not configuration.** The workspace is
compared before and after, and a session that modified anything has its findings
discarded — a read-only tool that wrote is a tool behaving differently from its
contract, and the findings of a process that ignored one instruction are not
evidence of anything.

---

## 4. Where the model participates

Detection, localisation and verification are **deterministic and always will
be**. They are the parts whose answers must be reproducible and auditable, and a
model cannot be either.

**Everything that talks to a model goes through `harness.ts`** — including
`emend models`, which only *lists* what a provider serves and still has no
business knowing one exists. One module, two verbs, because they are two capabilities and the difference decides how far a
wrong answer gets:

| Verb | What it is | Why a wrong answer is contained |
| --- | --- | --- |
| `ask(system, user)` | Messages in, text out. Never touches the checkout. | The caller interprets the answer. A proposed edit whose `find` string matches nothing is rejected before anything is written — it **fails closed**. |
| `run(dir, task)` | A subprocess with tools, working in a directory. | It writes first and is judged after, by `gate.ts`: any changed region the failure did not ask for is reverted before verification. |

That split is why the structured path was not folded into the harness when the
two were unified. Byam's 27% is the case for keeping a constrained strategy;
BigBag's is the case for it returning a *validated edit set* rather than a
freeform patch, which is precisely what a harness produces. Both papers are
implemented in `llm/propose.ts`, and its header derives the design from them.

What *was* shared and duplicated is the boundary: at one point six modules
resolved a provider and three built requests. Provider, key, retry policy and
the three-state availability now live in one place, and a feature module owns
what it says and nothing else.

`gate.ts` is the judge both strategies answer to, and it consults no model on
purpose — it decides whether a model's work may land, and a judge that can be
talked round is not one.

### How a job is expressed

> Decided in [§5 of the model boundary spec](./specs/2026-08-12-model-boundary.md);
> the code is being moved onto it now. What follows is the shape it lands in, and
> the byte-identity test at the end of this section is what makes moving safe.

Four jobs reach `ask`: migrating a call site, tightening what stripping `any`
exposed, reviewing a migration that is already green, and repairing what a linter
flagged. They share a response shape and a rule for narrowing a union, and they
**contradict each other on purpose** — migration forbids touching a function
body, tightening requires it; the review job exists partly to say *do not report
what the tightening job exists to remove*.

Both the sharing and the contradicting are *relationships between jobs*, and
copying is not a way to maintain a relationship — nothing checks that the copies
still agree.

- A **skill** is a named instruction fragment — the response shape, the narrowing
  rule, the blast-radius rule. It exists once and is referenced.
- A **task** is one job: which skills it includes, what it says beyond them, and
  how it renders its context.

`runTask(task, ctx)` is the single entry point. The task supplies its parts; the
harness composes the system and user prompts and calls `ask`. What that buys is
not brevity. It is that a disagreement between two jobs becomes the presence or
absence of a *named* skill — which can be checked — instead of prose in four
places, which cannot.

**The restructuring is not allowed to change a word.** These are the most-edited
lines in the repository and the least covered by tests, because what a prompt is
worth is measured by running it. So the composed prompts are asserted
byte-identical to what the four hand-written builders produced, which is what
makes this a refactor and not an experiment. Changes to wording are separate
commits, measured through `eval.ts`.

The model participates where the answer is a judgement:

| Pass | What it does | Constraint |
| --- | --- | --- |
| Structured repair (`llm/propose.ts`) | Proposes text edits for findings the planner declines | No filesystem, no shell. Given the surface diff, the located sites and the source. Edits the failure did not ask for are withheld and recorded. |
| Tightening | Strips parameter `any` and repairs what that exposes | Reverted wholesale if verification fails |
| Harness escalation (`harness.ts`) | An opencode session with edit rights, when structured edits still leave the build red | Every hunk held to the evidence rule; anything the failure did not ask for is reverted |
| Behaviour review (`reviewharness.ts`) | Reads the repository and reports what the diff cannot show | Read-only, enforced by comparing the workspace |

It is **on by default**. `--no-agent` and `--no-review` turn it off for runs
that must stay offline or byte-for-byte reproducible. A finding the planner
declines is a finding somebody repairs by hand, and a self-maintaining tool that
stops at the mechanical cases is a linter that files issues.

Three states, not two: the model is *on*, *switched off*, or *wanted and
unreachable*. The third used to be invisible — a run with no API key produced
the same output as a run that chose not to try, and both read as "the model
looked and found nothing."

Any OpenAI-compatible endpoint works (`llm/providers.ts`), including a local
Ollama or vLLM. The recommended defaults are open-weight.

---

## 5. Module map

```
src/
  ── detection ───────────────────────────────────────────────
  registry.ts     npm metadata, tarball download + cache
  lockfile.ts     package-lock.json -> resolved versions + install tree
  vendor.ts       reconstruct node_modules from the lockfile, no install
  inventory.ts    repo -> installed dependency versions
  surface.ts      .d.ts -> public API surface (breadth-first, canonical paths)
  diff.ts         surface x surface -> classified changes
  specs.ts        resolve a vendor's OpenAPI description, with provenance
  specfetch.ts    fetch and cache it
  specdiff.ts     description x description -> route changes
  osv.ts          known vulnerabilities
  advisory.ts     advisory metadata and reachability
  pins.ts         version literals a repo writes down twice
  lint.ts         lint findings, routed to the linter's own autofix
  detectors.ts    every tier -> one finding shape
  analyze.ts      the scan pipeline

  ── localisation ────────────────────────────────────────────
  callsites.ts    repo -> where package symbols are used (type resolution)
  httpsites.ts    repo -> outbound HTTP calls, and which are unreadable
  goreach.ts      Go: symbol-level reachability, which its advisories name
  impact.ts       the mirror image — what reshaping a symbol the repo OWNS costs

  ── repair ──────────────────────────────────────────────────
  plan.ts         deterministic rename planning
  apply.ts        isolated workspace, edit application, rollback
  verify.ts       baseline/post command running and comparison
  remediate.ts    the vulnerability remediation ladder
  fix.ts          the fix pipeline (per-package)
  harness.ts      THE boundary: `ask`, `run`, `runTask` — nothing else reaches a model
  gate.ts         is this change one the failure asked for? no model involved
  reviewharness.ts read-only repo-wide and behaviour reviews
  quality.ts      deprecation gaps left behind by a migration
  freshness.ts    upgrades simply sitting there, with nothing that touches you

  ── output ──────────────────────────────────────────────────
  pr.ts           evidence-rich PR rendering + gh integration
  store.ts        node:sqlite persistence
  server.ts       dashboard + webhook endpoint
  mcp.ts          MCP server, so a coding agent can drive Emend
  cli.ts          command surface
  eval.ts         measure the agent against a corpus

  github/         App auth, webhook intake, job runner, API pull requests
  llm/tasks.ts    the four jobs, each as skills + instructions + a renderer
  llm/skills.ts   instruction fragments, named once and shared by reference
  llm/propose.ts  the structured strategy: send, parse, gate what comes back
  llm/client.ts   the HTTP transport
  llm/providers.ts provider presets
```

---

## 6. Rules that keep it honest

These are not style preferences. Each was learned by shipping the opposite.

**Could not check ≠ checked and clean.** Applied to unreadable calls, unresolvable
descriptions, uncovered paths, host budget, truncated surfaces, and unreviewed
behaviour. Every one of those is counted and reported.

**Do not compare a representation and call the difference a difference in
meaning.** This is the single most common bug in this codebase's history. Cache
paths that differ but name the same package. Segment counts that differ but
match the same route. Printer suffixes. Type-parameter names. A dated
`apiVersion` shared by eight vendors. Every instance produced a confident,
wrong finding.

**A filter that empties a list has made a claim.** Dropping entries that fail
validation reads as tidying, but if *every* entry was dropped, the honest result
is "I did not understand this answer", not "there was nothing to report". Those
are opposite claims, and one of them is a clean bill of health.

**A rule that only one prompt carries is a rule the others are missing.** The
narrowing rule lived in the tightening prompt alone, so a migration that had to
narrow a union wrote `Number(value)` unguided and rendered `$NaN` in a chart that
typechecked and passed every test. Instructions are named skills because of that,
not for brevity.

**Attribution can fail, and failing is a value.** Where Emend cannot tell whose
API a pin belongs to, the subject is `null` rather than a guess — a wrong
subject gets the pin compared against a different company's published version.

**Measure before writing the rule, and check something other than your
motivating example.** Two rules written from an invented fixture turned out to
be inert; one written from a single real example hid real removals across a
whole package. The rules that survived were the ones measured against a corpus
first.

---

## 7. Testing

```bash
npm test            # 604 tests, node:test, no framework
npm run typecheck   # tsc --noEmit; the real gate
npm run audit:removals
```

`audit:removals` cross-examines every reported removal across 18 real SDK
upgrades, resolving each path the way a consumer would rather than trusting
Emend's own index. It exists because the bug class that matters most here — a
confident finding that is simply wrong — is invisible to unit tests, and was
caught only when someone read a pull request and asked why the diff was empty.

Tests here are expected to encode *why* a behaviour matters, not just that it
happens. A test whose comment explains the failure it prevents is doing its job;
one that restates the assertion in words is not.

---

## 8. Runtime

Node 22.6+, native TypeScript type stripping, **no build step**. Two runtime
dependencies (`typescript`, `yaml`). `node:sqlite` for persistence. That is
deliberate: a tool that audits other people's dependency trees should be able to
account for its own.
