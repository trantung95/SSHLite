# Design: Connect-time accounts (host = endpoint, credentials per account)

- Date: 2026-06-16
- Status: Approved design, pending implementation plan
- Area: connection / auth UX
- Related code: `src/services/HostService.ts`, `src/providers/HostTreeProvider.ts`, `src/extension.ts` (addHost / addCredential / connectWithCredential), `src/types.ts`, `src/services/CredentialService.ts`, `src/services/ConnectionPortabilityService.ts`, `src/commands/connectionSyncCommands.ts`, `src/webviews/ConnectionImportPanel.ts`, `src/utils/connectionPrefix.ts`
- Related docs: `.adn/flow/connection-flow.md`, `.adn/features/tree-providers.md`, `.adn/features/connection-portability.md`

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

1. **Additive, backward compatible.** No id-scheme change for existing account hosts, no
   migration. Existing saved hosts (with a username) keep working unchanged and render as
   account rows.
2. **Keep the existing tree + "Add User..." flow.** Do not invent a connect-time QuickPick.
   A new host shows as a server node with an **empty account list** plus the always-present
   "Add User..." button.
3. **Endpoint representation = a single `IHostConfig` record with NO username AND an explicit
   `isEndpoint: true` flag** (no separate store). The empty username alone is NOT enough:
   the codebase has falsy `!h.username` guards that would silently drop the record (see 4.8,
   FM-1), so an explicit boolean flag is required to distinguish a deliberate endpoint from a
   malformed/legacy record. This stays within the "one IHostConfig, no new storage" choice.
4. **FTP included.** FTP hosts also become endpoints with accounts added via Add User
   (password-only; FTP has no key/passphrase). A reminder hook plus a parity test keep SSH
   and FTP auth/endpoint flows consistent in both directions.
5. **One connectability chokepoint (audit-driven).** Endpoints are rejected at a single
   boundary (`ConnectionManager.connect` / `ConnectionFactory.createConnection`) and
   `FTPConnection.connect` gets the empty-username guard `SSHConnection` already has. This
   neutralises the entire "connected path" class of bugs at once.
6. **Endpoint persists; it is filtered, not deleted.** Adding the first account does not delete
   the endpoint record. Guards ensure it never appears as a connectable/selectable item.
7. **ids normalise username to `''`, never `undefined`.** All id build/parse goes through the
   new `src/utils/hostId.ts` helpers so an endpoint id is `host:port:` (never the literal
   `host:port:undefined`), and parsing is right-anchored (IPv6-safe).

**Full-source audit:** a 5-agent scan of the entire `src/` tree produced the consolidated,
de-duplicated implementation checklist in the companion file
`2026-06-16-connect-time-accounts-audit.md` (8 root-cause guards G1-G8, every call site, and
four newly-found criticals B1-B4: FTP silent anonymous login, `"undefined"` id interpolation,
a `matchesFilter` crash, and the VS Code settings schema). The audit is authoritative for the
implementation; sections 4.6 and 4.8 below summarise it.

## 4. Design

### 4.1 Data model (`src/types.ts`)

- `IHostConfig.username` becomes **optional** (`username?: string`).
- Add `IHostConfig.isEndpoint?: boolean`. A record is an endpoint when `isEndpoint === true`;
  such a record has no username and owns no credential. Helper `isEndpointHost(host)`
  centralises the check (used by tree, connect, export/import, management ops).
- The endpoint id is `host:port:` (empty username segment) but is NEVER parsed with a naive
  `split(':')`. All id construction and parsing goes through two new helpers (4.8, Guard 3).
- `loadSavedHosts` (`HostService.ts`, ~line 184) currently skips any record failing the
  truthy `!h.username` test. Replace that blanket skip with an endpoint-aware branch:
  endpoint records load; account records still require a username.

Credential storage is unchanged: accounts still key credentials by their account `hostId`
(`host:port:username`). Endpoints store no credential.

### 4.2 Add Host wizard (`HostService.promptAddHost`, ~line 600)

Collect endpoint-only fields, then save an endpoint record (`isEndpoint: true`, no username).

- SSH: protocol -> display name -> hostname -> port -> **save endpoint** (drop the username
  step and the private-key step).
- FTP: protocol -> display name -> hostname -> port -> FTPS/secure (endpoint-level) ->
  **save endpoint** (drop the username / anonymous / password steps, which move to Add User).

Auto-detection of default keys (`~/.ssh/id_rsa`, ...) in `buildAuthConfig` is unaffected and
stays as a connect-time fallback for SSH accounts.

