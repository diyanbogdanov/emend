/**
 * Emend as tools, so an agent drives the loop instead of Emend calling a model.
 *
 * The inversion is the point. Everywhere else here, Emend owns a retry loop and
 * asks a model for text edits; `runAgentRepair` is 230 lines of orchestration
 * doing what a tool-using agent already does natively, with a fixed three-attempt
 * budget and no way to change its mind about which rung to try. Exposing the
 * primitives instead puts the deterministic parts — resolve, bump, verify, prove
 * the advisory cleared — behind a boundary the agent cannot fake, and leaves the
 * reasoning to something built for it.
 *
 * **Why hand-rolled JSON-RPC.** MCP over stdio is JSON-RPC 2.0 with a three-call
 * handshake. The SDK would be the fourth dependency in a package that has two,
 * and would earn that place only if this needed resources, prompts, sampling or
 * transports other than stdio. It needs none of them.
 *
 * **What a tool result is.** Every tool returns what was *measured*, never a
 * judgement: `verify` reports the outcome and the output, `advisory_status`
 * reports the versions actually resolved in the lockfile. An agent that wants to
 * claim a vulnerability is fixed has to call `advisory_status` and read it, the
 * same way `fixVulnerability` does — because a green build with the vulnerable
 * version still installed is the failure most easily mistaken for success, and
 * moving the loop out of Emend must not move that check out with it.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { scanRepo } from './analyze.ts';
import { fixPackage, fixVulnerability } from './fix.ts';
import { planRemediation, pathsTo } from './remediate.ts';
import { readRepo } from './inventory.ts';
import { readLockfile } from './lockfile.ts';
import { runPhase, compare } from './verify.ts';
import { analyseImpact, renderImpact } from './impact.ts';
import { httpFetcher } from './specfetch.ts';
import { scanPackages } from './osv.ts';
import type { Finding } from './types.ts';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

const str = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new Error(`${key} is required`);
  return value;
};

/** Findings are passed back by id, so the agent never hand-writes one. */
async function findingById(repoDir: string, id: string): Promise<Finding> {
  const report = await scanRepo(repoDir, { vulnerabilities: vulnOptions() });
  const found = report.packages.flatMap((p) => p.findings).find((f) => f.id === id);
  if (!found) throw new Error(`no finding ${id} in ${repoDir}; run scan first`);
  return found;
}

function vulnOptions(): { scan: Parameters<typeof scanPackages>[0] extends never ? never : ReturnType<typeof vulnScan> } {
  return { scan: vulnScan() } as never;
}
function vulnScan() {
  const fetch = httpFetcher({ timeoutMs: 30_000 });
  return (packages: Parameters<typeof scanPackages>[1]) => scanPackages(fetch, packages);
}

