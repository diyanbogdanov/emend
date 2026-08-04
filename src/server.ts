/**
 * Local dashboard.
 *
 * Plain node:http and a single self-contained page — no framework, no build step,
 * nothing to install. The dashboard is for reviewing findings, so it optimises for
 * information density over decoration.
 */

import http from 'node:http';
import { Store } from './store.ts';
import { resolveAppConfig, verifyWebhookSignature } from './github/app.ts';
import { handleWebhook } from './github/webhook.ts';
import { startRunner } from './github/runner.ts';

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Read the raw request body. Signature verification needs the exact bytes. */
function readBody(req: http.IncomingMessage, limit = 8 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function startServer(port: number): Promise<void> {
  // The GitHub App is optional: `emend serve` stays a local dashboard when no
  // App credentials are present, and only becomes a hosted service when they are.
  const app = resolveAppConfig();
  let stopRunner: (() => void) | undefined;
  if (app.ok) {
    const runnerStore = new Store();
    stopRunner = startRunner({
      store: runnerStore,
      config: app.config,
      log: (m) => console.log(`  [runner] ${m}`),
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    if (url.pathname === '/webhook') {
      void handleWebhookRequest(req, res, app);
      return;
    }

    const store = new Store();
    try {
      if (url.pathname === '/api/repos') {
        json(res, store.listRepos());
        return;
      }
      if (url.pathname === '/api/jobs') {
        json(res, store.listJobs());
        return;
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
        return;
      }
      if (url.pathname === '/api/scans') {
        json(res, store.listScans());
        return;
      }
      if (url.pathname === '/api/findings') {
        const repo = url.searchParams.get('repo') ?? undefined;
        json(res, store.listFindings(repo));
        return;
      }
      if (url.pathname === '/api/packages') {
        const repo = url.searchParams.get('repo') ?? undefined;
        json(res, store.latestScanPackages(repo));
        return;
      }
      if (url.pathname === '/api/runs') {
        const finding = url.searchParams.get('finding') ?? undefined;
        json(res, store.listRuns(finding));
        return;
      }
      json(res, { error: 'not found' }, 404);
    } catch (err) {
      json(res, { error: (err as Error).message }, 500);
    } finally {
      store.close();
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`\n  Emend dashboard → http://localhost:${port}`);
      if (app.ok) {
        console.log(`  GitHub App active → POST http://localhost:${port}/webhook`);
      } else {
        console.log(`  Local mode — ${app.reason}`);
      }
      console.log('  Ctrl-C to stop.\n');
      // Resolves only when the server closes, keeping the CLI process alive.
      server.on('close', () => {
        stopRunner?.();
        resolve();
      });
    });
  });
}

/**
 * The webhook endpoint.
 *
 * Order matters: verify the signature against the raw bytes, and only then
 * parse. An unverified payload is never given to the handler, so a forged
 * delivery cannot queue work or mutate tracked repositories.
 */