### 4.3 Tree (`HostTreeProvider.getUserCredentialItems`, ~line 504)

- **Skip** endpoint records when building account rows (no `UserCredentialTreeItem` for an
  endpoint), but still let the endpoint keep the `ServerTreeItem` alive in its `host:port`
  bucket (`getServerItems` groups by `getServerKey` = `host:port`, so the endpoint anchors
  the server node).
- The `AddCredentialTreeItem` ("Add User...") is already appended unconditionally, so a fresh
  endpoint renders as: server node -> (no account rows) -> "Add User...".
- An endpoint must NEVER produce a clickable connect target (guards FM-4). Server-node
  `contextValue` for an endpoint-only, disconnected, saved host resolves to `savedServer`
  (edit / remove / rename / copy still work on it).

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
template (the endpoint or an existing account in the same server bucket). The account record
is a normal host (`isEndpoint` absent/false, username set).

### 4.5 Connect

- Click an account row -> `sshLite.connectWithCredential(hostConfig, credential)` (unchanged).
- Endpoint records have no username, no `.command`, and `sshLite.connect` must early-return
  on `isEndpointHost(host)`. An endpoint can never trigger a connect with an empty username.

### 4.6 Backward compatibility / caller audit (LITE)

Endpoint records must not leak into code paths that assume a username. Audit and guard every
reader of `host.username`, at minimum:

- export / import connections (see 4.8 — the high-risk surface)
- `sshLite.copyHost`, `sshLite.editHost`, `sshLite.renameHost`, `sshLite.setTabLabel`
- `HostService.removeHost` / `renameHost` / `setTabLabel` (id parsing — see 4.8 Guard 3)
- monitor / terminal / tools commands gated on a connected server
- `connectionPrefix.getConnectionPrefix`, `FileDecorationProvider` tooltip
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
   - Add Host produces an endpoint record (`isEndpoint`, no username) for SSH and for FTP.
   - Each protocol exposes an Add User path that yields an account record + credential.
   - The tree renders an empty endpoint as server + "Add User..." for both protocols.
   This is the hard enforcement; the hook is the soft, in-editor nudge.

### 4.8 Export / Import and ID hardening (HIGH RISK — explicit handling)

> The full-source audit (companion `...-audit.md`) supersedes and extends this section.
> Guards G1 (id helpers), G2 (persistence guards), and G7 (export/import correctness) there
> cover the export/import surface in full, including the audit-only finding that
> `connectionSyncCommands.ts` builds ids with its own local `hostId()` whose `${undefined}`
> output breaks endpoint conflict detection (critical). The 12 failure modes below are the
> original first pass, retained for context.

An adversarial pass over export/import surfaced 12 failure modes when an endpoint record
flows through the persistence and portability layers. The blockers and their guards:

**FM-1 (blocker) — falsy `!h.username` guards silently drop endpoints.** Four sites skip any
record where `!h.username` is true (empty string is falsy): `loadSavedHosts` (~184),
`getSavedHostsForExport` (~288), `importSavedHosts` (~455), and the unchecked
`ExportedHost[]` cast in `ConnectionPortabilityService.parseAndValidate` (~141). Endpoints
vanish from load, export, and import with no error.
- **Guard 1/2:** Replace every `!h.username` skip with an `isEndpointHost(h)`-aware branch:
  endpoints pass through; account records still require a username. Update the `ExportedHost`
  type (currently `username: string`, ~lines 8-15) to `username?: string` + `isEndpoint?:
  boolean`, and add per-entry validation in `parseAndValidate`.

**FM-2 (blocker) — id `host:port:` breaks `split(':')` everywhere; IPv6 already latently
broken.** `removeHost` (~533), `renameHost` (~570), `setTabLabel` (~598),
`connectionPrefix.ts` (~56), and `FileDecorationProvider` (~252) all do
`const [host, port, user] = id.split(':')`, which mis-parses an empty-username id and any
IPv6 host.
- **Guard 3:** Add `src/utils/hostId.ts` with `buildHostId(host)` and
  `parseHostId(id): {host, port, username}` that split from the RIGHT (username is the last
  segment and may be empty; port is second-from-last; host may contain colons for IPv6).
  Replace all five `split(':')` call sites. This also fixes the pre-existing IPv6 bug.

**FM-3 / FM-10 (high) — credential keyed `host:port:` is orphaned.** If an endpoint ever
carries credential metadata it exports under an unreachable key.
- **Guard:** endpoints own no credentials; `getSavedHostsForExport` and credential export
  must not emit a credential bucket for an endpoint id. Assert this in tests.