export function tools(): ToolDef[] {
  return [
    {
      name: 'scan',
      description:
        'Find drift, vulnerabilities and version pins in a repository. Returns findings with stable ids, ' +
        'the call sites each one hits, and the warnings that limited the analysis. A warning means a ' +
        'question could not be answered, never that the answer was clean.',
      inputSchema: {
        type: 'object',
        properties: { repo: { type: 'string', description: 'Absolute path to the repository' } },
        required: ['repo'],
      },
      run: async (args) => {
        const report = await scanRepo(str(args, 'repo'), { vulnerabilities: vulnOptions() });
        return {
          findings: report.packages.flatMap((p) =>
            p.findings.map((f) => ({
              id: f.id,
              detector: f.detector,
              pkg: f.pkg,
              from: f.fromVersion,
              to: f.toVersion,
              change: f.change.path,
              kind: f.change.kind,
              severity: f.change.severity,
              sites: f.sites.slice(0, 20).map((s) => `${s.file}:${s.line}`),
            })),
          ),
          // Never dropped. "Could not check" and "checked and clean" are
          // different answers, and only one of them is in the findings list.
          warnings: report.warnings,
        };
      },
    },
    {
      name: 'plan_remediation',
      description:
        'For a vulnerable package, which dependency to bump and to what version, plus the route from ' +
        'each direct dependency down to it. Returns kind "none" with a reason when nothing can move it — ' +
        'an unfixable vulnerability is a real answer.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          pkg: { type: 'string' },
          version: { type: 'string', description: 'The vulnerable version currently installed' },
          target: { type: 'string', description: 'The fixed version to reach' },
        },
        required: ['repo', 'pkg', 'version', 'target'],
      },
      run: async (args) => {
        const repo = str(args, 'repo');
        const directs = new Set((await readRepo(repo)).dependencies.map((d) => d.name));
        const lockRaw = await readFile(path.join(repo, 'package-lock.json'), 'utf8').catch(() => '');
        const pkg = str(args, 'pkg');
        return {
          plan: planRemediation(
            { name: pkg, version: str(args, 'version'), target: str(args, 'target') },
            directs,
            lockRaw,
          ),
          routes: pathsTo(lockRaw, pkg, directs),
        };
      },
    },
    {
      name: 'fix_vulnerability',
      description:
        'Take one vulnerability finding through the full remediation: isolated workspace, baseline, the ' +
        'bump (direct, then parents, then an override), and verification. Reports whether the advisory ' +
        'actually cleared SEPARATELY from whether the build passed. Both must hold; a green build with ' +
        'the vulnerable version still installed is not a fix.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          finding_id: { type: 'string', description: 'An id from scan' },
          keep_workspace: { type: 'boolean' },
        },
        required: ['repo', 'finding_id'],
      },
      run: async (args) => {
        const repo = str(args, 'repo');
        const result = await fixVulnerability(repo, await findingById(repo, str(args, 'finding_id')), {
          keepWorkspace: args['keep_workspace'] === true,
        });
        return {
          advisory_cleared: result.resolved,
          build: result.verification?.outcome ?? 'unverified',
          installed_after: result.installedAfter,
          used_override: result.overrode,
          remediation: result.remediation,
          diff: result.diff,
          workspace: result.workspaceDir,
          note: result.note,
        };
      },
    },
    {
      name: 'fix_package',
      description:
        'Take every finding for one package through the deterministic migration: workspace, baseline, ' +
        'bump, planned edits, verification. Returns the diff and what was left unplanned. Edits it cannot ' +
        'justify are not made; that is the caller\'s job to finish.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          finding_ids: { type: 'array', items: { type: 'string' } },
          keep_workspace: { type: 'boolean' },
        },
        required: ['repo', 'finding_ids'],
      },
      run: async (args) => {
        const repo = str(args, 'repo');
        const ids = Array.isArray(args['finding_ids']) ? (args['finding_ids'] as string[]) : [];
        const findings: Finding[] = [];
        for (const id of ids) findings.push(await findingById(repo, id));
        if (findings.length === 0) throw new Error('finding_ids must name at least one finding');
        const result = await fixPackage(repo, findings, {
          keepWorkspace: args['keep_workspace'] === true,
        });
        return {
          build: result.verification?.outcome ?? 'unverified',
          applied_edits: result.appliedEdits,
          failed_edits: result.failedEdits,
          unplanned: result.unplanned?.length ?? 0,
          diff: result.diff,
          workspace: result.workspaceDir,
        };
      },
    },
    {
      name: 'verify',
      description:
        'Run the repository\'s own typecheck and tests and compare against a baseline. The outcome ' +
        'distinguishes a regression this change caused from a failure that was already there — a repo ' +
        'that was red before is reported as such, not blamed on the change.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          skip_tests: { type: 'boolean', description: 'Typecheck only. The result says so.' },
        },
        required: ['repo'],
      },
      run: async (args) => {
        const repo = str(args, 'repo');
        const opts = { skipTests: args['skip_tests'] === true };
        const phase = await runPhase(repo, opts);
        const report = compare(phase, phase);
        return {
          outcome: report.outcome,
          summary: report.summary,
          typecheck: phase.typecheck.ok,
          tests: phase.test?.ok ?? null,
          output: [phase.typecheck.stdout, phase.typecheck.stderr, phase.test?.stdout, phase.test?.stderr]
            .filter(Boolean)
            .join('\n')
            .slice(0, 20_000),
        };
      },
    },
    {
      name: 'advisory_status',
      description:
        'Which versions of a package the lockfile actually resolves, read back from disk. The only ' +
        'evidence that a bump moved what it claimed to move — a parent bump can resolve a patched child, ' +
        'a still-vulnerable one, or the same one, and only the lockfile knows which.',
      inputSchema: {
        type: 'object',
        properties: { repo: { type: 'string' }, pkg: { type: 'string' } },
        required: ['repo', 'pkg'],
      },
      run: async (args) => {
        const pkg = str(args, 'pkg');
        const lock = await readLockfile(str(args, 'repo'));
        const versions = [...lock.tree.values()].filter((e) => e.name === pkg).map((e) => e.version);
        return { pkg, installed: versions, present: versions.length > 0 };
      },
    },
    {
      name: 'impact',
      description:
        'What else in the repository references the symbols declared in these files. Answers "if I change ' +
        'this function, what breaks" before the edit rather than after the build. Exact for static uses; ' +
        'blind to reflection and dynamic property access, so absence means none were found, not none.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          files: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths' },
        },
        required: ['repo', 'files'],
      },
      run: async (args) => {
        const files = Array.isArray(args['files']) ? (args['files'] as string[]) : [];
        const impacts = await analyseImpact(str(args, 'repo'), files);
        return {
          summary: renderImpact(impacts),
          symbols: impacts
            .filter((i) => i.external.length > 0)
            .map((i) => ({
              name: i.name,
              declared_in: i.declaredIn,
              used_in: i.external.map((s) => `${s.file}:${s.line}`),
            })),
        };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

interface Request {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

/** One request in, one response out. Exported so the protocol is testable without a process. */
export async function handle(request: Request): Promise<Record<string, unknown> | null> {
  const reply = (result: unknown): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id: request.id ?? null,
    result,
  });

  switch (request.method) {
    case 'initialize':
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'emend', version: '0.1.0' },
      });
    // A notification carries no id and must draw no response at all; replying to
    // one is a protocol error that some clients treat as fatal.
    case 'notifications/initialized':
      return null;
    case 'tools/list':
      return reply({
        tools: tools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call': {
      const name = String(request.params?.['name'] ?? '');
      const tool = tools().find((t) => t.name === name);
      if (!tool) {
        return reply({ content: [{ type: 'text', text: `no such tool: ${name}` }], isError: true });
      }
      try {
        const out = await tool.run((request.params?.['arguments'] as Record<string, unknown>) ?? {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      } catch (err) {
        // Reported as a tool error rather than a protocol error: the agent can
        // read it, correct itself and call again, which a transport-level
        // failure would not let it do.
        const message = err instanceof Error ? err.message : String(err);
        return reply({ content: [{ type: 'text', text: `error: ${message}` }], isError: true });
      }
    }
    default:
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: { code: -32601, message: `method not found: ${request.method}` },
      };
  }
}

/** Serve on stdin/stdout until the client closes the stream. */
export async function serve(): Promise<void> {
  let buffer = '';
  process.stdin.setEncoding('utf8');

  for await (const chunk of process.stdin) {
    buffer += chunk;
    // Newline-delimited JSON. A partial line is kept for the next chunk, because
    // a large tool result arrives split and parsing half of one loses the call.
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      try {
        const response = await handle(JSON.parse(line) as Request);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`,
        );
      }
    }
  }
}
