#!/bin/bash
# Test runner: installs SSH Lite from VS Code Marketplace and tests SSH connection
# Each container runs this script independently
# Result JSON is emitted as the LAST line of stdout, prefixed with RESULT_JSON:

set -uo pipefail

CONTAINER_ID="${CONTAINER_ID:-unknown}"
SSH_HOST="${SSH_HOST:-ssh-target}"
SSH_PORT="${SSH_PORT:-22}"
SSH_USER="${SSH_USER:-testuser}"
SSH_PASS="${SSH_PASS:-testpass}"

# VS Code CLI flags for headless container usage
export DONT_PROMPT_WSL_INSTALL=1
CODE_FLAGS="--no-sandbox --user-data-dir=/home/tester/.vscode-data"

# Timestamps
start_time=$(date +%s%3N)

log() {
    echo "[Container ${CONTAINER_ID}] $(date '+%H:%M:%S') $*"
}

emit_result() {
    local status="$1"
    local phase="$2"
    local message="$3"
    local end_time=$(date +%s%3N)
    local duration_ms=$((end_time - start_time))

    log "Result: ${status} at phase=${phase} (${duration_ms}ms)"
    # Emit JSON on last line - orchestrator parses this
    echo "RESULT_JSON:{\"container_id\":\"${CONTAINER_ID}\",\"status\":\"${status}\",\"phase\":\"${phase}\",\"message\":\"${message}\",\"duration_ms\":${duration_ms},\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"vscode_version\":\"${VSCODE_VERSION:-unknown}\",\"extension_version\":\"${EXT_VERSION:-unknown}\"}"
}

# --- Phase 1: Check VS Code installation ---
log "Phase 1: Checking VS Code installation..."
VSCODE_VERSION=$(code ${CODE_FLAGS} --version 2>/dev/null | head -1 || echo "not-installed")
if [ "${VSCODE_VERSION}" = "not-installed" ]; then
    emit_result "FAIL" "vscode_check" "VS Code not found"
    exit 1
fi
log "VS Code version: ${VSCODE_VERSION}"

# --- Phase 2: Search marketplace for SSH Lite ---
log "Phase 2: Searching marketplace for 'SSH Lite'..."

SEARCH_RESULT=$(code ${CODE_FLAGS} --list-extensions 2>/dev/null || true)
log "Currently installed extensions: $(echo "${SEARCH_RESULT}" | wc -l | tr -d ' ')"

# --- Phase 3: Install extension from marketplace ---
log "Phase 3: Installing hybr8.ssh-lite from marketplace..."
install_start=$(date +%s%3N)

INSTALL_OUTPUT=$(code ${CODE_FLAGS} --install-extension hybr8.ssh-lite --force 2>&1) || {
    install_end=$(date +%s%3N)
    install_duration=$((install_end - install_start))
    log "INSTALL FAILED after ${install_duration}ms: ${INSTALL_OUTPUT}"
    emit_result "FAIL" "extension_install" "Install failed after ${install_duration}ms"
    exit 1
}

install_end=$(date +%s%3N)
install_duration=$((install_end - install_start))
log "Install completed in ${install_duration}ms"
log "Install output: ${INSTALL_OUTPUT}"

# --- Phase 4: Verify extension is installed ---
log "Phase 4: Verifying extension installation..."
INSTALLED=$(code ${CODE_FLAGS} --list-extensions 2>/dev/null)
if echo "${INSTALLED}" | grep -qi "ssh-lite"; then
    log "Extension verified in installed list"
else
    log "WARNING: Extension not found in list. List: ${INSTALLED}"
    emit_result "FAIL" "extension_verify" "Extension not in --list-extensions output"
    exit 1
fi

# Get extension version
EXT_VERSION=$(code ${CODE_FLAGS} --list-extensions --show-versions 2>/dev/null | grep -i ssh-lite | head -1 || echo "unknown")
log "Installed extension: ${EXT_VERSION}"

