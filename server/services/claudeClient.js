const ANTHROPIC_VERSION = '2023-06-01';
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const CLAUDE_THINKING_BUDGET_TOKENS = 8000;
const CLAUDE_CONNECTIVITY_TIMEOUT_MS = 15000;

export const PROVIDER_UPSTREAM = {
  univibe: 'https://api.univibe.cc/anthropic/v1/messages',
  bltcy: 'https://api.bltcy.ai/v1/messages',
  cc580: 'https://cc.580ai.net/v1/messages',
};

export function getApiKey(provider) {
  if (provider === 'univibe') {
    return process.env.UNIVIBE_API_KEY || process.env.VITE_UNIVIBE_API_KEY || '';
  }
  if (provider === 'bltcy') {
    return process.env.BLTCY_API_KEY || process.env.VITE_BLTCY_API_KEY || '';
  }
  if (provider === 'cc580') {
    return process.env.CC580_API_KEY || process.env.VITE_CC580_API_KEY || '';
  }
  return '';
}

export function buildUpstreamHeaders(provider, apiKey, stream = false) {
  const base = {
    'anthropic-version': ANTHROPIC_VERSION,
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
  };

  if (provider === 'bltcy') {
    return { ...base, Authorization: `Bearer ${apiKey}` };
  }

  return { ...base, 'x-api-key': apiKey };
}

function buildThinkingConfig() {
  return {
    type: 'enabled',
    budget_tokens: CLAUDE_THINKING_BUDGET_TOKENS,
  };
}

function assertProvider(provider) {
  const upstreamUrl = PROVIDER_UPSTREAM[provider];
  if (!upstreamUrl) {
    throw new Error(`未知的 Claude provider: ${provider}`);
  }

  const apiKey = getApiKey(provider);
  if (!apiKey) {
    throw new Error(`未配置 ${provider} API Key（请在 .env.local 中设置）`);
  }

  return { upstreamUrl, apiKey };
}

export async function sendClaudeRequest(provider, payload, options = {}) {
  const { upstreamUrl, apiKey } = assertProvider(provider);
  const isStream = payload?.stream === true;

  return fetch(upstreamUrl, {
    method: 'POST',
    headers: buildUpstreamHeaders(provider, apiKey, isStream),
    body: JSON.stringify(payload),
    ...options,
  });
}

