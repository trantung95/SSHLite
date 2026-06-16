# Connect-time Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a host a server endpoint (`host:port`) whose accounts (username + password or key + passphrase) are added under it at connect time, for both SSH and FTP, without breaking existing saved hosts or the export/import pipeline.

**Architecture:** Additive. `IHostConfig.username` becomes optional; an endpoint record carries `isEndpoint: true` and no username. A new `src/utils/hostId.ts` centralises id build/parse (username normalised to `''`, IPv6-safe right-anchored parse). Endpoints are made un-connectable at one chokepoint and filtered out of every connect picker; the tree renders an endpoint as a server node with an empty account list plus the existing "Add User..." item.

**Tech Stack:** TypeScript, ssh2, basic-ftp, VS Code Extension API, Jest (`@swc/jest`), docker SSH test servers.

**Source of truth:** `docs/specs/2026-06-16-connect-time-accounts-design.md` (design) and `docs/specs/2026-06-16-connect-time-accounts-audit.md` (G1-G8 guards + B1-B4 criticals + every call site).

**Conventions:** TDD (test first, watch it fail, minimal code, watch it pass, commit). `npm run compile` (0 errors) + `npx jest --no-coverage` after each task. Solo repo: commit directly to `master`. Reset singletons with `(Service as any)._instance = undefined`. Mock vars use `var` + getters (swc no-hoist).

---

## File Structure

| File | Responsibility | Phase |
|------|----------------|-------|
| `src/utils/hostId.ts` (create) | `buildHostId`, `parseHostId`, `isEndpointHost`, `defaultPort` — the only place ids are built/parsed | 0 |
| `src/utils/hostId.test.ts` (create) | Unit tests incl. IPv6 + endpoint | 0 |
| `src/types.ts` (modify) | `username?` optional + `isEndpoint?` flag | 1 |
| `src/services/HostService.ts` (modify) | endpoint-aware load/save/export/import; use hostId helpers in remove/rename/setTabLabel | 1 |
| `package.json` (modify) | `sshLite.hosts` schema: username optional; add isEndpoint | 1 |
| `src/connection/ConnectionManager.ts` / `ConnectionFactory.ts` (modify) | reject endpoint at one chokepoint | 2 |
| `src/connection/SSHConnection.ts` / `FTPConnection.ts` (modify) | use hostId for `id`; FTP empty-username guard; home fallback | 2 |
| `src/providers/HostTreeProvider.ts` (modify) | skip endpoint account row; stable credential id; filter crash fix; endpoint contextValue | 3 |
| `src/providers/FileDecorationProvider.ts`, `PortForwardTreeProvider.ts`, `src/utils/connectionPrefix.ts` (modify) | parse via hostId | 3 |
| `src/extension.ts` (modify) | exclude endpoints from connect pickers; addHost wizard; addCredential FTP branch | 3,4 |
| `src/services/HostService.ts` `promptAddHost` (modify) | endpoint-only wizard (SSH+FTP) | 4 |
| `src/services/ConnectionPortabilityService.ts`, `src/commands/connectionSyncCommands.ts`, `src/webviews/ConnectionImportPanel.ts`, `src/services/CredentialService.ts` (modify) | endpoint-aware export/import + version flag | 5 |
| `src/services/FilenameIndexService.ts`, `AuditService.ts`, `SshKeyService.ts` (modify) | endpoint guards / display | 6 |
| `.claude/hooks/*`, `.claude/settings.json` (modify) | SSH↔FTP parity reminder hook | 6 |
| `.adn/*` (modify) | docs sync | 6 |

---

## Phase 0 — Foundation: `src/utils/hostId.ts` (keystone; also fixes latent IPv6 bug)

### Task 0.1: hostId helpers (TDD)

