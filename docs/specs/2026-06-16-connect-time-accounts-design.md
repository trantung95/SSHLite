# Design: Connect-time accounts (host = endpoint, credentials per account)

- Date: 2026-06-16
- Status: Approved design, pending implementation plan
- Area: connection / auth UX
- Related code: `src/services/HostService.ts`, `src/providers/HostTreeProvider.ts`, `src/extension.ts` (addHost / addCredential / connectWithCredential), `src/types.ts`, `src/services/CredentialService.ts`
- Related docs: `.adn/flow/connection-flow.md`, `.adn/features/tree-providers.md`

## 1. Problem

Today a saved host is identified by `host:port:username` and the username plus private-key
path are collected during the **Add Host** wizard, then frozen into the host record
(`IHostConfig.id = "host:port:username"`, `src/types.ts:16`). Credentials are stored per
that same id (`sshLite:{hostId}:{credentialId}`, `CredentialService.getSecretKey`).

Consequences the user wants to remove:

- Add Host forces a username step and a private-key step up front.
- A host feels tied to one account. To use a second account on the same server the user
  must add a whole new host (or use Add User, which is not obvious as the primary path).
- There is no clean "enter a fresh password or passphrase for a new account at the moment I
  connect" path; the first account's credential is baked in at add time.

## 2. Goal

- **Host = server endpoint** (`host:port`). Username + credential (password OR
  key + passphrase, with file browse) belong to an **account** that lives under the host.
- **Add Host** collects only endpoint details (no username, no key).
- Accounts are added under the host via the existing **"Add User..."** affordance, which
  already prompts: username -> Password or Private Key -> browse file -> passphrase (only if
  the key is encrypted). Each new account gets its own credential.
- Applies to **both SSH and FTP**. A parity mechanism keeps the two protocol flows in sync.

## 3. Decisions (locked)

1. **Additive, backward compatible.** No id-scheme change for existing hosts, no migration.
   Existing saved hosts (with a username) keep working unchanged and render as account rows.
2. **Keep the existing tree + "Add User..." flow.** Do not invent a connect-time QuickPick.
   A new host shows as a server node with an **empty account list** plus the always-present
   "Add User..." button.
3. **Endpoint representation = `IHostConfig` with an empty `username`** (minimal). No new
   storage. The endpoint record persists in `sshLite.hosts` like any saved host; its id is
   effectively `host:port` (empty username segment).
4. **FTP included.** FTP hosts also become endpoints with accounts added via Add User
   (password-only; FTP has no key/passphrase). A reminder hook plus a parity test keep SSH
   and FTP auth/endpoint flows consistent in both directions.

## 4. Design

### 4.1 Data model (`src/types.ts`)

- `IHostConfig.username` becomes **optional** (`username?: string`).
  - Record **with** a username = one account (unchanged behaviour, existing data).
  - Record **without** a username = an **endpoint** (a host added but no account yet).
- Add a small derived helper, `isEndpointOnly(host) = !host.username`, used wherever the
  tree or connect logic must distinguish an endpoint from an account.
- `loadSavedHosts` (`HostService.ts`, ~line 172) currently rejects/normalises records with no
  username. Relax it to **accept endpoint records** (empty username) while still loading
  account records as before. The endpoint id stays stable and unique per `host:port`.

Credential storage is unchanged: accounts still key credentials by their account `hostId`
(`host:port:username`). Endpoints store no credential.

### 4.2 Add Host wizard (`HostService.promptAddHost`, ~line 600)

Collect endpoint-only fields, then save an endpoint record.

- SSH: protocol -> display name -> hostname -> port -> **save endpoint** (drop the username
  step and the private-key step).
- FTP: protocol -> display name -> hostname -> port -> FTPS/secure (endpoint-level) ->
  **save endpoint** (drop the username / anonymous / password steps, which move to Add User).

Auto-detection of default keys (`~/.ssh/id_rsa`, ...) in `buildAuthConfig` is unaffected and
stays as a connect-time fallback for SSH accounts.

### 4.3 Tree (`HostTreeProvider.getUserCredentialItems`, ~line 504)

- **Skip** endpoint records when building account rows (do not create a
  `UserCredentialTreeItem` for an empty-username record), but still let the endpoint record
  keep the `ServerTreeItem` alive in its `host:port` bucket.
- The `AddCredentialTreeItem` ("Add User...") is already appended unconditionally, so a fresh
  endpoint renders as: server node -> (no account rows) -> "Add User...".
- Server-node `contextValue` for an endpoint-only, disconnected, saved host resolves to
  `savedServer` (edit / remove / rename / copy still work on it).

### 4.4 Add User (`sshLite.addCredential`, extension.ts ~3226; helper `promptPrivateKeyAuth` ~101)

