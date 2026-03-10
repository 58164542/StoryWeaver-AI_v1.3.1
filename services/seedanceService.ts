import { Logger } from "../utils/logger";
import { uploadImageToGitHub, isBase64DataUrl } from "./githubImageService";

const SEEDANCE_CREATE_URL = "https://api.xskill.ai/api/v3/tasks/create";
const SEEDANCE_QUERY_URL = "https://api.xskill.ai/api/v3/tasks/query";

// 任务创建响应类型
interface SeedanceTaskResponse {
  code: number;
  data: {
    task_id: string;
    price: number;
  };
  message?: string;
}

// 任务查询响应类型
interface SeedanceQueryResponse {
  code: number;
  data: {
    status: 'completed' | 'success' | 'failed' | 'error' | 'pending' | 'processing';
    result?: {
      output?: {
        images?: string[];
      };
    };
    error?: string;
  };
  message?: string;
}

/**
 * 使用 Seedance 速推模型从多张参考图生成视频
 */
export const generateVideoWithSeedanceMultiRef = async (
  imageUrls: string[],
  prompt: string,
  aspectRatio: '16:9' | '9:16' | '1:1' | '4:3' | '3:4',
  duration: number = 5,
  projectId: string,
  model: string = 'seedance_2.0_fast',
  onProgress?: (progress: number) => void
): Promise<string> => {
  const apiKey = process.env.NEX_API_KEY;
  if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
    throw new Error('请在 .env.local 文件中配置 NEX_API_KEY');
  }

  // 上传所有 Base64 图片
  const finalUrls: string[] = [];
  for (const url of imageUrls) {
    if (isBase64DataUrl(url)) {
      const uploaded = await uploadImageToGitHub(url, projectId);
      finalUrls.push(uploaded);
    } else {
      finalUrls.push(url);
    }
  }

  const createPayload = {
    model: "st-ai/super-seed2",
    params: {
      model: model,
      prompt: prompt,
      media_files: finalUrls,
      aspect_ratio: aspectRatio,
      duration: duration.toString()
    },
    channel: null
  };

  Logger.logRequest('Seedance MultiRef', 'createTask', SEEDANCE_CREATE_URL, createPayload);

  const createResponse = await fetch(SEEDANCE_CREATE_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(createPayload)
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    throw new Error(`创建多参考视频任务失败 (${createResponse.status}): ${errorText}`);
  }

  const createData: SeedanceTaskResponse = await createResponse.json();
  if (createData.code !== 200 || !createData.data?.task_id) {
    throw new Error(`创建任务失败: ${createData.message || '未知错误'}`);
  }

  const taskId = createData.data.task_id;
  const maxAttempts = 720; // 约 60 分钟（720 * 5s）
  const pollInterval = 5000;
  let attempts = 0;

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    attempts++;

    const queryResponse = await fetch(SEEDANCE_QUERY_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId })
    });

    if (!queryResponse.ok) {
      const errorText = await queryResponse.text();
      throw new Error(`查询任务状态失败 (${queryResponse.status}): ${errorText}`);
    }

    const taskData: SeedanceQueryResponse = await queryResponse.json();
    if (taskData.code !== 200) throw new Error(`查询任务失败: ${taskData.message || '未知错误'}`);

    const status = taskData.data.status;
    if (onProgress) {
      let progress = 0;
      if (status === 'pending') progress = 10;
      else if (status === 'processing') progress = Math.min(10 + (attempts / maxAttempts) * 80, 90);
      else if (status === 'completed' || status === 'success') progress = 100;
      onProgress(progress);
    }

    if (status === 'completed' || status === 'success') {
      const videoUrl = taskData.data.result?.output?.images?.[0];
      if (!videoUrl) throw new Error('任务成功但未返回视频 URL');
      Logger.logInfo('Seedance MultiRef 视频生成成功', { taskId, videoUrl });
      return videoUrl;
    }

    if (status === 'failed' || status === 'error') {
      throw new Error(`视频生成失败: ${taskData.data.error || '未知错误'}`);
    }
  }

  throw new Error('视频生成超时，请稍后重试');
};

/**
 * 使用 Seedance 2.0 API 从图片生成视频
 * @param imageUrl 输入图片的URL（支持 HTTP URL 或 Base64）
 * @param prompt 视频生成提示词
 * @param aspectRatio 视频宽高比
 * @param duration 视频时长（秒）
 * @param projectId 项目 ID（用于 GitHub 图床路径）
 * @param onProgress 进度回调函数
 * @returns 生成的视频 URL
 */
