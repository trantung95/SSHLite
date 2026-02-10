import * as vscode from 'vscode';

/**
 * Priority levels for preload operations
 * Lower number = higher priority
 * Priority 0 (CRITICAL) always gets a connection slot immediately
 */
export enum PreloadPriority {
  /** Highest priority - always executes immediately (user-triggered actions like search, open file) */
  CRITICAL = 0,
  /** High priority - user-visible operations (parent folder, current directory) */
  HIGH = 1,
  /** Medium priority - frequent folders/files from history */
  MEDIUM = 2,
  /** Low priority - background preloading of subdirectories */
  LOW = 3,
  /** Lowest priority - speculative preloading */
  IDLE = 4,
}

/**
 * Task in the priority queue
 */
interface QueueTask {
  id: string;
  priority: PreloadPriority;
  execute: () => Promise<void>;
  connectionId: string;
  description: string;
  createdAt: number;
}

/**
 * Priority Queue Service for managing preload operations
 *
 * Design Principles:
 * 1. Lower priority number = higher priority
 * 2. Priority 0 (CRITICAL) ALWAYS executes immediately - never waits
 * 3. Higher priorities get more connection slots
 * 4. Non-preload actions (user interactions) use executeImmediate() and bypass the queue
 * 5. Queue is processed in priority order when slots become available
 * 6. Each server (connectionId) gets its own independent queue with its own slot allocation
 *
 * Slot Allocation Strategy (per server):
 * - Slots per server controlled by sshLite.maxPreloadingConcurrency (default: 5)
 * - CRITICAL (0): Always gets a slot, even if over limit
 * - HIGH (1): Gets up to 2 slots when available
 * - MEDIUM (2): Gets up to 1 slot when >= 2 slots available
 * - LOW (3): Gets up to 1 slot when >= 3 slots available
 * - IDLE (4): Gets up to 1 slot when >= 4 slots available
 */
export class PriorityQueueService {
  private static instance: PriorityQueueService | undefined;

  // Per-connection priority queues: connectionId -> (priority -> tasks[])
  private connectionQueues: Map<string, Map<PreloadPriority, QueueTask[]>> = new Map();

  // Active task tracking
  private activeTasks: Map<string, QueueTask> = new Map(); // taskId -> task
  private activeByConnection: Map<string, Set<string>> = new Map(); // connectionId -> Set of taskIds

  // Configuration
  private maxSlotsPerConnection: number = 5;

  // Per-connection state
  private cancelledConnections: Set<string> = new Set();
  private cancelledAll: boolean = false;
  private completedByConnection: Map<string, number> = new Map();
  private totalQueuedByConnection: Map<string, number> = new Map();

  // Per-connection processing flag to prevent concurrent queue processing
  private processingConnections: Set<string> = new Set();

  private static readonly PRIORITY_ORDER = [
    PreloadPriority.CRITICAL,
    PreloadPriority.HIGH,
    PreloadPriority.MEDIUM,
    PreloadPriority.LOW,
    PreloadPriority.IDLE,
  ];

