/**
 * Diffs two API surfaces into a set of classified changes.
 *
 * Every classification here is deterministic — no model is consulted. That is a
 * deliberate constraint: the research on LLM-driven dependency migration
 * (Byam, arXiv 2505.07522) found that model-generated end-to-end fixes fully
 * repaired only 27% of builds. Detection must be something we can be certain
 * about, so that anything generative downstream is checked against ground truth
 * rather than trusted.
 */

import { canonicalType } from './surface.ts';
import type { ApiSurface, ApiSymbol, SurfaceChange, SurfaceDiff } from './types.ts';

/**
 * Split the first parameter list of a signature into top-level parameters.
 *
 * Every step here has to be nesting-aware. Type text is full of nested
 * parentheses, generics, object literals and tuples, so scanning for the first
 * `)` or splitting on every `,` produces nonsense on any realistic SDK
 * signature.
 */
export function parameterList(signature: string): string[] | null {
  const open = signature.indexOf('(');
  if (open === -1) return null;

  let depth = 0;
  let close = -1;
  for (let i = open; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return null;

  const inner = signature.slice(open + 1, close).trim();
  if (inner === '') return [];

  const params: string[] = [];
  let nesting = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '(' || ch === '<' || ch === '{' || ch === '[') nesting++;
    else if (ch === ')' || ch === '>' || ch === '}' || ch === ']') nesting--;
    if (ch === ',' && nesting === 0) {
      params.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') params.push(current.trim());
  return params;
}

/**
 * True for `name?: T`, `...rest: T[]`, and `name: T = default`.
 *
 * The `?` must be found before the *top-level* colon. A naive search finds
 * `errorMap?:` inside a nested options object and misclassifies a required
 * parameter as optional.
 */
function isOptionalParam(param: string): boolean {
  const trimmed = param.trim();
  if (trimmed.startsWith('...')) return true;

  let nesting = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '(' || ch === '<' || ch === '{' || ch === '[') nesting++;
    else if (ch === ')' || ch === '>' || ch === '}' || ch === ']') nesting--;
    else if (ch === ':' && nesting === 0) {
      return trimmed.slice(0, i).trim().endsWith('?');
    }
  }
  return trimmed.endsWith('?');
}

/** Parameters a caller must supply. Null when the signature isn't callable. */
export function requiredArity(signature: string): number | null {
  const params = parameterList(signature);
  if (params === null) return null;
  return params.filter((p) => !isOptionalParam(p)).length;
}

/**
 * Whether the new declaration only added type parameters a caller may omit.
 *
 * `Config` and `Config<Foo>` both still bind when `P = any` is appended, so
 * nothing that compiled stops compiling. Reporting that as breaking reads a
 * structural difference as a semantic one — measured on activepieces, where
 * axios 1.18 -> 1.19 reported `AxiosRequestConfig`, `AxiosResponse` and
 * `isAxiosError` as breaking on the default path, with no flags, on a package
 * in nearly every TypeScript repository.
 *
 * Two things have to hold, and the second is what keeps this from swallowing
 * real breaks. The parameters already there must be untouched and every added
 * one must be defaulted — which only `TypeParam` can answer, since the
 * signature omits defaults entirely. And the rest of the signature must be
 * unchanged *once the added parameters are taken back out*: a widening threads
 * its new parameter through the return type, so the strings legitimately
 * differ, while `(path: string)` becoming `(path: number)` alongside it does
 * not survive the removal and stays breaking.
 */
export function widenedByDefaultedTypeParams(before: ApiSymbol, after: ApiSymbol): boolean {
  const had = before.typeParams ?? [];
  const has = after.typeParams ?? [];
  if (has.length <= had.length) return false;
  for (let i = 0; i < had.length; i++) if (has[i]?.name !== had[i]?.name) return false;

  const added = has.slice(had.length);
  if (!added.every((p) => p.defaulted)) return false;

  // Take the added parameters back out of the new signature. What is left must
  // be what the old one said, or something else changed too.
  let reduced = after.signature;
  for (const { name } of added) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    reduced = reduced.replace(
      new RegExp(`,\\s*${escaped}(\\s*=\\s*[^,>]+)?(?=\\s*[,>])`, 'g'),
      '',
    );
  }
  return reduced === before.signature;
}

