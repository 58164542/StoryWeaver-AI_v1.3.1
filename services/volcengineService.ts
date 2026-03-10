import { AnalysisResult, StoryboardBreakdown, StoryboardBreakdownFrame } from "../types";
import { Logger } from "../utils/logger";

const VOLCENGINE_API_URL = "https://ark.cn-beijing.volces.com/api/v3/responses";
const VOLCENGINE_VIDEO_API_URL = "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks";
const GRSAI_CHAT_API_URL = "https://grsaiapi.com/v1/chat/completions";

/**
 * 清理JSON响应，移除可能的markdown代码块标记和修复常见格式问题
 */
function cleanJsonResponse(text: string): string {
  const extractJsonBlock = (input: string): string | undefined => {
    const startBrace = input.indexOf('{');
    const startBracket = input.indexOf('[');

    let start = -1;
    if (startBrace === -1) start = startBracket;
    else if (startBracket === -1) start = startBrace;
    else start = Math.min(startBrace, startBracket);

    if (start === -1) return undefined;

    const openChar = input[start];
    const closingChar = openChar === '{' ? '}' : ']';

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < input.length; i++) {
      const ch = input[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === openChar) depth++;
      else if (ch === closingChar) {
        depth--;
        if (depth === 0) {
          return input.slice(start, i + 1);
        }
      }
    }

    // 没找到成对的结束符，尽量截取到最后一个结束符
    const lastClose = input.lastIndexOf(closingChar);
    if (lastClose > start) return input.slice(start, lastClose + 1);

    return undefined;
  };

  let cleaned = (text ?? '').trim();

  // 移除一些模型会返回的思考块，避免 JSON.parse 直接炸掉
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // 移除markdown代码块标记（可能出现多段）
  cleaned = cleaned.replace(/```json\s*/gi, '').replace(/```/g, '').trim();

  // 提取第一个完整 JSON 块（去掉前后夹杂的解释/日志文本）
  // 即使本身以 { 或 [ 开头，也可能存在尾部脏文本导致 JSON.parse 失败
  const extracted = extractJsonBlock(cleaned);
  if (extracted) cleaned = extracted.trim();

  // 修复常见的JSON格式问题：字符串值中未转义的双引号
  // 这个问题在火山引擎返回中文内容时经常出现
  cleaned = fixUnescapedQuotes(cleaned);

  return cleaned;
}

/**
 * 修复JSON字符串中未转义的双引号
 * 策略：在JSON字符串值内部的双引号前添加反斜杠转义
 */
function fixUnescapedQuotes(jsonStr: string): string {
  let result = '';
  let inString = false;
  let lastChar = '';

  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];
    const nextChar = jsonStr[i + 1];

    // 检测字符串的开始和结束
    if (char === '"' && lastChar !== '\\') {
      if (!inString) {
        // 进入字符串
        inString = true;
        result += char;
      } else {
        // 可能是字符串结束，需要判断后面是否是合法的JSON分隔符
        const isStringEnd = !nextChar || nextChar === ',' || nextChar === '}' || nextChar === ']' || nextChar === ':' || /\s/.test(nextChar);

        if (isStringEnd) {
          // 确实是字符串结束
          inString = false;
          result += char;
        } else {
          // 这是字符串内部的未转义引号，需要转义
          result += '\\"';
        }
      }
    } else {
      result += char;
    }

    lastChar = char;
  }

  return result;
}

// JSON Schema 定义 - 角色和场景分析
const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    characters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          description: { type: "string" },
          appearance: { type: "string" },
          personality: { type: "string" },
          role: { type: "string" }
        },
        required: ["name", "aliases", "description", "appearance", "personality", "role"],
        additionalProperties: false
      }
    },
    variants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          characterName: { type: "string" },
          name: { type: "string" },
          context: { type: "string" },
          appearance: { type: "string" }
        },
        required: ["characterName", "name", "appearance"],
        additionalProperties: false
      }
    },
    scenes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          environment: { type: "string" },
          atmosphere: { type: "string" }
        },
        required: ["name", "description", "environment", "atmosphere"],
        additionalProperties: false
      }
    }
  },
  required: ["characters", "scenes"],
  additionalProperties: false
};

