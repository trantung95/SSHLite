#!/bin/bash
# toxiproxy-seed.sh — add network "toxics" to the running Toxiproxy SSH proxy.
#
# APPROACH 2 of 2 ("Toxiproxy sidecar"). The `toxiproxy` compose service starts
# a clean proxy named "ssh" (see toxiproxy.json) that forwards localhost:2206 ->
# slow-backend:22 with NO impairment. This script talks to the Toxiproxy HTTP
# API (default http://localhost:8474) to ADD latency / jitter so connections
# through port 2206 become slow and laggy at run time — no rebuild, no restart.
#
# Why a separate step: toxics are runtime state, not part of the seeded proxy
# config, so you tune them live with curl (or the `toxiproxy-cli` binary).
#
# Usage:
#   bash test-docker/toxiproxy-seed.sh            # add default latency toxic
#   LATENCY=600 JITTER=200 bash test-docker/toxiproxy-seed.sh
#
# Tunables (env, with defaults):
#   API       Toxiproxy API base URL   (default http://localhost:8474)
#   PROXY     proxy name               (default ssh)
#   LATENCY   added latency in ms      (default 300)
#   JITTER    latency jitter in ms     (default 100)
#
# Idempotent: each toxic is deleted (ignore 404) then re-added, so re-running
# updates values instead of erroring on "toxic already exists".

set -u

API="${API:-http://localhost:8474}"
PROXY="${PROXY:-ssh}"
LATENCY="${LATENCY:-300}"
JITTER="${JITTER:-100}"

log() { printf '[toxiproxy-seed] %s\n' "$*"; }

if ! command -v curl >/dev/null 2>&1; then
  log "ERROR: curl is required but not found on PATH."
  exit 1
fi

# Sanity: is the API reachable and does the proxy exist?
if ! curl -fsS "${API}/proxies/${PROXY}" >/dev/null 2>&1; then
  log "ERROR: cannot reach proxy '${PROXY}' at ${API}."
  log "       Is the toxiproxy service up?  docker compose -f test-docker/docker-compose.yml up -d toxiproxy slow-backend"
  exit 1
fi

# del_toxic <name> — remove a toxic if present (ignore 404 so it's idempotent).
del_toxic() {
  curl -fsS -X DELETE "${API}/proxies/${PROXY}/toxics/$1" >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# latency toxic: adds LATENCY ms (+/- JITTER) to traffic in the downstream dir.
# ---------------------------------------------------------------------------
log "adding latency toxic: latency=${LATENCY}ms jitter=${JITTER}ms on proxy '${PROXY}'"
del_toxic latency_down
curl -fsS -X POST "${API}/proxies/${PROXY}/toxics" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"latency_down\",\"type\":\"latency\",\"stream\":\"downstream\",\"attributes\":{\"latency\":${LATENCY},\"jitter\":${JITTER}}}" \
  >/dev/null && log "latency toxic applied." || log "latency toxic FAILED."

log "current toxics on '${PROXY}':"
curl -fsS "${API}/proxies/${PROXY}/toxics" || true
printf '\n'

# ===========================================================================
# COOKBOOK — copy/paste these to add other impairments by hand.
# Toxiproxy API ref: https://github.com/Shopify/toxiproxy#http-api
# ===========================================================================
#
# Add upstream latency too (impair the client->server direction):
#   curl -X POST ${API}/proxies/ssh/toxics -H 'Content-Type: application/json' \
#     -d '{"name":"latency_up","type":"latency","stream":"upstream","attributes":{"latency":300,"jitter":100}}'
#
# Throttle bandwidth to 32 KB/s (simulate a thin pipe):
#   curl -X POST ${API}/proxies/ssh/toxics -H 'Content-Type: application/json' \
#     -d '{"name":"slow_band","type":"bandwidth","stream":"downstream","attributes":{"rate":32}}'
#
# Hard timeout / "down" — stop forwarding so the connection hangs then drops.
#   A timeout toxic with timeout:0 holds data forever (connection appears dead):
#   curl -X POST ${API}/proxies/ssh/toxics -H 'Content-Type: application/json' \
#     -d '{"name":"blackhole","type":"timeout","stream":"downstream","attributes":{"timeout":0}}'
#   Or fully cut the link by DISABLING the proxy (instant disconnect for all sessions):
#   curl -X POST ${API}/proxies/ssh -H 'Content-Type: application/json' -d '{"enabled":false}'
#   Re-enable:
#   curl -X POST ${API}/proxies/ssh -H 'Content-Type: application/json' -d '{"enabled":true}'
#
# Reset peer mid-stream after 1s (simulate RST):
#   curl -X POST ${API}/proxies/ssh/toxics -H 'Content-Type: application/json' \
#     -d '{"name":"rst","type":"reset_peer","stream":"downstream","attributes":{"timeout":1000}}'
#
# Probabilistic toxic (apply to only 30% of connections) via "toxicity":
#   curl -X POST ${API}/proxies/ssh/toxics -H 'Content-Type: application/json' \
#     -d '{"name":"flaky","type":"latency","toxicity":0.3,"attributes":{"latency":800}}'
#
# List toxics:    curl ${API}/proxies/ssh/toxics
# Remove a toxic: curl -X DELETE ${API}/proxies/ssh/toxics/latency_down
# Remove ALL:     for t in $(curl -s ${API}/proxies/ssh/toxics | grep -o '"name":"[^"]*"' | cut -d'"' -f4); do \
#                   curl -X DELETE ${API}/proxies/ssh/toxics/$t; done
# Reset everything (clears all toxics on all proxies):
#   curl -X POST ${API}/reset
