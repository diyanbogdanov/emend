#!/usr/bin/env node
/**
 * Launcher for the Emend CLI.
 *
 * Emend runs its TypeScript sources directly through Node's native type
 * stripping, so a checkout has no build step to run or keep in sync. This shim
 * exists to pass the required flags — and to pick which of the two things it is
 * launching.
 *
 * There are two because Node refuses to strip types for files under
 * `node_modules` and offers no way to ask it to. From a checkout the sources run
 * as they always have; an installed package runs `dist/cli.js`, which
 * `npm run build` produces and `prepack` guarantees is there. Preferring the
 * bundle only when it exists keeps development on the sources, where a change
 * takes effect when it is saved rather than when it is rebuilt.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { totalmem } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.resolve(here, '..', 'dist', 'cli.js');
const sources = path.resolve(here, '..', 'src', 'cli.ts');
const bundled = existsSync(bundle);
const cli = bundled ? bundle : sources;

/**
 * Give V8 most of the machine rather than its default ceiling.
 *
 * A package's whole type surface is held in memory while it is analysed, and
 * the largest measured — googleapis, at 400,630 symbols — needs roughly 3 GB on
 * its own. Node's default heap is well under that, so an uncapped walk would die
 * with an out-of-memory abort rather than a finding. Three quarters of physical
 * memory leaves room for the OS and the TypeScript compiler's own allocations.
 */
const heapMb = Math.max(2048, Math.floor((totalmem() / 1024 / 1024) * 0.75));

const child = spawn(
  process.execPath,
  [
    `--max-old-space-size=${heapMb}`,
    // Both layouts want the warning gone — `node:sqlite` is experimental
    // whatever the code was written in, and it announces itself on every
    // command. Only the stripping is about which of the two is running.
    '--disable-warning=ExperimentalWarning',
    ...(bundled ? [] : ['--experimental-strip-types']),
    cli,
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);

child.on('close', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