/**
 * Whether a signature identifies a declaration rather than describing a shape.
 *
 * The distinction the first attempt at rename detection lacked, and the reason
 * it was reverted. `typeof slugify` names a declaration — nothing else in a
 * package has that type by accident — while `boolean` names a shape half the
 * surface shares. Matching on the second let one newly added boolean property
 * stand in as the destination for every removed boolean property in
 * @vue/runtime-core 3.5, hiding real removals behind a coincidence of type.
 *
 * Only `typeof X`, deliberately. It is the narrowest form that is provably
 * nominal, and a narrow rule that suppresses two false removals is worth more
 * than a broad one that hides an unknown number of real ones.
 */
function namesADeclaration(signature: string, path: string): boolean {
  const named = /^typeof ([A-Za-z_$][\w$]*)$/.exec(signature.trim());
  if (!named) return false;
  // And it must name *itself*. `AddressModule :: typeof LocationModule` is an
  // alias, and removing an alias removes an export however well its target
  // survives — @faker-js/faker 10 dropped `AddressModule` and
  // `import { AddressModule }` breaks, which is in their own migration guide.
  // A declaration reachable under some other name is not the same fact as a
  // name that still works, and for a consumer only the second one matters.
  return named[1] === (path.split('.').pop() ?? path);
}

/**
 * A signature with its type parameters renamed to their positions.
 *
 * A type parameter's name is not observable to a caller: they are supplied
 * positionally, `useMutation<A, B, C, D>`, and nobody can reference one by
 * name. So @tanstack/react-query renaming `TContext` to `TOnMutateResult` —
 * used in the same slot throughout — changed the signature string and nothing
 * a consumer can see, and was reported as breaking.
 *
 * Comparing positionally is the same move that fixed the cache path and the
 * defaulted type parameter: normalise the representation, then compare meaning.
 * A rename that comes *with* a real change still differs after normalising,
 * and so does a reordering, because position is exactly what is preserved.
 */
/**
 * A signature with the printer's disambiguating suffixes removed.
 *
 * `typeToString` appends `_2`, `_3` and so on when two types share a name in
 * scope, so which one gets a suffix depends on what else the file happens to
 * import. @tanstack/react-query 5.51 -> 5.101 produced a breaking finding whose
 * entire difference was `_2`. Same family as the version inside a cache path:
 * the rendering moved and the API did not.
 *
 * Used only for the comparison, never for what is stored, so a reader still
 * sees what the compiler actually printed.
 */
function withoutPrinterSuffixes(signature: string): string {
  return signature.replace(/\b([A-Za-z_$][\w$]*?)_\d+\b/g, '$1');
}

/**
 * A signature reduced to what a caller is actually held to.
 *
 * Three things a consumer cannot observe are stripped: the printer's
 * disambiguating suffixes, the names of type parameters, and the names of value
 * parameters. What survives is arity, optionality, and the types themselves.
 */
interface Reduction {
  /** Aliases both versions agree the meaning of. Shared between the two sides. */
  aliases: ReadonlyMap<string, string>;
  /** This version's own declared defaults, for the type names both agree on. */
  defaults: ReadonlyMap<string, readonly string[]>;
}

function comparableSignature(symbol: ApiSymbol, reduce?: Reduction): string {
  const params = symbol.typeParams ?? [];

  // A sentinel keeps a substitution from being substituted again, which a
  // parameter already named `T0` would otherwise trigger.
  let out = symbol.signature;
  params.forEach((param, i) => {
    const escaped = param.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'g'), `\u0000T${i}`);
  });
  const reduced = withoutPrinterSuffixes(positionalParams(out.replaceAll('\u0000', '')));
  // One pass, not a fixed point: an alias whose expansion names another alias
  // is left as it is rather than chased, because a cycle would not terminate
  // and nothing measured needed the second hop.
  const aliases = reduce?.aliases;
  const substituted =
    aliases && aliases.size > 0
      ? reduced.replace(/\b[A-Za-z_$][\w$]*\b/g, (name) => aliases.get(name) ?? name)
      : reduced;
  // Last, so it also settles whatever ordering the substitutions introduced.
  return canonicalType(substituted, reduce?.defaults);
}

