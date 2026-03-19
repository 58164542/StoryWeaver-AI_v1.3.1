import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEpisodeFromPreprocessResult,
  getFailedPreprocessEpisodes,
} from './preprocessSegmentation.js';

test('buildEpisodeFromPreprocessResult marks failed segmentation episodes', () => {
  const episode = buildEpisodeFromPreprocessResult({
    id: 'ep-1',
    name: '第 1 集',
    frames: [],
    updatedAt: 123,
  }, {
    content: '原始章节文本',
    failed: true,
  });

  assert.equal(episode.scriptContent, '原始章节文本');
  assert.equal(episode.preprocessSegmentFailed, true);
});

test('getFailedPreprocessEpisodes returns only failed episodes', () => {
  const failedEpisodes = getFailedPreprocessEpisodes([
    { id: 'ep-1', name: '第1集', scriptContent: 'a', frames: [], preprocessSegmentFailed: true },
    { id: 'ep-2', name: '第2集', scriptContent: 'b', frames: [], preprocessSegmentFailed: false },
    { id: 'ep-3', name: '第3集', scriptContent: 'c', frames: [], preprocessSegmentFailed: true },
  ]);

  assert.deepEqual(failedEpisodes.map(episode => episode.id), ['ep-1', 'ep-3']);
});
