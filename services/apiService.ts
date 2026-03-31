/**
 * 前端 API 服务 - 与后端通信
 */

function resolveApiBaseUrl() {
  const configuredUrl = import.meta.env.VITE_API_URL || process.env.VITE_API_URL;
  if (configuredUrl) {
    return configuredUrl;
  }

  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:3001`;
  }

  return 'http://localhost:3001';
}

function resolveSeedanceApiUrl() {
  const configuredUrl = import.meta.env.VITE_SEEDANCE_API_URL || process.env.SEEDANCE_API_URL;
  if (configuredUrl) {
    return configuredUrl;
  }

  try {
    const apiUrl = new URL(
      API_BASE_URL,
      typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'
    );
    return `${apiUrl.protocol}//${apiUrl.hostname}:3005`;
  } catch {
    if (typeof window !== 'undefined') {
      return `${window.location.protocol}//${window.location.hostname}:3005`;
    }
    return 'http://localhost:3005';
  }
}

const API_BASE_URL = resolveApiBaseUrl();
export const SEEDANCE_API_URL = resolveSeedanceApiUrl();

export function toAbsoluteApiUrl(url: string) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return `${API_BASE_URL}${url}`;
}

/**
 * 通用请求函数
 */
async function request(url: string, options: RequestInit = {}) {
  try {
    const response = await fetch(`${API_BASE_URL}${url}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    const rawText = await response.text();
    const contentType = response.headers.get('content-type') || '';
    let data: any = null;

    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch {
        const trimmed = rawText.trim();
        const isHtmlResponse = contentType.includes('text/html') || /^<!DOCTYPE html>/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);
        if (isHtmlResponse) {
          throw new Error(`接口返回了 HTML 而不是 JSON [${url}]。通常是后端未重启、API 路由不存在，或 VITE_API_URL 指到了前端服务。`);
        }

        throw new Error(`接口返回的不是合法 JSON [${url}]：${trimmed.slice(0, 200)}`);
      }
    }

    if (!response.ok) {
      throw new Error(data?.error || `HTTP ${response.status}: ${response.statusText}`);
    }

    if (!data?.success) {
      throw new Error(data?.error || '请求失败');
    }

    return data.data;
  } catch (error) {
    console.error(`API 请求失败 [${url}]:`, error);
    throw error;
  }
}

// ==================== 项目相关 API ====================

/**
 * 获取所有项目列表
 */
export async function getAllProjects() {
  return request('/api/projects');
}

/**
 * 获取单个项目的完整数据
 */
export async function getProject(projectId: string) {
  return request(`/api/projects/${projectId}`);
}

/**
 * 创建新项目
 */
export async function createProject(project: any) {
  return request('/api/projects', {
    method: 'POST',
    body: JSON.stringify(project),
  });
}

/**
 * 更新项目（完整更新，用于导入/复制等场景）
 */
export async function updateProject(projectId: string, project: any) {
  return request(`/api/projects/${projectId}`, {
    method: 'PUT',
    body: JSON.stringify(project),
  });
}

/**
 * 更新项目元数据（只更新 name / type，不触碰 episodes / characters / settings）
 */
export async function updateProjectMeta(projectId: string, meta: { name?: string; type?: string }) {
  return request(`/api/projects/${projectId}/meta`, {
    method: 'PUT',
    body: JSON.stringify(meta),
  });
}

/**
 * 更新项目设置（只更新 settings 字段）
 */
export async function updateProjectSettings(projectId: string, settings: any) {
  return request(`/api/projects/${projectId}/settings`, {
    method: 'PUT',
    body: JSON.stringify(settings),
  });
}

/**
 * 更新项目资产（只更新 characters/scenes/variants 字段）
 */
export async function updateProjectAssets(projectId: string, assets: { characters?: any[]; scenes?: any[]; variants?: any[] }) {
  return request(`/api/projects/${projectId}/assets`, {
    method: 'PUT',
    body: JSON.stringify(assets),
  });
}

/**
 * 更新单个分集（只更新指定分集）
 */
export async function updateEpisode(projectId: string, episodeId: string, episode: any) {
  return request(`/api/projects/${projectId}/episodes/${episodeId}`, {
    method: 'PUT',
    body: JSON.stringify(episode),
  });
}

// ==================== 分集回收站 API ====================

/**
 * 软删除分集（移入项目分集回收站）
 */
export async function deleteEpisode(projectId: string, episodeId: string) {
  return request(`/api/projects/${projectId}/episodes/${episodeId}`, {
    method: 'DELETE',
  });
}

/**
 * 获取项目的分集回收站列表
 */
export async function getEpisodeRecycleBin(projectId: string) {
  return request(`/api/projects/${projectId}/episode-recycle-bin`);
}

/**
 * 恢复回收站中的分集
 */
export async function restoreEpisode(projectId: string, episodeId: string) {
  return request(`/api/projects/${projectId}/episode-recycle-bin/${episodeId}/restore`, {
    method: 'POST',
  });
}

/**
 * 永久删除回收站中的分集
 */
export async function deleteEpisodePermanently(projectId: string, episodeId: string) {
  return request(`/api/projects/${projectId}/episode-recycle-bin/${episodeId}`, {
    method: 'DELETE',
  });
}

/**
 * 删除项目
 */
export async function deleteProject(projectId: string) {
  return request(`/api/projects/${projectId}`, {
    method: 'DELETE',
  });
}

/**
 * 获取回收站列表
 */
export async function getRecycleBin() {
  try {
    return await request('/api/recycle-bin');
  } catch (error) {
    return await request('/api/projects/recycle-bin');
  }
}

/**
 * 恢复回收站项目
 */
export async function restoreProject(projectId: string) {
  try {
    return await request(`/api/recycle-bin/${projectId}/restore`, {
      method: 'POST',
    });
  } catch (error) {
    return await request(`/api/projects/recycle-bin/${projectId}/restore`, {
      method: 'POST',
    });
  }
}

/**
 * 永久删除回收站项目
 */
export async function deleteProjectPermanently(projectId: string) {
  try {
    return await request(`/api/recycle-bin/${projectId}`, {
      method: 'DELETE',
    });
  } catch (error) {
    return await request(`/api/projects/recycle-bin/${projectId}`, {
      method: 'DELETE',
    });
  }
}

// ==================== 全局设置 API ====================

/**
 * 获取全局设置
 */
export async function getSettings() {
  return request('/api/settings');
}

/**
 * 更新全局设置
 */
export async function updateSettings(settings: any) {
  return request('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  });
}

// ==================== 媒体文件 API ====================

/**
 * 上传媒体文件（Base64）
 */
export async function uploadMedia(base64Data: string, filename: string) {
  const data = await request('/api/media/upload', {
    method: 'POST',
    body: JSON.stringify({ base64Data, filename }),
  });
  if (data?.url && typeof data.url === 'string' && data.url.startsWith('/')) {
    return { ...data, url: `${API_BASE_URL}${data.url}` };
  }
  return data;
}

/**
 * 将后端媒体 URL 读取为 base64 DataURL（绕过跨域 fetch 问题）
 */
export async function readMediaAsBase64(url: string): Promise<string> {
  const data = await request('/api/media/read-as-base64', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
  return data.base64Data as string;
}

/**
 * 拉取外部视频并保存到本地媒体目录
 */
export async function saveExternalVideo(url: string, filename?: string) {
  const data = await request('/api/media/save-external-video', {
    method: 'POST',
    body: JSON.stringify({ url, filename }),
  });
  if (data?.url && typeof data.url === 'string' && data.url.startsWith('/')) {
    return { ...data, url: `${API_BASE_URL}${data.url}` };
  }
  return data;
}

/**
 * 拉取外部图片并保存到本地媒体目录
 */
export async function saveExternalImage(url: string, filename?: string) {
  const data = await request('/api/media/save-external-image', {
    method: 'POST',
    body: JSON.stringify({ url, filename }),
  });
  if (data?.url && typeof data.url === 'string' && data.url.startsWith('/')) {
    return { ...data, url: `${API_BASE_URL}${data.url}` };
  }
  return data;
}

/**
 * 删除媒体文件
 */
export async function deleteMedia(type: 'images' | 'videos' | 'audio', filename: string) {
  return request(`/api/media/${type}/${filename}`, {
    method: 'DELETE',
  });
}

/**
 * 获取媒体文件 URL
 */
export function getMediaUrl(type: 'images' | 'videos' | 'audio', filename: string) {
  return `${API_BASE_URL}/api/media/${type}/${filename}`;
}

/**
 * 导出当前分集的分镜图 ZIP
 */
export async function exportEpisodeStoryboardImagesZip(projectId: string, episodeId: string) {
  const data = await request(`/api/projects/${projectId}/episodes/${episodeId}/storyboard-images/export`, {
    method: 'POST',
  });

  return {
    ...data,
    downloadUrl: typeof data?.downloadUrl === 'string' ? toAbsoluteApiUrl(data.downloadUrl) : data?.downloadUrl,
  };
}

/**
 * 导出当前项目的资产图 ZIP
 */
export async function exportProjectAssetImagesZip(projectId: string) {
  const data = await request(`/api/projects/${projectId}/asset-images/export`, {
    method: 'POST',
  });

  return {
    ...data,
    downloadUrl: typeof data?.downloadUrl === 'string' ? toAbsoluteApiUrl(data.downloadUrl) : data?.downloadUrl,
  };
}

// ==================== Seedance Session API ====================

export async function getSeedanceSessions() {
  return request('/api/seedance-sessions');
}

export async function addSeedanceSession(sessionId: string, name: string) {
  return request('/api/seedance-sessions', {
    method: 'POST',
    body: JSON.stringify({ sessionId, name }),
  });
}

export async function updateSeedanceSession(id: string, updates: any) {
  return request(`/api/seedance-sessions/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export async function deleteSeedanceSession(id: string) {
  return request(`/api/seedance-sessions/${id}`, {
    method: 'DELETE',
  });
}

export async function querySeedanceSessionCredits(id: string) {
  const response = await fetch(`${SEEDANCE_API_URL}/api/sessions/${id}/query-credits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data.data;
}

export async function getSeedanceSessionsStatus() {
  const result = await request('/api/seedance-sessions');
  return result?.data || result;
}

export async function getSeedanceSessionFullById(id: string): Promise<string | null> {
  const result = await request('/api/seedance-sessions/full');
  const sessions: Array<{ id: string; sessionId: string }> = result?.data || result || [];
  return sessions.find(s => s.id === id)?.sessionId ?? null;
}

export async function resetInsufficientSessions() {
  return request('/api/seedance-sessions/reset-insufficient', { method: 'POST' });
}

export async function syncSeedanceSessions() {
  // 通知微服务从中心后端刷新缓存
  try {
    const response = await fetch(`${SEEDANCE_API_URL}/api/sessions/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || `HTTP ${response.status}`);
    }
    return data.data;
  } catch {
    // 微服务不可达时静默失败，不影响中心后端操作
    return null;
  }
}

// ==================== 健康检查 ====================

/**
 * 检查服务器是否在线
 */
export async function checkHealth() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/health`);
    return response.ok;
  } catch (error) {
    return false;
  }
}

/**
 * 轻量更新单个分镜的文本字段（imagePrompt / videoPrompt 等）。
 * 不传输整个项目 base64 数据，避免 request entity too large。
 */
export async function updateFrameTextFields(
  projectId: string,
  episodeId: string,
  frameId: string,
  updates: { imagePrompt?: string; videoPrompt?: string; imageError?: string; videoError?: string }
) {
  return request(`/api/projects/${projectId}/frames/${frameId}`, {
    method: 'PATCH',
    body: JSON.stringify({ episodeId, ...updates }),
  });
}

export async function recordProjectTextUsage(
  projectId: string,
  payload: {
    provider: string;
    model: string;
    taskType: string;
    idempotencyKey: string;
    usage: any;
  }
) {
  return request(`/api/projects/${projectId}/stats/text-usage`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateFrameVideo(
  projectId: string,
  episodeId: string,
  frameId: string,
  payload: {
    videoUrl: string;
    videoDuration?: number;
    successTaskKey?: string;
  }
) {
  return request(`/api/projects/${projectId}/frames/${frameId}/video`, {
    method: 'PATCH',
    body: JSON.stringify({ episodeId, ...payload }),
  });
}

/**
 * 根据项目类型获取分段预处理提示词
 */
export async function getSegmentSkillPrompt(projectType?: string) {
  const settings = await getSettings();
  const type = projectType || 'REAL_PERSON_COMMENTARY';
  const prompts = settings.projectTypePrompts?.[type];

  if (!prompts) {
    throw new Error(`未找到项目类型 ${type} 的提示词配置`);
  }

  const content = prompts.preprocessSegmentPrompt;
  if (!content) {
    throw new Error(`项目类型 ${type} 的分段预处理提示词为空`);
  }

  return { content };
}

export async function createNovelPreprocessTask(payload: {
  projectId: string;
  projectType?: string;
  novelText: string;
  episodeDrafts: Array<{ title: string; content: string }>;
  systemInstruction: string;
  segmentPrompt: string;
  secondPassPrompt?: string;
  enableSecondPass?: boolean;
}) {
  return request('/api/preprocess/novel', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function createEpisodePreprocessTask(payload: {
  projectId: string;
  episodeId: string;
  episodeName: string;
  content: string;
  segmentPrompt: string;
  secondPassPrompt?: string;
  enableSecondPass?: boolean;
}) {
  return request('/api/preprocess/episode', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function getPreprocessTask(taskId: string) {
  return request(`/api/preprocess/tasks/${taskId}`);
}

export async function listPreprocessTasks(projectId?: string) {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return request(`/api/preprocess/tasks${query}`);
}

export async function markPreprocessTaskApplied(taskId: string) {
  return request(`/api/preprocess/tasks/${taskId}/applied`, {
    method: 'POST',
  });
}

export async function deletePreprocessTask(taskId: string) {
  return request(`/api/preprocess/tasks/${taskId}`, {
    method: 'DELETE',
  });
}

export default {
  getAllProjects,
  getProject,
  createProject,
  updateProject,
  updateProjectMeta,
  updateProjectSettings,
  updateProjectAssets,
  updateEpisode,
  deleteEpisode,
  getEpisodeRecycleBin,
  restoreEpisode,
  deleteEpisodePermanently,
  deleteProject,
  getSettings,
  updateSettings,
  uploadMedia,
  saveExternalVideo,
  saveExternalImage,
  deleteMedia,
  getMediaUrl,
  exportEpisodeStoryboardImagesZip,
  exportProjectAssetImagesZip,
  getSeedanceSessions,
  addSeedanceSession,
  updateSeedanceSession,
  deleteSeedanceSession,
  querySeedanceSessionCredits,
  getSeedanceSessionsStatus,
  getSeedanceSessionFullById,
  resetInsufficientSessions,
  syncSeedanceSessions,
  checkHealth,
  recordProjectTextUsage,
  updateFrameVideo,
  getSegmentSkillPrompt,
  createNovelPreprocessTask,
  createEpisodePreprocessTask,
  getPreprocessTask,
  listPreprocessTasks,
  markPreprocessTaskApplied,
  deletePreprocessTask,
};
