/**
 * Persistence for scans, findings, and fix runs.
 *
 * Uses node:sqlite so there is no native build step and no dependency to install.
 * The store is what makes findings *trackable* rather than recomputed: a finding
 * keeps its identity across scans (see the fingerprint in analyze.ts), so the
 * dashboard can show whether something is new, still open, or fixed.
 */

import { DatabaseSync } from 'node:sqlite';
import type { FixedRecord } from './remediate.ts';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Finding, ScanReport, VerificationReport } from './types.ts';

export const DEFAULT_DB_PATH =
  process.env.EMEND_DB ?? path.join(homedir(), '.emend', 'emend.db');

/**
 * What one scan changed, relative to the last one of the same repository.
 *
 * The unit a scheduled run reports. Findings are identified by the fingerprint
 * in analyze.ts, which is what makes "the same finding" survive across scans.
 */
export interface ScanDelta {
  scanId: number;
  /** No previous scan, so nothing here is news — this run is the baseline. */
  first: boolean;
  /** Finding ids never recorded for this repository before. */
  added: string[];
  /** Finding ids that were fixed and are open again. */
  returned: string[];
  /** Finding ids that were open and are now absent. */
  resolved: string[];
}

/** What the store holds for one repository, enough to decide whether to keep it. */
export interface StoredRepoData {
  repoDir: string;
  /** The name the most recent scan gave it. */
  repoName: string;
  scans: number;
  findings: number;
  runs: number;
  lastScanned: string;
}

/** What a prune deleted, reported so that deleting nothing is visibly nothing. */
export interface PrunedCounts {
  scans: number;
  findings: number;
  runs: number;
  fixedVulnerabilities: number;
}

export interface StoredScan {
  id: number;
  repoDir: string;
  repoName: string;
  startedAt: string;
  finishedAt: string;
  counts: ScanReport['counts'];
  warnings: string[];
}

export interface StoredFinding {
  findingId: string;
  scanId: number;
  repoDir: string;
  finding: Finding;
  firstSeen: string;
  lastSeen: string;
  status: 'open' | 'fixed' | 'dismissed';
}

export interface StoredRun {
  id: number;
  findingId: string;
  outcome: string;
  summary: string;
  createdAt: string;
  report: VerificationReport | null;
  planRationale: string | null;
  diff: string | null;
  /**
   * Which model produced this migration, or null when the deterministic planner
   * did it alone.
   *
   * Recorded because model quality is not visible in the outcome. Two models can
   * both verify and still differ in what they left behind — one narrowing a union
   * correctly, another coercing it and silently rendering a real string as "0".
   * Without this column that difference is unattributable after the fact, so a
   * regression introduced by changing EMEND_LLM_MODEL cannot be traced to it.
   */
  agent: { model: string; provider: string } | null;
}

export interface TrackedRepo {
  repoKey: string;
  installationId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  addedAt: string;
  lastScannedAt: string | null;
}

export interface PullRequestRecord {
  repoKey: string;
  number: number;
  branch: string;
  url: string;
  findingIds: string[];
  openedAt: string;
  /** 'pending' until the customer's CI reports. Never assume it passed. */
  ciStatus: string;
  ciCheckedAt: string | null;
}

export interface Job {
  id: number;
  repoKey: string;
  ref: string;
  kind: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

function toTrackedRepo(r: Record<string, string | number>): TrackedRepo {
  return {
    repoKey: String(r['repo_key']),
    installationId: Number(r['installation_id']),
    owner: String(r['owner']),
    name: String(r['name']),
    defaultBranch: String(r['default_branch']),
    addedAt: String(r['added_at']),
    lastScannedAt: r['last_scanned_at'] ? String(r['last_scanned_at']) : null,
  };
}

function toJob(r: Record<string, string | number>): Job {
  return {
    id: Number(r['id']),
    repoKey: String(r['repo_key']),
    ref: String(r['ref']),
    kind: String(r['kind']),
    status: String(r['status']) as Job['status'],
    attempts: Number(r['attempts']),
    createdAt: String(r['created_at']),
    startedAt: r['started_at'] ? String(r['started_at']) : null,
    finishedAt: r['finished_at'] ? String(r['finished_at']) : null,
    error: r['error'] ? String(r['error']) : null,
  };
}

export class Store {
  #db: DatabaseSync;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS scans (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_dir     TEXT NOT NULL,
        repo_name    TEXT NOT NULL,
        started_at   TEXT NOT NULL,
        finished_at  TEXT NOT NULL,
        counts_json  TEXT NOT NULL,
        warnings_json TEXT NOT NULL,
        packages_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS findings (
        finding_id   TEXT NOT NULL,
        repo_dir     TEXT NOT NULL,
        scan_id      INTEGER NOT NULL,
        finding_json TEXT NOT NULL,
        first_seen   TEXT NOT NULL,
        last_seen    TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'open',
        PRIMARY KEY (finding_id, repo_dir)
      );

