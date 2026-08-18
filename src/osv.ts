/**
 * Asking OSV which of this repository's installed packages are vulnerable.
 *
 * OSV answers the question a dependency tree actually poses — *is this package
 * at this version vulnerable?* — rather than NVD's, which is answered by
 * matching CPE strings and is a swamp. It needs no key and imposes no rate
 * limit.
 *
 * Two properties shape everything here.
 *
 * **It is ecosystem-keyed.** `npm`, `PyPI`, `Go`, `Maven`, `crates.io`. Nothing
 * in this file may assume npm: adding a language costs an inventory reader —
 * what is installed, at what version — and not a second pipeline. That makes
 * this the cheapest route Emend has to a second ecosystem.
 *
 * **Screening and detail are different calls.** `querybatch` answers a whole
 * tree in one request and returns only ids; the full record comes from
 * `/v1/vulns/{id}`. Measured: three packages in half a second. Fetching detail
 * per package instead would cost one request per dependency.
 */

import { schemeFor, type VersionScheme } from './versions.ts';
import type { Fetcher } from './specfetch.ts';

const API = 'https://api.osv.dev/v1';

/** A package as the repository has it installed. */
export interface InstalledPackage {
  name: string;
  /** OSV's ecosystem identifier: `npm`, `PyPI`, `Go`, `Maven`, … */
  ecosystem: string;
  version: string;
}

// ---------------------------------------------------------------------------
// The wire shape, as measured
// ---------------------------------------------------------------------------

export interface OsvEvent {
  introduced?: string;
  fixed?: string;
  /** How OSV records "still unpatched": affected up to here, no fix published. */
  last_affected?: string;
  limit?: string;
}

export interface OsvRange {
  type?: string;
  events?: OsvEvent[];
}

export interface OsvAffected {
  package?: { name?: string; ecosystem?: string };
  ranges?: OsvRange[];
}

export interface OsvRecord {
  id: string;
  aliases?: string[];
  summary?: string;
  severity?: Array<{ type?: string; score?: string }>;
  affected?: OsvAffected[];
}

export interface Vulnerability {
  /** OSV's own id, usually a GHSA. */
  id: string;
  /** Every id this advisory is known by, so a better record can be found. */
  aliases: string[];
  /** The CVE, when the advisory has one. What people search by. */
  cve: string | null;
  summary: string;
  /**
   * The lowest version that fixes this for the installed version, or null when
   * no fix has been published.
   *
   * Null is a real answer. An unfixable vulnerability is worth reporting, and a
   * guessed version is worse than none.
   */
  fixedIn: string | null;
  /**
   * The CVSS vector, not a score.
   *
   * Measured: OSV gives `CVSS:3.1/AV:N/…`. Storing it as a number would mean
   * inventing one — the numeric score, and EPSS with it, comes from GitHub
   * Advisory.
   */
  cvssVector: string | null;
}

export interface VulnerablePackage extends InstalledPackage {
  vulnerabilities: Vulnerability[];
}

// ---------------------------------------------------------------------------
// Reading a record
// ---------------------------------------------------------------------------

/**
 * Range types that name installable versions.
 *
 * `GIT` ranges exist too, and their `fixed` is a commit hash. Found live: the
 * target for `requests@2.19.0` came back as
 * `74ea7cf7a6a27a4eeb2ae24e162bcc942a6706d5`, because a hash compared as a
 * version and won the maximum. Proposing that as an upgrade is not a smaller
 * mistake than proposing nothing.
 */
const INSTALLABLE_RANGE = new Set(['SEMVER', 'ECOSYSTEM']);

/** `0` is OSV's "from the beginning", which sorts below every real version. */
function atLeast(version: string, floor: string, scheme: VersionScheme): boolean {
  if (floor === '0') return true;
  return scheme.compare(version, floor) >= 0;
}

