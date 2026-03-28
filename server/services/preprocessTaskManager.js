import fs from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { PREPROCESS_SEGMENT_CONCURRENCY, mapWithConcurrencyLimit } from '../../utils/segmentConcurrency.js';
import {
  analyzeNovelScriptWithClaudeServer,
  getAvailableClaudeProviders,
  segmentEpisodeWithClaudeServer,
} from './claudeClient.js';
import { getDatabase, saveDatabase } from '../db/index.js';
import { recordProjectTextUsage } from './projectStats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASKS_FILE = process.env.PREPROCESS_TASKS_PATH || join(__dirname, '../../data/preprocess-tasks.json');
const TASK_HISTORY_LIMIT = 100;
const TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 300;

export function recordPreprocessTaskUsage({ project, projectId, taskType, sourceId, operationId, result, now = Date.now() }) {
  if (!project || project.id !== projectId) {
    return false;
  }

  if (!taskType || !sourceId || !operationId || !result?.provider || !result?.model || !result?.usage) {
    return false;
  }

  return recordProjectTextUsage(project, {
    provider: 'claude',
    model: result.model,
    taskType,
    idempotencyKey: `${projectId}:${taskType}:${sourceId}:${operationId}`,
    usage: result.usage,
    now,
  });
}

class PreprocessTaskManager {
  constructor() {
    this.tasks = new Map();
    this.persistTimer = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    await fs.mkdir(dirname(TASKS_FILE), { recursive: true });

    let loadedTasks = [];
    try {
      const raw = await fs.readFile(TASKS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      loadedTasks = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('[preprocess-task-manager] 读取任务持久化文件失败:', error.message);
      }
    }

    const now = Date.now();
    for (const task of loadedTasks) {
      if (!task?.id) continue;
      if (now - (task.updatedAt || task.createdAt || now) > TASK_RETENTION_MS) continue;

      const nextTask = { ...task };
      if (nextTask.status === 'pending' || nextTask.status === 'running') {
        nextTask.status = 'interrupted';
        nextTask.stage = 'interrupted';
        nextTask.error = '服务重启中断，请重试';
        nextTask.updatedAt = now;
        nextTask.completedAt = now;
      }
      this.tasks.set(nextTask.id, nextTask);
    }

    await this.persist();
    this.initialized = true;
  }

  createBaseTask(partial) {
    const now = Date.now();
    return {
      id: uuidv4(),
      status: 'pending',
      stage: 'connectivity',
      createdAt: now,
      updatedAt: now,
      progress: {
        total: 0,
        completed: 0,
        currentEpisodeName: undefined,
        assetExtractionDone: false,
        secondPassCompleted: 0,
      },
      requestSummary: {},
      results: {
        availableProviders: [],
      },
      ...partial,
    };
  }

  async createNovelTask(payload) {
    const task = this.createBaseTask({
      type: 'novel',
      projectId: payload.projectId,
      input: {
        episodeDrafts: payload.episodeDrafts,
      },
      requestSummary: {
        projectType: payload.projectType,
        episodeCount: payload.episodeDrafts.length,
        enableSecondPass: Boolean(payload.enableSecondPass && payload.secondPassPrompt?.trim()),
      },
      progress: {
        total: payload.episodeDrafts.length,
        completed: 0,
        currentEpisodeName: undefined,
        assetExtractionDone: false,
        secondPassCompleted: 0,
      },
    });

    this.tasks.set(task.id, task);
    this.schedulePersist();
    void this.runNovelTask(task.id, payload);
    return task;
  }

  async createEpisodeTask(payload) {
    const task = this.createBaseTask({
      type: 'episode',
      projectId: payload.projectId,
      episodeId: payload.episodeId,
      episodeName: payload.episodeName,
      input: {
        episodeId: payload.episodeId,
        episodeName: payload.episodeName,
        originalContent: payload.content,
      },
      requestSummary: {
        enableSecondPass: Boolean(payload.enableSecondPass && payload.secondPassPrompt?.trim()),
      },
      progress: {
        total: 1,
        completed: 0,
        currentEpisodeName: payload.episodeName,
        assetExtractionDone: true,
        secondPassCompleted: 0,
      },
    });

    this.tasks.set(task.id, task);
    this.schedulePersist();
    void this.runEpisodeTask(task.id, payload);
    return task;
  }

  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  listTasks(projectId) {
    return Array.from(this.tasks.values())
      .filter(task => !projectId || task.projectId === projectId)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async markTaskApplied(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error('任务不存在');
    }
    task.resultAppliedAt = Date.now();
    task.updatedAt = Date.now();
    this.schedulePersist();
    return task;
  }