      CREATE TABLE IF NOT EXISTS runs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        finding_id     TEXT NOT NULL,
        repo_dir       TEXT NOT NULL,
        outcome        TEXT NOT NULL,
        summary        TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        report_json    TEXT,
        plan_rationale TEXT,
        diff           TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_findings_repo ON findings(repo_dir, status);
      CREATE INDEX IF NOT EXISTS idx_runs_finding ON runs(finding_id);

      -- Hosted service. A local CLI install simply leaves these empty.
      -- Vulnerabilities that were fixed once, so a later scan can tell a
      -- reintroduction from a new finding. Without it a revert or a lockfile
      -- regenerated from a stale branch arrives looking brand new, and the fact
      -- that it was already dealt with is lost.
      CREATE TABLE IF NOT EXISTS fixed_vulnerabilities (
        repo_dir   TEXT NOT NULL,
        pkg        TEXT NOT NULL,
        fixed_at   TEXT NOT NULL,
        advisories TEXT NOT NULL,
        recorded   TEXT NOT NULL,
        PRIMARY KEY (repo_dir, pkg)
      );

      CREATE TABLE IF NOT EXISTS installations (
        installation_id INTEGER PRIMARY KEY,
        account         TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        suspended_at    TEXT
      );

      CREATE TABLE IF NOT EXISTS repos (
        repo_key        TEXT PRIMARY KEY,
        installation_id INTEGER NOT NULL,
        owner           TEXT NOT NULL,
        name            TEXT NOT NULL,
        default_branch  TEXT NOT NULL,
        added_at        TEXT NOT NULL,
        last_scanned_at TEXT,
        removed_at      TEXT
      );

      -- The job queue. SQLite is the broker: at design-partner scale a separate
      -- queue service would be infrastructure without a corresponding problem.
      CREATE TABLE IF NOT EXISTS jobs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_key     TEXT NOT NULL,
        ref          TEXT NOT NULL,
        kind         TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'queued',
        attempts     INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        started_at   TEXT,
        finished_at  TEXT,
        error        TEXT
      );

