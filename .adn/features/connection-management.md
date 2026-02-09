# Connection Management

Covers `ConnectionManager`, `SSHConnection`, auto-reconnect, credential flow, and host key verification.

---

## ConnectionManager (`src/connection/ConnectionManager.ts`)

Singleton that orchestrates multiple SSH connections with auto-reconnect.

### State

```typescript
private _connections: Map<string, SSHConnection>;           // Active connections
private _disconnectedConnections: Map<string, DisconnectedConnectionInfo>;  // For reconnect
private _activeReconnectAttempts: Set<string>;              // Prevent duplicate reconnects
```

### Events

| Event | Fires When | Subscribers |
|-------|-----------|-------------|
| `onDidChangeConnections` | Connection added/removed/state changed | HostTreeProvider, FileTreeProvider, SearchPanel |
| `onConnectionStateChange` | Connection state transitions | FileTreeProvider (cache clear), extension.ts |
| `onReconnecting` | Reconnect attempt starts/stops | HostTreeProvider (status display) |

### Connection Flow

```
connect(host) or connectWithCredential(host, credential)
  │
  ├─ Check existing: if connected, return existing
  ├─ Create SSHConnection
  ├─ Subscribe to onStateChange
  ├─ Store in _connections Map
  ├─ Track in ActivityService
  ├─ await connection.connect()
  ├─ Set context: sshLite.hasConnections = true
  └─ Return connection
```

### Connection ID Format

```
${host}:${port}:${username}
// Example: "192.168.1.100:22:root"
```

This ID is used as the Map key and throughout the codebase for identifying connections.

---

## Auto-Reconnect State Machine

```
Connected
    │ (unexpected disconnect)
    ▼
Check isManualDisconnect?
    │
    ├─ YES → Clean up: remove from _connections + _disconnectedConnections
    │
    └─ NO → Check reconnectTimer exists?
         │
         ├─ YES → Skip (already reconnecting)
         │
         └─ NO → Start reconnect timer (3 second interval)
              │
              ▼
         Reconnecting (attempt N)
              │
              ├─ AuthenticationError → STOP reconnect (prevent lockout)
              │    └─ isNonRecoverableError() returns true
              │
              ├─ ConnectionError → RETRY (network may come back)
              │
              └─ Success → Restore state, fire events
```

**Key constants**:
- `RECONNECT_INTERVAL_MS = 3000` (3 seconds between attempts)
- `MAX_RECONNECT_ATTEMPTS = 0` (unlimited retries)

**Non-recoverable errors** (stop reconnect):
- "Invalid username" / empty username
- Authentication failures
- Host key mismatch

---

## SSHConnection (`src/connection/SSHConnection.ts`)

Wraps ssh2 `Client` for SSH operations and `SFTPWrapper` for file operations.

### Connect Sequence

```
1. Get credentials (from CredentialService or prompt user)
2. Create ssh2 Client
3. Set up host key verification (globalState fingerprint check)
4. Client.connect({
     host, port, username,
     password or privateKey,
     readyTimeout: 30000,
     keepaliveInterval: 30000
   })
5. On 'ready':
   a. Set state = Connected
   b. Detect server capabilities (OS, file watchers)
   c. Initialize SFTP subsystem
6. On 'error': Handle → set Error/Disconnected state
```

### Server Capabilities Detection

Runs on first connect to detect what the remote server supports:

```typescript
interface ServerCapabilities {
  os: 'linux' | 'darwin' | 'unknown';
  hasInotifywait: boolean;   // Linux file watcher
  hasFswatch: boolean;       // macOS file watcher
  watchMethod: 'inotifywait' | 'fswatch' | 'poll';
}
```

Detection commands:
- `uname -s` → OS type
- `which inotifywait` → Linux watcher
- `which fswatch` → macOS watcher

### Host Key Verification

Uses `vscode.Memento` (globalState) to store known host fingerprints:

```
1. On 'keyboard-interactive' / hostVerify callback:
2. Check globalState for stored fingerprint
3. If new host: prompt user to accept
4. If fingerprint changed: warn user (possible MITM)
5. Store accepted fingerprint in globalState
```

**Critical**: `setGlobalState()` MUST be called in extension.ts before any connections, or host verification silently fails.

### File Operations

| Method | Implementation |
|--------|---------------|
| `listFiles(path)` | `ls -la --time-style=+%s` via exec, parsed to IRemoteFile[] |
| `readFile(path)` | SFTP `readFile()` → Buffer |
| `writeFile(path, content)` | SFTP `writeFile()` |
| `deleteFile(path)` | SFTP `unlink()` or `rmdir()` |
| `mkdir(path)` | SFTP `mkdir()` |
| `stat(path)` | SFTP `stat()` → IRemoteFile |
| `exec(command)` | SSH exec → stdout string |
| `shell()` | SSH shell → ClientChannel (for terminals) |

### SSH Command Logging

ALL SSH commands logged to "SSH Lite" output channel:
```
[2026-02-09T10:15:32.123Z] [SSH 192.168.1.100] $ ls -la /home/user
[2026-02-09T10:15:32.456Z] [SFTP 192.168.1.100] READ: /home/user/config.json (2.1 KB)
```

---

## Credential Flow

```
User connects
  │
  ├─ Has SavedCredential? → Use stored password/key
  │   └─ CredentialService.getCredentialSecret(hostId, credentialId)
  │
  ├─ Has privateKeyPath in IHostConfig? → Use SSH key
  │   └─ Read key file, prompt for passphrase if encrypted
  │
  └─ No credentials? → Prompt for password
      └─ vscode.window.showInputBox({ password: true })
      └─ Optionally save via CredentialService
```

After successful connect with credential, `DisconnectedConnectionInfo` stores the credential for auto-reconnect.