  async deleteTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === 'pending' || task.status === 'running') {
      throw new Error('运行中的任务不能删除');
    }
    this.tasks.delete(taskId);
    this.schedulePersist();
    return true;
  }

  updateTask(taskId, patch) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('任务不存在');

    Object.assign(task, patch, { updatedAt: Date.now() });
    this.schedulePersist();
    return task;
  }

  mergeTask(taskId, updater) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('任务不存在');

    updater(task);
    task.updatedAt = Date.now();
    this.schedulePersist();
    return task;
  }

  async recordTaskUsage(projectId, taskType, sourceId, operationId, result) {
    const project = getDatabase().data.projects.find(item => item.id === projectId);
    if (!project) {
      return false;
    }

    const recorded = recordPreprocessTaskUsage({
      project,
      projectId,
      taskType,
      sourceId,
      operationId,
      result,
      now: Date.now(),
    });

    if (recorded) {
      project.updatedAt = Date.now();
      await saveDatabase();
    }

    return recorded;
  }

  async runNovelTask(taskId, payload) {
    try {
      this.updateTask(taskId, { status: 'running', stage: 'connectivity' });

      const { availableProviders, checks } = await getAvailableClaudeProviders();
      if (availableProviders.length === 0) {
        throw new Error(`三个 Claude API 均不可用，无法执行预处理：\n\n• 柏拉图中转: ${checks.bltcy.error}\n• CC580: ${checks.cc580.error}\n• Univibe: ${checks.univibe.error}`);
      }

      this.mergeTask(taskId, task => {
        task.results.availableProviders = availableProviders;
      });

      const textForAssets = payload.novelText.slice(0, 8000);
      this.updateTask(taskId, { stage: 'asset_extraction' });

      const analysis = await this.runAnalyzeWithFallback(textForAssets, payload.systemInstruction, availableProviders);
      await this.recordTaskUsage(payload.projectId, 'assetExtraction', 'novel', `${taskId}:analyze:${analysis.provider || 'unknown'}`, analysis);
      this.mergeTask(taskId, task => {
        task.progress.assetExtractionDone = true;
        task.results.analysis = analysis;
      });

      this.updateTask(taskId, { stage: 'segmenting' });
      this.mergeTask(taskId, task => {
        task.results.segmentedScripts = Array.from({ length: payload.episodeDrafts.length }, () => null);
      });
      const segmentedScripts = await mapWithConcurrencyLimit(
        payload.episodeDrafts,
        PREPROCESS_SEGMENT_CONCURRENCY,
        async (draft, index) => {
          this.mergeTask(taskId, task => {
            task.progress.currentEpisodeName = draft.title;
          });
          const result = await this.runSegmentWithFallback(
            draft.content,
            payload.segmentPrompt,
            draft.title,
            { fullNovelText: payload.novelText },
            availableProviders,
          );
          await this.recordTaskUsage(payload.projectId, 'preprocessSegment', draft.title, `${taskId}:segment:${index}:${result.provider || 'unknown'}`, result);
          this.mergeTask(taskId, task => {
            task.progress.completed += 1;
            task.progress.currentEpisodeName = draft.title;
            task.results.segmentedScripts[index] = result;
          });
          return result;
        }
      );

      const secondPassPrompt = payload.enableSecondPass ? payload.secondPassPrompt?.trim() : '';
      let finalScripts = segmentedScripts;
      const secondPassFailedIndexes = [];

      if (secondPassPrompt) {
        this.updateTask(taskId, { stage: 'second_pass' });
        this.mergeTask(taskId, task => {
          task.results.finalScripts = Array.from({ length: segmentedScripts.length }, () => null);
          task.results.secondPassFailedIndexes = [];
        });
        finalScripts = await mapWithConcurrencyLimit(
          segmentedScripts,
          PREPROCESS_SEGMENT_CONCURRENCY,
          async (result, index) => {
            if (result.failed) {
              this.mergeTask(taskId, task => {
                task.results.finalScripts[index] = result;
              });
              return result;
            }

            const draft = payload.episodeDrafts[index];
            this.mergeTask(taskId, task => {
              task.progress.currentEpisodeName = `${draft.title}(二次加工)`;
            });

            const secondary = await this.runSegmentWithFallback(
              result.content,
              secondPassPrompt,
              `${draft.title}(二次加工)`,
              { fullNovelText: payload.novelText },
              availableProviders,
            );
            await this.recordTaskUsage(payload.projectId, 'preprocessSecondPass', draft.title, `${taskId}:second-pass:${index}:${secondary.provider || 'unknown'}`, secondary);

            let finalResult = secondary;
            this.mergeTask(taskId, task => {
              task.progress.secondPassCompleted += 1;
              if (secondary.failed) {
                secondPassFailedIndexes.push(index);
                task.results.secondPassFailedIndexes.push(index);
                finalResult = { content: draft.content, failed: false };
              }
              task.results.finalScripts[index] = finalResult;
            });

            return finalResult;
          }
        );
      } else {
        this.mergeTask(taskId, task => {
          task.results.finalScripts = segmentedScripts;
          task.results.secondPassFailedIndexes = [];
        });
      }

      this.mergeTask(taskId, task => {
        task.results.finalScripts = finalScripts;
        task.results.secondPassFailedIndexes = secondPassFailedIndexes;
      });

      this.updateTask(taskId, {
        status: 'completed',
        stage: 'completed',
        completedAt: Date.now(),
      });
    } catch (error) {
      this.updateTask(taskId, {
        status: 'failed',
        stage: 'failed',
        error: error instanceof Error ? error.message : String(error),
        completedAt: Date.now(),
      });
    }
  }

  async runEpisodeTask(taskId, payload) {
    try {
      this.updateTask(taskId, { status: 'running', stage: 'connectivity' });

      const { availableProviders, checks } = await getAvailableClaudeProviders();
      if (availableProviders.length === 0) {
        throw new Error(`三个 Claude API 均不可用，无法执行预处理：\n\n• 柏拉图中转: ${checks.bltcy.error}\n• CC580: ${checks.cc580.error}\n• Univibe: ${checks.univibe.error}`);
      }

      this.mergeTask(taskId, task => {
        task.results.availableProviders = availableProviders;
        task.progress.currentEpisodeName = payload.episodeName;
      });

      this.updateTask(taskId, { stage: 'segmenting' });
      let result = await this.runSegmentWithFallback(
        payload.content,
        payload.segmentPrompt,
        payload.episodeName,
        { fullNovelText: payload.content },
        availableProviders,
      );
      await this.recordTaskUsage(payload.projectId, 'preprocessSegment', payload.episodeId, `${taskId}:segment:${result.provider || 'unknown'}`, result);

      if (result.failed) {
        throw new Error('Claude API 无法完成分段处理，请检查网络或稍后重试');
      }

      const secondPassPrompt = payload.enableSecondPass ? payload.secondPassPrompt?.trim() : '';
      let secondPassFailed = false;
      if (secondPassPrompt) {
        this.updateTask(taskId, { stage: 'second_pass' });
        const sp = await this.runSegmentWithFallback(
          result.content,
          secondPassPrompt,
          `${payload.episodeName}(二次加工)`,
          { fullNovelText: payload.content },
          availableProviders,
        );
        await this.recordTaskUsage(payload.projectId, 'preprocessSecondPass', payload.episodeId, `${taskId}:second-pass:${sp.provider || 'unknown'}`, sp);

        this.mergeTask(taskId, task => {
          task.progress.secondPassCompleted = 1;
        });

        if (!sp.failed) {
          result = sp;
        } else {
          secondPassFailed = true;
          result = { content: payload.content, failed: false };
        }
      }

      this.mergeTask(taskId, task => {
        task.progress.completed = 1;
        task.results.episodeResult = {
          ...result,
          secondPassFailed,
        };
      });

      this.updateTask(taskId, {
        status: 'completed',
        stage: 'completed',
        completedAt: Date.now(),
      });
    } catch (error) {
      this.updateTask(taskId, {
        status: 'failed',
        stage: 'failed',
        error: error instanceof Error ? error.message : String(error),
        completedAt: Date.now(),
      });
    }
  }

  async runAnalyzeWithFallback(scriptContent, systemInstruction, providers) {
    let lastError = null;
    for (const provider of providers) {
      try {
        return await analyzeNovelScriptWithClaudeServer(scriptContent, systemInstruction, provider);
      } catch (error) {
        lastError = error;
        console.warn(`[preprocess-task-manager] 资产提取失败，切换 provider 重试: ${provider}`, error);
      }
    }
    throw lastError || new Error('Claude 资产提取失败');
  }

  async runSegmentWithFallback(episodeText, skillPrompt, debugLabel, promptContext, providers) {
    for (const provider of providers) {
      const result = await segmentEpisodeWithClaudeServer(episodeText, skillPrompt, debugLabel, promptContext, provider);
      if (!result.failed) {
        return result;
      }
    }
    return { content: episodeText, failed: true };
  }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  async persist() {
    const now = Date.now();
    const tasks = Array.from(this.tasks.values())
      .filter(task => now - (task.updatedAt || task.createdAt || now) <= TASK_RETENTION_MS)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, TASK_HISTORY_LIMIT);

    this.tasks = new Map(tasks.map(task => [task.id, task]));
    await fs.writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
  }
}

const preprocessTaskManager = new PreprocessTaskManager();

export async function initPreprocessTaskManager() {
  await preprocessTaskManager.init();
  return preprocessTaskManager;
}

export function getPreprocessTaskManager() {
  return preprocessTaskManager;
}