/**
 * The version that fixes this advisory for one package at one version.
 *
 * The `affected` array is filtered by package *and* ecosystem, not indexed. One
 * advisory routinely covers several packages with different fixed versions —
 * `lodash`, `lodash-es`, `lodash.trimend` all appear under GHSA-29mw-wpgm-hmr9 —
 * so reading the first entry proposes an upgrade that fixes nothing and may name
 * a version this package never published. Names also repeat across ecosystems:
 * `requests` is a PyPI package and a Go module.
 *
 * Events are ordered and describe alternating windows: introduced, fixed,
 * introduced again, fixed again. The answer is the `fixed` closing whichever
 * window the installed version sits in — and null when it sits between windows,
 * because then it is not affected at all.
 */
export function fixedVersionFor(
  record: OsvRecord,
  name: string,
  ecosystem: string,
  installed: string,
): string | null {
  for (const affected of record.affected ?? []) {
    if (affected.package?.name !== name) continue;
    if (affected.package?.ecosystem !== ecosystem) continue;

    for (const range of affected.ranges ?? []) {
      if (!INSTALLABLE_RANGE.has(range.type ?? '')) continue;
      let openedAt: string | null = null;
      for (const event of range.events ?? []) {
        if (event.introduced !== undefined) {
          openedAt = atLeast(installed, event.introduced, schemeFor(ecosystem)) ? event.introduced : null;
          continue;
        }
        // A window only matters if the installed version opened it.
        if (openedAt === null) continue;

        if (event.fixed !== undefined) {
          // Inside the window: the fix closes it. Past it: not affected here.
          if (schemeFor(ecosystem).compare(installed, event.fixed) < 0) return event.fixed;
          openedAt = null;
          continue;
        }
        if (event.last_affected !== undefined) {
          // Affected with no published fix, which is a real answer.
          if (schemeFor(ecosystem).compare(installed, event.last_affected) <= 0) return null;
          openedAt = null;
        }
      }
    }
  }
  return null;
}

/** Whether this advisory covers the installed version at all. */
function covers(record: OsvRecord, name: string, ecosystem: string, installed: string): boolean {
  for (const affected of record.affected ?? []) {
    if (affected.package?.name !== name) continue;
    if (affected.package?.ecosystem !== ecosystem) continue;

    for (const range of affected.ranges ?? []) {
      if (!INSTALLABLE_RANGE.has(range.type ?? '')) continue;
      let open = false;
      for (const event of range.events ?? []) {
        if (event.introduced !== undefined) open = atLeast(installed, event.introduced, schemeFor(ecosystem));
        else if (event.fixed !== undefined && open) {
          if (schemeFor(ecosystem).compare(installed, event.fixed) < 0) return true;
          open = false;
        } else if (event.last_affected !== undefined && open) {
          if (schemeFor(ecosystem).compare(installed, event.last_affected) <= 0) return true;
          open = false;
        }
      }
      // A window that never closed is still open at the installed version.
      if (open) return true;
    }
  }
  return false;
}

export function readVulnerability(
  record: OsvRecord,
  name: string,
  ecosystem: string,
  installed: string,
): Vulnerability {
  const cve = (record.aliases ?? []).find((a) => a.startsWith('CVE-')) ?? null;
  const cvss = (record.severity ?? []).find((s) => typeof s.score === 'string');
  return {
    id: record.id,
    aliases: record.aliases ?? [],
    cve,
    summary: record.summary ?? '',
    fixedIn: fixedVersionFor(record, name, ecosystem, installed),
    cvssVector: cvss?.score ?? null,
  };
}

// ---------------------------------------------------------------------------
// Scanning a tree
// ---------------------------------------------------------------------------

async function postJson(fetch: Fetcher, url: string, body: unknown): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

