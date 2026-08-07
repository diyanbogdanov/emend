import test from 'node:test';
import assert from 'node:assert/strict';
import { versionPinDetector, runDetectors, type DetectorContext } from '../src/detectors.ts';
import type { Detector, Finding } from '../src/types.ts';

function context(files: Record<string, string>, installed: Array<[string, string]> = []): DetectorContext {
  return {
    repoDir: '/repo',
    dependencies: installed.map(([name, version]) => ({
      name,
      installed: version,
      declared: version,
      dev: false,
      source: 'lockfile' as const,
      declaredIn: [''],
    })),
    sourceFiles: Object.keys(files).filter((f) => /\.[cm]?[jt]sx?$/.test(f)),
    read: async (file: string) => files[file] ?? null,
  };
}

const DOCKERFILE = 'FROM node:18-alpine AS builder\nRUN npm ci\n';
const MANIFEST = JSON.stringify({ engines: { node: '>=22' } });

// ---------------------------------------------------------------------------
// A pin drift becomes a finding, so it reaches everything findings reach
// ---------------------------------------------------------------------------

test('a drifted pin becomes a finding with a call site', () => {
  // Pin conflicts lived beside the findings rather than among them, so they were
  // never stored, never tracked across scans, never rendered into a pull request
  // and never shown on the dashboard. Everything downstream consumes `Finding`;
  // anything that is not one is invisible to all of it.
  return versionPinDetector.detect(context({ Dockerfile: DOCKERFILE, 'package.json': MANIFEST }))
    .then(({ findings }: { findings: Finding[] }) => {
      const node = findings.find((f) => f.pkg === 'node');
      assert.equal(node?.detector, 'version-pin');
      assert.equal(node?.fromVersion, '18');
      assert.equal(node?.toVersion, '22');
      assert.equal(node?.change.kind, 'version-drift');
      // A finding without a call site is not a finding — that is the whole claim
      // over Dependabot, and it holds here too: the pin has a file and a line.
      assert.equal(node?.sites[0]?.file, 'Dockerfile');
      assert.equal(node?.sites[0]?.line, 1);
    });
});

test('a pin drift is severity drift, never breaking', () => {
  // The headline count is what makes a scan worth reading. A drifted tag is real
  // and is not a change in anybody's public API, so counting it as breaking
  // would overstate both and blunt the one number that carries the product.
  return versionPinDetector.detect(context({ Dockerfile: DOCKERFILE, 'package.json': MANIFEST }))
    .then(({ findings }: { findings: Finding[] }) => {
      assert.ok(findings.length > 0);
      assert.ok(findings.every((f) => f.change.severity === 'drift'));
    });
});

test('a pin with nothing to arbitrate it produces no finding', () => {
  // Reporting that three files disagree is honest. A finding asserts a target
  // version, and inventing one would be the guess the planner refuses.
  return versionPinDetector
    .detect(context({ Dockerfile: DOCKERFILE, '.nvmrc': '22\n' }))
    .then(({ findings }: { findings: Finding[] }) => {
      assert.deepEqual(findings, []);
    });
});

test('a repository with nothing pinned does not run the detector', () => {
  // `applies` is the cheap precondition. A detector that has to read the whole
  // repository before discovering it has no work is a detector nobody registers.
  return versionPinDetector
    .applies(context({ 'src/index.ts': 'export const x = 1;' }))
    .then((applies: boolean) => assert.equal(applies, false));
});

// ---------------------------------------------------------------------------
// runDetectors — the seam itself
// ---------------------------------------------------------------------------

test('a detector that does not apply is never asked to detect', () => {
  let detected = false;
  const never: Detector = {
    id: 'never',
    applies: async () => false,
    detect: async () => {
      detected = true;
      return { findings: [] };
    },
  };
  return runDetectors([never], context({})).then(() => {
    assert.equal(detected, false, 'applies is a precondition, not a hint');
  });
});

test('one detector throwing does not lose the others findings', () => {
  // A detector reaching the network or the filesystem will fail sometimes, and a
  // scan that loses every other result because one adapter threw is worse than
  // one that reports what it has. The failure is returned, never swallowed.
  const broken: Detector = {
    id: 'broken',
    applies: async () => true,
    detect: async () => {
      throw new Error('registry unreachable');
    },
  };
  return runDetectors(
    [broken, versionPinDetector],
    context({ Dockerfile: DOCKERFILE, 'package.json': MANIFEST }),
  ).then((result) => {
    assert.ok(result.findings.some((f) => f.pkg === 'node'));
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]?.reason ?? '', /registry unreachable/);
    assert.equal(result.failures[0]?.detector, 'broken');
  });
});
