/**
 * Activation regression smoke test for SSH Lite.
 *
 * Background: in v0.8.10, an unguarded throw in one service init step inside
 * `activate()` aborted the whole function before reaching `createTreeView()`.
 * Result: all 4 tree views showed "There is no data provider registered" and
 * saved hosts looked lost. v0.8.11 wraps each high-risk step in `safeStep()`
 * so one failure no longer cascades.
 *
 * These tests are the regression net. They assert:
 *  - happy path: all 4 trees register, no init step failed
 *  - degraded path: when one service init throws, the OTHER 3 trees still
 *    register and the failure is recorded for the end-of-activate summary
 */

import * as vscode from 'vscode';
import { activate, __testGetActivateFailures } from './extension';
import { CredentialService } from './services/CredentialService';
import { HostService } from './services/HostService';
import { FileService } from './services/FileService';
import { TerminalService } from './services/TerminalService';
import { PortForwardService } from './services/PortForwardService';
import { ConnectionManager } from './connection/ConnectionManager';
import { AuditService } from './services/AuditService';
import { ServerMonitorService } from './services/ServerMonitorService';
import { CommandGuard } from './services/CommandGuard';
import { FolderHistoryService } from './services/FolderHistoryService';
import { SnippetService } from './services/SnippetService';
import { ActivityService } from './services/ActivityService';

/**
 * Reset every singleton the extension touches so each test gets a clean slate.
 * Without this, state injected by `mockImplementationOnce` on one test would
 * leak into the next.
 */
function resetAllSingletons(): void {
  const singletons = [
    CredentialService, HostService, FileService, TerminalService,
    PortForwardService, ConnectionManager, AuditService, ServerMonitorService,
    CommandGuard, FolderHistoryService, SnippetService, ActivityService,
  ];
  for (const S of singletons) {
    (S as unknown as { _instance?: unknown })._instance = undefined;
  }
}

function makeMockContext(): vscode.ExtensionContext {
  return {
    subscriptions: [] as { dispose(): unknown }[],
    extension: { packageJSON: { version: '0.8.11-test' } },
    extensionPath: '/fake/extension/path',
    globalState: {
      get: jest.fn().mockReturnValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      keys: jest.fn().mockReturnValue([]),
      setKeysForSync: jest.fn(),
    },
    workspaceState: {
      get: jest.fn().mockReturnValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      keys: jest.fn().mockReturnValue([]),
    },
    secrets: {
      get: jest.fn().mockResolvedValue(undefined),
      store: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      onDidChange: jest.fn(),
    },
  } as unknown as vscode.ExtensionContext;
}

describe('extension.activate — regression net for v0.8.10 tree-view-fail-to-register bug', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAllSingletons();
  });

  describe('happy path', () => {
    it('registers all 4 tree views with the expected viewIds and records zero failures', () => {
      const context = makeMockContext();
      const createTreeView = vscode.window.createTreeView as jest.Mock;

      activate(context);

      // All 4 SSH Lite tree views must register — the v0.8.10 bug was that
      // ZERO of these calls happened because activate() crashed earlier.
      expect(createTreeView).toHaveBeenCalledTimes(4);

      const viewIds = createTreeView.mock.calls.map((args) => args[0]).sort();
      expect(viewIds).toEqual([
        'sshLite.activity',
        'sshLite.fileExplorer',
        'sshLite.hosts',
        'sshLite.portForwards',
      ]);

      expect(__testGetActivateFailures()).toEqual([]);
    });
  });

  describe('degraded path — one service init throws', () => {
    it('still registers all 4 trees, records the failure, and shows one error notification', () => {
      const context = makeMockContext();
      const createTreeView = vscode.window.createTreeView as jest.Mock;
      const showErrorMessage = vscode.window.showErrorMessage as jest.Mock;

      // Inject a throw into CredentialService.initialize — this is exactly
      // the shape of the v0.8.10 regression (a service init throwing).
      jest.spyOn(CredentialService.prototype, 'initialize').mockImplementationOnce(() => {
        throw new Error('mock credential-svc failure for regression test');
      });

      activate(context);

      // The OTHER 3 trees still register — this is the whole point of safeStep.
      expect(createTreeView).toHaveBeenCalledTimes(4);
      const viewIds = createTreeView.mock.calls.map((args) => args[0]).sort();
      expect(viewIds).toEqual([
        'sshLite.activity',
        'sshLite.fileExplorer',
        'sshLite.hosts',
        'sshLite.portForwards',
      ]);

      // The failure is recorded so the end-of-activate summary fires.
      expect(__testGetActivateFailures()).toContain('credential-svc');

      // User sees exactly one summary notification mentioning the failed step.
      expect(showErrorMessage).toHaveBeenCalled();
      const lastMsg = showErrorMessage.mock.calls[showErrorMessage.mock.calls.length - 1][0] as string;
      expect(lastMsg).toContain('credential-svc');
    });
  });
});
