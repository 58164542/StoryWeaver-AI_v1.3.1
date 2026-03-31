import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyProjectFrameVideoSuccess,
  createDefaultProjectStats,
  ensureProjectStats,
  recordProjectTextUsage,
  recordProjectSeedanceVideoSuccess,
} from './projectStats.js';

test('ensureProjectStats adds default stats and一期 coverage metadata', () => {
  const project = { id: 'project-1', name: '测试项目' };

  const changed = ensureProjectStats(project, 1234567890);

  assert.equal(changed, true);
  assert.deepEqual(project.stats.textUsage.totals, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requestCount: 0,
  });
  assert.equal(project.stats.videoGeneration.seedanceSuccessCount, 0);
  assert.equal(project.stats.implementationProgress.phase, 'phase1');
  assert.deepEqual(project.stats.implementationProgress.coverage, ['claude', 'seedance']);
  assert.equal(project.stats.implementationProgress.statsActivatedAt, 1234567890);
  assert.equal(project.stats.implementationProgress.lastUpdatedAt, 1234567890);
});

test('recordProjectTextUsage aggregates totals and ignores duplicate idempotency keys', () => {
  const project = { id: 'project-1', stats: createDefaultProjectStats(1000) };

  const firstRecorded = recordProjectTextUsage(project, {
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    taskType: 'storyboardBreakdown',
    idempotencyKey: 'usage-1',
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
    },
    now: 2000,
  });

  const secondRecorded = recordProjectTextUsage(project, {
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    taskType: 'storyboardBreakdown',
    idempotencyKey: 'usage-1',
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
    },
    now: 3000,
  });

  assert.equal(firstRecorded, true);
  assert.equal(secondRecorded, false);
  assert.deepEqual(project.stats.textUsage.totals, {
    inputTokens: 120,
    outputTokens: 30,
    totalTokens: 150,
    requestCount: 1,
  });
  assert.deepEqual(project.stats.textUsage.providers.claude.totals, {
    inputTokens: 120,
    outputTokens: 30,
    totalTokens: 150,
    requestCount: 1,
  });
  assert.deepEqual(project.stats.textUsage.providers.claude.models['claude-sonnet-4-6'].taskTypes.storyboardBreakdown, {
    inputTokens: 120,
    outputTokens: 30,
    totalTokens: 150,
    requestCount: 1,
  });
});

test('recordProjectTextUsage normalizes Gemini usage and upgrades coverage to phase2', () => {
  const project = { id: 'project-1', stats: createDefaultProjectStats(1000) };

  const recorded = recordProjectTextUsage(project, {
    provider: 'gemini',
    model: 'gemini-3-flash-preview',
    taskType: 'assetExtraction',
    idempotencyKey: 'usage-gemini-1',
    usage: {
      promptTokenCount: 90,
      candidatesTokenCount: 30,
      totalTokenCount: 120,
    },
    now: 2000,
  });

  assert.equal(recorded, true);
  assert.deepEqual(project.stats.textUsage.providers.gemini.totals, {
    inputTokens: 90,
    outputTokens: 30,
    totalTokens: 120,
    requestCount: 1,
  });
  assert.equal(project.stats.implementationProgress.phase, 'phase2');
  assert.deepEqual(project.stats.implementationProgress.coverage, ['claude', 'seedance', 'gemini']);
});

test('recordProjectSeedanceVideoSuccess counts successful Seedance tasks by unique successTaskKey', () => {
  const project = { id: 'project-1', stats: createDefaultProjectStats(1000) };

  const firstRecorded = recordProjectSeedanceVideoSuccess(project, {
    successTaskKey: 'jimeng:task-1',
    now: 2000,
  });
  const secondRecorded = recordProjectSeedanceVideoSuccess(project, {
    successTaskKey: 'jimeng:task-1',
    now: 3000,
  });
  const anotherTaskRecorded = recordProjectSeedanceVideoSuccess(project, {
    successTaskKey: 'seedance:task-2',
    now: 4000,
  });

  assert.equal(firstRecorded, true);
  assert.equal(secondRecorded, false);
  assert.equal(anotherTaskRecorded, true);
  assert.equal(project.stats.videoGeneration.seedanceSuccessCount, 2);
  assert.deepEqual(project.stats.dedupe.seedanceSuccessTaskKeys, [
    'jimeng:task-1',
    'seedance:task-2',
  ]);
});

test('applyProjectFrameVideoSuccess updates frame videoUrl and counts every unique successful Seedance task', () => {
  const project = {
    id: 'project-1',
    stats: createDefaultProjectStats(1000),
    episodes: [
      {
        id: 'episode-1',
        name: '第1集',
        scriptContent: '',
        frames: [
          { id: 'frame-1', index: 0, imagePrompt: '', videoPrompt: '', originalText: '', references: { characterIds: [] } },
        ],
      },
    ],
  };

  const firstApplied = applyProjectFrameVideoSuccess(project, {
    episodeId: 'episode-1',
    frameId: 'frame-1',
    videoUrl: '/api/media/videos/a.mp4',
    successTaskKey: 'jimeng:task-1',
    now: 2000,
  });
  const secondApplied = applyProjectFrameVideoSuccess(project, {
    episodeId: 'episode-1',
    frameId: 'frame-1',
    videoUrl: '/api/media/videos/b.mp4',
    successTaskKey: 'jimeng:task-2',
    now: 3000,
  });

  assert.equal(firstApplied.recorded, true);
  assert.equal(secondApplied.recorded, true);
  assert.equal(project.episodes[0].frames[0].videoUrl, '/api/media/videos/b.mp4');
  assert.equal(project.episodes[0].frames[0].isGeneratingVideo, false);
  assert.equal(project.episodes[0].frames[0].videoProgress, undefined);
  assert.equal(project.episodes[0].frames[0].videoError, undefined);
  assert.equal(project.episodes[0].frames[0].seedanceTaskUpdatedAt, 3000);
  assert.equal(project.stats.videoGeneration.seedanceSuccessCount, 2);
});

test('ensureProjectStats repairs legacy partial stats structure', () => {
  const project = {
    id: 'project-legacy',
    stats: {
      textUsage: {
        totals: { inputTokens: 1, outputTokens: 2, totalTokens: 3, requestCount: 1 },
      },
    },
  };

  const changed = ensureProjectStats(project, 5555);

  assert.equal(changed, true);
  assert.deepEqual(project.stats.textUsage.totals, {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    requestCount: 1,
  });
  assert.deepEqual(project.stats.textUsage.providers, {});
  assert.equal(project.stats.videoGeneration.seedanceSuccessCount, 0);
  assert.equal(project.stats.implementationProgress.phase, 'phase1');
  assert.deepEqual(project.stats.implementationProgress.coverage, ['claude', 'seedance']);
  assert.equal(project.stats.implementationProgress.statsActivatedAt, 5555);
  assert.deepEqual(project.stats.dedupe.textUsageKeys, []);
  assert.deepEqual(project.stats.dedupe.seedanceSuccessTaskKeys, []);
});
