# Connection Flow

Complete flow from user clicking a host to established SSH connection.

---

## Flow Diagram

```
User clicks host in tree (or runs sshLite.connect)
    │
    ▼
extension.ts: sshLite.connect handler
    │
    ├─ From ServerTreeItem? → Use item.hosts
    │   ├─ Single user → use directly
    │   └─ Multiple users → showQuickPick to select
    │
    ├─ From UserCredentialTreeItem? → Use item.hostConfig
    │
    └─ No argument (command palette)? → showQuickPick from all hosts
    │
    ▼
Show progress notification: "Connecting to {name}..."
    │
    ▼
ConnectionManager.connect(hostConfig)
    │
    ├─ Check existing connection → if already connected, return it
    │
    ├─ Clear any pending reconnect timer
    │
    ▼
Create new SSHConnection(host)
    │
    ├─ Subscribe to onStateChange
    ├─ Store in _connections Map
    ├─ Track in ActivityService
    │
    ▼
SSHConnection.connect()
    │
    ├─ Get credentials:
    │   ├─ SavedCredential provided? → Use stored secret
    │   ├─ privateKeyPath in config? → Read key file
    │   └─ No credentials → prompt password (showInputBox)
    │
    ├─ Create ssh2 Client
    │
    ├─ Host key verification:
    │   ├─ Check globalState for stored fingerprint
    │   ├─ New host → prompt user to accept
    │   ├─ Changed fingerprint → warn user (MITM risk)
    │   └─ Store accepted fingerprint
    │
    ▼
Client.connect({
  host, port, username,
  password/privateKey,
  readyTimeout: 30000,
  keepaliveInterval: 30000
})
    │
    ├─ 'ready' event:
    │   1. State → Connected
    │   2. detectServerCapabilities()
    │      → uname -s (OS type)
    │      → which inotifywait/fswatch (file watcher)
    │   3. Initialize SFTP subsystem
    │
    ├─ 'error' event:
    │   ├─ AuthenticationError → State = Error (no auto-reconnect)
    │   └─ ConnectionError → State = Disconnected (auto-reconnect)
    │
    └─ 'close' event:
        └─ State → Disconnected → auto-reconnect starts
    │
    ▼
Connection established
    │
    ├─ ActivityService.completeActivity()
    ├─ setContext('sshLite.hasConnections', true)
    ├─ Fire onDidChangeConnections event
    │
    ▼
Event subscribers react:
    │
    ├─ HostTreeProvider.refresh() → show green icon
    ├─ FileTreeProvider.refresh() → show file tree
    ├─ SearchPanel.updateServerConnection() → update checkbox
    └─ Status bar: "$(check) Connected to {name}"
```

---

## Error Handling

```typescript
try {
  await connectionManager.connect(hostConfig);
} catch (error) {
  const errMsg = (error as Error).message;

  // Actionable suggestions based on error type
  if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ETIMEDOUT'))
    → "Check if the server is running and the port is correct."

  if (errMsg.includes('authentication') || errMsg.includes('Permission denied'))
    → "Verify your username and password/key."

  if (errMsg.includes('ENOTFOUND') || errMsg.includes('getaddrinfo'))
    → "Check the hostname - it may be misspelled or unreachable."

  vscode.window.showErrorMessage(`Connection failed: ${errMsg}${suggestion}`);
}
```

---

## Credential Resolution Order

```
1. Explicit credential (connectWithCredential) → use it directly
2. Saved credentials (CredentialService) → use first matching
3. Private key in host config (privateKeyPath) → read key file
4. SSH agent (if available) → try agent auth
5. Prompt user for password → showInputBox({ password: true })
```

**Password prompt is a LAST RESORT (legacy/no-credential path in `buildAuthConfig`).**
The plain `sshLite.connect` command reaches `buildAuthConfig` WITHOUT a SavedCredential.
There, the login-password box is shown ONLY when there is no other way to
authenticate — no private key (config or default `~/.ssh/id_*`) and no SSH agent.
When a key or agent IS present the user is never prompted for a password; a
previously SAVED password (`creds.get`, no prompt) is still attached silently as
a fallback in case the key/agent is rejected.

**Passphrase prompt is shown ONLY when the key is actually encrypted.** Every
key-credential setup flow decides this via `isPrivateKeyEncrypted()`
(`src/connection/keyEncryption.ts`), which delegates to ssh2's own
`utils.parseKey` — the exact parser the live connection uses. The three sites:
the legacy `buildAuthConfig` path (`sshLite.connect`), the `connectWithCredential`
first-connect setup, and `promptPrivateKeyAuth` (the "add user with key"
command). `connectToPinnedFolder` and auto-reconnect reuse an existing saved
credential, so they never prompt. An unencrypted key
connects with NO prompt at all (no password, no passphrase). This replaced an
older `keyText.includes('ENCRYPTED')` heuristic that (a) prompted for a
passphrase on every connect of an unencrypted key, and (b) silently MISSED
encrypted keys in the modern OpenSSH format (cipher in the base64 body, no
"ENCRYPTED" header). A passphrase is a separate prompt from a login password.

---

## Post-Connection Setup

After connection, the extension automatically:

1. **Loads file tree** → FileTreeProvider shows remote files
2. **Starts preloading** (if enabled) → FolderHistoryService provides paths
3. **Updates search panel** → Server marked as connected
4. **Detects server capabilities** → OS type, file watchers
5. **Begins auto-refresh** (if timer > 0) → Periodic file tree updates
