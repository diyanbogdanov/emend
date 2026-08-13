# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: **Security → Report a
vulnerability** on this repository. That keeps the report out of the public
issue tracker until a fix exists.

Include what you would want included: the code path, a way to reproduce, and
what an attacker gets. A report that names a file and line is worth ten that
name a category.

This is a solo-maintained project. Reports get a first response on a
best-effort basis — expect days, not hours — and an honest answer about
whether and when a fix will land. Please do not disclose publicly before
hearing back.

## What Emend does with the code it touches

Knowing the security model tells you where a finding would matter:

- **Analysis never executes repository code.** Dependencies are symlinked from
  a tarball cache rather than installed, the dependency bump passes
  `--ignore-scripts`, and the hosted path never runs the repository's test
  script. Anything that adds code execution to the analysis path removes the
  property that makes per-job isolation unnecessary — that is the invariant
  most worth reporting a hole in.
- **One thing changes code**: a harness session in a throwaway `git worktree`.
  Nothing touches the user's working tree; a workspace that does not verify is
  discarded.
- **Local verification does run your own project's typecheck and tests** —
  `emend fix` on a repository you do not trust is running that repository's
  toolchain, the same as opening it in an editor with tasks enabled.
- **`emend serve` binds `127.0.0.1` by default** and has no authentication.
  `--host` widens it deliberately; the dashboard serves repository names,
  paths and diffs to anyone who can reach it.
- **`.env` is loaded from the current working directory.** Run Emend from your
  own directory, not from inside a checkout you do not trust — a hostile
  `.env` can point `EMEND_LLM_BASE_URL` or `EMEND_GITHUB_API` somewhere else
  for any variable your environment does not already set.
- **Secrets stay in the environment.** LLM keys reach the harness by variable
  reference, never written into config or logs; the GitHub App private key is
  read from `EMEND_GITHUB_PRIVATE_KEY` and installation tokens are cached in
  memory only.

## Supported versions

Pre-1.0: fixes land on `main` only. There are no backported patches.
