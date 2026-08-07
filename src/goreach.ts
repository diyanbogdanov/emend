/**
 * Go, and the symbol-level reachability npm cannot offer.
 *
 * Two things make Go the ecosystem worth adding next. Its inventory is a flat
 * resolved list in `go.sum`, so the reader is small — which was the whole claim
 * about OSV being ecosystem-keyed. And its advisories name the *functions* that
 * are vulnerable, not just the module: measured, `GO-2023-1737` carries
 * `{"imports":[{"path":"github.com/gin-gonic/gin","symbols":["Context.FileAttachment"]}]}`.
 * That is the data `govulncheck` runs on, and nothing equivalent exists for npm.
 *
 * It takes two hops to reach. GHSA records for Go carry no `ecosystem_specific`
 * at all; the `GO-xxxx` record they alias does. Same shape as following an
 * `x-origin` — the first source says where a better one is.
 *
 * **What this establishes, precisely.** A Go symbol is `Func` for a package-level
 * function and `Type.Method` for a method. The first can be matched exactly,
 * through the import alias the file actually uses. The second cannot, without a
 * Go type checker: `c.FileAttachment(...)` is only the vulnerable call if `c` is
 * a `gin.Context`, and knowing that means resolving types. So a method match says
 * *a call to a method of this name appears here, in a file that imports the
 * affected module* — which is a strong lead and is not proof, and is reported at
 * medium confidence for exactly that reason.
 */

import type { CallSite } from './types.ts';
import type { InstalledPackage, OsvRecord } from './osv.ts';

export interface SymbolTarget {
  /** The import path the symbols belong to. */
  path: string;
  symbols: string[];
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/**
 * What this module actually builds against.
 *
 * `go.sum` first, because it is the resolved set — the role package-lock.json
 * plays. Every module appears there twice, once for its content and once for its
 * `go.mod`, and counting both doubles every query and every finding.
 */
export function goInventory(goSum: string, goMod: string): InstalledPackage[] {
  const found = new Map<string, InstalledPackage>();

  for (const line of goSum.split('\n')) {
    const m = line.match(/^(\S+)\s+(v\S+?)(\/go\.mod)?\s+h1:/);
    if (!m?.[1] || !m[2]) continue;
    // The `/go.mod` line is the same module, hashed differently.
    if (m[3]) continue;
    found.set(`${m[1]}@${m[2]}`, { name: m[1], ecosystem: 'Go', version: m[2] });
  }
  if (found.size > 0) return [...found.values()];

  // No go.sum: go.mod's `require` blocks are the next best answer, and name
  // ranges rather than resolutions — worth saying if it ever matters.
  let inBlock = false;
  for (const raw of goMod.split('\n')) {
    const line = raw.trim();
    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    const single = line.match(/^require\s+(\S+)\s+(v\S+)/);
    const inside = inBlock ? line.match(/^(\S+)\s+(v\S+)/) : null;
    const m = single ?? inside;
    if (!m?.[1] || !m[2]) continue;
    found.set(`${m[1]}@${m[2]}`, { name: m[1], ecosystem: 'Go', version: m[2] });
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// What an advisory names
// ---------------------------------------------------------------------------

/** The affected symbols this record lists for one module, if it lists any. */
export function symbolTargets(record: OsvRecord, moduleName: string): SymbolTarget[] {
  const targets: SymbolTarget[] = [];
  for (const affected of record.affected ?? []) {
    if (affected.package?.name !== moduleName) continue;
    const specific = (affected as { ecosystem_specific?: unknown }).ecosystem_specific;
    const imports = (specific as { imports?: unknown } | undefined)?.imports;
    if (!Array.isArray(imports)) continue;
    for (const entry of imports) {
      const e = entry as { path?: unknown; symbols?: unknown };
      if (typeof e.path !== 'string' || !Array.isArray(e.symbols)) continue;
      const symbols = e.symbols.filter((sym): sym is string => typeof sym === 'string');
      if (symbols.length > 0) targets.push({ path: e.path, symbols });
    }
  }
  return targets;
}

/** The `GO-xxxx` alias, which is the record that carries the symbols. */
export function goAdvisoryId(aliases: string[] | undefined): string | null {
  return (aliases ?? []).find((a) => a.startsWith('GO-')) ?? null;
}

// ---------------------------------------------------------------------------
// Finding them in source
// ---------------------------------------------------------------------------

/**
 * Import path by the name the file refers to it as.
 *
 * An unaliased import is referred to by its last path element, which is right
 * far more often than not — a package can declare a name that differs from its
 * directory, and resolving that needs the package's own source.
 */
export function goImports(source: string): Map<string, string> {
  const imports = new Map<string, string>();

  const record = (alias: string | undefined, path: string): void => {
    const name = alias && alias !== '_' && alias !== '.' ? alias : (path.split('/').pop() ?? path);
    imports.set(name, path);
  };

  const block = source.match(/import\s*\(([\s\S]*?)\)/);
  if (block?.[1]) {
    for (const raw of block[1].split('\n')) {
      const m = raw.trim().match(/^(?:([\w.]+)\s+)?"([^"]+)"/);
      if (m?.[2]) record(m[1], m[2]);
    }
  }
  for (const m of source.matchAll(/^\s*import\s+(?:([\w.]+)\s+)?"([^"]+)"/gm)) {
    if (m[2]) record(m[1], m[2]);
  }
  return imports;
}

/**
 * Where a file appears to reach one of an advisory's symbols.
 *
 * The import is the precondition: without it there is no path to the symbol,
 * whatever names appear in the file. That makes the negative strong even where
 * the positive is a lead.
 */
export function goSymbolSites(file: string, source: string, target: SymbolTarget): CallSite[] {
  const imports = goImports(source);
  const alias = [...imports.entries()].find(([, path]) => path === target.path)?.[0];
  if (!alias) return [];

  const lines = source.split('\n');
  const sites: CallSite[] = [];

  for (const symbol of target.symbols) {
    const [head, method] = symbol.includes('.') ? symbol.split('.') : [null, symbol];
    // A method: matched by name alone, because knowing the receiver's type needs
    // a Go type checker. A package-level function: matched through the alias,
    // which is exact.
    const pattern = method && head
      ? new RegExp(`\\.${method}\\s*\\(`)
      : new RegExp(`\\b${alias}\\.${method}\\s*\\(`);

    lines.forEach((text, i) => {
      const at = text.search(pattern);
      if (at === -1) return;
      sites.push({
        file,
        line: i + 1,
        column: at + 1,
        text: text.trim().slice(0, 120),
        via: 'import',
      });
    });
  }
  return sites;
}
