import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

test('episode list shows a single retry button and failed badge', async () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const appPath = path.join(currentDir, '..', 'App.tsx');
  const source = await readFile(appPath, 'utf8');

  const retryButtonMatches = source.match(/重试失败预处理 \(\{failedPreprocessEpisodes\.length\}\)/g) ?? [];

  assert.equal(retryButtonMatches.length, 1, '应只保留一个“重试失败预处理”按钮');
  assert.match(source, /episode\.preprocessSegmentFailed\s*&&\s*\(/, '分集卡片应根据 preprocessSegmentFailed 渲染失败标注');
  assert.match(source, /预处理失败/, '分集卡片应展示“预处理失败”文案');
});