// JSON Schema 定义 - 分镜分解
const STORYBOARD_SCHEMA = {
  type: "object",
  properties: {
    frames: {
      type: "array",
      items: {
        type: "object",
        properties: {
          imagePrompt: { type: "string" },
          videoPrompt: { type: "string" },
          // 兼容旧结构：prompt 为单提示词
          prompt: { type: "string" },
          // 兼容旧结构：dialogue 是合并后的字符串
          dialogue: { type: "string" },
          // 新结构：dialogues 是结构化对白列表
          dialogues: {
            type: "array",
            items: {
              type: "object",
              properties: {
                speakerName: { type: "string" },
                text: { type: "string" }
              },
              required: ["text"],
              additionalProperties: false
            }
          },
          originalText: { type: "string" },
          characterNames: {
            type: "array",
            items: { type: "string" }
          },
          variantNames: {
            type: "array",
            items: { type: "string" }
          },
          sceneName: { type: "string" }
        },
        required: ["imagePrompt", "videoPrompt", "originalText"],
        additionalProperties: false
      }
    }
  },
  required: ["frames"],
  additionalProperties: false
};

const PROMPT_REWRITE_SCHEMA = {
  type: "object",
  properties: {
    rewrittenPrompt: { type: "string" },
    notes: { type: "string" }
  },
  required: ["rewrittenPrompt"],
  additionalProperties: false
};

interface VolcengineMessage {
  role: string;
  content: Array<{
    type: string;
    text?: string;
    image_url?: string;
  }>;
}

interface VolcengineRequest {
  model: string;
  input: VolcengineMessage[];
  thinking?: {
    type: string;
  };
  stream?: boolean;
  text?: {
    format?: {
      type: string;
      name: string;
      schema: object;
    };
  };
}

interface VolcengineResponse {
  output?: Array<{
    type: string;
    role: string;
    content: Array<{
      type: string;
      text?: string;
    }>;
    status: string;
  }>;
  error?: {
    message: string;
  };
}

interface GrsaiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface GrsaiChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

/**
 * 调用火山引擎 API
 */
async function callVolcengineAPI(
  model: string,
  prompt: string,
  systemInstruction?: string,
  schema?: object,
  schemaName?: string
): Promise<string> {
  const apiKey = process.env.ARK_API_KEY;

  // 调试日志：查看实际的 API key 值
  console.log('[callVolcengineAPI 调试] ARK_API_KEY:', {
    isDefined: apiKey !== undefined,
    length: apiKey?.length ?? 0,
    first20: apiKey?.substring(0, 20) ?? 'UNDEFINED',
    isUUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(apiKey || '')
  });

  if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
    throw new Error('请在 .env.local 文件中配置 ARK_API_KEY');
  }

  const messages: VolcengineMessage[] = [];

  // 如果有系统指令，添加为第一条消息
  if (systemInstruction) {
    messages.push({
      role: "system",
      content: [{ type: "input_text", text: systemInstruction }]
    });
  }

  // 添加用户消息
  messages.push({
    role: "user",
    content: [{ type: "input_text", text: prompt }]
  });

  const requestBody: VolcengineRequest = {
    model: model,
    input: messages,
    thinking: {
      type: "enabled"
    },
    stream: false
  };

  // 如果提供了 schema，添加结构化输出配置
  if (schema && schemaName) {
    requestBody.text = {
      format: {
        type: "json_schema",
        name: schemaName,
        schema: schema
      }
    };
  }

  try {
    const response = await fetch(VOLCENGINE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('火山引擎 API 响应错误', {
        status: response.status,
        statusText: response.statusText,
        url: VOLCENGINE_API_URL,
        error: errorText
      });
      throw new Error(`火山引擎 API 错误 (${response.status}): ${errorText}`);
    }

    const data: VolcengineResponse = await response.json();
    console.log('火山引擎 API 响应状态', { status: response.status, statusText: response.statusText });

    // 添加详细日志
    console.log("火山引擎 API 完整响应:", JSON.stringify(data, null, 2));

    if (data.error) {
      throw new Error(`火山引擎 API 错误: ${data.error.message}`);
    }

    // 火山引擎的响应结构：output[].content[0].text
    // 启用 thinking 时 output[0] 为 reasoning 类型（无 content），output[1] 才是 message
    const messageOutput = data.output?.find((o: any) => o.type === 'message');
    const contentItems = messageOutput?.content || [];
    const textItems = Array.isArray(contentItems)
      ? contentItems.filter((c: any) => typeof c?.text === 'string' && c.text.length > 0)
      : [];
    const content = textItems.length > 0 ? textItems[textItems.length - 1].text : undefined;
    if (!content) {
      console.error("响应结构:", data);
      console.error("output:", data.output);
      console.error("第一个 output:", data.output?.[0]);
      console.error("content:", data.output?.[0]?.content);
      throw new Error("火山引擎 API 返回空响应");
    }

    // 清理返回的文本，移除可能的markdown代码块标记
    const cleanedContent = cleanJsonResponse(content);

    // 调试日志：显示修复前后的对比
    if (content !== cleanedContent) {
      console.log("🔧 JSON内容已修复");
      console.log("修复前长度:", content.length);
      console.log("修复后长度:", cleanedContent.length);

      // 找出差异位置
      let diffPos = -1;
      for (let i = 0; i < Math.min(content.length, cleanedContent.length); i++) {
        if (content[i] !== cleanedContent[i]) {
          diffPos = i;
          break;
        }
      }

      if (diffPos !== -1) {
        console.log("首次差异位置:", diffPos);
        console.log("修复前 (position " + diffPos + " 附近):", content.substring(Math.max(0, diffPos - 30), diffPos + 30));
        console.log("修复后 (position " + diffPos + " 附近):", cleanedContent.substring(Math.max(0, diffPos - 30), diffPos + 30));
      }
    } else {
      console.log("✓ JSON内容无需修复");
    }

    return cleanedContent;
  } catch (error) {
    console.error("调用火山引擎 API 失败:", error);
    throw error;
  }
}

