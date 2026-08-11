# Terminal & Port Forwarding

Covers `TerminalService` and `PortForwardService`.

---

## TerminalService (`src/services/TerminalService.ts`)

Singleton service for creating Secure Shell (SSH) terminals in Visual Studio Code (VS Code).

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

### Native-parity PTY (`term` + forwarded env)

SSH Lite's terminal is a VS Code `Pseudoterminal` whose input is written raw to an ssh2 `shell()` channel and whose output is fired raw to the terminal — so it is a faithful PTY. Remote shell plugins and TUI apps (oh-my-zsh, powerlevel10k, starship, **fzf-tab**, zsh-autosuggestions / -syntax-highlighting, bash-completion, ble.sh, vim/neovim, tmux, htop/btop, lazygit, ranger/lf/nnn, mc, k9s) run entirely on the remote and "just work" through this channel, exactly as in a native `ssh user@host` session — SSH Lite does not implement them, it provides the PTY they need.

To match a native session, `TerminalService` requests the PTY with two things (set once when the channel opens — no polling, no extra server commands, fully LITE):

1. **`term`** — `getTermType()` reads `sshLite.terminal.termType` (default `xterm-256color`). Without this, ssh2 defaults `$TERM` to `vt100`, under which 256-color menus, box-drawing, and prompts render wrong.
2. **`env`** — `buildShellEnv()` forwards the client's locale (`LANG`, `LC_*`) and `COLORTERM`, mirroring OpenSSH's default `SendEnv LANG LC_*`. Gated by `sshLite.terminal.forwardEnv` (default on) and merged with user-defined `sshLite.terminal.env`. Only values that actually exist locally are forwarded (never a fabricated locale, which would trigger remote `setlocale` warnings). The remote `sshd` must allow them via `AcceptEnv` — most distributions allow `LANG LC_*` by default; if the server rejects them the request is silently ignored (harmless, server keeps its default).

**Plumbing** (the chokepoint every terminal path funnels through): `SSHConnection.shell(pty?, opts?)` forwards to ssh2 `client.shell(pty, opts, cb)`; a bare `shell()` keeps the old `vt100` behaviour (backward-compat for the chaos suite and any non-terminal caller). `CommandGuard.openShell(connection, pty?, opts?)` threads the same options for the channel-guarded paths (`openTerminal` / `openTerminalHere` in `extension.ts`); the direct paths (`FileService`, `ServerMonitorService` → `createTerminal`) get them inside `createTerminal`.

**Capability matrix** — what is already native vs. what is out of reach:

