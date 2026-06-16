# Audit: full-source hidden-issue scan for the endpoint/optional-username change

- Date: 2026-06-16
- Companion to: `2026-06-16-connect-time-accounts-design.md`
- Method: 5 parallel sub-agents, one per code region (core/connection, providers,
  extension+commands, export/import/sync, per-host state services + repo-wide sweep).
- This file is the consolidated, de-duplicated **implementation checklist**, organised by the
  8 root-cause guards. Individual call sites are listed under the guard that fixes them.

## Headline (new criticals beyond the original FM-1..12)

- **B1 (Blocker) — FTP silent anonymous login.** `FTPConnection.connect()` has NO empty-username
  guard (SSH has one at `SSHConnection.ts:286`). An endpoint reaching FTP connect calls
  `client.access({ user: '' })` (`FTPConnection.ts:119`); many servers treat empty USER as
  anonymous -> accidental anonymous login, or a 530 that triggers `deleteAll(endpointId)`.
- **B2 (Blocker) — id becomes the literal string `"host:port:undefined"`.** ids are built as
  `` `${host.host}:${host.port}:${host.username}` `` at `SSHConnection.ts:209`,
  `FTPConnection.ts:55`, `HostService.loadSavedHosts:195`. `${undefined}` interpolates to the
  text `"undefined"`, not an empty segment. This poisons tab prefixes, credential keys, and
  import conflict detection. The design assumed `host:port:` (empty) — wrong in practice.
- **B3 (Crash) — `matchesFilter`** does `host.username.toLowerCase()`
  (`HostTreeProvider.ts:364`); throws `TypeError` when username is undefined and a tree filter
  is active.
- **B4 — VS Code settings schema.** `package.json contributes.configuration` declares
  `sshLite.hosts[].username` as a required string; an endpoint with no username will flag the
  whole `sshLite.hosts` array as invalid in the Settings UI.

## Key structural decisions forced by the audit

1. **Normalise username to `''`, never `undefined`-interpolated.** All id construction goes
   through `buildHostId(host)` which coerces a missing username to `''`, so an endpoint id is
   exactly `host:port:` (one trailing colon), never `host:port:undefined`. All parsing goes
   through `parseHostId(id)` which splits from the RIGHT (username last and may be empty; port
   second-from-last; host is the remainder, so IPv6 hosts survive).
2. **One connectability chokepoint.** Endpoints are rejected at a single boundary
   (`ConnectionManager.connect` / `ConnectionFactory.createConnection`) with a dedicated
   `EndpointNotConnectable` outcome, AND `FTPConnection.connect` gets the same guard
   `SSHConnection.connect` already has. Once an endpoint provably cannot become a live
   `connection`, every `connection.host.username`-renders-"undefined" cosmetic bug on the
   connected path is unreachable (defense-in-depth only).
3. **Endpoint persists; it is filtered, not deleted.** Adding the first account does NOT delete
   the endpoint record. Guards G4/G5 ensure the endpoint never appears as a connectable or
   selectable item; the endpoint simply anchors the server node and survives when all accounts
   are removed.
4. **Distinct endpoint contextValue** (e.g. `savedServer.endpoint`) so connect/terminal/monitor/
   setTabLabel/clearCredentials menus do not target it, while edit/remove/copy still do.

---

## G1 — Canonical id helpers (`src/utils/hostId.ts`): `buildHostId` / `parseHostId`

`buildHostId(host)` -> `` `${host.host}:${port}:${host.username ?? ''}` ``.
`parseHostId(id)` -> right-anchored split: `{ host, port, username }`, username may be `''`,
host may contain `:` (IPv6). Fixes B2 + the pre-existing IPv6 latent bug.

Replace every BUILD site:
- `src/connection/SSHConnection.ts:209` (S6, root cause)
- `src/connection/FTPConnection.ts:55` (S7)
- `src/services/HostService.ts:195` (loadSavedHosts), `:378` (getAllHostsForExport savedRaw)
- `src/commands/connectionSyncCommands.ts:16` (local `hostId()` — FM-C: replace entirely)
- `src/services/FilenameIndexService.ts:64` (snapshot/host key)
- `src/webviews/SearchPanel.ts:66` (ServerSearchEntry.id)
- `src/extension.ts:3293` (addCredential newHostId — username is prompted, still use helper)

Replace every PARSE / `split(':')` site:
- `src/services/HostService.ts:532` (removeHost), `:569` (renameHost), `:597` (setTabLabel)
  — FM-2/FM-D: these silently no-op on endpoints and corrupt on IPv6.
