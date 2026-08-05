/**
 * Finds the manifests a repository actually declares dependencies in.
 *
 * Reading only the root `package.json` is right for a single-package repo and
 * badly wrong for a monorepo, where the root typically declares a handful of
 * tooling devDependencies and every real dependency lives in `packages/*`.
 * Emend reported a private monorepo as having zero findings across 865 resolved
 * packages for exactly this reason — not because the repository was clean, but
 * because it never looked at the six manifests that matter.
 *
 * That failure mode is the expensive one. A missed feature is visible; a
 * confident "no findings" is trusted.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/** Bounds discovery on repositories with pathological directory counts. */
const MAX_WORKSPACES = 200;
const MAX_GLOB_DEPTH = 6;

interface RootManifest {
  workspaces?: string[] | { packages?: string[] };
}

/**
 * Workspace globs declared by the repository.
 *
 * npm, yarn and bun use `workspaces` in package.json; pnpm uses a separate
 * `pnpm-workspace.yaml`. The pnpm file needs only its `packages:` list, which is
 * a flat sequence of strings and readable line by line — consistent with how the
 * lockfile parsers avoid taking on a YAML dependency.
 */
async function readWorkspaceGlobs(repoDir: string): Promise<string[]> {
  const globs: string[] = [];

  try {
    const manifest = JSON.parse(
      await readFile(path.join(repoDir, 'package.json'), 'utf8'),
    ) as RootManifest;
    const declared = Array.isArray(manifest.workspaces)
      ? manifest.workspaces
      : manifest.workspaces?.packages;
    if (Array.isArray(declared)) {
      for (const g of declared) if (typeof g === 'string') globs.push(g);
    }
  } catch {
    /* no readable root manifest; the caller reports that separately */
  }

  try {
    const yaml = await readFile(path.join(repoDir, 'pnpm-workspace.yaml'), 'utf8');
    let inPackages = false;
    for (const line of yaml.split('\n')) {
      if (/^[a-zA-Z]/.test(line)) inPackages = /^packages:/.test(line);
      if (!inPackages) continue;
      const item = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/)?.[1];
      if (item) globs.push(item.trim());
    }
  } catch {
    /* not a pnpm workspace */
  }

  return globs;
}

/**
 * Expand a workspace glob to directories that contain a package.json.
 *
 * Only the subset of glob syntax workspace fields actually use is supported:
 * literal segments, `*` for one path segment, and `**` for any depth. Negations
 * (`!packages/excluded`) are handled by the caller.
 */
async function expandGlob(
  repoDir: string,
  glob: string,
  found: Set<string>,
): Promise<void> {
  const segments = glob.split('/').filter((s) => s !== '' && s !== '.');

  const walk = async (dir: string, index: number, depth: number): Promise<void> => {
    if (found.size >= MAX_WORKSPACES || depth > MAX_GLOB_DEPTH) return;

    if (index >= segments.length) {
      const rel = path.relative(repoDir, dir).split(path.sep).join('/');
      try {
        await readFile(path.join(dir, 'package.json'), 'utf8');
        if (rel !== '') found.add(rel);
      } catch {
        /* a matched directory without a manifest is not a workspace */
      }
      return;
    }

    const segment = segments[index] ?? '';
    if (segment === '**') {
      // `**` matches here and at any depth below.
      await walk(dir, index + 1, depth);
      for (const child of await subdirectories(dir)) {
        await walk(child, index, depth + 1);
      }
      return;
    }
    if (segment.includes('*')) {
      const re = new RegExp(`^${segment.split('*').map(escapeRegex).join('.*')}$`);
      for (const child of await subdirectories(dir)) {
        if (re.test(path.basename(child))) await walk(child, index + 1, depth + 1);
      }
      return;
    }
    await walk(path.join(dir, segment), index + 1, depth + 1);
  };

  await walk(repoDir, 0, 0);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function subdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Every manifest directory in the repository, root first.
 *
 * Returns `['']` for a single-package repository, so callers have one code path
 * rather than a special case.
 */
export async function findWorkspaces(repoDir: string): Promise<string[]> {
  const globs = await readWorkspaceGlobs(repoDir);
  if (globs.length === 0) return [''];

  const positive = globs.filter((g) => !g.startsWith('!'));
  const negated = globs
    .filter((g) => g.startsWith('!'))
    .map((g) => g.slice(1).replace(/\/$/, ''));

  const found = new Set<string>();
  for (const glob of positive) {
    await expandGlob(repoDir, glob.replace(/\/$/, ''), found);
  }

  const excluded = new Set<string>();
  for (const glob of negated) {
    await expandGlob(repoDir, glob, excluded);
  }

  return ['', ...[...found].filter((w) => !excluded.has(w)).sort()];
}