| Capability | Status |
|---|---|
| `$TERM` 256-color, login-shell rc sourcing (so plugins load), window resize/SIGWINCH, mouse reporting, alternate screen, bracketed paste, arrow/F-keys, Ctrl-C/Z/D, 24-bit truecolor escapes | Work via the faithful PTY + byte pass-through (truecolor also needs `COLORTERM` forwarded **and** a remote app that opts in, e.g. vim `termguicolors`) |
| Locale `LANG`/`LC_*`, `COLORTERM` | Forwarded — **server-gated** by `sshd` `AcceptEnv` |
| OSC 52 clipboard (remote app → local clipboard) | **Not available** — VS Code does not yet implement it (upstream microsoft/vscode#210302) |
| Some `Alt`/`Meta` and chord keys | Intercepted by VS Code; user tunes `terminal.integrated.sendKeybindingsToShell` / `commandsToSkipShell` |

> Out of scope by design: extension-side autocomplete (intercepting TAB / querying the server per keystroke) would mean automatic server commands + polling — a LITE violation. Native shell completion (and fzf-tab) already cover this on the remote.

### Activity event (`onActivity`)

`TerminalService` exposes a public event `onActivity: vscode.Event<'input'|'output'>`, a coarse signal that fires on terminal input (user typing) or output (data from the shell), carrying only the direction tag, never the keystroke or data content. `extension.ts` forwards it to the Support view coder via `SupportViewProvider.notifyTyped('terminal-in'|'terminal-out')`, so the animated coder reacts to activity in SSH Lite's own terminals. See `.adn/features/support-view.md`.

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

## Channel Limit Handling

SSH servers enforce a maximum number of concurrent channels (`MaxSessions`, typically 10). During heavy parallel content search, terminal opens may be delayed.

**Terminal behaviour:** shows "Waiting for a free channel to open terminal..." progress notification while queued. Opens automatically when a search channel frees up. Times out after 30 seconds and shows: *"Failed to open terminal: all SSH channels are busy (30s timeout). Stop a search or wait and try again."*

**Search behaviour:** automatically reduces max concurrent search threads on channel-limit failure and retries the failed command (up to 3 times). Users see search completing at reduced parallelism without any error.

**Configuration:** `sshLite.maxChannelsPerServer` (default 8) — reduce if your server has `MaxSessions` set below 10; increase for servers with higher limits.

---

## PortForwardService (`src/services/PortForwardService.ts`)

Singleton service for SSH port forwarding (local → remote tunnels) with **persistent saved rules**.

### Forward Creation

```
sshLite.forwardPort command:
  1. Select a Secure Shell (SSH) server; only connected servers are available
  2. Enter the destination service port and destination host (default: localhost)
  3. Enter the listening port on the user's computer
  4. connection.forwardPort(localPort, remoteHost, remotePort)
  5. Store in active forwards list
  6. Auto-save rule to globalState for persistence
  7. Update PortForwardTreeProvider
```

The three native Visual Studio Code steps use consistent titles. Port validation
accepts only American Standard Code for Information Interchange (ASCII) decimal
digits representing integers from 1 through 65535. It rejects surrounding
whitespace, signs, hexadecimal notation, exponent notation, decimals, and local
ports already forwarded by any active connection. Success feedback states the
complete route and that the rule was saved. A failed interactive creation explains the reason and gives
stage-specific recovery: another local port for bind conflicts, storage access
for persistence failures, or connection recovery for connection failures.
`Retry` appears only when retrying is safe; saved-rule activation and automatic
restore keep their existing behavior.

Saved-rule writes use a candidate snapshot: in-memory state changes only after
`globalState.update()` succeeds. Writes are serialized so simultaneous forward
creation cannot overwrite another saved rule. If persistence fails after the
local listener starts, creation stops that listener and removes its tree row before offering
`Retry`. The rollback also removes a tree row when adding it mutated provider
state before a refresh notification failed. If listener rollback fails, the error omits `Retry` and directs the
user to stop the active forward first.

The serialized write queue keeps ownership across disposal and reactivation.
Each queued write captures its extension lifecycle generation and the exact
extension context that owns the write. A completion from a disposed lifecycle
cannot replace reactivated in-memory rules, and the next lifecycle write waits
behind the pending write before persisting its own snapshot. The
`sshLite.savedPortForwards` schema is unchanged.

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
- **Restore failure state**: A failed auto-restore remains visible with its error reason for the current extension session. The failure registry is a nested in-memory map keyed separately by host identifier and rule identifier, so delimiter-bearing backward-compatible values remain distinct. It is never written to `globalState`; the saved-rule format remains backward-compatible. Service disposal clears the failure registry, cached saved rules, extension context, and tree-provider reference before normal reactivation reloads persisted rules.

### Forward Lifecycle

```
Forward created → listening on localPort → traffic tunneled → rule auto-saved
  │
  ├─ User stops: sshLite.stopForward → TCP server stops, saved rule persists
  │   └─ Tree shows dimmed SavedForwardTreeItem
  │
  ├─ Connection drops → TCP servers stop, saved rules persist
  │   └─ Auto-reconnect restores connection AND forwards automatically
  │       └─ Failed rule remains visible as "Restore failed · reason"
  │
  ├─ User disconnects → TCP servers stop, saved rules persist
  │   └─ Next connect restores forwards automatically
  │
  ├─ VSCode restarts → saved rules survive
  │   └─ Next connect restores forwards automatically
  │
  └─ User deletes rule: sshLite.deleteSavedForward → modal confirmation → rule removed permanently
```

The delete confirmation names the local route, destination, persistence
consequence, and the boundary that no server data is deleted. It states that the
rule will not restore on future connections unless recreated. A custom destination
host remains visible instead of being replaced by the Secure Shell (SSH) server name.

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
  └─ PortForwardServerGroupTreeItem (server, expanded by default)
       description: "1 active · 2 saved"
       ├─ PortForwardTreeItem        (active, blue icon)
       │    label: "localhost:3000 → host:3000"
       │    description: "Active"
       │    contextValue: "forward"
       │    action: stop
       │
       └─ SavedForwardTreeItem       (inactive)
            label: "localhost:8080 → host:8080"
            description: "Saved · stopped", "Host disconnected",
                         "Port forwarding unavailable", or "Restore failed · reason"
            contextValue: "savedForward"
            actions: play, delete
```

Root groups are the union of port-forward-capable connected servers with active forwards and every server identifier with saved rules. A removed host therefore keeps an orphan group keyed by its original `hostId`; no saved rule disappears from the tree. A same-identifier File Transfer Protocol (FTP) connection does not make a saved rule startable: activation checks capability before calling `forwardPort()` and shows a Secure Shell recovery message instead of rejecting the command. Active rows render before inactive saved rows. `getParent()` returns the cached group with stable identifier `port-forward-server:<hostId>` so reveal and expand/collapse operations keep a stable hierarchy. Saved rows use `saved:<JSON tuple>` identifiers, preserving the stored rule identifier while preventing composite-key collisions.

Restore batches log one `restore/begin` event and one `restore/complete` event through the SSH Lite output channel. The completion payload includes counts and failed rule reasons without logging inside the per-rule loop.

**Wire-up**: `portForwardService.setTreeProvider(portForwardTreeProvider)` and `portForwardService.initialize(context)` in `extension.ts` connect the service to the user interface and persistence.

## User Actions

| Action | Primitives | Notes |
|---|---|---|
| Run terminal | shell, runShort | |
| Run command | runShort, runFailing | |
