#!/bin/bash
# Entrypoint for key-auth Docker containers.
# Copies test SSH public keys into authorized_keys for testuser and keyuser.
# Then starts sshd in the foreground.

set -e

# Setup SSH key auth for testuser (supports both password + key)
TESTUSER_SSH="/home/testuser/.ssh"
mkdir -p "$TESTUSER_SSH"
if [ -f /test-keys/authorized_keys ]; then
  cp /test-keys/authorized_keys "$TESTUSER_SSH/authorized_keys"
  chmod 700 "$TESTUSER_SSH"
  chmod 600 "$TESTUSER_SSH/authorized_keys"
  chown -R testuser:testuser "$TESTUSER_SSH"
fi

# Setup SSH key auth for keyuser (key-only, no password)
KEYUSER_SSH="/home/keyuser/.ssh"
mkdir -p "$KEYUSER_SSH"
if [ -f /test-keys/authorized_keys ]; then
  cp /test-keys/authorized_keys "$KEYUSER_SSH/authorized_keys"
  chmod 700 "$KEYUSER_SSH"
  chmod 600 "$KEYUSER_SSH/authorized_keys"
  chown -R keyuser:keyuser "$KEYUSER_SSH"
fi

# Start sshd in foreground
exec /usr/sbin/sshd -D -e
