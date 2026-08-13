/**
 * Run one eval case for real and print everything needed to judge the result.
 *
 * `runCase` discards its workspace as soon as the metrics are read, which is
 * right for a sweep and wrong for verifying the scorer: the diff is the
 * evidence, and answering the last denominator question meant re-running a
 * case to get one. So this runs the same scan and the same `fixPackage`, hands
 * the result to `measureCase` — the measurement `runCase` uses, not a copy of
 * it — and keeps the workspace long enough to print the diff.
 *
 *   node --experimental-strip-types scripts/capture-case.ts <case-id>
 */

import { rm } from 'node:fs/promises';
import { BUILT_IN_CASES, materialiseCase, measureCase, scanOptionsFor, scoreCase } from '../src/eval.ts';
import { scanRepo } from '../src/analyze.ts';
import { fixPackage } from '../src/fix.ts';
import { openCodeHarness } from '../src/harness.ts';
import { resolveChecks } from '../src/quality.ts';

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
  // Both of these are what `runCase` asks for, and a capture that asked for less
  // would print a different score for the same run — which is the whole failure
  // this script was rewritten to stop having.
  countUpgradeErrors: true,
  harness: openCodeHarness({ model }),
  onProgress: (m) => console.log(`  ${m}`),
});

const ws = result.workspaceDir;

// The measurement itself is `runCase`'s, called rather than reproduced. This
// script held a second copy for a while and it drifted — it left the harness
// off the outcome entirely and filled the error counts with zeroes of its own —
// so the score printed here was not the score the sweep would report for the
// same run, which is the one thing a capture is for.
const outcome = await measureCase(evalCase, findings, result, model);

// Re-read only for the per-file detail the outcome does not carry: `unresolved`
// names the symbols, and when a check fires it is the file that says why.
const resolutions = ws && evalCase.mustResolve?.length
  ? await resolveChecks(evalCase.mustResolve, ws)
  : [];

console.log('\n--- diff ---');
console.log(result.diff);
console.log(`--- ${(result.diff.match(/^@@/gm) ?? []).length} hunk(s), as the pipeline counts them ---`);

console.log('\n--- completeness ---');
for (const r of resolutions) {
  console.log(`  ${r.state.padEnd(10)} ${r.check.symbol}${r.files.length ? `  (${r.files.join(', ')})` : ''}${r.reason ? `  ${r.reason}` : ''}`);
}

const score = scoreCase(evalCase, outcome);
console.log('\n--- score ---');
console.log(`  verdict=${outcome.verdict} appliedEdits=${outcome.editsApplied} escapes=${outcome.typeEscapes} gaps=${outcome.deprecationGaps}`);
console.log(`  passed=${score.passed}  CLEAN=${score.clean}  editRatio=${score.editRatio.toFixed(2)}`);
console.log(`  penalties: ${score.penalties.length ? score.penalties.join(' | ') : '(none)'}`);

if (ws) await rm(ws, { recursive: true, force: true });
await rm(dir, { recursive: true, force: true });
