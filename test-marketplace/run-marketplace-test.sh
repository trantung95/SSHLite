#!/bin/bash
# Marketplace Installation Stress Test
# Launches 50 containers in batches over ~30 minutes
# Each container installs SSH Lite from VS Code Marketplace and tests SSH
# Results collected from docker logs (RESULT_JSON: prefix)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOTAL_CONTAINERS=60
BATCH_SIZE=10
BATCH_DELAY_SECONDS=360  # 6 min between batches = 5 batches over ~30 min
RESULTS_DIR="${SCRIPT_DIR}/logs/results"
NETWORK_NAME="marketplace-test-net"
SSH_TARGETS=("ssh-target-1" "ssh-target-2" "ssh-target-3" "ssh-target-4" "ssh-target-5")
IMAGE_NAME="marketplace-vscode-client"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${CYAN}[$(date '+%H:%M:%S')]${NC} $*"; }

header() {
    echo ""
    echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $*${NC}"
    echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
}

# --- Cleanup previous ---
cleanup_containers() {
    log "Cleaning up previous test containers..."
    docker ps -a --filter "name=marketplace-client-" --format "{{.Names}}" 2>/dev/null | \
        xargs -r docker rm -f 2>/dev/null || true
}

# --- Build ---
build_images() {
    header "Building Docker images"
    log "Building SSH target servers..."
    docker compose -f "${SCRIPT_DIR}/docker-compose.yml" build --quiet 2>&1
    log "Building VS Code client..."
    docker build -t "${IMAGE_NAME}" -f "${SCRIPT_DIR}/Dockerfile.vscode-client" "${SCRIPT_DIR}" 2>&1 | tail -3
    log "Images ready"
}

# --- Start SSH targets ---
start_ssh_targets() {
    header "Starting SSH target servers"
    docker compose -f "${SCRIPT_DIR}/docker-compose.yml" up -d 2>&1
    sleep 3
    for target in "${SSH_TARGETS[@]}"; do
        if docker ps --filter "name=marketplace-${target}" --format "{{.Status}}" | grep -q "Up"; then
            log "  ${GREEN}OK${NC} ${target}"
        else
            log "  ${RED}FAIL${NC} ${target}"
            exit 1
        fi
    done
}

# --- Launch container ---
launch_container() {
    local id=$1
    local name="marketplace-client-${id}"
    local target="${SSH_TARGETS[$((RANDOM % ${#SSH_TARGETS[@]}))]}"

    docker run -d \
        --name "${name}" \
        --network "${NETWORK_NAME}" \
        -e "CONTAINER_ID=${id}" \
        -e "SSH_HOST=${target}" \
        -e "SSH_PORT=22" \
        -e "SSH_USER=testuser" \
        -e "SSH_PASS=testpass" \
        "${IMAGE_NAME}" > /dev/null 2>&1
}

# --- Launch batch ---
launch_batch() {
    local batch=$1 start_id=$2 count=$3
    local end_id=$((start_id + count - 1))

    header "Batch ${batch}: containers ${start_id}-${end_id}"

    local ok=0 fail=0
    for i in $(seq "${start_id}" "${end_id}"); do
        if launch_container "$i"; then
            ok=$((ok + 1))
        else
            fail=$((fail + 1))
            log "  ${RED}Failed to launch #${i}${NC}"
        fi
    done
    log "Launched: ${GREEN}${ok}${NC}  Failed: ${RED}${fail}${NC}"
}

# --- Collect results from docker logs ---
collect_result() {
    local id=$1
    local name="marketplace-client-${id}"
    local result_file="${RESULTS_DIR}/result-${id}.json"

    # Skip if already collected
    [ -f "${result_file}" ] && return 0

    # Check if container has exited
    local status=$(docker inspect --format '{{.State.Status}}' "${name}" 2>/dev/null || echo "missing")
    [ "${status}" != "exited" ] && return 1

    # Extract RESULT_JSON from logs
    local json=$(docker logs "${name}" 2>/dev/null | grep "^RESULT_JSON:" | tail -1 | sed 's/^RESULT_JSON://')
    if [ -n "${json}" ]; then
        echo "${json}" > "${result_file}"
        return 0
    fi
    return 1
}

