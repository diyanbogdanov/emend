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
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..', 'src', 'cli.ts');

const child = spawn(
  process.execPath,
  ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', cli, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

child.on('close', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
