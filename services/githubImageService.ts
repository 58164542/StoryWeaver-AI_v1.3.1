import { Logger } from "../utils/logger";

/**
 * GitHub 图片上传服务
 * 用于将 Base64 图片上传到 GitHub 私有仓库，获取 HTTP URL
 */

// GitHub API 配置
const GITHUB_API_BASE = "https://api.github.com";

interface GitHubUploadResponse {
  content: {
    name: string;
    path: string;
    sha: string;
    size: number;
    url: string;
    html_url: string;
    git_url: string;
    download_url: string;
    type: string;
  };
}

interface GitHubContentResponse {
  sha: string;
}

/**
 * 从 Base64 Data URL 中提取 MIME type 和纯 Base64 数据
 */
function parseDataUrl(dataUrl: string): { mimeType: string; base64Data: string } {
  const matches = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!matches) {
    throw new Error('无效的 Base64 Data URL 格式');
  }
  return {
    mimeType: matches[1],
    base64Data: matches[2]
  };
}

/**
 * 根据 MIME type 获取文件扩展名
 */
function getFileExtension(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp'
  };
  return mimeToExt[mimeType] || 'png';
}

/**
 * 生成唯一的文件名
 */
function generateFileName(projectId: string, mimeType: string): string {
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(2, 10);
  const extension = getFileExtension(mimeType);
  return `${timestamp}_${randomId}.${extension}`;
}

const inFlightByKey = new Map<string, Promise<string>>();
const completedByKey = new Map<string, string>();

const MAX_UPLOAD_CACHE_SIZE = 2000;

const pruneCompletedCache = () => {
  if (completedByKey.size <= MAX_UPLOAD_CACHE_SIZE) return;
  const removeCount = Math.max(1, Math.floor(MAX_UPLOAD_CACHE_SIZE * 0.2));
  const keys = Array.from(completedByKey.keys()).slice(0, removeCount);
  for (const k of keys) completedByKey.delete(k);
};

let githubUploadActive = 0;
const githubUploadWaiters: Array<() => void> = [];
const GITHUB_UPLOAD_CONCURRENCY = 1;

const withGithubUploadSlot = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (githubUploadActive >= GITHUB_UPLOAD_CONCURRENCY) {
    await new Promise<void>(resolve => githubUploadWaiters.push(resolve));
  }
  githubUploadActive++;
  try {
    return await fn();
  } finally {
    githubUploadActive--;
    const next = githubUploadWaiters.shift();
    if (next) next();
  }
};

const sha1Hex = async (input: string): Promise<string> => {
  const data = new TextEncoder().encode(input);
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!subtle) {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = (hash * 31 + input.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(16);
  }
  const digest = await subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
};

const tryParseJson = (text: string): any | null => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * 上传 Base64 图片到 GitHub 仓库
 * @param base64DataUrl Base64 格式的图片数据
 * @param projectId 项目 ID（用于组织路径）
 * @returns GitHub 图片的公开访问 URL
 */
