/**
 * 贾维斯中转图像生成服务
 * 模型: gemini-3.1-flash-image-preview
 * 端点: https://own-jarvis-api.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent
 * 参考图格式: URL（base64 参考图先上传 GitHub 转为 HTTP URL）
 * 响应格式: 返回图片 URL
 *
 * ⚠️ 新增图片生成服务规范（必须）：
 *    调用 buildPromptWithRefs() 将参考图对应关系注入提示词，
 *    否则模型不知道"图1 = 角色X"，角色一致性严重下降。
 */

import { Logger } from "../utils/logger";
import { uploadImageToGitHub } from "./githubImageService";
import { buildPromptWithRefs } from "../utils/imagePromptUtils";

const JARVIS_BASE_URL = "https://own-jarvis-api.com";
const JARVIS_MODEL = "gemini-3.1-flash-image-preview";

export const generateImageWithJarvisNanoBanana2 = async (
  prompt: string,
  aspectRatio: string = '16:9',
  referenceImages: { name: string; data: string; mimeType: string }[] = [],
  projectId: string,
  onProgress?: (progress: number) => void
): Promise<string> => {
  const apiKey = process.env.JARVIS_API_KEY;
  if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
    throw new Error('请在 .env.local 文件中配置 JARVIS_API_KEY');
  }

  if (onProgress) onProgress(5);

  // 将 base64 参考图上传至 GitHub，获取可公开访问的 HTTP URL
  const refParts: Array<{ file_data: { mime_type: string; file_uri: string } }> = [];
  for (const ref of referenceImages) {
    try {
      const dataUrl = `data:${ref.mimeType};base64,${ref.data}`;
      const uploaded = await uploadImageToGitHub(dataUrl, projectId);
      refParts.push({ file_data: { mime_type: ref.mimeType, file_uri: uploaded } });
      Logger.logInfo('JarvisImage 参考图上传成功', { name: ref.name, uploaded });
    } catch (e) {
      Logger.logError('JarvisImage', `参考图上传失败，已跳过: ${ref.name}`, e);
    }
  }

  // 构建含参考图对应关系的完整提示词（⚠️ 所有图片服务必须调用此函数）
  const fullPrompt = buildPromptWithRefs(prompt, referenceImages);

  // 文本在前，参考图紧随其后（Gemini 格式）
  const parts: unknown[] = [{ text: fullPrompt }, ...refParts];

  const requestBody = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: {
        aspectRatio,
        imageSize: "2K",
      },
    },
  };

  const url = `${JARVIS_BASE_URL}/v1beta/models/${JARVIS_MODEL}:generateContent?key=${apiKey}`;
  console.log('[生图请求][Jarvis]', {
    model: JARVIS_MODEL,
    prompt: fullPrompt,
    promptLength: fullPrompt.length,
    aspectRatio,
    referenceImagesCount: referenceImages.length,
    uploadedReferenceCount: refParts.length,
  });
  Logger.logRequest('JarvisImage', 'generateContent', url, { model: JARVIS_MODEL, aspectRatio, refCount: refParts.length });

  if (onProgress) onProgress(10);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`贾维斯图片生成请求失败 (${response.status}): ${errorText}`);
  }

  const responseData = await response.json();
  // 首次调试用，确认响应结构后可删除此行
  console.log('[JarvisImage] 完整响应:', JSON.stringify(responseData, null, 2));

  if (onProgress) onProgress(90);

  // 按优先级尝试提取图片 URL
  for (const candidate of (responseData.candidates ?? [])) {
    for (const part of (candidate?.content?.parts ?? [])) {
      // file_data.file_uri（snake_case URL 格式）
      if (part.file_data?.file_uri) {
        if (onProgress) onProgress(100);
        Logger.logInfo('JarvisImage 生成成功', { url: part.file_data.file_uri });
        return part.file_data.file_uri;
      }
      // fileData.fileUri（camelCase URL 格式）
      if (part.fileData?.fileUri) {
        if (onProgress) onProgress(100);
        Logger.logInfo('JarvisImage 生成成功', { url: part.fileData.fileUri });
        return part.fileData.fileUri;
      }
      // inlineData / inline_data（base64 兜底，转为 data URL）
      const inline = part.inlineData ?? part.inline_data;
      if (inline?.data) {
        if (onProgress) onProgress(100);
        const mimeType = inline.mime_type ?? inline.mimeType ?? 'image/png';
        Logger.logInfo('JarvisImage 生成成功（base64 兜底）', { mimeType });
        return `data:${mimeType};base64,${inline.data}`;
      }
    }
  }

  throw new Error('未从贾维斯响应中获取到图片，请检查控制台日志中的完整响应结构');
};
