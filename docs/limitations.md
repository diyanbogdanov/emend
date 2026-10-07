# Known limitations

Measured, not hypothetical. Each of these is a case where Emend can be wrong or
silent, and knowing which is which is the point.

Back to the [README](../README.md).

---

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
the largest: across five real package pairs it was **80 findings**, because a
library rewriting `type QueryKey = ReadonlyArray<unknown>` as a conditional
changes nothing about the type and everything about how it prints. An alias is
substituted only where both versions agree what it means, so it can collapse a
difference the printer invented and never create one.

Union member order is settled the same way — by parsing the type and sorting on
the AST, using the TypeScript compiler this project already depends on. The
printer orders a union by internal type id, so which order you see depends on
what else the program happened to load.

So is a type argument that only restates its default: `QueryObserverResult` and
`QueryObserverResult<unknown, Error>` are one type where the declaration reads
`<TData = unknown, TError = Error>`. That one matters out of proportion to its
subtlety — axios 1.18 → 1.19 adds a single defaulted type parameter, seventeen
symbols mention it, and axios is in nearly every TypeScript repository.

Together these removed **101 findings across five real package pairs and added
none**.

The row that matters most is the smallest. A return type narrowing from
`(A | B)[]` to `A[]` is *safe* to the compiler and means the call now returns
fewer kinds of thing. No type-level analysis will ever catch that one; it is why
the behaviour review exists.

**A known blind spot, measured.** Where a package changes an *internal* type
alias that its exported signatures mention, those signatures render identically
in both versions and Emend reports nothing —
`@tanstack/query-core`'s `Listener` went from `() => void` to
`(focused: boolean) => void` and is invisible. Expanding aliases the two versions
disagree about would surface it, and was tried: across 77 real package pairs it
added **782** findings to catch that one, most of them differences buried deep in
expanded inferred types. Reporting the changed alias itself instead measures at
154 across the same 77 pairs, which is the shape a fix should take.

---

## Python

Python support is newer and narrower than TypeScript's, and the gaps below are
where it is narrower. Most are structural — they follow from how Python is read
here — and are said as such rather than dressed as measurements.

**`emend fix` does not migrate Python yet.** `scan` reads Python; `fix` bumps
npm packages only, and refuses a Python finding outright rather than hand its
name to a package manager that would install whatever npm package shares it.

**Verifying Python needs a type checker.** Through `emend mcp`'s `verify` tool
— the one path that verifies a Python repository today — Emend runs mypy or
pyright, then pytest, and calls a repository with neither type checker
`unverified`. Passing tests alone are not taken as proof: Python has no compile
step, and accepting them would change what Emend acts on for TypeScript too.
This is a refusal, not an oversight.

**A package's API is read from its source, not inferred.** Each version's wheel
is parsed, never imported, so nothing resolves what a name refers to:

- a signature is whatever its own `def` line says;
- re-exports through `__init__.py` are not followed; every file's top-level
  names are merged into one namespace instead, which finds a re-exported name
  where it is defined — and makes two files defining the same name collide,
  the first in path order winning;
- names manufactured at import time (a module `__getattr__`, PEP 562) are
  invisible;
- a decorator that changes what callers pass is read at its face-value `def`;
  only `@deprecated` is understood.

What it does find is real. PyYAML 5.4.1 → 6.0.3 reports `load` as drift at the
call `yaml.load(open("c.yml"))`, where 6.0 made `Loader` required; urllib3
1.26.18 → 2.0.0 finds `HTTPResponse.getheaders` and `AppEngineManager` removed
and `request()` added — each a documented 2.0 change.

**A method call is a lead, not proof.** Without types, `c.close()` cannot be
tied to a `Session`. A call through an imported name is exact; a method of the
right name, in a file that imports the package, is reported as a place to look.
The import is the precondition, which is what keeps "not called from this
repository" strong.

**Only wheels are read, and only up to a size.** A package that publishes only
an sdist is skipped — reading one can mean running its `setup.py`, which is the
one thing analysis never does. A wheel PyPI lists at over 256 MiB is skipped
too, which takes in the CUDA builds of torch and tensorflow. Both are reported
as skipped, never as clean.

**Import names come from where a wheel's files sit.** PyYAML is found as `yaml`
because its wheel ships `yaml/`. A wheel that also ships a stray top-level
`tests/` package claims `tests` as well, and a namespace package written the
old pkgutil way claims its whole namespace (`google`) rather than its own
corner of it. When a vulnerable package's wheel cannot be read at all, whether
the repository imports it is reported as *could not be checked* — never as *not
imported*.

**A range in requirements.txt is not an installed version.** `requests>=2.0`
names no version, so that dependency is skipped rather than guessed, unless a
`-c` constraints file pins it. An `-r` or `-c` include is followed only inside
the repository; one that leaves it, or is a URL, is named in a warning and not
read. A repository with only a `pyproject.toml` has its dependencies read from
nowhere, and says so.

**Dependency groups are not read.** uv and Poetry record which group a package
belongs to; Emend reports every dependency as a runtime one. That over-reports
— a test-only package is screened as though it ships — which is the safe
direction to be wrong in.

**One ecosystem per repository.** A repository that both npm and Python claim
has its npm dependencies analysed and its Python ones skipped, with a warning
naming the ecosystem left out. Merging the two would key both by bare package
name, and an npm and a PyPI package with the same name would overwrite each
other.

**PEP 440 is not fully normalised.** Versions written the canonical way order
correctly — epochs, pre-, post- and dev-releases, including a post-release of a
pre-release. Alternative spellings (`1.0-alpha`, `1.0.a1`, `rev`) are not
normalised; one that does not parse sorts lowest, so it is never proposed as an
upgrade target.
