# Slow / Laggy SSH Test Servers

Two reusable SSH servers that intentionally degrade the network so you can
reproduce timing-sensitive bugs: high ping, jitter, packet loss, and occasional
disconnects. Both live in `test-docker/docker-compose.yml` (project `hybr8-prod`)
and serve the same rich `seed-showcase.sh` file tree as the normal test servers.

Login for both: host `localhost`, user `testuser` / password `testpass`
(also `admin` / `adminpass`).

| Approach | Service(s) | Host port | How it impairs traffic | Tune by |
|----------|------------|-----------|------------------------|---------|
| 1 — in-container `tc`/netem | `slow` | **2205** | Linux netem on `eth0` + periodic blackout loop | env vars (rebuild-free, set in compose / `-e`) |
| 2 — Toxiproxy sidecar | `toxiproxy` + `slow-backend` | **2206** (API **8474**) | Toxiproxy "toxics" added at runtime | HTTP API (live, no restart) |

Pick **Approach 1** for a self-contained "this server is just slow and flaky"
fixture. Pick **Approach 2** when you want to flip impairment on/off mid-test
from your test code via the API (latency, bandwidth, hard timeout, instant down).

> **Windows / macOS (Docker Desktop): use Approach 2.** Approach 1 needs the
> `sch_netem` kernel module, which the Docker Desktop WSL2 / LinuxKit kernel does
> **not** ship. `tc` then fails with `Error: Specified qdisc kind is unknown.`
> even though `NET_ADMIN` is granted — the entrypoint degrades to an *un-impaired*
> server (no lag). Approach 1 only adds real latency on a Linux host / CI runner
> whose kernel has `CONFIG_NET_SCH_NETEM` (most do). Toxiproxy (Approach 2) works
> everywhere because it impairs in userspace, no kernel module needed — it is the
> latency source used by `docker-ssh-reveal.test.ts`.

---

## Approach 1 — in-container `tc`/netem (`slow`, port 2205)

The `slow` image is the base sshd image plus `iproute2` and a custom entrypoint
(`slow-entrypoint.sh`). On startup it applies a netem profile to `eth0` and, by
default, runs a background loop that blacks the link out periodically.

### Bring it up

```bash
docker compose -f test-docker/docker-compose.yml up -d --build slow
```

Connect:

```bash
ssh testuser@localhost -p 2205     # password: testpass
```

Watch the impairment state transitions:

```bash
docker logs -f hybr8-prod-slow-01
# [slow-entrypoint ...] applied netem steady-state profile OK
# [slow-entrypoint ...] BLACKOUT start (100% loss for 5s)
# [slow-entrypoint ...] BLACKOUT end (restored delay=300ms ...)
```

### Requires NET_ADMIN

`tc` needs the `NET_ADMIN` capability, already set on the service
(`cap_add: [NET_ADMIN]`). If it is missing, the entrypoint logs a clear warning
and runs sshd **without** latency rather than crashing — so a misconfigured host
still gives you a reachable (but un-impaired) server.

It also needs a kernel with `sch_netem`. **Docker Desktop's WSL2 kernel does not
have it**, so on Windows/macOS `tc` fails with `Specified qdisc kind is unknown`
and you get no lag (see the warning at the top — use Approach 2 there). Check
your kernel: `docker exec hybr8-prod-slow-01 tc qdisc add dev eth0 root netem
delay 100ms` — exit 0 means netem works, exit 2 means the module is absent.

### Tune it

All knobs are env vars with defaults baked into the compose `environment:` block:

| Var | Default | Meaning |
|-----|---------|---------|
| `NETEM_DELAY` | `300` | base one-way delay, ms |
| `NETEM_JITTER` | `80` | delay jitter, ms (normal distribution) |
| `NETEM_LOSS` | `3` | steady-state packet loss, % |
| `FLAKY_INTERVAL` | `45` | seconds between blackouts |
| `FLAKY_DOWN` | `5` | blackout duration, seconds (link -> 100% loss) |
| `FLAKY_ENABLED` | `1` | `1` = run blackout loop, `0` = steady-state only |

Override per-run without editing compose:

```bash
# Heavier lag, faster disconnect cycle:
NETEM_DELAY=600 NETEM_JITTER=200 NETEM_LOSS=8 FLAKY_INTERVAL=20 FLAKY_DOWN=8 \
  docker compose -f test-docker/docker-compose.yml up -d --build slow

# Steady lag, no disconnects:
FLAKY_ENABLED=0 docker compose -f test-docker/docker-compose.yml up -d --build slow
```

(Compose reads these from your shell environment because the compose
`environment:` values are plain defaults. On Windows PowerShell use
`$env:NETEM_DELAY="600"; docker compose ...`.)

---

## Approach 2 — Toxiproxy sidecar (`toxiproxy` + `slow-backend`, port 2206)

`slow-backend` is a clean base sshd with **no published port** — only the
`toxiproxy` sidecar reaches it over the compose network. `toxiproxy` forwards
host port **2206 -> slow-backend:22** and exposes its control API on **8474**.

The proxy starts **clean** (no impairment; see `toxiproxy.json`). You add
impairment ("toxics") at runtime via the API, so you can turn lag on/off mid-test
without restarting anything.

### Bring it up

```bash
docker compose -f test-docker/docker-compose.yml up -d --build toxiproxy slow-backend
```

Verify the proxy is live (no toxics yet, so this is currently fast):

```bash
ssh testuser@localhost -p 2206     # password: testpass
curl http://localhost:8474/proxies # shows the "ssh" proxy
```

### Add impairment

Run the seed helper to add a latency toxic (default 300ms +/- 100ms):

```bash
bash test-docker/toxiproxy-seed.sh
# or tune:
LATENCY=600 JITTER=200 bash test-docker/toxiproxy-seed.sh
```

The script is idempotent (delete-then-add) and its header/footer document how to
add other toxics by hand: upstream latency, bandwidth throttle, hard timeout
("down"), connection reset, and probabilistic toxics. Quick examples:

```bash
# Instant full disconnect for all sessions (then re-enable):
curl -X POST http://localhost:8474/proxies/ssh -d '{"enabled":false}'
curl -X POST http://localhost:8474/proxies/ssh -d '{"enabled":true}'

# Remove the latency toxic the seed script added:
curl -X DELETE http://localhost:8474/proxies/ssh/toxics/latency_down

# Clear ALL toxics on all proxies:
curl -X POST http://localhost:8474/reset
```

API reference: https://github.com/Shopify/toxiproxy#http-api

---

## Cleanup

Stop just the slow servers (leave the rest of the fleet running):

```bash
docker compose -f test-docker/docker-compose.yml stop slow toxiproxy slow-backend
docker compose -f test-docker/docker-compose.yml rm -f slow toxiproxy slow-backend
```

Or tear the whole `hybr8-prod` project down:

```bash
docker compose -f test-docker/docker-compose.yml down
```

Logs persist on the host under `test-docker/logs/hybr8-prod-slow-01/` and
`test-docker/logs/hybr8-prod-slow-backend/`.

---

## Port map (avoids existing allocations)

| Port | Server |
|------|--------|
| 2201-2203 | base web / api / db |
| 2204 | sudo server |
| **2205** | **slow (Approach 1, netem)** |
| **2206** | **slow via toxiproxy (Approach 2)** |
| **8474** | **Toxiproxy HTTP API** |
| 2210-2214 | multi-OS (`docker-compose.multios.yml`) |
| 2215 | manual smoke |
| 2230-2234 | CI (`docker-compose.ci.yml`) |
