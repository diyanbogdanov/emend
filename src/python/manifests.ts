/**
 * Reads resolved dependency versions — and, where nothing is resolved, the
 * declared ranges — from Python's five manifest formats: `uv.lock`,
 * `poetry.lock`, `pdm.lock`, `Pipfile.lock` and `requirements.txt`.
 *
 * Three of these — `uv.lock`, `poetry.lock`, `pdm.lock` — are TOML, and none of
 * them gets a TOML parser. `lockfile.ts`'s argument for npm's lockfiles applies
 * here unchanged: the facts this module wants — package name, resolved version
 * — live in the *keys* of a `[[package]]` table (`name = "requests"`,
 * `version = "2.31.0"`), which are matchable line by line. A real TOML parser
 * would be Emend's first TOML dependency and would buy nothing, since the
 * nested values a real parser would also hand back — file hashes, wheel URLs,
 * marker expressions — are exactly the parts not needed here.
 *
 * That is a claim about the shape of these files, and reasoning from shape
 * rather than from real files is exactly the mistake this module was written
 * to avoid — a fixture built to satisfy a regex proves nothing about the
 * format in circulation. So the claim was checked against real, current
 * lockfiles committed by uv, Poetry and PDM's own repositories before this
 * parser was written (see `test/fixtures/python/`, and the provenance of each
 * file recorded in `test/pythonmanifests.test.ts`), not assumed from the
 * format's documentation.
 *
 * `Pipfile.lock` is JSON, read with `JSON.parse` directly — there is no
 * shallow-parsing argument to make there; `JSON.parse` already is the real
 * parser for that format. `requirements.txt` is neither TOML nor JSON; it is
 * read a line at a time against the shape PEP 508 describes.
 *
 * Being deliberately shallow has a cost worth stating, the same one
 * `lockfile.ts` states for npm: these parsers understand the shapes in
 * circulation today and will not silently adapt to a lockfile shape none of
 * uv, Poetry, PDM or Pipenv actually write. An unrecognised file yields no
 * versions, which the caller (`../ecosystems.ts`) reports as degraded via
 * `unsupported` rather than treating as an empty dependency set.
 */

export type PythonManifestKind =
  | 'uv.lock'
  | 'poetry.lock'
  | 'pdm.lock'
  | 'Pipfile.lock'
  | 'requirements.txt';

export interface PythonManifest {
  kind: PythonManifestKind;
  /**
   * Package name -> exact resolved version. Populated by the four lockfiles,
   * which record what a resolver actually produced, and by any
   * `requirements.txt` entry pinned to one concrete version with `==` or
   * `===` — a fact the manifest states outright, not a lockfile's
   * resolution, but not a guess either. See `declared` below: a single
   * `requirements.txt` can populate both maps at once, so there is no
   * whole-file "is this manifest resolved" flag any more — check each map.
   */
  versions: Map<string, string>;
  /**
   * Package name -> the range/specifier text as written, e.g. `">=2.31.0"`.
   * Always empty for the four lockfiles — a lockfile does not carry the range
   * that produced its resolution, that lives in `pyproject.toml`, which this
   * module does not parse.
   *
   * For `requirements.txt`, holds every entry that is *not* a concrete
   * `==`/`===` pin: a real range (`>=2.31.0`, `~=2.0`), a wildcard pin
   * (`==2.31.*`, which names a family of versions rather than one), or an
   * entry with no specifier at all. Each line routes independently, so one
   * file can have some names here and others in `versions` — callers must
   * check both rather than assuming a whole file is one or the other.
   */
  declared: Map<string, string>;
  /**
   * This manifest's own kind, when its content had text but none of it could
   * be read as the format `kind` names — an unrecognised lockfile shape, or
   * (for `Pipfile.lock`) JSON that does not parse or has no `default`/
   * `develop` object. `null` when the file was empty (nothing to misread) or
   * when at least one dependency was recovered.
   */
  unsupported: PythonManifestKind | null;
}

/**
 * Resolved versions from the TOML shape `uv.lock`, `poetry.lock` and
 * `pdm.lock` all share: a sequence of `[[package]]` array-of-tables entries,
 * each opening with a bare `name = "x"` key immediately followed by a bare
 * `version = "y"` key.
 *
 * Scoped to genuine `[[package]]` blocks — `inPackageBlock` is true only
 * between a `[[package]]` header and the next table header of any kind — not
 * merely "the last name seen since some header". A weaker rule (clear the
 * pending name on any header, but still accept `name =` / `version =`
 * anywhere) does not actually stop a subtable from being misread: Poetry and
 * PDM write per-package subtables such as `[package.dependencies]` for their
 * real dependency lists, and if one of those ever wrote its own bare
 * `name = "x"` / `version = "y"` pair, a "clear on header" rule would still
 * read that pair as a package, because both lines legitimately match once the
 * clear has already happened. None of the four real fixtures this was checked
 * against does that (see `test/pythonmanifests.test.ts`'s synthetic test for
 * a constructed case that does). Requiring the *current* table to be
 * `[[package]]` rules the whole shape out regardless of what a subtable
 * writes, which is what "track the current `[[package]]` block" means here.
 *
 * The regexes are anchored to the whole trimmed line on purpose. uv.lock's own
 * dependency lists are inline tables — `dependencies = [ { name = "certifi" },
 * ... ]` — and a trimmed line from inside one reads `{ name = "certifi" },`,
 * which does not start with `name` and so never matches. An unanchored
 * `.includes('name = "')` check would match it; anchoring is what makes the
 * `inPackageBlock` guard above unnecessary for every real fixture checked, and
 * it is kept anyway as the second line of defence the comment above explains.
 */
