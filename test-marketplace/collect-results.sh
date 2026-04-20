#!/bin/bash
# Collect results from running/finished marketplace test containers
# Can run independently to check progress or final results

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="${SCRIPT_DIR}/logs/results"
TOTAL=${1:-50}

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

mkdir -p "${RESULTS_DIR}"

# Collect from docker logs
echo -e "${CYAN}Collecting results from containers...${NC}"
for i in $(seq 1 "${TOTAL}"); do
    name="marketplace-client-${i}"
    result_file="${RESULTS_DIR}/result-${i}.json"

    # Skip if already collected
    [ -f "${result_file}" ] && continue

    # Check if container exists
    status=$(docker inspect --format '{{.State.Status}}' "${name}" 2>/dev/null || echo "missing")
    [ "${status}" = "missing" ] && continue

    # Extract result JSON
    json=$(docker logs "${name}" 2>/dev/null | grep "^RESULT_JSON:" | tail -1 | sed 's/^RESULT_JSON://')
    [ -n "${json}" ] && echo "${json}" > "${result_file}"
done

# Report
echo ""
echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  SSH Lite Marketplace Test Results${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
echo ""

pass=0; fail=0; total_dur=0; min_dur=999999999; max_dur=0

for f in "${RESULTS_DIR}"/result-*.json; do
    [ -f "$f" ] || continue
    info=$(cat "$f" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(d.get('status',''), d.get('duration_ms',0))
" 2>/dev/null || echo "UNKNOWN 0")
    s=$(echo "$info" | cut -d' ' -f1)
    d=$(echo "$info" | cut -d' ' -f2)

    case "$s" in
        PASS)
            pass=$((pass + 1))
            total_dur=$((total_dur + d))
            [ "$d" -lt "$min_dur" ] && min_dur=$d
            [ "$d" -gt "$max_dur" ] && max_dur=$d
            ;;
        FAIL) fail=$((fail + 1)) ;;
    esac
done

reported=$((pass + fail))
running=$(docker ps --filter "name=marketplace-client-" --format "." 2>/dev/null | wc -l | tr -d ' ')
pending=$((TOTAL - reported))

echo -e "  ${GREEN}PASS:${NC}      ${pass}"
echo -e "  ${RED}FAIL:${NC}      ${fail}"
echo -e "  Reported:  ${reported} / ${TOTAL}"
echo -e "  Running:   ${running}"
echo -e "  Pending:   ${pending}"

if [ "$pass" -gt 0 ]; then
    echo ""
    echo -e "  ${CYAN}Timing (PASS):${NC}"
    echo -e "    Average:  $((total_dur / pass))ms"
    echo -e "    Min:      ${min_dur}ms"
    echo -e "    Max:      ${max_dur}ms"
fi

# Versions
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
        cat "$f" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('status')=='FAIL':
    print(f\"    #{d['container_id']} phase={d['phase']}: {d['message']}\")
" 2>/dev/null
    done
fi

echo ""
rate=0
[ "$reported" -gt 0 ] && rate=$((pass * 100 / reported))
if [ "$rate" -ge 95 ]; then
    echo -e "  Pass rate: ${GREEN}${rate}%${NC}"
elif [ "$rate" -ge 80 ]; then
    echo -e "  Pass rate: ${YELLOW}${rate}%${NC}"
else
    echo -e "  Pass rate: ${RED}${rate}%${NC}"
fi
echo ""
