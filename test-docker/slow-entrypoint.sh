#!/bin/bash
# slow-entrypoint.sh — entrypoint for the in-container "slow / laggy" SSH server.
#
# Applies Linux traffic-control (tc/netem) latency, jitter and packet-loss to the
# container's eth0 interface, then (optionally) runs a periodic "blackout" loop
# that flips the link to 100% loss for a few seconds to simulate intermittent
# disconnects. Finally it execs sshd in the foreground so the container stays up.
#
# Tunables (all via env, with defaults applied below):
#   NETEM_DELAY    base one-way delay in ms                     (default 300)
#   NETEM_JITTER   delay jitter in ms (normal distribution)     (default 80)
#   NETEM_LOSS     steady-state packet loss in %                (default 3)
#   FLAKY_INTERVAL seconds between blackouts                     (default 45)
#   FLAKY_DOWN     blackout duration in seconds                  (default 5)
#   FLAKY_ENABLED  1 = run the blackout loop, 0 = steady only    (default 1)
#
# Requires the NET_ADMIN capability (cap_add: [NET_ADMIN] in compose) for tc to
# work. If NET_ADMIN is missing, tc fails: we log a clear warning and keep
# running WITHOUT latency rather than crashing the container.

set -u

# ---------------------------------------------------------------------------
# defaults
# ---------------------------------------------------------------------------
NETEM_DELAY="${NETEM_DELAY:-300}"
NETEM_JITTER="${NETEM_JITTER:-80}"
NETEM_LOSS="${NETEM_LOSS:-3}"
FLAKY_INTERVAL="${FLAKY_INTERVAL:-45}"
FLAKY_DOWN="${FLAKY_DOWN:-5}"
FLAKY_ENABLED="${FLAKY_ENABLED:-1}"

IFACE="eth0"

# ISO-ish timestamped log line to stdout (visible via `docker logs`).
log() {
  printf '[slow-entrypoint %s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

# Whether tc successfully installed the steady-state qdisc. Used to gate the
# blackout loop so we don't spam errors when NET_ADMIN is missing.
NETEM_ACTIVE=0

# Apply the steady-state netem profile (delay + jitter + loss). Returns non-zero
# if tc fails (e.g. missing NET_ADMIN) so callers can degrade gracefully.
apply_steady() {
  tc qdisc replace dev "$IFACE" root netem \
    delay "${NETEM_DELAY}ms" "${NETEM_JITTER}ms" distribution normal \
    loss "${NETEM_LOSS}%"
}

# Switch to a full blackout: 100% packet loss in both directions.
apply_blackout() {
  tc qdisc change dev "$IFACE" root netem loss 100%
}

# ---------------------------------------------------------------------------
# install the steady-state profile
# ---------------------------------------------------------------------------
log "applying netem: delay=${NETEM_DELAY}ms jitter=${NETEM_JITTER}ms loss=${NETEM_LOSS}% on ${IFACE}"
if apply_steady 2>/tmp/tc-err; then
  NETEM_ACTIVE=1
  log "applied netem steady-state profile OK"
else
  log "WARNING: failed to apply netem (tc error below). Two common causes:"
  log "WARNING:   1) NET_ADMIN capability missing — add 'cap_add: [NET_ADMIN]'."
  log "WARNING:   2) Kernel has no sch_netem module — Docker Desktop's WSL2 kernel"
  log "WARNING:      lacks it ('qdisc kind is unknown'); use the Toxiproxy server"
  log "WARNING:      (port 2206) on Windows/macOS instead. See SLOW-SERVERS.md."
  log "WARNING: Continuing WITHOUT latency so the container stays usable."
  while IFS= read -r line; do log "  tc: $line"; done < /tmp/tc-err
fi

# ---------------------------------------------------------------------------
# periodic blackout loop (background) — simulates intermittent disconnects
# ---------------------------------------------------------------------------
blackout_loop() {
  # Guard: never run the loop if the steady profile never installed; there is
  # nothing to flip and tc would just error every cycle.
  if [ "$NETEM_ACTIVE" != "1" ]; then
    log "blackout loop disabled: netem not active (no NET_ADMIN)"
    return 0
  fi

  log "blackout loop started: every ${FLAKY_INTERVAL}s blackout for ${FLAKY_DOWN}s"
  # Infinite loop is intentional (background daemon). Each tc call is guarded so
  # a transient failure logs and continues rather than killing the loop.
  while true; do
    sleep "$FLAKY_INTERVAL" || sleep 5
    log "BLACKOUT start (100% loss for ${FLAKY_DOWN}s)"
    if ! apply_blackout 2>/tmp/tc-bl-err; then
      log "BLACKOUT apply failed; skipping this cycle"
      while IFS= read -r line; do log "  tc: $line"; done < /tmp/tc-bl-err
      continue
    fi
    sleep "$FLAKY_DOWN" || sleep 1
    if apply_steady 2>/tmp/tc-bl-err; then
      log "BLACKOUT end (restored delay=${NETEM_DELAY}ms jitter=${NETEM_JITTER}ms loss=${NETEM_LOSS}%)"
    else
      log "BLACKOUT end: FAILED to restore steady profile; link may stay degraded"
      while IFS= read -r line; do log "  tc: $line"; done < /tmp/tc-bl-err
    fi
  done
}

if [ "$FLAKY_ENABLED" = "1" ]; then
  blackout_loop &
  log "blackout loop backgrounded (pid $!)"
else
  log "FLAKY_ENABLED=0 — steady-state only, no periodic blackouts"
fi

# ---------------------------------------------------------------------------
# run sshd in the foreground (keeps the container alive alongside the loop)
# ---------------------------------------------------------------------------
log "starting sshd (foreground)"
exec /usr/sbin/sshd -D -e 2>&1 | tee /var/log/sshd/sshd.log
