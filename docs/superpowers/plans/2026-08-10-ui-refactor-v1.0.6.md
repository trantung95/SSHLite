# Kế hoạch triển khai tái cấu trúc giao diện gốc Secure Shell (SSH) Lite 1.0.6

> **Dành cho tác nhân thực thi:** BẮT BUỘC dùng `superpowers:subagent-driven-development` (khuyến nghị) hoặc `superpowers:executing-plans` để triển khai từng hạng mục. Mọi bước dùng ô chọn `- [ ]` để theo dõi.

**Mục tiêu:** Tái cấu trúc bốn mô-đun cây gốc và lớp hộp thoại/phản hồi của SSH Lite theo thiết kế A2 đã duyệt, giữ nguyên thói quen thao tác và số biểu tượng thao tác đang hiển thị của phiên bản 1.0.5.

**Kiến trúc:** Giữ nguyên command identifier, view identifier và dịch vụ lõi. Presentation state nằm trong từng tree provider; manifest giữ command icon, title và menu placement; `extension.ts` cùng `PortForwardService.ts` điều phối hộp thoại native. Các contract xuyên màn hình được khóa bằng test đọc `package.json`, còn hành vi từng module được khóa bằng test provider/service hiện có.

**Công nghệ:** TypeScript, Giao diện lập trình ứng dụng (Application Programming Interface, API) mở rộng Visual Studio Code (VS Code), Codicon, Jest với `@swc/jest`, manifest đóng góp `package.json`.

## Ràng buộc toàn cục

- Phiên bản đầu vào là `1.0.5`; phiên bản phát hành của kế hoạch này là `1.0.6`.
- VS Code tối thiểu vẫn là `^1.85.0`; không nâng engine chỉ để lấy icon mới.
- Giữ nguyên 117 command; không thêm, xóa hoặc đổi command identifier.
- Giữ nguyên view identifier: `sshLite.hosts`, `sshLite.fileExplorer`, `sshLite.activity`, `sshLite.portForwards`.
- Số action icon nhìn thấy phải bằng phiên bản 1.0.5 trong cùng state: Hosts `6`; Remote Files `10`, hoặc `11` khi filename filter active; Activity `4`; Port Forwards `2`.
- Inline action phải giữ đúng parity: Remote Files connection/folder/file `5/4/4`; Activity group/cancellable/completed `1/1/0`; Port Forwards active/saved `1/2`.
- Search dùng `search`; deep filename scan dùng `remote-explorer`; file filter dùng `filter`; tree state dùng `expand-all`, `fold-down`, `collapse-all`.
- ThemeIcon và text phải truyền đạt state mà không phụ thuộc riêng vào màu.
- Product copy tiếp tục dùng ngôn ngữ hiện có của extension; tài liệu và review với người dùng dùng tiếng Việt.
- Mọi source change phải chạy `npm run compile` ngay trong task chứa thay đổi.
- Mọi bug phát hiện trong quá trình thực thi phải có regression test ở tầng phù hợp.
- Không thay đổi connection config, keybinding hoặc dữ liệu đã lưu mà không có migration path.
- Không chạm các file hook chưa được theo dõi trong `.codex/hooks/`.

---

## Cấu trúc file dự kiến

| File | Trách nhiệm sau refactor |
|---|---|
| `package.json` | Command icon, action title, menu order và điều kiện hiển thị |
| `src/__tests__/ui-manifest-contract.test.ts` | Contract icon compatibility, action parity, slot và title xuyên module |
| `src/providers/HostTreeProvider.ts` | Presentation state của host, group, account, credential và empty state |
| `src/providers/FileTreeProvider.ts` | Presentation state của connection, folder, file, filter, loading, error và empty state |
| `src/providers/ActivityTreeProvider.ts` | Grouping, progress, status, tooltip và empty state của activity |
| `src/providers/PortForwardTreeProvider.ts` | Group rule theo host, active/saved/disconnected/restore-failed state |
| `src/services/PortForwardService.ts` | Lifecycle rule và lỗi auto-restore có thể hiển thị trong tree |
| `src/ui/nativeFeedback.ts` | Copy builder và port validation dùng chung cho native dialog/feedback |
| `src/extension.ts` | Command orchestration, confirmation, progress và feedback surface |
| `.adn/configuration/ui-icon-audit.md` | Quyết định cuối của icon audit và bằng chứng kiểm tra |
| `.adn/features/tree-providers.md` | Contract presentation của bốn native tree |
| `.adn/features/activity-audit.md` | Activity state, clear/cancel boundary và tooltip |
| `.adn/features/terminal-port-forwarding.md` | Port forward grouping, lifecycle và restore failure |
| `.adn/CHANGELOG.md` và `README.md` | Release note 1.0.6 |

---

### Hạng mục 1: Khóa quy ước icon, tiêu đề, menu và số lượng

**Files:**
- Create: `src/__tests__/ui-manifest-contract.test.ts`
- Modify: `package.json`
- Regenerate: `docs/COMMANDS.md`
- Regenerate: `src/chaos/catalog/commands.json`
- Regenerate: `src/chaos/catalog/actions.json`
- Regenerate: `src/chaos/catalog/flows.json`

