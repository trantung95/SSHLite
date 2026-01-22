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
 *
 * Slot Allocation Strategy:
 * - Total slots controlled by sshLite.maxPreloadingConcurrency (default: 5)
 * - CRITICAL (0): Always gets a slot, even if over limit
 * - HIGH (1): Gets up to 2 slots when available
 * - MEDIUM (2): Gets up to 1 slot when >= 2 slots available
 * - LOW (3): Gets up to 1 slot when >= 3 slots available
 * - IDLE (4): Gets up to 1 slot when >= 4 slots available
 */
export class PriorityQueueService {
  private static instance: PriorityQueueService | undefined;

  // Priority queues (Map of priority -> array of tasks)
  private queues: Map<PreloadPriority, QueueTask[]> = new Map();

  // Active task tracking
  private activeTasks: Map<string, QueueTask> = new Map(); // taskId -> task
  private activeByConnection: Map<string, Set<string>> = new Map(); // connectionId -> Set of taskIds

  // Configuration
  private maxTotalSlots: number = 5;

  // State
  private cancelled: boolean = false;
  private completedCount: number = 0;
  private totalQueued: number = 0;

  // Processing flag to prevent concurrent queue processing
  private isProcessing: boolean = false;

  private constructor() {
    // Initialize queues for each priority level
    for (const priority of [
      PreloadPriority.CRITICAL,
      PreloadPriority.HIGH,
      PreloadPriority.MEDIUM,
      PreloadPriority.LOW,
      PreloadPriority.IDLE,
    ]) {
      this.queues.set(priority, []);
    }

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
    this.maxTotalSlots = config.get<number>('maxPreloadingConcurrency', 5);
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
    // If cancelled and not critical, reject immediately
    if (this.cancelled && priority !== PreloadPriority.CRITICAL) {
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

    // Add to appropriate queue
    const queue = this.queues.get(priority)!;
    queue.push(task);
    this.totalQueued++;

    // Try to process queue
    this.processQueue();
  }

  /**
   * Process the queue - runs tasks based on priority and available slots
   */
  private async processQueue(): Promise<void> {
    // Prevent concurrent processing
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (true) {
        const task = this.getNextTask();
        if (!task) break;

        // Execute task (don't await - allow parallel execution)
        this.executeTask(task).catch(() => {
          /* Silently ignore errors in preload tasks */
        });
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Get the next task to execute based on priority and slot availability
   */
  private getNextTask(): QueueTask | undefined {
    const activeCount = this.activeTasks.size;

    // Process queues in priority order
    for (const priority of [
      PreloadPriority.CRITICAL,
      PreloadPriority.HIGH,
      PreloadPriority.MEDIUM,
      PreloadPriority.LOW,
      PreloadPriority.IDLE,
    ]) {
      // Check slot availability for this priority
      if (!this.canRunAtPriority(priority, activeCount)) {
        continue;
      }

      const queue = this.queues.get(priority)!;
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

    // Check total slot limit
    if (activeCount >= this.maxTotalSlots) return false;

    // Priority-based slot allocation
    const availableSlots = this.maxTotalSlots - activeCount;

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
      this.completedCount++;
    } finally {
      // Release slot
      this.activeTasks.delete(task.id);
      connectionTasks?.delete(task.id);
      if (connectionTasks?.size === 0) {
        this.activeByConnection.delete(task.connectionId);
      }

      // Process more tasks after completion
      this.processQueue();
    }
  }

  /**
   * Cancel all pending preload tasks (except CRITICAL)
   */
  public cancelAll(): void {
    this.cancelled = true;

    // Clear all queues except critical
    for (const [priority, queue] of this.queues.entries()) {
      if (priority !== PreloadPriority.CRITICAL) {
        queue.length = 0;
      }
    }

    this.totalQueued = 0;
  }

  /**
   * Reset cancelled state and counters (for new preload sessions)
   */
  public reset(): void {
    this.cancelled = false;
    this.completedCount = 0;
    this.totalQueued = 0;
  }

  /**
   * Check if cancelled
   */
  public isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * Get queue status for UI display
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

    for (const [priority, queue] of this.queues.entries()) {
      byPriority[priority] = queue.length;
      totalQueued += queue.length;
    }

    return {
      active: this.activeTasks.size,
      queued: totalQueued,
      completed: this.completedCount,
      total: this.totalQueued,
      byPriority,
    };
  }

  /**
   * Clear queue for a specific connection
   */
  public clearConnection(connectionId: string): void {
    for (const queue of this.queues.values()) {
      // Remove tasks for this connection
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].connectionId === connectionId) {
          queue.splice(i, 1);
        }
      }
    }
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
   * Check if preloading is in progress
   */
  public isPreloadingInProgress(): boolean {
    if (this.activeTasks.size > 0) return true;

    for (const queue of this.queues.values()) {
      if (queue.length > 0) return true;
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
