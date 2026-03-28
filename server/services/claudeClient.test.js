import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeNovelScriptWithClaudeServer,
  segmentEpisodeWithClaudeServer,
} from './claudeClient.js';

const originalFetch = globalThis.fetch;
const originalUnivibeApiKey = process.env.UNIVIBE_API_KEY;

function createSseReader(chunks) {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) {
            return { done: true, value: undefined };
          }

          const value = encoder.encode(chunks[index]);
          index += 1;
          return { done: false, value };
        },
      };
    },
  };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.UNIVIBE_API_KEY = originalUnivibeApiKey;
});

test('analyzeNovelScriptWithClaudeServer returns usage metadata with parsed result', async () => {
  process.env.UNIVIBE_API_KEY = 'test-key';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return name === 'content-type' ? 'application/json' : null;
      },
    },
    async text() {
      return JSON.stringify({
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 120,
          output_tokens: 80,
          total_tokens: 200,
        },
        content: [
          {
            type: 'text',
            text: '{"characters":[],"scenes":[],"variants":[]}',
          },
        ],
      });
    },
  });

  const result = await analyzeNovelScriptWithClaudeServer('原文', '规则', 'univibe');

  assert.deepEqual(result, {
    characters: [],
    scenes: [],
    variants: [],
    provider: 'univibe',
    model: 'claude-sonnet-4-6',
    usage: {
      input_tokens: 120,
      output_tokens: 80,
      total_tokens: 200,
    },
  });
});

test('segmentEpisodeWithClaudeServer returns usage metadata with successful stream result', async () => {
  process.env.UNIVIBE_API_KEY = 'test-key';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return name === 'content-type' ? 'text/event-stream' : null;
      },
    },
    body: createSseReader([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"切分结果"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":50,"output_tokens":25,"total_tokens":75}}\n\n',
    ]),
  });

  const result = await segmentEpisodeWithClaudeServer('章节原文', '提示词模板', '第1集', {}, 'univibe');

  assert.deepEqual(result, {
    content: '切分结果',
    failed: false,
    provider: 'univibe',
    model: 'claude-sonnet-4-6',
    usage: {
      input_tokens: 50,
      output_tokens: 25,
      total_tokens: 75,
    },
  });
});
