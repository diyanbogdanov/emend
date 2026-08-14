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