async function callGrsaiChatAPI(
  model: string,
  prompt: string,
  systemInstruction?: string,
  schema?: object,
  schemaName?: string
): Promise<string> {
  const apiKey = process.env.GRSAI_API_KEY;

  if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
    throw new Error('请在 .env.local 文件中配置 GRSAI_API_KEY');
  }

  const messages: GrsaiChatMessage[] = [];
  if (systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }
  messages.push({ role: 'user', content: prompt });

  const requestBody = {
    model,
    stream: false,
    messages,
    // Grsai 中转的 Gemini 系列模型不支持 json_schema 类型，使用 json_object 确保输出 JSON 格式
    response_format: schema && schemaName ? {
      type: "json_object"
    } : undefined
  };

  const startTime = Date.now();
  Logger.logRequest('Grsai', 'chat.completions', GRSAI_CHAT_API_URL, requestBody);

  let response: Response;
  try {
    response = await fetch(GRSAI_CHAT_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
  } catch (error) {
    Logger.logError('Grsai', 'chat.completions 请求失败', error);
    throw error;
  }

  if (!response.ok) {
    const errorText = await response.text();
    Logger.logError('Grsai', 'chat.completions 响应错误', {
      status: response.status,
      error: errorText
    });
    console.error('Grsai 响应错误', {
      status: response.status,
      statusText: response.statusText,
      url: GRSAI_CHAT_API_URL,
      error: errorText
    });
    throw new Error(`Grsai API 错误 (${response.status}): ${errorText}`);
  }

  const data: GrsaiChatResponse = await response.json();
  console.log('Grsai 响应状态', { status: response.status, statusText: response.statusText });
  Logger.logResponse('Grsai', response.status, data, Date.now() - startTime);

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Grsai API 返回空响应');
  }

  return content;
}

export interface PromptRewriteResult {
  rewrittenPrompt: string;
  notes?: string;
}

/**
 * 使用豆包模型将违规分镜生图提示词改写为合规版本（结构化 JSON 输出）。
 * 保留画面意图（构图/镜头/氛围），去除触发审核的内容，不输出绕过审核的建议。
 */