- `src/utils/connectionPrefix.ts:56` (FM-E/FM-3: tab prefix `undefined@host`)
- `src/providers/FileDecorationProvider.ts:252` (S2: tooltip `(undefined)`)
- `src/providers/PortForwardTreeProvider.ts:205` (S3: orphaned-rule host; IPv6)
- `src/extension.ts:3241` (FM-C6: `serverKey.split(':')` — IPv6 corrupts new account id)

## G2 — `isEndpointHost(host)` + endpoint-aware persistence guards

Replace falsy `!h.username` skips (empty string / undefined are both falsy -> silent drop)
with `(!h.username && !h.isEndpoint)`:
- `src/services/HostService.ts:184` (loadSavedHosts) — FM-1/FM-A
- `src/services/HostService.ts:288` (getSavedHostsForExport) — FM-19
- `src/services/HostService.ts:455` (importSavedHosts) — FM-18; also normalise `keyOf` username
- `src/services/ConnectionPortabilityService.ts:141` (parseAndValidate cast) — FM-12/FM-G

Dedup normalisation:
- `src/services/HostService.ts:229` (saveHost dedup): compare `(h.username ?? '')` so two
  endpoints don't both persist (FM-16); endpoint vs account stay distinct (FM-5).

## G3 — One connectability chokepoint + FTP guard (neutralises the connected-path cosmetics)

- Add guard in `ConnectionManager.connect` / `ConnectionFactory.createConnection`: reject
  `isEndpointHost(host)` with a dedicated `EndpointNotConnectable` error BEFORE a transport is
  created (FM-13). Add an `isEndpointError` branch to the reconnect classifier so it does not
  show "Authentication failed" / does not loop (`ConnectionManager.ts:497`).
- **B1:** add the empty-username guard to `FTPConnection.connect()` mirroring
  `SSHConnection.connect():286` (currently FTP guards only `host.host` at `:88`).
- `SSHConnection.resolveHomePath()` fallback `/home/${username}` -> guard to `/` when no
  username (FM-15). `SshKeyService.pushPublicKey` home fallback likewise (`SshKeyService.ts:95`).
- Once this lands, these become unreachable defense-in-depth (do NOT need scattered fixes):
  FM-21/FM-22 (buildAuthConfig + disconnect log), FTPConnection `_resolvePassword` prompt
  (`:442`), FileTreeProvider reconnecting strings (`:57/87/95`), AuditService username,
  PortForward QuickPick, SearchPanel overlap warning, FileService sudo message (S8). Keep a
  cheap `username || '<endpoint>'` in the audit/log lines (FM-21/FM-6) as hygiene.

## G4 — Exclude endpoints from every "pick a host to connect" surface

Apply `!isEndpointHost(h)` when building these lists:
- `src/extension.ts:963` connect palette QuickPick (FM-C1, High)
- `src/extension.ts:933` multi-user picker on a ServerTreeItem (FM-C3, High)
- `src/extension.ts:1237` reconnectOrphanedFile fallback picker (FM-C2)
- `src/extension.ts:193` buildServerSearchEntries cross-server search (FM-C13)
- `src/commands/connectionSyncCommands.ts:115` existingSides import-diff rows (FM-C12)

## G5 — Tree rendering: endpoint = server anchor only, never an account row

- `HostTreeProvider.getUserCredentialItems:510` — skip endpoint records (no
  `UserCredentialTreeItem`) (ISSUE-2 / FM-4). Endpoint still anchors the `ServerTreeItem` via
  `getServerItems` host:port grouping.
- `UserCredentialTreeItem` — set an explicit stable `this.id = \`credential:${hostConfig.id}\``
  (ISSUE-10: blank-label items currently collapse to the same implicit id and hide each other).
- **B3:** `HostTreeProvider.matchesFilter:364` -> `host.username?.toLowerCase() ?? ''`.
- `ServerTreeItem` tooltip user list `:93` -> filter empty usernames, show `(no accounts)`
  (ISSUE-1).
- Endpoint `ServerTreeItem` contextValue -> a distinct value (e.g. `savedServer.endpoint`) so
  package.json menus for setTabLabel / clearCredentials / connect do not match it, while
  edit / remove / copy still do (ISSUE-9). Audit all `view/item/context` `when` regexes.
- `FileTreeProvider` reconnecting description/tooltip `:57/87/95` — guard username (ISSUE-6),
  reachable only via G3 race; low.

## G6 — Add User branches by protocol + endpoint-aware dedup

- `extension.ts:3261` addCredential auth-method QuickPick: branch on
  `templateHost.connectionType`. SSH -> Password | Private Key; **FTP -> Password | Anonymous**
  (no key option — a `privateKey` credential is unusable by FTP) (FM-C4).
