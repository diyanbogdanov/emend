import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPrBody, parsePrSummary } from '../src/pr.ts';
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

// ---------------------------------------------------------------------------
// The model-written review guide
// ---------------------------------------------------------------------------

function regressed(): FixResult['verification'] {
  return {
    outcome: 'regression',
    summary: 'post-change typecheck failed',
    baseline: { typecheck: { ok: true }, test: { ok: true } },
    post: { typecheck: { ok: false }, test: { ok: false } },
  } as unknown as FixResult['verification'];
}

test('a summary is rendered as a review guide, attributed to the model', () => {
  // Every other section says what happened. None says where to look, and a
  // reviewer opening a verified migration has no way to tell which of nine call
  // sites is the one worth reading. That is the gap this fills — not another
  // restatement of the diff.
  const body = renderPrBody(result(), {
    summary: {
      model: 'z-ai/glm-5.2',
      says: 'Error formatting now reads `issues` rather than `errors`; each entry keeps its shape.',
      checks: [
        { path: 'src/schema.ts', why: 'the only site that indexes the result before mapping' },
      ],
    },
  });
  assert.match(body, /What to look at/);
  assert.match(body, /Error formatting now reads/);
  assert.match(body, /src\/schema\.ts/);
  // Attribution is not decoration. A PR body is authoritative-looking, and a
  // reader who cannot tell which sentences a model wrote cannot weight them.
  assert.match(body, /z-ai\/glm-5\.2/);
});

test('no summary renders no section at all', () => {
  // Degrading to a heading with nothing under it would read as "the model looked
  // and had nothing to say", which is a claim. Absence stays absence — the rule
  // the review findings already follow.
  assert.doesNotMatch(renderPrBody(result()), /What to look at/);
});

test('the summary never displaces the verification verdict', () => {
  // The failure mode that makes this dangerous. A model sentence reading "this
  // looks low risk" above a regression badge is a body contradicting itself, and
  // a reader cannot tell which half to believe. The verdict is Emend's, from
  // evidence; the model is asked what to check, never whether it is fine.
  const body = renderPrBody(result({ verification: regressed() }), {
    summary: { model: 'm', says: 'Straightforward and low risk.', checks: [] },
  });
  const verdict = body.indexOf('Regression');
  const guide = body.indexOf('What to look at');
  assert.ok(verdict !== -1, 'the verdict must still be rendered');
  assert.ok(verdict < guide, 'the verdict is above the model, not beneath it');
});

test('a check naming a file the evidence never mentions sinks the whole summary', () => {
  // The guard that makes this safe to print. An instruction not to invent things
  // is a wish; the evidence is right here, so a path can be *checked* — and a
  // model confident enough to invent one has said what its prose is worth.
  // Keeping the paragraph and dropping the bad check would leave the least
  // verifiable part on the page and remove the thing that exposed it.
  const said = '{"says": "Nothing behavioural changes.", "checks": ' +
    '[{"path": "src/invented.ts", "why": "handles the error path"}]}';
  assert.equal(parsePrSummary(said, new Set(['src/schema.ts'])), null);
});

test('a summary with no checks at all is a real answer', () => {
  // Distinct from the case above, and the distinction is the same one this
  // codebase makes everywhere: offering nothing is an answer, offering only
  // things that turned out to be false is not.
  const parsed = parsePrSummary('{"says": "No call site stands out.", "checks": []}', new Set());
  assert.equal(parsed?.says, 'No call site stands out.');
  assert.deepEqual(parsed?.checks, []);
});

test('checks are kept when the evidence backs them', () => {
  const said = '{"says": "Reads issues rather than errors.", "checks": ' +
    '[{"path": "src/schema.ts", "why": "indexes the result before mapping"}]}';
  const parsed = parsePrSummary(said, new Set(['src/schema.ts']));
  assert.equal(parsed?.checks.length, 1);
  assert.equal(parsed?.checks[0]?.path, 'src/schema.ts');
});
