/**
 * Persistence for scans, findings, and fix runs.
 *
 * Uses node:sqlite so there is no native build step and no dependency to install.
 * The store is what makes findings *trackable* rather than recomputed: a finding
 * keeps its identity across scans (see the fingerprint in analyze.ts), so the
 * dashboard can show whether something is new, still open, or fixed.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Finding, ScanReport, VerificationReport } from './types.ts';

export const DEFAULT_DB_PATH =
  process.env.EMEND_DB ?? path.join(homedir(), '.emend', 'emend.db');

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

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, id);
      CREATE INDEX IF NOT EXISTS idx_repos_install ON repos(installation_id);
    `);
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

  recordScan(report: ScanReport, repoName: string): number {
    const now = new Date().toISOString();
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

    return scanId;
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
  ): number {
    const res = this.#db
      .prepare(
        `INSERT INTO runs (finding_id, repo_dir, outcome, summary, created_at, report_json, plan_rationale, diff)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
    }));
  }

  close(): void {
    this.#db.close();
  }
}