  private constructor() {
    // Load config
    this.updateConfig();

    // Listen for config changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sshLite.maxPreloadingConcurrency')) {
        this.updateConfig();
      }
    });
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): PriorityQueueService {
    if (!PriorityQueueService.instance) {
      PriorityQueueService.instance = new PriorityQueueService();
    }
    return PriorityQueueService.instance;
  }

  /**
   * Update configuration from settings
   */
  private updateConfig(): void {
    const config = vscode.workspace.getConfiguration('sshLite');
    this.maxSlotsPerConnection = config.get<number>('maxPreloadingConcurrency', 5);
  }

  /**
   * Get or create per-connection priority queues
   */
  private getOrCreateConnectionQueue(connectionId: string): Map<PreloadPriority, QueueTask[]> {
    let connQueue = this.connectionQueues.get(connectionId);
    if (!connQueue) {
      connQueue = new Map();
      for (const priority of PriorityQueueService.PRIORITY_ORDER) {
        connQueue.set(priority, []);
      }
      this.connectionQueues.set(connectionId, connQueue);
    }
    return connQueue;
  }

  /**
   * Execute an action IMMEDIATELY - bypasses the queue entirely
   * Use this for user-triggered actions that should NEVER wait
   * Examples: opening a file, searching, navigating to a folder
   */
  public async executeImmediate<T>(execute: () => Promise<T>): Promise<T> {
    // Direct execution - no queueing, no slot limits
    return execute();
  }

  /**
   * Enqueue a preload task with priority
   * Returns a promise that resolves when the task completes
   *
   * @param connectionId - Connection ID for the task
   * @param description - Human-readable description for debugging
   * @param priority - Task priority (lower = higher priority)
   * @param execute - The async function to execute
   */
  public async enqueue(
    connectionId: string,
    description: string,
    priority: PreloadPriority,
    execute: () => Promise<void>
  ): Promise<void> {
    // If cancelled (globally or per-connection) and not critical, reject immediately
    if ((this.cancelledAll || this.cancelledConnections.has(connectionId)) && priority !== PreloadPriority.CRITICAL) {
      return;
    }

    const taskId = `${connectionId}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;

    const task: QueueTask = {
      id: taskId,
      priority,
      execute,
      connectionId,
      description,
      createdAt: Date.now(),
    };

    // CRITICAL priority (0) executes immediately without queueing
    if (priority === PreloadPriority.CRITICAL) {
      await this.executeTask(task);
      return;
    }

    // Add to per-connection queue
    const connQueue = this.getOrCreateConnectionQueue(connectionId);
    connQueue.get(priority)!.push(task);
    this.totalQueuedByConnection.set(connectionId, (this.totalQueuedByConnection.get(connectionId) || 0) + 1);

    // Try to process this connection's queue
    this.processConnectionQueue(connectionId);
  }

  /**
   * Process the queue for a specific connection
   */
  private async processConnectionQueue(connectionId: string): Promise<void> {
    // Prevent concurrent processing for same connection
    if (this.processingConnections.has(connectionId)) return;
    this.processingConnections.add(connectionId);

    try {
      const connQueue = this.connectionQueues.get(connectionId);
      if (!connQueue) return;

      while (true) {
        const task = this.getNextTaskForConnection(connectionId, connQueue);
        if (!task) break;

        // Execute task (don't await - allow parallel execution)
        this.executeTask(task).catch(() => {
          /* Silently ignore errors in preload tasks */
        });
      }
    } finally {
      this.processingConnections.delete(connectionId);
    }
  }

  /**
   * Get the next task to execute for a connection based on priority and slot availability
   */
  private getNextTaskForConnection(connectionId: string, connQueue: Map<PreloadPriority, QueueTask[]>): QueueTask | undefined {
    const activeCount = this.activeByConnection.get(connectionId)?.size || 0;

    // Process queues in priority order
    for (const priority of PriorityQueueService.PRIORITY_ORDER) {
      // Check slot availability for this priority (per-connection)
      if (!this.canRunAtPriority(priority, activeCount)) {
        continue;
      }

      const queue = connQueue.get(priority)!;
      if (queue.length > 0) {
        return queue.shift();
      }
    }

    return undefined;
  }

  /**
   * Check if we can run a task at the given priority level
   */
  private canRunAtPriority(priority: PreloadPriority, activeCount: number): boolean {
    // CRITICAL always runs
    if (priority === PreloadPriority.CRITICAL) return true;

    // Check per-connection slot limit
    if (activeCount >= this.maxSlotsPerConnection) return false;

    // Priority-based slot allocation
    const availableSlots = this.maxSlotsPerConnection - activeCount;

    switch (priority) {
      case PreloadPriority.HIGH:
        return availableSlots >= 1; // HIGH runs if any slot available
      case PreloadPriority.MEDIUM:
        return availableSlots >= 2; // MEDIUM needs 2+ slots available
      case PreloadPriority.LOW:
        return availableSlots >= 3; // LOW needs 3+ slots available
      case PreloadPriority.IDLE:
        return availableSlots >= 4; // IDLE needs 4+ slots available
      default:
        return false;
    }
  }

  /**
   * Execute a task
   */
  private async executeTask(task: QueueTask): Promise<void> {
    // Track active task
    this.activeTasks.set(task.id, task);

    let connectionTasks = this.activeByConnection.get(task.connectionId);
    if (!connectionTasks) {
      connectionTasks = new Set();
      this.activeByConnection.set(task.connectionId, connectionTasks);
    }
    connectionTasks.add(task.id);

    try {
      await task.execute();
      this.completedByConnection.set(
        task.connectionId,
        (this.completedByConnection.get(task.connectionId) || 0) + 1
      );
    } finally {
      // Release slot
      this.activeTasks.delete(task.id);
      connectionTasks?.delete(task.id);
      if (connectionTasks?.size === 0) {
        this.activeByConnection.delete(task.connectionId);
      }

      // Process more tasks for this connection after completion
      this.processConnectionQueue(task.connectionId);
    }
  }

  /**
   * Cancel all pending preload tasks across all connections (except CRITICAL)
   */
  public cancelAll(): void {
    this.cancelledAll = true;

    // Clear all per-connection queues except critical
    for (const connQueue of this.connectionQueues.values()) {
      for (const [priority, queue] of connQueue.entries()) {
        if (priority !== PreloadPriority.CRITICAL) {
          queue.length = 0;
        }
      }
    }

    for (const connectionId of this.totalQueuedByConnection.keys()) {
      this.totalQueuedByConnection.set(connectionId, 0);
    }
  }

  /**
   * Cancel pending preload tasks for a specific connection (except CRITICAL)
   */
  public cancelConnection(connectionId: string): void {
    this.cancelledConnections.add(connectionId);

    const connQueue = this.connectionQueues.get(connectionId);
    if (connQueue) {
      for (const [priority, queue] of connQueue.entries()) {
        if (priority !== PreloadPriority.CRITICAL) {
          queue.length = 0;
        }
      }
    }
    this.totalQueuedByConnection.set(connectionId, 0);
  }

  /**
   * Reset cancelled state and counters globally (for new preload sessions)
   */
  public reset(): void {
    this.cancelledAll = false;
    this.cancelledConnections.clear();
    this.completedByConnection.clear();
    this.totalQueuedByConnection.clear();
  }

  /**
   * Reset cancelled state and counters for a specific connection
   */
  public resetConnection(connectionId: string): void {
    this.cancelledConnections.delete(connectionId);
    this.completedByConnection.delete(connectionId);
    this.totalQueuedByConnection.delete(connectionId);
  }

  /**
   * Check if globally cancelled
   */
  public isCancelled(): boolean {
    return this.cancelledAll;
  }

  /**
   * Check if a specific connection is cancelled (globally or per-connection)
   */
  public isConnectionCancelled(connectionId: string): boolean {
    return this.cancelledAll || this.cancelledConnections.has(connectionId);
  }

  /**
   * Get aggregated queue status for UI display (backward compatible)
   */
  public getStatus(): {
    active: number;
    queued: number;
    completed: number;
    total: number;
    byPriority: { [key: number]: number };
  } {
    const byPriority: { [key: number]: number } = {};
    let totalQueued = 0;

    for (const connQueue of this.connectionQueues.values()) {
      for (const [priority, queue] of connQueue.entries()) {
        byPriority[priority] = (byPriority[priority] || 0) + queue.length;
        totalQueued += queue.length;
      }
    }

    // Initialize any missing priorities
    for (const priority of PriorityQueueService.PRIORITY_ORDER) {
      if (!(priority in byPriority)) {
        byPriority[priority] = 0;
      }
    }

    let completed = 0;
    for (const c of this.completedByConnection.values()) completed += c;
    let total = 0;
    for (const t of this.totalQueuedByConnection.values()) total += t;

    return {
      active: this.activeTasks.size,
      queued: totalQueued,
      completed,
      total,
      byPriority,
    };
  }

  /**
   * Get status for a specific connection
   */
  public getConnectionStatus(connectionId: string): {
    active: number;
    queued: number;
    completed: number;
    total: number;
  } {
    const activeCount = this.activeByConnection.get(connectionId)?.size || 0;
    let queued = 0;
    const connQueue = this.connectionQueues.get(connectionId);
    if (connQueue) {
      for (const queue of connQueue.values()) queued += queue.length;
    }
    return {
      active: activeCount,
      queued,
      completed: this.completedByConnection.get(connectionId) || 0,
      total: this.totalQueuedByConnection.get(connectionId) || 0,
    };
  }

  /**
   * Clear queue and all state for a specific connection (e.g., on disconnect)
   */
  public clearConnection(connectionId: string): void {
    this.connectionQueues.delete(connectionId);
    this.cancelledConnections.delete(connectionId);
    this.completedByConnection.delete(connectionId);
    this.totalQueuedByConnection.delete(connectionId);
    this.processingConnections.delete(connectionId);
  }

  /**
   * Get active task count for a connection
   */
  public getActiveCountForConnection(connectionId: string): number {
    return this.activeByConnection.get(connectionId)?.size || 0;
  }

  /**
   * Get total active task count
   */
  public getActiveCount(): number {
    return this.activeTasks.size;
  }

  /**
   * Check if preloading is in progress (any connection)
   */
  public isPreloadingInProgress(): boolean {
    if (this.activeTasks.size > 0) return true;

    for (const connQueue of this.connectionQueues.values()) {
      for (const queue of connQueue.values()) {
        if (queue.length > 0) return true;
      }
    }

    return false;
  }

  /**
   * Get priority name for display
   */
  public static getPriorityName(priority: PreloadPriority): string {
    switch (priority) {
      case PreloadPriority.CRITICAL:
        return 'Critical';
      case PreloadPriority.HIGH:
        return 'High';
      case PreloadPriority.MEDIUM:
        return 'Medium';
      case PreloadPriority.LOW:
        return 'Low';
      case PreloadPriority.IDLE:
        return 'Idle';
      default:
        return 'Unknown';
    }
  }
}
