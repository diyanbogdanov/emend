#!/usr/bin/env node
/**
 * Launcher for the Emend CLI.
 *
 * Emend runs its TypeScript sources directly through Node's native type
 * stripping, so there is no build step to run or keep in sync. This shim exists
 * only to pass the required flags.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { totalmem } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..', 'src', 'cli.ts');

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
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    cli,
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);

child.on('close', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