async function handleWebhookRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: ReturnType<typeof resolveAppConfig>,
): Promise<void> {
  if (req.method !== 'POST') {
    json(res, { error: 'method not allowed' }, 405);
    return;
  }
  if (!app.ok) {
    json(res, { error: 'GitHub App is not configured' }, 503);
    return;
  }

  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch (err) {
    json(res, { error: (err as Error).message }, 413);
    return;
  }

  const signature = req.headers['x-hub-signature-256'];
  const ok = verifyWebhookSignature(
    app.config.webhookSecret,
    raw,
    typeof signature === 'string' ? signature : undefined,
  );
  if (!ok) {
    json(res, { error: 'invalid signature' }, 401);
    return;
  }

  const event = String(req.headers['x-github-event'] ?? '');
  const store = new Store();
  try {
    const payload = JSON.parse(raw.toString('utf8')) as Parameters<typeof handleWebhook>[2];
    const result = handleWebhook(store, event, payload);
    console.log(`  [webhook] ${event}: ${result.action} (${result.jobsQueued} queued)`);
    json(res, result);
  } catch (err) {
    json(res, { error: (err as Error).message }, 400);
  } finally {
    store.close();
  }
}

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Emend</title>
<style>
  :root {
    --bg: #faf9f7;
    --panel: #ffffff;
    --line: #e3ded6;
    --ink: #17150f;
    --muted: #6d675c;
    --accent: #b4530a;
    --break: #b3261e;
    --deprecate: #8a6100;
    --ok: #1c6b3f;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
    --sans: ui-sans-serif, -apple-system, "Segoe UI", Inter, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #12110f;
      --panel: #1a1916;
      --line: #2e2b26;
      --ink: #eeeae2;
      --muted: #9a9287;
      --accent: #e08b3e;
      --break: #f07167;
      --deprecate: #d9a441;
      --ok: #6fcf97;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: var(--sans); font-size: 14px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  header {
    border-bottom: 1px solid var(--line); padding: 18px 24px;
    display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap;
  }
  h1 { font-size: 17px; margin: 0; letter-spacing: -0.01em; }
  h1 span { color: var(--accent); }
  .tag {
    font-family: var(--mono); font-size: 11px; color: var(--muted);
    border: 1px solid var(--line); border-radius: 3px; padding: 2px 7px;
  }
  main { padding: 24px; max-width: 1180px; margin: 0 auto; }
  .stats { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 24px; }
  .stat {
    background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
    padding: 12px 16px; min-width: 128px;
  }
  .stat b { display: block; font-size: 24px; font-weight: 600; letter-spacing: -0.02em; }
  .stat small { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .07em; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .09em; color: var(--muted); margin: 28px 0 10px; font-weight: 600; }
  .card {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 6px; margin-bottom: 10px; overflow: hidden;
  }
  .card-head {
    padding: 12px 16px; display: flex; gap: 10px; align-items: center;
    flex-wrap: wrap; cursor: pointer;
  }
  .card-head:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
  .sym { font-family: var(--mono); font-size: 13px; font-weight: 600; }
  .badge {
    font-family: var(--mono); font-size: 10px; text-transform: uppercase;
    letter-spacing: .06em; padding: 2px 7px; border-radius: 3px;
    border: 1px solid currentColor;
  }
  .b-breaking { color: var(--break); }
  .b-deprecation { color: var(--deprecate); }
  .b-open { color: var(--muted); }
  .b-fixed { color: var(--ok); }
  .spacer { flex: 1; }
  .meta { color: var(--muted); font-size: 12px; font-family: var(--mono); }
  .body { border-top: 1px solid var(--line); padding: 14px 16px; display: none; }
  .card.open .body { display: block; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th {
    text-align: left; font-weight: 600; color: var(--muted); font-size: 11px;
    text-transform: uppercase; letter-spacing: .06em; padding: 5px 8px 5px 0;
    border-bottom: 1px solid var(--line);
  }
  td { padding: 6px 8px 6px 0; border-bottom: 1px solid color-mix(in srgb, var(--line) 55%, transparent); vertical-align: top; }
  td.code, .site { font-family: var(--mono); font-size: 12px; }
  .site-src { color: var(--muted); }
  pre {
    font-family: var(--mono); font-size: 12px; background: var(--bg);
    border: 1px solid var(--line); border-radius: 4px; padding: 10px;
    overflow-x: auto; margin: 10px 0 0;
  }
  .add { color: var(--ok); }
  .del { color: var(--break); }
  .empty { color: var(--muted); padding: 34px; text-align: center; border: 1px dashed var(--line); border-radius: 6px; }
  .warn {
    border-left: 3px solid var(--deprecate); background: color-mix(in srgb, var(--deprecate) 8%, transparent);
    padding: 9px 13px; margin-bottom: 8px; font-size: 12.5px; border-radius: 0 4px 4px 0;
  }
  code { font-family: var(--mono); background: color-mix(in srgb, var(--muted) 14%, transparent); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  select { font-family: var(--sans); font-size: 12px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--panel); color: var(--ink); }
</style>
</head>
<body>
<header>
  <h1>emend<span>.</span></h1>
  <span class="tag">API drift → verified migrations</span>
  <div class="spacer"></div>
  <select id="repo"></select>
</header>
<main>
  <div class="stats" id="stats"></div>
  <div id="warnings"></div>
  <h2>Findings</h2>
  <div id="findings"></div>
  <h2>Packages analyzed</h2>
  <div id="packages"></div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
let scans = [], repo = null;

async function get(p) { const r = await fetch(p); return r.json(); }

async function boot() {
  scans = await get('/api/scans');
  const repos = [...new Set(scans.map(s => s.repoDir))];
  if (repos.length === 0) {
    $('findings').innerHTML = '<div class="empty">No scans yet. Run <code>emend scan &lt;repo&gt;</code>.</div>';
    return;
  }
  $('repo').innerHTML = repos.map(r => '<option value="' + esc(r) + '">' + esc(r.split('/').slice(-2).join('/')) + '</option>').join('');
  repo = repos[0];
  $('repo').onchange = (e) => { repo = e.target.value; render(); };
  render();
}

async function render() {
  const scan = scans.find(s => s.repoDir === repo);
  const [findings, packages] = await Promise.all([
    get('/api/findings?repo=' + encodeURIComponent(repo)),
    get('/api/packages?repo=' + encodeURIComponent(repo)),
  ]);

  const c = scan ? scan.counts : { breaking: 0, deprecation: 0, callSites: 0, packagesAnalyzed: 0, packagesSkipped: 0 };
  const unlocated = packages.reduce((n, p) => n + (p.unlocatedBreaking || 0), 0);
  $('stats').innerHTML = [
    ['Breaking', c.breaking, 'affecting your code'],
    ['Deprecated', c.deprecation, 'affecting your code'],
    ['Call sites', c.callSites, 'located'],
    ['Analyzed', c.packagesAnalyzed, 'packages'],
    ['Skipped', c.packagesSkipped, 'not known clean'],
    ['Filtered out', unlocated, 'changes not in your code'],
  ].map(([label, n, sub]) =>
    '<div class="stat"><small>' + label + '</small><b>' + n + '</b><small>' + sub + '</small></div>'
  ).join('');

  $('warnings').innerHTML = (scan?.warnings ?? []).map(w => '<div class="warn">' + esc(w) + '</div>').join('');

  $('findings').innerHTML = findings.length === 0
    ? '<div class="empty">No findings — no tracked API change intersects this codebase.</div>'
    : findings.map(renderFinding).join('');

  document.querySelectorAll('.card-head').forEach(h => {
    h.onclick = () => h.parentElement.classList.toggle('open');
  });

  $('packages').innerHTML = '<div class="card"><div class="body" style="display:block">'
    + '<table><thead><tr><th>Package</th><th>From → To</th><th>Status</th><th>Findings</th><th>Not in your code</th><th>Note</th></tr></thead><tbody>'
    + packages.map(p =>
      '<tr><td class="code">' + esc(p.pkg) + '</td>'
      + '<td class="code">' + esc(p.fromVersion ?? '?') + ' → ' + esc(p.toVersion ?? '?') + '</td>'
      + '<td>' + esc(p.status) + '</td>'
      + '<td>' + p.findings.length + '</td>'
      + '<td>' + (p.unlocatedBreaking || 0) + '</td>'
      + '<td class="site-src">' + esc((p.note ?? '').slice(0, 120)) + '</td></tr>'
    ).join('')
    + '</tbody></table></div></div>';
}

function renderFinding(row) {
  const f = row.finding, ch = f.change;
  const sites = f.sites.map(s =>
    '<tr><td class="code">' + esc(s.file) + ':' + s.line + ':' + s.column + '</td>'
    + '<td class="code site-src">' + esc(s.text) + '</td>'
    + '<td class="meta">' + esc(s.via) + '</td></tr>'
  ).join('');

  return '<div class="card">'
    + '<div class="card-head">'
    +   '<span class="badge b-' + esc(ch.severity) + '">' + esc(ch.kind) + '</span>'
    +   '<span class="sym">' + esc(ch.path) + '</span>'
    +   '<span class="meta">' + esc(f.pkg) + ' ' + esc(f.fromVersion) + ' → ' + esc(f.toVersion) + '</span>'
    +   '<div class="spacer"></div>'
    +   '<span class="badge b-' + esc(row.status) + '">' + esc(row.status) + '</span>'
    +   '<span class="meta">' + f.sites.length + ' site' + (f.sites.length === 1 ? '' : 's') + '</span>'
    +   '<span class="meta">' + esc(f.id) + '</span>'
    + '</div>'
    + '<div class="body">'
    +   '<table><thead><tr><th>Location</th><th>Source</th><th>Via</th></tr></thead><tbody>' + sites + '</tbody></table>'
    +   '<pre><span class="del">- ' + esc((ch.before ?? '(absent)').slice(0, 400)) + '</span>\\n'
    +   '<span class="add">+ ' + esc((ch.after ?? '(removed)').slice(0, 400)) + '</span></pre>'
    +   '<p class="meta">confidence: ' + esc(f.confidence) + ' · fix with <code>emend fix --finding ' + esc(f.id) + '</code></p>'
    + '</div></div>';
}

boot();
</script>
</body>
</html>`;
