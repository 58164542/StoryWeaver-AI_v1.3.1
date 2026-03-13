import { Logger } from "../utils/logger";
import { uploadImageToGitHub, isBase64DataUrl } from "./githubImageService";
import { readMediaAsBase64 } from "./apiService";

const KLING_API_BASE = "https://api-beijing.klingai.com";
const KLING_VIDEO_ENDPOINT = `${KLING_API_BASE}/v1/videos/omni-video`;

type KlingStatus = "pending" | "processing" | "running" | "success" | "succeeded" | "completed" | "failed" | "error" | "cancelled" | "canceled";

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
  data?: {
    status?: KlingStatus | string;
    result?: any;
    output?: any;
    error?: any;
    videos?: any[];
    video_url?: string;
    message?: string;
  };
  status?: KlingStatus | string;
  result?: any;
  output?: any;
  error?: any;
  videos?: any[];
  video_url?: string;
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

const base64UrlEncode = (data: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const base64UrlEncodeString = (text: string): string => {
  const encoded = new TextEncoder().encode(text);
  return base64UrlEncode(encoded);
};

const signHmacSha256 = async (data: string, secret: string): Promise<string> => {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!subtle) {
    throw new Error("当前环境不支持加密签名，无法生成可灵 API Token");
  }
  const key = await subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return base64UrlEncode(new Uint8Array(signature));
};

const getKlingApiToken = async (): Promise<string> => {
  const directToken = process.env.KLING_API_TOKEN || process.env.KLING_API_KEY;
  if (directToken) return directToken;

  const accessKey = process.env.KLING_ACCESS_KEY;
  const secretKey = process.env.KLING_SECRET_KEY;
  if (!accessKey || !secretKey) {
    throw new Error("请在 .env.local 文件中配置 KLING_API_TOKEN 或 KLING_ACCESS_KEY / KLING_SECRET_KEY");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { iss: accessKey, exp: now + 1800, nbf: now - 5 };
  const encodedHeader = base64UrlEncodeString(JSON.stringify(header));
  const encodedPayload = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await signHmacSha256(signingInput, secretKey);
  return `${signingInput}.${signature}`;
};

const extractTaskId = (data: KlingCreateResponse): string | null => {
  return data.data?.task_id || data.data?.taskId || data.data?.id || data.task_id || data.taskId || data.id || null;
};

const extractStatus = (data: KlingQueryResponse): string | undefined => {
  return data.data?.status || data.status;
};

const extractVideoUrl = (data: KlingQueryResponse): string | null => {
  const scope = data.data ?? data;
  return (
    scope?.result?.video_url ||
    scope?.result?.videos?.[0]?.url ||
    scope?.result?.videos?.[0]?.video_url ||
    scope?.result?.output?.videos?.[0]?.url ||
    scope?.result?.output?.videos?.[0]?.video_url ||
    scope?.output?.video_url ||
    scope?.videos?.[0]?.url ||
    scope?.videos?.[0]?.video_url ||
    scope?.video_url ||
    null
  );
};

const extractErrorMessage = (data: KlingQueryResponse): string | undefined => {
  const scope = data.data ?? data;
  if (!scope) return undefined;
  if (typeof scope.error === "string") return scope.error;
  if (scope.error?.message) return scope.error.message;
  if (typeof scope.message === "string") return scope.message;
  return undefined;
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
  const apiToken = await getKlingApiToken();
  const finalImageUrl = await resolveKlingImageUrl(imageUrl, projectId, githubImageUrl);

  const createPayload: any = {
    model: "kling-v3-omni",
    prompt,
    multi_shot: false,
    aspect_ratio: aspectRatio,
    duration,
    sound: "off",
    image_list: finalImageUrl ? [{ image_url: finalImageUrl }] : undefined
  };

  if (!finalImageUrl) {
    delete createPayload.image_list;
  }

  Logger.logRequest("Kling Omni", "createTask", KLING_VIDEO_ENDPOINT, createPayload);

  const createResponse = await fetch(KLING_VIDEO_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
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

  const maxAttempts = 180;
  const pollInterval = 5000;
  let attempts = 0;

  const successStatuses = new Set(["success", "succeeded", "completed", "finished", "done"]);
  const failedStatuses = new Set(["failed", "error", "cancelled", "canceled"]);

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    attempts++;

    const queryResponse = await fetch(`${KLING_VIDEO_ENDPOINT}/${taskId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiToken}`,
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
      if (status === "pending") progress = 10;
      else if (status === "processing" || status === "running") progress = Math.min(10 + (attempts / maxAttempts) * 80, 90);
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
