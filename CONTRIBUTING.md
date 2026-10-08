# Contributing to Emend

## Licence

Emend is licensed under the [MIT License](./LICENSE). By submitting a
contribution you agree that it is licensed under the same terms — there is no
separate agreement to sign.

If a contribution includes work that is not yours, say so in the pull request
and name its licence, so it can be recorded in
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).

## Before you open a pull request

```bash
npm run typecheck
npm test
```

Both must be green.

You do not need to run `npm run build` yourself. It bundles the CLI for
publishing, `npm install` runs it for you through `prepare`, and a checkout runs
its sources regardless of whether a `dist/` is sitting there — the launcher goes
by whether it is under `node_modules`, not by what has been built. The one thing
worth building deliberately for is a change to how Emend finds the files it
ships beside the code (`skills/`, `fixtures/`, `bin/`): those resolve differently
once bundled, and CI proves it by installing the tarball rather than by reading
the diff.

If you changed anything the agent does — a prompt, the
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

## Releasing

For maintainers. A release is a pull request, then a tag:

1. On a branch, run `npm version X.Y.Z --no-git-tag-version`, move the
   changelog's `[Unreleased]` entries under `[X.Y.Z] — <date>` with a compare
   link, and open a pull request.
2. Once it is merged, tag the merge commit and push the tag:

   ```bash
   git checkout main && git pull
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

3. [`release.yml`](./.github/workflows/release.yml) publishes that tag to npm,
   with provenance and without an npm login or token. It refuses a tag that does
   not match `package.json`'s version or is not on `main`, and runs the
   typecheck and tests first.
4. Create the GitHub release from the changelog's `[X.Y.Z]` section.
