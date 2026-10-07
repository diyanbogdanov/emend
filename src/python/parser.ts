/**
 * Parses Python source into a tree-sitter syntax tree, using the WASM build of
 * the grammar rather than the native `tree-sitter-python` binding.
 *
 * Emend's whole pitch is `npx emend-cli` with no API key and no config, cold.
 * The native binding ships prebuilt binaries for the common platform/arch
 * pairs, but falls back to a node-gyp compile the moment a host does not match
 * one — an unusual architecture, musl libc, a Node ABI newer than its last
 * prebuild — and that fallback needs a C toolchain Emend cannot assume a
 * stranger's first `npx` run has. The WASM build has nothing to compile on any
 * host, ever — it is a binary `web-tree-sitter` loads directly — so the first
 * run behaves the same as the hundredth, everywhere.
 *
 * Parsing is not execution. This module turns Python source text into a tree
 * describing its structure; nothing on that path evaluates a single expression
 * from the file it reads. That is the same property `lockfile.ts` states for
 * reading a lockfile instead of running `npm install`: a fact can be read off a
 * file without running what the file describes. It is what makes it safe to
 * point this at a dependency nobody has decided to trust yet.
 *
 * `Parser.init()` and the grammar load both cost a real file read, and neither
 * changes between calls. So the parser is built once, on first use, and reused
 * for every parse after — a second call to `parsePython` must not re-read the
 * grammar from disk, or scanning a package turns one read into one per file.
 */

import { Language, Parser, type Tree } from 'web-tree-sitter';
import { emendPath } from '../paths.ts';

/**
 * Vendored from the official `tree-sitter-python` npm package (0.25.0, MIT,
 * github.com/tree-sitter/tree-sitter-python). Licence text and exact
 * provenance are in THIRD-PARTY-NOTICES.md, not repeated here.
 *
 * Resolved via `emendPath` rather than a relative `../..` count: this module
 * sits two directories below the package root in the source tree
 * (`src/python/parser.ts`) but one below it once bundled (`dist/cli.js`), so a
 * fixed `..` count that is correct in one layout is wrong in the other.
 * `emendPath` finds the root by walking up for `package.json`, which is at the
 * same place — the actual package root — regardless of which layout is
 * running.
 */
const GRAMMAR_PATH = emendPath('assets', 'tree-sitter-python.wasm');

/**
 * The loaded parser, built at most once. `??=` in `parsePython` assigns this
 * promise before its first `await` runs, so calls that arrive while the load
 * is still in flight share it instead of each starting their own.
 */
let parserPromise: Promise<Parser> | undefined;

async function loadParser(): Promise<Parser> {
  await Parser.init();
  const python = await Language.load(GRAMMAR_PATH);
  const parser = new Parser();
  parser.setLanguage(python);
  return parser;
}

/** Parses Python source into a tree-sitter syntax tree. Never runs it. */
export async function parsePython(source: string): Promise<Tree> {
  parserPromise ??= loadParser();
  const tree = (await parserPromise).parse(source);
  // `parse` returns null only when no language is set, which `loadParser`
  // always does before handing the parser back. Unreachable in practice, but
  // thrown explicitly rather than asserted away with `!`, which would just be
  // a different way of hiding the same unproven case.
  if (!tree) throw new Error('web-tree-sitter returned no syntax tree for a Python parse');
  return tree;
}
