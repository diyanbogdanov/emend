import type { RepoInfo } from './types.ts';
import { inventoriesFor } from './ecosystems.ts';

/**
 * What this repository declares it depends on.
 *
 * A router since the language seams landed: whichever ecosystem claims the
 * repository supplies the answer. It used to read `package.json` directly and
 * throw when absent, which gated every entry point on npm before any seam could
 * be consulted — so a Python repository failed with an npm-shaped error and never
 * reached the coverage line that exists to describe exactly that case.
 */
export async function readRepo(repoDir: string): Promise<RepoInfo> {
  const claimed = await inventoriesFor(repoDir);
  const first = claimed[0];
  if (!first) {
    throw new Error(
      `no recognised manifest in ${repoDir} — looked for package.json, ` +
        'pyproject.toml, requirements.txt, uv.lock, poetry.lock, pdm.lock and Pipfile.lock',
    );
  }
  // The first claimant, deliberately. A polyglot repository has more than one,
  // and merging their dependency lists would present a single `RepoInfo` whose
  // `name` and `workspaces` belong to whichever ecosystem happened to win —
  // a worse answer than picking one and saying so. Revisit when a real polyglot
  // repository demands it, with evidence rather than symmetry.
  return first.declared(repoDir);
}