function parsePackageBlocks(text: string): Map<string, string> {
  const versions = new Map<string, string>();
  let inPackageBlock = false;
  let pendingName: string | undefined;

  for (const raw of text.split('\n')) {
    const line = raw.trim();

    if (line.startsWith('[')) {
      inPackageBlock = line === '[[package]]';
      pendingName = undefined;
      continue;
    }
    if (!inPackageBlock) continue;

    const nameMatch = /^name = "([^"]*)"$/.exec(line);
    // The capture group is mandatory in the pattern, so a match always
    // captures it; this check exists only because `noUncheckedIndexedAccess`
    // cannot see that from the regex. Not a real "no name" path, so not
    // separately tested — here instead of a `!` so a future edit that breaks
    // that guarantee fails safe (skips the line) rather than crashing.
    if (nameMatch && nameMatch[1] !== undefined) {
      pendingName = nameMatch[1];
      continue;
    }

    const versionMatch = /^version = "([^"]*)"$/.exec(line);
    if (versionMatch && versionMatch[1] !== undefined && pendingName !== undefined) {
      // First occurrence wins, matching `lockfile.ts`'s pnpm/yarn parsers: a
      // package can legitimately resolve to two versions under different
      // Python-version markers (uv and PDM both support this), and there is
      // no single correct answer to "which one" without reading the marker —
      // which is exactly the kind of nested detail this module does not read.
      if (!versions.has(pendingName)) versions.set(pendingName, versionMatch[1]);
      pendingName = undefined;
    }
  }

  return versions;
}

function readTomlLockfile(
  kind: 'uv.lock' | 'poetry.lock' | 'pdm.lock',
  text: string,
): PythonManifest {
  const versions = parsePackageBlocks(text);
  // Same rule `lockfile.ts` applies to pnpm/yarn: content that yielded nothing
  // is reported as unsupported, not as a dependency-free repository. This
  // cannot tell "wrong format" apart from "a real, genuinely dependency-free
  // lockfile of this kind" — neither can `lockfile.ts`'s parsers, for the same
  // reason: a line-matcher has no notion of "syntactically valid but empty",
  // only "found something" or "found nothing".
  const unsupported = versions.size === 0 && text.trim() !== '' ? kind : null;
  return { kind, versions, declared: new Map(), unsupported };
}

interface PipfileLockEntry {
  version?: string;
}
interface PipfileLockDoc {
  default?: Record<string, PipfileLockEntry>;
  develop?: Record<string, PipfileLockEntry>;
}

/**
 * `Pipfile.lock` — plain JSON, read with `JSON.parse` rather than matched line
 * by line, since JSON is not the format this module exists to avoid taking a
 * dependency on: `JSON.parse` is built in and already is the real parser.
 *
 * `default` before `develop` when a name appears in both (unusual, but not
 * forbidden): the runtime dependency is the more consequential fact to keep.
 */
function readPipfileLock(text: string): PythonManifest {
  const empty: PythonManifest = {
    kind: 'Pipfile.lock',
    versions: new Map(),
    declared: new Map(),
    unsupported: null,
  };
  if (text.trim() === '') return empty;

  let doc: PipfileLockDoc;
  try {
    doc = JSON.parse(text) as PipfileLockDoc;
  } catch {
    return { ...empty, unsupported: 'Pipfile.lock' };
  }

  const versions = new Map<string, string>();
  for (const group of [doc.default, doc.develop]) {
    for (const [name, entry] of Object.entries(group ?? {})) {
      // Pipfile.lock pins every resolved entry as `"==2.31.0"` — the operator
      // is guaranteed by the format, not merely likely, so a version that does
      // not start with it is something this reader does not understand (a VCS
      // ref, a local path) rather than a version to report.
      if (!entry?.version?.startsWith('==')) continue;
      if (versions.has(name)) continue;
      versions.set(name, entry.version.slice(2));
    }
  }

  if (versions.size === 0) return { ...empty, unsupported: 'Pipfile.lock' };
  return { ...empty, versions };
}

