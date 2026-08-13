/**
 * Applies a migration plan inside an isolated workspace.
 *
 * The user's working tree is never touched. Emend either creates a detached git
 * worktree (preferred — cheap, and the branch is already in a state git can push)
 * or, for repositories without commits, copies the directory.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import path from 'node:path';
import type { CommandResult, MigrationPlan, PlannedEdit } from './types.ts';
import { runCommand } from './verify.ts';
import { findWorkspaces } from './workspaces.ts';

const execFileAsync = promisify(execFile);

export type WorkspaceMode = 'worktree' | 'copy';

export interface Workspace {
  dir: string;
  mode: WorkspaceMode;
  /** Present only for worktree mode — the branch/commit the workspace is based on. */
  baseCommit: string | null;
  cleanup: () => Promise<void>;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function gitHead(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoDir, 'rev-parse', 'HEAD']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Copy an installed dependency tree into the workspace.
 *
 * A workspace repository does not keep one `node_modules` — it keeps one per
 * package. A real six-workspace monorepo had two entries at the root and
 * fifteen, twenty-six, five, four, four and six across its workspaces, so
 * copying only the root produced a workspace whose baseline failed to typecheck
 * for want of almost every dependency. Emend then correctly reported
 * "pre-existing failure" about a repository that was perfectly healthy.
 *
 * On macOS/APFS `cp -c` uses clonefile, so the copy is near-instant and costs
 * no disk even for a large tree; everywhere else plain `cp -R` is the fallback.
 * Reinstalling from scratch instead would add minutes per run for no benefit —
 * we bump only the one package under migration afterwards. `-R` preserves
 * symlinks rather than following them, which matters: bun and pnpm fill
 * per-workspace directories with links into a shared store, and dereferencing
 * them would multiply the copy by the number of workspaces.
 */
async function copyNodeModules(from: string, to: string): Promise<boolean> {
  const roots = await findWorkspaces(from);
  let copiedAny = false;

  for (const workspace of roots) {
    const src = path.join(from, workspace, 'node_modules');
    if (!(await exists(src))) continue;
    const dst = path.join(to, workspace, 'node_modules');
    await mkdir(path.dirname(dst), { recursive: true });

    const attempts =
      platform() === 'darwin'
        ? [
            ['-c', '-R', src, dst],
            ['-R', src, dst],
          ]
        : [['-R', src, dst]];
    for (const args of attempts) {
      try {
        await execFileAsync('cp', args, { maxBuffer: 64 * 1024 * 1024 });
        copiedAny = true;
        break;
      } catch {
        /* try next strategy */
      }
    }
  }
  return copiedAny;
}

