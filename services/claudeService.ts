/**
 * Claude 服务 - 通过 Univibe Anthropic 兼容端点调用 claude-sonnet-4-6
 * 端点：https://api.univibe.cc/anthropic/v1/messages
 * 注意：使用 Anthropic Messages 协议；资产提取强制纯 JSON；分段使用流式 SSE
 */

import { AnalysisResult } from '../types';
import { Logger } from '../utils/logger';

const CLAUDE_API_URL = 'https://api.univibe.cc/anthropic/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';
const CLAUDE_THINKING_BUDGET_TOKENS = 4096;

function getApiKey(): string {
  const env = import.meta.env as Record<string, string | undefined>;
  const key = env.VITE_UNIVIBE_API_KEY
    || env.UNIVIBE_API_KEY
    || env.univibe_api_key
    || process.env.UNIVIBE_API_KEY
    || process.env.univibe_api_key;

  if (!key || key === 'PLACEHOLDER_API_KEY') {
    throw new Error('请在 .env.local 中配置 VITE_UNIVIBE_API_KEY（或 UNIVIBE_API_KEY / univibe_api_key）');
  }

  return key;
}

function buildHeaders(apiKey: string, stream = false): HeadersInit {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'Content-Type': 'application/json',
    'Accept': stream ? 'text/event-stream' : 'application/json',
  };
}

function buildThinkingConfig() {
  return {
    type: 'enabled' as const,
    budget_tokens: CLAUDE_THINKING_BUDGET_TOKENS,
  };
}

function sanitizeAnthropicLogValue(value: any): any {
  if (Array.isArray(value)) {
    return value.map(item => sanitizeAnthropicLogValue(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if ((key === 'thinking' || key === 'signature') && typeof item === 'string') {
        return [key, key === 'thinking' ? '[THINKING_REDACTED]' : '[SIGNATURE_REDACTED]'];
      }

      return [key, sanitizeAnthropicLogValue(item)];
    })
  );
}

function sanitizeAnthropicRawTextForLog(rawText: string): string {
  try {
    return JSON.stringify(sanitizeAnthropicLogValue(JSON.parse(rawText)));
  } catch {
    return rawText
      .replace(/("thinking"\s*:\s*")((?:\\.|[^"\\])*)(")/g, '$1[THINKING_REDACTED]$3')
      .replace(/("signature"\s*:\s*")((?:\\.|[^"\\])*)(")/g, '$1[SIGNATURE_REDACTED]$3');
  }
}

function extractTextFromMessageContent(content: any): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map(block => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      return '';
    })
    .filter(Boolean)
    .join('');
}

function parseAnthropicSseChunk(
  chunk: string,
  rawEvents: string[],
  debugLabel: string,
  attempt: number
): { text: string; stopReason: string | null; usage: any } {
  const lines = chunk.split('\n').map(line => line.trim()).filter(Boolean);
  const dataLines = lines.filter(line => line.startsWith('data: '));
  const dataStr = dataLines.map(line => line.slice(6)).join('');

  if (!dataStr || dataStr === '[DONE]') {
    return { text: '', stopReason: null, usage: null };
  }

  let eventData: any;
  try {
    eventData = JSON.parse(dataStr);
  } catch {
    console.warn(`[分段][${debugLabel}][第${attempt}次] 非 JSON SSE 行（跳过）:`, sanitizeAnthropicRawTextForLog(dataStr).slice(0, 120));
    return { text: '', stopReason: null, usage: null };
  }

  rawEvents.push(JSON.stringify(sanitizeAnthropicLogValue(eventData)));

  if (eventData?.type === 'error' || eventData?.error) {
    const message = eventData?.error?.message || eventData?.message || 'Anthropic 流式响应报错';
    throw new Error(message);
  }

  const text = eventData?.type === 'content_block_delta' && eventData?.delta?.type === 'text_delta'
    ? eventData.delta.text || ''
    : eventData?.type === 'content_block_start' && eventData?.content_block?.type === 'text'
    ? eventData.content_block.text || ''
    : '';

  const stopReason = eventData?.type === 'message_delta'
    ? eventData?.delta?.stop_reason ?? null
    : null;

  const usage = eventData?.usage
    ?? eventData?.message?.usage
    ?? null;

  return { text, stopReason, usage };
}

