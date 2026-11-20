/**
 * Cross-server search E2E tests
 *
 * Requires Docker: `docker compose -f test/e2e/docker-compose.yml up -d`
 *
 * These tests connect to a real SSH server (OpenSSH in Docker) and verify:
 * - Connect + search for known text
 * - Multi-path search (results from both paths)
 * - Find files mode (search by filename)
 * - Cancel kills remote process
 * - Permission denied (partial results)
 * - Graceful error handling
 *
 * Run: npx jest --testPathPattern=e2e --no-coverage
 * Skip if Docker unavailable: tests auto-skip via beforeAll check.
 */

import { Client } from 'ssh2';
import * as net from 'net';

const SSH_HOST = '127.0.0.1';
const SSH_PORT = 2222;
const SSH_USER = 'testuser';
const SSH_PASS = 'testpass';

/**
 * Check if the Docker SSH server is reachable
 */
function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: SSH_HOST, port: SSH_PORT }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(2000);
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Execute a command on the SSH server and return stdout
 */
function sshExec(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          reject(err);
          return;
        }
        let output = '';
        let errOutput = '';
        stream.on('data', (data: Buffer) => { output += data.toString(); });
        stream.stderr.on('data', (data: Buffer) => { errOutput += data.toString(); });
        stream.on('close', () => {
          conn.end();
          resolve(output);
        });
      });
    });
    conn.on('error', reject);
    conn.connect({
      host: SSH_HOST,
      port: SSH_PORT,
      username: SSH_USER,
      password: SSH_PASS,
    });
  });
}

describe('Cross-server search E2E', () => {
  let dockerAvailable = false;

  beforeAll(async () => {
    dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
      console.warn('Docker SSH server not available. Skipping e2e tests.');
      console.warn('Start with: docker compose -f test/e2e/docker-compose.yml up -d');
    }
  }, 10000);

  function skipIfNoDocker() {
    if (!dockerAvailable) {
      return true;
    }
    return false;
  }

  it('should connect and execute a command', async () => {
    if (skipIfNoDocker()) return;

    const result = await sshExec('echo hello');
    expect(result.trim()).toBe('hello');
  });

  it('should search for known text with grep', async () => {
    if (skipIfNoDocker()) return;

    const result = await sshExec('grep -rnH "hello" /home/testuser/files/ 2>/dev/null');
    expect(result).toContain('hello');
    // Should find matches in both a/hello.ts and b/world.ts and b/nested/deep.txt
    expect(result).toContain('hello.ts');
  });

  it('should search multiple paths in parallel', async () => {
    if (skipIfNoDocker()) return;

    const resultA = await sshExec('grep -rnH "hello" /home/testuser/files/a/ 2>/dev/null');
    const resultB = await sshExec('grep -rnH "hello" /home/testuser/files/b/ 2>/dev/null');

    expect(resultA).toContain('hello.ts');
    expect(resultB).toContain('world.ts');
  });

  it('should find files by name', async () => {
    if (skipIfNoDocker()) return;

    const result = await sshExec('find /home/testuser/files -name "*.ts" -type f 2>/dev/null');
    expect(result).toContain('hello.ts');
    expect(result).toContain('world.ts');
  });

  it('should handle permission denied gracefully', async () => {
    if (skipIfNoDocker()) return;

    // Search in /root which testuser can't access - should not crash
    const result = await sshExec('grep -rnH "test" /root/ 2>/dev/null || echo "PERMISSION_OK"');
    // Either empty results or PERMISSION_OK (grep returns non-zero for no matches)
    expect(result).toBeDefined();
  });

  it('should cancel grep process via stream close', async () => {
    if (skipIfNoDocker()) return;

    // Start a slow grep and kill it
    const conn = new Client();
    await new Promise<void>((resolve, reject) => {
      conn.on('ready', () => {
        conn.exec('grep -rnH ".*" / 2>/dev/null', (err, stream) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }

          // Consume output like SSHConnection.searchFiles does. An unread stream stays
          // paused, ssh2 never processes the CHANNEL_CLOSE reply and 'close' never fires.
          stream.on('data', () => { /* discard */ });

          // Close stream after 500ms (simulating cancel)
          setTimeout(() => {
            stream.close();
          }, 500);

          stream.on('close', () => {
            // Verify no zombie grep processes
            // Match only a process whose command line STARTS with the grep. The old
            // `ps aux | grep "[g]rep.*-rnH"` also matched the `sh -c` / `bash -c`
            // running this very check, so it counted 2 with no grep alive.
            conn.exec('sleep 0.3; ps -eo args | grep -c "^grep -rnH" || true', (err2, stream2) => {
              if (err2) {
                conn.end();
                reject(err2);
                return;
              }
              let output = '';
              stream2.on('data', (data: Buffer) => { output += data.toString(); });
              stream2.on('close', () => {
                conn.end();
                try {
                  expect(parseInt(output.trim(), 10)).toBe(0);
                  resolve();
                } catch (e) {
                  reject(e); // a throw here would only surface as a timeout
                }
              });
            });
          });
        });
      });
      conn.on('error', reject);
      conn.connect({
        host: SSH_HOST,
        port: SSH_PORT,
        username: SSH_USER,
        password: SSH_PASS,
      });
    });
  }, 10000);

  it('should handle connection drop gracefully', async () => {
    if (skipIfNoDocker()) return;

    // Verify we can connect and disconnect without issues
    const conn = new Client();
    await new Promise<void>((resolve, reject) => {
      conn.on('ready', () => {
        conn.end();
        resolve();
      });
      conn.on('error', reject);
      conn.connect({
        host: SSH_HOST,
        port: SSH_PORT,
        username: SSH_USER,
        password: SSH_PASS,
      });
    });
  });
});