export async function prepareWorkspace(repoDir: string): Promise<Workspace> {
  const abs = path.resolve(repoDir);
  const dir = path.join(
    tmpdir(),
    `emend-ws-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );

  const head = await gitHead(abs);

  if (head) {
    await execFileAsync('git', ['-C', abs, 'worktree', 'add', '--detach', dir, head]);
    await copyNodeModules(abs, dir);
    return {
      dir,
      mode: 'worktree',
      baseCommit: head,
      cleanup: async () => {
        try {
          await execFileAsync('git', ['-C', abs, 'worktree', 'remove', '--force', dir]);
        } catch {
          await rm(dir, { recursive: true, force: true });
        }
      },
    };
  }

  // No commits (or not a git repo): fall back to a plain copy so the tool still
  // works on a scratch directory.
  await mkdir(dir, { recursive: true });
  const copyArgs = platform() === 'darwin' ? ['-c', '-R'] : ['-R'];
  await execFileAsync('cp', [...copyArgs, `${abs}/.`, dir], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    dir,
    mode: 'copy',
    baseCommit: null,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export interface EditResult {
  applied: PlannedEdit[];
  failed: Array<{ edit: PlannedEdit; reason: string }>;
}

/**
 * Apply edits, refusing any whose expected text is not present.
 *
 * The `find` check is what makes this safe to run unattended: a plan built from
 * one scan could be applied to a file that has since changed, and blindly
 * splicing at a stale line/column would silently corrupt source. A mismatch is
 * reported, never guessed around.
 */
export async function applyEdits(dir: string, edits: PlannedEdit[]): Promise<EditResult> {
  const applied: PlannedEdit[] = [];
  const failed: Array<{ edit: PlannedEdit; reason: string }> = [];

  const byFile = new Map<string, PlannedEdit[]>();
  for (const e of edits) {
    const list = byFile.get(e.file) ?? [];
    list.push(e);
    byFile.set(e.file, list);
  }

  for (const [file, fileEdits] of byFile) {
    const absPath = path.join(dir, file);
    let content: string;
    try {
      content = await readFile(absPath, 'utf8');
    } catch (err) {
      for (const e of fileEdits) {
        failed.push({ edit: e, reason: `cannot read ${file}: ${(err as Error).message}` });
      }
      continue;
    }

    const lines = content.split('\n');
    // Apply bottom-up and right-to-left so earlier edits never shift the
    // coordinates of ones not yet applied.
    const ordered = [...fileEdits].sort(
      (a, b) => b.line - a.line || b.column - a.column,
    );

    let dirty = false;
    for (const e of ordered) {
      const idx = e.line - 1;
      const line = lines[idx];
      if (line === undefined) {
        failed.push({ edit: e, reason: `${file} has no line ${e.line}` });
        continue;
      }
      const start = e.column - 1;
      const actual = line.slice(start, start + e.find.length);
      if (actual !== e.find) {
        failed.push({
          edit: e,
          reason: `expected "${e.find}" at ${file}:${e.line}:${e.column} but found "${actual}" — file changed since the scan`,
        });
        continue;
      }
      lines[idx] = line.slice(0, start) + e.replace + line.slice(start + e.find.length);
      applied.push(e);
      dirty = true;
    }

    if (dirty) await writeFile(absPath, lines.join('\n'), 'utf8');
  }

  return { applied, failed };
}

/**
 * A located replacement: find this exact text, put that in its place.
 *
 * Deterministic edits only, now. An identical shape called `TextEdit` lived in
 * the model layer, where `find` matching nothing was the fail-closed property
 * that made a proposer safe. The one-writer decision removed the proposer;
 * what still produces these
 * is the rename planner and the manifest rewriter, neither of which consults a
 * model. Two names for four fields was already one too many.
 */
export interface TextEditRequest {
  file: string;
  /** Exact, unique substring to replace. Emend locates it; nothing guesses. */
  find: string;
  replace: string;
  reason: string;
}

export interface TextEditResult {
  applied: TextEditRequest[];
  failed: Array<{ edit: TextEditRequest; reason: string }>;
  /** Original contents, so a failed attempt can be rolled back cleanly. */
  snapshots: Map<string, string>;
}

/**
 * Apply search-and-replace edits, used for agent-proposed migrations.
 *
 * Coordinates are a bad contract for a language model — it cannot reliably count
 * columns. An exact substring is something it *can* produce, because it is
 * copying from source it was shown. Emend then does the locating.
 *
 * Both failure modes are refusals, never guesses:
 *  - not found  -> the model invented or mistyped the text
 *  - ambiguous  -> replacing an arbitrary occurrence could corrupt unrelated code
 */
export async function applyTextEdits(
  dir: string,
  edits: TextEditRequest[],
): Promise<TextEditResult> {
  const applied: TextEditRequest[] = [];
  const failed: Array<{ edit: TextEditRequest; reason: string }> = [];
  const snapshots = new Map<string, string>();

  const byFile = new Map<string, TextEditRequest[]>();
  for (const e of edits) {
    const list = byFile.get(e.file) ?? [];
    list.push(e);
    byFile.set(e.file, list);
  }

  for (const [file, fileEdits] of byFile) {
    const absPath = path.join(dir, file);
    let content: string;
    try {
      content = await readFile(absPath, 'utf8');
    } catch (err) {
      for (const e of fileEdits) {
        failed.push({ edit: e, reason: `cannot read ${file}: ${(err as Error).message}` });
      }
      continue;
    }

    snapshots.set(file, content);
    let working = content;

    for (const e of fileEdits) {
      const occurrences = working.split(e.find).length - 1;
      if (occurrences === 0) {
        failed.push({
          edit: e,
          reason: `text not found in ${file}: ${JSON.stringify(e.find.slice(0, 120))}`,
        });
        continue;
      }
      if (occurrences > 1) {
        failed.push({
          edit: e,
          reason: `text appears ${occurrences} times in ${file}; needs more surrounding context to be unambiguous`,
        });
        continue;
      }
      working = working.replace(e.find, e.replace);
      applied.push(e);
    }

    if (working !== content) await writeFile(absPath, working, 'utf8');
  }

  return { applied, failed, snapshots };
}

/** Restore files captured in a snapshot, undoing a failed attempt. */
export async function restoreSnapshots(
  dir: string,
  snapshots: Map<string, string>,
): Promise<void> {
  for (const [file, content] of snapshots) {
    await writeFile(path.join(dir, file), content, 'utf8').catch(() => {});
  }
}

/** Install the target version of the package being migrated. */
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Which package manager owns this repository, by the lockfile it left behind. */
export async function detectPackageManager(dir: string): Promise<PackageManager> {
  for (const [file, manager] of [
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
  ] as const) {
    if (await exists(path.join(dir, file))) return manager;
  }
  return 'npm';
}

/**
 * The workspace whose manifest declares this package.
 *
 * A monorepo root usually declares nothing. Bumping there would add a
 * dependency the repository never had and leave the workspace that actually
 * uses it untouched — a change that installs cleanly and fixes nothing.
 */
async function declaringWorkspace(dir: string, pkg: string): Promise<string> {
  for (const workspace of await findWorkspaces(dir)) {
    try {
      const manifest = JSON.parse(
        await readFile(path.join(dir, workspace, 'package.json'), 'utf8'),
      ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      if (manifest.dependencies?.[pkg] ?? manifest.devDependencies?.[pkg]) return workspace;
    } catch {
      /* unreadable manifest: try the next workspace */
    }
  }
  return '';
}

/**
 * Bump a dependency in the manifest that declares it, using the repository's own
 * package manager, preserving how it chose to express the range.
 *
 * Three things this gets wrong if done naively, all of which produce a pull
 * request that looks plausible and is not:
 *
 *  - Running `npm install` in a bun or pnpm repository writes a
 *    `package-lock.json` alongside the real lockfile. The diff then contains a
 *    file the project does not use and the lockfile it does use is unchanged.
 *  - Running at the root of a workspace repository edits the root manifest,
 *    which does not declare the package.
 *  - Every manager defaults to a caret range, so an exact pin silently widens.
 *    One scanned repository pins `playwright` exactly and has a test asserting
 *    the pin matches its Docker base image; that test failed on `^1.62.1` alone.
 */
export async function bumpDependency(
  dir: string,
  pkg: string,
  version: string,
  options: { ignoreScripts?: boolean; manager?: PackageManager; workspace?: string } = {},
): Promise<CommandResult> {
  const manager = options.manager ?? (await detectPackageManager(dir));
  const workspace = options.workspace ?? (await declaringWorkspace(dir, pkg));
  const cwd = path.join(dir, workspace);

  let exact = false;
  let prefix: string | undefined;
  try {
    const manifest = JSON.parse(
      await readFile(path.join(cwd, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const declared = manifest.dependencies?.[pkg] ?? manifest.devDependencies?.[pkg] ?? '';
    prefix = declared.match(/^[~^]/)?.[0];
    exact = !prefix && /^\d/.test(declared);
  } catch {
    /* no readable manifest: accept the manager's default range style */
  }

  // Lifecycle scripts are arbitrary code from a repository Emend does not
  // trust. A hosted run against a Prisma repository executed `prisma generate`
  // through a postinstall hook, which also corrupted the verification by
  // repairing a baseline failure mid-run.
  const ignore = options.ignoreScripts === true;

  // bun, pnpm and yarn all record exactly the spec they are handed, so the
  // range operator belongs in the spec rather than in a flag. Passing a bare
  // version turns `^2.15.0` into a hard pin — a real change to how the project
  // takes updates, made silently while migrating something unrelated.
  const spec = `${pkg}@${prefix ?? ''}${version}`;

  if (manager === 'bun') {
    const args = ['add', spec];
    if (exact) args.push('--exact');
    if (ignore) args.push('--ignore-scripts');
    return runCommand('bun', args, cwd);
  }
  if (manager === 'pnpm') {
    const args = ['add', spec];
    if (exact) args.push('--save-exact');
    if (ignore) args.push('--ignore-scripts');
    return runCommand('pnpm', args, cwd);
  }
  if (manager === 'yarn') {
    const args = ['add', spec];
    if (exact) args.push('--exact');
    return runCommand('yarn', args, cwd);
  }

  const args = ['install', `${pkg}@${version}`, '--no-audit', '--no-fund', '--silent'];
  if (prefix) args.push(`--save-prefix=${prefix}`);
  else if (exact) args.push('--save-exact');
  if (ignore) args.push('--ignore-scripts');
  return runCommand('npm', args, cwd);
}

/** Unified diff of the workspace against its base, for the PR body. */
export async function workspaceDiff(ws: Workspace): Promise<string> {
  try {
    // Exclude vendored and lockfile churn: a reviewer needs to see the source
    // edit, not thousands of lines of dependency diff.
    const { stdout } = await execFileAsync(
      'git',
      [
        '-C',
        ws.dir,
        'diff',
        '--',
        '.',
        ':(exclude)package-lock.json',
        ':(exclude)node_modules',
        ':(exclude)**/node_modules/**',
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return '';
  }
}

export async function applyPlan(
  ws: Workspace,
  plan: MigrationPlan,
): Promise<{ edits: EditResult; bump: CommandResult }> {
  const edits = await applyEdits(ws.dir, plan.edits);
  const bump = await bumpDependency(ws.dir, plan.pkg, plan.toVersion);
  return { edits, bump };
}