**Interfaces:**
- Consumes: `package.json.contributes.commands`, `package.json.contributes.menus`.
- Produces: một quy ước manifest mà Hạng mục 2–7 phải giữ xanh.

- [ ] **Step 1: Viết test đỏ cho 13 command icon đã duyệt**

```typescript
import manifest from '../../package.json';

const expectedIcons: Record<string, string> = {
  'sshLite.importConnections': '$(arrow-circle-down)',
  'sshLite.forwardPort': '$(add)',
  'sshLite.cancelSearch': '$(search-stop)',
  'sshLite.cutRemoteItem': '$(move)',
  'sshLite.manageSnippets': '$(symbol-snippet)',
  'sshLite.pushPubKeyToHost': '$(key)',
  'sshLite.diagnoseSlowness': '$(pulse)',
  'sshLite.pinFolder': '$(pin)',
  'sshLite.deletePinnedFolder': '$(close)',
  'sshLite.clearAuditLog': '$(clear-all)',
  'sshLite.showBackupLogs': '$(output)',
  'sshLite.showServerBackups': '$(archive)',
  'sshLite.manageRemoteService': '$(gear)',
};

it('uses the approved command icon mapping', () => {
  const commands = new Map(manifest.contributes.commands.map(command => [command.command, command.icon]));
  expect(Object.fromEntries(Object.keys(expectedIcons).map(id => [id, commands.get(id)])))
    .toEqual(expectedIcons);
});
```

- [ ] **Step 2: Viết test đỏ cho action liền kề và title mô tả hậu quả**

```typescript
it('keeps adjacent Remote Files actions visually and verbally distinct', () => {
  const commands = new Map(manifest.contributes.commands.map(command => [command.command, command]));
  expect(commands.get('sshLite.showSearch')).toMatchObject({ icon: '$(search)' });
  expect(commands.get('sshLite.searchServerForFilter')).toMatchObject({ icon: '$(remote-explorer)' });
  expect(commands.get('sshLite.filterFiles')).toMatchObject({ icon: '$(filter)' });
  expect(commands.get('sshLite.showSearch')?.title).toContain('Advanced Search');
  expect(commands.get('sshLite.searchServerForFilter')?.title).toContain('Deep Scan');
});

it('explains stop, clear, and delete consequences in action titles', () => {
  const commands = new Map(manifest.contributes.commands.map(command => [command.command, command.title]));
  expect(commands.get('sshLite.stopForward')).toContain('Keep Saved Rule');
  expect(commands.get('sshLite.clearActivities')).toContain('Running Operations Continue');
  expect(commands.get('sshLite.deleteSavedForward')).toContain('Delete Saved Rule');
});
```

- [ ] **Step 3: Viết test đỏ cho title toolbar và inline parity**

```typescript
const titleMenus = manifest.contributes.menus['view/title'];
const itemMenus = manifest.contributes.menus['view/item/context'];

it('keeps the manifest entries that encode approved visible title states', () => {
  const navigation = (view: string) => titleMenus.filter(item =>
    item.when?.includes(`view == ${view}`) && item.group?.startsWith('navigation'));
  expect(navigation('sshLite.hosts')).toHaveLength(10);
  expect(navigation('sshLite.fileExplorer')).toHaveLength(13);
  expect(navigation('sshLite.activity')).toHaveLength(6);
  expect(navigation('sshLite.portForwards')).toHaveLength(4);
});

it('keeps Port Forwards row action parity', () => {
  expect(itemMenus.filter(item => item.when === 'view == sshLite.portForwards && viewItem == forward'))
    .toHaveLength(1);
  expect(itemMenus.filter(item => item.when === 'view == sshLite.portForwards && viewItem == savedForward'))
    .toHaveLength(2);
});
```

- [ ] **Step 4: Chạy test để xác nhận đỏ**

Run: `npx jest --no-coverage src/__tests__/ui-manifest-contract.test.ts`

Expected: FAIL ở 13 icon mapping và ba title mới.

- [ ] **Step 5: Sửa manifest bằng mapping và title đã duyệt**

Đặt chính xác các icon trong `expectedIcons`. Giữ `sshLite.searchServerForFilter` là `$(remote-explorer)`. Đặt title:

```json
{
  "sshLite.showSearch": "Advanced Search — Content, Filenames, Scopes, and Servers",
  "sshLite.searchServerForFilter": "Deep Scan Current Filter — Add Matches to Remote Files",
  "sshLite.filterFiles": "Filter Loaded Files by Name",
  "sshLite.forwardPort": "Create Port Forward — Automatically Save Rule",
  "sshLite.stopForward": "Stop Port Forward — Keep Saved Rule",
  "sshLite.clearActivities": "Clear Activity List — Running Operations Continue",
  "sshLite.deleteSavedForward": "Delete Saved Rule Permanently"
}
```

Không đổi `command` identifier, `when`, `group` hoặc số menu entry.

- [ ] **Step 6: Regenerate tài liệu và chaos catalog**

Run: `npm run docs:commands`

Run: `npm run chaos:catalog`

Expected: `docs/COMMANDS.md` và ba file catalog đồng bộ với manifest.

- [ ] **Step 7: Chạy test, build và drift test**