      -- Pull requests Emend opened, and what the customer's CI made of them.
      --
      -- The hosted path cannot verify a migration itself: running a repository's
      -- tests is the code execution the scan path deliberately avoids. So the
      -- customer's own CI is the verifier, and its verdict arrives after the PR
      -- rather than before. Until it does, ci_status stays 'pending' and must
      -- never be presented as passing.
      CREATE TABLE IF NOT EXISTS pull_requests (
        repo_key    TEXT NOT NULL,
        number      INTEGER NOT NULL,
        branch      TEXT NOT NULL,
        head_sha    TEXT,
        url         TEXT NOT NULL,
        finding_ids TEXT NOT NULL,
        opened_at   TEXT NOT NULL,
        ci_status   TEXT NOT NULL DEFAULT 'pending',
        ci_checked_at TEXT,
        PRIMARY KEY (repo_key, number)
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, id);
      CREATE INDEX IF NOT EXISTS idx_repos_install ON repos(installation_id);
      CREATE INDEX IF NOT EXISTS idx_pr_branch ON pull_requests(branch);
    `);

    // Columns added after a database already exists. `CREATE TABLE IF NOT EXISTS`
    // above is a no-op on an existing table, so every later column needs this.
    this.#addColumn('runs', 'agent_model', 'TEXT');
    this.#addColumn('runs', 'agent_provider', 'TEXT');
  }

  /**
   * Add a column unless it is already there.
   *
   * SQLite has no `ADD COLUMN IF NOT EXISTS`, and re-adding raises a plain error
   * that is only distinguishable by message — too fragile to catch. So the
   * existing columns are read first. Nullable by design: back-filling a value
   * for rows that predate the column would be inventing history, and here a null
   * genuinely means "we do not know", not "no agent ran".
   */
  #addColumn(table: string, column: string, definition: string): void {
    // Table and column are internal literals, never user input; PRAGMA does not
    // accept bound parameters for its argument.
    const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (columns.some((c) => c.name === column)) return;
    this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  recordPullRequest(pr: {
    repoKey: string;
    number: number;
    branch: string;
    url: string;
    findingIds: string[];
  }): void {
    this.#db
      .prepare(
        `INSERT INTO pull_requests (repo_key, number, branch, url, finding_ids, opened_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_key, number) DO UPDATE SET
           finding_ids = excluded.finding_ids,
           ci_status = 'pending',
           ci_checked_at = NULL`,
      )
      .run(
        pr.repoKey,
        pr.number,
        pr.branch,
        pr.url,
        JSON.stringify(pr.findingIds),
        new Date().toISOString(),
      );
  }

  /**
   * Record a CI verdict for whichever PR is on this branch.
   *
   * Keyed by branch because `check_suite` identifies the head branch, not the
   * pull request. A no-op when the branch is not one Emend opened — the App also
   * receives check events for every other push to the repository.
   */
  recordCiResult(repoKey: string, branch: string, headSha: string, status: string): boolean {
    const result = this.#db
      .prepare(
        `UPDATE pull_requests SET ci_status = ?, ci_checked_at = ?, head_sha = ?
         WHERE repo_key = ? AND branch = ?`,
      )
      .run(status, new Date().toISOString(), headSha, repoKey, branch);
    return result.changes > 0;
  }

  listPullRequests(repoKey?: string): PullRequestRecord[] {
    const rows = (
      repoKey
        ? this.#db
            .prepare(`SELECT * FROM pull_requests WHERE repo_key = ? ORDER BY opened_at DESC`)
            .all(repoKey)
        : this.#db.prepare(`SELECT * FROM pull_requests ORDER BY opened_at DESC`).all()
    ) as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      repoKey: String(r['repo_key']),
      number: Number(r['number']),
      branch: String(r['branch']),
      url: String(r['url']),
      findingIds: JSON.parse(String(r['finding_ids'])) as string[],
      openedAt: String(r['opened_at']),
      ciStatus: String(r['ci_status']),
      ciCheckedAt: r['ci_checked_at'] ? String(r['ci_checked_at']) : null,
    }));
  }

  /**
   * Record that a vulnerability was cleared, and at which version.
   *
   * Only ever called after a verified fix. Recording an attempt would make the
   * regression guard fire on a package that was never actually repaired.
   */
  recordVulnerabilityFixed(repoDir: string, pkg: string, fixedAt: string, advisories: string[]): void {
    this.#db
      .prepare(
        `INSERT INTO fixed_vulnerabilities (repo_dir, pkg, fixed_at, advisories, recorded)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(repo_dir, pkg) DO UPDATE SET
           fixed_at   = excluded.fixed_at,
           advisories = excluded.advisories,
           recorded   = excluded.recorded`,
      )
      .run(repoDir, pkg, fixedAt, JSON.stringify(advisories), new Date().toISOString());
  }

  /** Everything this repository has had fixed, for the regression guard. */
  fixedVulnerabilities(repoDir: string): FixedRecord[] {
    const rows = this.#db
      .prepare('SELECT pkg, fixed_at, advisories FROM fixed_vulnerabilities WHERE repo_dir = ?')
      .all(repoDir) as Array<{ pkg: string; fixed_at: string; advisories: string }>;
    return rows.map((r) => {
      let advisories: string[] = [];
      try {
        advisories = JSON.parse(r.advisories) as string[];
      } catch {
        advisories = [];
      }
      return { pkg: r.pkg, fixedAt: r.fixed_at, advisories };
    });
  }

  // ---------------------------------------------------------------------------
  // Hosted service: installations, repositories, and the job queue.
  // ---------------------------------------------------------------------------

  upsertInstallation(installationId: number, account: string): void {
    this.#db
      .prepare(
        `INSERT INTO installations (installation_id, account, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(installation_id) DO UPDATE SET account = excluded.account, suspended_at = NULL`,
      )
      .run(installationId, account, new Date().toISOString());
  }

  suspendInstallation(installationId: number): void {
    this.#db
      .prepare(`UPDATE installations SET suspended_at = ? WHERE installation_id = ?`)
      .run(new Date().toISOString(), installationId);
  }

  upsertRepo(repo: {
    repoKey: string;
    installationId: number;
    owner: string;
    name: string;
    defaultBranch: string;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO repos (repo_key, installation_id, owner, name, default_branch, added_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_key) DO UPDATE SET
           installation_id = excluded.installation_id,
           default_branch = excluded.default_branch,
           removed_at = NULL`,
      )
      .run(
        repo.repoKey,
        repo.installationId,
        repo.owner,
        repo.name,
        repo.defaultBranch,
        new Date().toISOString(),
      );
  }

  removeRepo(repoKey: string): void {
    this.#db
      .prepare(`UPDATE repos SET removed_at = ? WHERE repo_key = ?`)
      .run(new Date().toISOString(), repoKey);
  }

  getRepo(repoKey: string): TrackedRepo | null {
    const row = this.#db
      .prepare(`SELECT * FROM repos WHERE repo_key = ? AND removed_at IS NULL`)
      .get(repoKey) as Record<string, string | number> | undefined;
    return row ? toTrackedRepo(row) : null;
  }

  listRepos(installationId?: number): TrackedRepo[] {
    const rows = (
      installationId === undefined
        ? this.#db
            .prepare(`SELECT * FROM repos WHERE removed_at IS NULL ORDER BY repo_key`)
            .all()
        : this.#db
            .prepare(
              `SELECT * FROM repos WHERE installation_id = ? AND removed_at IS NULL ORDER BY repo_key`,
            )
            .all(installationId)
    ) as Array<Record<string, string | number>>;
    return rows.map(toTrackedRepo);
  }

  markRepoScanned(repoKey: string): void {
    this.#db
      .prepare(`UPDATE repos SET last_scanned_at = ? WHERE repo_key = ?`)
      .run(new Date().toISOString(), repoKey);
  }

  /**
   * Queue a scan, collapsing duplicates.
   *
   * A push burst produces many events for one repository; scanning each would
   * waste work and race on the findings table. An already-queued job for the
   * same repository is updated to the newest ref instead of stacking.
   */
  enqueueJob(repoKey: string, ref: string, kind: 'scan' = 'scan'): number {
    const pending = this.#db
      .prepare(`SELECT id FROM jobs WHERE repo_key = ? AND kind = ? AND status = 'queued'`)
      .get(repoKey, kind) as { id: number } | undefined;
    if (pending) {
      this.#db.prepare(`UPDATE jobs SET ref = ?, created_at = ? WHERE id = ?`).run(
        ref,
        new Date().toISOString(),
        pending.id,
      );
      return pending.id;
    }
    const result = this.#db
      .prepare(
        `INSERT INTO jobs (repo_key, ref, kind, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(repoKey, ref, kind, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  /**
   * Claim the oldest queued job.
   *
   * The UPDATE ... WHERE status = 'queued' is the claim: SQLite serialises
   * writers, so two runners cannot both take the same row.
   */
  claimJob(): Job | null {
    const row = this.#db
      .prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1`)
      .get() as Record<string, string | number> | undefined;
    if (!row) return null;

    const claimed = this.#db
      .prepare(
        `UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1
         WHERE id = ? AND status = 'queued'`,
      )
      .run(new Date().toISOString(), Number(row['id']));
    if (claimed.changes === 0) return null; // another runner won the race

    return toJob(row);
  }

  finishJob(id: number, error?: string): void {
    this.#db
      .prepare(
        `UPDATE jobs SET status = ?, finished_at = ?, error = ? WHERE id = ?`,
      )
      .run(error ? 'failed' : 'done', new Date().toISOString(), error ?? null, id);
  }

  listJobs(limit = 50): Job[] {
    const rows = this.#db
      .prepare(`SELECT * FROM jobs ORDER BY id DESC LIMIT ?`)
      .all(limit) as Array<Record<string, string | number>>;
    return rows.map(toJob);
  }

  recordScan(report: ScanReport, repoName: string): ScanDelta {
    const now = new Date().toISOString();

    // Read the prior state before the upsert overwrites it. A scheduled scan is
    // only worth reading if it says what changed; without this every run reports
    // the same sixty-three advisories and trains the reader to skip it, which is
    // how security tooling actually fails.
    const before = new Map<string, string>(
      (
        this.#db
          .prepare(`SELECT finding_id, status FROM findings WHERE repo_dir = ?`)
          .all(report.repo) as Array<{ finding_id: string; status: string }>
      ).map((r) => [r.finding_id, r.status]),
    );
    const scanned = Number(
      (
        this.#db
          .prepare(`SELECT COUNT(*) AS n FROM scans WHERE repo_dir = ?`)
          .get(report.repo) as { n: number }
      ).n,
    );
    const insertScan = this.#db.prepare(`
      INSERT INTO scans (repo_dir, repo_name, started_at, finished_at, counts_json, warnings_json, packages_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = insertScan.run(
      report.repo,
      repoName,
      report.startedAt,
      report.finishedAt,
      JSON.stringify(report.counts),
      JSON.stringify(report.warnings),
      JSON.stringify(report.packages),
    );
    const scanId = Number(result.lastInsertRowid);

    const findings = report.packages.flatMap((p) => p.findings);
    const upsert = this.#db.prepare(`
      INSERT INTO findings (finding_id, repo_dir, scan_id, finding_json, first_seen, last_seen, status)
      VALUES (?, ?, ?, ?, ?, ?, 'open')
      ON CONFLICT(finding_id, repo_dir) DO UPDATE SET
        scan_id = excluded.scan_id,
        finding_json = excluded.finding_json,
        last_seen = excluded.last_seen,
        -- A finding that reappears after being marked fixed is open again.
        status = CASE WHEN findings.status = 'dismissed' THEN 'dismissed' ELSE 'open' END
    `);
    for (const f of findings) {
      upsert.run(f.id, report.repo, scanId, JSON.stringify(f), now, now);
    }

    // Findings present in an earlier scan but absent now are resolved.
    const currentIds = new Set(findings.map((f) => f.id));
    const existing = this.#db
      .prepare(`SELECT finding_id FROM findings WHERE repo_dir = ? AND status = 'open'`)
      .all(report.repo) as Array<{ finding_id: string }>;
    const close = this.#db.prepare(
      `UPDATE findings SET status = 'fixed', last_seen = ? WHERE finding_id = ? AND repo_dir = ?`,
    );
    for (const row of existing) {
      if (!currentIds.has(row.finding_id)) close.run(now, row.finding_id, report.repo);
    }

    // On the first scan everything is unseen, and calling all of it "new" is
    // true and useless. A baseline is not news.
    const first = scanned === 0;
    return {
      scanId,
      first,
      added: first ? [] : findings.filter((f) => !before.has(f.id)).map((f) => f.id),
      // Distinct from `added`, because a finding that was fixed and came back is
      // a revert or a stale merge — and that it was already dealt with once is
      // the most useful thing to know about it. Dismissed findings stay
      // dismissed and are news in neither sense.
      returned: first ? [] : findings.filter((f) => before.get(f.id) === 'fixed').map((f) => f.id),
      resolved: [...before]
        .filter(([id, status]) => status === 'open' && !currentIds.has(id))
        .map(([id]) => id),
    };
  }

  listScans(limit = 50): StoredScan[] {
    const rows = this.#db
      .prepare(
        `SELECT id, repo_dir, repo_name, started_at, finished_at, counts_json, warnings_json
         FROM scans ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      id: Number(r['id']),
      repoDir: String(r['repo_dir']),
      repoName: String(r['repo_name']),
      startedAt: String(r['started_at']),
      finishedAt: String(r['finished_at']),
      counts: JSON.parse(String(r['counts_json'])) as ScanReport['counts'],
      warnings: JSON.parse(String(r['warnings_json'])) as string[],
    }));
  }

  latestScanPackages(repoDir?: string): ScanReport['packages'] {
    const row = repoDir
      ? (this.#db
          .prepare(`SELECT packages_json FROM scans WHERE repo_dir = ? ORDER BY id DESC LIMIT 1`)
          .get(repoDir) as Record<string, string> | undefined)
      : (this.#db
          .prepare(`SELECT packages_json FROM scans ORDER BY id DESC LIMIT 1`)
          .get() as Record<string, string> | undefined);
    if (!row) return [];
    return JSON.parse(String(row['packages_json'])) as ScanReport['packages'];
  }

  listFindings(repoDir?: string): StoredFinding[] {
    const rows = (
      repoDir
        ? this.#db
            .prepare(
              `SELECT * FROM findings WHERE repo_dir = ? ORDER BY status, finding_id`,
            )
            .all(repoDir)
        : this.#db.prepare(`SELECT * FROM findings ORDER BY status, finding_id`).all()
    ) as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      findingId: String(r['finding_id']),
      scanId: Number(r['scan_id']),
      repoDir: String(r['repo_dir']),
      finding: JSON.parse(String(r['finding_json'])) as Finding,
      firstSeen: String(r['first_seen']),
      lastSeen: String(r['last_seen']),
      status: String(r['status']) as StoredFinding['status'],
    }));
  }

  getFinding(findingId: string, repoDir?: string): StoredFinding | null {
    const row = (
      repoDir
        ? this.#db
            .prepare(`SELECT * FROM findings WHERE finding_id = ? AND repo_dir = ?`)
            .get(findingId, repoDir)
        : this.#db.prepare(`SELECT * FROM findings WHERE finding_id = ?`).get(findingId)
    ) as Record<string, string | number> | undefined;
    if (!row) return null;
    return {
      findingId: String(row['finding_id']),
      scanId: Number(row['scan_id']),
      repoDir: String(row['repo_dir']),
      finding: JSON.parse(String(row['finding_json'])) as Finding,
      firstSeen: String(row['first_seen']),
      lastSeen: String(row['last_seen']),
      status: String(row['status']) as StoredFinding['status'],
    };
  }

  recordRun(
    findingId: string,
    repoDir: string,
    report: VerificationReport,
    planRationale: string | null,
    diff: string | null,
    /** Omitted when the deterministic planner produced the migration unaided. */
    agent?: { model: string; provider: string } | null,
  ): number {
    const res = this.#db
      .prepare(
        `INSERT INTO runs (finding_id, repo_dir, outcome, summary, created_at, report_json, plan_rationale, diff, agent_model, agent_provider)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        findingId,
        repoDir,
        report.outcome,
        report.summary,
        new Date().toISOString(),
        JSON.stringify(report),
        planRationale,
        diff,
        agent?.model ?? null,
        agent?.provider ?? null,
      );
    return Number(res.lastInsertRowid);
  }

  listRuns(findingId?: string): StoredRun[] {
    const rows = (
      findingId
        ? this.#db
            .prepare(`SELECT * FROM runs WHERE finding_id = ? ORDER BY id DESC`)
            .all(findingId)
        : this.#db.prepare(`SELECT * FROM runs ORDER BY id DESC LIMIT 100`).all()
    ) as Array<Record<string, string | number | null>>;
    return rows.map((r) => ({
      id: Number(r['id']),
      findingId: String(r['finding_id']),
      outcome: String(r['outcome']),
      summary: String(r['summary']),
      createdAt: String(r['created_at']),
      report: r['report_json']
        ? (JSON.parse(String(r['report_json'])) as VerificationReport)
        : null,
      planRationale: r['plan_rationale'] ? String(r['plan_rationale']) : null,
      diff: r['diff'] ? String(r['diff']) : null,
      // Rows written before this column existed report null rather than a
      // placeholder model, so "unknown" stays distinguishable from "no agent".
      agent: r['agent_model']
        ? {
            model: String(r['agent_model']),
            provider: String(r['agent_provider'] ?? 'unknown'),
          }
        : null,
    }));
  }

  /**
   * Every repository the store holds scan data for.
   *
   * One row per distinct `repo_dir`, which is what the dashboard's repo picker
   * shows. It only ever grew: an `emend scan` of a temporary directory leaves a
   * row behind long after the directory is gone, so a machine used for
   * development accumulates eval workspaces and debugging fixtures indefinitely.
   *
   * Counts and a last-seen timestamp travel with it because a path alone does
   * not say what is worth keeping. Whether the directory still exists is the
   * caller's question to answer — the store deliberately does not touch the
   * filesystem, so this stays usable against a database copied from elsewhere.
   */
  listStoredRepos(): StoredRepoData[] {
    const rows = this.#db
      .prepare(
        `SELECT s.repo_dir                                   AS repo_dir,
                count(DISTINCT s.id)                         AS scans,
                max(s.started_at)                            AS last_scanned,
                (SELECT repo_name FROM scans
                  WHERE repo_dir = s.repo_dir
                  ORDER BY id DESC LIMIT 1)                  AS repo_name,
                (SELECT count(*) FROM findings
                  WHERE repo_dir = s.repo_dir)               AS findings,
                (SELECT count(*) FROM runs
                  WHERE repo_dir = s.repo_dir)               AS runs
           FROM scans s
          GROUP BY s.repo_dir
          ORDER BY last_scanned DESC`,
      )
      .all() as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      repoDir: String(r['repo_dir']),
      repoName: String(r['repo_name'] ?? ''),
      scans: Number(r['scans']),
      findings: Number(r['findings']),
      runs: Number(r['runs']),
      lastScanned: String(r['last_scanned'] ?? ''),
    }));
  }

  /**
   * Forget one repository's scan data.
   *
   * Returns what it deleted rather than nothing, so a mistyped path reads as
   * "there was nothing there" instead of as a successful clear — the same reason
   * a scan reports skipped call sites rather than counting them clean.
   */
  pruneRepo(repoDir: string): PrunedCounts {
    return this.#atomically(() => this.#pruneWhere('repo_dir = ?', [repoDir]));
  }

  /**
   * Forget all scan history, and — only when asked — the GitHub App's state too.
   *
   * Two unrelated things share this database. `scans`, `findings`, `runs` and
   * `fixed_vulnerabilities` are local clutter, regenerated by scanning again.
   * `installations`, `repos`, `jobs` and `pull_requests` are the hosted
   * service's operational state: deleting those unregisters the App and loses
   * the record of every pull request it opened, which is not something anyone
   * tidying a dropdown is asking for. So it is opt-in.
   */
  pruneAll(options: { includeApp?: boolean } = {}): PrunedCounts {
    return this.#atomically(() => {
      const counts = this.#pruneWhere('1 = 1', []);
      if (options.includeApp) {
        for (const table of ['pull_requests', 'jobs', 'repos', 'installations']) {
          this.#db.prepare(`DELETE FROM ${table}`).run();
        }
      }
      return counts;
    });
  }

  /**
   * All of `work`'s writes, or none of them.
   *
   * A prune is several `DELETE`s that only mean anything together. Ordering them
   * children-first decides *which* half survives an interruption; it cannot make
   * a half impossible, and a findings row whose scan is gone is exactly the state
   * the ordering was chosen to avoid. Interruption is not hypothetical here: this
   * is the one path a person runs when they want the rows gone, and it is
   * followed immediately by `store.close()`.
   *
   * Not nested — `pruneAll` wraps the whole job including the App tables, so
   * `#pruneWhere` stays a plain sequence of deletes and never opens one itself.
   */
  #atomically<T>(work: () => T): T {
    this.#db.exec('BEGIN');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The scan-side tables, deleted together so no orphan rows are left behind. */
  #pruneWhere(where: string, params: string[]): PrunedCounts {
    const del = (table: string): number =>
      Number(this.#db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params).changes ?? 0);
    // Children first: a findings row outliving its scan would show in the
    // dashboard with nothing behind it.
    const runs = del('runs');
    const findings = del('findings');
    const fixedVulnerabilities = del('fixed_vulnerabilities');
    const scans = del('scans');
    return { scans, findings, runs, fixedVulnerabilities };
  }

  close(): void {
    this.#db.close();
  }
}