export async function checkClaudeConnectivity(provider, timeoutMs = CLAUDE_CONNECTIVITY_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await sendClaudeRequest(provider, {
      model: CLAUDE_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }, {
      signal: controller.signal,
    });

    if (response.status < 500) {
      return { ok: true };
    }

    const errorText = await response.text().catch(() => '');
    return {
      ok: false,
      error: `${provider} Claude 服务不可用（${response.status}）: ${errorText.slice(0, 200) || response.statusText}`,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, error: `${provider} Claude 连通性检测超时（>${timeoutMs}ms）` };
    }
    return {
      ok: false,
      error: `${provider} Claude 连通性检测失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function getAvailableClaudeProviders() {
  const [bltcyCheck, cc580Check, univibeCheck] = await Promise.all([
    checkClaudeConnectivity('bltcy'),
    checkClaudeConnectivity('cc580'),
    checkClaudeConnectivity('univibe'),
  ]);

  const availableProviders = [];
  if (bltcyCheck.ok) availableProviders.push('bltcy');
  if (cc580Check.ok) availableProviders.push('cc580');
  if (univibeCheck.ok) availableProviders.push('univibe');

  return {
    availableProviders,
    checks: {
      bltcy: bltcyCheck,
      cc580: cc580Check,
      univibe: univibeCheck,
    },
  };
}

function assertNotHtmlResponse(contentType, preview, label) {
  const isHtml = (contentType && contentType.includes('text/html'))
    || /^<!DOCTYPE html>/i.test((preview || '').trimStart())
    || /^<html[\s>]/i.test((preview || '').trimStart());

  if (isHtml) {
    throw new Error(`${label} 返回了 HTML 而不是 JSON/SSE（可能是 URL 配置错误或中转服务异常）: ${String(preview || '').slice(0, 200)}`);
  }
}

function extractTextFromMessageContent(content) {
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

function parseAnthropicSseChunk(chunk) {
  const lines = chunk.split('\n').map(line => line.trim()).filter(Boolean);
  const dataLines = lines.filter(line => line.startsWith('data: '));
  const dataStr = dataLines.map(line => line.slice(6)).join('');

  if (!dataStr || dataStr === '[DONE]') {
    return { text: '', stopReason: null, usage: null };
  }

  let eventData;
  try {
    eventData = JSON.parse(dataStr);
  } catch {
    return { text: '', stopReason: null, usage: null };
  }

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

  const usage = eventData?.usage ?? eventData?.message?.usage ?? null;
  return { text, stopReason, usage };
}

function renderChapterPreprocessPrompt(template, context) {
  const replacements = [
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

export async function analyzeNovelScriptWithClaudeServer(scriptContent, systemInstruction, provider) {
  const payload = {
    model: CLAUDE_MODEL,
    temperature: 1,
    max_tokens: 40000,
    thinking: buildThinkingConfig(),
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

  const response = await sendClaudeRequest(provider, payload);
  const rawText = await response.text();

  if (!response.ok) {
    throw new Error(`[${provider}] Claude API 请求失败 (${response.status}): ${rawText}`);
  }

  assertNotHtmlResponse(response.headers.get('content-type'), rawText, '[Claude 资产提取]');

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`Claude 响应不是合法 JSON: ${rawText.slice(0, 300)}`);
  }

  const content = extractTextFromMessageContent(data?.content);
  if (!content) {
    throw new Error('Claude 响应中没有 content 文本块');
  }

  let jsonStr = content.trim();
  jsonStr = jsonStr.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '');
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    const braceStart = jsonStr.indexOf('{');
    const braceEnd = jsonStr.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      parsed = JSON.parse(jsonStr.slice(braceStart, braceEnd + 1));
    } else {
      throw new Error('Claude 返回的内容不包含 JSON 对象');
    }
  }

  return {
    characters: Array.isArray(parsed.characters) ? parsed.characters : [],
    scenes: Array.isArray(parsed.scenes) ? parsed.scenes : [],
    variants: Array.isArray(parsed.variants) ? parsed.variants : [],
    provider,
    model: data?.model || CLAUDE_MODEL,
    usage: data?.usage || null,
  };
}

export async function segmentEpisodeWithClaudeServer(episodeText, skillContent, debugLabel = '未命名分集', promptContext = {}, provider) {
  const renderedPrompt = renderChapterPreprocessPrompt(skillContent, {
    chapterText: episodeText,
    ...promptContext,
  });

  const payload = {
    model: CLAUDE_MODEL,
    temperature: 1,
    max_tokens: 40000,
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
      const response = await sendClaudeRequest(provider, payload);
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`[${provider}] 分段 API 请求失败 (${response.status}): ${errorText.slice(0, 300)}`);
      }

      assertNotHtmlResponse(response.headers.get('content-type'), '', `[分段][${debugLabel}]`);

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('分段流式响应不可读');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let stopReason = null;
      let usage = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';

        for (const chunk of chunks) {
          const parsed = parseAnthropicSseChunk(chunk);
          if (parsed.text) content += parsed.text;
          if (parsed.stopReason) stopReason = parsed.stopReason;
          if (parsed.usage) usage = parsed.usage;
        }
      }

      if (buffer.trim()) {
        const parsed = parseAnthropicSseChunk(buffer);
        if (parsed.text) content += parsed.text;
        if (parsed.stopReason) stopReason = parsed.stopReason;
        if (parsed.usage) usage = parsed.usage;
      }

      if (!content) {
        throw new Error('分段响应中没有 content');
      }

      if (stopReason === 'max_tokens') {
        return { content: episodeText, failed: true };
      }

      return {
        content: String(content).trim(),
        failed: false,
        provider,
        model: CLAUDE_MODEL,
        usage,
      };
    } catch (error) {
      console.warn(`[分段][${debugLabel}] 第 ${attempt} 次失败:`, error);
      if (attempt >= maxAttempts) {
        return {
          content: episodeText,
          failed: true,
        };
      }
    }
  }

  return { content: episodeText, failed: true };
}
