import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildProjectTextUsagePayload } from './projectTextUsage.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(currentDir, '..');

async function readProjectFile(relativePath) {
  return readFile(path.join(rootDir, relativePath), 'utf8');
}

test('buildProjectTextUsagePayload returns API payload for Claude usage result', () => {
  const payload = buildProjectTextUsagePayload({
    provider: 'claude',
    projectId: 'project-1',
    taskType: 'storyboardBreakdown',
    operationId: 'op-1',
    sourceId: 'episode-1',
    result: {
      usage: {
        input_tokens: 120,
        output_tokens: 80,
        total_tokens: 200,
      },
      provider: 'univibe',
      model: 'claude-sonnet-4-6',
    },
  });

  assert.deepEqual(payload, {
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    taskType: 'storyboardBreakdown',
    idempotencyKey: 'project-1:storyboardBreakdown:episode-1:op-1',
    usage: {
      input_tokens: 120,
      output_tokens: 80,
      total_tokens: 200,
    },
  });
});

test('buildProjectTextUsagePayload returns API payload for Gemini usage result', () => {
  const payload = buildProjectTextUsagePayload({
    provider: 'gemini',
    projectId: 'project-1',
    taskType: 'assetExtraction',
    operationId: 'op-gemini-1',
    sourceId: 'episode-1',
    result: {
      usage: {
        promptTokenCount: 90,
        candidatesTokenCount: 30,
        totalTokenCount: 120,
      },
      model: 'gemini-3-flash-preview',
    },
  });

  assert.deepEqual(payload, {
    provider: 'gemini',
    model: 'gemini-3-flash-preview',
    taskType: 'assetExtraction',
    idempotencyKey: 'project-1:assetExtraction:episode-1:op-gemini-1',
    usage: {
      promptTokenCount: 90,
      candidatesTokenCount: 30,
      totalTokenCount: 120,
    },
  });
});

test('buildProjectTextUsagePayload returns null when result has no usage', () => {
  const payload = buildProjectTextUsagePayload({
    provider: 'claude',
    projectId: 'project-1',
    taskType: 'assetExtraction',
    operationId: 'op-2',
    sourceId: 'episode-1',
    result: {
      provider: 'univibe',
      model: 'claude-sonnet-4-6',
    },
  });

  assert.equal(payload, null);
});

test('buildProjectTextUsagePayload returns null when required identifiers are missing', () => {
  const payload = buildProjectTextUsagePayload({
    provider: 'claude',
    projectId: '',
    taskType: 'preprocessSegment',
    operationId: 'op-3',
    sourceId: 'episode-1',
    result: {
      usage: { input_tokens: 10, output_tokens: 20 },
      provider: 'univibe',
      model: 'claude-sonnet-4-6',
    },
  });

  assert.equal(payload, null);
});

test('Gemini and Volcengine text usage are wired into services and app recording paths', async () => {
  const [appSource, geminiSource, volcengineSource] = await Promise.all([
    readProjectFile('App.tsx'),
    readProjectFile('services/geminiService.ts'),
    readProjectFile('services/volcengineService.ts'),
  ]);

  assert.match(geminiSource, /usageMetadata/, 'Gemini service 应暴露 usageMetadata');
  assert.match(volcengineSource, /usage/, 'Volcengine service 应暴露 usage');
  assert.match(appSource, /provider:\s*'gemini'/, 'App 应上报 Gemini 文本 usage');
  assert.match(appSource, /provider:\s*'volcengine'/, 'App 应上报 Volcengine 文本 usage');
});
