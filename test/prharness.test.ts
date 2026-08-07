import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPrBody } from '../src/pr.ts';
import type { FixResult, HarnessEscalation } from '../src/fix.ts';
import type { Finding } from '../src/types.ts';

const FINDING: Finding = {
  id: 'abc123',
  detector: 'surface-diff',
  pkg: 'zod',
  fromVersion: '3.23.8',
  toVersion: '4.0.0',
  change: {
    path: 'ZodString.email',
    kind: 'removed',
    severity: 'breaking',
    confidence: 'high',
    before: 'email(): ZodString',
    after: null,
  },
  sites: [{ file: 'src/schema.ts', line: 4, column: 3, text: 'z.string().email()', via: 'import' }],
  confidence: 'high',
};

const AGENT: NonNullable<FixResult['agent']> = {
  model: 'z-ai/glm-5.2',
  provider: 'OpenRouter',
  attempts: [{ attempt: 1, edits: [], rationale: 'replaced the removed method', modelConfidence: 'high', outcome: 'verified' }],
  rationale: 'replaced the removed method',
  initialErrors: 2,
  finalErrors: 0,
};

function harness(over: Partial<HarnessEscalation> = {}): HarnessEscalation {
  return {
    id: 'opencode',
    ok: true,
    log: 'read the CI config and updated the Dockerfile base image',
    keptHunks: 2,
    revertedHunks: [],
    ...over,
  };
}

function result(over: Partial<FixResult> = {}): FixResult {
  return {
    finding: FINDING,
    plan: null,
    verification: {
      outcome: 'verified',
      summary: 'typecheck and tests pass',
      baseline: { typecheck: { ok: true }, test: { ok: true } },
      post: { typecheck: { ok: true }, test: { ok: true } },
    } as unknown as FixResult['verification'],
    diff: 'diff --git a/src/schema.ts b/src/schema.ts',
    appliedEdits: 2,
    failedEdits: [],
    bump: null,
    workspaceDir: null,
    workspaceMode: 'worktree',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// A harness is not the same thing as a model proposing edits
// ---------------------------------------------------------------------------

test('a harness escalation is named, so a reviewer knows what wrote the branch', () => {
  // It was collected and never shown. A reviewer looking at a diff produced by an
  // agent with write access could not tell that from one produced by pattern
  // substitution, which is the difference that decides how closely they read it.
  const body = renderPrBody(result({ agent: AGENT, harness: harness() }));
  assert.match(body, /opencode/);
  assert.match(body, /harness/i);
});

test('the claim that the model had no filesystem access is dropped when it did', () => {
  // The agent block states it outright, and it was true for every PR until a
  // harness could produce one. Leaving it in place would be a false statement
  // about how the change was made, in the section explaining how it was made.
  const withHarness = renderPrBody(result({ agent: AGENT, harness: harness() }));
  assert.ok(
    !/never had filesystem or shell access/i.test(withHarness),
    'the sentence must not survive an escalation',
  );

  const withoutHarness = renderPrBody(result({ agent: AGENT }));
  assert.match(withoutHarness, /never had filesystem or shell access/i);
});

test('hunks the gate reverted are listed, not merely counted', () => {
  // Same rule as the withheld edits above them: usually valid code, which is
  // exactly why verification cannot be what catches it, and why a reviewer is
  // entitled to see what the harness wanted beyond what the upgrade required.
  const body = renderPrBody(
    result({
      harness: harness({
        revertedHunks: [
          {
            hunk: { file: 'src/unrelated.ts', start: 40, end: 44 },
            evidence: 'unrequested',
            reason: 'src/unrelated.ts:40 covers a call site with nothing outstanding on it',
          },
        ],
      }),
    }),
  );
  assert.match(body, /src\/unrelated\.ts/);
  assert.match(body, /nothing outstanding/);
});

test('an escalation that achieved nothing says so rather than going unmentioned', () => {
  // The most expensive step in the pipeline. A run that declined to happen looks
  // identical to one that tried, unless it is written down.
  const body = renderPrBody(
    result({ harness: harness({ ok: false, reason: 'opencode is unavailable — not on PATH', keptHunks: 0 }) }),
  );
  assert.match(body, /not on PATH/);
});

test('a PR with no harness says nothing about one', () => {
  const body = renderPrBody(result({ agent: AGENT }));
  assert.ok(!/opencode/i.test(body));
});
