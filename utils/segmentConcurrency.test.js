import test from 'node:test';
import assert from 'node:assert/strict';
import { PREPROCESS_SEGMENT_CONCURRENCY, mapWithConcurrencyLimit } from './segmentConcurrency.js';

test('novel preprocess segmentation runs with five concurrent workers', async () => {
  const items = Array.from({ length: 12 }, (_, index) => index);
  let running = 0;
  let maxRunning = 0;

  const results = await mapWithConcurrencyLimit(items, PREPROCESS_SEGMENT_CONCURRENCY, async (item) => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise(resolve => setTimeout(resolve, 10));
    running -= 1;
    return item * 2;
  });

  assert.deepEqual(results, items.map(item => item * 2));
  assert.equal(maxRunning, 5);
});
