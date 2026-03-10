/**
 * 全局任务队列管理器
 * 用于控制图片/视频/音频生成任务的并发数量
 */

export type TaskType = 'character' | 'scene' | 'variant' | 'storyboard' | 'video' | 'audio';

export interface Task {
  id: string;
  type: TaskType;
  targetId: string;
  projectId: string;
  episodeId?: string;
  execute: () => Promise<void>;
  onProgress?: (progress: number) => void;
  onError?: (error: string) => void;
  onComplete?: () => void;
}

export interface TaskStatus {
  taskId: string;
  type: TaskType;
  targetId: string;
  progress: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  error?: string;
}

type StatusListener = (statuses: Map<string, TaskStatus>) => void;

class TaskQueueManager {
  private maxConcurrent: number = 5;
  private maxConcurrentVideo: number = 10; // 视频生成并发数
  private queue: Task[] = [];
  private running: Map<string, Task> = new Map();
  private statuses: Map<string, TaskStatus> = new Map();
  private listeners: Set<StatusListener> = new Set();

  /**
   * 获取当前正在运行的视频任务数量
   */
  private getRunningVideoCount(): number {
    let count = 0;
    for (const task of this.running.values()) {
      if (task.type === 'video') {
        count++;
      }
    }
    return count;
  }

  /**
   * 获取当前正在运行的非视频任务数量
   */
  private getRunningNonVideoCount(): number {
    let count = 0;
    for (const task of this.running.values()) {
      if (task.type !== 'video') {
        count++;
      }
    }
    return count;
  }

  /**
   * 添加单个任务到队列
   */
  enqueue(task: Task): void {
    this.queue.push(task);

    // 初始化任务状态
    this.statuses.set(task.id, {
      taskId: task.id,
      type: task.type,
      targetId: task.targetId,
      progress: 0,
      status: 'queued'
    });

    this.notifyListeners();
    this.processQueue();
  }

  /**
   * 批量添加任务到队列
   */
  enqueueBatch(tasks: Task[]): void {
    tasks.forEach(task => {
      this.queue.push(task);

      // 初始化任务状态
      this.statuses.set(task.id, {
        taskId: task.id,
        type: task.type,
        targetId: task.targetId,
        progress: 0,
        status: 'queued'
      });
    });

    this.notifyListeners();
    this.processQueue();
  }

  /**
   * 根据目标ID获取任务状态
   */
  getStatusByTarget(targetId: string): TaskStatus | undefined {
    for (const status of this.statuses.values()) {
      if (status.targetId === targetId &&
          (status.status === 'queued' || status.status === 'running')) {
        return status;
      }
    }
    return undefined;
  }

  /**
   * 订阅状态变化
   */
  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);

    // 返回取消订阅函数
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 通知所有监听器
   */
  private notifyListeners(): void {
    this.listeners.forEach(listener => {
      listener(new Map(this.statuses));
    });
  }

  /**
   * 处理队列，启动新任务
   */
  private async processQueue(): Promise<void> {
    while (this.queue.length > 0) {
      // 检查是否还能启动新任务
      const nextTask = this.queue[0];
      if (!nextTask) break;

      let canStart = false;
      if (nextTask.type === 'video') {
        // 视频任务：检查视频并发数
        canStart = this.getRunningVideoCount() < this.maxConcurrentVideo;
      } else {
        // 非视频任务：检查总并发数
        canStart = this.getRunningNonVideoCount() < this.maxConcurrent;
      }

      if (!canStart) {
        break; // 达到并发限制，停止启动新任务
      }

      // 从队列中取出任务
      const task = this.queue.shift();
      if (!task) break;

      this.running.set(task.id, task);

      // 更新状态为运行中
      const status = this.statuses.get(task.id);
      if (status) {
        status.status = 'running';
        this.notifyListeners();
      }

      // 异步执行任务（不等待）
      this.executeTask(task);
    }
  }

  /**
   * 执行单个任务
   */
  private async executeTask(task: Task): Promise<void> {
    try {
      // 包装进度回调
      const wrappedOnProgress = (progress: number) => {
        const status = this.statuses.get(task.id);
        if (status) {
          status.progress = progress;
          this.notifyListeners();
        }

        // 调用任务自己的进度回调
        if (task.onProgress) {
          task.onProgress(progress);
        }
      };

      // 临时替换任务的进度回调
      const originalOnProgress = task.onProgress;
      task.onProgress = wrappedOnProgress;

      // 执行任务
      await task.execute();

      // 恢复原始回调
      task.onProgress = originalOnProgress;

      // 更新状态为完成
      const status = this.statuses.get(task.id);
      if (status) {
        status.status = 'completed';
        status.progress = 100;
        this.notifyListeners();
      }

      // 调用完成回调
      if (task.onComplete) {
        task.onComplete();
      }

    } catch (error) {
      // 更新状态为失败
      const status = this.statuses.get(task.id);
      if (status) {
        status.status = 'failed';
        status.error = error instanceof Error ? error.message : String(error);
        this.notifyListeners();
      }

      // 调用错误回调
      if (task.onError) {
        task.onError(error instanceof Error ? error.message : String(error));
      }

      console.error(`Task ${task.id} failed:`, error);
    } finally {
      // 从运行列表中移除
      this.running.delete(task.id);

      // 继续处理队列
      this.processQueue();
    }
  }

  /**
   * 获取当前队列状态（用于调试）
   */
  getQueueInfo(): { queued: number; running: number; total: number } {
    return {
      queued: this.queue.length,
      running: this.running.size,
      total: this.statuses.size
    };
  }

  /**
   * 清理已完成和失败的任务状态（可选，用于内存管理）
   */
  cleanup(): void {
    const toDelete: string[] = [];

    this.statuses.forEach((status, taskId) => {
      if (status.status === 'completed' || status.status === 'failed') {
        toDelete.push(taskId);
      }
    });

    toDelete.forEach(taskId => {
      this.statuses.delete(taskId);
    });

    this.notifyListeners();
  }
}

// 导出单例
export const taskQueue = new TaskQueueManager();
