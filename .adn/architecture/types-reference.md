# Types Reference

All core interfaces and types defined in `src/types.ts` and `src/types/progressive.ts`.

---

## Core Interfaces

### IHostConfig

SSH host configuration. Source: `src/types.ts`

```typescript
type ConnectionType = 'ssh' | 'ftp';

interface IHostConfig {
  id: string;              // Unique key: "${host}:${port}:${username}"
  name: string;            // Display name
  host: string;            // Hostname or IP
  port: number;            // Port (default: 22 for SSH, 21 for FTP)
  username: string;        // Authentication username ('anonymous' for anonymous FTP)
  privateKeyPath?: string; // Path to private key file (SSH only)
  tabLabel?: string;       // Custom tab prefix (e.g., "PRD", "DEV")
  source: 'ssh-config' | 'saved';  // Origin of this config
  connectionType?: ConnectionType; // Transport. Absent means 'ssh' (backward compat)
  secure?: boolean;        // FTP only: use explicit FTPS (TLS)
  anonymous?: boolean;     // FTP only: anonymous login
}
```

**Notes**:
- `id` is the connection identifier used throughout the codebase
- `tabLabel` shows as `[PRD]` instead of `[SSH]` in editor tabs when set
- `source` distinguishes between ~/.ssh/config entries and manually saved hosts
- `connectionType` is optional for backward compatibility; use the `getConnectionType(host)` helper which defaults a missing value to `'ssh'` (issue #9)

### IRemoteFile

Remote file/directory metadata. Source: `src/types.ts`

```typescript
interface IRemoteFile {
  name: string;            // File/directory name
  path: string;            // Full remote path
  isDirectory: boolean;    // Directory flag
  size: number;            // Size in bytes
  modifiedTime: number;    // Unix timestamp (milliseconds)
  accessTime?: number;     // Last access (optional)
  owner?: string;          // Owner username (optional)
  group?: string;          // Group name (optional)
  permissions?: string;    // Unix permissions "rwxr-xr-x" (optional)
  connectionId: string;    // Links to connection
}
```

### IConnection / ISSHConnection (issue #9)

Connections are split into a protocol-agnostic `IConnection` (implemented by both
`SSHConnection` and `FTPConnection`) and an SSH-only `ISSHConnection extends IConnection`
that adds the ssh2-coupled surface. Source: `src/types.ts`. See
[connection-protocols.md](../features/connection-protocols.md).

```typescript
interface IConnectionCapabilities {
  type: ConnectionType;       // 'ssh' or 'ftp'
  supportsExec: boolean;      // false for FTP
  supportsShell: boolean;     // false for FTP
  supportsPortForward: boolean;
  supportsNativeWatch: boolean;  // false for FTP (poll instead)
  supportsSearch: boolean;
  supportsServerBackup: boolean;
  supportsSudo: boolean;
}

interface IConnection {
  readonly id: string;
  readonly host: IHostConfig;
  readonly state: ConnectionState;
  readonly capabilities: IConnectionCapabilities;
  readonly onStateChange: Event<ConnectionState>;
  readonly onFileChange: Event<{ remotePath: string; event: 'modify'|'delete'|'create' }>;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  dispose(): void;

  // File operations (work over both SSH and FTP)
  listFiles(remotePath: string): Promise<IRemoteFile[]>;
  readFile(remotePath: string): Promise<Buffer>;
  writeFile(remotePath: string, content: Buffer): Promise<void>;
  deleteFile(remotePath: string): Promise<void>;
  mkdir(remotePath: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  stat(remotePath: string): Promise<IRemoteFile>;
  fileExists(remotePath: string): Promise<boolean>;

  // Resolve the default/home directory (SSH: echo ~ / realpath; FTP: PWD after login)
  resolveHomePath(): Promise<string>;
}

interface ISSHConnection extends IConnection {
  readonly client: Client | null;  // ssh2 Client (SSH only)
  exec(command: string): Promise<string>;
  shell(): Promise<ClientChannel>;
  forwardPort(localPort: number, remoteHost: string, remotePort: number): Promise<void>;
  stopForward(localPort: number): Promise<void>;
}

// Helpers (src/types.ts)
function getConnectionType(host: IHostConfig): ConnectionType; // missing => 'ssh'
function isSSHConnection(c: IConnection): c is ISSHConnection;  // c.capabilities.supportsExec
```

`ConnectionFactory.createConnection(host, credential)` returns a `FTPConnection`
when `getConnectionType(host) === 'ftp'`, otherwise a `SSHConnection`.
`ConnectionManager` stores `Map<string, IConnection>` and calls the factory.

### ISavedPortForwardRule

Saved port forward rule (persisted in globalState, survives restarts). Source: `src/types.ts`

```typescript
interface ISavedPortForwardRule {
  id: string;              // Unique identifier ("pf_timestamp_random")
  localPort: number;       // Local port to listen on
  remoteHost: string;      // Remote host (usually "localhost")
  remotePort: number;      // Remote port
}
```

Stored in `context.globalState` under key `sshLite.savedPortForwards`, indexed by `hostId`.

### IPortForward

Active port forward configuration (in-memory). Source: `src/types.ts`

```typescript
interface IPortForward {
  id: string;              // Unique identifier ("localPort:connectionId")
  connectionId: string;    // Connection ID
  localPort: number;       // Local port
  remoteHost: string;      // Remote host (usually "localhost")
  remotePort: number;      // Remote port
  active: boolean;         // Whether forward is active
}
```

### ITransferProgress

File transfer progress reporting. Source: `src/types.ts`

```typescript
interface ITransferProgress {
  path: string;
  transferred: number;    // Bytes transferred
  total: number;           // Total bytes
  direction: 'upload' | 'download';
}
```

---

## Enums

### ConnectionState

```typescript
enum ConnectionState {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Reconnecting = 'reconnecting',
  Error = 'error',
}
```

**Used by**: ConnectionManager (auto-reconnect logic), HostTreeProvider (icon colors), extension.ts (context keys)

**Key behavior**: `AuthenticationError` sets state to `Error` and stops auto-reconnect. `ConnectionError` sets to `Disconnected` and triggers reconnect.

---

## Error Hierarchy

```typescript
SSHError extends Error
  ├─ code: string
  ├─ cause?: Error
  │
  ├─ AuthenticationError (code: 'AUTH_FAILED')
  │   → Non-recoverable: stops auto-reconnect
  │   → Example: wrong password, invalid key
  │
  ├─ ConnectionError (code: 'CONNECTION_FAILED')
  │   → May be recoverable: triggers auto-reconnect
  │   → Example: ECONNREFUSED, ETIMEDOUT, network drop
  │
  ├─ SFTPError (code: 'SFTP_ERROR')
  │   → File operation failed
  │   → Example: permission denied, file not found
  │
  ├─ FTPError (code: 'FTP_ERROR')
  │   → FTP transport/operation failed (issue #9)
  │   → Extends SSHError so the reconnect classifier keeps working
  │
  └─ UnsupportedOverFtpError (code: 'FTP_UNSUPPORTED')
      → A shell-only operation was attempted over FTP
```

**Important**: Error type determines reconnect behavior in ConnectionManager. `AuthenticationError` prevents reconnect to avoid account lockout.

---

## Credential Types

Defined in `src/services/CredentialService.ts`:

```typescript
interface SavedCredential {
  id: string;
  label: string;
  type: 'password' | 'privateKey';
  privateKeyPath?: string;
  pinnedFolders?: PinnedFolder[];
}

interface PinnedFolder {
  name: string;
  remotePath: string;
}
```

**Storage model**:
- Metadata (id, label, type, pinnedFolders) → VS Code settings (`sshLite.credentialIndex`)
- Secrets (actual password/passphrase) → OS keychain via SecretStorage API
- Session cache → In-memory for performance

---

## Activity Types

Defined in `src/services/ActivityService.ts`:

```typescript
type ActivityType = 'connect' | 'download' | 'upload' | 'terminal' | 'search' | 'delete' | 'other';
```

---

## Progressive Download Types

Defined in `src/types/progressive.ts`:

```typescript
const PROGRESSIVE_PREVIEW_SCHEME = 'ssh-lite-preview';

// Used for custom URI scheme: ssh-lite-preview://connectionId/remotePath?lines=1000
```

Used by `ProgressiveFileContentProvider` to serve preview content for large files before full download completes.
