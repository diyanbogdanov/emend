/**
 * Reading the files of a repository being scanned — and only those.
 *
 * The hosted App clones repositories it has no reason to trust, and git
 * records symlinks faithfully: `requirements.txt -> /etc/passwd` is an
 * ordinary commit. Read through, that file was parsed as requirements and each
 * of its lines printed back as a package name; a `package.json` linked the same
 * way had its first bytes quoted in the JSON parse error. So a path is judged
 * by where it really leads, not by where it sits in the checkout.
 *
 * A link that stays inside the repository is still the repository's own file
 * and is read. `node_modules` is never read through here: Emend links it into
 * its own package cache on purpose (see `vendor.ts`).
 */

import { lstatSync, realpathSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

/** Whether `target` is `root` or below it. Both must already be real paths. */
export function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** A repository file that is a link to somewhere outside the repository. */
export class OutsideRepositoryError extends Error {
  constructor(relative: string) {
    super(`${relative} is a link to outside the repository — not read`);
    this.name = 'OutsideRepositoryError';
  }
}

/**
 * The text of `relative` inside `repoDir`, refused with `OutsideRepositoryError`
 * when its real path is outside the repository. A missing file rejects the way
 * `readFile` does, so callers that treat absence as absence keep doing so.
 */
export async function readRepoFile(repoDir: string, relative: string): Promise<string> {
  const real = await realpath(path.join(repoDir, relative));
  if (!within(await realpath(repoDir), real)) throw new OutsideRepositoryError(relative);
  return readFile(real, 'utf8');
}

/**
 * Whether `p` is a symlink whose real path is outside `root` (already real).
 * A dangling link answers false: there is nothing at the other end to read,
 * and the read that follows fails the ordinary way.
 */
export function linksOutside(root: string, p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink() && !within(root, realpathSync(p));
  } catch {
    return false;
  }
}