interface ChapterPreprocessPromptContext {
  storyContext?: string;
  characterInfo?: string;
  sceneInfo?: string;
  fullNovelText?: string;
  tweetContent?: string;
  previousContext?: string;
  nextContext?: string;
  chapterText: string;
}

export interface SegmentEpisodeResult {
  content: string;
  failed: boolean;
}

function renderChapterPreprocessPrompt(template: string, context: ChapterPreprocessPromptContext): string {
  const replacements: Array<[RegExp, string]> = [
    [/\{\{\s*故事情节\s*\}\}/g, context.storyContext ?? ''],
    [/\{\{\s*角色信息\s*\}\}/g, context.characterInfo ?? ''],
    [/\{\{\s*场景信息\s*\}\}/g, context.sceneInfo ?? ''],
    [/\{\{\s*小说原文\s*\}\}/g, context.fullNovelText ?? ''],
    [/\{\{\s*推文文案\s*\}\}/g, context.tweetContent ?? ''],
    [/\{\{\s*前面分镜:2\s*\}\}/g, context.previousContext ?? ''],
    [/\{\{\s*后面分镜:2\s*\}\}/g, context.nextContext ?? ''],
    [/\{\{\s*章节文案\s*\}\}/g, context.chapterText],
  ];

  let rendered = template;
  for (const [pattern, value] of replacements) {
    rendered = rendered.replace(pattern, value);
  }

  return rendered;
}

/**
 * 调用 claude-sonnet-4-6 对单集文本执行分段处理（导演分段 skill）
 * 流式输出；若 stop_reason=max_tokens、流式 error 或请求失败，则自动重试一次。
 * 第二次仍失败时，回退为该章原文，避免整次小说预处理失败。
 */
export async function segmentEpisodeWithClaude(
  episodeText: string,
  skillContent: string,
  debugLabel = '未命名分集',
  promptContext?: Omit<ChapterPreprocessPromptContext, 'chapterText'>
): Promise<SegmentEpisodeResult> {
  const apiKey = getApiKey();

  const renderedPrompt = renderChapterPreprocessPrompt(skillContent, {
    chapterText: episodeText,
    ...promptContext,
  });

  const payload = {
    model: CLAUDE_MODEL,
    temperature: 0,
    max_tokens: 30000,
    thinking: buildThinkingConfig(),
    stream: true,
    system: renderedPrompt,
    messages: [
      {
        role: 'user',
        content: episodeText,
      },
    ],
  };

  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      console.group(`%c[分段][${debugLabel}][第${attempt}次] 请求体`, 'color: #60a5fa; font-weight: bold');
      console.log(sanitizeAnthropicLogValue(JSON.parse(JSON.stringify(payload))));
      console.groupEnd();

      const response = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: buildHeaders(apiKey, true),
        body: JSON.stringify(payload),
      });

      console.group(`%c[分段][${debugLabel}][第${attempt}次] 响应头`, 'color: #34d399; font-weight: bold');
      console.log('status:', response.status);
      console.groupEnd();

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`分段 API 请求失败 (${response.status}): ${errorText.slice(0, 300)}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('分段流式响应不可读');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let stopReason: string | null = null;
      let usage: any = null;
      const rawEvents: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';

        for (const chunk of chunks) {
          const parsed = parseAnthropicSseChunk(chunk, rawEvents, debugLabel, attempt);
          if (parsed.text) content += parsed.text;
          if (parsed.stopReason) stopReason = parsed.stopReason;
          if (parsed.usage) usage = parsed.usage;
        }
      }

      if (buffer.trim()) {
        const parsed = parseAnthropicSseChunk(buffer, rawEvents, debugLabel, attempt);
        if (parsed.text) content += parsed.text;
        if (parsed.stopReason) stopReason = parsed.stopReason;
        if (parsed.usage) usage = parsed.usage;
      }

      console.group(`%c[分段][${debugLabel}][第${attempt}次] 流式响应体`, 'color: #34d399; font-weight: bold');
      console.log('raw events:', rawEvents);
      console.groupEnd();

      console.group(`%c[分段][${debugLabel}][第${attempt}次] 解析结果`, 'color: #fbbf24; font-weight: bold');
      console.log('stop_reason:', stopReason);
      console.log('usage:', usage);
      console.log('message.content:', content);
      console.groupEnd();

      if (!content) {
        throw new Error('分段响应中没有 content');
      }

      if (stopReason === 'max_tokens') {
        throw new Error(`分段输出被截断（stop_reason=max_tokens）：${debugLabel}`);
      }

      return {
        content: String(content).trim(),
        failed: false,
      };
    } catch (error) {
      console.warn(`[分段][${debugLabel}] 第 ${attempt} 次失败:`, error);
      if (attempt >= maxAttempts) {
        console.error(`[分段][${debugLabel}] 两次都失败，回退为原始章节文本写入分集剧本`);
        return {
          content: episodeText,
          failed: true,
        };
      }
    }
  }

  return episodeText;
}

/**
 * 调用 claude-sonnet-4-6 提取小说资产（角色、场景、变体）
 * system 强制纯 JSON 输出，提取规则放入 user message
 */
export async function analyzeNovelScriptWithClaude(
  scriptContent: string,
  systemInstruction: string
): Promise<AnalysisResult> {
  const apiKey = getApiKey();

  const payload = {
    model: CLAUDE_MODEL,
    max_tokens: 30000,
    thinking: buildThinkingConfig(),
    system: '你是一个结构化信息提取助手。无论用户提供什么文本，你只能输出纯JSON对象，不得包含任何markdown标记、代码块、解释文字、标题或换行注释。你的输出必须能被 JSON.parse() 直接解析。',
    messages: [
      {
        role: 'user',
        content: `请从以下小说文本中提取角色、场景和变体信息。

