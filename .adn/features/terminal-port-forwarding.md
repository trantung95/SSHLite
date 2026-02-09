# Terminal & Port Forwarding

Covers `TerminalService` and `PortForwardService`.

---

## TerminalService (`src/services/TerminalService.ts`)

Singleton service for creating SSH terminals in VS Code.

### Terminal Creation

```
sshLite.openTerminal command:
  1. Select connection (or use tree item's connection)
  2. Create VS Code Terminal with SSH shell:
     - connection.shell() → ClientChannel
     - vscode.window.createTerminal({ pty: customPty })
  3. Wire channel I/O to terminal pty
  4. Terminal name: "[SSH] hostname" or "[label] hostname" (if tabLabel set)

sshLite.openTerminalHere command:
  Same as openTerminal but starts in the selected folder's path
  → Sends "cd /path" command after shell ready
```

### Connection Reuse

**LITE principle**: Terminals reuse the existing SSH connection. No new SSH session is created — `connection.shell()` opens a new channel on the existing multiplexed connection.

### Terminal Lifecycle

```
Terminal created → shell channel active → user interacts
  │
  ├─ User closes terminal → channel.close()
  │
  ├─ Connection drops → terminal shows disconnect
  │   └─ Auto-reconnect restores connection but NOT terminal
  │
  └─ User disconnects → all terminals for connection close
```

---

## PortForwardService (`src/services/PortForwardService.ts`)

Singleton service for SSH port forwarding (local → remote tunnels) with **persistent saved rules**.

### Forward Creation

```
sshLite.forwardPort command:
  1. Prompt for local port
  2. Prompt for remote host (default: localhost)
  3. Prompt for remote port
  4. connection.forwardPort(localPort, remoteHost, remotePort)
  5. Store in active forwards list
  6. Auto-save rule to globalState for persistence
  7. Update PortForwardTreeProvider
```

### Data Types

```typescript
// Active forward (in-memory, tied to live TCP server)
interface IPortForward {
  id: string;           // "localPort:connectionId"
  connectionId: string;
  localPort: number;
  remoteHost: string;   // Usually "localhost" or "127.0.0.1"
  remotePort: number;
  active: boolean;
}

// Saved forward rule (persisted in globalState, survives restarts)
interface ISavedPortForwardRule {
  id: string;           // "pf_timestamp_random"
  localPort: number;
  remoteHost: string;
  remotePort: number;
}
```

### Persistence

Rules are saved to `context.globalState` under key `sshLite.savedPortForwards`, indexed by `hostId` (format: `host:port:username`).

- **Auto-save**: Every `forwardPort()` call automatically saves the rule
- **Auto-restore**: On `ConnectionState.Connected` event, saved rules are restored via `restoreForwardsForConnection()`
- **Deduplication**: Rules are deduped by `localPort + remoteHost + remotePort` within a host
- **Initialization**: `portForwardService.initialize(context)` loads saved rules on activation

### Forward Lifecycle

```
Forward created → listening on localPort → traffic tunneled → rule auto-saved
  │
  ├─ User stops: sshLite.stopForward → TCP server stops, saved rule persists
  │   └─ Tree shows dimmed SavedForwardTreeItem
  │
  ├─ Connection drops → TCP servers stop, saved rules persist
  │   └─ Auto-reconnect restores connection AND forwards automatically
  │
  ├─ User disconnects → TCP servers stop, saved rules persist
  │   └─ Next connect restores forwards automatically
  │
  ├─ VSCode restarts → saved rules survive
  │   └─ Next connect restores forwards automatically
  │
  └─ User deletes rule: sshLite.deleteSavedForward → rule removed permanently
```

### Commands

| Command | Trigger | Description |
|---------|---------|-------------|
| `sshLite.forwardPort` | View title button | Create new forward (auto-saved) |
| `sshLite.stopForward` | Active forward inline | Stop TCP server, keep saved rule |
| `sshLite.activateSavedForward` | Saved forward inline | Re-activate a saved rule |
| `sshLite.deleteSavedForward` | Saved forward inline | Remove saved rule permanently |

### PortForwardTreeProvider (`src/providers/PortForwardTreeProvider.ts`)

Tree view showing both active forwards and saved-but-inactive rules:

```
sshLite.portForwards
  ├─ PortForwardTreeItem          (active, blue icon)
  │    label: "host:3000 <-> localhost:3000"
  │    contextValue: "forward"
  │    action: stop
  │
  └─ SavedForwardTreeItem         (inactive, dimmed icon)
       label: "host:8080 <-> localhost:8080"
       contextValue: "savedForward"
       actions: play, delete
```

**Wire-up**: `portForwardService.setTreeProvider(portForwardTreeProvider)` and `portForwardService.initialize(context)` in extension.ts connect the service to the UI and persistence.