export const generateVideoWithSeedance = async (
  imageUrl: string,
  prompt: string,
  aspectRatio: '16:9' | '9:16' | '1:1' | '4:3' | '3:4',
  duration: number = 5,
  projectId: string,
  onProgress?: (progress: number) => void
): Promise<string> => {
  const apiKey = process.env.NEX_API_KEY;

  if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
    throw new Error('请在 .env.local 文件中配置 NEX_API_KEY');
  }

  Logger.logInfo('开始创建 Seedance 2.0 视频生成任务', {
    imageUrl: imageUrl.substring(0, 50) + '...',
    prompt,
    aspectRatio,
    duration,
    projectId
  });

  // 步骤 0: 检测并处理 Base64 图片
  let finalImageUrl = imageUrl;
  if (isBase64DataUrl(imageUrl)) {
    Logger.logInfo('检测到 Base64 图片，开始上传到 GitHub', { projectId });
    try {
      finalImageUrl = await uploadImageToGitHub(imageUrl, projectId);
      Logger.logInfo('图片上传成功，获得 GitHub URL', { githubUrl: finalImageUrl });
    } catch (error) {
      Logger.logError('Seedance', 'Base64 图片上传失败', error);
      throw new Error(`图片上传到 GitHub 失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  } else {
    Logger.logInfo('使用现有的 HTTP URL', { imageUrl: finalImageUrl });
  }

  // 步骤1: 创建视频生成任务
  const createPayload = {
    model: "st-ai/super-seed2",
    params: {
      model: "seedance_2.0_fast",
      prompt: prompt,
      media_files: [finalImageUrl], // 使用处理后的 URL（Base64 已上传到 GitHub）
      aspect_ratio: aspectRatio,
      duration: duration.toString()
    },
    channel: null
  };

  Logger.logRequest('Seedance 2.0', 'createTask', SEEDANCE_CREATE_URL, createPayload);

  const createResponse = await fetch(SEEDANCE_CREATE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(createPayload)
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    Logger.logError('Seedance', '创建视频生成任务失败', {
      status: createResponse.status,
      error: errorText
    });
    throw new Error(`创建视频生成任务失败 (${createResponse.status}): ${errorText}`);
  }

  const createData: SeedanceTaskResponse = await createResponse.json();

  if (createData.code !== 200 || !createData.data?.task_id) {
    Logger.logError('Seedance', 'API返回错误', createData);
    throw new Error(`创建任务失败: ${createData.message || '未知错误'}`);
  }

  const taskId = createData.data.task_id;
  Logger.logInfo('Seedance 视频生成任务已创建', {
    taskId,
    price: createData.data.price
  });

  // 步骤2: 轮询查询任务状态
  const maxAttempts = 720; // 最多轮询 720 次（60 分钟）
  const pollInterval = 5000; // 每 5 秒轮询一次
  let attempts = 0;

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    attempts++;

    const queryPayload = {
      task_id: taskId
    };

    const queryResponse = await fetch(SEEDANCE_QUERY_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(queryPayload)
    });

    if (!queryResponse.ok) {
      const errorText = await queryResponse.text();
      Logger.logError('Seedance', '查询任务状态失败', {
        status: queryResponse.status,
        error: errorText
      });
      throw new Error(`查询任务状态失败 (${queryResponse.status}): ${errorText}`);
    }

    const taskData: SeedanceQueryResponse = await queryResponse.json();

    if (taskData.code !== 200) {
      Logger.logError('Seedance', '查询API返回错误', taskData);
      throw new Error(`查询任务失败: ${taskData.message || '未知错误'}`);
    }

    const status = taskData.data.status;
    Logger.logInfo('Seedance 任务状态', { taskId, status, attempts });

    // 步骤3: 更新进度
    if (onProgress) {
      let progress = 0;
      if (status === 'pending') {
        progress = 10;
      } else if (status === 'processing') {
        // 处理中时，根据轮询次数估算进度（10% - 90%）
        progress = Math.min(10 + (attempts / maxAttempts) * 80, 90);
      } else if (status === 'completed' || status === 'success') {
        progress = 100;
      }
      onProgress(progress);
    }

    // 步骤4: 处理完成状态
    if (status === 'completed' || status === 'success') {
      const videoUrl = taskData.data.result?.output?.images?.[0];
      if (!videoUrl) {
        throw new Error('任务成功但未返回视频 URL');
      }
      Logger.logInfo('Seedance 视频生成成功', { taskId, videoUrl });
      return videoUrl;
    }

    // 步骤5: 处理失败状态
    if (status === 'failed' || status === 'error') {
      const errorMsg = taskData.data.error || '未知错误';
      Logger.logError('Seedance', '视频生成失败', { taskId, error: errorMsg });
      throw new Error(`视频生成失败: ${errorMsg}`);
    }
  }

  // 超过最大轮询次数
  Logger.logError('Seedance', '视频生成超时', { taskId, attempts });
  throw new Error('视频生成超时，请稍后重试');
};
