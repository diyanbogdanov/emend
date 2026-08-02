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
 * Copy node_modules into the workspace.
 *
 * On macOS/APFS `cp -c` uses clonefile, so this is near-instant and costs no disk
 * even for a large tree. Reinstalling from scratch instead would add minutes per
 * run for no benefit — we bump only the one package under migration afterwards.
 */
async function copyNodeModules(from: string, to: string): Promise<boolean> {
  const src = path.join(from, 'node_modules');
  if (!(await exists(src))) return false;
  const dst = path.join(to, 'node_modules');
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
      return true;
    } catch {
      /* try next strategy */
    }
  }
  return false;
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

export interface TextEditRequest {
  file: string;
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
export async function bumpDependency(
  dir: string,
  pkg: string,
  version: string,
): Promise<CommandResult> {
  return runCommand(
    'npm',
    ['install', `${pkg}@${version}`, '--no-audit', '--no-fund', '--silent'],
    dir,
  );
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