**FM-4 (high) — endpoint rendered as a blank, clickable account row.** Covered by 4.3/4.5:
the tree skips endpoints and connect early-returns on `isEndpointHost`.

**FM-6 (high) — round-trip export -> import drops the endpoint** (same root as FM-1). Fixed by
Guard 1/2; add an explicit new -> export -> import -> new lossless round-trip test.

**FM-7 (medium) — old version silently drops endpoints from a new-format file.** Acceptable
data-wise (old versions cannot use endpoints), but confusing ("imported 0 connections").
- **Guard:** stamp the export envelope (bump `formatVersion` or add a `containsEndpoints`
  flag) so an older importer can show an informational notice instead of a silent zero.

**FM-8 / FM-11 (low) — diff UI and tab prefix render `@host:port`** for empty username.
- **Guard:** a shared `formatHostLabel(host)` that renders `host:port` (no leading `@`) when
  there is no username; use it in `connectionSyncCommands` detail strings and
  `connectionPrefix`.

**FM-5 / FM-9 / FM-12 (low) — dedup-on-save, Set membership, unchecked cast.** Mostly correct
once Guard 1/2/3 land; FM-12 is closed by the per-entry validation added in Guard 1/2.

## 5. Non-goals

- No connect-time QuickPick account picker (explicitly rejected in favour of the tree).
- No change to credential storage keys or the `SavedCredential` shape.
- No migration of existing account hosts; they keep their baked-in username and behaviour.
- No new top-level commands expected (command count unchanged). If that changes, update the
  five count locations + run `npm run docs:commands` and `npm run chaos:catalog` per CLAUDE.md.

## 6. Testing plan

- **Unit**
  - `HostService`: Add Host saves an endpoint (`isEndpoint`, no username) for SSH and FTP;
    FTPS flag kept.
  - `HostService.loadSavedHosts`: loads endpoint records; still loads account records;
    still rejects genuinely malformed records (no host/name).
  - `HostTreeProvider`: an endpoint-only server renders no account rows + "Add User...";
    no clickable connect target on the endpoint.
  - `addCredential`: SSH branch (password / key+passphrase) and FTP branch (password / anon).
  - Caller-audit guards: endpoint skipped/handled in copy, edit, prefix, decoration.
  - `src/utils/hostId.ts`: `parseHostId` / `buildHostId` round-trip for account, endpoint,
    and IPv6 hosts.
  - Parity test (4.7).
  - **Export/Import (4.8) — the high-risk matrix:**
    - `HostService.export.test.ts`: endpoint appears in export with correct fields; no
      credential bucket emitted for it; no collision with an account on the same `host:port`.
    - `HostService.import.test.ts`: importing an endpoint upserts by `host:port`; new ->
      export -> import -> new is lossless (FM-6).
    - new `HostService.endpoint.test.ts`: `removeHost` / `renameHost` / `setTabLabel` on an
      endpoint id mutate the right record and never touch account records sharing `host:port`.
    - `connectionSyncCommands.select.test.ts`: import file with an endpoint -> diff `detail`
      is `host:port` (not `@host:port`); `filterPayload` keeps a selected endpoint; no
      collision with a same-`host:port` account.
    - `connectionPrefix` test: `getConnectionPrefix("10.0.0.1:22:")` is sensible, not `@host`.
    - `ConnectionPortabilityService`: `parseAndValidate` keeps the endpoint with the right
      shape (optional username + `isEndpoint`); old-format file still imports fine.
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
- `.adn/features/connection-portability.md` (endpoint export/import, envelope flag)
- `.adn/configuration/commands-reference.md` if any command title/contextValue changes
- `.adn/lessons.md` (SSH<->FTP parity rule; the `!username` falsy-guard + IPv6 split lesson)
  and the parity hook docs

## 8. Risks

- **Export/import is the top risk** (section 4.8). Mitigated by the `isEndpoint` flag (not
  empty-string detection), the centralised `parseHostId`/`buildHostId`, endpoint-aware guards
  at all four skip sites, the envelope version stamp, and the full export/import test matrix.
- Empty-username records flowing into an unaudited `host.username` reader. Mitigated by 4.6
  audit + `isEndpointHost` guards + tests.
- FTP Add User branch must correctly resolve `anonymous` / `secure`; covered by unit tests.
- Parity drift between SSH and FTP over time; mitigated by the hook + parity test.
- IPv6 hosts: the new `parseHostId` must be right-anchored; covered by a dedicated test.
