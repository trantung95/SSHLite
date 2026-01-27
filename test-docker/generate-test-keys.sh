#!/bin/bash
# Generate SSH test keys for integration testing.
# Creates RSA, Ed25519, and encrypted RSA keys in test-docker/test-keys/.
# This script is idempotent — it skips generation if keys already exist.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KEYDIR="$SCRIPT_DIR/test-keys"

mkdir -p "$KEYDIR"

# RSA key (unencrypted)
if [ ! -f "$KEYDIR/id_rsa_test" ]; then
  ssh-keygen -t rsa -b 2048 -f "$KEYDIR/id_rsa_test" -N "" -q
  echo "Generated: id_rsa_test (RSA 2048-bit)"
else
  echo "Exists: id_rsa_test"
fi

# Ed25519 key (unencrypted)
if [ ! -f "$KEYDIR/id_ed25519_test" ]; then
  ssh-keygen -t ed25519 -f "$KEYDIR/id_ed25519_test" -N "" -q
  echo "Generated: id_ed25519_test (Ed25519)"
else
  echo "Exists: id_ed25519_test"
fi

# RSA key (encrypted with passphrase "testphrase")
if [ ! -f "$KEYDIR/id_rsa_encrypted" ]; then
  ssh-keygen -t rsa -b 2048 -f "$KEYDIR/id_rsa_encrypted" -N "testphrase" -q
  echo "Generated: id_rsa_encrypted (RSA 2048-bit, passphrase: testphrase)"
else
  echo "Exists: id_rsa_encrypted"
fi

# Build authorized_keys from all public keys
cat "$KEYDIR"/*.pub > "$KEYDIR/authorized_keys"
chmod 600 "$KEYDIR/authorized_keys"
echo "Built: authorized_keys ($(wc -l < "$KEYDIR/authorized_keys") keys)"

echo "All test keys ready in $KEYDIR"
