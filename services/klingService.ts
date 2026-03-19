import { Logger } from "../utils/logger";
import { uploadImageToGitHub, isBase64DataUrl } from "./githubImageService";
import { readMediaAsBase64 } from "./apiService";

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const KLING_PROXY_BASE = `${API_BASE_URL}/api/kling`;

interface KlingCreateResponse {
  code?: number;
  message?: string;
  data?: {
    id?: string;
    task_id?: string;
    taskId?: string;
  };
  id?: string;
  task_id?: string;
  taskId?: string;
}

interface KlingQueryResponse {
  code?: number;
  message?: string;
  request_id?: string;
  data?: {
    task_id?: string;
    task_status?: string;
    task_status_msg?: string;
    task_result?: {
      videos?: Array<{ id?: string; url?: string; watermark_url?: string; duration?: string }>;
    };
  };
}

const normalizeImageUrlInput = (value: string): string => {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return trimmed;
  const quotePairs: Array<[string, string]> = [
    ["`", "`"],
    ['"', '"'],
    ["'", "'"]
  ];
  for (const [start, end] of quotePairs) {
    if (trimmed.startsWith(start) && trimmed.endsWith(end) && trimmed.length > 1) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
};

const isPublicHttpUrl = (value: string): boolean => {
  if (!/^https?:\/\//i.test(value)) return false;
  let hostname = "";
  try {
    hostname = new URL(value).hostname;
  } catch {
    return false;
  }
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".local")) return false;
  if (lower === "0.0.0.0" || lower === "::1") return false;
  const ipv4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
  }
  return true;
};

const getKlingApiToken = async (): Promise<string> => {
  const directToken = process.env.KLING_API_TOKEN || process.env.KLING_API_KEY;
  if (directToken) return directToken;

  const accessKey = process.env.KLING_ACCESS_KEY;
  const secretKey = process.env.KLING_SECRET_KEY;
  if (!accessKey || !secretKey) {
    throw new Error("请在 .env.local 文件中配置 KLING_API_TOKEN 或 KLING_ACCESS_KEY / KLING_SECRET_KEY");
  }

  // 通过后端签名，避免 Web Crypto API 在非 HTTPS 局域网环境下不可用
  const response = await fetch(`${API_BASE_URL}/api/kling/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`获取可灵 Token 失败 (${response.status}): ${err}`);
  }
  const result = await response.json();
  if (!result.success || !result.data?.token) {
    throw new Error(result.error || '后端返回可灵 Token 为空');
  }
  return result.data.token;
};

const extractTaskId = (data: KlingCreateResponse): string | null => {
  return data.data?.task_id || data.data?.taskId || data.data?.id || data.task_id || data.taskId || data.id || null;
};

const extractStatus = (data: KlingQueryResponse): string | undefined => {
  return data.data?.task_status;
};

const extractVideoUrl = (data: KlingQueryResponse): string | null => {
  return data.data?.task_result?.videos?.[0]?.url ?? null;
};

const extractErrorMessage = (data: KlingQueryResponse): string | undefined => {
  return data.data?.task_status_msg || data.message;
};

const resolveKlingImageUrl = async (
  imageUrl: string,
  projectId: string,
  githubImageUrl?: string
): Promise<string> => {
  if (githubImageUrl) return githubImageUrl;
  const normalized = normalizeImageUrlInput(imageUrl);
  if (!normalized) return normalized;
  if (isBase64DataUrl(normalized)) {
    return await uploadImageToGitHub(normalized, projectId);
  }
  if (isPublicHttpUrl(normalized)) {
    return normalized;
  }
  const base64Data = await readMediaAsBase64(normalized);
  return await uploadImageToGitHub(base64Data, projectId);
};

export const generateVideoWithKlingOmni = async (
  imageUrl: string,
  prompt: string,
  aspectRatio: "16:9" | "9:16" | "1:1" | "4:3" | "3:4",
  duration: number = 5,
  projectId: string,
  onProgress?: (progress: number) => void,
  githubImageUrl?: string
): Promise<string> => {
  const finalImageUrl = await resolveKlingImageUrl(imageUrl, projectId, githubImageUrl);

  const createPayload: any = {
    model_name: "kling-v3-omni",
    prompt,
    multi_shot: false,
    aspect_ratio: aspectRatio,
    duration: String(duration),
    sound: "on",
    image_list: finalImageUrl ? [{ image_url: finalImageUrl }] : undefined
  };

  if (!finalImageUrl) {
    delete createPayload.image_list;
  }

  Logger.logRequest("Kling Omni", "createTask", `${KLING_PROXY_BASE}/videos`, createPayload);

  const createResponse = await fetch(`${KLING_PROXY_BASE}/videos`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(createPayload)
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    Logger.logError("Kling Omni", "创建视频生成任务失败", {
      status: createResponse.status,
      error: errorText
    });
    throw new Error(`创建视频生成任务失败 (${createResponse.status}): ${errorText}`);
  }

  const createData: KlingCreateResponse = await createResponse.json();
  const taskId = extractTaskId(createData);
  if (!taskId) {
    Logger.logError("Kling Omni", "未获取到任务 ID", createData);
    throw new Error("未获取到任务 ID");
  }

  Logger.logInfo("Kling Omni 视频生成任务已创建", { taskId });

  const maxAttempts = 360;
  const pollInterval = 5000;
  let attempts = 0;

  const successStatuses = new Set(["succeed", "success", "succeeded", "completed"]);
  const failedStatuses = new Set(["failed", "fail", "error", "cancelled", "canceled"]);

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    attempts++;

    const queryResponse = await fetch(`${KLING_PROXY_BASE}/videos/${taskId}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json"
      }
    });

    if (!queryResponse.ok) {
      const errorText = await queryResponse.text();
      Logger.logError("Kling Omni", "查询任务状态失败", {
        status: queryResponse.status,
        error: errorText
      });
      throw new Error(`查询任务状态失败 (${queryResponse.status}): ${errorText}`);
    }

    const queryData: KlingQueryResponse = await queryResponse.json();
    const status = extractStatus(queryData);

    if (onProgress) {
      let progress = 0;
      if (status === "submitted") progress = 10;
      else if (status === "processing") progress = Math.min(10 + (attempts / maxAttempts) * 80, 90);
      else if (status && successStatuses.has(status)) progress = 100;
      onProgress(progress);
    }

    if (status && successStatuses.has(status)) {
      const videoUrl = extractVideoUrl(queryData);
      if (!videoUrl) {
        Logger.logError("Kling Omni", "任务成功但未返回视频 URL", queryData);
        throw new Error("任务成功但未返回视频 URL");
      }
      Logger.logInfo("Kling Omni 视频生成成功", { taskId, videoUrl });
      return videoUrl;
    }

    if (status && failedStatuses.has(status)) {
      const errorMessage = extractErrorMessage(queryData) || "未知错误";
      throw new Error(`视频生成失败: ${errorMessage}`);
    }
  }

  throw new Error("视频生成超时，请稍后重试");
};