async function getJson(fetch: Fetcher, url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

/** OSV caps a batch; a large tree is screened in several. */
const BATCH_SIZE = 500;

/**
 * Every vulnerable package in a tree, with what fixes each.
 *
 * A failed screening returns nothing, and the caller must render that as *could
 * not check* rather than *checked and clean*. This function cannot tell the
 * difference for the caller — it can only avoid pretending the second happened.
 */
export async function scanPackages(
  fetch: Fetcher,
  packages: InstalledPackage[],
): Promise<VulnerablePackage[]> {
  if (packages.length === 0) return [];

  // 1. Screen. One request per five hundred packages, ids only.
  const idsByPackage = new Map<number, string[]>();
  for (let offset = 0; offset < packages.length; offset += BATCH_SIZE) {
    const slice = packages.slice(offset, offset + BATCH_SIZE);
    const answer = (await postJson(fetch, `${API}/querybatch`, {
      queries: slice.map((p) => ({
        package: { name: p.name, ecosystem: p.ecosystem },
        version: p.version,
      })),
    })) as { results?: Array<{ vulns?: Array<{ id?: unknown }> }> } | null;
    if (!answer?.results) continue;

    answer.results.forEach((result, i) => {
      const ids = (result?.vulns ?? [])
        .map((v) => v.id)
        .filter((id): id is string => typeof id === 'string');
      if (ids.length > 0) idsByPackage.set(offset + i, ids);
    });
  }
  if (idsByPackage.size === 0) return [];

  // 2. Fetch each distinct advisory once. One record routinely covers several
  //    packages in the same tree — `lodash` and `lodash-es` — and trees are full
  //    of them.
  const records = new Map<string, OsvRecord>();
  for (const ids of idsByPackage.values()) {
    for (const id of ids) {
      if (records.has(id)) continue;
      const record = (await getJson(fetch, `${API}/vulns/${encodeURIComponent(id)}`)) as
        | OsvRecord
        | null;
      if (record?.id) records.set(id, record);
    }
  }

  // 3. Keep only what the detail confirms. Screening is coarse, and an advisory
  //    that does not cover this version is a false positive from a source that
  //    never claimed it.
  const found: VulnerablePackage[] = [];
  for (const [index, ids] of idsByPackage) {
    const pkg = packages[index];
    if (!pkg) continue;
    const vulnerabilities = ids
      .map((id) => records.get(id))
      .filter((r): r is OsvRecord => r !== undefined)
      .filter((r) => covers(r, pkg.name, pkg.ecosystem, pkg.version))
      .map((r) => readVulnerability(r, pkg.name, pkg.ecosystem, pkg.version));
    if (vulnerabilities.length > 0) found.push({ ...pkg, vulnerabilities });
  }
  return found;
}

export interface RemediationTarget {
  /** The version to bump to, or null when nothing here is patched. */
  version: string | null;
  /** How many of this package's advisories that bump clears. */
  clears: number;
  /** Advisory ids the bump does *not* clear, because no fix exists yet. */
  leaves: string[];
}

/**
 * One bump for the package, rather than one per advisory.
 *
 * Measured live: `lodash@4.17.15` carries six advisories fixed in 4.17.19,
 * 4.17.21 and 4.17.23. Taking the first leaves two live, so the target is the
 * highest fix among them — one bump, one verification, and the package actually
 * clean afterwards rather than nearly.
 *
 * `leaves` is the honest half. A target clearing three of four is worth taking
 * and must not be reported as clearing four: the unpatched one survives the
 * upgrade, and the pull request has to say which.
 */
export function remediationTarget(pkg: VulnerablePackage): RemediationTarget {
  let version: string | null = null;
  let clears = 0;
  const leaves: string[] = [];

  for (const vuln of pkg.vulnerabilities) {
    if (vuln.fixedIn === null) {
      leaves.push(vuln.id);
      continue;
    }
    clears++;
    if (version === null || schemeFor(pkg.ecosystem).compare(vuln.fixedIn, version) > 0) version = vuln.fixedIn;
  }
  return { version, clears, leaves };
}
