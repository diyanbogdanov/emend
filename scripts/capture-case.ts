/**
 * Run one eval case for real and print everything needed to judge the result.
 *
 * `runCase` discards its workspace as soon as the metrics are read, which is
 * right for a sweep and wrong for verifying the scorer: the diff is the
 * evidence, and answering the last denominator question meant re-running a
 * case to get one. This mirrors `runCase`'s computation
 * exactly — same scan options, same `fixPackage` call, same `resolveChecks` and
 * `remainingDeprecations` against the migrated tree — and keeps the diff.
 *
 *   node --experimental-strip-types scripts/capture-case.ts <case-id>
 */

import { rm } from 'node:fs/promises';
import { BUILT_IN_CASES, materialiseCase, scanOptionsFor, scoreCase, type CaseOutcome } from '../src/eval.ts';
import { scanRepo } from '../src/analyze.ts';
import { fixPackage } from '../src/fix.ts';
import { openCodeHarness } from '../src/harness.ts';
import { remainingDeprecations, resolveChecks } from '../src/quality.ts';
import { countTypeEscapes } from '../src/pr.ts';

const id = process.argv[2];
const evalCase = BUILT_IN_CASES.find((c) => c.id === id);
if (!evalCase) {
  console.error(`unknown case: ${id}\nknown: ${BUILT_IN_CASES.map((c) => c.id).join(', ')}`);
  process.exit(1);
}

const model = process.env['EMEND_EVAL_MODEL'] ?? 'openrouter/z-ai/glm-5.2';
console.log(`# ${evalCase.id} — minimalEdits=${evalCase.minimalEdits}, model=${model}`);

const dir = await materialiseCase(evalCase);
const scan = await scanRepo(dir, scanOptionsFor(evalCase));
const findings = scan.packages.flatMap((p) => p.findings);
console.log(`# ${findings.length} finding(s)`);

const result = await fixPackage(dir, findings, {
  keepWorkspace: true,
  harness: openCodeHarness({ model }),
  onProgress: (m) => console.log(`  ${m}`),
});

const ws = result.workspaceDir;
const gaps = ws ? await remainingDeprecations(findings, ws) : [];
const resolutions = ws && evalCase.mustResolve?.length
  ? await resolveChecks(evalCase.mustResolve, ws)
  : [];

console.log('\n--- diff ---');
console.log(result.diff);

console.log('--- hunks, at the two context widths ---');
const hunksAt = (diff: string): number => (diff.match(/^@@/gm) ?? []).length;
console.log(`  diff as reported: ${hunksAt(result.diff)} hunk(s)`);

console.log('\n--- completeness ---');
for (const r of resolutions) {
  console.log(`  ${r.state.padEnd(10)} ${r.check.symbol}${r.files.length ? `  (${r.files.join(', ')})` : ''}${r.reason ? `  ${r.reason}` : ''}`);
}

// A refusal only makes the run inconclusive when it also failed — `runCase`'s
// rule, copied rather than approximated. Leaving it out scored a run whose engine
// produced nothing as a migration that failed, which is precisely the claim
// `inconclusive` was added to stop the benchmark making.
const passed =
  result.verification.outcome === 'verified' || result.verification.outcome === 'typecheck-only';
const refused = result.harness && !result.harness.ok ? result.harness.reason : undefined;

const outcome: CaseOutcome = {
  caseId: evalCase.id,
  model,
  verdict: result.verification.outcome,
  ...(refused && !passed ? { inconclusive: refused } : {}),
  editsApplied: result.appliedEdits,
  editsWithheld: result.harness?.revertedHunks.length ?? 0,
  ...(resolutions.some((r) => r.state === 'unresolved')
    ? { unresolved: resolutions.filter((r) => r.state === 'unresolved').map((r) => r.check.symbol) }
    : {}),
  ...(resolutions.some((r) => r.state === 'unknown')
    ? { uncheckable: resolutions.filter((r) => r.state === 'unknown').map((r) => `${r.check.symbol} — ${r.reason}`) }
    : {}),
  errorsBefore: 0,
  errorsAfter: 0,
  typeEscapes: countTypeEscapes(result.diff),
  deprecationGaps: gaps.length,
  durationMs: 0,
};

const score = scoreCase(evalCase, outcome);
console.log('\n--- score ---');
console.log(`  verdict=${outcome.verdict} appliedEdits=${outcome.editsApplied} escapes=${outcome.typeEscapes} gaps=${outcome.deprecationGaps}`);
console.log(`  passed=${score.passed}  CLEAN=${score.clean}  editRatio=${score.editRatio.toFixed(2)}`);
console.log(`  penalties: ${score.penalties.length ? score.penalties.join(' | ') : '(none)'}`);

if (ws) await rm(ws, { recursive: true, force: true });
await rm(dir, { recursive: true, force: true });