Branch by `host.connectionType`:

- **SSH** (unchanged): username -> duplicate check -> auth method QuickPick
  (Password | Private Key) -> password input **or** `promptPrivateKeyAuth` (browse/type key,
  passphrase only if `isPrivateKeyEncrypted`). Creates an account `IHostConfig` + a
  `SavedCredential`.
- **FTP** (new branch): username (or an "anonymous" choice) -> password input (skipped for
  anonymous). No key / passphrase options. Creates an account `IHostConfig` (FTP) +
  credential. The `anonymous` / `secure` flags resolve correctly for the new account.

The new account's `host`/`port`/`name`/`connectionType`/`secure` are copied from the
template (the endpoint or an existing account in the same server bucket).

### 4.5 Connect

- Click an account row -> `sshLite.connectWithCredential(hostConfig, credential)` (unchanged).
- Endpoint records have no username and **no `.command`**, so they are never connectable and
  cannot trigger a connect with an empty username. The server node itself only expands.

### 4.6 Backward compatibility / caller audit (LITE)

Endpoint records (empty username) must not leak into code paths that assume a username.
Audit and guard every reader of `host.username`, at minimum:

- export / import connections (`ConnectionImportPanel`, HostService import/export)
- `sshLite.copyHost`, `sshLite.editHost`, `sshLite.renameHost`
- monitor / terminal / tools commands gated on a connected server
- `buildAuthConfig` and both connect paths

Rule: an endpoint record is a server placeholder only. It is editable (name/host/port, and
FTPS for FTP), removable, copyable; it is never connected, never a credential owner.

### 4.7 SSH <-> FTP parity hook

Because the endpoint + Add User logic now exists in two protocol branches, a change to one
must be mirrored to the other. Deliverables:

1. **Parity reminder hook** (`.claude/hooks/` + `.claude/settings.json`): a PostToolUse hook
   that, when an edit touches the SSH auth/endpoint surface (the relevant regions of
   `HostService.ts` add-host, `extension.ts` addCredential, SSH connect), emits a reminder to
   review the FTP counterpart, and vice versa. The hook only reminds; it does not block.
2. **Parity test** (jest): assert the invariants that must hold for both protocols, e.g.
   - Add Host produces an endpoint record (empty username) for SSH and for FTP.
   - Each protocol exposes an Add User path that yields an account record + credential.
   - The tree renders an empty endpoint as server + "Add User..." for both protocols.
   This is the hard enforcement ("the same gap can never silently return"); the hook is the
   soft, in-editor nudge.

## 5. Non-goals

- No connect-time QuickPick account picker (explicitly rejected in favour of the tree).
- No change to credential storage keys or the `SavedCredential` shape.
- No migration of existing hosts; they keep their baked-in username and behaviour.
- No new top-level commands expected (command count unchanged). If that changes, update the
  five count locations + run `npm run docs:commands` and `npm run chaos:catalog` per CLAUDE.md.

## 6. Testing plan

- **Unit**
  - `HostService`: Add Host saves an endpoint (empty username) for SSH and FTP; FTPS flag kept.
  - `HostService.loadSavedHosts`: accepts endpoint records; still loads account records.
  - `HostTreeProvider`: an endpoint-only server renders no account rows + "Add User...".
  - `addCredential`: SSH branch (password / key+passphrase) and FTP branch (password / anon).
  - Caller-audit guards: endpoint record skipped/handled in export/import, copy, edit.
  - Parity test (section 4.7).
- **Docker** (server `sshlite-keys`, port 2216 — already up):
  - Add endpoint -> Add User `testuser` / `testpass` (password) -> connect succeeds.
  - Add User with key `test-docker/test-keys/id_rsa_encrypted`, passphrase `testphrase`
    (encrypted-key passphrase path) -> connect succeeds.
  - Add User `keyuser` (key-only, no password) -> connect succeeds, no password prompt.
  - Two accounts under one endpoint, each with its own credential, connect independently.
- Run `npm run compile` (0 errors) and `npx jest --no-coverage` before claiming done.

## 7. Docs to update on implementation

- `.adn/flow/connection-flow.md` (endpoint -> account -> credential resolution order)
- `.adn/features/tree-providers.md` (endpoint server with empty account list)
- `.adn/configuration/commands-reference.md` if any command title/contextValue changes
- `.adn/lessons.md` (SSH<->FTP parity rule) and the parity hook docs

## 8. Risks

- Empty-username records flowing into an unaudited `host.username` reader. Mitigated by the
  section 4.6 audit + guards and unit tests.
- FTP Add User branch must correctly resolve `anonymous` / `secure`; covered by unit tests.
- Parity drift between SSH and FTP over time; mitigated by the hook + parity test.
