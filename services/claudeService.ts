/**
 * Claude 服务 - 通过本地后端代理调用 claude-sonnet-4-6（避免 CORS 问题）
 * 支持的上游端点（由后端 server/routes/claude.js 代理）：
 * - Univibe: https://api.univibe.cc/anthropic/v1/messages
 * - 柏拉图中转: https://api.bltcy.ai/v1/messages
 *
 * 注意：API Key 存放在后端 process.env，前端不持有任何密钥
 */

import { AnalysisResult, StoryboardBreakdown, StoryboardDialogueLine } from '../types';
import { Logger } from '../utils/logger';

export type ClaudeProviderType = 'univibe' | 'bltcy';

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const CLAUDE_THINKING_BUDGET_TOKENS = 4096;

/** 本地后端代理地址（与 apiService.ts 中的 API_BASE_URL 逻辑一致） */
function getProxyUrl(): string {
  const configuredUrl = (import.meta as any).env?.VITE_API_URL;
  if (configuredUrl) return `${configuredUrl}/api/claude/proxy`;
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:3001/api/claude/proxy`;
  }
  return 'http://localhost:3001/api/claude/proxy';
}

// 全局状态：当前使用的 Claude 提供商
let currentClaudeProvider: ClaudeProviderType = 'univibe';

export function setClaudeProvider(provider: ClaudeProviderType) {
  console.log(`🔄 切换 Claude 提供商: ${currentClaudeProvider} → ${provider}`);
  currentClaudeProvider = provider;
}

export function getCurrentClaudeProvider(): ClaudeProviderType {
  return currentClaudeProvider;
}

const CLAUDE_CONNECTIVITY_TIMEOUT_MS = 15000;

/**
 * 检查指定 Claude 提供商的网络连通性
 * 发送一个最小请求（max_tokens=1），在超时内收到任何非网络错误响应即视为连通
 */
export async function checkClaudeConnectivity(
  provider: ClaudeProviderType,
  timeoutMs: number = CLAUDE_CONNECTIVITY_TIMEOUT_MS
): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const providerName = provider === 'univibe' ? 'Univibe' : '柏拉图中转';

  try {
    const response = await fetch(getProxyUrl(), {
      method: 'POST',
      headers: buildProxyHeaders(),
      body: JSON.stringify({
        provider,
        model: CLAUDE_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: controller.signal,
    });

    // 任何 HTTP 响应（包括 4xx）都说明网络连通，只有 5xx 才视为不可用
    if (response.status < 500) {
      return { ok: true };
    }

    const errorText = await response.text().catch(() => '');
    return {
      ok: false,
      error: `${providerName} Claude 服务不可用（${response.status}）: ${errorText.slice(0, 200) || response.statusText}`,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, error: `${providerName} Claude 连通性检测超时（>${timeoutMs}ms）` };
    }
    return { ok: false, error: `${providerName} Claude 连通性检测失败: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** 后端代理请求头（不含 API Key，provider 通过 body 传递） */
function buildProxyHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json' };
}

function assertNotHtmlResponse(contentType: string | null, preview: string, label: string): void {
  const isHtml = (contentType && contentType.includes('text/html'))
    || /^<!DOCTYPE html>/i.test(preview.trimStart())
    || /^<html[\s>]/i.test(preview.trimStart());
  if (isHtml) {
    throw new Error(`${label} 返回了 HTML 而不是 JSON/SSE（可能是 URL 配置错误或中转服务异常）: ${preview.slice(0, 200)}`);
  }
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
  promptContext?: Omit<ChapterPreprocessPromptContext, 'chapterText'>,
  provider?: ClaudeProviderType
): Promise<SegmentEpisodeResult> {
  const providerType = provider || currentClaudeProvider;

  const renderedPrompt = renderChapterPreprocessPrompt(skillContent, {
    chapterText: episodeText,
    ...promptContext,
  });

  const payload = {
    provider: providerType,
    model: CLAUDE_MODEL,
    temperature: 0,
    max_tokens: 30000,
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

      const response = await fetch(getProxyUrl(), {
        method: 'POST',
        headers: buildProxyHeaders(),
        body: JSON.stringify(payload),
      });

      console.group(`%c[分段][${debugLabel}][第${attempt}次] 响应头`, 'color: #34d399; font-weight: bold');
      console.log('status:', response.status);
      console.groupEnd();

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`分段 API 请求失败 (${response.status}): ${errorText.slice(0, 300)}`);
      }

      // 防止 URL 配置错误时 200 HTML 响应被当成 SSE 处理
      assertNotHtmlResponse(
        response.headers.get('content-type'),
        '',  // 流式响应不预读 body，仅检查 Content-Type
        `[分段][${debugLabel}]`
      );

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
        // 截断原因是上下文/输出超限，换相同 payload 重试必然复现，直接标记失败
        console.error(`[分段][${debugLabel}] 输出被截断（max_tokens），不重试，回退为原始章节文本`);
        return { content: episodeText, failed: true };
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

  return { content: episodeText, failed: true };
}

