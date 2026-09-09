import { randomUUID } from 'node:crypto';
import { BassfishError } from './domain.js';

export interface MentionBatch {
  notifications: Record<string, unknown>[];
  moreAvailable: boolean;
}

interface MentionTask {
  id: string;
  status: 'working' | 'completed' | 'failed' | 'cancelled';
  statusMessage: string;
  createdAt: number;
  updatedAt: number;
  discardAt: number;
  controller: AbortController;
  result?: MentionBatch;
  error?: { code: number; message: string };
  waiters: Set<() => void>;
  routeKey?: string;
}

/** Live MCP listener tasks. Message delivery is durable; these wait handles are not. */
export class MentionTaskRegistry {
  private readonly tasks = new Map<string, MentionTask>();
  private readonly activeTaskIds = new Map<string, string>();
  constructor(
    private readonly waitForBatch: (
      routeKey: string | undefined,
      signal: AbortSignal,
    ) => Promise<MentionBatch>,
    private readonly now: () => number = Date.now,
    private readonly retentionMs = 60_000,
  ) {}

  create(routeKey?: string): Record<string, unknown> {
    this.prune();
    const key = routeKey ?? '';
    const activeTaskId = this.activeTaskIds.get(key);
    const active = activeTaskId ? this.tasks.get(activeTaskId) : undefined;
    if (active?.status === 'working') return this.view(active);
    const at = this.now();
    const task: MentionTask = {
      id: `mention_${randomUUID()}`,
      status: 'working',
      statusMessage: 'Waiting for a Bassfish mention.',
      createdAt: at,
      updatedAt: at,
      discardAt: Number.POSITIVE_INFINITY,
      controller: new AbortController(),
      waiters: new Set(),
      routeKey,
    };
    this.tasks.set(task.id, task);
    this.activeTaskIds.set(key, task.id);
    void this.run(task);
    return this.view(task);
  }

  has(taskId: string): boolean {
    this.prune();
    return this.tasks.has(taskId);
  }

  get(taskId: string): Record<string, unknown> {
    this.prune();
    return this.view(this.own(taskId));
  }

  route(taskId: string): string | undefined {
    this.prune();
    return this.own(taskId).routeKey;
  }

  cancel(taskId: string): void {
    const task = this.own(taskId);
    if (task.status !== 'working') return;
    task.controller.abort();
    this.finish(task, 'cancelled', 'Mention listening was cancelled.');
  }

  async waitForUpdate(
    taskId: string,
    updatedAfter: number,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const task = this.own(taskId);
    if (task.updatedAt > updatedAfter || timeout <= 0) return this.view(task);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        task.waiters.delete(changed);
        if (error) reject(error);
        else resolve(this.view(this.own(taskId)));
      };
      const changed = () => finish();
      const abort = () => finish(new BassfishError('CANCELLED', 'Task observation was cancelled.'));
      const timer = setTimeout(changed, Math.max(0, timeout));
      timer.unref();
      task.waiters.add(changed);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  }

  stop(): void {
    for (const task of this.tasks.values()) if (task.status === 'working') this.cancel(task.id);
  }

  private async run(task: MentionTask): Promise<void> {
    try {
      const result = await this.waitForBatch(task.routeKey, task.controller.signal);
      if (task.status === 'working') {
        task.result = result;
        this.finish(
          task,
          'completed',
          `Received ${result.notifications.length} Bassfish mention notification${result.notifications.length === 1 ? '' : 's'}.`,
        );
      }
    } catch (error) {
      if (task.status !== 'working') return;
      const message = error instanceof Error ? error.message : 'Bassfish mention listening failed.';
      task.error = { code: -32603, message };
      this.finish(task, 'failed', message);
    }
  }

  private finish(task: MentionTask, status: MentionTask['status'], message: string): void {
    task.status = status;
    task.statusMessage = message;
    task.updatedAt = Math.max(this.now(), task.updatedAt + 1);
    task.discardAt = task.updatedAt + this.retentionMs;
    const routeKey = task.routeKey ?? '';
    if (this.activeTaskIds.get(routeKey) === task.id) this.activeTaskIds.delete(routeKey);
    for (const wake of task.waiters) wake();
    task.waiters.clear();
  }

  private own(taskId: string): MentionTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new BassfishError('TASK_NOT_FOUND', 'Task not found for this adapter.');
    return task;
  }

  private view(task: MentionTask): Record<string, unknown> {
    return {
      taskId: task.id,
      status: task.status,
      statusMessage: task.statusMessage,
      createdAt: new Date(task.createdAt).toISOString(),
      lastUpdatedAt: new Date(task.updatedAt).toISOString(),
      ttlMs: task.status === 'working' ? null : this.retentionMs,
      pollIntervalMs: 1_000,
      ...(task.status === 'completed' && task.result ? { result: task.result } : {}),
      ...(task.status === 'failed' && task.error ? { error: task.error } : {}),
    };
  }

  private prune(): void {
    const at = this.now();
    for (const [id, task] of this.tasks)
      if (task.status !== 'working' && at >= task.discardAt) this.tasks.delete(id);
  }
}
