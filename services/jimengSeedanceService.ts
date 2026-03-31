/**
 * 即梦 Seedance 2.0 直连视频生成服务
 * 通过独立微服务 (port 3005) 调用即梦 API
 */
import { isBase64DataUrl } from './githubImageService';
import { readMediaAsBase64, SEEDANCE_API_URL } from './apiService';

/** taskId → sessionName 映射，用于错误日志展示账号信息 */
const taskSessionMap = new Map<string, string>();

async function dataUrlToFile(dataUrl: string, filename: string): Promise<File> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return new File([blob], filename, { type: blob.type || 'image/png' });
}

function inferExtension(mimeType?: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'png';
}

async function resolveImageToFile(
  imageUrl: string,
  index: number,
  fallbackUrl?: string
): Promise<File> {
  const normalized = (imageUrl || '').trim() || (fallbackUrl || '').trim();
  if (!normalized) throw new Error(`第${index + 1}张参考图缺少 URL`);

  if (isBase64DataUrl(normalized)) {
    const mimeType = normalized.match(/^data:(.+?);base64,/)?.[1] || 'image/png';
    return dataUrlToFile(normalized, `reference_${index + 1}.${inferExtension(mimeType)}`);
  }

  try {
    const response = await fetch(normalized);
    if (response.ok) {
      const blob = await response.blob();
      return new File([blob], `reference_${index + 1}.${inferExtension(blob.type)}`, {
        type: blob.type || 'image/png'
      });
    }
    console.warn(`[jimeng-seedance] 第${index + 1}张参考图直接下载失败 (HTTP ${response.status})，尝试后端转存: ${normalized.substring(0, 80)}`);
  } catch (fetchErr) {
    console.warn(`[jimeng-seedance] 第${index + 1}张参考图直接下载失败，尝试后端转存: ${normalized.substring(0, 80)}`, fetchErr);
  }

  const base64Data = await readMediaAsBase64(normalized);
  return dataUrlToFile(base64Data, `reference_${index + 1}.png`);
}

export const pollJimengSeedanceTask = async (
  taskId: string,
  onProgress?: (progress: number, sessionName?: string) => void
): Promise<string> => {
  const maxAttempts = 6000;
  const pollInterval = 600000; // 10分钟（与后端保持一致）
  let consecutiveFetchErrors = 0;
  const maxConsecutiveFetchErrors = 5;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    let statusResponse: Response;
    try {
      statusResponse = await fetch(`${SEEDANCE_API_URL}/api/task/${taskId}`);
      consecutiveFetchErrors = 0;
    } catch (fetchErr) {
      consecutiveFetchErrors++;
      const sessionName = taskSessionMap.get(taskId) || '未知账号';
      const errDetail = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      console.warn(`[jimeng-seedance] 轮询网络错误 (${consecutiveFetchErrors}/${maxConsecutiveFetchErrors}) [taskId=${taskId}] [session=${sessionName}] [url=${SEEDANCE_API_URL}/api/task/${taskId}]: ${errDetail}`);
      if (consecutiveFetchErrors >= maxConsecutiveFetchErrors) {
        throw new Error(`即梦微服务连接失败 [taskId=${taskId}] [session=${sessionName}] [${SEEDANCE_API_URL}]: ${errDetail}`);
      }
      continue;
    }

    if (!statusResponse.ok) {
      if (statusResponse.status === 404) {
        throw new Error(`任务已丢失，请重新生成 [taskId=${taskId}]`);
      }
      console.warn(`[jimeng-seedance] 轮询失败: ${statusResponse.status} [taskId=${taskId}]`);
      continue;
    }

    const statusData = await statusResponse.json();
    const sessionName = statusData.sessionName || taskSessionMap.get(taskId);

    if (statusData.status === 'waiting') {
      // 后端正在等待可用账号，显示排队状态，不计入进度
      if (onProgress) onProgress(1, sessionName);
      continue;
    }

    if (statusData.status === 'done') {
      if (onProgress) onProgress(100, sessionName);
      const videoUrl = statusData.result?.data?.[0]?.url;
      if (!videoUrl) throw new Error(`视频生成成功但未返回 URL [taskId=${taskId}]`);
      const savedLocally = statusData.result?.data?.[0]?.savedLocally;
      taskSessionMap.delete(taskId);
      // 如果微服务已将视频保存到主后端，直接返回本地 URL；否则走 proxy
      if (savedLocally) return videoUrl;
      return `${SEEDANCE_API_URL}/api/video-proxy?url=${encodeURIComponent(videoUrl)}`;
    }

    if (statusData.status === 'error') {
      const errSessionName = sessionName || '未知账号';
      taskSessionMap.delete(taskId);
      throw new Error(`${statusData.error || '即梦视频生成失败'} [taskId=${taskId}] [session=${errSessionName}]`);
    }

    if (onProgress) {
      const elapsed = statusData.elapsed || 0;
      const progressText: string = statusData.progress || '';
      let progress: number;

      // 根据后端实际阶段文本映射进度，比纯 elapsed 更准确
      if (progressText.includes('下载参考图片') || progressText.includes('下载第')) {
        progress = 5;
      } else if (progressText.includes('上传参考图片') || progressText.includes('上传第')) {
        progress = 10;
      } else if (progressText.includes('提交视频生成')) {
        progress = 18;
      } else if (progressText.includes('等待AI生成') || progressText.includes('AI正在生成')) {
        // 生成阶段：20-80，按 elapsed 递增
        progress = Math.min(20 + ((elapsed - 10) / 240) * 60, 80);
      } else if (progressText.includes('已等待')) {
        progress = Math.min(50 + ((elapsed - 60) / 300) * 35, 85);
      } else if (progressText.includes('获取高清') || progressText.includes('保存视频')) {
        progress = 90;
      } else {
        // 兜底：按 elapsed 平滑递增
        if (elapsed < 30) {
          progress = 5 + (elapsed / 30) * 15;
        } else if (elapsed < 120) {
          progress = 20 + ((elapsed - 30) / 90) * 40;
        } else {
          progress = Math.min(60 + ((elapsed - 120) / 300) * 30, 90);
        }
      }

      // 每 10 分钟打印一次日志（200 次轮询 × 3 秒 = 600 秒）
      if (attempt % 200 === 0) {
        const sessionInfo = sessionName ? ` [session=${sessionName}]` : '';
        console.log(`[jimeng-seedance] ${taskId}${sessionInfo} [${elapsed}s] ${progressText || 'processing'} → ${Math.round(progress)}%`);
      }
      onProgress(Math.round(progress), sessionName);
    }
  }

  throw new Error('即梦视频生成超时，请稍后重试');
};