# --- Phase 5: Check extension files ---
log "Phase 5: Checking extension package integrity..."
EXT_DIR=$(find /home/tester/.vscode/extensions -maxdepth 1 -name "*ssh-lite*" -type d 2>/dev/null | head -1)
if [ -z "${EXT_DIR}" ]; then
    emit_result "FAIL" "extension_files" "Extension directory not found"
    exit 1
fi

# Check critical files exist
MISSING_FILES=""
for f in "package.json" "out/extension.js"; do
    if [ ! -f "${EXT_DIR}/${f}" ]; then
        MISSING_FILES="${MISSING_FILES} ${f}"
    fi
done

if [ -n "${MISSING_FILES}" ]; then
    emit_result "FAIL" "extension_files" "Missing files:${MISSING_FILES}"
    exit 1
fi

# Check package.json is valid JSON
if ! jq empty "${EXT_DIR}/package.json" 2>/dev/null; then
    emit_result "FAIL" "extension_files" "package.json is invalid JSON"
    exit 1
fi

# Get extension metadata
EXT_NAME=$(jq -r '.displayName // .name' "${EXT_DIR}/package.json")
EXT_PKG_VERSION=$(jq -r '.version' "${EXT_DIR}/package.json")
log "Extension: ${EXT_NAME} v${EXT_PKG_VERSION}"

# Count files in extension
FILE_COUNT=$(find "${EXT_DIR}" -type f | wc -l | tr -d ' ')
DIR_SIZE=$(du -sh "${EXT_DIR}" 2>/dev/null | cut -f1)
log "Extension size: ${DIR_SIZE}, files: ${FILE_COUNT}"

# --- Phase 6: Test SSH connection to target server ---
log "Phase 6: Testing SSH connection to ${SSH_HOST}:${SSH_PORT}..."
ssh_start=$(date +%s%3N)

# Wait for SSH server to be ready (max 30 seconds)
for i in $(seq 1 30); do
    if sshpass -p "${SSH_PASS}" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=2 \
        -p "${SSH_PORT}" "${SSH_USER}@${SSH_HOST}" "echo ok" 2>/dev/null; then
        break
    fi
    if [ "$i" -eq 30 ]; then
        emit_result "FAIL" "ssh_connect" "SSH server not reachable after 30s"
        exit 1
    fi
    sleep 1
done

ssh_end=$(date +%s%3N)
ssh_duration=$((ssh_end - ssh_start))
log "SSH connection successful in ${ssh_duration}ms"

# --- Phase 7: Test SFTP operations (what the extension does) ---
log "Phase 7: Testing SFTP operations..."

# List remote directory
SFTP_LIST=$(sshpass -p "${SSH_PASS}" ssh -o StrictHostKeyChecking=no \
    -p "${SSH_PORT}" "${SSH_USER}@${SSH_HOST}" "ls -la /home/testuser/" 2>&1) || {
    emit_result "FAIL" "sftp_list" "Failed to list remote directory"
    exit 1
}
log "Remote listing: $(echo "${SFTP_LIST}" | wc -l) entries"

# Read remote file
SFTP_READ=$(sshpass -p "${SSH_PASS}" ssh -o StrictHostKeyChecking=no \
    -p "${SSH_PORT}" "${SSH_USER}@${SSH_HOST}" "cat /home/testuser/projects/readme.txt" 2>&1) || {
    emit_result "FAIL" "sftp_read" "Failed to read remote file"
    exit 1
}
log "Remote file content: ${SFTP_READ}"

# --- All phases passed ---
log "ALL PHASES PASSED"
emit_result "PASS" "complete" "All checks passed. Install:${install_duration}ms SSH:${ssh_duration}ms Ext:${EXT_NAME} v${EXT_PKG_VERSION} Size:${DIR_SIZE}(${FILE_COUNT}files)"