collect_all_results() {
    for i in $(seq 1 "${TOTAL_CONTAINERS}"); do
        collect_result "$i" 2>/dev/null || true
    done
}

# --- Progress ---
show_progress() {
    collect_all_results

    local pass=0 fail=0
    for f in "${RESULTS_DIR}"/result-*.json; do
        [ -f "$f" ] || continue
        local s=$(cat "$f" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
        case "$s" in
            PASS) pass=$((pass + 1)) ;;
            FAIL) fail=$((fail + 1)) ;;
        esac
    done

    local reported=$((pass + fail))
    local running=$(docker ps --filter "name=marketplace-client-" --format "." 2>/dev/null | wc -l | tr -d ' ')
    local pending=$((TOTAL_CONTAINERS - reported))

    log "Progress: ${GREEN}${pass} PASS${NC} | ${RED}${fail} FAIL${NC} | ${YELLOW}${pending} pending${NC} | running: ${running}"
}

# --- Wait for completion ---
wait_for_completion() {
    local max_wait=600
    local elapsed=0

    header "Waiting for all containers (max ${max_wait}s)"

    while [ "$elapsed" -lt "$max_wait" ]; do
        local running=$(docker ps --filter "name=marketplace-client-" --format "." 2>/dev/null | wc -l | tr -d ' ')
        show_progress

        if [ "$running" -eq 0 ]; then
            log "All containers finished"
            collect_all_results
            break
        fi

        sleep 15
        elapsed=$((elapsed + 15))
    done

    if [ "$elapsed" -ge "$max_wait" ]; then
        log "${YELLOW}Timeout. Killing remaining containers...${NC}"
        docker ps --filter "name=marketplace-client-" --format "{{.Names}}" 2>/dev/null | \
            xargs -r docker kill 2>/dev/null || true
        sleep 2
        collect_all_results
    fi
}

