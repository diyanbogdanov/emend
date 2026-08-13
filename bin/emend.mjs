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
 * `node_modules` and offers no way to ask it to. So that — being installed — is
 * the question, and it is asked directly rather than through a proxy for it.
 *
 * Both proxies were tried first and both are wrong in one layout each. "Prefer
 * the bundle when it exists" is a trap in a checkout: one `npm pack` leaves a
 * `dist/` behind, and from then on every run silently executes it while the
 * developer edits files that no longer do anything. "Prefer the sources when
 * they exist" is a trap the other way: `npm install github:…` puts the whole
 * repository under `node_modules`, sources and all, which is precisely the case
 * Node refuses. Node's own rule is the only one true in both.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { totalmem } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const sources = path.resolve(here, '..', 'src', 'cli.ts');
const bundle = path.resolve(here, '..', 'dist', 'cli.js');
const installed = here.split(path.sep).includes('node_modules');
const cli = installed ? bundle : sources;

// An install with no bundle cannot run at all, and the error Node gives for it
// names a `.ts` file and a constant nobody has heard of. Say what is actually
// missing instead: `prepare` builds it, so getting here means the package was
// assembled by hand or the build was skipped.
if (installed && !existsSync(bundle)) {
  console.error(
    `emend: installed without its bundle — ${bundle} does not exist.\n` +
      'The published package cannot run from TypeScript sources: Node declines to\n' +
      'strip types under node_modules. Reinstall from npm, or run `npm run build`\n' +
      'in the source of this install.',
  );
  process.exit(1);
}

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
    ...(installed ? [] : ['--experimental-strip-types']),
    cli,
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);

child.on('close', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