- Dedup check `serverItem.hosts.find(h => h.username === username)` must IGNORE the endpoint
  record (its empty username must not block, and the endpoint must not be treated as an
  account) (FM-C4 part 2).
- `extension.ts:3241` serverKey parse via G1 helper (IPv6) (FM-C6).
- Endpoint is NOT removed after the first account is added (decision 3); rely on G4/G5.

## G7 — Export / import / sync correctness (highest-risk surface)

- Types: `ExportedHost.username?: string` + `isEndpoint?: boolean`
  (`ConnectionPortabilityService.ts:8`); `ImportSide` carries `formatHostLabel` output
  (`ConnectionImportPanel.ts:7`) (FM-F).
- `parseAndValidate` (`:127`): per-entry normalise `{ isEndpoint: !!e.isEndpoint, username:
  e.username || '' }`; read envelope `containsEndpoints`; bump `VERSION` to 2; soft-warn when
  `containsEndpoints && consumer is old` (FM-G / FM-7).
- Envelope: emit `containsEndpoints: true` when any endpoint is exported (FM-7).
- `connectionSyncCommands.ts`: replace local `hostId()` with `buildHostId` at lines 16, 126,
  150, 155 + credential loop (FM-C, Critical — otherwise endpoint conflict detection silently
  fails and endpoints import without the review UI). `existingSides:115` and
  `applyImportFlow:161` detail via `formatHostLabel` (FM-B).
- `filterPayload:124` — canonicalise credential keys with `buildHostId` before the `chosen`
  Set check (FM-K).
- `applyImportFlow:150` — force the review UI when `containsEndpoints` even if no id conflict,
  so endpoints are not silently injected (FM-H, medium).
- Credentials: endpoints emit NO credential bucket; `exportMetadata` skips endpoint ids;
  `applyImport` + `importCredentialMetadata` guard against endpoint ids
  (`CredentialService.ts:291`, `:207` deleteAll) (FM-I / FM-M / FM-3/10/20).
- Google Drive sync (`GoogleDriveSyncService` push/pull) is a pass-through over the same
  functions — inherits all the above, no separate change (FM-L).

## G8 — Per-host state services + settings schema

- **B4:** `package.json contributes.configuration` `sshLite.hosts` item schema — make
  `username` optional / allow absent when `isEndpoint: true`.
- `FilenameIndexService.hostKey():64` — guard/throw on an endpoint (cannot index a
  non-connectable host); also via G3 the index UI is never offered (FM-1 agent5).
- `AuditService.username` -> `string | undefined`, render `<endpoint>` (FM-6 agent5, low).
- `FolderHistoryService` / `PortForwardService` rules are keyed by the live `connection.id`;
  endpoints never connect (G3) so they never write — confirm, no migration of existing account
  rules happens (we do not migrate accounts), so the host->endpoint key-loss case is N/A.
- `SearchPanel.detectRedundancy:1611` overlap warning username guard (low).
- Clean (no action — confirmed by scan): `ActivityService`, `ServerMonitorService`,
  `TerminalService`, `RemoteClipboardService`, `SnippetService`, `SystemToolsService`,
  `RemoteDiffService`, `searchCommandBuilder`.

---

## Test matrix delta (add to design section 6)

- `src/utils/hostId.test.ts`: `build`/`parse` round-trip for account, endpoint (`host:port:`),
  IPv4, and IPv6 hosts; assert no `"undefined"` literal ever appears.
- `FilenameIndexService`: refuses to index an endpoint.
- `HostTreeProvider`: filter active with an endpoint present does NOT throw (B3 regression);
  endpoint produces no account row and a stable distinct `UserCredentialTreeItem` id is never
  collided; endpoint contextValue excludes setTabLabel/clearCredentials/connect menus.
- `ConnectionManager`/`FTPConnection`: connecting an endpoint throws `EndpointNotConnectable`
  (both protocols), never an anonymous FTP login (B1 regression).
- `connectionSyncCommands`: endpoint conflict is DETECTED (uses `buildHostId`); import of an
  all-endpoint file shows the review UI; diff detail has no `undefined@`/`@host` (FM-B/C/H).
- `ConnectionPortabilityService`: round-trip new->export->import->new is lossless for
  endpoints; old-format file still imports; `containsEndpoints` + version 2 handled.
- `package.json` settings-schema test (if a schema test exists) accepts an endpoint host.
- Docker (`sshlite-keys:2216`) end-to-end unchanged from the design doc.
