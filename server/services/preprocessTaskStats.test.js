import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProjectStats } from './projectStats.js';
import { recordPreprocessTaskUsage } from './preprocessTaskManager.js';

test('recordPreprocessTaskUsage records analyze usage for the owning project', () => {
  const project = {
    id: 'project-1',
    stats: createDefaultProjectStats(1000),
  };

  const recorded = recordPreprocessTaskUsage({
    project,
    projectId: 'project-1',
    taskType: 'assetExtraction',
    sourceId: 'novel',
    operationId: 'task-1:analyze:univibe',
    result: {
      provider: 'univibe',
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 120,
        output_tokens: 80,
        total_tokens: 200,
      },
    },
    now: 2000,
  });

  assert.equal(recorded, true);
  assert.deepEqual(project.stats.textUsage.totals, {
    inputTokens: 120,
    outputTokens: 80,
    totalTokens: 200,
    requestCount: 1,
  });
  assert.deepEqual(project.stats.textUsage.providers.claude.totals, {
    inputTokens: 120,
    outputTokens: 80,
    totalTokens: 200,
    requestCount: 1,
  });
});

test('recordPreprocessTaskUsage ignores missing usage metadata', () => {
  const project = {
    id: 'project-1',
    stats: createDefaultProjectStats(1000),
  };

  const recorded = recordPreprocessTaskUsage({
    project,
    projectId: 'project-1',
    taskType: 'preprocessSegment',
    sourceId: 'episode-1',
    operationId: 'task-1:segment:episode-1:bltcy',
    result: {
      provider: 'bltcy',
      model: 'claude-sonnet-4-6',
    },
    now: 2000,
  });

  assert.equal(recorded, false);
  assert.deepEqual(project.stats.textUsage.totals, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requestCount: 0,
  });
});