**Files:**
- Create: `src/utils/hostId.ts`
- Test: `src/utils/hostId.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/utils/hostId.test.ts
import { buildHostId, parseHostId, isEndpointHost, defaultPort } from './hostId';

describe('hostId', () => {
  describe('buildHostId', () => {
    it('builds an account id', () => {
      expect(buildHostId({ host: 'h.com', port: 22, username: 'alice' })).toBe('h.com:22:alice');
    });
    it('builds an endpoint id with empty username, never the literal "undefined"', () => {
      expect(buildHostId({ host: 'h.com', port: 22 })).toBe('h.com:22:');
      expect(buildHostId({ host: 'h.com', port: 22, username: undefined })).toBe('h.com:22:');
      expect(buildHostId({ host: 'h.com', port: 22 })).not.toContain('undefined');
    });
    it('defaults port by protocol when absent', () => {
      expect(buildHostId({ host: 'h', username: 'a' })).toBe('h:22:a');
      expect(buildHostId({ host: 'h', username: 'a', connectionType: 'ftp' })).toBe('h:21:a');
    });
  });

  describe('parseHostId (right-anchored, IPv6-safe)', () => {
    it('parses an account id', () => {
      expect(parseHostId('h.com:22:alice')).toEqual({ host: 'h.com', port: 22, username: 'alice' });
    });
    it('parses an endpoint id (empty username)', () => {
      expect(parseHostId('h.com:22:')).toEqual({ host: 'h.com', port: 22, username: '' });
    });
    it('parses IPv6 hosts that contain colons', () => {
      expect(parseHostId('::1:22:alice')).toEqual({ host: '::1', port: 22, username: 'alice' });
      expect(parseHostId('::1:22:')).toEqual({ host: '::1', port: 22, username: '' });
      expect(parseHostId('2001:db8::1:2222:bob')).toEqual({ host: '2001:db8::1', port: 2222, username: 'bob' });
    });
  });

  describe('round-trip', () => {
    it.each(['h:22:alice', 'h:22:', '::1:22:alice', '::1:22:', '2001:db8::1:2222:bob'])(
      'build(parse(%s)) === %s', (id) => {
        expect(buildHostId(parseHostId(id))).toBe(id);
      });
  });

  describe('isEndpointHost', () => {
    it('is true only for the explicit flag', () => {
      expect(isEndpointHost({ isEndpoint: true })).toBe(true);
      expect(isEndpointHost({ username: 'alice' })).toBe(false);
      expect(isEndpointHost({ username: '' })).toBe(false); // malformed, not an endpoint
    });
  });

  describe('defaultPort', () => {
    it('22 for ssh/undefined, 21 for ftp', () => {
      expect(defaultPort()).toBe(22);
      expect(defaultPort('ssh')).toBe(22);
      expect(defaultPort('ftp')).toBe(21);
    });
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx jest --no-coverage src/utils/hostId.test.ts`
Expected: FAIL — `Cannot find module './hostId'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/utils/hostId.ts
import type { ConnectionType } from '../types';

/** Minimal shape needed to build a host id. */
export interface HostIdParts {
  host: string;
  port?: number;
  username?: string;
  connectionType?: ConnectionType;
}

/** Default port by protocol (ssh 22, ftp 21). */
export function defaultPort(connectionType?: ConnectionType): number {
  return connectionType === 'ftp' ? 21 : 22;
}

/**
 * Canonical connection/host id: `${host}:${port}:${username}`.
 * Username is normalised to '' (never the literal string "undefined"), so an
 * endpoint record (no username) yields `host:port:` not `host:port:undefined`.
 */
export function buildHostId(h: HostIdParts): string {
  const port = h.port ?? defaultPort(h.connectionType);
  const username = h.username ?? '';
  return `${h.host}:${port}:${username}`;
}

export interface ParsedHostId {
  host: string;
  port: number;
  username: string;
}

/**
 * Parse a host id built by buildHostId. Splits from the RIGHT so username (last
 * segment, may be empty) and port (second-from-last) are unambiguous even when
 * the host contains ':' (IPv6, e.g. '::1:22:alice' or '::1:22:').
 */
export function parseHostId(id: string): ParsedHostId {
  const lastColon = id.lastIndexOf(':');
  if (lastColon === -1) {
    return { host: id, port: NaN, username: '' };
  }
  const username = id.slice(lastColon + 1);
  const secondColon = id.lastIndexOf(':', lastColon - 1);
  if (secondColon === -1) {
    return { host: id.slice(0, lastColon), port: NaN, username };
  }
  return {
    host: id.slice(0, secondColon),
    port: parseInt(id.slice(secondColon + 1, lastColon), 10),
    username,
  };
}

/** True when a host config represents an endpoint (no account/username yet). */
export function isEndpointHost(h: { isEndpoint?: boolean }): boolean {
  return h.isEndpoint === true;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx jest --no-coverage src/utils/hostId.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Compile + commit**

Run: `npm run compile` → 0 errors.
```bash
git add src/utils/hostId.ts src/utils/hostId.test.ts
git commit -m "feat(hostId): canonical build/parse helpers (IPv6-safe, endpoint-aware) [Phase 0]"
```

---

## Phase 1 — Data model + persistence (endpoint survives load/save/export/import)

### Task 1.1: type changes

**Files:** Modify `src/types.ts:13-36`

**Decision (re-planned from evidence):** keep `username: string` (REQUIRED, typed) and store
`''` for an endpoint, distinguished by an explicit `isEndpoint` flag. This avoids a
codebase-wide `string | undefined` compile cascade (keeps every commit green) and structurally
eliminates criticals B2 (`${undefined}` -> literal "undefined") and B3 (`undefined.toLowerCase()`
crash) because the value is always a string. The flag — not emptiness — is the source of truth.

- [ ] **Step 1:** Add `isEndpoint` to `IHostConfig` (keep `username: string`):

```typescript
  /** Username for authentication. Empty string ('') on an endpoint record. */
  username: string;
  ...
  /** True when this record is a server endpoint (host:port) with no account yet. */
  isEndpoint?: boolean;
