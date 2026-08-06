# Deploying Emend

Emend is a single always-on Node process with a disk. No database server, no
queue service, no container orchestration — the job queue is SQLite and the
runner is in-process.

That shape makes it cheap, but it is not free-tier shaped: a scan builds a
TypeScript program over the whole repository with its dependency types staged,
which is CPU- and memory-hungry in bursts, and the tarball cache wants real disk.
Platforms that price by RAM-hour and charge for egress are the worst fit for
exactly this workload.

---

## Sizing

| Resource | Minimum | Why |
| --- | --- | --- |
| RAM | **8 GB** | A package's whole type surface is held in memory while it is analysed. Most are trivial (zod: 189 MB) but `googleapis` needs ~3 GB on its own, and analysis runs four packages at a time. 2 GB was the recommendation while surfaces were truncated at 25,000 symbols; they are not any more. |
| vCPU | 2 | Typechecking is the bottleneck; scans are seconds, not minutes. |
| Disk | 20 GB | SQLite is tiny. The tarball cache is the consumer, and it is shared across every repository — the second repo using zod costs nothing. |
| Egress | modest | npm tarballs in, GitHub API out. Cache hits make this fall off sharply after the first few repositories. |

---

## Recommended: AWS on Activate credits

**Apply first — it takes ten minutes and the credits are the whole argument.**

<https://aws.amazon.com/activate/> → **Founders** tier. Self-serve, no VC or
accelerator referral needed. Eligibility is bootstrapped/self-funded, under ten
years old, fewer than ten employees, under $1M revenue or funding, pre-Series B.
Credits are $1,000–$5,000 depending on what they approve.

At `t4g.large` (~$49/mo, see sizing above), the $1,000 tier is roughly 20 months
of runway. That is long enough to find out whether anyone wants this, which is
the only question that matters right now.

### Instance

`t4g.large` — 2 vCPU, 8 GB, ARM/Graviton (~$49/mo). ARM is both cheaper and
fully supported; Node, `tar` and the TypeScript compiler all run natively.

`t4g.small` (2 GB) was the earlier recommendation and is no longer enough:
symbol-walk limits were removed so that no real package is analysed only
partially, and the memory that used to be saved by truncating is now spent. At
$49/mo an AWS Activate Founders grant of $1,000 covers roughly 20 months rather
than six years — still long enough to learn whether anyone wants this.

Add 2 GB of swap. It costs nothing and turns an OOM kill during an unusually
large scan into a slow scan:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

If you see the runner die mid-scan with no error, that is the OOM killer. The
launcher already sizes V8's heap to three quarters of physical memory, so the
answer is a bigger instance rather than a flag.

### Storage

A 20 GB `gp3` root volume is enough. Keep `~/.emend` on it — that is both the
SQLite database and the tarball cache.

Back up the database, not the cache. The cache rebuilds itself from npm; the
database holds every finding's history and is the only thing that cannot be
regenerated:

```bash
sqlite3 ~/.emend/emend.db ".backup /tmp/emend-backup.db" && \
  aws s3 cp /tmp/emend-backup.db s3://<your-bucket>/emend/$(date +%F).db
```

### Running it

systemd, so it restarts on boot and on crash:

```ini
# /etc/systemd/system/emend.service
[Unit]
Description=Emend
After=network-online.target

[Service]
Type=simple
User=emend
WorkingDirectory=/opt/emend
EnvironmentFile=/opt/emend/.env
ExecStart=/usr/bin/node bin/emend.mjs serve --port 8080
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`EnvironmentFile` rather than baking secrets into the unit: the unit file is
world-readable, `.env` should be `chmod 600` and owned by the service user.

### TLS

GitHub will not deliver webhooks to plain HTTP. Caddy gets a certificate and
renews it with no configuration beyond a domain name:

```
# /etc/caddy/Caddyfile
emend.example.com {
    reverse_proxy localhost:8080
}
```

Point an A record at the instance's Elastic IP first. **Use an Elastic IP** — a
default public IP changes when the instance stops, and a changed IP means every
webhook delivery fails until you notice.

Then set the App's webhook URL to `https://emend.example.com/webhook`. That is
the value that must never change again; everything else here can be rebuilt.