Run: `npx jest --no-coverage src/__tests__/ui-manifest-contract.test.ts src/__tests__/ftp-menu-gating.test.ts src/__tests__/chaos/catalogDrift.test.ts`

Run: `npm run compile`

Expected: tất cả PASS; TypeScript có 0 error.

- [ ] **Step 8: Commit**

```bash
git add package.json docs/COMMANDS.md src/chaos/catalog src/__tests__/ui-manifest-contract.test.ts
git commit -m "feat(ui): standardize native action semantics"
```

---

### Hạng mục 2: Tái cấu trúc cách hiển thị SSH Hosts

**Files:**
- Modify: `src/providers/HostTreeProvider.ts`
- Modify: `src/providers/HostTreeProvider.test.ts`
- Modify: `.adn/features/tree-providers.md`

**Interfaces:**
- Consumes: quy ước icon và tiêu đề lệnh từ Hạng mục 1.
- Produces: `NoHostsTreeItem`; host row dùng `server` ThemeIcon và state text ổn định cho normal, connected, reconnecting, failed, empty.

- [ ] **Step 1: Viết test đỏ cho icon và state không phụ thuộc màu**

```typescript
it('renders connected host with server icon and explicit state text', () => {
  const host = createMockHostConfig({ name: 'Production', host: '10.0.0.1', port: 22 });
  const item = new ServerTreeItem('10.0.0.1:22', [host], true);
  expect((item.iconPath as vscode.ThemeIcon).id).toBe('server');
  expect(item.tooltip?.toString()).toContain('Status: Connected');
});

it('renders reconnecting and failed hosts with explicit text', () => {
  const host = createMockHostConfig({ name: 'Production', host: '10.0.0.1', port: 22 });
  const reconnecting = new ServerTreeItem('10.0.0.1:22', [host], false, undefined, true);
  const failed = new ServerTreeItem('10.0.0.1:22', [host], false, {
    success: false, timestamp: Date.now(), errorMessage: 'Connection refused'
  });
  expect((reconnecting.iconPath as vscode.ThemeIcon).id).toBe('server');
  expect(reconnecting.tooltip?.toString()).toContain('Status: Reconnecting');
  expect((failed.iconPath as vscode.ThemeIcon).id).toBe('server');
  expect(failed.tooltip?.toString()).toContain('Connection failed');
});
```

- [ ] **Step 2: Viết test đỏ cho empty state và inline action parity**

```typescript
it('shows a quiet actionable empty state', async () => {
  mockGetAllHosts.mockReturnValue([]);
  const children = await provider.getChildren();
  expect(children).toHaveLength(1);
  expect(children[0].label).toBe('No SSH hosts yet');
  expect(children[0].description).toContain('Add Host');
});
```

- [ ] **Step 3: Chạy test để xác nhận đỏ**

Run: `npx jest --no-coverage src/providers/HostTreeProvider.test.ts`

Expected: FAIL ở ThemeIcon `vm*`, state text hoặc empty copy hiện tại.

- [ ] **Step 4: Implement presentation tối thiểu**

Trong `HostTreeProvider.ts`:

```typescript
export class NoHostsTreeItem extends vscode.TreeItem {
  readonly contextValue = 'noHosts';
  constructor() {
    super('No SSH hosts yet', vscode.TreeItemCollapsibleState.None);
    this.id = 'hosts:empty';
    this.iconPath = new vscode.ThemeIcon('server');
    this.description = 'Use Add Host to create or import a connection';
  }
}
```

- Mọi `ServerTreeItem` dùng `new vscode.ThemeIcon('server', stateColor)`; `stateColor` được chọn ngay trong constructor từ `isConnected`, `isReconnecting` và `lastConnectionAttempt`. Sudo mode giữ `shield` vì đó là mode riêng, không phải host identity.
- Connected dùng `charts.green`; reconnecting dùng `charts.yellow`; failed dùng `charts.orange`; saved/disconnected dùng foreground mặc định.
- Tooltip phải dùng đúng các chuỗi trạng thái `Status: Connected`, `Status: Reconnecting`, `Status: Connection failed` và kèm `errorMessage` khi có.
- Giữ stable item `id` hiện có.
- Không đổi `contextValue` hoặc command binding.
- Protocol group dùng `remote`, không dùng `terminal` cho Secure Shell (SSH) và `cloud` cho File Transfer Protocol (FTP).
- Account, credential và pinned-folder row giữ số inline action hiện tại.
- Empty state dùng icon `server` trung tính, label `No SSH hosts yet`, description `Use Add Host to create or import a connection`.

- [ ] **Step 5: Chạy targeted test và build**

Run: `npx jest --no-coverage src/providers/HostTreeProvider.test.ts src/extension.activate.test.ts`

Run: `npm run compile`

Expected: PASS; TypeScript có 0 error.

- [ ] **Step 6: Cập nhật tài liệu và commit**

Ghi state table, icon và empty copy vào `.adn/features/tree-providers.md`.

```bash
git add src/providers/HostTreeProvider.ts src/providers/HostTreeProvider.test.ts .adn/features/tree-providers.md
git commit -m "feat(ui): clarify SSH host states"
```

---

