/**
 * GitHub App authentication and repository access.
 *
 * Emend follows Dependabot's credential model: the component that analyses code
 * never holds a durable credential. A GitHub App authenticates as itself with a
 * short-lived RS256 JWT, exchanges that for an installation token scoped to one
 * account, and the token is used only to pull a source tarball. It is never
 * written to disk, never placed in the environment, and never handed to the
 * analysis path — which receives a plain directory and nothing else.
 *
 * Repository contents arrive through the tarball endpoint rather than `git
 * clone`. That avoids spawning git with a credential in its argv or askpass
 * environment, and it is one request instead of a subprocess.
 */

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

const API = process.env.EMEND_GITHUB_API ?? 'https://api.github.com';

export interface AppConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
}

export interface AppConfigError {
  ok: false;
  reason: string;
}

export type AppConfigResult = { ok: true; config: AppConfig } | AppConfigError;

/**
 * Read App credentials from the environment.
 *
 * Returns a structured failure rather than throwing: the local CLI must keep
 * working with no GitHub App configured at all.
 */
export function resolveAppConfig(): AppConfigResult {
  const appId = process.env.EMEND_GITHUB_APP_ID ?? '';
  const webhookSecret = process.env.EMEND_GITHUB_WEBHOOK_SECRET ?? '';

  // Accept the PEM directly or as base64, because multi-line secrets survive
  // very few deployment environments intact.
  let privateKey = process.env.EMEND_GITHUB_PRIVATE_KEY ?? '';
  if (privateKey && !privateKey.includes('BEGIN')) {
    try {
      privateKey = Buffer.from(privateKey, 'base64').toString('utf8');
    } catch {
      /* leave as-is; the signing call will report it */
    }
  }
  privateKey = privateKey.replace(/\\n/g, '\n');

  const missing = [
    !appId && 'EMEND_GITHUB_APP_ID',
    !privateKey && 'EMEND_GITHUB_PRIVATE_KEY',
    !webhookSecret && 'EMEND_GITHUB_WEBHOOK_SECRET',
  ].filter(Boolean);

  if (missing.length > 0) {
    return { ok: false, reason: `GitHub App not configured. Missing: ${missing.join(', ')}` };
  }
  return { ok: true, config: { appId, privateKey, webhookSecret } };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * A GitHub App JWT: RS256 over `{header}.{payload}`, valid ten minutes.
 *
 * `iat` is backdated a minute because GitHub rejects tokens issued in the
 * future and modest clock skew between hosts is normal.
 */
export function appJwt(config: AppConfig): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: config.appId }),
  );
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    config.privateKey,
  );
  return `${header}.${payload}.${base64url(signature)}`;
}

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<number, TokenCacheEntry>();

/**
 * Exchange the App JWT for an installation token.
 *
 * Tokens live an hour; they are cached until five minutes before expiry so a
 * burst of webhooks does not mint one per event. The cache is in-memory only —
 * a credential that never touches disk cannot be read off it later.
 */
export async function installationToken(
  config: AppConfig,
  installationId: number,
): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 5 * 60_000) return cached.token;

  const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appJwt(config)}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    // Deliberately does not include the response body: GitHub echoes request
    // details in errors and this string reaches logs.
    throw new Error(`could not mint installation token (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(installationId, {
    token: body.token,
    expiresAt: Date.parse(body.expires_at),
  });
  return body.token;
}

export interface Repo {
  owner: string;
  name: string;
  defaultBranch: string;
}

/** `owner/repo` -> the stable key findings are correlated by. */
export function repoKey(owner: string, name: string): string {
  return `github.com/${owner}/${name}`;
}

async function api<T>(token: string, endpoint: string): Promise<T> {
  const res = await fetch(`${API}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${endpoint}`);
  return (await res.json()) as T;
}

/** Every repository an installation can see. */
export async function listInstallationRepos(token: string): Promise<Repo[]> {
  const out: Repo[] = [];
  for (let page = 1; page <= 10; page++) {
    const body = await api<{
      repositories: Array<{ name: string; owner: { login: string }; default_branch: string }>;
    }>(token, `/installation/repositories?per_page=100&page=${page}`);
    for (const r of body.repositories) {
      out.push({ owner: r.owner.login, name: r.name, defaultBranch: r.default_branch });
    }
    if (body.repositories.length < 100) break;
  }
  return out;
}

/**
 * Download a repository at a ref and extract it to a fresh temp directory.
 *
 * The caller owns the directory and must remove it. Nothing here executes any
 * repository content — it is downloaded, unpacked, and read.
 */
export async function fetchRepoTarball(
  token: string,
  owner: string,
  name: string,
  ref: string,
): Promise<string> {
  const res = await fetch(`${API}/repos/${owner}/${name}/tarball/${ref}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`tarball ${res.status} for ${owner}/${name}@${ref}`);

  const dir = path.join(
    tmpdir(),
    `emend-repo-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
  );
  await mkdir(dir, { recursive: true });
  const tgz = path.join(dir, 'repo.tgz');
  await writeFile(tgz, Buffer.from(await res.arrayBuffer()));

  try {
    await execFileAsync('tar', ['-xzf', tgz, '-C', dir]);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`could not extract ${owner}/${name}@${ref}: ${(err as Error).message}`);
  }
  await rm(tgz, { force: true });

  // GitHub tarballs unpack to a single `<owner>-<repo>-<sha>` directory.
  const entries = await readdir(dir, { withFileTypes: true });
  const root = entries.find((e) => e.isDirectory());
  if (!root) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`empty tarball for ${owner}/${name}@${ref}`);
  }
  return path.join(dir, root.name);
}

/**
 * Verify a webhook signature.
 *
 * Runs against the raw body — re-serialising parsed JSON changes the bytes and
 * the signature will not match. Uses a constant-time comparison because a
 * fast-failing string compare leaks the expected digest one byte at a time.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
