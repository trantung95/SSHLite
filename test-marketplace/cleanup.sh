#!/bin/bash
# Clean up all marketplace test containers and infrastructure

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Stopping and removing test client containers..."
docker ps -a --filter "name=marketplace-client-" --format "{{.Names}}" 2>/dev/null | \
    xargs -r docker rm -f 2>/dev/null || true

echo "Stopping SSH target servers..."
docker compose -f "${SCRIPT_DIR}/docker-compose.yml" down 2>/dev/null || true

echo "Removing test network..."
docker network rm marketplace-test-net 2>/dev/null || true

echo "Cleanup complete."
echo ""
echo "To also remove the VS Code client image:"
echo "  docker rmi marketplace-vscode-client"
echo ""
echo "To remove result logs:"
echo "  rm -rf ${SCRIPT_DIR}/logs/results/"