export const rewriteImagePromptForPolicyCompliance = async (
  originalPrompt: string,
  policyError?: string,
  model: string = 'doubao-seed-2-0-pro-260215'
): Promise<PromptRewriteResult> => {
  const startTime = Date.now();
  Logger.logOperationStart('提示词合规改写（豆包）', {
    model,
    originalPromptLength: originalPrompt.length,
    hasPolicyError: !!policyError
  });

  const prompt = `你是一个"分镜生图提示词"编辑器。用户的提示词触发了平台的内容政策拦截。

请将下面的提示词改写为"合规版本"，要求：
1) 保留剧情信息与画面意图（构图、镜头、角色关系、环境氛围）。
2) 删除或替换可能触发政策的细节（如过度血腥、露骨性内容、未成年人性化、仇恨/歧视、违法活动等）。
3) 不要输出任何规避/绕过审核的建议，不要输出提示审核关键词。
4) 必须输出合法 JSON，禁止 Markdown。

政策错误信息（如有）：
${policyError ?? ''}

原始提示词：
${originalPrompt}`;

  try {
    const responseText = await callVolcengineAPI(
      model,
      prompt,
      undefined,
      PROMPT_REWRITE_SCHEMA,
      'prompt_rewrite'
    );

    const result: PromptRewriteResult = JSON.parse(responseText);
    const duration = Date.now() - startTime;
    Logger.logOperationEnd('提示词合规改写（豆包）', { rewrittenLength: result.rewrittenPrompt?.length ?? 0 }, duration);
    return result;
  } catch (error) {
    Logger.logError('提示词合规改写（豆包）', '改写失败', error);
    throw error;
  }
};

/**
 * 分析小说文本，提取角色和场景
 */
export const analyzeNovelScript = async (
  text: string,
  model: string = 'doubao-seed-2-0-pro-260215',
  systemInstruction?: string
): Promise<AnalysisResult> => {
  const prompt = `
分析以下小说文本，提取关键角色、角色变体和场景。

对于 characters，提取角色完整基础形象，输出字段包含：name（名字，禁止括号注释）、aliases（脚本中出现的别名/别称列表）、description（描述）、appearance（完整基础形象：面部外貌、发型、体态 + 年龄 + 日常常服/默认服装；常服必须写入此字段，不得作为变体）、personality（性格）、role（角色类型：Protagonist/Antagonist/Supporting）。

对于 variants（角色服装/外貌变体）：【严格规则】仅提取文本中明确标注了"变体XX"编号的条目（如"变体01""变体02""#### 变体XX"格式）。常服/日常装束/默认服装不得作为变体提取，应归入主体 appearance 字段。输出字段：characterName（对应角色的 name，必须完全匹配）、name（变体名）、context（出现场景）、appearance（变体专属外貌描述，包含衣着、配饰等具体细节）。

对于 scenes，包含：name（名字）、description（描述）、environment（环境，禁止出现任何剧情描述，只描述场景地点的布置和外观，去除所有有关小物件、场景人物、出现人物身份代词的描写，如果原文中缺乏描写酌情原创。）、atmosphere（氛围）。

文本内容：
${text.substring(0, 30000)}
  `;

  try {
    const responseText = await callVolcengineAPI(
      model,
      prompt,
      systemInstruction,
      ANALYSIS_SCHEMA,
      "novel_analysis"
    );

    console.log("准备解析的JSON文本（前500字符）:", responseText.substring(0, 500));
    console.log("准备解析的JSON文本（后500字符）:", responseText.substring(Math.max(0, responseText.length - 500)));

    let result: AnalysisResult;
    try {
      result = JSON.parse(responseText) as AnalysisResult;
    } catch (parseError) {
      console.error("JSON解析失败！完整的响应文本:", responseText);
      console.error("响应文本长度:", responseText.length);
      console.error("响应文本的前100个字符:", responseText.substring(0, 100));
      console.error("响应文本的后100个字符:", responseText.substring(Math.max(0, responseText.length - 100)));

      // 尝试找出问题位置
      if (parseError instanceof SyntaxError) {
        const errorMsg = parseError.message;
        const posMatch = errorMsg.match(/position (\d+)/);
        if (posMatch) {
          const pos = parseInt(posMatch[1]);
          const start = Math.max(0, pos - 50);
          const end = Math.min(responseText.length, pos + 50);
          console.error(`错误位置附近的文本 (position ${pos}):`, responseText.substring(start, end));
          console.error(`错误字符: "${responseText[pos]}"`);
        }
      }

      throw parseError;
    }

    // 验证返回的数据结构
    if (!result.characters || !result.scenes) {
      throw new Error("返回的 JSON 格式不正确，缺少 characters 或 scenes 字段");
    }

    return result;
  } catch (error) {
    console.error("分析小说文本失败:", error);
    throw error;
  }
};

