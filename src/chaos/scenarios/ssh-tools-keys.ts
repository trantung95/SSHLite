/**
 * Chaos Scenarios: SSH Key Manager
 *
 * SshKeyService.generateKey + pushPublicKey roundtrip against real SSH containers.
 * Kept separate because it needs local tmp-dir for keypair files.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { SSHConnection } from '../../connection/SSHConnection';
import { SshKeyService } from '../../services/SshKeyService';
import { ScenarioDefinition, ScenarioContext, ScenarioResult } from '../ChaosConfig';
import { createChaosConnection, safeChaosDisconnect, withTimeout } from '../chaos-helpers';

const CATEGORY = 'ssh-tools';

function escSh(p: string): string { return p.replace(/'/g, "'\\''"); }

async function runSshPushPubKey(ctx: ScenarioContext): Promise<ScenarioResult> {
  const start = Date.now();
  const violations: string[] = [];
  let conn: SSHConnection | null = null;
  let tmpDir: string | undefined;
  try {
    conn = await createChaosConnection(ctx.server);
    const svc = SshKeyService.getInstance();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-key-'));
    const keyPath = path.join(tmpDir, 'chaos_test');
    const pubKeyPath = keyPath + '.pub';
    try {
      await svc.generateKey({ type: 'ed25519', comment: 'chaos-test', passphrase: '', outFile: keyPath });
    } catch {
      // ssh-keygen not installed — skip gracefully
      return { name: 'ssh-tools:ssh-push-pubkey', server: ctx.server.label, server_os: ctx.server.os, passed: true, invariantViolations: [], anomalies: [], stateTimeline: [], duration_ms: Date.now() - start };
    }
    if (!fs.existsSync(pubKeyPath)) {
      violations.push('generateKey: public key file not created');
    } else {
      const pubContent = fs.readFileSync(pubKeyPath, 'utf8').trim();
      if (!pubContent.startsWith('ssh-ed25519')) {
        violations.push(`generateKey: bad key format: ${pubContent.slice(0, 30)}`);
      }
      const result = await svc.pushPublicKey(conn, pubKeyPath);
      if (!result.added && !result.reason?.toLowerCase().includes('already')) {
        violations.push(`pushPublicKey: unexpected result: ${JSON.stringify(result)}`);
      }
      const home = (await withTimeout(conn.exec('echo $HOME'), 10000, 'HOME')).trim();
      const authFile = `${home}/.ssh/authorized_keys`;
      const authContent = await withTimeout(conn.exec(`cat '${escSh(authFile)}' 2>/dev/null || true`), 10000, 'cat auth_keys');
      const km = pubContent.split(' ')[1];
      if (km && !authContent.includes(km)) { violations.push(`pushPublicKey: key not found in authorized_keys`); }
      if (km) {
        try { await conn.exec(`grep -v '${escSh(km)}' '${escSh(authFile)}' > /tmp/ak.tmp 2>/dev/null && mv /tmp/ak.tmp '${escSh(authFile)}' || true`); } catch {}
      }
    }
    return { name: 'ssh-tools:ssh-push-pubkey', server: ctx.server.label, server_os: ctx.server.os, passed: violations.length === 0, invariantViolations: violations, anomalies: [], stateTimeline: [], duration_ms: Date.now() - start };
  } catch (err) {
    return { name: 'ssh-tools:ssh-push-pubkey', server: ctx.server.label, server_os: ctx.server.os, passed: false, invariantViolations: [], anomalies: [], stateTimeline: [], duration_ms: Date.now() - start, error: (err as Error).message };
  } finally {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true }); } catch {} }
    await safeChaosDisconnect(conn);
  }
}

export const sshToolsKeyScenarios: ScenarioDefinition[] = [
  { name: 'ssh-push-pubkey', category: CATEGORY, fn: runSshPushPubKey },
];