```

- [ ] **Step 2:** Run `npm run compile`. Expected: 0 errors (no type cascade — username stays a
string). Endpoints carry `username: ''` + `isEndpoint: true`; all guards key off `isEndpoint`.
Note: the `?? ''` / `username || '<endpoint>'` display guards in later tasks become
belt-and-suspenders rather than crash-preventers, but are kept for clarity and IPv6.

### Task 1.2: endpoint-aware load/save (TDD)

**Files:** Modify `src/services/HostService.ts` (`loadSavedHosts:181-208`, `saveHost:228-231`, settings type literals); Test: `src/services/HostService.endpoint.test.ts` (create).

- [ ] **Step 1: Write failing tests** — loading a saved entry with `isEndpoint: true` and no username keeps it (id `host:port:`); a no-username, non-endpoint entry is still skipped; `removeHost`/`renameHost`/`setTabLabel` find and mutate an endpoint by id; two endpoints on the same host:port dedup. Use `buildHostId`/`parseHostId`. (Mock `vscode.workspace.getConfiguration` per `src/__mocks__`.)

```typescript
// key assertions
expect(loaded.find(h => h.isEndpoint)?.id).toBe('h.com:22:');
expect(loaded.some(h => h.host === 'bad' && !h.username && !h.isEndpoint)).toBe(false); // malformed skipped
await svc.removeHost('h.com:22:'); // endpoint removed, account 'h.com:22:alice' untouched
```

- [ ] **Step 2:** Run, verify fail.

- [ ] **Step 3:** Implement:
  - `loadSavedHosts:184` guard → `if (!host.name || !host.host || (!host.username && !host.isEndpoint)) { ... continue; }` and include `isEndpoint: host.isEndpoint` in the pushed object; build `id` via `buildHostId({ host: host.host, port, username: host.username, connectionType: host.connectionType })`.
  - `saveHost` dedup `:230` → compare `(h.username ?? '') === (host.username ?? '')`; carry `isEndpoint` into `newHost`; add `isEndpoint` to both settings type literals (`:216-226`, `:175-179`).
  - `removeHost:532`, `renameHost:569`, `setTabLabel:597` → replace `const [hostAddr, portStr, username] = hostId.split(':')` with `const { host: hostAddr, port, username } = parseHostId(hostId);` and match on `(h.username ?? '') === username`.

- [ ] **Step 4:** Run tests + `npm run compile`. Expected: PASS, 0 errors.

- [ ] **Step 5: Commit** — `feat(hosts): endpoint-aware load/save + hostId parsing in remove/rename/setTabLabel [Phase 1]`

### Task 1.3: settings schema (B4)

**Files:** Modify `package.json` `contributes.configuration` → `sshLite.hosts` items.

- [ ] **Step 1:** In the `hosts` array item schema, change `username` out of `required` (or relax to allow absent) and add `"isEndpoint": { "type": "boolean" }`. Keep `host` required.
- [ ] **Step 2:** Reload-test mentally: a saved endpoint no longer flags `sshLite.hosts` invalid. Run `npm run docs:commands` only if command titles changed (they did not).
- [ ] **Step 3: Commit** — `fix(settings): allow optional username + isEndpoint in sshLite.hosts schema [Phase 1]`

---

## Phase 2 — Connectability chokepoint (B1 FTP, endpoint un-connectable)

### Task 2.1: id via hostId in connections

**Files:** Modify `src/connection/SSHConnection.ts:209`, `src/connection/FTPConnection.ts:55`.

- [ ] **Step 1:** Replace each `` this.id = `${host.host}:${host.port}:${host.username}` `` with `this.id = buildHostId(host);` (import from `../utils/hostId`). Existing account behaviour unchanged; endpoint ids would be `host:port:` not `host:port:undefined`.
- [ ] **Step 2:** `npm run compile` + run existing `SSHConnection*.test.ts` / FTP tests. Expected: PASS.
- [ ] **Step 3: Commit** — `refactor(conn): build connection id via hostId helper [Phase 2]`

### Task 2.2: chokepoint guard + FTP empty-username guard (TDD)

**Files:** Modify `src/connection/ConnectionManager.ts` (`connect`/`createConnection` ~127, reconnect classifier ~497) and/or `src/connection/ConnectionFactory.ts`; `src/connection/FTPConnection.ts:88` (connect guard); add error type. Test: `src/connection/ConnectionManager.endpoint.test.ts` + extend FTP tests.

- [ ] **Step 1: Write failing tests** — `connectionManager.connect(endpointHost)` rejects with an `EndpointNotConnectable` (or `ConnectionError` whose message is NOT auth-classified) for BOTH `connectionType` ssh and ftp; FTP never calls `client.access` with `user:''`.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Implement: at the single `createConnection`/`connect` entry, `if (isEndpointHost(host)) throw new ConnectionError('This is an endpoint — add an account with "Add User" before connecting.');` BEFORE constructing a transport. Add the same empty-username guard to `FTPConnection.connect()` that `SSHConnection.connect():286` has. Add an `isEndpoint`-aware branch to the reconnect classifier so it does not show "Authentication failed" or loop.
- [ ] **Step 4:** Run tests + compile. Expected: PASS.
- [ ] **Step 5: Commit** — `fix(conn): reject endpoints at one chokepoint + FTP empty-username guard (B1) [Phase 2]`

### Task 2.3: home-path fallbacks

**Files:** `src/connection/SSHConnection.ts:242` (`resolveHomePath`), `src/services/SshKeyService.ts:95`.

- [ ] **Step 1:** Guard fallbacks: `home || (this.host.username ? \`/home/${this.host.username}\` : '/')`. (Endpoint can't reach here post-chokepoint; defense-in-depth.)
- [ ] **Step 2:** Compile + run touched tests. **Commit** — `fix(conn): guard /home fallback when username absent [Phase 2]`

---

## Phase 3 — Tree + pickers (B3 crash, endpoint shows as empty server)

### Task 3.1: tree rendering (TDD)

**Files:** Modify `src/providers/HostTreeProvider.ts` (`getUserCredentialItems:510`, `UserCredentialTreeItem` ctor `:131`, `matchesFilter:364`, ServerTreeItem tooltip `:93`, contextValue `:82-90`). Test: extend `HostTreeProvider.test.ts`.

- [ ] **Step 1: Write failing tests** — a server whose only host is an endpoint renders 0 account rows + 1 "Add User..." item; `matchesFilter` with an active filter and an endpoint present does NOT throw (B3); two endpoints produce distinct stable `UserCredentialTreeItem` ids (none created, but assert no blank-id collision for mixed account rows); endpoint server `contextValue` does not match the connect/setTabLabel/clearCredentials `when` regexes.
- [ ] **Step 2:** Run, verify fail (esp. B3 throws today).
- [ ] **Step 3:** Implement:
  - `getUserCredentialItems` loop `:510` → `if (isEndpointHost(host)) continue;` before pushing a `UserCredentialTreeItem`.
  - `UserCredentialTreeItem` ctor → add `this.id = \`credential:${hostConfig.id}\`;`.
  - `matchesFilter:364` → `host.username?.toLowerCase() ?? ''`.
  - ServerTreeItem tooltip `:93` → `hosts.filter(h => h.username).map(h => h.username).join(', ') || '(no accounts)'`.
  - contextValue: when the server's only/all records are endpoints (or to mark an endpoint anchor), emit `savedServer.endpoint`; update `package.json` `when` clauses so connect (`connectWithCredential`), `setTabLabel`, `clearCredentials` exclude `*.endpoint` while editHost/removeHost/copyHost still match.
- [ ] **Step 4:** Run + compile. PASS.
- [ ] **Step 5: Commit** — `fix(tree): endpoint = empty server node; stable credential id; filter crash (B3) [Phase 3]`

### Task 3.2: display parsers via hostId

**Files:** `src/utils/connectionPrefix.ts:56`, `src/providers/FileDecorationProvider.ts:252`, `src/providers/PortForwardTreeProvider.ts:205`.

- [ ] **Step 1: Write failing tests** (extend `connectionPrefix` test): `getConnectionPrefix('::1:22:bob')` → `bob@::1`; `getConnectionPrefix('h:22:')` → sensible (e.g. `h`), never `@h` or `undefined@h`.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Replace the `split(':')` positional logic with `parseHostId(...)` in all three; render empty username without a dangling `@`.
- [ ] **Step 4:** Run + compile. PASS.
- [ ] **Step 5: Commit** — `fix(ui): parse connection ids via hostId (IPv6 + endpoint) [Phase 3]`

### Task 3.3: exclude endpoints from connect pickers

**Files:** `src/extension.ts:933` (multi-user picker), `:963` (connect palette), `:1237` (orphan reconnect), `:193` (server search), `src/commands/connectionSyncCommands.ts:115` (existingSides).

- [ ] **Step 1: Write failing test** (where feasible at unit level for `buildServerSearchEntries` / a small helper) asserting endpoints are absent; for command handlers, add a guard and a focused test on any extractable predicate.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Apply `.filter(h => !isEndpointHost(h))` at each list-building site.
- [ ] **Step 4:** Run + compile. PASS.
- [ ] **Step 5: Commit** — `fix(connect): exclude endpoints from all connect pickers [Phase 3]`

---

## Phase 4 — The UX: endpoint-only Add Host + protocol-aware Add User

### Task 4.1: Add Host wizard → endpoint only (TDD)

**Files:** Modify `src/services/HostService.ts` `promptAddHost:600-696` (+ `promptFtpOptions` usage). Test: `HostService.addHost.test.ts`.

- [ ] **Step 1: Write failing tests** — SSH Add Host saves a record with `isEndpoint:true`, no username, no privateKeyPath (prompts: name, host, port only); FTP Add Host saves endpoint with `secure` kept, no username/anonymous/password.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Remove the username InputBox `:657-665` and the `pickPrivateKeyPath` step `:668-671` from the SSH branch; for FTP remove the username/anonymous/password prompts, keep the FTPS pick; call `saveHost({ ..., isEndpoint: true })` with no username.
- [ ] **Step 4:** Run + compile. PASS.
- [ ] **Step 5: Commit** — `feat(addHost): create a bare endpoint (no username/key step) for SSH and FTP [Phase 4]`

### Task 4.2: Add User branches by protocol (TDD)

**Files:** Modify `src/extension.ts` `addCredential:3232-3311` (+ `:3241` serverKey parse, dedup `:3254`). Test: extend an extension/command test or a extracted helper test.

- [ ] **Step 1: Write failing tests** — for an SSH template the auth QuickPick offers Password + Private Key; for an FTP template it offers Password + Anonymous (no Private Key); the endpoint record in `serverItem.hosts` does NOT block the dedup check; serverKey parsed via `parseHostId`/helper handles IPv6.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Branch the auth-method QuickPick on `templateHost.connectionType`; for FTP build a password/anonymous credential (no key); skip the endpoint when checking `serverItem.hosts.find(h => h.username === username)`; parse serverKey with the hostId helper. Build the new account id via `buildHostId`.
- [ ] **Step 4:** Run + compile. PASS. Then **docker** smoke: with `sshlite-keys:2216` up, add endpoint → Add User `testuser`/`testpass` → connect; Add User `id_rsa_encrypted` passphrase `testphrase`; Add User `keyuser` key-only.
- [ ] **Step 5: Commit** — `feat(addUser): protocol-aware account creation; endpoint-safe dedup [Phase 4]`

---

## Phase 5 — Export / import / sync correctness (highest risk)

### Task 5.1: types + validator + envelope (TDD)

**Files:** Modify `src/services/ConnectionPortabilityService.ts:8-15` (`ExportedHost`), `:127-143` (`parseAndValidate`), envelope/version; `src/webviews/ConnectionImportPanel.ts:7-14` (`ImportSide`). Test: extend `HostService.export.test.ts` / portability tests.

- [ ] **Step 1: Write failing tests** — round-trip new→export→import→new is lossless for an endpoint; old-format file (no `containsEndpoints`, all usernames) still imports; export sets `containsEndpoints: true` when an endpoint is included; `parseAndValidate` normalises `{ isEndpoint: !!e.isEndpoint, username: e.username || '' }`.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** `ExportedHost.username?: string; isEndpoint?: boolean`; bump envelope `VERSION` to 2; emit/read `containsEndpoints`; per-entry normalise in `parseAndValidate`; soft-warn (not throw) on old consumer. Update `HostService.getSavedHostsForExport:288`, `getAllHostsForExport:378` guards to allow endpoints (`!h.username && !h.isEndpoint` skip) and build keys via `buildHostId`. Update `importSavedHosts:455` guard + `keyOf:491` via `buildHostId`.
- [ ] **Step 4:** Run + compile. PASS.
- [ ] **Step 5: Commit** — `feat(portability): endpoint-aware export/import + envelope v2 containsEndpoints [Phase 5]`

### Task 5.2: sync command id + diff + credential keys (TDD)

**Files:** Modify `src/commands/connectionSyncCommands.ts` (local `hostId():15`, `existingSides:115`, `applyImportFlow:150/161`, `filterPayload:124`); `src/services/CredentialService.ts` (`exportMetadata:221`, `importCredentialMetadata:291`, `deleteAll:207`). Test: extend `connectionSyncCommands.select.test.ts`.

- [ ] **Step 1: Write failing tests** — an endpoint that already exists locally is DETECTED as a conflict (uses `buildHostId`); import of an all-endpoint file shows the review UI; diff `detail` is `host:port` (no `@`/`undefined@`); credential buckets are never emitted/imported for an endpoint id.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Delete the local `hostId()` and import `buildHostId`; use it at lines 16/126/150/155 + credential loop; add a `formatHostLabel(h)` helper (`h.username ? \`${h.username}@${h.host}:${h.port}\` : \`${h.host}:${h.port}\``) for `existingSides` + `applyImportFlow` detail; force review UI when `containsEndpoints`; canonicalise credential keys in `filterPayload`; guard `importCredentialMetadata`/`exportMetadata`/`deleteAll` against endpoint ids (`isEndpointHost`/empty username).
- [ ] **Step 4:** Run + compile. PASS.
- [ ] **Step 5: Commit** — `fix(sync): centralise id, endpoint-safe diff + credential keys [Phase 5]`

---

## Phase 6 — Residual services, parity hook, docs

### Task 6.1: residual service guards

**Files:** `src/services/FilenameIndexService.ts:64`, `src/services/AuditService.ts:19`, `src/webviews/SearchPanel.ts:1611`, `src/services/FileService.ts:5183`.

- [ ] **Step 1: Write failing test** — `FilenameIndexService` refuses to index an endpoint.
- [ ] **Step 2/3:** Throw on endpoint in `hostKey()`; `AuditService.username` → `string | undefined` rendered `<endpoint>`; guard display strings (`username ?? '<endpoint>'`). Build keys via `buildHostId`.
- [ ] **Step 4:** Run + compile. **Commit** — `fix(services): endpoint guards in index/audit/search/sudo display [Phase 6]`

### Task 6.2: SSH↔FTP parity reminder hook

**Files:** Create `.claude/hooks/parity-ssh-ftp.*`; modify `.claude/settings.json`.

- [ ] **Step 1:** Add a PostToolUse hook that, when an edit touches the SSH endpoint/auth surface (`HostService.promptAddHost`, `extension.ts` addCredential, SSH connect guard), prints a reminder to review the FTP counterpart and vice versa. Reminder only, never blocks.
- [ ] **Step 2:** Add a jest parity test asserting both protocols: Add Host → endpoint; Add User path exists; tree renders empty endpoint. File `src/__tests__/parity-ssh-ftp.test.ts`.
- [ ] **Step 3: Commit** — `chore(hooks): SSH<->FTP parity reminder + parity test [Phase 6]`

### Task 6.3: docs sync

**Files:** `.adn/flow/connection-flow.md`, `.adn/features/tree-providers.md`, `.adn/features/connection-portability.md`, `.adn/configuration/commands-reference.md` (if changed), `.adn/lessons.md` (already has the entry), `.adn/CHANGELOG.md`, `README.md` if user-facing.

- [ ] **Step 1:** Update each doc to describe endpoint → account → credential. Re-run `npm run docs:commands` + `npm run chaos:catalog` if any command/contextValue changed (audit per CLAUDE.md). Confirm command count unchanged.
- [ ] **Step 2: Commit** — `docs(.adn): endpoint/account model sync [Phase 6]`

### Task 6.4: full verification

- [ ] `npm run compile` (0 errors), `npx jest --no-coverage` (all pass).
- [ ] Docker: `npm run test:docker:*` relevant suites on `sshlite-keys:2216` + FTP servers — endpoint→Add User→connect for SSH password, SSH passphrase (`testphrase`), SSH key-only, and FTP password.
- [ ] Dispatch `superpowers:requesting-code-review` on the full diff.

---

## Self-Review notes

- Spec coverage: design §4.1-4.8 + audit G1-G8 each map to a task (G1→0.1/2.1/3.2/5.2; G2→1.2/5.1; G3→2.2/2.3; G4→3.3; G5→3.1; G6→4.2; G7→5.1/5.2; G8→6.1). B1→2.2, B2→0.1 (+ usage in 2.1/5.2), B3→3.1, B4→1.3.
- Signature consistency: `buildHostId`/`parseHostId`/`isEndpointHost`/`defaultPort` defined once in Task 0.1 and reused verbatim everywhere.
- Ordering: each phase depends only on earlier ones; master stays green + releasable after every task.
