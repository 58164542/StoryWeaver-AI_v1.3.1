import { Logger } from "../utils/logger";
import { uploadImageToGitHub } from "./githubImageService";
import { buildPromptWithRefs } from "../utils/imagePromptUtils";

const XSKILL_CREATE_URL = "https://api.xskill.ai/api/v3/tasks/create";
const XSKILL_QUERY_URL = "https://api.xskill.ai/api/v3/tasks/query";

interface XskillTaskResponse {
  code: number;
  data: {
    task_id: string;
    price: number;
  };
  message?: string;
}

interface XskillQueryResponse {
  code: number;
  data: {
    task_id?: string;
    status: 'completed' | 'success' | 'failed' | 'error' | 'pending' | 'processing';
    output?: {
      images?: Array<{ url: string; width: number | null; height: number | null; content_type?: string; file_name?: string }>;
    };
    error?: string;
  };
  message?: string;
}

/**
 * 使用速推中转 API（fal-ai/nano-banana-2）生成图片
 * 采用异步任务模式：创建任务 → 轮询查询 → 返回图片 URL
 *
 * @param prompt 生图提示词
 * @param aspectRatio 宽高比，如 "16:9"
 * @param referenceImages 参考图（base64 格式），会自动上传至 GitHub 获得 HTTP URL
 * @param projectId 项目 ID，用于 GitHub 图床路径组织
 * @param onProgress 进度回调 (0-100)
 * @returns 生成的图片 HTTP URL
 */
export const generateImageWithXskillNanoBanana2 = async (
  prompt: string,
  aspectRatio: string = '16:9',
  referenceImages: { name: string; data: string; mimeType: string }[] = [],
  projectId: string,
  onProgress?: (progress: number) => void
): Promise<string> => {
  const apiKey = process.env.NEX_API_KEY;
  if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
    throw new Error('请在 .env.local 文件中配置 NEX_API_KEY');
  }

  // 将 base64 参考图上传至 GitHub，获取可公开访问的 HTTP URL
  const imageUrls: string[] = [];
  for (const ref of referenceImages) {
    try {
      const dataUrl = `data:${ref.mimeType};base64,${ref.data}`;
      const uploaded = await uploadImageToGitHub(dataUrl, projectId);
      imageUrls.push(uploaded);
      Logger.logInfo('XskillImage 参考图上传成功', { name: ref.name, uploaded });
    } catch (e) {
      Logger.logError('XskillImage', `参考图上传失败，已跳过: ${ref.name}`, e);
    }
  }

  // 构建含参考图对应关系的完整提示词（使用共享工具函数，新增服务时同样必须调用）
  // ⚠️ 所有图片生成服务都必须执行此步骤：将参考图名称注入提示词，让模型知道"图1 = 角色X"
  const fullPrompt = buildPromptWithRefs(prompt, referenceImages);

  const params: Record<string, unknown> = {
    prompt: fullPrompt,
    num_images: 1,
    aspect_ratio: aspectRatio,
  };
  if (imageUrls.length > 0) {
    params.image_urls = imageUrls;
  }

  const createPayload = {
    model: "fal-ai/nano-banana-2",
    params,
    channel: null,
  };

  Logger.logRequest('XskillImage', 'createTask', XSKILL_CREATE_URL, createPayload);

  const createResponse = await fetch(XSKILL_CREATE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(createPayload),
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    throw new Error(`创建图片任务失败 (${createResponse.status}): ${errorText}`);
  }

  const createData: XskillTaskResponse = await createResponse.json();
  if (createData.code !== 200 || !createData.data?.task_id) {
    throw new Error(`创建任务失败: ${createData.message || '未知错误'}`);
  }

  const taskId = createData.data.task_id;
  Logger.logInfo('XskillImage 任务已创建', { taskId, price: createData.data.price });

  // 最多轮询 360 次（约 30 分钟，每次间隔 5s）
  const maxAttempts = 360;
  const pollInterval = 5000;
  let attempts = 0;

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    attempts++;

    const queryResponse = await fetch(XSKILL_QUERY_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ task_id: taskId }),
    });

    if (!queryResponse.ok) {
      const errorText = await queryResponse.text();
      throw new Error(`查询任务状态失败 (${queryResponse.status}): ${errorText}`);
    }

    const taskData: XskillQueryResponse = await queryResponse.json();
    if (taskData.code !== 200) {
      throw new Error(`查询任务失败: ${taskData.message || '未知错误'}`);
    }

    const status = taskData.data.status;
    Logger.logInfo('XskillImage 任务状态', { taskId, status, attempts });

    if (onProgress) {
      let progress = 0;
      if (status === 'pending') progress = 10;
      else if (status === 'processing') progress = Math.min(10 + (attempts / maxAttempts) * 80, 90);
      else if (status === 'completed' || status === 'success') progress = 100;
      onProgress(progress);
    }

    if (status === 'completed' || status === 'success') {
      const imageUrl = taskData.data.output?.images?.[0]?.url;
      if (!imageUrl) throw new Error('任务成功但未返回图片 URL');
      Logger.logInfo('XskillImage 图片生成成功', { taskId, imageUrl });
      return imageUrl;
    }

    if (status === 'failed' || status === 'error') {
      throw new Error(`图片生成失败: ${taskData.data.error || '未知错误'}`);
    }
  }

  throw new Error('图片生成超时，请稍后重试');
};