/**
 * Aliases the two versions agree about.
 *
 * The whole safety argument. Where an alias means the same thing in both,
 * substituting it can only collapse a difference the printer invented — the
 * comparison gets strictly more accurate. Where the two disagree, substituting
 * would make signatures differ that had been rendering identically, and
 * measured on query-core that trade was bad: of four aliases whose expansion
 * moved between 5.51 and 5.101, two had merely been reordered by the printer
 * (`"error" | "pending" | "success"` against `"pending" | "success" | "error"`),
 * one was a genuine break and one was ambiguous. Two false findings bought for
 * one true one is the wrong direction for this codebase, so a disagreement
 * means the alias is left alone on both sides and nothing changes.
 */
/**
 * Type names whose defaults the two versions agree about, position by position.
 *
 * Positions only one version has are not a disagreement. Adding a defaulted type
 * parameter cannot break a caller — `Config` and `Config<Foo>` both still bind
 * when `P = any` is appended — which is the reasoning
 * `widenedByDefaultedTypeParams` already applies at the declaration, applied
 * here at every place the type is referenced. Measured, that is where most of it
 * happens: axios 1.18 -> 1.19 adds one defaulted parameter and 17 symbols
 * mention it.
 *
 * A shared position whose default genuinely moved excludes the type entirely.
 * `TError = Error` becoming `TError = unknown` changes what a bare reference
 * means, and dropping the argument on both sides would hide it.
 */
function agreedDefaults(
  from: ApiSurface,
  to: ApiSurface,
  aliases: ReadonlyMap<string, string>,
): Set<string> {
  const agreed = new Set<string>();
  const theirs = to.typeDefaults ?? {};
  // Through the same reduction the signatures get: one version writes the
  // default as `QueryKey` and the other as `readonly unknown[]`, and those are
  // the same default.
  const reduced = (text: string) =>
    canonicalType(
      withoutPrinterSuffixes(text).replace(/\b[A-Za-z_$][\w$]*\b/g, (n) => aliases.get(n) ?? n),
    );

  for (const [name, ours] of Object.entries(from.typeDefaults ?? {})) {
    const other = theirs[name];
    if (other === undefined) continue;
    let agrees = true;
    for (let i = 0; i < Math.min(ours.length, other.length); i++) {
      if (reduced(ours[i] ?? '') !== reduced(other[i] ?? '')) {
        agrees = false;
        break;
      }
    }
    if (agrees) agreed.add(name);
  }
  return agreed;
}

function agreedAliases(from: ApiSurface, to: ApiSurface): Map<string, string> {
  const reduced = (text: string) => withoutPrinterSuffixes(canonicalType(text));
  const agreed = new Map<string, string>();
  const theirs = to.typeAliases ?? {};
  for (const [name, expansion] of Object.entries(from.typeAliases ?? {})) {
    const other = theirs[name];
    if (other === undefined) continue;
    // Compared through the same reduction a signature gets, because every
    // artifact that makes two renderings of one type differ applies here too.
    // Measured on query-core and react-query, five of the six aliases that
    // appeared to have moved between 5.51 and 5.101 had not: three were unions
    // the printer reordered (`NetworkMode`, `QueryStatus`, `MutationStatus`) and
    // one was its own disambiguating suffix (`React.ReactNode` against
    // `React_2.ReactNode`).
    if (other === expansion || reduced(other) === reduced(expansion)) {
      agreed.set(name, expansion);
    }
  }
  return agreed;
}

/**
 * One parameter binding: `props`, `{ a, b }`, `...rest`, and whether it is optional.
 *
 * Returns null when what follows is not a binding at all, which is most of the
 * time \u2014 `(A | B)[]` and `(T extends X ? A : B)` are parenthesised types, and a
 * scanner that mistook either for a parameter would rewrite the type itself.
 */