export const uploadImageToGitHub = async (
  base64DataUrl: string,
  projectId: string
): Promise<string> => {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  // 验证环境变量
  if (!token || token === 'PLACEHOLDER_TOKEN') {
    throw new Error('请在 .env.local 文件中配置 GITHUB_TOKEN');
  }
  if (!owner) {
    throw new Error('请在 .env.local 文件中配置 GITHUB_OWNER');
  }
  if (!repo) {
    throw new Error('请在 .env.local 文件中配置 GITHUB_REPO');
  }

  Logger.logInfo('开始上传图片到 GitHub', { projectId, repo: `${owner}/${repo}` });

  try {
    // 解析 Base64 数据
    const { mimeType, base64Data } = parseDataUrl(base64DataUrl);
    Logger.logInfo('解析图片数据', { mimeType, base64Length: base64Data.length });

    const extension = getFileExtension(mimeType);
    const contentHash = await sha1Hex(`${mimeType}:${base64Data}`);
    const fileName = `${contentHash}.${extension}`;
    const filePath = `images/${projectId}/${fileName}`;

    Logger.logInfo('准备上传文件', { filePath, fileName });

    // 构建 GitHub API 请求
    const apiUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${filePath}`;
    const commitMessage = `Upload image for project ${projectId}`;

    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
    const cacheKey = `${owner}/${repo}/${branch}/${filePath}`;

    const cached = completedByKey.get(cacheKey);
    if (cached) return cached;

    const inFlight = inFlightByKey.get(cacheKey);
    if (inFlight) return await inFlight;

    const doUpload = async (): Promise<string> => {
      return await withGithubUploadSlot(async () => {
        const requestBodyBase = {
          message: commitMessage,
          content: base64Data,
          branch: branch
        };

        Logger.logRequest('GitHub', 'uploadFile', apiUrl, {
          message: commitMessage,
          path: filePath,
          branch: branch,
          contentLength: base64Data.length
        });

        const doPut = async (body: any) => {
          return await fetch(apiUrl, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github.v3+json',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
          });
        };

        const fetchRemoteSha = async (): Promise<string> => {
          const getUrl = `${apiUrl}?ref=${encodeURIComponent(branch)}`;
          const metaRes = await fetch(getUrl, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github.v3+json'
            }
          });
          if (!metaRes.ok) return '';
          const meta = (await metaRes.json()) as GitHubContentResponse;
          const sha = String((meta as any)?.sha ?? '').trim();
          return sha;
        };

        let lastErrorText = '';
        for (let attempt = 1; attempt <= 2; attempt++) {
          let response = await doPut(requestBodyBase);
          if (response.ok) {
            const result: GitHubUploadResponse = await response.json();
            Logger.logInfo('图片上传成功', {
              path: result.content.path,
              sha: result.content.sha,
              size: result.content.size,
              attempt
            });
            completedByKey.set(cacheKey, rawUrl);
            pruneCompletedCache();
            return rawUrl;
          }

          const errorText = await response.text();
          lastErrorText = errorText;

          Logger.logError('GitHub', '上传图片失败', {
            status: response.status,
            error: errorText,
            attempt
          });

          if (response.status === 401) {
            throw new Error('GitHub Token 无效或已过期，请检查 GITHUB_TOKEN 配置');
          }
          if (response.status === 403) {
            throw new Error('GitHub Token 权限不足，请确保 Token 拥有 repo 权限');
          }
          if (response.status === 404) {
            throw new Error(`GitHub 仓库 ${owner}/${repo} 不存在或无访问权限`);
          }

          if (response.status === 422) {
            const parsed = tryParseJson(errorText);
            const message = String(parsed?.message ?? errorText);
            if (message.toLowerCase().includes('already exists')) {
              completedByKey.set(cacheKey, rawUrl);
              pruneCompletedCache();
              return rawUrl;
            }
            if (message.toLowerCase().includes('sha') && message.toLowerCase().includes("wasn't supplied")) {
              const sha = await fetchRemoteSha();
              if (sha) {
                const put2 = await doPut({ ...requestBodyBase, sha });
                if (put2.ok) {
                  completedByKey.set(cacheKey, rawUrl);
                  pruneCompletedCache();
                  return rawUrl;
                }
              }
              completedByKey.set(cacheKey, rawUrl);
              pruneCompletedCache();
              return rawUrl;
            }
            throw new Error(`上传图片到 GitHub 失败 (422): ${errorText}`);
          }

          if (response.status === 409) {
            if (attempt >= 2) {
              const sha = await fetchRemoteSha();
              if (sha) {
                const put2 = await doPut({ ...requestBodyBase, sha });
                if (put2.ok) {
                  completedByKey.set(cacheKey, rawUrl);
                  pruneCompletedCache();
                  return rawUrl;
                }
              }
              throw new Error(`上传图片到 GitHub 失败 (409): ${errorText}`);
            }
            await sleep(350);
            continue;
          }

          throw new Error(`上传图片到 GitHub 失败 (${response.status}): ${errorText}`);
        }

        throw new Error(`上传图片到 GitHub 失败: ${lastErrorText}`);
      });
    };

    const promise = doUpload()
      .then((url) => {
        completedByKey.set(cacheKey, url);
        pruneCompletedCache();
        return url;
      })
      .finally(() => {
        inFlightByKey.delete(cacheKey);
      });
    inFlightByKey.set(cacheKey, promise);
    return await promise;

  } catch (error) {
    Logger.logError('GitHub', '图片上传过程出错', error);
    throw error;
  }
};

/**
 * 检测 URL 是否为 Base64 Data URL
 */
export const isBase64DataUrl = (url: string): boolean => {
  return url.startsWith('data:image/');
};
