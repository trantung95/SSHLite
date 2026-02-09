/**
 * Chaos Bug Discovery Module - Output & Event Collector
 *
 * Intercepts ALL extension output channels, state events, and activity events.
 * This is the key innovation: captures everything the extension produces
 * so ChaosDetector can scan for anomalies.
 *
 * Captured channels:
 * - SSH Lite (main extension log)
 * - SSH Lite Commands (every SSH/SFTP command)
 * - SSH Lite Audit (file operation audit trail)
 * - SSH Lite Monitor (server diagnostics)
 * - SSH Lite - Server Backups (backup operations)
 */

import * as vscode from 'vscode';
import { SSHConnection } from '../connection/SSHConnection';
import { ActivityService, Activity } from '../services/ActivityService';
import { StateEvent } from './ChaosConfig';

export interface CollectedData {
  /** Output channel name -> timestamped lines */
  outputChannels: Map<string, string[]>;
  /** State/activity event timeline */
  stateTimeline: StateEvent[];
  /** Activity snapshots taken during collection */
  activitySnapshots: Activity[][];
  /** Start time of collection */
  startTime: number;
  /** End time of collection */
  endTime: number;
}

/**
 * Collects all extension output during chaos scenario execution.
 */
export class ChaosCollector {
  private outputChannels: Map<string, string[]> = new Map();
  private stateTimeline: StateEvent[] = [];
  private activitySnapshots: Activity[][] = [];
  private disposables: Array<{ dispose(): void }> = [];
  private startTime = 0;
  private originalCreateOutputChannel: any;
  private collecting = false;

  /**
   * Start collecting output and events.
   * Patches vscode mock's createOutputChannel to capture all output.
   */
  start(): void {
    this.reset();
    this.startTime = Date.now();
    this.collecting = true;

    // Patch createOutputChannel to capture output
    this.originalCreateOutputChannel = (vscode.window.createOutputChannel as jest.Mock).getMockImplementation?.()
      || undefined;

    const channels = this.outputChannels;
    (vscode.window.createOutputChannel as jest.Mock).mockImplementation((name: string) => {
      if (!channels.has(name)) {
        channels.set(name, []);
      }
      const lines = channels.get(name)!;
      return {
        appendLine: jest.fn((msg: string) => {
          lines.push(`[${Date.now()}] ${msg}`);
        }),
        append: jest.fn((msg: string) => {
          lines.push(`[${Date.now()}] ${msg}`);
        }),
        clear: jest.fn(() => {
          lines.length = 0;
        }),
        show: jest.fn(),
        hide: jest.fn(),
        dispose: jest.fn(),
        name,
      };
    });

    // Hook ActivityService events
    const activityService = ActivityService.getInstance();
    const actDisposable = activityService.onDidChangeActivities(() => {
      if (!this.collecting) return;
      const activities = activityService.getAllActivities();
      this.activitySnapshots.push([...activities]);
      this.stateTimeline.push({
        timestamp: Date.now(),
        connectionId: 'global',
        type: 'activity-change',
        data: JSON.stringify(activities.map(a => ({
          id: a.id, type: a.type, status: a.status, description: a.description,
        }))),
      });
    });
    this.disposables.push(actDisposable);
  }

  /**
   * Hook a specific SSHConnection's state change events.
   */
  hookConnection(conn: SSHConnection): void {
    const stateDisposable = conn.onStateChange((state) => {
      if (!this.collecting) return;
      this.stateTimeline.push({
        timestamp: Date.now(),
        connectionId: conn.id,
        type: 'state-change',
        data: state,
      });
    });
    this.disposables.push(stateDisposable);

    const fileDisposable = conn.onFileChange((event) => {
      if (!this.collecting) return;
      this.stateTimeline.push({
        timestamp: Date.now(),
        connectionId: conn.id,
        type: 'file-change',
        data: typeof event === 'string' ? event : JSON.stringify(event),
      });
    });
    this.disposables.push(fileDisposable);
  }

  /**
   * Stop collecting and return all captured data.
   */
  stop(): CollectedData {
    this.collecting = false;
    const endTime = Date.now();

    // Restore original createOutputChannel
    if (this.originalCreateOutputChannel) {
      (vscode.window.createOutputChannel as jest.Mock).mockImplementation(this.originalCreateOutputChannel);
    } else {
      (vscode.window.createOutputChannel as jest.Mock).mockReturnValue({
        appendLine: jest.fn(),
        append: jest.fn(),
        clear: jest.fn(),
        show: jest.fn(),
        hide: jest.fn(),
        dispose: jest.fn(),
      });
    }

    // Dispose all event hooks
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];

    return {
      outputChannels: new Map(this.outputChannels),
      stateTimeline: [...this.stateTimeline],
      activitySnapshots: [...this.activitySnapshots],
      startTime: this.startTime,
      endTime,
    };
  }

  /**
   * Get current output channel lines (for mid-scenario checks).
   */
  getChannelLines(channelName: string): string[] {
    return this.outputChannels.get(channelName) || [];
  }

  /**
   * Get current state timeline.
   */
  getTimeline(): StateEvent[] {
    return [...this.stateTimeline];
  }

  /**
   * Reset all collected data.
   */
  private reset(): void {
    this.outputChannels.clear();
    this.stateTimeline = [];
    this.activitySnapshots = [];
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.collecting = false;
  }
}