function readBinding(
  s: string,
  from: number,
): { rest: boolean; optional: boolean; end: number } | null {
  let i = from;
  while (s[i] === ' ') i++;

  const rest = s.startsWith('...', i);
  if (rest) i += 3;

  const first = s[i];
  if (first === undefined) return null;
  if (first === '{' || first === '[') {
    // A destructuring pattern, skipped whole: what it pulls out of the argument
    // is the callee's business, and the declared type after the colon is the
    // part a caller is held to.
    const close = first === '{' ? '}' : ']';
    let depth = 0;
    for (; i < s.length; i++) {
      if (s[i] === first) depth++;
      else if (s[i] === close && --depth === 0) {
        i++;
        break;
      }
    }
    if (depth !== 0) return null;
  } else if (/[A-Za-z_$]/.test(first)) {
    while (i < s.length && /[\w$]/.test(s[i] ?? '')) i++;
  } else {
    return null;
  }

  const optional = s[i] === '?';
  if (optional) i++;
  // Only a colon makes it a binding. Without one this was a type expression
  // that happened to start with an identifier.
  if (s[i] !== ':') return null;
  return { rest, optional, end: i + 1 };
}

const OPENERS = '({[<';
const CLOSERS = ')}]>';

/**
 * Parameter bindings replaced by their position.
 *
 * TypeScript has no named arguments, so what a parameter is *called* is
 * unobservable to a caller \u2014 and where a parameter is destructured, the printer
 * renders the binding pattern in place of a name, which means a callee pulling
 * one more property out of an argument whose declared type never moved renders
 * as a changed signature. Measured on one repository: `@xyflow/react`'s
 * `BaseEdge`, its `ReactFlowProvider` and react-hook-form's `FormProvider` were
 * three findings across 21 call sites, all of them this.
 *
 * Only a binding directly inside a `(` group is rewritten. Members of an object
 * type are also `name: Type` and their names are absolutely part of the
 * contract, so confusing the two would erase every real property rename \u2014 the
 * enclosing bracket is what tells them apart.
 */
export function positionalParams(signature: string): string {
  const stack: Array<{ open: string; count: number }> = [];
  let out = '';
  let i = 0;
  let atParamStart = false;

  while (i < signature.length) {
    const ch = signature[i] ?? '';

    // `=>` before bracket handling: its `>` is not a closing angle, and popping
    // on it would leave every following depth wrong.
    if (ch === '=' && signature[i + 1] === '>') {
      out += '=>';
      i += 2;
      atParamStart = false;
      continue;
    }

    if (atParamStart && stack[stack.length - 1]?.open === '(') {
      const binding = readBinding(signature, i);
      if (binding) {
        const group = stack[stack.length - 1]!;
        out += `${binding.rest ? '...' : ''}p${group.count}${binding.optional ? '?' : ''}:`;
        group.count++;
        i = binding.end;
        atParamStart = false;
        continue;
      }
    }

    if (OPENERS.includes(ch)) {
      stack.push({ open: ch, count: 0 });
      atParamStart = ch === '(';
    } else if (CLOSERS.includes(ch)) {
      stack.pop();
      atParamStart = false;
    } else if (ch === ',') {
      atParamStart = true;
    } else if (ch !== ' ') {
      atParamStart = false;
    }

    out += ch;
    i++;
  }
  return out;
}

/** What `normaliseSignature` appends when it keeps only part of a signature. */
const CUT = '\u2026<truncated>';