export const analyzeNovelScriptWithGrsai = async (
  text: string,
  model: string = 'gemini-3.1-pro',
  systemInstruction?: string
): Promise<AnalysisResult> => {
  const prompt = `
分析以下小说文本，提取关键角色、角色变体和场景。

对于 characters，提取角色完整基础形象，输出字段：name（名字，禁止括号注释）、aliases（脚本中出现的别名/别称列表）、description（描述）、appearance（完整基础形象：面部外貌、发型、体态 + 日常常服/默认服装；常服必须写入此字段，不得作为变体）、personality（性格）、role（角色类型：Protagonist/Antagonist/Supporting）。

对于 variants（角色服装/外貌变体）：【严格规则】仅提取文本中明确标注了"变体XX"编号的条目（如"变体01""变体02""#### 变体XX"格式）。常服/日常装束/默认服装不得作为变体提取，应归入主体 appearance 字段。输出字段：characterName（对应角色的 name，必须完全匹配）、name（变体名）、context（出现场景）、appearance（变体专属外貌含衣着配饰的具体描述）。

对于 scenes，包含：name（名字）、description（描述）、environment（环境）、atmosphere（氛围）。

文本内容：
${text.substring(0, 30000)}

【重要】请直接输出纯 JSON 对象，格式为 {"characters":[...],"variants":[...],"scenes":[...]}，禁止输出任何 Markdown 标记、代码块、标题或解释文字。
  `;

  try {
    const responseText = await callGrsaiChatAPI(
      model,
      prompt,
      systemInstruction,
      ANALYSIS_SCHEMA,
      "novel_analysis"
    );

    console.log("准备解析的JSON文本（前500字符）:", responseText.substring(0, 500));
    console.log("准备解析的JSON文本（后500字符）:", responseText.substring(Math.max(0, responseText.length - 500)));

    let result: AnalysisResult;
    try {
      result = JSON.parse(responseText) as AnalysisResult;
    } catch (parseError) {
      const cleaned = cleanJsonResponse(responseText);
      try {
        result = JSON.parse(cleaned) as AnalysisResult;
      } catch {
        console.error("JSON解析失败！完整的响应文本:", responseText);
        console.error("响应文本长度:", responseText.length);
        console.error("响应文本的前100个字符:", responseText.substring(0, 100));
        console.error("响应文本的后100个字符:", responseText.substring(Math.max(0, responseText.length - 100)));

        if (parseError instanceof SyntaxError) {
          const errorMsg = parseError.message;
          const posMatch = errorMsg.match(/position (\d+)/);
          if (posMatch) {
            const pos = parseInt(posMatch[1]);
            const start = Math.max(0, pos - 50);
            const end = Math.min(responseText.length, pos + 50);
            console.error(`错误位置附近的文本 (position ${pos}):`, responseText.substring(start, end));
            console.error(`错误字符: "${responseText[pos]}"`);
          }
        }

        throw parseError;
      }
    }

    if (!result.characters || !result.scenes) {
      throw new Error("返回的 JSON 格式不正确，缺少 characters 或 scenes 字段");
    }

    return result;
  } catch (error) {
    console.error("分析小说文本失败:", error);
    throw error;
  }
};

/**
 * 旧格式兼容：将只有 prompt 字段的帧补全为 imagePrompt/videoPrompt
 */
const normalizeBreakdownFrame = (f: any): StoryboardBreakdownFrame => {
  const imagePrompt = typeof f.imagePrompt === 'string' ? f.imagePrompt : (f.prompt ?? '');
  const videoPrompt = typeof f.videoPrompt === 'string' ? f.videoPrompt : (f.prompt ?? '');
  return { ...f, imagePrompt, videoPrompt };
};

/**
 * 生成分镜分解
 */