/**
 * One `requirements.txt` line, once comments are stripped and it is known to
 * be neither blank nor an option/editable/include line: `name[extras]
 * specifier ; marker`. Greedy on the name-character class, which is exactly
 * how `requests>=2.31.0` (no space before the operator, and a real line from
 * the fixture used in `test/pythonmanifests.test.ts`) still separates cleanly
 * — `>` is not a name character, so the name group stops there on its own.
 *
 * Not a full PEP 508 parser: the specifier is kept as whatever text follows
 * the name/extras, not validated against PEP 440's grammar, and a marker is
 * discarded rather than evaluated — Emend is reading what versions a
 * repository asked for, not choosing an interpreter to run it under.
 */
const REQUIREMENT_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/;

/** What one `requirements.txt` sorts its entries into — see `parseRequirementsTxt`. */
interface ParsedRequirements {
  versions: Map<string, string>;
  declared: Map<string, string>;
}

/**
 * Whether `specifier` — the text after a name/extras on one requirements.txt
 * line, e.g. `"==2.31.0"` or `">=2.0"` — names one concrete, non-wildcard
 * version: the only shape safe to promote from a range to a resolution.
 *
 * Both PEP 440 equality operators count: `==` (version matching) and `===`
 * (arbitrary equality). `==` additionally allows a trailing `.*` for prefix
 * matching (`==2.31.*`), which is a range wearing pin syntax — excluded by
 * checking for a literal `*` rather than by validating "digits and dots
 * only", which would also reject legitimate pre/post/dev segments like
 * `2.31.0rc1`. A comma joins multiple specifiers (`==2.31.0,!=2.31.1`); more
 * than one constraint is a range's shape even when one arm is exact, so that
 * is excluded too rather than guessing which arm should win.
 */
function resolvedVersion(specifier: string): string | null {
  const match = /^(===|==)\s*(.+)$/.exec(specifier.trim());
  const version = match?.[2]?.trim();
  if (!version) return null;
  if (version.includes('*') || version.includes(',')) return null;
  return version;
}

/**
 * Sorts every `requirements.txt` entry into a resolution or a range, per
 * line — the two are no longer whole-file properties. `requests==2.31.0` is
 * as much a fact as a lockfile entry; `urllib3>=2.0` on the very next line is
 * a guess waiting to happen, and one real file can contain both.
 */
function parseRequirementsTxt(text: string): ParsedRequirements {
  const versions = new Map<string, string>();
  const declared = new Map<string, string>();

  for (const raw of text.split('\n')) {
    // Stripping an inline comment first handles a full-line comment
    // (`# pinned for CI` becomes `''`) and a trailing one (`jinja2>=3.1.0  #
    // why` becomes `jinja2>=3.1.0`) with the same rule: '#' cannot appear in a
    // real name, specifier or marker, so everything from the first one is
    // always safe to drop.
    const line = (raw.split('#')[0] ?? '').trim();
    if (line === '') continue;

    // `-e .`, `-e .[extra]` (editable installs), `-r other.txt` / `-c
    // constraints.txt` (includes) and option flags like `--index-url` all
    // start with `-`. None names an installable package; treating `-e` as one
    // would put a nonsense entry into a vulnerability query.
    if (line.startsWith('-')) continue;

    const beforeMarker = (line.split(';')[0] ?? '').trim();
    if (beforeMarker === '') continue;

    const match = REQUIREMENT_RE.exec(beforeMarker);
    if (!match) continue;
    const [, name, rest] = match;
    if (!name) continue;
    // First occurrence wins, across both maps: a name already recorded (as
    // either a resolution or a range) is not reconsidered by a later,
    // possibly-conflicting line.
    if (versions.has(name) || declared.has(name)) continue;

    const specifier = (rest ?? '').trim();
    const pinned = resolvedVersion(specifier);
    if (pinned !== null) {
      versions.set(name, pinned);
    } else {
      declared.set(name, specifier);
    }
  }

  return { versions, declared };
}

/**
 * Read one Python manifest.
 *
 * `kind` is supplied by the caller rather than sniffed from content or file
 * extension: `ecosystems.ts` already knows which file it opened, so guessing
 * again here would be a second, possibly-disagreeing opinion about the same
 * fact. See the module doc for what "deliberately shallow" costs.
 */
export function readPythonManifest(kind: PythonManifestKind, text: string): PythonManifest {
  switch (kind) {
    case 'uv.lock':
    case 'poetry.lock':
    case 'pdm.lock':
      return readTomlLockfile(kind, text);
    case 'Pipfile.lock':
      return readPipfileLock(text);
    case 'requirements.txt': {
      const { versions, declared } = parseRequirementsTxt(text);
      return {
        kind,
        versions,
        declared,
        // A requirements.txt line is independently a comment, an option, a
        // requirement, or noise — there is no single whole-file shape to call
        // unsupported the way a TOML block or a JSON document has. A line
        // that does not parse is simply skipped, the same as a blank one.
        unsupported: null,
      };
    }
  }
}
