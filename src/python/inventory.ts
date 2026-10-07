/**
 * The PyPI ecosystem inventory: what a Python repository declares and has
 * installed, read from whichever of `uv.lock`, `poetry.lock`, `pdm.lock`,
 * `Pipfile.lock` or `requirements.txt` the repository actually has.
 *
 * Tried in that order — resolution-quality order, per `MANIFEST_ORDER`'s own
 * doc — because the four lockfiles record an install a resolver actually
 * produced, while `requirements.txt` records only what was asked for. Where a
 * lockfile exists it answers alone; `requirements.txt` is never consulted
 * alongside one, because mixing a resolution for one package with a range for
 * another would report one installed version carrying the other's provenance.
 *
 * `applies()` also treats a bare `pyproject.toml` as claiming the repository —
 * a real Python project with no lockfile committed yet is still a Python
 * project worth naming as one — but `declared()` has nothing to read from
 * `pyproject.toml` alone: its `[project.dependencies]` is not one of the five
 * formats `../python/manifests.ts` parses (see that module's doc for why), so
 * that case reports zero dependencies with a warning rather than guessing at
 * ranges nobody read.
 *
 * Registered in `../ecosystems.ts`'s `INVENTORIES`, which is what makes a
 * Python repository screened at all — see that module's doc for the bug this
 * exists to stop from recurring.
 */

import { readFile, access, realpath } from 'node:fs/promises';
import { OutsideRepositoryError, readRepoFile, within } from '../repofiles.ts';
import path from 'node:path';
import {
  readPythonManifest,
  requirementName,
  type PythonManifest,
  type PythonManifestKind,
} from './manifests.ts';
import type { EcosystemInventory } from '../ecosystems.ts';
import type { CallSite, InstalledDependency, RepoInfo } from '../types.ts';
import type { InstalledPackage } from '../osv.ts';

/**
 * Resolution-quality order: a true lockfile before the one format that is
 * only ever a range. Among the four lockfiles themselves there is no ranking
 * to make — a repository migrating between tools might have more than one on
 * disk, but a repository using exactly one Python package manager, which is
 * the ordinary case, has at most one of these four to begin with. Newest and
 * most actively developed first (uv), oldest last (Pipenv), purely as a
 * tie-break for the migrating-repository case, not a claim that uv's
 * resolution is more trustworthy than Poetry's.
 */
const MANIFEST_ORDER: PythonManifestKind[] = [
  'uv.lock',
  'poetry.lock',
  'pdm.lock',
  'Pipfile.lock',
  'requirements.txt',
];

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

interface BestManifest {
  kind: PythonManifestKind;
  /** Kept alongside the parsed result so `manifestSites` need not re-read the file. */
  text: string;
  manifest: PythonManifest;
  /** Each `-r`/`-c` include that could not be followed, and why — every one a
   *  reason the dependency list is partial. Always empty for the lockfiles. */
  unfollowed: string[];
  /** The requirements files read, repository-relative, top one first — where a
   *  package is required, for citing it. Empty for the lockfiles. */
  files: { path: string; text: string }[];
}

/** PEP 503's normalised name, so `Requests` in one file and `requests` in another are one package. */
const canonical = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');

/**
 * `requirements.txt` with its `-r` and `-c` includes followed the way pip
 * follows them: each relative to the file that names it, a requirements
 * include adding its packages, a constraints include only deciding the version
 * of a package something else requires. First occurrence wins across files, as
 * it does within one.
 *
 * The paths come from the repository, and the hosted App scans repositories it
 * has no reason to trust, so a target is judged by its real path: one outside
 * the checkout — `../x`, or a committed symlink to anywhere — is not read,
 * because whatever file it named would be parsed as requirements and its lines
 * printed back as dependency names. A URL is not fetched. Neither is dropped in
 * silence: each lands in `unfollowed`.
 */
