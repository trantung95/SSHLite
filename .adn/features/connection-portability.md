# Connection Portability — Import / Export / Sync (issue #11)

Back up saved connections to a JSON file, restore them on another machine, and
(optionally) sync them natively to Google Drive. Everything is user-triggered;
there is no background polling or auto-sync (LITE).

## What is exported

A versioned envelope produced by `ConnectionPortabilityService`:

```jsonc
{
  "schema": "sshlite-connections",      // format marker (validated on import)
  "version": 1,                          // bumped only on breaking format changes
  "exportedAt": "2026-06-10T12:34:56Z",
  "extensionVersion": "0.10.0",
  "hosts": [                             // ALL panel hosts: saved + ~/.ssh/config, deduped
    { "name": "Prod", "host": "10.0.0.1", "port": 22, "username": "admin",
      "privateKeyPath": "~/.ssh/id_rsa", "tabLabel": "PRD" }
  ],
  "credentials": {                       // from sshLite.credentialIndex (non-secret)
    "10.0.0.1:22:admin": [
      { "id": "c1", "label": "Default", "type": "password",
        "pinnedFolders": [ { "id": "p1", "name": "app", "remotePath": "/srv/app" } ] }
    ]
  }
}
```

- **Every connection the user sees in the Hosts panel is exported** — both saved hosts (`sshLite.hosts`) and `~/.ssh/config` hosts, deduped by `host:port:username` via `HostService.getAllHostsForExport()` (saved entry wins on a collision). This matches `getAllHosts()`; exporting saved-only silently dropped ssh-config hosts (a 19-saved / 82-ssh-config user got an export of 19 — issue #11 follow-up).
- `privateKeyPath` is exported **unexpanded** (`~/.ssh/...`) so the file is portable across machines/OSes: saved hosts keep their raw value; ssh-config hosts have their expanded key path collapsed back to `~`. On import every host is written to `sshLite.hosts` as `source: 'saved'`; on the same machine `getAllHosts()` dedup keeps the panel clean, and on a new machine the saved copy restores hosts whose `~/.ssh/config` isn't present.
- **No passwords or passphrases.** Secrets live only in `vscode.SecretStorage` and are never written to the file. A planted secret-bearing field is stripped by the export whitelist (`ConnectionPortabilityService.test.ts`).

## Import reconciliation

`parseAndValidate()` rejects a wrong `schema`, an unsupported (newer) `version`, or a non-array `hosts` with a clear message. Import is **always merge** (additive: upsert each host by `host:port:username` and each credential by `id`, pinned folders deduped by `remotePath`; existing connections not in the file are kept). There is **no intermediate Merge/Replace prompt** — `applyImportFlow()` decides between two paths:

- **No conflict** (nothing in the file matches an existing connection) → the file is merged in directly, no UI.
- **At least one conflict** → the **import review UI** opens immediately (a webview panel, `ConnectionImportPanel`).

**Import review UI — two labelled columns with a divider.** The panel is a grid table split by a vertical divider line: the left column header is **"Current (this extension)"**, the right is **"From file: &lt;filename&gt;"** (for Drive pull the label is `&lt;driveFileName&gt; (Google Drive)`). One row per connection in the file. **Conflicting connections sort to the top, alphabetically**, then the new ones (alphabetical). Each side shows name, `user@host:port`, key path, and credential/pinned chips; changed fields on the importing side are highlighted (`.chg`). The radio sits at the **start of its own half** (so header + radio + content line up per side). For a **conflict**, a radio on each side lets the user choose the file version or the current version (default: **file**). For a **new** connection the left column reads "Not currently saved" and the right-side radio is **always selected and locked** (a lone radio that can't be unticked — rendered checked, not greyed-out). Toolbar: **Use all from file** / **Keep all current** + a live "N of M will be imported" counter; **Import selected** and **Cancel**. The chosen connection ids (file-side radios that are checked) are applied as a merge; a conflict where the user kept the current version is skipped. Used by both file import and Drive pull. The panel posts `{type:'import', selectedIds}` / `{type:'cancel'}` back; all HTML (names + the source label) is escaped, and logs go through the webview `{type:'log'}` bridge. The current-side data comes from `existingSides()` (HostService.getAllHosts + CredentialService.listCredentials).

After applying, the Hosts tree refreshes. An imported password credential has **no** stored secret, so the first connect prompts for the password (existing `SSHConnection.buildAuthConfig` behavior; proven end-to-end in `docker-ssh-import.test.ts`).

## Native Google Drive sync

`GoogleDriveSyncService` implements the loopback + PKCE (S256) OAuth2 flow for a Google **Desktop** client and the minimal Drive REST calls — all over global `fetch` (no `googleapis` dependency).

- **Scope:** `https://www.googleapis.com/auth/drive.file` — non-sensitive (no Google CASA assessment), and the synced file is visible in the user's own Drive. The app can only see files it created.
- **Tokens** (`refresh` + `access` + `expiry`) are stored in SecretStorage under `sshLite:googleDrive:tokens`, refreshed on demand and on HTTP 401 (refresh-then-retry).
- **Push** = build export → find-or-create the Drive file (multipart create / `uploadType=media` PATCH). **Pull** = `files.list` by name → download with `alt=media` → validate → Merge/Replace.
- File name is configurable via `sshLite.googleDrive.fileName` (default `sshlite-connections.json`).

### One-time setup (project owner)

Drive sync only works once a Google Cloud OAuth client is provisioned and pasted
into `src/sync/googleClient.ts`:

1. Google Cloud Console → new project → enable the **Google Drive API**.
2. Create an OAuth client of type **Desktop app**.
3. Consent screen: add **only** the `drive.file` scope and publish to **In production** (while in *Testing*, Google expires refresh tokens after 7 days).
4. Paste the client id/secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

For a Desktop client the "client secret" is not confidential (it ships in the extension); PKCE is the real protection. Until configured, `isDriveConfigured()` is false and the Drive commands tell the user sync is unconfigured and suggest local Export/Import to a Drive-synced folder instead.

## Commands & UI

Six commands, grouped under a single **Import / Export / Sync** submenu (`$(sync)`) on the Hosts toolbar (`navigation@4`), and all in the Command Palette:

| Command | Action |
|---------|--------|
| `sshLite.exportConnections` | Export to a chosen JSON file |
| `sshLite.importConnections` | Import from a JSON file (Merge / Replace) |
| `sshLite.connectGoogleDrive` | OAuth sign-in |
| `sshLite.disconnectGoogleDrive` | Revoke + clear tokens |
| `sshLite.syncPushToDrive` | Upload the export to Drive |
| `sshLite.syncPullFromDrive` | Download from Drive and apply (Merge / Replace) |

## Code map

| File | Role |
|------|------|
| `src/services/ConnectionPortabilityService.ts` | Format authority: `buildExportPayload`, `serialize`, `parseAndValidate`, `applyImport` |
| `src/services/GoogleDriveSyncService.ts` | OAuth token lifecycle + Drive REST (`signIn`/`signOut`/`isSignedIn`/`push`/`pull`) |
| `src/sync/googleOAuth.ts` | PKCE helpers, auth-URL/token-body builders, loopback callback server |
| `src/sync/googleClient.ts` | Shipped client constants + `isDriveConfigured()` |
| `src/commands/connectionSyncCommands.ts` | The six command handlers + Merge/Replace UX + conflict-gated `pickConnectionsToImport()` |
| `src/webviews/ConnectionImportPanel.ts` | Import review webview: per-connection checkboxes, conflict badges, Select all/none, returns chosen ids |
| `src/services/HostService.ts` | `getAllHostsForExport()` (saved + ssh-config, deduped, portable `~`), `getSavedHostsForExport()`, `importSavedHosts(hosts, mode)` |
| `src/services/CredentialService.ts` | `exportMetadata()`, `importCredentialMetadata(hostId, creds, mode)` (never touches SecretStorage) |

## Tests

`ConnectionPortabilityService.test.ts`, `HostService.import.test.ts`, `CredentialService.import.test.ts`, `connectionSyncCommands.uri.test.ts` (URI-scheme safety), `connectionSyncCommands.drive.test.ts`, `googleOAuth.test.ts` (PKCE vector + request shaping), `GoogleDriveSyncService.test.ts` (mock `fetch`), and `docker-ssh-import.test.ts` (real-server prompt-then-auth).
