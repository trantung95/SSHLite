/**
 * Chaos Bug Discovery Module - Invariant Validator
 *
 * Post-scenario invariant checks that verify operation contracts.
 * Every operation has a contract that must hold -- violations = bug found.
 */

import { SSHConnection } from '../connection/SSHConnection';
import { ActivityService } from '../services/ActivityService';
import { SFTPError, ConnectionState } from '../types';

export class ChaosValidator {
  private invariantsChecked = 0;
  private invariantsViolated = 0;
  private violations: string[] = [];

  /**
   * Verify writeFile contract: readFile must return exact same content.
   */
  async verifyWrite(conn: SSHConnection, remotePath: string, expectedContent: Buffer | string): Promise<void> {
    this.invariantsChecked++;
    try {
      const actual = await conn.readFile(remotePath);
      const expected = typeof expectedContent === 'string' ? Buffer.from(expectedContent) : expectedContent;
      if (!actual.equals(expected)) {
        this.invariantsViolated++;
        this.violations.push(
          `writeFile invariant: content mismatch on ${remotePath} (expected ${expected.length} bytes, got ${actual.length} bytes)`
        );
      }
    } catch (err) {
      this.invariantsViolated++;
      this.violations.push(
        `writeFile invariant: readFile failed on ${remotePath}: ${(err as Error).message}`
      );
    }
  }

  /**
   * Verify mkdir contract: listFiles on parent must include the new directory.
   */
  async verifyMkdir(conn: SSHConnection, dirPath: string, parentPath: string): Promise<void> {
    this.invariantsChecked++;
    try {
      const files = await conn.listFiles(parentPath);
      const dirName = dirPath.split('/').pop()!;
      const found = files.some(f => f.name === dirName && f.isDirectory);
      if (!found) {
        this.invariantsViolated++;
        this.violations.push(
          `mkdir invariant: ${dirName} not found in ${parentPath} listing after mkdir`
        );
      }
    } catch (err) {
      this.invariantsViolated++;
      this.violations.push(
        `mkdir invariant: listFiles failed on ${parentPath}: ${(err as Error).message}`
      );
    }
  }

  /**
   * Verify deleteFile contract: stat must throw SFTPError.
   */
  async verifyDelete(conn: SSHConnection, remotePath: string): Promise<void> {
    this.invariantsChecked++;
    try {
      await conn.stat(remotePath);
      // If stat succeeds, the file wasn't deleted
      this.invariantsViolated++;
      this.violations.push(
        `deleteFile invariant: stat succeeded on ${remotePath} after delete (file still exists)`
      );
    } catch (err) {
      // Expected: file should not exist
      if (!(err instanceof SFTPError)) {
        this.invariantsViolated++;
        this.violations.push(
          `deleteFile invariant: unexpected error type on stat after delete: ${(err as Error).constructor.name}`
        );
      }
    }
  }

  /**
   * Verify rename contract: old path throws on stat, new path succeeds.
   */
  async verifyRename(conn: SSHConnection, oldPath: string, newPath: string): Promise<void> {
    this.invariantsChecked++;

    // Old path should NOT exist
    try {
      await conn.stat(oldPath);
      this.invariantsViolated++;
      this.violations.push(
        `rename invariant: old path ${oldPath} still exists after rename`
      );
    } catch {
      // Expected
    }

    // New path SHOULD exist
    this.invariantsChecked++;
    try {
      await conn.stat(newPath);
    } catch (err) {
      this.invariantsViolated++;
      this.violations.push(
        `rename invariant: new path ${newPath} does not exist after rename: ${(err as Error).message}`
      );
    }
  }

  /**
   * Verify connection state is Connected (for non-disconnect operations).
   */
  verifyConnected(conn: SSHConnection): void {
    this.invariantsChecked++;
    if (conn.state !== ConnectionState.Connected) {
      this.invariantsViolated++;
      this.violations.push(
        `connection invariant: expected Connected, got ${conn.state} on ${conn.id}`
      );
    }
  }

  /**
   * Verify no running activities remain (resource leak check).
   */
  verifyNoRunningActivities(): void {
    this.invariantsChecked++;
    const activityService = ActivityService.getInstance();
    const running = activityService.getRunningActivities();
    if (running.length > 0) {
      this.invariantsViolated++;
      const descriptions = running.map(a => `"${a.description}" (${a.type})`).join(', ');
      this.violations.push(
        `activity leak: ${running.length} activities still running: ${descriptions}`
      );
    }
  }

  /**
   * Verify that an activity was recorded for an operation.
   */
  verifyActivityRecorded(activityService: ActivityService, beforeCount: number): void {
    this.invariantsChecked++;
    const afterCount = activityService.getAllActivities().length;
    if (afterCount <= beforeCount) {
      this.invariantsViolated++;
      this.violations.push(
        `activity tracking: no new activity recorded (before: ${beforeCount}, after: ${afterCount})`
      );
    }
  }

  /**
   * Verify search results: every returned path should be statable.
   */
  async verifySearchResults(
    conn: SSHConnection,
    results: Array<{ path: string; line?: number; preview?: string }>
  ): Promise<void> {
    for (const result of results.slice(0, 10)) { // Check first 10
      this.invariantsChecked++;
      try {
        await conn.stat(result.path);
      } catch (err) {
        this.invariantsViolated++;
        this.violations.push(
          `search invariant: returned path ${result.path} cannot be stat'd: ${(err as Error).message}`
        );
      }
    }
  }

  /**
   * Verify that an operation on a disconnected connection throws.
   */
  async verifyDisconnectedThrows(
    operation: () => Promise<any>,
    operationName: string
  ): Promise<void> {
    this.invariantsChecked++;
    try {
      await operation();
      this.invariantsViolated++;
      this.violations.push(
        `disconnect invariant: ${operationName} succeeded on disconnected connection (should throw)`
      );
    } catch {
      // Expected
    }
  }

  /**
   * Get all violations found.
   */
  getViolations(): string[] {
    return [...this.violations];
  }

  /**
   * Get statistics.
   */
  getStats(): { checked: number; violated: number } {
    return { checked: this.invariantsChecked, violated: this.invariantsViolated };
  }

  /**
   * Reset for next scenario.
   */
  reset(): void {
    this.invariantsChecked = 0;
    this.invariantsViolated = 0;
    this.violations = [];
  }
}