export const generateStoryboardBreakdown = async (
  text: string,
  model: string = 'doubao-seed-2-0-pro-260215',
  systemInstruction?: string
): Promise<StoryboardBreakdown> => {
  const prompt = `
将以下小说文本分解为视频脚本。

每个 frame 应包含：
- imagePrompt: 详细的静态画面描述，用于图像生成器。重点描述单帧的构图、人物外貌/姿态、场景环境、光线氛围，要求画面内容具体、静态感强，适合直接生成分镜图片。（图片提示词严禁使用线性时间描述、严禁使用一个以上的动作词汇）
- videoPrompt: 一组详细连贯的视觉描述，用于视频生成器。要求按照分镜拆解提示词要求详细阐述清楚剧情背景和视频内容，必须包含详细的起承转合线性时间动作，将单调的镜头语言动作具象化，如果原文内容不足以支撑起一段连贯的动作镜头，酌情加以补充细节和裂变镜头。
- dialogues: 结构化对话数组（可选），每项为 { speakerName, text }
  - speakerName: 必须使用候选角色的 name（不要输出别称/外号/括号注释）；旁白/未知说话人请省略 speakerName
  - text: 台词内容
  - 一个分镜内可能有多个说话人、多句台词
- dialogue: （兼容字段，可选）将 dialogues 合并成多行字符串
- originalText: 该帧对应的原始文本片段
- characterNames: 该帧中出现的所有角色名字或别名列表（可选）
- sceneName: 该帧发生的场景名称（可选）

文本内容：
${text.substring(0, 30000)}
  `;

  try {
    const responseText = await callVolcengineAPI(
      model,
      prompt,
      systemInstruction,
      STORYBOARD_SCHEMA,
      "storyboard_breakdown"
    );

    console.log("准备解析分镜JSON文本（前500字符）:", responseText.substring(0, 500));

    let result: StoryboardBreakdown;
    try {
      result = JSON.parse(responseText) as StoryboardBreakdown;
    } catch (parseError) {
      const cleaned = cleanJsonResponse(responseText);
      try {
        result = JSON.parse(cleaned) as StoryboardBreakdown;
      } catch {
        console.error("分镜JSON解析失败！完整的响应文本:", responseText);
        console.error("响应文本长度:", responseText.length);

        // 尝试找出问题位置
        if (parseError instanceof SyntaxError) {
          const errorMsg = parseError.message;
          const posMatch = errorMsg.match(/position (\d+)/);
          if (posMatch) {
            const pos = parseInt(posMatch[1]);
            const start = Math.max(0, pos - 50);
            const end = Math.min(responseText.length, pos + 50);
            console.error(`错误位置附近的文本 (position ${pos}):`, responseText.substring(start, end));
          }
        }

        throw parseError;
      }
    }

    // dialogues 兼容：如果只给 dialogue 字符串，也能在后续拼接/拆分
    // 同时做 imagePrompt/videoPrompt 旧格式兼容处理
    if (result?.frames?.length) {
      result.frames = result.frames.map(f => {
        const anyFrame: any = f;
        let normalized = normalizeBreakdownFrame(anyFrame);
        if (Array.isArray(anyFrame.dialogues) && anyFrame.dialogues.length > 0) {
          const merged = anyFrame.dialogues
            .map((d: any) => {
              const speaker = String(d.speakerName ?? '').trim();
              const text = String(d.text ?? '').trim();
              if (!text) return '';
              return speaker ? `${speaker}：${text}` : text;
            })
            .filter(Boolean)
            .join('\n');
          return { ...normalized, dialogue: merged };
        }
        return normalized;
      });
    }

    // 验证返回的数据结构
    if (!result.frames || !Array.isArray(result.frames)) {
      throw new Error("返回的 JSON 格式不正确，缺少 frames 数组");
    }

    return result;
  } catch (error) {
    console.error("生成分镜分解失败:", error);
    throw error;
  }
};

