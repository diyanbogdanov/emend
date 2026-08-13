/**
 * Symbols the target version really exports, ranked by nearness to what broke.
 *
 * All that survives of what was `llm/agent.ts` and then `llm/propose.ts`. Both
 * names described a strategy — a model proposing `find`/`replace` pairs for
 * Emend to locate and apply — and the one-writer decision removed it: one
 * thing changes code now, and it is the harness. What that strategy needed
 * *besides* a model was this, and the need did not leave with it.
 *
 * The cheapest defence available against an invented API. A model can still
 * hallucinate a symbol; it has no excuse to.
 */

/** Symbols in the target version that share a container with the changed symbol. */
export function nearbySymbols(
  changedPath: string,
  toSymbols: Record<string, { path: string; deprecated: boolean }>,
): string[] {
  const dot = changedPath.lastIndexOf('.');
  const parent = dot === -1 ? '' : changedPath.slice(0, dot);
  const leaf = (dot === -1 ? changedPath : changedPath.slice(dot + 1)).toLowerCase();

  const leafOfRaw = (p: string): string => {
    const i = p.lastIndexOf('.');
    return i === -1 ? p : p.slice(i + 1);
  };
  const leafOf = (p: string): string => leafOfRaw(p).toLowerCase();

  // camelCase and snake_case both split into the words a reader would say.
  const words = (s: string): string[] =>
    s.split(/(?=[A-Z])|[._\-\s]/).filter(Boolean).map((w) => w.toLowerCase());
  const leafWords = words(leafOfRaw(changedPath));

  /**
   * Whether the missing name's words all appear, in order, inside a candidate.
   *
   * `AxiosTransformer` -> `AxiosResponseTransformer` is the shape: a word added
   * in the middle, which no substring test detects.
   *
   * The single-word case returns early because it decides nothing — a lone word
   * matching as a word always matches as a substring too, so bucket 2 has
   * already claimed it. That is a short-circuit, not a rule, and no test guards
   * it: removing the line changes no ranking.
   */
  const insertsInto = (candidateLeaf: string): boolean => {
    if (leafWords.length < 2) return false;
    let i = 0;
    for (const word of words(candidateLeaf)) {
      if (word === leafWords[i]) i += 1;
    }
    return i === leafWords.length;
  };

  // Same-container siblings, *plus* any symbol elsewhere carrying the same leaf
  // name. Restricting to siblings makes a relocated helper — `record` becoming
  // `core.record` — impossible to offer, because the filter runs before the
  // ranking below ever sees it. The model is told to use nothing outside this
  // list, so a migration that moves a symbol between containers could not be
  // expressed at all.
  const out: string[] = [];
  for (const s of Object.values(toSymbols)) {
    if (s.deprecated) continue;
    const sDot = s.path.lastIndexOf('.');
    const sParent = sDot === -1 ? '' : s.path.slice(0, sDot);
    if (sParent === parent || leafOf(s.path) === leaf) out.push(s.path);
  }

  // Rank by name similarity to the symbol that broke, not alphabetically.
  //
  // The prompt can only carry a slice of this list, and the model is instructed
  // to use nothing outside it. Sorting alphabetically buried zod 4's
  // `partialRecord` — the exact replacement for a broken `record` call — at
  // position ~200 of 264, past the cutoff. The model then could not name the one
  // symbol that would have fixed the build, and spent three attempts failing.
  const score = (candidatePath: string): number => {
    const cDot = candidatePath.lastIndexOf('.');
    const cParent = cDot === -1 ? '' : candidatePath.slice(0, cDot);
    const name = leafOf(candidatePath);
    const sibling = cParent === parent;
    if (name === leaf) return sibling ? 0 : 1; // same name, here or relocated
    if (name.includes(leaf)) return 2; // record -> partialRecord, looseRecord
    if (leaf.includes(name)) return 3;
    // A word inserted in the middle, which neither `includes` test can see.
    // Measured live: axios 0.33.0 removes `AxiosTransformer` and exports
    // `AxiosResponseTransformer`, and neither name contains the other, so the
    // real replacement sat in the bottom bucket with every unrelated export. The
    // agent could not name it and weakened the annotation instead.
    if (insertsInto(leafOfRaw(candidatePath))) return 4;
    return 5;
  };

  return out.sort((a, b) => {
    const diff = score(a) - score(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
}

// ---------------------------------------------------------------------------
// Evidence: deciding which proposed edits the upgrade actually asked for.
// ---------------------------------------------------------------------------

/** A compiler or test diagnostic, reduced to the location it points at. */

/** `src/schema.ts(28,15): error TS2554: ...` — tsc's own format. */
/** `src/schema.ts:28:15: error ...` — most other tools. */
