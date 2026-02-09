# Types Reference

All core interfaces and types defined in `src/types.ts` and `src/types/progressive.ts`.

---

## Core Interfaces

### IHostConfig

SSH host configuration. Source: `src/types.ts`

```typescript
interface IHostConfig {
  id: string;              // Unique key: "${host}:${port}:${username}"
  name: string;            // Display name
  host: string;            // Hostname or IP
  port: number;            // SSH port (default: 22)
  username: string;        // Authentication username
  privateKeyPath?: string; // Path to private key file
  tabLabel?: string;       // Custom tab prefix (e.g., "PRD", "DEV")
  source: 'ssh-config' | 'saved';  // Origin of this config
}
```

**Notes**:
- `id` is the connection identifier used throughout the codebase
- `tabLabel` shows as `[PRD]` instead of `[SSH]` in editor tabs when set
- `source` distinguishes between ~/.ssh/config entries and manually saved hosts

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

### ISSHConnection

SSH connection interface. Source: `src/types.ts`

```typescript
interface ISSHConnection {
  readonly id: string;
  readonly host: IHostConfig;
  readonly state: ConnectionState;
  readonly client: Client | null;  // ssh2 Client

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  exec(command: string): Promise<string>;
  shell(): Promise<ClientChannel>;

  // File operations
  listFiles(remotePath: string): Promise<IRemoteFile[]>;
  readFile(remotePath: string): Promise<Buffer>;
  writeFile(remotePath: string, content: Buffer): Promise<void>;
  deleteFile(remotePath: string): Promise<void>;
  mkdir(remotePath: string): Promise<void>;
  stat(remotePath: string): Promise<IRemoteFile>;

  // Port forwarding
  forwardPort(localPort: number, remoteHost: string, remotePort: number): Promise<void>;
  stopForward(localPort: number): Promise<void>;
}
```

### IPortForward

Port forward configuration. Source: `src/types.ts`

```typescript
interface IPortForward {
  id: string;              // Unique identifier
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
  └─ SFTPError (code: 'SFTP_ERROR')
      → File operation failed
      → Example: permission denied, file not found
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