### Hạng mục 3: Tái cấu trúc cách hiển thị Remote Files

**Files:**
- Modify: `src/providers/FileTreeProvider.ts`
- Modify: `src/providers/FileTreeProvider.test.ts`
- Modify: `src/providers/FileTreeProvider.filter.test.ts`
- Modify: `src/providers/FileTreeProvider.issue13.test.ts`
- Modify: `.adn/features/tree-providers.md`

**Interfaces:**
- Consumes: quy ước tiêu đề và icon của `showSearch`, `searchServerForFilter`, `filterFiles` từ Hạng mục 1.
- Produces: connection/folder/file state rõ ràng; filter và deep scan vẫn giữ logic dữ liệu hiện có.

- [ ] **Step 1: Viết test đỏ cho ba action khác nhau**

Test provider không đổi command, nhưng phải khóa presentation của filter:

```typescript
it('filters only cached rows until deep scan is explicitly requested', async () => {
  provider.setFilter('*.log');
  expect(mockConnection.searchFiles).not.toHaveBeenCalled();
  await provider.searchServerForFilter();
  expect(mockConnection.searchFiles).toHaveBeenCalledWith(
    expect.any(String), '*.log', expect.objectContaining({ searchContent: false }));
});
```

- [ ] **Step 2: Viết test đỏ cho ThemeIcon và state rows**

```typescript
it('uses remote icon for a connection root', () => {
  const connection = createMockConnection();
  const item = new ConnectionTreeItem(connection as SSHConnection, '/var');
  expect((item.iconPath as vscode.ThemeIcon).id).toBe('remote');
});

it('distinguishes open, loading, and failed presentation', () => {
  const connection = createMockConnection();
  const file = createMockRemoteFile('app.log', { path: '/var/app.log', isDirectory: false });
  const open = new FileTreeItem(file, connection as SSHConnection, false, true);
  const loading = new FileTreeItem(file, connection as SSHConnection, false, false, true);
  const failed = new LoadErrorTreeItem('Permission denied', 'conn:/var');
  expect((open.iconPath as vscode.ThemeIcon).id).toBe('file');
  expect(open.description).toContain('Open');
  expect((loading.iconPath as vscode.ThemeIcon).id).toBe('sync~spin');
  expect(failed.contextValue).toBe('loadError');
  expect(failed.label).toContain('Permission denied');
});
```

- [ ] **Step 3: Chạy test để xác nhận đỏ**

Run: `npx jest --no-coverage src/providers/FileTreeProvider.test.ts src/providers/FileTreeProvider.filter.test.ts src/providers/FileTreeProvider.issue13.test.ts`

Expected: ít nhất connection icon test FAIL trước implementation.

- [ ] **Step 4: Implement presentation state**

- Connection root dùng `remote` ThemeIcon; state connected, reconnecting và disconnected luôn có description.
- Parent row giữ `arrow-up` nhưng bỏ amber; dùng foreground theme mặc định.
- File đang mở giữ file-type icon và dùng decoration/description `Open`, không thay icon bằng `eye`.
- Loading dùng `sync~spin` và label chỉ rõ path đang tải.
- Failed listing dùng `error`, giữ nguyên dữ liệu cache cũ và recovery qua action refresh hiện có.
- Empty folder trả mảng rỗng để VS Code hiển thị empty tự nhiên; không tạo error-like placeholder.
- Filter result giữ nguyên dữ liệu đầy đủ, max result và hit-limit behavior.
- Không đổi canonical inline slot `5/4/4` trong `package.json`.

- [ ] **Step 5: Chạy targeted test và build**

Run: `npx jest --no-coverage src/providers/FileTreeProvider.test.ts src/providers/FileTreeProvider.filter.test.ts src/providers/FileTreeProvider.issue13.test.ts src/__tests__/ftp-menu-gating.test.ts`

Run: `npm run compile`

Expected: PASS; không có inline slot collision; TypeScript có 0 error.

- [ ] **Step 6: Cập nhật tài liệu và commit**

Ghi default, filtered, loading, upload failure và empty folder presentation vào `.adn/features/tree-providers.md`.

```bash
git add src/providers/FileTreeProvider.ts src/providers/FileTreeProvider.test.ts src/providers/FileTreeProvider.filter.test.ts src/providers/FileTreeProvider.issue13.test.ts .adn/features/tree-providers.md
git commit -m "feat(ui): clarify remote file states"
```

---

### Hạng mục 4: Tái cấu trúc trạng thái Activity và ranh giới xóa/hủy

**Files:**
- Modify: `src/providers/ActivityTreeProvider.ts`
- Modify: `src/providers/ActivityTreeProvider.test.ts`
- Modify: `src/services/ActivityService.test.ts`
- Modify: `.adn/features/activity-audit.md`

**Interfaces:**
- Consumes: đối tượng Activity hiện có và quy ước tiêu đề thao tác từ Hạng mục 1.
- Produces: status presentation cho `running`, `completed`, `failed`, `cancelled`; không đổi lifecycle timer.

- [ ] **Step 1: Viết test đỏ cho status, progress và tooltip**