async function submitJimengSeedanceTask(
  files: File[],
  prompt: string,
  aspectRatio: '16:9' | '9:16' | '1:1' | '4:3' | '3:4',
  duration: number,
  model: string,
  projectId?: string,
  episodeId?: string,
  frameId?: string
): Promise<string> {
  const formData = new FormData();
  formData.append('prompt', prompt);
  formData.append('ratio', aspectRatio);
  formData.append('duration', String(duration));
  formData.append('model', model);
  if (projectId) formData.append('projectId', projectId);
  if (episodeId) formData.append('episodeId', episodeId);
  if (frameId) formData.append('frameId', frameId);

  for (const file of files) {
    formData.append('files', file);
  }

  const submitUrl = `${SEEDANCE_API_URL}/api/generate-video`;
  let response: Response;
  try {
    response = await fetch(submitUrl, {
      method: 'POST',
      body: formData,
    });
  } catch (fetchErr) {
    const errDetail = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    throw new Error(`无法连接到即梦微服务 [${submitUrl}]: ${errDetail}`);
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(`${err.error || `即梦 Seedance 请求失败: ${response.status}`} [${submitUrl}]`);
  }

  const { taskId, sessionName } = await response.json();
  if (!taskId) throw new Error('未获取到任务 ID');

  if (sessionName) taskSessionMap.set(taskId, sessionName);
  console.log(`[jimeng-seedance] 任务已提交: ${taskId}, session: ${sessionName || '未知'}`);
  return taskId;
}

export const submitJimengSeedanceImageToVideoTask = async (
  imageUrl: string,
  prompt: string,
  aspectRatio: '16:9' | '9:16' | '1:1' | '4:3' | '3:4',
  duration: number = 5,
  projectId: string,
  model: string = 'seedance-2.0',
  githubImageUrl?: string,
  episodeId?: string,
  frameId?: string
): Promise<string> => {
  const file = await resolveImageToFile(imageUrl, 0, githubImageUrl);
  return submitJimengSeedanceTask([file], prompt, aspectRatio, duration, model, projectId, episodeId, frameId);
};

export const submitJimengSeedanceMultiRefTask = async (
  imageUrls: string[],
  prompt: string,
  aspectRatio: '16:9' | '9:16' | '1:1' | '4:3' | '3:4',
  duration: number = 5,
  projectId: string,
  model: string = 'seedance-2.0',
  episodeId?: string,
  frameId?: string
): Promise<string> => {
  const files: File[] = [];
  for (let index = 0; index < imageUrls.length; index++) {
    files.push(await resolveImageToFile(imageUrls[index], index));
  }
  return submitJimengSeedanceTask(files, prompt, aspectRatio, duration, model, projectId, episodeId, frameId);
};

export const generateVideoWithJimengSeedance = async (
  imageUrl: string,
  prompt: string,
  aspectRatio: '16:9' | '9:16' | '1:1' | '4:3' | '3:4',
  duration: number = 5,
  projectId: string,
  onProgress?: (progress: number) => void,
  model: string = 'seedance-2.0',
  githubImageUrl?: string,
  episodeId?: string,
  frameId?: string
): Promise<string> => {
  if (onProgress) onProgress(2);
  const taskId = await submitJimengSeedanceImageToVideoTask(
    imageUrl,
    prompt,
    aspectRatio,
    duration,
    projectId,
    model,
    githubImageUrl,
    episodeId,
    frameId
  );
  if (onProgress) onProgress(5);
  return pollJimengSeedanceTask(taskId, onProgress);
};

export const generateVideoWithJimengSeedanceMultiRef = async (
  imageUrls: string[],
  prompt: string,
  aspectRatio: '16:9' | '9:16' | '1:1' | '4:3' | '3:4',
  duration: number = 5,
  projectId: string,
  onProgress?: (progress: number) => void,
  model: string = 'seedance-2.0',
  episodeId?: string,
  frameId?: string
): Promise<string> => {
  if (onProgress) onProgress(2);
  const taskId = await submitJimengSeedanceMultiRefTask(
    imageUrls,
    prompt,
    aspectRatio,
    duration,
    projectId,
    model,
    episodeId,
    frameId
  );
  if (onProgress) onProgress(5);
  return pollJimengSeedanceTask(taskId, onProgress);
};

export interface ActiveTask {
  id: string;
  status: string;
  projectId: string;
  episodeId: string;
  frameId: string;
  sessionName: string;
  progress: string;
  elapsed: number;
  startTime: number;
}

export const getActiveTasks = async (): Promise<ActiveTask[]> => {
  const response = await fetch(`${SEEDANCE_API_URL}/api/tasks`);
  if (!response.ok) throw new Error('获取任务列表失败');
  const data = await response.json();
  return data.data || [];
};
