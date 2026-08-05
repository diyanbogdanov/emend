# Registering the Emend GitHub App

Emend runs as a GitHub App so it can be installed per repository, authenticate
without a personal token, and receive push and CI events. This is the one part
of the system that cannot be tested locally — the App token exchange is
validated by GitHub itself.

Roughly 20 minutes.

---

## 1. Generate a webhook secret

GitHub signs every delivery with this. Emend verifies the signature before it
parses the payload, so a forged delivery cannot queue work or change tracked
repositories.

```bash
openssl rand -hex 32
```

Keep the output. You will paste it into the form in step 3 and into your
environment in step 6.

---

## 2. Expose your local server

GitHub must be able to reach your machine to deliver webhooks. Start a tunnel
**before** creating the App so you have a URL to paste into the form.

```bash
cloudflared tunnel --url http://localhost:8080
```

It prints a public `https://<random>.trycloudflare.com` URL. Your webhook URL is
that plus `/webhook`.

No cloudflared? `npx smee-client --url https://smee.io/new --target http://localhost:8080/webhook`
works the same way — visit <https://smee.io/new> first to mint a channel URL.

Both give you a throwaway URL that changes when you restart. That is fine for
setup; use a stable hostname before onboarding anyone.

---

## 3. Create the App

For an organization (use this for a private organisation):

```
https://github.com/organizations/a private organisation/settings/apps/new
```

For your personal account: <https://github.com/settings/apps/new>

Fill in:

| Field | Value |
| --- | --- |
| **GitHub App name** | `Emend` — must be globally unique, so try `Emend Dev` or `Emend a private organisation` if taken |
| **Homepage URL** | Anything. `https://github.com/a private organisation/a scanned repository` is fine |
| **Webhook** | Leave **Active** checked |
| **Webhook URL** | Your tunnel URL + `/webhook` |
| **Webhook secret** | The value from step 1 |

Leave "Callback URL", "Setup URL", and the OAuth boxes empty. Emend does not use
the OAuth user flow — it authenticates as an installation.

---

## 4. Set repository permissions

Under **Permissions → Repository permissions**, set exactly these four. Leave
every other permission at *No access*.

| Permission | Level | Why Emend needs it |
| --- | --- | --- |
| **Contents** | **Read and write** | Read the source tarball, and create the branch and commit |
| **Pull requests** | **Read and write** | Open and update the draft PR |
| **Checks** | Read-only | Receive `check_suite`, which is how CI results come back |
| **Metadata** | Read-only | Mandatory for every App; GitHub selects it automatically |

**Contents must be write, not read.** Emend builds commits through the Git Data
API — a blob per changed file, then a tree, a commit, and a branch ref — and
every one of those is a write. With read-only Contents the scan and migration
succeed and then the first blob upload fails with 403, which is an expensive
place to discover the mistake.

---

## 5. Subscribe to events

Under **Subscribe to events**, tick exactly these four:

- **Installation** — a repo was connected or disconnected
- **Installation repositories** — repos added to or removed from an existing install
- **Push** — new commits on the default branch trigger a rescan
- **Check suite** — your CI's verdict on an Emend pull request

Under **Where can this GitHub App be installed?** choose **Only on this
account** while you are testing.

Click **Create GitHub App**.

---

## 6. Collect the credentials

On the App's settings page after creation:

1. **App ID** is near the top. A number like `1234567`.
2. Scroll to **Private keys** → **Generate a private key**. A `.pem` file
   downloads. GitHub shows it once; keep it.

Then, in the Emend repo:

```bash
cat >> .env <<'ENV'
EMEND_GITHUB_APP_ID=1234567
EMEND_GITHUB_WEBHOOK_SECRET=<the hex string from step 1>
ENV

# Multi-line PEM does not survive .env parsing, so base64 it.
# Emend detects base64 and decodes it automatically.
echo "EMEND_GITHUB_PRIVATE_KEY=$(base64 -i ~/Downloads/emend.*.private-key.pem | tr -d '\n')" >> .env
```

`.env` is gitignored. The private key is the App's identity — anyone holding it
can act as Emend on every repository it is installed on.

---

## 7. Install it on a repository

On the App settings page, click **Install App** in the left sidebar, choose the
account, and select **Only select repositories** → `a scanned repository`.

Installing fires an `installation` webhook, which tracks the repo and queues its
first scan immediately.

---

## 8. Start Emend and verify

```bash
node bin/emend.mjs serve --port 8080
```

You should see:

```
  Emend dashboard → http://localhost:8080
  GitHub App active → POST http://localhost:8080/webhook
```

If it says `Local mode — GitHub App not configured. Missing: …`, the named
variables did not reach the process. Emend loads `.env` from the current working
directory, so run it from the repo root.

Then check the three things that prove the loop works:

```bash
curl -s localhost:8080/api/repos    | head -c 300   # the repo is tracked
curl -s localhost:8080/api/jobs     | head -c 300   # a scan was queued
```

and open <http://localhost:8080> — the repository appears under **Monitored
repositories** with its findings and queue state once the scan completes.

---

## Troubleshooting

**Webhook deliveries show 401.** The secret in `.env` does not match the one in
the App settings. GitHub's **Advanced** tab on the App page lists every delivery
with its request and response; use *Redeliver* after fixing rather than pushing
again.

**Deliveries show 503.** Emend started in local mode — the credentials are not
reaching it. See step 8.

**Nothing queues on push.** Emend only acts on the default branch, by design;
feature branches would triple the scan volume and produce findings about code
that may never merge.

**403 on `git/blobs`.** Contents is read-only. Fix it in **Permissions**, then
accept the permission change on the installation — GitHub does not apply
upgraded permissions until the install approves them.

**A Prisma repository reports `pre-existing-failure` and proposes nothing.**
Expected. Prisma generates its client during install and the published tarball
is a stub, so the baseline typecheck fails on missing model types. Emend refuses
to attribute that to a migration it did not cause. Generating the client would
mean executing repository code, which the hosted path deliberately does not do.