---

## Alternatives, and when they win

**Hetzner CX32** — €10.59/mo for 4 vCPU, 8 GB, 80 GB. Substantially cheaper than
the equivalent AWS instance before credits, and the right answer if the Activate
application is rejected. Same systemd and Caddy setup; only the provider changes.

**Fly.io** — least work: a Dockerfile, `fly launch`, TLS handled. Realistically
$12–25/mo once a 2 GB machine, a persistent volume ($0.15/GB/mo) and egress are
counted, and the free tier is gone. Worth it if you would rather not own a
server at all.

**Render / Railway** — Render's $7 Starter is 512 MB, which will OOM on a real
scan; the next tier up removes the price advantage. Railway meters CPU, memory,
volumes and egress with no hard cap, which is the wrong billing shape for a
workload whose cost is bursty CPU.

---

## Before design partners, not after

- **Elastic IP and a real domain.** A `trycloudflare` URL dies with the terminal
  and silently breaks every installation.
- **Back up the database.** Findings history is the only unrecoverable state.
- **Watch the disk.** The tarball cache grows without bound today; nothing prunes
  it. `du -sh ~/.emend/cache` occasionally, and delete the whole directory if it
  gets awkward — it rebuilds.
- **Set `EMEND_LLM_*`** if you want agent migrations. Without them the runner
  still scans and still proposes anything the deterministic planner can do; it
  just declines the rest.
- **Re-check the default model periodically.** `openrouter` and `deepinfra` ship
  a verified default, so a provider and a key are enough to start. The frontier
  moves monthly, though, and a stale model silently costs quality rather than
  failing — so treat the date on the table below as its expiry, and re-measure
  rather than copying a model ID out of a blog post or an old commit.

---

## Which model, and why it matters more than it looks

Measured 2026-08-06 on the recharts 3 tooltip formatter, the hardest real case
seen so far. Every model below migrates and verifies identically; they differ
only in the *tightening* pass, where nothing can fail them:

| Model | $/Mtok in/out | Result |
| --- | --- | --- |
| `moonshotai/kimi-k3` | 3.00 / 15.00 | `typeof value === 'number' ? value.toFixed(1) : String(value ?? '')` |
| `z-ai/glm-5.2` | 0.76 / 2.42 | same, and 4× cheaper |
| `deepseek/deepseek-v4-pro` | 0.43 / 0.87 | same, cheapest of the three |
| `qwen/qwen3-coder` | 0.30 / 1.00 | narrowed, but `Number(value)` in the else branch — renders "NaN" |

**`z-ai/glm-5.2` is the default** on `openrouter`, and `zai-org/GLM-5.2` on
`deepinfra` — a provider and a key are all you need:

```bash
export EMEND_LLM_PROVIDER=openrouter && export OPENROUTER_API_KEY=... && emend fix ./repo --agent
```

`deepseek/deepseek-v4-pro` scores identically and costs less; it is a reasonable
swap. Kimi K3 also matches, at 6–17× the price on this workload. Any of them —
or any other model your provider serves — via `EMEND_LLM_MODEL`, which always
wins over the default:

```bash
export EMEND_LLM_MODEL=deepseek/deepseek-v4-pro
```

`nebius`, `fireworks`, `together` and `groq` carry no default: their catalogues
need a key to read, so no ID has been verified and guessing one would fail at the
first request with a 404 that looks like an Emend bug. Run `emend models` there.

The trap worth internalising: an A/B on the same models showed the *prompt*
decided correctness and the *model* decided whether edits applied at all. Under
the previous tightening prompt — which listed coercion before narrowing — both
K3 and GLM-5.2 dutifully returned `Number(value ?? 0)`, which renders a real
string value as "0". Verification passes either way. Neither a stronger model
nor a better prompt is sufficient alone.
