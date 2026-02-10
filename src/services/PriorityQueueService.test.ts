/**
 * PriorityQueueService tests
 *
 * Tests the priority-based task queue:
 * - Priority levels and slot allocation
 * - CRITICAL tasks execute immediately
 * - Queue processing in priority order
 * - Cancel/reset operations (global + per-connection)
 * - Per-connection queue independence
 * - Connection-specific queue management
 * - Status reporting (global + per-connection)
 */

import { PriorityQueueService, PreloadPriority } from './PriorityQueueService';

function resetService(): PriorityQueueService {
  (PriorityQueueService as any).instance = undefined;
  return PriorityQueueService.getInstance();
}

describe('PriorityQueueService', () => {
  let service: PriorityQueueService;

  beforeEach(() => {
    service = resetService();
  });

  describe('getInstance', () => {
    it('should return singleton', () => {
      const a = PriorityQueueService.getInstance();
      const b = PriorityQueueService.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('executeImmediate', () => {
    it('should execute task directly without queueing', async () => {
      let executed = false;
      await service.executeImmediate(async () => {
        executed = true;
        return 'result';
      });
      expect(executed).toBe(true);
    });

    it('should return the task result', async () => {
      const result = await service.executeImmediate(async () => 42);
      expect(result).toBe(42);
    });

    it('should propagate errors', async () => {
      await expect(
        service.executeImmediate(async () => {
          throw new Error('test error');
        })
      ).rejects.toThrow('test error');
    });
  });

  describe('enqueue', () => {
    it('should execute CRITICAL tasks immediately', async () => {
      let executed = false;
      await service.enqueue('conn1', 'critical task', PreloadPriority.CRITICAL, async () => {
        executed = true;
      });
      expect(executed).toBe(true);
    });

    it('should queue non-critical tasks', async () => {
      let executed = false;
      // Enqueue HIGH priority — should execute since slots are available
      await service.enqueue('conn1', 'high task', PreloadPriority.HIGH, async () => {
        executed = true;
      });
      // Allow microtask to process
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(executed).toBe(true);
    });

    it('should not queue when globally cancelled', async () => {
      service.cancelAll();

      let executed = false;
      await service.enqueue('conn1', 'task', PreloadPriority.HIGH, async () => {
        executed = true;
      });

      // Allow processing
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(executed).toBe(false);
    });

    it('should still execute CRITICAL when cancelled', async () => {
      service.cancelAll();

      let executed = false;
      await service.enqueue('conn1', 'critical', PreloadPriority.CRITICAL, async () => {
        executed = true;
      });
      expect(executed).toBe(true);
    });

    it('should not queue when connection is cancelled', async () => {
      service.cancelConnection('conn1');

      let executed = false;
      await service.enqueue('conn1', 'task', PreloadPriority.HIGH, async () => {
        executed = true;
      });

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(executed).toBe(false);
    });

    it('should still execute CRITICAL when connection is cancelled', async () => {
      service.cancelConnection('conn1');

      let executed = false;
      await service.enqueue('conn1', 'critical', PreloadPriority.CRITICAL, async () => {
        executed = true;
      });
      expect(executed).toBe(true);
    });
  });

  describe('cancelAll', () => {
    it('should mark service as cancelled', () => {
      service.cancelAll();
      expect(service.isCancelled()).toBe(true);
    });

    it('should clear all queues', () => {
      service.cancelAll();
      const status = service.getStatus();
      expect(status.queued).toBe(0);
    });
  });

  describe('cancelConnection', () => {
    it('should cancel only the specified connection', async () => {
      service.cancelConnection('conn1');

      expect(service.isConnectionCancelled('conn1')).toBe(true);
      expect(service.isConnectionCancelled('conn2')).toBe(false);
    });

    it('should not affect other connections tasks', async () => {
      service.cancelConnection('conn1');

      let conn1Executed = false;
      let conn2Executed = false;

      await service.enqueue('conn1', 'task', PreloadPriority.HIGH, async () => {
        conn1Executed = true;
      });
      await service.enqueue('conn2', 'task', PreloadPriority.HIGH, async () => {
        conn2Executed = true;
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(conn1Executed).toBe(false);
      expect(conn2Executed).toBe(true);
    });

    it('should clear queued tasks for the connection', () => {
      service.cancelConnection('conn1');
      const status = service.getConnectionStatus('conn1');
      expect(status.queued).toBe(0);
    });
  });

  describe('reset', () => {
    it('should clear cancelled state', () => {
      service.cancelAll();
      expect(service.isCancelled()).toBe(true);

      service.reset();
      expect(service.isCancelled()).toBe(false);
    });

    it('should reset counters', () => {
      service.reset();
      const status = service.getStatus();
      expect(status.completed).toBe(0);
      expect(status.total).toBe(0);
    });

    it('should clear per-connection cancelled state', () => {
      service.cancelConnection('conn1');
      expect(service.isConnectionCancelled('conn1')).toBe(true);

      service.reset();
      expect(service.isConnectionCancelled('conn1')).toBe(false);
    });
  });

  describe('resetConnection', () => {
    it('should clear cancelled state for one connection', () => {
      service.cancelConnection('conn1');
      service.cancelConnection('conn2');

      service.resetConnection('conn1');

      expect(service.isConnectionCancelled('conn1')).toBe(false);
      expect(service.isConnectionCancelled('conn2')).toBe(true);
    });

    it('should reset counters for one connection only', async () => {
      await service.enqueue('conn1', 'task', PreloadPriority.CRITICAL, async () => {});
      await service.enqueue('conn2', 'task', PreloadPriority.CRITICAL, async () => {});

      service.resetConnection('conn1');

      const conn1Status = service.getConnectionStatus('conn1');
      expect(conn1Status.completed).toBe(0);
      expect(conn1Status.total).toBe(0);

      const conn2Status = service.getConnectionStatus('conn2');
      expect(conn2Status.completed).toBe(1);
    });

    it('should allow new tasks after reset', async () => {
      service.cancelConnection('conn1');

      let executed = false;
      await service.enqueue('conn1', 'task', PreloadPriority.HIGH, async () => {
        executed = true;
      });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(executed).toBe(false);

      service.resetConnection('conn1');

      await service.enqueue('conn1', 'task2', PreloadPriority.HIGH, async () => {
        executed = true;
      });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(executed).toBe(true);
    });
  });

  describe('isConnectionCancelled', () => {
    it('should return false by default', () => {
      expect(service.isConnectionCancelled('conn1')).toBe(false);
    });

    it('should return true when connection is cancelled', () => {
      service.cancelConnection('conn1');
      expect(service.isConnectionCancelled('conn1')).toBe(true);
    });

    it('should return true when globally cancelled', () => {
      service.cancelAll();
      expect(service.isConnectionCancelled('conn1')).toBe(true);
      expect(service.isConnectionCancelled('conn2')).toBe(true);
    });
  });

  describe('getStatus', () => {
    it('should return initial status', () => {
      const status = service.getStatus();
      expect(status.active).toBe(0);
      expect(status.queued).toBe(0);
      expect(status.completed).toBe(0);
    });

    it('should track completed tasks', async () => {
      await service.enqueue('conn1', 'task', PreloadPriority.CRITICAL, async () => {});

      const status = service.getStatus();
      expect(status.completed).toBe(1);
    });

    it('should report by priority', () => {
      const status = service.getStatus();
      expect(status.byPriority).toBeDefined();
      expect(status.byPriority[PreloadPriority.CRITICAL]).toBe(0);
      expect(status.byPriority[PreloadPriority.HIGH]).toBe(0);
    });

    it('should aggregate across all connections', async () => {
      await service.enqueue('conn1', 'task1', PreloadPriority.CRITICAL, async () => {});
      await service.enqueue('conn2', 'task2', PreloadPriority.CRITICAL, async () => {});
      await service.enqueue('conn3', 'task3', PreloadPriority.CRITICAL, async () => {});

      const status = service.getStatus();
      expect(status.completed).toBe(3);
    });
  });

  describe('getConnectionStatus', () => {
    it('should return zero status for unknown connection', () => {
      const status = service.getConnectionStatus('unknown');
      expect(status.active).toBe(0);
      expect(status.queued).toBe(0);
      expect(status.completed).toBe(0);
      expect(status.total).toBe(0);
    });

    it('should track per-connection completed tasks', async () => {
      await service.enqueue('conn1', 'task1', PreloadPriority.CRITICAL, async () => {});
      await service.enqueue('conn1', 'task2', PreloadPriority.CRITICAL, async () => {});
      await service.enqueue('conn2', 'task3', PreloadPriority.CRITICAL, async () => {});

      const conn1Status = service.getConnectionStatus('conn1');
      expect(conn1Status.completed).toBe(2);

      const conn2Status = service.getConnectionStatus('conn2');
      expect(conn2Status.completed).toBe(1);
    });
  });

  describe('clearConnection', () => {
    it('should remove queued tasks for a specific connection', () => {
      // Just verify no errors
      service.clearConnection('conn1');
    });

    it('should clear all state for a connection', async () => {
      await service.enqueue('conn1', 'task', PreloadPriority.CRITICAL, async () => {});
      service.cancelConnection('conn1');

      service.clearConnection('conn1');

      // After clear, connection is no longer cancelled
      expect(service.isConnectionCancelled('conn1')).toBe(false);
      const status = service.getConnectionStatus('conn1');
      expect(status.completed).toBe(0);
      expect(status.total).toBe(0);
    });

    it('should not affect other connections', async () => {
      await service.enqueue('conn1', 'task1', PreloadPriority.CRITICAL, async () => {});
      await service.enqueue('conn2', 'task2', PreloadPriority.CRITICAL, async () => {});

      service.clearConnection('conn1');

      const conn2Status = service.getConnectionStatus('conn2');
      expect(conn2Status.completed).toBe(1);
    });
  });

  describe('getActiveCountForConnection', () => {
    it('should return 0 for unknown connection', () => {
      expect(service.getActiveCountForConnection('unknown')).toBe(0);
    });
  });

  describe('getActiveCount', () => {
    it('should return 0 initially', () => {
      expect(service.getActiveCount()).toBe(0);
    });
  });

  describe('isPreloadingInProgress', () => {
    it('should return false when idle', () => {
      expect(service.isPreloadingInProgress()).toBe(false);
    });
  });

  describe('getPriorityName', () => {
    it('should return correct names', () => {
      expect(PriorityQueueService.getPriorityName(PreloadPriority.CRITICAL)).toBe('Critical');
      expect(PriorityQueueService.getPriorityName(PreloadPriority.HIGH)).toBe('High');
      expect(PriorityQueueService.getPriorityName(PreloadPriority.MEDIUM)).toBe('Medium');
      expect(PriorityQueueService.getPriorityName(PreloadPriority.LOW)).toBe('Low');
      expect(PriorityQueueService.getPriorityName(PreloadPriority.IDLE)).toBe('Idle');
    });

    it('should return Unknown for invalid priority', () => {
      expect(PriorityQueueService.getPriorityName(99 as any)).toBe('Unknown');
    });
  });

  describe('PreloadPriority enum', () => {
    it('should have correct numeric values (lower = higher priority)', () => {
      expect(PreloadPriority.CRITICAL).toBe(0);
      expect(PreloadPriority.HIGH).toBe(1);
      expect(PreloadPriority.MEDIUM).toBe(2);
      expect(PreloadPriority.LOW).toBe(3);
      expect(PreloadPriority.IDLE).toBe(4);
    });
  });

  describe('per-connection queue independence', () => {
    it('should execute tasks from different connections independently', async () => {
      const executed: string[] = [];

      await service.enqueue('conn1', 'task1', PreloadPriority.CRITICAL, async () => {
        executed.push('conn1');
      });
      await service.enqueue('conn2', 'task2', PreloadPriority.CRITICAL, async () => {
        executed.push('conn2');
      });

      expect(executed).toEqual(['conn1', 'conn2']);
    });

    it('should track active tasks per connection independently', async () => {
      expect(service.getActiveCountForConnection('conn1')).toBe(0);
      expect(service.getActiveCountForConnection('conn2')).toBe(0);
      expect(service.getActiveCountForConnection('conn3')).toBe(0);
    });

    it('conn1 full slots should NOT block conn2', async () => {
      const resolvers: (() => void)[] = [];

      // Fill conn1 with 5 long-running tasks (maxSlotsPerConnection = 5)
      for (let i = 0; i < 5; i++) {
        service.enqueue('conn1', `conn1-task${i}`, PreloadPriority.HIGH, () => {
          return new Promise<void>(resolve => resolvers.push(resolve));
        });
      }
      // Allow all to start
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(service.getActiveCountForConnection('conn1')).toBe(5);

      // conn2 should still be able to run tasks
      let conn2Executed = false;
      await service.enqueue('conn2', 'conn2-task', PreloadPriority.HIGH, async () => {
        conn2Executed = true;
      });
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(conn2Executed).toBe(true);

      // Cleanup: resolve conn1 tasks
      resolvers.forEach(r => r());
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    it('should cancel per-connection without affecting others', async () => {
      service.cancelConnection('conn1');

      let conn1Executed = false;
      let conn2Executed = false;

      await service.enqueue('conn1', 'task', PreloadPriority.HIGH, async () => {
        conn1Executed = true;
      });
      await service.enqueue('conn2', 'task', PreloadPriority.HIGH, async () => {
        conn2Executed = true;
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(conn1Executed).toBe(false);
      expect(conn2Executed).toBe(true);
    });

    it('should track status across multiple connections', async () => {
      await service.enqueue('conn1', 'task1', PreloadPriority.CRITICAL, async () => {});
      await service.enqueue('conn2', 'task2', PreloadPriority.CRITICAL, async () => {});
      await service.enqueue('conn3', 'task3', PreloadPriority.CRITICAL, async () => {});

      const status = service.getStatus();
      expect(status.completed).toBe(3);
    });

    it('should cancel all non-critical tasks from all connections', async () => {
      service.cancelAll();

      let conn1Executed = false;
      let conn2Executed = false;

      await service.enqueue('conn1', 'task', PreloadPriority.HIGH, async () => {
        conn1Executed = true;
      });
      await service.enqueue('conn2', 'task', PreloadPriority.LOW, async () => {
        conn2Executed = true;
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(conn1Executed).toBe(false);
      expect(conn2Executed).toBe(false);
    });

    it('should clear tasks for specific connection without affecting others', () => {
      service.clearConnection('conn1');
      // conn2 tasks are unaffected (verify no errors)
      service.clearConnection('conn2');
    });
  });
});
