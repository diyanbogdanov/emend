# Contributing to Emend

## Licence

Emend is licensed under the **GNU Affero General Public License v3.0** — see
[LICENSE](./LICENSE).

The clause that matters for a tool like this one is **§13, Remote Network
Interaction**: anyone who runs a modified Emend as a network service has to offer
its users the modified source. Running it privately is unrestricted; offering it
to others as a service is not.

## Why there is a CLA

Emend is dual-licensed: AGPL-3.0 for everyone, and a separate commercial licence
for anyone who wants to embed it without AGPL obligations.

**Dual licensing only works if one party owns or controls all the copyright.** A
project that merges contributions under AGPL alone cannot later offer any of that
code commercially, because it does not have the right to. Collecting the
agreement afterwards means tracking down every past contributor and getting each
one to agree — including any who have moved on, changed employer, or simply do
not reply. One who declines can block the licence for everyone.

So the agreement is collected before the first merge, not after. See [CLA.md](./CLA.md).

> **This has not been reviewed by a lawyer.** It is a starting point modelled on
> widely-used contributor agreements, and it should be reviewed before the
> repository is made public or relied on for anything commercial. Getting it
> wrong is not recoverable by editing a file later.

## Before you open a pull request

```bash
npm run typecheck
npm test
```

Both must be green. If you changed anything the agent does — a prompt, the
evidence gate, the planner — also run:

```bash
emend eval --model <model> --repeat 3
```

and put the before and after tables in the pull request. A prompt change without
a measurement is a guess, and this repository has a documented history of guesses
that turned out backwards — including one this week that was argued from sound
reasoning and settled the other way by reading a diff.

## What the code expects of you

[docs/architecture.md](./docs/architecture.md) describes the design, and the
module headers carry the reasoning for the decisions they implement. Two conventions matter more than the rest:

**Never report something unverified as safe.** A package with no type
declarations is `unanalyzable`, not `clean`. A verification that did not run is
`unverified`, not `passing`. A repair that changed nothing is not a success
however green the build is. These are enforced in code, and a change that
loosens one needs to say why in its commit message.

**Comments explain why, not what.** The interesting content in this codebase is
the reasoning behind a decision — usually a specific failure that motivated it.
Prefer recording what went wrong over describing what the code does.