export function diffSurfaces(from: ApiSurface, to: ApiSurface): SurfaceDiff {
  const changes: SurfaceChange[] = [];
  const aliases = agreedAliases(from, to);
  const shared = agreedDefaults(from, to, aliases);
  // Substituted the same way the signatures are, or they no longer match what
  // they are compared against: after `QueryKey` becomes `readonly unknown[]` in
  // a signature, a default still recorded as `QueryKey` matches nothing.
  const substitute = (text: string) =>
    aliases.size === 0
      ? text
      : text.replace(/\b[A-Za-z_$][\w$]*\b/g, (name) => aliases.get(name) ?? name);
  const only = (all: Record<string, string[]> | undefined): Map<string, readonly string[]> =>
    new Map(
      Object.entries(all ?? {})
        .filter(([name]) => shared.has(name))
        .map(([name, defaults]) => [name, defaults.map(substitute)]),
    );
  // Each side drops its OWN defaults; `shared` only decides which type names may
  // be dropped at all. The texts differ legitimately — one version writes
  // `QueryKey` where the other writes `readonly unknown[]` — and each is the
  // default that version declared.
  const fromSide: Reduction = { aliases, defaults: only(from.typeDefaults) };
  const toSide: Reduction = { aliases, defaults: only(to.typeDefaults) };
  const notes: string[] = [];

  const unanalyzable = from.entry === null || to.entry === null;
  if (from.entry === null) {
    notes.push(`${from.pkg}@${from.version} ships no type declarations`);
  }
  if (to.entry === null) {
    notes.push(`${to.pkg}@${to.version} ships no type declarations`);
  }

  // A truncated surface cannot support absence claims. If the *new* surface was
  // cut short, a symbol missing from it may simply be past the cutoff — reporting
  // that as a removal would invent breaking changes that do not exist.
  // A surface whose entry resolved but yielded nothing is the same failure one
  // step later, and it read as a deleted API. Measured on activepieces: every
  // package reporting a removal reported *only* removals — slugify 1 of 1,
  // fuse.js 1 of 1, react-table 5 of 5 — and slugify 1.6.6 -> 1.6.9 is a patch
  // whose published types still export the same symbol. Could not read is not
  // was removed.
  const readNothing = (s: ApiSurface): boolean =>
    s.entry !== null && Object.keys(s.symbols).length === 0;

  const suppressRemovals = Boolean(to.truncated) || readNothing(to) || unanalyzable;
  const suppressAdditions = Boolean(from.truncated) || readNothing(from) || unanalyzable;
  if (readNothing(to)) {
    notes.push(
      `${to.pkg}@${to.version} declares types but no symbols could be read from them; removals are not reported`,
    );
  }
  if (readNothing(from)) {
    notes.push(
      `${from.pkg}@${from.version} declares types but no symbols could be read from them; additions are not reported`,
    );
  }
  if (to.truncated) {
    notes.push(
      `${to.pkg}@${to.version} surface was truncated; removals are not reported`,
    );
  }
  if (from.truncated) {
    notes.push(
      `${from.pkg}@${from.version} surface was truncated; additions are not reported`,
    );
  }

  // Where a symbol whose type names a declaration might have moved to: an
  // identically typed symbol that is newly present, and the only candidate.
  // Ambiguity is a guess, and a guess here hides a removal.
  const appeared = new Map<string, string | null>();
  for (const [path, sym] of Object.entries(to.symbols)) {
    if (path in from.symbols) continue;
    if (!/^typeof [A-Za-z_$][\w$]*$/.test(sym.signature.trim())) continue;
    appeared.set(sym.signature, appeared.has(sym.signature) ? null : path);
  }

  // Signatures long enough that only part of them was stored. What lies past
  // the cut was never compared, so neither a difference nor an agreement within
  // the visible part settles the whole signature — and an agreement reading as
  // "unchanged" was the silent half of that.
  const partial: string[] = [];

  if (!unanalyzable) {
    for (const [path, before] of Object.entries(from.symbols)) {
      // A path absent from `symbols` may still be reachable through an alias.
      //
      // The surface walk claims each symbol under the first path that reaches
      // it and records other spellings in `aliases`. So when a package converts
      // a direct export into an aliased re-export — `export { Root }` becoming
      // `export { Avatar as Root }`, which @radix-ui/react-avatar did between
      // 1.1.11 and 1.2.6 — `Avatar` claims the symbol and `Root` moves to
      // `aliases`. Consulting only `symbols` then reports `Root` as removed,
      // with high confidence, about a package that still exports it. That
      // produced a pull request for a migration nobody needed.
      const after = to.symbols[path] ?? to.symbols[to.aliases[path] ?? ''];

      if (!after) {
        if (suppressRemovals) continue;

        // A symbol may have moved rather than gone. Adding a default export
        // changes which root the extractor walks and renames every path at
        // once — slugify 1.6.6 -> 1.6.9 is a patch whose function is still
        // exported, read as `_default` instead of `slugify`.
        const movedTo = namesADeclaration(before.signature, path)
          ? appeared.get(before.signature)
          : undefined;
        if (movedTo) {
          notes.push(
            `${to.pkg}@${to.version}: ${path} is no longer at that path, but ${movedTo} is the same declaration — reported as moved rather than removed`,
          );
          continue;
        }
        changes.push({
          path,
          kind: 'removed',
          severity: 'breaking',
          confidence: 'high',
          before: before.signature,
          after: null,
        });
        continue;
      }

      // Deprecated in the version being moved to, whether or not it was already
      // deprecated in the one installed. Only the first was reported, so a scan
      // of 227 packages found zero deprecations while zod alone carried 332 —
      // everything deprecated before the last upgrade was invisible. A
      // deprecation somebody has been living with is still work, and it is what
      // stops compiling at the next major.
      if (after.deprecated) {
        changes.push({
          path,
          kind: 'deprecated',
          severity: 'deprecation',
          confidence: 'high',
          before: before.signature,
          after: after.signature,
          // What the new declaration says to do instead, when it says anything.
          // Often the replacement is not a symbol — recharts 3 replaces `Cell`
          // with a `shape` prop — so this is the only channel that can carry it.
          ...(after.doc ? { guidance: after.doc } : {}),
        });
        // A symbol can be both newly deprecated and re-signatured; fall through
        // so the signature change is also recorded.
      }

      if (before.signature.endsWith(CUT) || after.signature.endsWith(CUT)) {
        partial.push(path);
      }

      // Compared with type parameters at their positions, so a rename alone is
      // not a change. Their names are not something a caller can refer to.
      if (
        before.signature !== after.signature &&
        comparableSignature(before, fromSide) !== comparableSignature(after, toSide)
      ) {
        const beforeRequired = requiredArity(before.signature);
        const afterRequired = requiredArity(after.signature);
        // A type parameter added without a default is a required type argument,
        // provable the same way a required value parameter is: `Config<Foo>`
        // stops binding because the second has nothing to fall back to.
        const hadTp = before.typeParams ?? [];
        const hasTp = after.typeParams ?? [];
        const gainedRequiredTypeParam =
          hasTp.length > hadTp.length && hasTp.slice(hadTp.length).some((t) => !t.defaulted);

        const gainedRequiredParam =
          beforeRequired !== null &&
          afterRequired !== null &&
          afterRequired > beforeRequired;

        // A widening is not a break: everything that bound before still binds.
        const widened = widenedByDefaultedTypeParams(before, after);

        changes.push({
          path,
          kind: 'signature-changed',
          // What this comparison can actually demonstrate.
          //
          // A new *required* parameter is breaking and provably so: every
          // existing call is now short an argument. Everything else is an edit
          // whose effect a string comparison cannot determine — and measured on
          // activepieces, of 44 such findings none had a shape that could be
          // proved either way: 24 were not function signatures at all and the
          // rest changed more than one thing at once. Roughly half were
          // additions — a wider input union, an extra property on a returned
          // object — which break nobody, and all of them were being called
          // breaking.
          //
          // So the finding stays, with its call sites, and the claim is
          // calibrated to the evidence: something moved under you, and Emend
          // cannot tell whether it bites. Saying `breaking` there spends the
          // word on cases that do not deserve it, which is what makes it
          // ignorable on the ones that do.
          severity:
            widened
              ? 'feature'
              : gainedRequiredParam || gainedRequiredTypeParam
                ? 'breaking'
                : 'drift',
          // A new *required* parameter is unambiguously breaking. Any other
          // signature edit might be a widening (safe) or a narrowing (breaking);
          // string comparison alone cannot tell, so it stays medium and is never
          // auto-applied without verification.
          confidence: widened || gainedRequiredParam || gainedRequiredTypeParam ? 'high' : 'medium',
          before: before.signature,
          after: after.signature,
        });
      }
    }

    if (!suppressAdditions) {
      for (const [path, after] of Object.entries(to.symbols)) {
        if (from.symbols[path]) continue;
        changes.push({
          path,
          kind: 'added',
          severity: 'feature',
          confidence: 'high',
          before: null,
          after: after.signature,
        });
      }
    }
  }

  if (partial.length > 0) {
    notes.push(
      `${to.pkg}@${to.version}: ${partial.length} signature(s) were kept only in part and compared only as far as they were kept — ${partial.slice(0, 5).join(', ')}${partial.length > 5 ? ', …' : ''}`,
    );
  }

  return {
    pkg: from.pkg,
    fromVersion: from.version,
    toVersion: to.version,
    changes,
    unanalyzable,
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  };
}