```typescript
const createActivity = (overrides: Partial<Activity> = {}): Activity => ({
  id: 'activity-test',
  type: 'download',
  connectionId: 'conn1',
  serverName: 'Server1',
  description: 'Download app.log',
  status: 'running',
  startTime: new Date('2026-08-10T00:00:00Z'),
  cancellable: true,
  ...overrides,
});

it('shows progress, detail, duration, server, and status without relying on color', () => {
  const activity = createActivity({
    status: 'running', progress: 62, detail: '18 MB / 29 MB', description: 'Download app.log'
  });
  const item = new ActivityTreeItem(activity);
  expect(item.description).toBe('62% · 18 MB / 29 MB');
  expect((item.iconPath as vscode.ThemeIcon).id).toBe('sync~spin');
  expect(item.tooltip?.toString()).toContain('Status: Running');
  expect(item.tooltip?.toString()).toContain('Server:');
});
```

- [ ] **Step 2: Viết test đỏ cho completed, failed, cancelled và empty**

```typescript
it.each([
  ['completed', 'check', 'Completed'],
  ['failed', 'error', 'Failed'],
  ['cancelled', 'circle-slash', 'Cancelled'],
])('renders %s with icon and explicit text', (status, icon, text) => {
  const item = new ActivityTreeItem(createActivity({ status }));
  expect((item.iconPath as vscode.ThemeIcon).id).toBe(icon);
  expect(`${item.description} ${item.tooltip}`).toContain(text);
});

it('states that clearing tracking does not cancel operations', () => {
  expect(ActivityService.prototype.clearAll).not.toBe(ActivityService.prototype.cancelAll);
});
```

- [ ] **Step 3: Chạy test để xác nhận đỏ**

Run: `npx jest --no-coverage src/providers/ActivityTreeProvider.test.ts src/services/ActivityService.test.ts`

Expected: FAIL ở progress description mới.

- [ ] **Step 4: Implement presentation tối thiểu**

```typescript
if (activity.status === 'running' && activity.progress !== undefined) {
  this.description = activity.detail
    ? `${activity.progress}% · ${activity.detail}`
    : `${activity.progress}%`;
}
```

- Server/type group description dùng `runningCount` và `activityCount` bằng text, không chỉ icon.
- Running item có `sync~spin`; completed có `check`; cancelled có `circle-slash`; failed có `error`.
- Empty item label `No activities`, description `Running SSH operations will appear here`.
- `clearAll()` tiếp tục chỉ xóa tracking; `cancelAll()` tiếp tục gọi cancellation callback.
- Không thêm inline action; group/cancellable/completed giữ `1/1/0`.

- [ ] **Step 5: Chạy targeted test và build**

Run: `npx jest --no-coverage src/providers/ActivityTreeProvider.test.ts src/services/ActivityService.test.ts src/__tests__/ui-manifest-contract.test.ts`

Run: `npm run compile`

Expected: PASS; TypeScript có 0 error.

- [ ] **Step 6: Cập nhật tài liệu và commit**

```bash
git add src/providers/ActivityTreeProvider.ts src/providers/ActivityTreeProvider.test.ts src/services/ActivityService.test.ts .adn/features/activity-audit.md
git commit -m "feat(ui): clarify activity progress and outcomes"
```

---

### Hạng mục 5: Nhóm Port Forwards theo máy chủ và giữ lỗi khôi phục

**Files:**
- Modify: `src/providers/PortForwardTreeProvider.ts`
- Modify: `src/providers/PortForwardTreeProvider.test.ts`
- Modify: `src/services/PortForwardService.ts`
- Modify: `src/services/PortForwardService.test.ts`
- Modify: `.adn/features/terminal-port-forwarding.md`

**Interfaces:**
- Produces: `PortForwardServerGroupTreeItem`; `PortForwardService.getRestoreFailure(hostId, ruleId): string | undefined`; `PortForwardService.clearRestoreFailure(hostId, ruleId): void`.
- Consumes: `IPortForward`, `ISavedPortForwardRule`, HostService và ConnectionManager hiện có.

- [ ] **Step 1: Viết test đỏ cho grouping và label trái-sang-phải**

```typescript
it('groups active and saved rules under their host', async () => {
  provider.addForward(mockConnection.id, 8080, 'localhost', 3000);
  const groups = await provider.getChildren();
  expect(groups).toHaveLength(1);
  expect(groups[0]).toBeInstanceOf(PortForwardServerGroupTreeItem);
  const rules = await provider.getChildren(groups[0]);
  expect(rules).toHaveLength(1);
});

it('reads route from local endpoint to remote endpoint', () => {
  const item = new PortForwardTreeItem(forward, mockConnection);
  expect(item.label).toBe('localhost:8080 → production-api:3000');
});
```

- [ ] **Step 2: Viết test đỏ cho restore failure**

```typescript
it('keeps a failed restored rule visible with the reason', async () => {
  mockConnection.forwardPort.mockRejectedValueOnce(new Error('Address already in use'));
  await service.restoreForwardsForConnection(mockConnection);
  expect(service.getRestoreFailure(mockConnection.id, savedRule.id))
    .toBe('Address already in use');
  const group = (await provider.getChildren())[0];
  const rules = await provider.getChildren(group);
  expect(rules[0].description).toContain('Restore failed');
});
```