const normalizeStoryboardBreakdownResult = (raw: unknown): StoryboardBreakdown => {
  const isFrame = (value: any): value is StoryboardBreakdownFrame => {
    if (!value || typeof value !== 'object') return false;
    if (typeof value.originalText !== 'string') return false;
    // 接受新格式 (imagePrompt/videoPrompt) 或旧格式 (prompt)
    return typeof value.imagePrompt === 'string' || typeof value.prompt === 'string';
  };

  const flattenGroupedFrames = (items: any[]): StoryboardBreakdownFrame[] => {
    const frames: StoryboardBreakdownFrame[] = [];
    for (const item of items) {
      if (isFrame(item)) {
        frames.push(normalizeBreakdownFrame(item));
        continue;
      }
      if (item && typeof item === 'object' && Array.isArray((item as any).frames)) {
        for (const f of (item as any).frames) {
          if (isFrame(f)) frames.push(normalizeBreakdownFrame(f));
        }
      }
    }
    return frames;
  };

  if (raw && typeof raw === 'object' && Array.isArray((raw as any).frames)) {
    return { frames: (raw as any).frames.filter(isFrame).map(normalizeBreakdownFrame) };
  }

  if (Array.isArray(raw)) {
    const frames = flattenGroupedFrames(raw);
    return { frames };
  }

  if (raw && typeof raw === 'object' && Array.isArray((raw as any).groups)) {
    const frames = flattenGroupedFrames((raw as any).groups);
    return { frames };
  }

  throw new Error('返回的 JSON 格式不正确，无法解析为 StoryboardBreakdown');
};

export const generateStoryboardBreakdownWithGrsai = async (
  text: string,
  model: string = 'gemini-3.1-pro',
  systemInstruction?: string
): Promise<StoryboardBreakdown> => {
  const prompt = `
将以下小说文本分解为视觉分镜帧。

每个 frame 应包含：
- imagePrompt: 详细的静态画面描述，用于图像生成器。重点描述单帧的构图、人物外貌/姿态、场景环境、光线氛围，要求画面内容具体、静态感强，适合直接生成分镜图片。
- videoPrompt: 详细连贯的视觉描述，用于视频生成器。包含完整的起承转合线性时间动作，将镜头语言动作具象化，如原文不足以支撑连贯动作镜头，酌情补充细节和裂变镜头。
- dialogues: 结构化对话数组（可选），每项为 { speakerName, text }
  - speakerName: 必须使用候选角色的 name（不要输出别称/外号/括号注释）；旁白/未知说话人请省略 speakerName
  - text: 台词内容
  - 一个分镜内可能有多个说话人、多句台词
- dialogue: （兼容字段，可选）将 dialogues 合并成多行字符串
- originalText: 该帧对应的原始文本片段
- characterNames: 该帧中出现的角色名字或别名列表（可选）
- sceneName: 该帧发生的场景名称（可选）

文本内容：
${text.substring(0, 30000)}

【重要】请直接输出纯 JSON 对象，格式为 {"frames":[...]}，禁止输出任何 Markdown 标记、代码块、标题或解释文字。
  `;

  try {
    const responseText = await callGrsaiChatAPI(
      model,
      prompt,
      systemInstruction,
      STORYBOARD_SCHEMA,
      "storyboard_breakdown"
    );

    console.log("准备解析分镜JSON文本（前500字符）:", responseText.substring(0, 500));

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch (parseError) {
      const cleaned = cleanJsonResponse(responseText);
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        console.error("分镜JSON解析失败！完整的响应文本:", responseText);
        console.error("响应文本长度:", responseText.length);

        if (parseError instanceof SyntaxError) {
          const errorMsg = parseError.message;
          const posMatch = errorMsg.match(/position (\d+)/);
          if (posMatch) {
            const pos = parseInt(posMatch[1]);
            const start = Math.max(0, pos - 50);
            const end = Math.min(responseText.length, pos + 50);
            console.error(`错误位置附近的文本 (position ${pos}):`, responseText.substring(start, end));
          }
        }

        throw parseError;
      }
    }

    const result = normalizeStoryboardBreakdownResult(parsed);
    if (!result.frames || !Array.isArray(result.frames)) {
      throw new Error("返回的 JSON 格式不正确，缺少 frames 数组");
    }

    return result;
  } catch (error) {
    console.error("生成分镜分解失败:", error);
    throw error;
  }
};

/**
 * 火山引擎视频生成 API 接口定义
 */
interface VideoGenerationTask {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'expired';
  error?: {
    code: string;
    message: string;
  };
  content?: {
    video_url: string;
  };
}

/**
 * 将本地/局域网图片 URL 转为 base64 data URL，以便外部 API 访问。
 * 若已是 data URL 或公网 URL 则原样返回。
 */
