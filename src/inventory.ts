import type { RepoInfo } from './types.ts';
import { inventoriesFor, registeredManifests } from './ecosystems.ts';

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
    // Named from the registry, not a hardcoded wishlist: naming a Python
    // filename before any Python adapter exists would be exactly the "nobody
    // looked" claim this codebase refuses to make elsewhere.
    throw new Error(
      `no recognised manifest in ${repoDir} — looked for ${registeredManifests().join(', ')}`,
    );
  }
  // The first claimant, deliberately. A polyglot repository has more than one,
  // and merging their dependency lists would present a single `RepoInfo` whose
  // `name` and `workspaces` belong to whichever ecosystem happened to win —
  // a worse answer than picking one and saying so. Revisit when a real polyglot
  // repository demands it, with evidence rather than symmetry.
  const info = await first.declared(repoDir);

  // The rest of `claimed` is real work `inventoriesFor` already did, discarded
  // by picking `first` above. Cannot fire while npm is the only registered
  // ecosystem, but the second claimant (a Python adapter) is committed work
  // later in this plan, not a hypothetical — a polyglot repository deserves to
  // know an ecosystem went unanalysed rather than silently see npm's answer
  // presented as the whole picture.
  if (claimed.length > 1) {
    const skipped = claimed.slice(1).map((i) => i.id);
    info.warnings.push(
      `${claimed.length} ecosystems claim this repository (${claimed
        .map((i) => i.id)
        .join(', ')}) — only ${first.id}'s declared dependencies were analysed; ${skipped.join(', ')} skipped`,
    );
  }
  return info;
}
