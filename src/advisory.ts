/**
 * What GitHub knows about an advisory that OSV does not.
 *
 * OSV answers *which packages are affected*, and answers it better than anything
 * else. What it does not carry is a numeric severity or any estimate of whether
 * a vulnerability is actually being exploited — its `severity` is a CVSS vector
 * string, measured, and turning that into a number here would mean implementing
 * the CVSS calculator.
 *
 * GitHub's advisory endpoint carries both, keyed by the same GHSA id OSV
 * returns, so enrichment is one request per advisory with no search involved.
 *
 * **EPSS is the point.** Measured on GHSA-29mw-wpgm-hmr9: CVSS 5.3, rated
 * "medium", and an EPSS percentile of 0.936. CVSS scores the worst case whether
 * or not anybody exploits it; EPSS estimates whether they do. Ranking on CVSS
 * buries the vulnerability under active exploitation beneath a theoretically
 * worse one nobody touches, which is how a security report stops being read.
 */

import type { Fetcher } from './specfetch.ts';
import type { VulnerablePackage } from './osv.ts';

const API = 'https://api.github.com/advisories';

export interface AdvisoryFacts {
  /** GitHub's own label: `low`, `medium`, `high`, `critical`. */
  severity: string | null;
  cvssScore: number | null;
  /** Estimated probability of exploitation, as a percentile of all CVEs. */
  epssPercentile: number | null;
  cwe: string | null;
}

export interface EnrichOptions {
  token?: string;
  /**
   * How many advisories to look up.
   *
   * GitHub allows sixty unauthenticated requests an hour across everything
   * Emend does, and a repository with two hundred advisories would exhaust that
   * three times over — taking the spec resolver's budget with it.
   */
  max?: number;
}

const DEFAULT_MAX = 40;

/** Facts for as many of these advisories as the budget allows. */
export async function enrichAdvisories(
  fetch: Fetcher,
  ids: string[],
  options: EnrichOptions,
): Promise<Map<string, AdvisoryFacts>> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  };

  const found = new Map<string, AdvisoryFacts>();
  for (const id of [...new Set(ids)].slice(0, options.max ?? DEFAULT_MAX)) {
    let doc: {
      severity?: unknown;
      cvss?: { score?: unknown };
      epss?: { percentile?: unknown };
      cwes?: Array<{ cwe_id?: unknown }>;
    } | null = null;
    try {
      const res = await fetch(`${API}/${encodeURIComponent(id)}`, { headers });
      // A 403 is a rate limit and a 404 is an advisory GitHub has not published.
      // Neither is a fact about the vulnerability, so neither is recorded —
      // absent and zero mean opposite things when ranking.
      if (res.ok) doc = JSON.parse(res.body);
    } catch {
      doc = null;
    }
    if (!doc) continue;

    found.set(id, {
      severity: typeof doc.severity === 'string' ? doc.severity : null,
      cvssScore: typeof doc.cvss?.score === 'number' ? doc.cvss.score : null,
      epssPercentile: typeof doc.epss?.percentile === 'number' ? doc.epss.percentile : null,
      cwe: typeof doc.cwes?.[0]?.cwe_id === 'string' ? doc.cwes[0].cwe_id : null,
    });
  }
  return found;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** How urgent a single advisory is, on whatever evidence exists for it. */
function urgency(facts: AdvisoryFacts | undefined): number {
  if (!facts) return -1;
  // Exploitation likelihood first, on a scale that cannot be reached by CVSS
  // alone — so any measured EPSS outranks any severity label.
  if (facts.epssPercentile !== null) return 100 + facts.epssPercentile * 100;
  if (facts.cvssScore !== null) return facts.cvssScore;
  return SEVERITY_ORDER[facts.severity ?? ''] ?? 0;
}

/**
 * Vulnerable packages, most urgent first.
 *
 * A package is ranked by its **worst** advisory rather than its average. One
 * actively exploited advisory is the reason to act, and averaging it against
 * four quiet ones is exactly how it stops being visible.
 *
 * A package with no enrichment sorts last, not first. Unknown is not "worst",
 * and letting it displace something measured to be under active exploitation
 * would invert the ordering this exists to provide. Ordering is stable, so with
 * no enrichment at all the input order is left alone.
 */
export function rankVulnerable(
  packages: VulnerablePackage[],
  facts: Map<string, AdvisoryFacts>,
): VulnerablePackage[] {
  const worst = (pkg: VulnerablePackage): number =>
    Math.max(-1, ...pkg.vulnerabilities.map((v) => urgency(facts.get(v.id))));

  return packages
    .map((pkg, index) => ({ pkg, index, score: worst(pkg) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((e) => e.pkg);
}

/** `1st`, `2nd`, `3rd`, `11th`. Rendered text, so it should read as English. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}