async function resolveImageUrl(url: string): Promise<string> {
  if (!url || url.startsWith('data:')) return url;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`fetch image failed: ${response.status}`);
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.warn('[resolveImageUrl] 转换失败，使用原始 URL', e);
    return url;
  }
}

/**
 * 使用火山引擎 doubao-seedance 模型生成视频
 * @param imageUrl 输入图片的 URL
 * @param prompt 文本提示词
 * @param aspectRatio 视频宽高比
 * @param duration 视频时长（秒）
 * @param onProgress 进度回调函数
 * @returns 生成的视频 URL
 */
export const generateVideoWithVolcengine = async (
  imageUrl: string,
  prompt: string,
  aspectRatio: '16:9' | '9:16' | '1:1' | '4:3' | '3:4',
  duration: number = 5,
  onProgress?: (progress: number) => void
): Promise<string> => {
  const apiKey = process.env.ARK_API_KEY;

  if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
    throw new Error('请在 .env.local 文件中配置 ARK_API_KEY');
  }

  Logger.logInfo('开始创建火山引擎视频生成任务', { imageUrl, prompt, aspectRatio, duration });

  // 火山引擎是公网服务，无法访问局域网地址，先将本地图片转为 base64 data URL
  const resolvedImageUrl = await resolveImageUrl(imageUrl);

  // 创建视频生成任务
  const createResponse = await fetch(VOLCENGINE_VIDEO_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'doubao-seedance-1-5-pro-251215',
      content: [
        {
          type: 'text',
          text: prompt
        },
        {
          type: 'image_url',
          image_url: {
            url: resolvedImageUrl
          }
        }
      ],
      resolution: '720p',
      ratio: aspectRatio,
      duration: duration,
      camera_fixed: false,
      watermark: true
    })
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    Logger.logError('Volcengine', '创建视频生成任务失败', { status: createResponse.status, error: errorText });
    throw new Error(`创建视频生成任务失败 (${createResponse.status}): ${errorText}`);
  }

  const createData = await createResponse.json();
  const taskId = createData.id;

  if (!taskId) {
    Logger.logError('Volcengine', '未获取到任务 ID', createData);
    throw new Error('未获取到任务 ID');
  }

  Logger.logInfo('视频生成任务已创建', { taskId });

  // 轮询查询任务状态
  const maxAttempts = 180; // 最多轮询 180 次（15 分钟）
  const pollInterval = 5000; // 每 5 秒轮询一次
  let attempts = 0;

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    attempts++;

    const queryResponse = await fetch(`${VOLCENGINE_VIDEO_API_URL}/${taskId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!queryResponse.ok) {
      const errorText = await queryResponse.text();
      Logger.logError('Volcengine', '查询任务状态失败', { status: queryResponse.status, error: errorText });
      throw new Error(`查询任务状态失败 (${queryResponse.status}): ${errorText}`);
    }

    const taskData: VideoGenerationTask = await queryResponse.json();
    Logger.logInfo('任务状态', { taskId, status: taskData.status, attempts });

    // 更新进度
    if (onProgress) {
      // 根据状态估算进度
      let progress = 0;
      if (taskData.status === 'queued') {
        progress = 10;
      } else if (taskData.status === 'running') {
        // 运行中时，根据轮询次数估算进度（10% - 90%）
        progress = Math.min(10 + (attempts / maxAttempts) * 80, 90);
      } else if (taskData.status === 'succeeded') {
        progress = 100;
      }
      onProgress(progress);
    }

    if (taskData.status === 'succeeded') {
      const videoUrl = taskData.content?.video_url;
      if (!videoUrl) {
        throw new Error('任务成功但未返回视频 URL');
      }
      Logger.logInfo('视频生成成功', { taskId, videoUrl });
      return videoUrl;
    } else if (taskData.status === 'failed') {
      const errorMsg = taskData.error?.message || '未知错误';
      Logger.logError('Volcengine', '视频生成失败', { taskId, error: errorMsg });
      throw new Error(`视频生成失败: ${errorMsg}`);
    } else if (taskData.status === 'expired') {
      Logger.logError('Volcengine', '视频生成任务超时', { taskId });
      throw new Error('视频生成任务超时');
    }
  }

  // 超过最大轮询次数
  Logger.logError('Volcengine', '视频生成超时', { taskId, attempts });
  throw new Error('视频生成超时，请稍后重试');
};
