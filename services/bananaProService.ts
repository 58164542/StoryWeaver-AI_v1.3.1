/**
 * 香蕉Pro图像生成服务
 * API文档: https://grsai.dakka.com.cn
 */

import { uploadImageToGitHub } from './githubImageService';
import { buildPromptWithRefs } from '../utils/imagePromptUtils';

const BANANA_PRO_API_URL = "https://grsai.dakka.com.cn/v1/draw/nano-banana";

/** 最大尝试次数（含首次）*/
const MAX_ATTEMPTS = 3;

/** 重试间隔基数（ms），第 n 次重试等待 n × BASE_RETRY_DELAY_MS */
const BASE_RETRY_DELAY_MS = 3000;

interface ReferenceImage {
  name: string;
  data: string;
  mimeType: string;
}

type ProgressCallback = (progress: number) => void;

interface BananaProRequest {
  model: string;
  prompt: string;
  aspectRatio: string;
  imageSize: string;
  urls?: string[];
  shutProgress: boolean;
}

interface BananaProResponse {
  id: string;
  results?: Array<{
    url: string;
    content: string;
  }>;
  progress: number;
  status: 'running' | 'succeeded' | 'failed';
  failure_reason?: string;
  error?: string;
}

/**
 * 是否属于内容审核（moderation）错误 — 不可重试，交由上层改写流程处理
 */
function isModerationError(msg: string): boolean {
  return msg.includes('内容政策') || msg.includes('moderation');
}

/**
 * 是否属于可重试的瞬态错误（超时、流中断、服务端 5xx 等）
 */
function isRetryableError(msg: string): boolean {
  if (isModerationError(msg)) return false;
  const lower = msg.toLowerCase();
  return (
    lower.includes('timeout') ||
    lower.includes('未收到有效的生成结果') ||
    lower.includes('无法读取响应流') ||
    lower.includes('failed to fetch') ||
    lower.includes('network') ||
    // HTTP 5xx
    /api 错误 \(5\d\d\)/.test(lower)
  );
}

/**
 * 下载图片并转换为Base64 Data URL
 */
async function downloadAndConvertImage(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`下载图片失败: ${response.status}`);
    }

    const blob = await response.blob();

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.error('图片下载转换失败:', error);
    throw error;
  }
}

/**
 * 将Data URL转换为纯Base64
 */
function dataUrlToBase64(dataUrl: string): string {
  const parts = dataUrl.split(',');
  return parts.length > 1 ? parts[1] : dataUrl;
}

function looksLikeHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function toDataUrl(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

/**
 * 执行一次图像生成请求（SSE 流式读取）。
 * - JSON 解析失败的行会被跳过（记录警告）。
 * - status=failed 会立刻抛出，不会被吞掉。
 */
async function attemptOnce(
  requestBody: BananaProRequest,
  apiKey: string,
  onProgress?: ProgressCallback,
  attempt: number = 1
): Promise<string> {
  console.log('[生图请求][香蕉Pro]', {
    attempt,
    url: BANANA_PRO_API_URL,
    model: requestBody.model,
    prompt: requestBody.prompt,
    promptLength: requestBody.prompt.length,
    aspectRatio: requestBody.aspectRatio,
    imageSize: requestBody.imageSize,
    urlsCount: requestBody.urls?.length ?? 0,
  });

  const response = await fetch(BANANA_PRO_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  console.log('[香蕉Pro] 响应状态', { attempt, status: response.status, ok: response.ok });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`香蕉Pro API 错误 (${response.status}): ${errorText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('无法读取响应流');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;

      // --- 仅对 JSON.parse 加保护，业务逻辑错误必须向外抛 ---
      let data: BananaProResponse;
      try {
        data = JSON.parse(line.slice(6));
      } catch {
        // 非 JSON 格式的 SSE 行（如服务端原始错误文本），记录后跳过
        console.warn('[香蕉Pro] 非JSON SSE行（跳过）:', line.slice(6, 120));
        continue;
      }

      // 更新进度
      if (onProgress && data.progress !== undefined) {
        onProgress(data.progress);
      }

      // 失败状态 —— 立刻抛出，不能被后续 catch 吞掉
      if (data.status === 'failed') {
        const errorMsg =
          data.failure_reason === 'output_moderation' ? '生成的图像违反内容政策' :
          data.failure_reason === 'input_moderation'  ? '输入的提示词违反内容政策' :
          (data.error || '生成失败');
        throw new Error(errorMsg);
      }

      // 成功
      if (data.status === 'succeeded' && data.results && data.results.length > 0) {
        const imageUrl = data.results[0].url;
        console.log('[香蕉Pro] 生成成功，正在下载图片...', { attempt });

        const base64Image = await downloadAndConvertImage(imageUrl);
        if (onProgress) onProgress(100);
        return base64Image;
      }
    }
  }

  // 流结束但没有收到 succeeded 事件
  throw new Error('未收到有效的生成结果');
}

/**
 * 使用香蕉Pro生成图像（含自动重试）
 *
 * @param prompt 图像描述提示词
 * @param aspectRatio 宽高比 (16:9, 9:16, 1:1, 4:3, 3:4)
 * @param referenceImages 参考图像数组
 * @param imageSize 图像大小 (1K, 2K, 4K)
 * @param onProgress 进度回调函数
 * @returns Base64 Data URL格式的图像
 */
export const generateImageWithBananaPro = async (
  prompt: string,
  aspectRatio: string = '16:9',
  referenceImages: ReferenceImage[] = [],
  imageSize: '1K' | '2K' | '4K' = '2K',
  onProgress?: ProgressCallback,
  modelName: string = 'nano-banana-pro-vt',
  githubProjectId: string = 'storyweaver'
): Promise<string> => {
  const apiKey = process.env.GRSAI_API_KEY;

  if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
    throw new Error('请在 .env.local 文件中配置 GRSAI_API_KEY');
  }

  // 参考图上传放在重试循环之外，避免因重试造成重复上传
  const urls: string[] = (await Promise.all(
    referenceImages.map(async (img) => {
      const raw = String(img?.data ?? '').trim();
      if (!raw) return '';
      if (looksLikeHttpUrl(raw)) return raw;

      const base64 = raw.startsWith('data:') ? dataUrlToBase64(raw) : raw;
      const dataUrl = raw.startsWith('data:') ? raw : toDataUrl(img.mimeType, base64);
      return await uploadImageToGitHub(dataUrl, githubProjectId);
    })
  )).filter(Boolean);

  // 构建含参考图对应关系的完整提示词（使用共享工具函数，新增服务时同样必须调用）
  const fullPrompt = buildPromptWithRefs(prompt, referenceImages);

  const requestBody: BananaProRequest = {
    model: modelName,
    prompt: fullPrompt,
    aspectRatio,
    imageSize,
    urls: urls.length > 0 ? urls : undefined,
    shutProgress: false
  };

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 重试前等待（首次不等待）
    if (attempt > 1) {
      const delayMs = BASE_RETRY_DELAY_MS * (attempt - 1);
      console.warn(`[香蕉Pro] 第 ${attempt} 次重试，等待 ${delayMs / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      // 重置进度条，让用户感知到重试开始
      if (onProgress) onProgress(0);
    }

    try {
      return await attemptOnce(requestBody, apiKey, onProgress, attempt);
    } catch (error) {
      lastError = error;
      const msg = String((error as Error)?.message ?? error);

      console.error(`[香蕉Pro] 第 ${attempt}/${MAX_ATTEMPTS} 次尝试失败`, { error: msg });

      // 内容审核错误：不重试，直接抛出（交由上层改写流程处理）
      if (isModerationError(msg)) {
        throw error;
      }

      // 已耗尽重试次数
      if (attempt >= MAX_ATTEMPTS) break;

      // 非可重试错误（如 4xx、业务逻辑错误）：不再重试
      if (!isRetryableError(msg)) {
        console.error('[香蕉Pro] 非可重试错误，放弃重试');
        break;
      }
      // 可重试错误：继续循环
    }
  }

  console.error('[香蕉Pro] 生成最终失败', {
    error: String(lastError),
    stack: (lastError as Error)?.stack
  });
  throw lastError;
};