function majorOf(version: string): number {
  return Number.parseInt(version.split('.')[0] ?? '0', 10) || 0;
}

/**
 * Changes that should be shown to a consumer, in the order a human should read
 * them.
 *
 * The signature-change filter is the difference between a usable report and an
 * unusable one. Comparing normalised type text catches real breaks, but it also
 * fires on every symbol whose internals were rewritten without its contract
 * changing. Across a major version that is almost everything: scanning a zod
 * 3.22 -> 4.4 upgrade produced 2,100+ "breaking" signature changes, essentially
 * all of them noise (`z.ZodString.min` was flagged, and it is fine).
 *
 * That measurement stands. What was wrong was where the filter sat.
 *
 * This list gates the **call-site walk**, not the report: `analyze.ts` uses it to
 * decide which symbols to look for, and a change with no call site never becomes
 * a finding — it is counted as unlocated. So the intersection was already doing
 * the filtering, and the confidence bar was a second filter applied *before* the
 * one that works. On a major jump — exactly when breaking changes happen — it
 * dropped every medium-confidence signature change before anything could ask
 * whether the code touches it.
 *
 * That cost a real miss. `useQuery` in @tanstack/react-query 4 -> 5 loses its
 * positional `(key, fn, options)` overload; the symbol survives, so the change is
 * `signature-changed` at medium confidence, and it was discarded before
 * localisation. A fixture calling it three times scanned clean — "No findings: no
 * tracked API change intersects this codebase", which is the clean bill of health
 * this project exists to refuse to give.
 *
 * So signature changes now reach the walk regardless of version distance, and the
 * intersection decides. The 2,100 zod entries have no call sites and stay
 * unlocated and counted; the handful a repository actually calls become findings,
 * severity `drift`, which is precisely the word for "something moved and I cannot
 * tell from a string comparison whether it bites".
 *
 * Removals and deprecations are unaffected — those are high-confidence in both
 * directions and are the findings that carry the product.
 *
 * **Measured, and the cost is real.** Across the four eval fixtures the breaking
 * and deprecation counts did not move at all — no new claim of a hard break —
 * but located call sites did: zod 3->4 went 7 -> 65, recharts 2->3 went 1 -> 7,
 * openai 3->4 was unchanged, and react-query 4->5 went 0 -> 1, which is the miss
 * this fixes. So the trade is nine times the located sites on a major zod bump
 * against never again reporting a clean scan over a real break, and the sites
 * gained are `drift` — labelled as "something moved and a string comparison
 * cannot say whether it bites", which is the whole reason that word exists.
 *
 * That volume is not yet solved, only correctly labelled. Presenting 65 drift
 * sites the same way as 4 breaking ones is a reporting problem, and it is open.
 */
export function consumerImpacting(diff: SurfaceDiff): SurfaceChange[] {
  const rank: Record<string, number> = { breaking: 0, deprecation: 1, feature: 2, safe: 3 };

  return diff.changes
    .filter((c) => {
      if (c.kind === 'removed') return true;
      if (c.kind === 'deprecated') return true;
      if (c.kind === 'signature-changed') return true;
      return false;
    })
    .sort((a, b) => {
      const bySeverity = (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9);
      if (bySeverity !== 0) return bySeverity;
      // Shallower paths first: `z.record` before `z.core.util.assertEqual`.
      return a.path.split('.').length - b.path.split('.').length;
    });
}
