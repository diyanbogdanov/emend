/**
 * Skills that live on disk, so the ones Emend ships and the ones you supply are
 * the same kind of thing.
 *
 * `skills.ts` holds the fragments Emend's own tasks are built from — narrowing,
 * the write-and-report contract — which are part of the tool and change when the
 * tool does. This module is for the other kind: the standards a *reviewer*
 * applies, which are a house opinion and should be swappable without forking.
 *
 * The format is the one already in circulation for this: a directory containing
 * `SKILL.md`, with optional YAML frontmatter for metadata and a markdown body
 * that is the instruction. Emend reads the body verbatim and never interprets
 * it — a skill is a payload handed to a model, not a program Emend runs.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { emendPath } from '../paths.ts';
import type { Skill } from './skills.ts';

/** Where the shipped skills live: `<package>/skills/<name>/SKILL.md`. */
function builtInRoot(): string {
  return emendPath('skills');
}

/**
 * Strip a leading YAML frontmatter block.
 *
 * Metadata, not instruction. A `description:` written for a skill index reads to
 * a model as a rule about descriptions, and the whole point of loading a file
 * verbatim is that what the model sees is what the author wrote.
 */
function splitFrontmatter(source: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { meta: {}, body: source };

  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (kv?.[1]) meta[kv[1]] = (kv[2] ?? '').trim();
  }
  return { meta, body: source.slice(match[0].length) };
}

/**
 * Load a skill by built-in name or by path.
 *
 * Accepts the directory or the `SKILL.md` inside it, because both are what
 * someone means. Throws rather than returning undefined: a review that silently
 * ran under different rules than the operator named is a review nobody chose,
 * reported as though they had.
 */
export function loadSkill(nameOrPath: string): Skill {
  const candidates = [
    path.join(builtInRoot(), nameOrPath, 'SKILL.md'),
    path.resolve(nameOrPath),
    path.join(path.resolve(nameOrPath), 'SKILL.md'),
  ];
  const file = candidates.find((c) => existsSync(c) && c.endsWith('.md'));
  if (!file) {
    throw new Error(
      `no SKILL.md for "${nameOrPath}" — looked in ${candidates.join(', ')}. ` +
        `Built-in skills: ${BUILT_IN_SKILLS.map((s) => s.name).join(', ')}`,
    );
  }

  const { meta, body } = splitFrontmatter(readFileSync(file, 'utf8'));
  return {
    // The directory name is the fallback, so a skill without frontmatter is
    // still a skill rather than an error about metadata.
    name: meta['name'] ?? path.basename(path.dirname(file)),
    text: body.trim(),
  };
}

/** Every skill shipped in this repository. */
export const BUILT_IN_SKILLS: Skill[] = readdirSync(builtInRoot(), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => loadSkill(e.name));

/**
 * The quality standard a review applies unless told otherwise.
 *
 * Swappable on purpose — what counts as good code is a house opinion, and
 * hard-coding one would make disagreeing with Emend a fork.
 */
export const REVIEW_SKILL_DEFAULT = 'thermo-nuclear-code-quality-review';

/**
 * What a migration must do to be finished, whatever the quality skill says.
 *
 * Not swappable, and composed *under* the quality skill rather than replaced by
 * it. The two answer different questions: this one is "did the migration do what
 * it reported", the other is "is the result good code". A quality skill that
 * displaced this would review the elegance of a migration that never removed the
 * deprecated call — which is the failure zod's corpus case exists to catch.
 */
export const COMPLETENESS_SKILL = 'migration-completeness';
