#!/usr/bin/env bash
# Real VS Code uninstall / reinstall end-to-end test — Linux leg (runs INSIDE
# the container; HOME=/home/node is a throwaway fake home).
#
#   1. install VSIX with the VS Code CLI, launch VS Code, wait for activate()
#   2. seed hooks with the extension's own HookInstallerService (fixture)
#   3. `code --uninstall-extension`, relaunch VS Code: it runs vscode:uninstall
#   4. assert hooks + staged files are gone, user config kept, tombstone left
#   5. reinstall + relaunch: tombstone consumed, auto-setup flag cleared
set -euo pipefail

E2E=/e2e
VSIX="$E2E/.artifacts/ssh-lite.vsix"
APP=/opt/VSCode-linux-x64
CLI="$APP/bin/code"
EXT_DIR="$HOME/.vscode/extensions"
WS="$HOME/ws"
LOG="$HOME/code-gui.log"
mkdir -p "$WS"

code_cli() { "$CLI" --no-sandbox "$@" 2>&1 | grep -v DeprecationWarning || true; }

start_gui() {
  echo "--- launching VS Code ($1)"
  xvfb-run -a "$APP/code" --no-sandbox --disable-gpu --disable-workspace-trust \
    --skip-welcome --skip-release-notes --disable-telemetry --new-window "$WS" >>"$LOG" 2>&1 &
}

stop_gui() {
  pkill -f "$APP/code" || true
  for _ in $(seq 1 30); do pgrep -f "$APP/code" >/dev/null || return 0; sleep 1; done
  pkill -9 -f "$APP/code" || true
  sleep 1
}

# wait_for <seconds> <e2e phase that exits 0 when ready>
wait_for() {
  local secs=$1 phase=$2
  for _ in $(seq 1 "$secs"); do
    node "$E2E/e2e.js" "$phase" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "TIMEOUT waiting for $phase"; tail -40 "$LOG" || true
  return 1
}

[ -f "$VSIX" ] || { echo "missing $VSIX (run scripts/test-vscode-uninstall.js)"; exit 2; }
echo "VS Code $("$CLI" --version --no-sandbox 2>/dev/null | head -1)"

echo "=== 1. install + activate"
node "$E2E/e2e.js" prepare-home
code_cli --install-extension "$VSIX" --force
start_gui "first start"
wait_for 90 registry-has-install
sleep 3   # let activate() finish its other startup steps
stop_gui
node "$E2E/e2e.js" activated

echo "=== 2. seed hooks (fixture = NPC panel auto-setup result)"
node "$E2E/e2e.js" seed "$EXT_DIR"

echo "=== 3. uninstall + restart (VS Code runs vscode:uninstall on this start)"
code_cli --uninstall-extension hybr8.ssh-lite
ls "$EXT_DIR" || true
start_gui "after uninstall"
wait_for 90 registry-has-tombstone
sleep 3
stop_gui
ls "$EXT_DIR" || true
node "$E2E/e2e.js" after-uninstall

echo "=== 4. reinstall + activate"
code_cli --install-extension "$VSIX" --force
start_gui "after reinstall"
wait_for 90 registry-tombstone-consumed
sleep 3
stop_gui
node "$E2E/e2e.js" after-reinstall

echo "=== ALL PHASES PASSED"