# --- Final report ---
final_report() {
    header "FINAL REPORT"

    local pass=0 fail=0 total_dur=0 min_dur=999999999 max_dur=0

    for f in "${RESULTS_DIR}"/result-*.json; do
        [ -f "$f" ] || continue
        local s=$(cat "$f" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status',''),d.get('duration_ms',0))" 2>/dev/null)
        local status=$(echo "$s" | cut -d' ' -f1)
        local dur=$(echo "$s" | cut -d' ' -f2)

        case "$status" in
            PASS)
                pass=$((pass + 1))
                total_dur=$((total_dur + dur))
                [ "$dur" -lt "$min_dur" ] && min_dur=$dur
                [ "$dur" -gt "$max_dur" ] && max_dur=$dur
                ;;
            FAIL) fail=$((fail + 1)) ;;
        esac
    done

    local total=$((pass + fail))
    local missing=$((TOTAL_CONTAINERS - total))

    echo ""
    echo -e "  Total containers:   ${TOTAL_CONTAINERS}"
    echo -e "  Reported:           ${total}"
    echo -e "  ${GREEN}Passed:             ${pass}${NC}"
    echo -e "  ${RED}Failed:             ${fail}${NC}"
    [ "$missing" -gt 0 ] && echo -e "  ${YELLOW}Missing/Timeout:    ${missing}${NC}"

    if [ "$pass" -gt 0 ]; then
        echo ""
        echo -e "  Avg duration:       $((total_dur / pass))ms"
        echo -e "  Min duration:       ${min_dur}ms"
        echo -e "  Max duration:       ${max_dur}ms"
    fi

    local rate=0
    [ "$total" -gt 0 ] && rate=$((pass * 100 / total))
    echo ""
    if [ "$rate" -ge 95 ]; then
        echo -e "  Pass rate:          ${GREEN}${rate}%${NC}"
    elif [ "$rate" -ge 80 ]; then
        echo -e "  Pass rate:          ${YELLOW}${rate}%${NC}"
    else
        echo -e "  Pass rate:          ${RED}${rate}%${NC}"
    fi

    # Extension versions
    echo ""
    echo -e "  ${CYAN}Extension versions:${NC}"
    for f in "${RESULTS_DIR}"/result-*.json; do
        [ -f "$f" ] || continue
        cat "$f" | python3 -c "import sys,json; print(json.load(sys.stdin).get('extension_version','unknown'))" 2>/dev/null
    done | sort | uniq -c | sort -rn | while read count ver; do
        echo "    ${count}x ${ver}"
    done

    # Failures
    if [ "$fail" -gt 0 ]; then
        echo ""
        echo -e "  ${RED}=== FAILURES ===${NC}"
        for f in "${RESULTS_DIR}"/result-*.json; do
            [ -f "$f" ] || continue
            local info=$(cat "$f" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('status')=='FAIL':
    print(f\"  #{d['container_id']} phase={d['phase']}: {d['message']}\")
" 2>/dev/null)
            [ -n "$info" ] && echo -e "    ${RED}${info}${NC}"
        done

        echo ""
        echo -e "  ${CYAN}Failures by phase:${NC}"
        for f in "${RESULTS_DIR}"/result-*.json; do
            [ -f "$f" ] || continue
            cat "$f" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('status')=='FAIL': print(d.get('phase','unknown'))
" 2>/dev/null
        done | sort | uniq -c | sort -rn | while read count phase; do
            echo "    ${count}x ${phase}"
        done
    fi

    # Missing containers
    if [ "$missing" -gt 0 ]; then
        echo ""
        echo -e "  ${YELLOW}Missing containers (check: docker logs marketplace-client-N):${NC}"
        for i in $(seq 1 "${TOTAL_CONTAINERS}"); do
            [ ! -f "${RESULTS_DIR}/result-${i}.json" ] && echo "    #${i}"
        done | head -20
    fi

    echo ""
}

# --- Main ---
main() {
    header "SSH Lite - Marketplace Installation Stress Test"
    log "Config: ${TOTAL_CONTAINERS} containers, ${BATCH_SIZE}/batch, ${BATCH_DELAY_SECONDS}s gap"
    log "Estimated time: ~$((BATCH_DELAY_SECONDS * (TOTAL_CONTAINERS / BATCH_SIZE - 1) / 60 + 5)) min"

    mkdir -p "${RESULTS_DIR}"
    rm -f "${RESULTS_DIR}"/result-*.json

    cleanup_containers
    build_images
    start_ssh_targets

    local num_batches=$(( (TOTAL_CONTAINERS + BATCH_SIZE - 1) / BATCH_SIZE ))

    for batch in $(seq 1 "${num_batches}"); do
        local start_id=$(( (batch - 1) * BATCH_SIZE + 1 ))
        local remaining=$((TOTAL_CONTAINERS - start_id + 1))
        local count=$((remaining < BATCH_SIZE ? remaining : BATCH_SIZE))

        launch_batch "${batch}" "${start_id}" "${count}"

        if [ "$batch" -gt 1 ]; then
            show_progress
        fi

        if [ "$batch" -lt "${num_batches}" ]; then
            log "Next batch in ${BATCH_DELAY_SECONDS}s..."
            sleep "${BATCH_DELAY_SECONDS}"
        fi
    done

    wait_for_completion
    final_report

    # Save text report
    REPORT="${RESULTS_DIR}/summary-$(date +%Y%m%d-%H%M%S).txt"
    final_report 2>&1 | sed 's/\x1b\[[0-9;]*m//g' > "${REPORT}"
    log "Report saved: ${REPORT}"

    # Cleanup all containers and SSH targets
    header "Cleanup"
    cleanup_containers
    docker compose -f "${SCRIPT_DIR}/docker-compose.yml" down 2>/dev/null || true
    log "All containers and SSH targets removed"
}

trap 'echo ""; log "Interrupted!"; cleanup_containers; docker compose -f "${SCRIPT_DIR}/docker-compose.yml" down 2>/dev/null; exit 1' INT TERM

main "$@"