- [ ] **Step 3: Chạy test để xác nhận đỏ**

Run: `npx jest --no-coverage src/providers/PortForwardTreeProvider.test.ts src/services/PortForwardService.test.ts`

Expected: FAIL vì provider hiện là flat list và restore error bị nuốt.

- [ ] **Step 4: Implement restore failure registry**

Trong `PortForwardService`:

```typescript
private readonly restoreFailures = new Map<string, string>();

private restoreFailureKey(hostId: string, ruleId: string): string {
  return `${hostId}:${ruleId}`;
}

getRestoreFailure(hostId: string, ruleId: string): string | undefined {
  return this.restoreFailures.get(this.restoreFailureKey(hostId, ruleId));
}

clearRestoreFailure(hostId: string, ruleId: string): void {
  this.restoreFailures.delete(this.restoreFailureKey(hostId, ruleId));
}
```

- Khi restore fail: lưu `(error as Error).message` theo host/rule và refresh provider.
- Khi activate thành công hoặc rule bị xóa: clear failure.
- Registry chỉ là runtime presentation state; không persist sang globalState.

- [ ] **Step 5: Implement host group và stable parent relation**

```typescript
export class PortForwardServerGroupTreeItem extends vscode.TreeItem {
  readonly contextValue = 'portForwardServerGroup';
  constructor(public readonly hostId: string, hostName: string, description: string) {
    super(hostName, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `port-forward-server:${hostId}`;
    this.iconPath = new vscode.ThemeIcon('server');
    this.description = description;
  }
}
```

- Root `getChildren()` trả group theo host.
- Group `getChildren(group)` trả active trước, saved inactive sau.
- Active label: `localhost:${localPort} → ${hostName}:${remotePort}`.
- Saved description: `Saved · stopped`; disconnected: `Host disconnected`; failed: `Restore failed · ${reason}`.
- `getParent(rule)` trả stable group tương ứng.
- Active row giữ một stop action; saved row giữ play và delete.

- [ ] **Step 6: Chạy targeted test và build**

Run: `npx jest --no-coverage src/providers/PortForwardTreeProvider.test.ts src/services/PortForwardService.test.ts src/services/PortForwardService.logs.test.ts src/__tests__/ui-manifest-contract.test.ts`

Run: `npm run compile`

Expected: PASS; TypeScript có 0 error.

- [ ] **Step 7: Cập nhật tài liệu và commit**

```bash
git add src/providers/PortForwardTreeProvider.ts src/providers/PortForwardTreeProvider.test.ts src/services/PortForwardService.ts src/services/PortForwardService.test.ts .adn/features/terminal-port-forwarding.md
git commit -m "feat(ui): group port forwards by host"
```

---

### Hạng mục 6: Chuẩn hóa hộp thoại gốc, kiểm tra dữ liệu và phản hồi

**Files:**
- Create: `src/ui/nativeFeedback.ts`
- Create: `src/ui/nativeFeedback.test.ts`
- Modify: `src/services/PortForwardService.ts`
- Modify: `src/services/PortForwardService.test.ts`
- Modify: `src/extension.ts`
- Modify: `src/extension.test.ts`

**Interfaces:**
- Produces: `portForwardStepTitle(step: 1 | 2 | 3): string`; `validatePort(value: string, unavailablePorts?: ReadonlySet<number>): string | null`; `formatErrorMessage(action: string, reason: string, recovery: string): string`.
- Consumes: các handler native hiện có.

- [ ] **Step 1: Viết test đỏ cho helper copy và validation**

```typescript
import { portForwardStepTitle, validatePort, formatErrorMessage } from './nativeFeedback';

it('labels each port-forward step', () => {
  expect(portForwardStepTitle(1)).toBe('Create Port Forward — Step 1 of 3');
  expect(portForwardStepTitle(2)).toBe('Create Port Forward — Step 2 of 3');
  expect(portForwardStepTitle(3)).toBe('Create Port Forward — Step 3 of 3');
});

it.each([['', 'Enter a port'], ['0', 'Port must be between 1 and 65535'], ['65536', 'Port must be between 1 and 65535']])
('validates port %p', (value, message) => expect(validatePort(value)).toBe(message));

it('reports an unavailable local port', () => {
  expect(validatePort('8080', new Set([8080]))).toBe('Local port 8080 is already forwarded');
});

it('formats errors with recovery', () => {
  expect(formatErrorMessage('Create port forward', 'Address already in use', 'Choose another local port and try again'))
    .toBe('Create port forward failed: Address already in use. Choose another local port and try again.');
});
```

- [ ] **Step 2: Chạy test để xác nhận đỏ**

Run: `npx jest --no-coverage src/ui/nativeFeedback.test.ts`

Expected: FAIL vì module chưa tồn tại.

- [ ] **Step 3: Implement helper thuần**

```typescript
export function portForwardStepTitle(step: 1 | 2 | 3): string {
  return `Create Port Forward — Step ${step} of 3`;
}

export function validatePort(value: string, unavailablePorts: ReadonlySet<number> = new Set()): string | null {
  if (!value.trim()) return 'Enter a port';
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Port must be between 1 and 65535';
  if (unavailablePorts.has(port)) return `Local port ${port} is already forwarded`;
  return null;
}

export function formatErrorMessage(action: string, reason: string, recovery: string): string {
  return `${action} failed: ${reason}. ${recovery}.`;
}
```

