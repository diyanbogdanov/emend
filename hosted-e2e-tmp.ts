/**
 * The hosted output path, end to end, minus the App token exchange.
 *
 * Everything here is what runOneJob does: fetch a tarball, stage dependencies,
 * scan, migrate with tests disabled, and open a draft PR through the API. This
 * exercises openPullRequest, changedFiles and recordPullRequest, none of which
 * had ever run.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fetchRepoTarball, repoKey } from './src/github/app.ts';
import { scanRepo } from './src/analyze.ts';
import { proposeMigrations } from './src/github/runner.ts';
import { Store } from './src/store.ts';

const token = process.env.GH_TOKEN!;
const OWNER = 'a private organisation', NAME = 'a scanned repository';
const key = repoKey(OWNER, NAME);

const dir = await fetchRepoTarball(token, OWNER, NAME, 'main');
try {
  const report = await scanRepo(dir, { repoKey: key, vendorDeps: true, only: ['playwright'] });
  console.log(`\n  scan: ${report.counts.breaking} breaking, ${report.counts.callSites} call site(s)`);

  const store = new Store();
  store.upsertInstallation(1, OWNER);
  store.upsertRepo({ repoKey: key, installationId: 1, owner: OWNER, name: NAME, defaultBranch: 'main' });
  store.recordScan(report, `${OWNER}/${NAME}`);

  const opened = await proposeMigrations({
    store, token,
    log: (m) => console.log(`  ${m}`),
    repo: { repoKey: key, owner: OWNER, name: NAME },
    baseBranch: 'main',
    workdir: dir,
    report,
    useAgent: true,
  });
  console.log(`\n  pull requests opened/updated: ${opened}`);
  for (const pr of store.listPullRequests(key)) {
    console.log(`    #${pr.number} ${pr.branch} ci=${pr.ciStatus} ${pr.url}`);
  }
  store.close();
} finally {
  await rm(path.dirname(dir), { recursive: true, force: true });
}
