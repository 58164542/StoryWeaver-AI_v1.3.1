/**
 * 柏拉图中转 nano banana（HD）图像生成
 * 端点: https://api.bltcy.ai/v1/images/generations
 * 模型: nano-banana-hd
 *
 * 说明：
 * - 该项目要求所有图片服务必须调用 buildPromptWithRefs() 注入参考图对应关系。
 * - 参考图先上传 GitHub 获取公网 URL，再以 OpenAI images API 风格的 `image[]` 传递。
 */

import { Logger } from "../utils/logger";
import { uploadImageToGitHub } from "./githubImageService";
import { buildPromptWithRefs } from "../utils/imagePromptUtils";

const BLTCY_IMAGES_API_URL = "https://api.bltcy.ai/v1/images/generations";
const BLTCY_NANO_BANANA_HD_MODEL = "nano-banana-hd";

interface ReferenceImage {
  name: string;
  data: string;
  mimeType: string;
}

type ProgressCallback = (progress: number) => void;

interface BltcyImagesResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
  error?: { message?: string };
}

function dataUrlToBase64(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

function toDataUrl(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

/**
 * 柏拉图中转：生成图片
 * @returns 图片 URL（优先）或 base64 data URL
 */
export const generateImageWithBltcyNanoBananaHd = async (
  prompt: string,
  aspectRatio: string = "16:9",
  referenceImages: ReferenceImage[] = [],
  projectId: string,
  onProgress?: ProgressCallback,
  model: string = BLTCY_NANO_BANANA_HD_MODEL
): Promise<string> => {
  const apiKey = process.env.BLTCY_API_KEY;
  if (!apiKey || apiKey === "PLACEHOLDER_API_KEY") {
    throw new Error("请在 .env.local 文件中配置 BLTCY_API_KEY");
  }

  if (onProgress) onProgress(5);

  // 参考图上传到 GitHub，得到公网 URL
  const referenceUrls: string[] = [];
  for (const ref of referenceImages) {
    try {
      const raw = String(ref?.data ?? "").trim();
      if (!raw) continue;
      const base64 = raw.startsWith("data:") ? dataUrlToBase64(raw) : raw;
      const dataUrl = raw.startsWith("data:") ? raw : toDataUrl(ref.mimeType, base64);
      const uploaded = await uploadImageToGitHub(dataUrl, projectId);
      referenceUrls.push(uploaded);
      Logger.logInfo("BltcyNanoBananaHd 参考图上传成功", { name: ref.name, uploaded });
    } catch (e) {
      Logger.logError("BltcyNanoBananaHd", `参考图上传失败，已跳过: ${ref?.name ?? "unknown"}`, e);
    }
  }

  if (onProgress) onProgress(15);

  // 注入“图1=角色X”之类的对应关系到提示词
  const fullPrompt = buildPromptWithRefs(prompt, referenceImages);

  const requestBody: any = {
    model,
    prompt: fullPrompt,
    n: 1,
    response_format: "url",
  };

  // 参考图字段：按 OpenAI images 风格传 image[]
  if (referenceUrls.length > 0) {
    requestBody.image = referenceUrls;
  }

  // 记录 aspectRatio（若上游不支持也无害），便于排查
  requestBody.aspect_ratio = aspectRatio;

  Logger.logRequest("BltcyNanoBananaHd", "images/generations", BLTCY_IMAGES_API_URL, {
    model,
    aspectRatio,
    promptLength: fullPrompt.length,
    referenceCount: referenceUrls.length,
  });

  if (onProgress) onProgress(20);

  const response = await fetch(BLTCY_IMAGES_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`柏拉图中转图片生成请求失败 (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as BltcyImagesResponse;
  if (result.error?.message) {
    throw new Error(result.error.message);
  }

  const first = result.data?.[0];
  if (first?.url) {
    if (onProgress) onProgress(100);
    return first.url;
  }
  if (first?.b64_json) {
    if (onProgress) onProgress(100);
    return `data:image/png;base64,${first.b64_json}`;
  }

  throw new Error("未从柏拉图中转响应中获取到图片（缺少 url/b64_json）");
};