- [ ] **Step 4: Dùng helper trong flow tạo port forward**

- Quick Pick title: `Create Port Forward — Step 1 of 3`.
- Item label là host name; description là `username@host · port N`; connected host đứng trước.
- Input Box cổng đích dùng title Step 2; prompt nêu đây là cổng dịch vụ trên máy đích.
- Input Box host đích tiếp tục là phần thứ hai của Step 2, giữ giá trị mặc định `localhost`; prompt giải thích `localhost` là chính máy chủ SSH.
- Input Box cổng cục bộ dùng title Step 3; prompt nêu cổng nằm trên máy người dùng; validation dùng `validatePort`.
- Success status bar nêu route và việc rule đã lưu.
- Error notification nêu reason, recovery và action `Retry` khi retry an toàn.

- [ ] **Step 5: Thêm modal confirmation cho delete saved forward**

Trong handler `sshLite.deleteSavedForward`, trước `deleteSavedRule`:

```typescript
const confirm = await vscode.window.showWarningMessage(
  `Delete saved rule localhost:${item.rule.localPort} → ${item.hostName}:${item.rule.remotePort}? ` +
  'It will not restore on the next connection. No server data will be deleted.',
  { modal: true },
  'Delete Saved Rule'
);
if (confirm !== 'Delete Saved Rule') return;
```

- [ ] **Step 6: Thêm confirmation rõ boundary cho clear activity list**

Nếu có running activity, handler `sshLite.clearActivities` hỏi:

```typescript
const confirm = await vscode.window.showWarningMessage(
  'Clear the activity list? Running operations will continue but will no longer appear in Activity.',
  { modal: true },
  'Clear Activity List'
);
if (confirm !== 'Clear Activity List') return;
```

Nếu không có running activity, clear ngay và dùng status bar nhẹ.

- [ ] **Step 7: Chạy targeted test và build**

Run: `npx jest --no-coverage src/ui/nativeFeedback.test.ts src/services/PortForwardService.test.ts src/extension.test.ts`

Run: `npm run compile`

Expected: PASS; TypeScript có 0 error.

- [ ] **Step 8: Commit**

```bash
git add src/ui/nativeFeedback.ts src/ui/nativeFeedback.test.ts src/services/PortForwardService.ts src/services/PortForwardService.test.ts src/extension.ts src/extension.test.ts
git commit -m "feat(ui): clarify native dialogs and feedback"
```

---

### Hạng mục 7: Tính nhất quán xuyên màn hình, khả năng tiếp cận và cổng chống tái phát

**Files:**
- Modify: `src/__tests__/ui-manifest-contract.test.ts`
- Modify: `src/__tests__/ftp-menu-gating.test.ts`
- Modify: `.adn/configuration/ui-icon-audit.md`
- Modify: `.adn/testing/testing-strategy.md`

**Interfaces:**
- Consumes: toàn bộ quy ước hiển thị từ Hạng mục 1–6.
- Produces: một gate duy nhất chặn icon drift, slot collision, unsupported Codicon và parity regression.

- [ ] **Step 1: Thêm supported-icon fixture ngay trong test**

Tạo `Set<string>` từ đúng các icon đang dùng sau Task 1 và xác nhận không còn `import`:

```typescript
const minimumSupportedIcons = new Set([
  'add', 'archive', 'arrow-circle-down', 'arrow-up', 'bug', 'calendar', 'clear-all',
  'clippy', 'close', 'cloud-download', 'cloud-upload', 'collapse-all', 'copy',
  'dashboard', 'database', 'debug-disconnect', 'diff', 'edit', 'expand-all', 'export',
  'feedback', 'file', 'filter', 'fold-down', 'folder-library', 'folder-opened', 'gear',
  'go-to-file', 'heart', 'history', 'home', 'info', 'key', 'link', 'list-flat',
  'list-tree', 'move', 'new-file', 'new-folder', 'output', 'person', 'pin', 'play',
  'plug', 'pulse', 'refresh', 'remote-explorer', 'root-folder', 'run', 'save',
  'search', 'search-stop', 'server-process', 'shield', 'sign-in', 'sign-out', 'star',
  'stop', 'stop-circle', 'symbol-snippet', 'symbol-variable', 'tag', 'target',
  'terminal', 'terminal-bash', 'trash'
]);
```

- [ ] **Step 2: Viết test compatibility và collision**

```typescript
it('uses only Codicons supported by VS Code 1.85.2 for every command', () => {
  for (const command of manifest.contributes.commands) {
    const id = command.icon?.match(/^\$\(([^)]+)\)$/)?.[1];
    expect(id && minimumSupportedIcons.has(id)).toBe(true);
  }
});
```

Giữ test collision hiện có trong `ftp-menu-gating.test.ts`; thêm assertion command xuất hiện nhiều row luôn dùng cùng `inline@N` slot theo bảng canonical trong `AGENTS.md`.

- [ ] **Step 3: Chạy toàn bộ native-tree test**

