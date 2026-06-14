/**
 * Shared helpers for the docker FTP integration suites (issue #9).
 *
 * Not a *.test.ts file, so it is never collected as a suite — it just holds
 * utilities imported by docker-ftp-*.test.ts.
 */
import { FTPConnection } from '../connection/FTPConnection';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry connect() until it succeeds or the budget runs out.
 *
 * pure-ftpd (port 2208) blocks new connections while it generates its
 * self-signed certificate + 2048-bit DH parameters on first boot, so a freshly
 * started container answers with "Server sent FIN packet unexpectedly" (plain
 * FTP) or a TLS handshake error (explicit FTPS) for the first ~30-90s. A warm
 * container connects on the first attempt; this loop only spends wall-clock
 * while the server is still warming up, keeping the suite robust whether the
 * container was just `docker compose up`-ed or has been running for a while.
 *
 * Retrying on the same FTPConnection is safe: a failed connect() leaves the
 * instance in the Error state with a nulled client, and the next connect()
 * builds a fresh basic-ftp client.
 */
export async function connectWithRetry(conn: FTPConnection, budgetMs = 90000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let lastErr: unknown;
  for (;;) {
    try {
      await conn.connect();
      return;
    } catch (err) {
      lastErr = err;
      if (Date.now() >= deadline) {
        break;
      }
      await sleep(3000);
    }
  }
  throw lastErr;
}
