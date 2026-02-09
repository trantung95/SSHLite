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

Singleton service for SSH port forwarding (local → remote tunnels).

### Forward Creation

```
sshLite.forwardPort command:
  1. Prompt for local port
  2. Prompt for remote host (default: localhost)
  3. Prompt for remote port
  4. connection.forwardPort(localPort, remoteHost, remotePort)
  5. Store in active forwards list
  6. Update PortForwardTreeProvider
```

### Forward Storage

```typescript
interface IPortForward {
  id: string;           // Unique ID
  connectionId: string;
  localPort: number;
  remoteHost: string;   // Usually "localhost" or "127.0.0.1"
  remotePort: number;
  active: boolean;
}
```

### Forward Lifecycle

```
Forward created → listening on localPort → traffic tunneled
  │
  ├─ User stops: sshLite.stopForward → connection.stopForward(localPort)
  │
  ├─ Connection drops → forward stops
  │   └─ Auto-reconnect does NOT restore forwards
  │
  └─ User disconnects → all forwards for connection stop
```

### PortForwardTreeProvider (`src/providers/PortForwardTreeProvider.ts`)

Tree view showing active port forwards:

```
sshLite.portForwards
  └─ PortForwardTreeItem
       label: "localhost:3000 → remote:3000"
       contextValue: "portForward"
       icon: $(plug)
```

**Wire-up**: `portForwardService.setTreeProvider(portForwardTreeProvider)` in extension.ts connects the service to the UI.
