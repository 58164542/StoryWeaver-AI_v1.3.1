/**
 * 前端 API 服务 - 与后端通信
 */

// API 基础 URL（开发环境默认使用 localhost:3001）
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

function toAbsoluteApiUrl(url: string) {
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

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
    }

    if (!data.success) {
      throw new Error(data.error || '请求失败');
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

export default {
  getAllProjects,
  getProject,
  createProject,
  updateProject,
  updateProjectSettings,
  updateProjectAssets,
  updateEpisode,
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
  checkHealth,
};