/**
 * 调用 claude-sonnet-4-6 提取小说资产（角色、场景、变体）
 * system 强制纯 JSON 输出，提取规则放入 user message
 */
export async function analyzeNovelScriptWithClaude(
  scriptContent: string,
  systemInstruction: string,
  provider?: ClaudeProviderType
): Promise<AnalysisResult> {
  const providerType = provider || currentClaudeProvider;

  const payload = {
    provider: providerType,
    model: CLAUDE_MODEL,
    max_tokens: 30000,
    system: '你是一个结构化信息提取助手。无论用户提供什么文本，你只能输出纯JSON对象，不得包含任何markdown标记、代码块、解释文字、标题或换行注释。你的输出必须能被 JSON.parse() 直接解析。',
    messages: [
      {
        role: 'user',
        content: `请提取这本小说中所有主要角色次要角色的外貌、衣着描写、角色别称（除了角色常规衣着以外，也区分角色不同衣着，创建不同的变体词条（常服不包括在内）。若原文无描述或模糊描述角色常服衣着，则根据身份和剧情定位进行适当原创）。不用输出表情、状态。
        （对于 characters，提取角色完整基础形象，输出字段包含：name（名字，禁止括号注释）、aliases（脚本中出现的别名/别称列表）、description（描述）、appearance（完整基础形象：面部外貌、发型、体态 + 年龄、性别、身份气质 + 日常常服/默认服装；常服必须写入此字段，不得作为变体）、personality（性格）、role（角色类型：Protagonist/Antagonist/Supporting）。
        对于 variants（角色服装/外貌变体）：【严格规则】仅提取文本中明确标注了"变体XX"编号的条目（如"变体01""变体02""#### 变体XX"格式）。常服/日常装束/默认服装不得作为变体提取，应归入主体 appearance 字段。输出字段：characterName（对应角色的 name，必须完全匹配）、name（变体名）、context（出现场景）、appearance（变体专属外貌描述，包含衣着、配饰等具体细节）。
        对于 scenes，包含：name（名字）、description（描述）、environment（环境，禁止出现任何剧情描述，只描述场景地点的布置和外观，去除所有有关小物件、场景人物、出现人物身份代词的描写，如果原文中缺乏描写酌情原创。）、atmosphere（氛围）。）

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

  const response = await fetch(getProxyUrl(), {
    method: 'POST',
    headers: buildProxyHeaders(),
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

  assertNotHtmlResponse(response.headers.get('content-type'), rawText, '[Claude 资产提取]');

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
  // 去除 markdown 代码块包裹
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // 兜底：提取第一个 { 到最后一个 } 之间的内容
    const braceStart = jsonStr.indexOf('{');
    const braceEnd = jsonStr.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      const extracted = jsonStr.slice(braceStart, braceEnd + 1);
      try {
        parsed = JSON.parse(extracted);
        console.warn('[Claude] JSON 兜底提取成功（模型在 JSON 前后输出了多余文字）');
      } catch (e2) {
        console.error('[Claude] JSON.parse 兜底也失败，原始 content:', content);
        throw new Error('Claude 返回的 JSON 格式无效: ' + (e2 as Error).message);
      }
    } else {
      console.error('[Claude] JSON.parse 失败且未找到 {} 结构，原始 content:', content);
      throw new Error('Claude 返回的内容不包含 JSON 对象');
    }
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

/**
 * 调用 claude-sonnet-4-6 生成分镜拆解
 * system 强制纯 JSON 输出，分镜规则放入 user message
 */
export async function generateStoryboardBreakdownWithClaude(
  scriptContent: string,
  systemInstruction: string,
  provider?: ClaudeProviderType
): Promise<StoryboardBreakdown> {
  const providerType = provider || currentClaudeProvider;

  const payload = {
    provider: providerType,
    model: CLAUDE_MODEL,
    max_tokens: 30000,
    system: '你是一个分镜拆解助手。无论用户提供什么文本，你只能输出纯JSON对象，不得包含任何markdown标记、代码块、解释文字、标题或换行注释。你的输出必须能被 JSON.parse() 直接解析。',
    messages: [
      {
        role: 'user',
        content: `请将以下小说文本拆解为视觉分镜帧。

【分镜规则】
${systemInstruction}

【必须严格遵守的输出格式】
直接输出以下结构的JSON对象，不得有任何其他文字：
{"frames":[{"imagePrompt":"静态画面描述","videoPrompt":"视频动作描述","dialogues":[{"speakerName":"角色名","text":"台词"}],"dialogue":"兼容字段","originalText":"原文片段","characterNames":["角色名"],"sceneNames":["场景名"],"variantNames":["变体名"]}]}

【小说文本】
${scriptContent.substring(0, 30000)}`,
      },
    ],
  };

  console.group('%c[Claude] 分镜拆解请求体', 'color: #a78bfa; font-weight: bold');
  console.log(sanitizeAnthropicLogValue(JSON.parse(JSON.stringify(payload))));
  console.groupEnd();

  const response = await fetch(getProxyUrl(), {
    method: 'POST',
    headers: buildProxyHeaders(),
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();

  console.group('%c[Claude] 分镜拆解响应体', 'color: #34d399; font-weight: bold');
  console.log('status:', response.status);
  console.log('raw text:', sanitizeAnthropicRawTextForLog(rawText));
  console.groupEnd();

  if (!response.ok) {
    throw new Error(`Claude API 请求失败 (${response.status}): ${rawText}`);
  }

  assertNotHtmlResponse(response.headers.get('content-type'), rawText, '[Claude 分镜拆解]');

  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`Claude 响应不是合法 JSON: ${rawText.slice(0, 300)}`);
  }

  const content = extractTextFromMessageContent(data?.content);
  if (!content) {
    console.error('[Claude] 分镜拆解响应结构异常:', JSON.stringify(sanitizeAnthropicLogValue(data)));
    throw new Error('Claude 分镜拆解响应中没有 content 文本块');
  }

  let jsonStr = content.trim();
  const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) jsonStr = match[1].trim();

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.error('[Claude] 分镜拆解 JSON.parse 失败，原始 content:', content);
    throw new Error('Claude 返回的分镜 JSON 格式无效: ' + (e as Error).message);
  }

  const frames = Array.isArray(parsed.frames) ? parsed.frames : Array.isArray(parsed) ? parsed : [];

  const result: StoryboardBreakdown = {
    frames: frames.map((f: any) => {
      const imagePrompt = typeof f.imagePrompt === 'string' ? f.imagePrompt : (f.prompt ?? '');
      const videoPrompt = typeof f.videoPrompt === 'string' ? f.videoPrompt : (f.prompt ?? '');

      // dialogues 兼容
      let dialogues: StoryboardDialogueLine[] | undefined = undefined;
      let dialogue: string | undefined = f.dialogue;
      if (Array.isArray(f.dialogues) && f.dialogues.length > 0) {
        dialogues = f.dialogues;
        dialogue = f.dialogues
          .map((d: any) => {
            const speaker = String(d.speakerName ?? '').trim();
            const text = String(d.text ?? '').trim();
            if (!text) return '';
            return speaker ? `${speaker}：${text}` : text;
          })
          .filter(Boolean)
          .join('\n');
      }

      return {
        imagePrompt,
        videoPrompt,
        dialogues,
        dialogue,
        originalText: f.originalText ?? '',
        characterNames: f.characterNames,
        variantNames: f.variantNames,
        sceneNames: f.sceneNames,
        sceneName: f.sceneName,
      };
    }),
  };

  Logger.logInfo('Claude 分镜拆解完成', {
    framesCount: result.frames.length,
  });

  return result;
}