async function readRequirementsTree(
  repoDir: string,
  text: string,
): Promise<{ manifest: PythonManifest; unfollowed: string[]; files: BestManifest['files'] }> {
  const root = await realpath(repoDir);
  const top = await realpath(path.join(repoDir, 'requirements.txt'));
  const visited = new Set<string>([top]);
  const seen = new Set<string>();
  const versions = new Map<string, string>();
  const declared = new Map<string, string>();
  const constraints = new Map<string, string>();
  const unfollowed: string[] = [];
  const files: BestManifest['files'] = [];

  const visit = async (file: string, body: string, asConstraints: boolean): Promise<void> => {
    const parsed = readPythonManifest('requirements.txt', body);
    if (!asConstraints) files.push({ path: path.relative(root, file).split(path.sep).join('/'), text: body });
    if (asConstraints) {
      for (const [name, version] of parsed.versions) {
        if (!constraints.has(canonical(name))) constraints.set(canonical(name), version);
      }
    } else {
      for (const [into, from] of [[versions, parsed.versions], [declared, parsed.declared]] as const) {
        for (const [name, value] of from) {
          if (seen.has(canonical(name))) continue;
          seen.add(canonical(name));
          into.set(name, value);
        }
      }
    }

    const named = path.relative(root, file);
    for (const include of parsed.includes ?? []) {
      const unread = (why: string) => unfollowed.push(`${named} includes ${include.target}, ${why}`);
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(include.target)) {
        unread('a URL Emend does not fetch — its packages were not read');
        continue;
      }
      let real: string;
      try {
        real = await realpath(path.resolve(path.dirname(file), include.target));
      } catch {
        unread('which does not exist — its packages were not read');
        continue;
      }
      if (!within(root, real) || real === root) {
        unread('which is outside the repository — not read');
        continue;
      }
      if (visited.has(real)) continue;
      visited.add(real);
      let next: string;
      try {
        next = await readFile(real, 'utf8');
      } catch {
        unread('which could not be read — its packages were not read');
        continue;
      }
      await visit(real, next, asConstraints || include.kind === 'constraints');
    }
  };
  await visit(top, text, false);

  for (const [name] of declared) {
    const pinned = constraints.get(canonical(name));
    if (pinned === undefined) continue;
    declared.delete(name);
    versions.set(name, pinned);
  }

  return {
    manifest: { kind: 'requirements.txt', versions, declared, unsupported: null },
    unfollowed,
    files,
  };
}

/**
 * The highest-resolution-quality manifest this repository actually has, read
 * once.
 *
 * Existence decides which manifest is "best", not content quality — the first
 * candidate in `MANIFEST_ORDER` that is present on disk is read and returned,
 * even if its content turns out to be unreadable (`manifest.unsupported` says
 * so); the next candidate is tried only when the file itself is absent. This
 * mirrors `../lockfile.ts`'s `readLockfile`, which does the same for npm: a
 * `package-lock.json` that fails to parse is reported as such, never silently
 * skipped in favour of a `pnpm-lock.yaml` that happens to parse.
 */
async function readBestManifest(repoDir: string): Promise<BestManifest | null> {
  for (const kind of MANIFEST_ORDER) {
    let text: string;
    try {
      text = await readRepoFile(repoDir, kind);
    } catch (err) {
      // Present but a link out of the repository: reported as a manifest that
      // could not be read, never as the absence of one — the next candidate
      // standing in for it would be a different file's answer.
      if (err instanceof OutsideRepositoryError) {
        return {
          kind,
          text: '',
          manifest: { kind, versions: new Map(), declared: new Map(), unsupported: kind },
          unfollowed: [err.message],
          // Nothing was read, so there is no requirement line to cite.
          files: [],
        };
      }
      continue;
    }
    if (kind === 'requirements.txt') return { kind, text, ...(await readRequirementsTree(repoDir, text)) };
    return { kind, text, manifest: readPythonManifest(kind, text), unfollowed: [], files: [] };
  }
  return null;
}

/**
 * The line in a lockfile's `raw` text that names `name`, so a finding can
 * point at it. `requirements.txt` is not a lockfile and is cited by
 * `requirementsSite` instead: given this needle, it never matched, and every
 * requirements finding cited line 1.
 *
 * `Pipfile.lock` is JSON, so its packages are named by an object key
 * (`"requests": {`); the three TOML lockfiles name them as
 * `name = "requests"`. Both needles are quoted so a shorter
 * package name cannot match inside a longer one's line (`requests` inside
 * `requests-toolbelt`) — the same reasoning `../ecosystems.ts`'s `lockfileSite`
 * gives for quoting an npm install path.
 *
 * `via: 'import'` is the same stretch `lockfileSite` makes: `CallSite.via` is
 * only `'import' | 'type'`, neither of which a manifest reference really is,
 * but widening that union changes what every renderer prints, which this is
 * not the place to do.
 */
