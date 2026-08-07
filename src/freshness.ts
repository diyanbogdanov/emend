/**
 * Upgrades that are simply sitting there.
 *
 * A package behind its latest version where the surface diff found nothing that
 * touches this repository. The scan already computed every part of that — it is
 * the same comparison the whole product runs on — and then reported it as
 * silence: "no findings" is true, and reads as "nothing to do", when what it
 * actually means is *there is a free upgrade here and Emend has already proved
 * it is safe for you*.
 *
 * Kept deliberately weak. Spec §6: these are unbounded, every repository has
 * some, and producing one requires no analysis at all. Pouring them in beside
 * proven findings inverts the signal-to-noise ratio that makes a scan worth
 * sharing, which the alert-fatigue literature names as the main reason people
 * stop reading exactly this kind of tool. So they carry their own severity, stay
 * out of the headline, and never share a section with anything that was proved.
 */

import { createHash } from 'node:crypto';
import type { Finding, PackageReport, Severity } from './types.ts';

/**
 * Whether a severity belongs in `N breaking · M deprecated`.
 *
 * The headline is the one line anybody reads, and every class that has been
 * added since — drift, vulnerability, lint, freshness — is real and is not an
 * API break. Each is counted on its own line instead, so the headline keeps
 * meaning what it says.
 */
export function inHeadline(severity: Severity): boolean {
  return severity === 'breaking' || severity === 'deprecation';
}

function freshnessId(pkg: string, from: string, to: string): string {
  return createHash('sha256').update(`freshness|${pkg}|${from}|${to}`).digest('hex').slice(0, 12);
}

/**
 * Packages that could be upgraded today at no cost to this repository.
 *
 * The conditions are all "Emend checked and there is nothing", not "Emend did
 * not look":
 *
 * - the package was analysed, so the surface of both versions was actually read
 * - the upgrade produced no findings, so nothing this repository calls changed
 *
 * Unlocated breaking changes do *not* disqualify it, and excluding them was the
 * first thing tried. Measured: zod 4.4.0 to 4.4.3, a patch upgrade, carries
 * fifteen breaking surface changes that this repository does not call — so the
 * strict rule made the detector fire essentially never.
 *
 * The claim is therefore "nothing *you call* changed", not "nothing changed",
 * and the count is stated so the reader can see the difference. That is a
 * stronger thing to be able to say than the weaker rule allowed, and it is
 * precisely what knowing the call sites buys.
 *
 * A package that could not be analysed is never fresh. Unanalysable means Emend
 * does not know whether the upgrade is safe, and this finding asserts that it is.
 */
export function freshnessFindings(packages: PackageReport[]): Finding[] {
  const found: Finding[] = [];
  for (const p of packages) {
    if (p.status !== 'analyzed') continue;
    if (p.findings.length > 0) continue;
    if (!p.fromVersion || !p.toVersion || p.fromVersion === p.toVersion) continue;

    found.push({
      id: freshnessId(p.pkg, p.fromVersion, p.toVersion),
      detector: 'freshness',
      pkg: p.pkg,
      fromVersion: p.fromVersion,
      toVersion: p.toVersion,
      change: {
        path: p.pkg,
        kind: 'version-drift',
        severity: 'freshness',
        confidence: 'high',
        before: p.fromVersion,
        after: p.toVersion,
        guidance:
          p.unlocatedBreaking > 0
            ? `${p.unlocatedBreaking} breaking change(s) between ${p.fromVersion} and ${p.toVersion}, none of which this repository calls`
            : `nothing changed between ${p.fromVersion} and ${p.toVersion} that this repository could call`,
      },
      // No call site, and deliberately so: the claim is precisely that no line
      // of this repository is affected. Somewhere to point would contradict it.
      sites: [],
      confidence: 'high',
    });
  }
  return found;
}
