/**
 * Per-Connection Preload Queue Integration Tests
 *
 * Tests cross-service interaction between PriorityQueueService and callers:
 * - Per-connection queue isolation (one server's full slots don't block another)
 * - Per-connection cancel/reset doesn't affect other servers
 * - Priority-based slot allocation per connection
 * - Concurrent task execution across multiple connections
 * - Global vs per-connection cancellation behavior
 * - Queue status reporting across connections
 * - Connection cleanup on disconnect
 */

import { PriorityQueueService, PreloadPriority } from '../services/PriorityQueueService';

function resetService(): PriorityQueueService {
  (PriorityQueueService as any).instance = undefined;
  return PriorityQueueService.getInstance();
}

describe('Integration: Per-Connection Preload Queue', () => {
  let service: PriorityQueueService;

  beforeEach(() => {
    service = resetService();
  });

  describe('multi-server independence', () => {
    it('should allow 3 servers to each run 5 CRITICAL tasks concurrently', async () => {
      const executedTasks: string[] = [];

      const promises: Promise<void>[] = [];
      for (const connId of ['server1:22:admin', 'server2:22:deploy', 'server3:2222:root']) {
        for (let i = 0; i < 5; i++) {
          promises.push(
            service.enqueue(connId, `task-${i}`, PreloadPriority.CRITICAL, async () => {
              executedTasks.push(`${connId}:${i}`);
            })
          );
        }
      }

      await Promise.all(promises);

      // All 15 tasks should have executed (5 per server, 3 servers)
      expect(executedTasks.length).toBe(15);

      // Each server should have 5 tasks
      for (const connId of ['server1:22:admin', 'server2:22:deploy', 'server3:2222:root']) {
        const serverTasks = executedTasks.filter(t => t.startsWith(connId));
        expect(serverTasks.length).toBe(5);
      }
    });

    it('should not block server2 when server1 has full slots', async () => {
      const resolvers: (() => void)[] = [];
      const server2Results: string[] = [];

      // Fill server1 with 5 long-running HIGH tasks
      for (let i = 0; i < 5; i++) {
        service.enqueue('server1', `s1-task-${i}`, PreloadPriority.HIGH, () => {
          return new Promise<void>(resolve => resolvers.push(resolve));
        });
      }

      // Wait for tasks to start
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(service.getActiveCountForConnection('server1')).toBe(5);

      // server2 should still be able to enqueue and execute
      await service.enqueue('server2', 's2-task', PreloadPriority.HIGH, async () => {
        server2Results.push('executed');
      });

      await new Promise(resolve => setTimeout(resolve, 20));
      expect(server2Results).toEqual(['executed']);

      // Clean up server1
      resolvers.forEach(r => r());
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    it('should track status independently per connection', async () => {
      // Execute tasks on 2 servers
      await service.enqueue('conn-a', 'task1', PreloadPriority.CRITICAL, async () => {});
      await service.enqueue('conn-a', 'task2', PreloadPriority.CRITICAL, async () => {});
      await service.enqueue('conn-b', 'task3', PreloadPriority.CRITICAL, async () => {});

      const statusA = service.getConnectionStatus('conn-a');
      const statusB = service.getConnectionStatus('conn-b');

      expect(statusA.completed).toBe(2);
      expect(statusB.completed).toBe(1);

      // Global status should aggregate
      const globalStatus = service.getStatus();
      expect(globalStatus.completed).toBe(3);
    });
  });

  describe('per-connection cancellation', () => {
    it('should cancel one server without affecting others', async () => {
      const executed: string[] = [];

      service.cancelConnection('server1');

      // server1 tasks should be rejected
      await service.enqueue('server1', 'blocked', PreloadPriority.HIGH, async () => {
        executed.push('server1');
      });

      // server2 tasks should execute
      await service.enqueue('server2', 'allowed', PreloadPriority.HIGH, async () => {
        executed.push('server2');
      });

      await new Promise(resolve => setTimeout(resolve, 20));

      expect(executed).toEqual(['server2']);
    });

    it('should allow CRITICAL tasks even when connection is cancelled', async () => {
      service.cancelConnection('server1');

      let criticalRan = false;
      await service.enqueue('server1', 'critical', PreloadPriority.CRITICAL, async () => {
        criticalRan = true;
      });

      expect(criticalRan).toBe(true);
    });

    it('should resume accepting tasks after resetConnection', async () => {
      service.cancelConnection('server1');

      // Task should be rejected
      let firstAttempt = false;
      await service.enqueue('server1', 'first', PreloadPriority.HIGH, async () => {
        firstAttempt = true;
      });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(firstAttempt).toBe(false);

      // Reset connection
      service.resetConnection('server1');

      // Task should now execute
      let secondAttempt = false;
      await service.enqueue('server1', 'second', PreloadPriority.HIGH, async () => {
        secondAttempt = true;
      });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(secondAttempt).toBe(true);
    });

    it('should cancelAll and affect all connections', async () => {
      service.cancelAll();

      const executed: string[] = [];

      await service.enqueue('server1', 't1', PreloadPriority.HIGH, async () => { executed.push('s1'); });
      await service.enqueue('server2', 't2', PreloadPriority.MEDIUM, async () => { executed.push('s2'); });
      await service.enqueue('server3', 't3', PreloadPriority.LOW, async () => { executed.push('s3'); });

      await new Promise(resolve => setTimeout(resolve, 20));
      expect(executed).toEqual([]);

      // isConnectionCancelled should return true for all
      expect(service.isConnectionCancelled('server1')).toBe(true);
      expect(service.isConnectionCancelled('server2')).toBe(true);
      expect(service.isConnectionCancelled('server3')).toBe(true);
    });

    it('should reset global cancel with reset()', async () => {
      service.cancelAll();
      expect(service.isCancelled()).toBe(true);

      service.reset();
      expect(service.isCancelled()).toBe(false);
      expect(service.isConnectionCancelled('server1')).toBe(false);

      let executed = false;
      await service.enqueue('server1', 'after-reset', PreloadPriority.HIGH, async () => {
        executed = true;
      });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(executed).toBe(true);
    });
  });

  describe('priority-based slot allocation per connection', () => {
    it('should respect slot limits within a single connection', async () => {
      const resolvers: (() => void)[] = [];
      const lowPriorityExecuted: boolean[] = [];

      // Fill 3 HIGH slots on server1
      for (let i = 0; i < 3; i++) {
        service.enqueue('server1', `high-${i}`, PreloadPriority.HIGH, () => {
          return new Promise<void>(resolve => resolvers.push(resolve));
        });
      }
      await new Promise(resolve => setTimeout(resolve, 20));

      // LOW priority needs 3+ available slots. With 3 active out of 5, only 2 available.
      // LOW should NOT execute yet.
      service.enqueue('server1', 'low-task', PreloadPriority.LOW, async () => {
        lowPriorityExecuted.push(true);
      });
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(lowPriorityExecuted.length).toBe(0);

      // Release 1 slot → 3 available → LOW can now run
      resolvers[0]();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(lowPriorityExecuted.length).toBe(1);

      // Clean up
      resolvers.slice(1).forEach(r => r());
      await new Promise(resolve => setTimeout(resolve, 20));
    });
  });

  describe('connection cleanup', () => {
    it('should clear all state for a connection on clearConnection', async () => {
      await service.enqueue('server1', 'task', PreloadPriority.CRITICAL, async () => {});
      service.cancelConnection('server1');

      // Before clear
      expect(service.isConnectionCancelled('server1')).toBe(true);
      expect(service.getConnectionStatus('server1').completed).toBe(1);

      // After clear
      service.clearConnection('server1');
      expect(service.isConnectionCancelled('server1')).toBe(false);
      expect(service.getConnectionStatus('server1').completed).toBe(0);
    });

    it('should not affect other connections on clearConnection', async () => {
      await service.enqueue('server1', 't1', PreloadPriority.CRITICAL, async () => {});
      await service.enqueue('server2', 't2', PreloadPriority.CRITICAL, async () => {});

      service.clearConnection('server1');

      // server2 state should be untouched
      expect(service.getConnectionStatus('server2').completed).toBe(1);
    });
  });

  describe('preload progress tracking', () => {
    it('should report preloading in progress when tasks are active', async () => {
      let resolver: (() => void) | undefined;

      expect(service.isPreloadingInProgress()).toBe(false);

      service.enqueue('server1', 'long-task', PreloadPriority.HIGH, () => {
        return new Promise<void>(resolve => { resolver = resolve; });
      });
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(service.isPreloadingInProgress()).toBe(true);

      // Complete the task
      resolver!();
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(service.isPreloadingInProgress()).toBe(false);
    });
  });
});
