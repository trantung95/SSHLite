/**
 * Chaos Bug Discovery Module - Anomaly Detector
 *
 * Scans collected output, state events, and activity snapshots for anomalies.
 * Each detection rule looks for a specific class of bugs.
 */

import { CollectedData } from './ChaosCollector';
import { Anomaly } from './ChaosConfig';

/** Patterns that indicate errors in output channels */
const ERROR_PATTERNS = [
  /\bError\b/i,
  /\bFAILED\b/,
  /\btimeout\b/i,
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bEPIPE\b/,
  /\bENOTFOUND\b/,
  /SFTP error/i,
  /unhandled/i,
  /uncaught/i,
  /stack overflow/i,
  /out of memory/i,
];

/** Patterns that are expected and should be ignored */
const EXPECTED_PATTERNS = [
  /\[CONNECT\] FAILED/,  // Expected for error-path scenarios
  /Authentication failed/, // Expected for wrong-password scenarios
  /Host key verification/, // Expected for first connect
  /No such file/,          // Expected for delete verification
];

export class ChaosDetector {
  /**
   * Scan collected data for anomalies.
   */
  detect(data: CollectedData, context?: { scenario?: string; server_os?: string; server_label?: string }): Anomaly[] {
    const anomalies: Anomaly[] = [];

    anomalies.push(...this.detectOutputErrors(data, context));
    anomalies.push(...this.detectActivityLeaks(data, context));
    anomalies.push(...this.detectStateAnomalies(data, context));
    anomalies.push(...this.detectDoubleEvents(data, context));

    return anomalies;
  }

  /**
   * Strategy 2: Scan output channels for unexpected errors.
   */
  private detectOutputErrors(
    data: CollectedData,
    context?: { scenario?: string; server_os?: string; server_label?: string }
  ): Anomaly[] {
    const anomalies: Anomaly[] = [];

    for (const [channel, lines] of data.outputChannels) {
      for (const line of lines) {
        // Check if line matches any error pattern
        const matchesError = ERROR_PATTERNS.some(p => p.test(line));
        if (!matchesError) continue;

        // Skip if it matches an expected pattern
        const isExpected = EXPECTED_PATTERNS.some(p => p.test(line));
        if (isExpected) continue;

        // Skip if this is an error-path scenario (errors are expected)
        if (context?.scenario?.includes('error-path')) continue;

        anomalies.push({
          type: 'output_error',
          channel,
          server_os: context?.server_os,
          server_label: context?.server_label,
          message: line.substring(0, 200),
          timestamp: this.extractTimestamp(line),
        });
      }
    }

    return anomalies;
  }

  /**
   * Strategy 4: Detect activity resource leaks.
   * Activities that were started but never completed/failed within 30s.
   */
  private detectActivityLeaks(
    data: CollectedData,
    context?: { scenario?: string; server_os?: string; server_label?: string }
  ): Anomaly[] {
    const anomalies: Anomaly[] = [];

    if (data.activitySnapshots.length === 0) return anomalies;

    // Check the final snapshot for still-running activities
    const finalSnapshot = data.activitySnapshots[data.activitySnapshots.length - 1];
    const runningAtEnd = finalSnapshot.filter(a => a.status === 'running');

    for (const activity of runningAtEnd) {
      const ageMs = data.endTime - activity.startTime.getTime();
      // Only flag if activity has been running for more than 30s
      if (ageMs > 30000) {
        anomalies.push({
          type: 'activity_leak',
          server_os: context?.server_os,
          server_label: context?.server_label,
          message: `Activity "${activity.description}" (${activity.type}) still running after ${Math.round(ageMs / 1000)}s`,
          timestamp: data.endTime,
        });
      }
    }

    return anomalies;
  }

  /**
   * Strategy 3: Detect state machine anomalies.
   */
  private detectStateAnomalies(
    data: CollectedData,
    context?: { scenario?: string; server_os?: string; server_label?: string }
  ): Anomaly[] {
    const anomalies: Anomaly[] = [];

    const stateChanges = data.stateTimeline.filter(e => e.type === 'state-change');

    // Group by connectionId
    const byConnection = new Map<string, typeof stateChanges>();
    for (const event of stateChanges) {
      const list = byConnection.get(event.connectionId) || [];
      list.push(event);
      byConnection.set(event.connectionId, list);
    }

    for (const [connId, events] of byConnection) {
      for (let i = 1; i < events.length; i++) {
        const prev = events[i - 1];
        const curr = events[i];

        // Two Connected events without Disconnected in between
        if (prev.data === 'Connected' && curr.data === 'Connected') {
          anomalies.push({
            type: 'state_anomaly',
            server_os: context?.server_os,
            server_label: context?.server_label,
            message: `Double Connected event on ${connId} without Disconnected`,
            timestamp: curr.timestamp,
          });
        }

        // Operations logged after disconnect (state events after Disconnected)
        if (prev.data === 'Disconnected' && curr.data !== 'Connecting' && curr.data !== 'Connected') {
          anomalies.push({
            type: 'state_anomaly',
            server_os: context?.server_os,
            server_label: context?.server_label,
            message: `State change to "${curr.data}" after Disconnected on ${connId}`,
            timestamp: curr.timestamp,
          });
        }
      }
    }

    return anomalies;
  }

  /**
   * Detect double-fire events or suspicious event patterns.
   */
  private detectDoubleEvents(
    data: CollectedData,
    context?: { scenario?: string; server_os?: string; server_label?: string }
  ): Anomaly[] {
    const anomalies: Anomaly[] = [];

    // Check for activity events that fire multiple times within 10ms (potential double-fire)
    const actEvents = data.stateTimeline.filter(e => e.type === 'activity-change');
    for (let i = 1; i < actEvents.length; i++) {
      const gap = actEvents[i].timestamp - actEvents[i - 1].timestamp;
      if (gap < 5 && actEvents[i].data === actEvents[i - 1].data) {
        anomalies.push({
          type: 'state_anomaly',
          server_os: context?.server_os,
          server_label: context?.server_label,
          message: `Duplicate activity event within ${gap}ms`,
          timestamp: actEvents[i].timestamp,
        });
      }
    }

    return anomalies;
  }

  /**
   * Extract timestamp from a log line like "[1234567890] message"
   */
  private extractTimestamp(line: string): number | undefined {
    const match = line.match(/^\[(\d+)\]/);
    return match ? parseInt(match[1], 10) : undefined;
  }
}