Run: `npx jest --no-coverage src/__tests__/ui-manifest-contract.test.ts src/__tests__/ftp-menu-gating.test.ts src/providers/HostTreeProvider.test.ts src/providers/FileTreeProvider.test.ts src/providers/FileTreeProvider.filter.test.ts src/providers/FileTreeProvider.issue13.test.ts src/providers/ActivityTreeProvider.test.ts src/providers/PortForwardTreeProvider.test.ts src/services/ActivityService.test.ts src/services/PortForwardService.test.ts src/ui/nativeFeedback.test.ts`

Expected: tất cả PASS.

- [ ] **Step 4: Chạy full unit suite và build**

Run: `npx jest --no-coverage`

Run: `npm run compile`

Expected: toàn bộ suite PASS; TypeScript có 0 error.

- [ ] **Step 5: Kiểm tra thủ công bằng Extension Development Host**

Kiểm tra cả Dark+ và Light+:

- Hosts: normal, connected, reconnecting, error, empty; header 6 icon.
- Remote Files: default 10 icon; filename filter active 11; inline `5/4/4`; loading, failed listing, empty folder.
- Activity: running, completed, failed, cancelled, empty; header 4; inline `1/1/0`.
- Port Forwards: active, saved, disconnected, restore failed, empty; header 2; inline active/saved `1/2`.
- Hover tooltip nói rõ action, phạm vi và hậu quả.
- Keyboard Tab/Shift+Tab, Enter, Escape, focus ring và screen-reader label hoạt động.
- Không state nào chỉ dựa vào màu.

- [ ] **Step 6: Cập nhật audit evidence và commit**

```bash
git add src/__tests__/ui-manifest-contract.test.ts src/__tests__/ftp-menu-gating.test.ts .adn/configuration/ui-icon-audit.md .adn/testing/testing-strategy.md
git commit -m "test(ui): lock native interface contracts"
```

---

### Hạng mục 8: Đóng phiên bản 1.0.6, tài liệu và gói phát hành

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `.adn/CHANGELOG.md`
- Regenerate: `docs/COMMANDS.md`
- Regenerate: `src/chaos/catalog/commands.json`
- Regenerate: `src/chaos/catalog/actions.json`
- Regenerate: `src/chaos/catalog/flows.json`

**Interfaces:**
- Consumes: phần triển khai và bằng chứng kiểm thử từ Hạng mục 1–7.
- Produces: package 1.0.6 có release note, tài liệu và catalog đồng bộ.

- [ ] **Step 1: Bump version đúng thứ tự**

Đổi `package.json`:

```json
"version": "1.0.6"
```

Không sửa `package-lock.json` thủ công.

- [ ] **Step 2: Viết release note**

Prepend README, giữ đúng hai version gần nhất:

```markdown
**1.0.6** — Refined the native SSH sidebar without changing visible action density: clearer host and file states, distinct search/filter actions, grouped port forwards, readable activity progress, and safer native confirmations.
```

Prepend `.adn/CHANGELOG.md` với cùng giá trị người dùng và thêm chi tiết kỹ thuật/test evidence; không trim changelog archive.

- [ ] **Step 3: Regenerate generated artifacts**

Run: `npm run docs:commands`

Run: `npm run chaos:catalog`

- [ ] **Step 4: Chạy full verification**

Run: `npm run compile`

Run: `npx jest --no-coverage`

Run: `npm run test:chaos`

Expected: build 0 error; unit suite PASS; quick chaos PASS.

- [ ] **Step 5: Package Visual Studio Extension (VSIX)**

Run: `npx vsce package`

Expected: tạo file `.vsix` phiên bản 1.0.6; packaging không báo missing file hoặc manifest error.

- [ ] **Step 6: Chạy code review bắt buộc**

Invoke: `superpowers:requesting-code-review`

Reviewer phải kiểm tra backward compatibility, action parity, restore failure lifecycle, clear/cancel boundary, test coverage và tài liệu.

- [ ] **Step 7: Sửa mọi finding rồi chạy lại verification đầy đủ**

Run: `npm run compile`

Run: `npx jest --no-coverage`

Run: `npm run test:chaos`

Run: `npx vsce package`

Expected: tất cả PASS sau lần sửa cuối.

- [ ] **Step 8: Commit release**

```bash
git add package.json README.md .adn/CHANGELOG.md docs/COMMANDS.md src/chaos/catalog
git commit -m "release: prepare SSH Lite 1.0.6"
```

---

## Điểm dừng và điều kiện hoàn tất

Không coi 1.0.6 hoàn tất nếu thiếu một trong các bằng chứng sau:

- 117 command và số visible action icon không đổi.
- Tất cả icon thay đổi tồn tại trong VS Code 1.85.2.
- Targeted test của từng task xanh trước commit tương ứng.
- Full Jest suite, TypeScript compile, quick chaos và VSIX package đều thành công sau code review.
- Dark theme, light theme, keyboard, hover, selected, disabled, loading, empty, warning và error được kiểm tra thủ công.
- README, changelog, command docs, chaos catalog và `.adn/` đồng bộ với source.
- Không file hook chưa được theo dõi trong `.codex/hooks/` bị stage hoặc commit.