function pythonManifestSite(kind: PythonManifestKind, raw: string, name: string): CallSite {
  const needle = kind === 'Pipfile.lock' ? `"${name}": {` : `name = "${name}"`;
  const lines = raw.split('\n');
  const index = lines.findIndex((l) => l.includes(needle));
  return {
    file: kind,
    line: index === -1 ? 1 : index + 1,
    column: 1,
    text: name,
    via: 'import',
  };
}

/**
 * Where `name` is required: the first line, across the requirements files in
 * the order they were read, whose requirement is `name` under PEP 503 — the
 * `Idna` a file writes is the `idna` an advisory names. Line 1 of
 * requirements.txt when none names it, as before.
 */
function requirementsSite(files: BestManifest['files'], name: string): CallSite {
  for (const file of files) {
    const index = file.text.split('\n').findIndex((line) => {
      const required = requirementName(line);
      return required !== null && canonical(required) === canonical(name);
    });
    if (index !== -1) return { file: file.path, line: index + 1, column: 1, text: name, via: 'import' };
  }
  return { file: 'requirements.txt', line: 1, column: 1, text: name, via: 'import' };
}

export function pythonInventory(): EcosystemInventory {
  return {
    id: 'python',
    osvEcosystem: 'PyPI',
    manifests: [...MANIFEST_ORDER, 'pyproject.toml'],

    async applies(repoDir) {
      for (const kind of MANIFEST_ORDER) {
        if (await exists(path.join(repoDir, kind))) return true;
      }
      // No lockfile and no requirements.txt is still a Python repository if
      // pyproject.toml says so — just one `declared()` cannot read dependency
      // ranges from (see the module doc).
      return exists(path.join(repoDir, 'pyproject.toml'));
    },

    async read(repoDir) {
      const best = await readBestManifest(repoDir);
      if (!best) {
        // Only pyproject.toml is present — the same case declared() already
        // warns about (see that branch below), and for the same reason: this
        // adapter never parses pyproject.toml's own `[project.dependencies]`
        // (module doc), so it cannot tell a repository that genuinely declares
        // nothing from one whose real dependencies simply have no lockfile
        // yet. Unlike npm's read(), there is no cheaper manifest to re-check
        // here — warning unconditionally is the only honest option available.
        return {
          packages: [],
          unsupported: null,
          incomplete:
            'found pyproject.toml but none of uv.lock, poetry.lock, pdm.lock, Pipfile.lock or ' +
            'requirements.txt — commit one so installed versions can be resolved and screened ' +
            'for vulnerabilities',
        };
      }

      // Every entry in `versions`, not just direct dependencies — uv.lock,
      // poetry.lock, pdm.lock and Pipfile.lock all record the whole resolved
      // tree there, so this needs no separate transitive walk the way a
      // manifest-only format would. A `requirements.txt` contributes only the
      // subset of `versions` its own `==`/`===` pins produced (see
      // `manifests.ts`); a range never lands in `versions` at all, so
      // screening it as if it were an installed version — asking OSV about a
      // version nobody confirmed is actually on disk, the exact fabrication
      // `InstalledDependency.source`'s `'range'` case exists to flag on the
      // `declared()` side — cannot happen here either. `read()` has no such
      // provenance field to flag a range with, so a range's honest answer
      // here is to be absent rather than guessed.
      const packages: InstalledPackage[] = [];
      for (const [name, version] of best.manifest.versions) {
        packages.push({ name, ecosystem: 'PyPI', version });
      }
      return {
        packages,
        unsupported: best.manifest.unsupported,
        // A manifest refused outright is already `unsupported`, and declared()
        // gives the reason; repeating it here printed it twice in one scan.
        incomplete:
          best.unfollowed.length > 0 && !best.manifest.unsupported ? best.unfollowed.join('; ') : null,
      };
    },

    async declared(repoDir) {
      const warnings: string[] = [];
      const best = await readBestManifest(repoDir);

      if (!best) {
        warnings.push(
          'found pyproject.toml but none of uv.lock, poetry.lock, pdm.lock, ' +
            'Pipfile.lock or requirements.txt — dependencies could not be read',
        );
        return {
          dir: repoDir,
          name: path.basename(repoDir),
          dependencies: [],
          scripts: {},
          warnings,
          workspaces: [''],
        };
      }

      const dependencies: InstalledDependency[] = [];

      // Every entry in `versions` is a resolution and every entry in
      // `declared` is a range — true within a single manifest regardless of
      // kind (see `PythonManifest`'s own doc) — so both maps are read
      // unconditionally rather than picking one based on `best.kind`. That
      // used to be a whole-file choice (`best.manifest.resolved`), which is
      // exactly what could not survive a `requirements.txt` that pins some
      // dependencies and ranges others: a single boolean cannot say "some of
      // both".
      //
      // `source` for a resolution still depends on `best.kind`: the four real
      // lockfiles are a resolver's output, `requirements.txt` is not — see
      // `InstalledDependency.source`'s own doc for why `pinned` is a
      // different claim from `lockfile`.
      const resolvedSource: InstalledDependency['source'] =
        best.kind === 'requirements.txt' ? 'pinned' : 'lockfile';

      for (const [name, version] of best.manifest.versions) {
        dependencies.push({
          name,
          ecosystem: 'PyPI',
          // Neither a lockfile nor a `==` pin carries the range that produced
          // it — a lockfile's range lives in pyproject.toml, which this
          // adapter does not parse (see the module doc), and a pin has no
          // separate range at all — so the resolved version is the truest
          // string available for `declared` either way.
          declared: version,
          // Simplification: uv.lock and poetry.lock do record which group
          // (dev, test, …) a package belongs to; this reads neither. Every
          // dependency is reported as a runtime one, which over-reports
          // rather than under-reports — a dev dependency screened for
          // vulnerabilities unnecessarily is the safe direction to be
          // wrong in, unlike the reverse.
          dev: false,
          installed: version,
          source: resolvedSource,
          declaredIn: [''],
        });
      }

      for (const [name, range] of best.manifest.declared) {
        dependencies.push({
          name,
          ecosystem: 'PyPI',
          declared: range,
          dev: false,
          // A range "may name a version that was never published —
          // callers must not present it as a fact read from the
          // repository" (`InstalledDependency.source`'s own doc), so
          // `installed` stays null rather than guessing.
          installed: null,
          source: 'range',
          declaredIn: [''],
        });
      }

      // Fires only when this manifest actually left something unresolved —
      // never for the four lockfiles, whose `declared` is always empty, and
      // not for a `requirements.txt` that turned out to be nothing but exact
      // pins. `declared.size` is the honest gate: a whole-file `resolved`
      // flag could only say "ranges" or "not", never "some".
      if (best.manifest.declared.size > 0) {
        warnings.push(
          `${best.kind} declares ranges, not resolved versions — installed versions ` +
            'could not be confirmed and are not guessed',
        );
      }

      warnings.push(...best.unfollowed);

      if (best.manifest.unsupported) {
        warnings.push(
          `found ${best.kind}, which Emend could not read — no dependencies were recovered from it`,
        );
      }

      return {
        dir: repoDir,
        name: path.basename(repoDir),
        dependencies,
        // npm-shaped and read by nothing: no detector or renderer consults a
        // Python repository's scripts today. Left empty rather than invented
        // — pyproject.toml's `[project.scripts]` and tox/nox sessions are not
        // this field's shape, and nothing here reads them.
        scripts: {},
        warnings,
        workspaces: [''],
      };
    },

    async manifestSites(repoDir, packages) {
      const best = await readBestManifest(repoDir);
      if (!best) return new Map();

      const sites = new Map<string, CallSite>();
      for (const pkg of packages) {
        sites.set(
          `${pkg.name}@${pkg.version}`,
          best.kind === 'requirements.txt'
            ? requirementsSite(best.files, pkg.name)
            : pythonManifestSite(best.kind, best.text, pkg.name),
        );
      }
      return sites;
    },
  };
}
