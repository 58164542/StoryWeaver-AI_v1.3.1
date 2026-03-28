import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectStatsSummary } from './projectStatsView.js';

test('buildProjectStatsSummary returns phase1 metrics and coverage text', () => {
  const summary = buildProjectStatsSummary({
    stats: {
      textUsage: {
        totals: {
          inputTokens: 120,
          outputTokens: 80,
          totalTokens: 200,
          requestCount: 3,
        },
        providers: {},
      },
      videoGeneration: {
        seedanceSuccessCount: 5,
      },
      implementationProgress: {
        phase: 'phase1',
        coverage: ['claude', 'seedance'],
        statsActivatedAt: 1711111111111,
        lastUpdatedAt: 1712222222222,
      },
    },
  });

  assert.deepEqual(summary, {
    totalTokens: 200,
    requestCount: 3,
    seedanceSuccessCount: 5,
    phaseLabel: '一期',
    coverageText: 'Claude 文本任务、Seedance 成功视频',
    activatedAtText: '2024-03-22 10:38',
    lastUpdatedAtText: '2024-04-04 07:17',
  });
});

test('buildProjectStatsSummary falls back when project stats are missing', () => {
  const summary = buildProjectStatsSummary({});

  assert.deepEqual(summary, {
    totalTokens: 0,
    requestCount: 0,
    seedanceSuccessCount: 0,
    phaseLabel: '一期',
    coverageText: 'Claude 文本任务、Seedance 成功视频',
    activatedAtText: '未启用',
    lastUpdatedAtText: '未更新',
  });
});