【提取规则】
${systemInstruction}

【必须严格遵守的输出格式】
直接输出以下结构的JSON对象，不得有任何其他文字：
{"characters":[{"name":"角色名","aliases":["别名"],"description":"描述","appearance":"外貌","personality":"性格","role":"Protagonist"}],"scenes":[{"name":"场景名","description":"描述","environment":"环境","atmosphere":"氛围"}],"variants":[{"characterName":"角色名","name":"变体名","context":"出现场景","appearance":"外貌"}]}

【小说文本】
${scriptContent}`,
      },
    ],
  };

  console.group('%c[Claude] 请求体', 'color: #a78bfa; font-weight: bold');
  console.log(sanitizeAnthropicLogValue(JSON.parse(JSON.stringify(payload))));
  console.groupEnd();

  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();

  console.group('%c[Claude] 响应体', 'color: #34d399; font-weight: bold');
  console.log('status:', response.status);
  console.log('raw text:', sanitizeAnthropicRawTextForLog(rawText));
  console.groupEnd();

  if (!response.ok) {
    throw new Error(`Claude API 请求失败 (${response.status}): ${rawText}`);
  }

  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`Claude 响应不是合法 JSON: ${rawText.slice(0, 300)}`);
  }

  const content = extractTextFromMessageContent(data?.content);
  if (!content) {
    console.error('[Claude] 响应结构异常:', JSON.stringify(sanitizeAnthropicLogValue(data)));
    throw new Error('Claude 响应中没有 content 文本块');
  }

  console.group('%c[Claude] message.content', 'color: #fbbf24; font-weight: bold');
  console.log(content);
  console.groupEnd();

  let jsonStr = content.trim();
  const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) jsonStr = match[1].trim();

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.error('[Claude] JSON.parse 失败，原始 content:', content);
    throw new Error('Claude 返回的 JSON 格式无效: ' + (e as Error).message);
  }

  const result: AnalysisResult = {
    characters: Array.isArray(parsed.characters) ? parsed.characters : [],
    scenes: Array.isArray(parsed.scenes) ? parsed.scenes : [],
    variants: Array.isArray(parsed.variants) ? parsed.variants : [],
  };

  Logger.logInfo('Claude 资产提取完成', {
    characters: result.characters.length,
    scenes: result.scenes.length,
    variants: result.variants?.length ?? 0,
  });

  return result;
}
