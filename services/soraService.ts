import { Logger } from "../utils/logger";
import { uploadImageToGitHub, isBase64DataUrl } from "./githubImageService";
import { readMediaAsBase64 } from "./apiService";

const SORA_CREATE_URL = "https://api.xskill.ai/api/v3/tasks/create";
const SORA_QUERY_URL = "https://api.xskill.ai/api/v3/tasks/query";

interface SoraTaskResponse {
  code: number;
  data: {
    task_id: string;
    price?: number;
  };
  message?: string;
}

interface SoraQueryResponse {
  code: number;
  data: {
    status: string;
    result?: {
      output?: {
        images?: string[];
      };
    };
    error?: string;
  };
  message?: string;
}

const SORA_ALLOWED_DURATIONS = [4, 8, 12] as const;

type SoraAllowedDuration = (typeof SORA_ALLOWED_DURATIONS)[number];

const normalizeSoraDuration = (duration: number): SoraAllowedDuration => {
  // 就近修正到 4/8/12
  if (duration <= 4) return 4;
  if (duration <= 8) return 8;
  return 12;
};

const extractDetailMessage = (errorText: string): string => {
  try {
    const parsed = JSON.parse(errorText) as { detail?: string };
    if (parsed?.detail) return parsed.detail;
  } catch {
    // ignore
  }
  return errorText;
};

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

export const generateVideoWithSora = async (
  imageUrl: string,
  prompt: string,
  aspectRatio: "16:9" | "9:16" | "1:1" | "4:3" | "3:4",
  duration: number = 4,
  projectId: string,
  onProgress?: (progress: number) => void,
  githubImageUrl?: string
): Promise<string> => {
  const apiKey = process.env.NEX_API_KEY;
  if (!apiKey || apiKey === "PLACEHOLDER_API_KEY") {
    throw new Error("请在 .env.local 文件中配置 NEX_API_KEY");
  }

  const normalizedDuration = normalizeSoraDuration(duration);
  if (normalizedDuration !== duration) {
    Logger.logInfo("Sora duration 已自动修正", {
      requested: duration,
      normalized: normalizedDuration,
      allowed: SORA_ALLOWED_DURATIONS
    });
  }

  // 步骤 0: 确保 image_url 是 Sora 外部 API 可访问的公网 URL
  let finalImageUrl: string;

  const normalizedImageUrl = normalizeImageUrlInput(imageUrl);

  if (githubImageUrl) {
    // 优先使用已上传的 GitHub URL
    Logger.logInfo("使用已有 GitHub URL", { githubImageUrl });
    finalImageUrl = githubImageUrl;
  } else if (isBase64DataUrl(normalizedImageUrl)) {
    // Base64 → 上传 GitHub
    Logger.logInfo("检测到 Base64 图片，开始上传到 GitHub", { projectId });
    try {
      finalImageUrl = await uploadImageToGitHub(normalizedImageUrl, projectId);
      Logger.logInfo("图片上传成功，获得 GitHub URL", { githubUrl: finalImageUrl });
    } catch (error) {
      Logger.logError("Sora", "Base64 图片上传失败", error);
      throw new Error(
        `图片上传到 GitHub 失败: ${error instanceof Error ? error.message : "未知错误"}`
      );
    }
  } else if (isPublicHttpUrl(normalizedImageUrl)) {
    Logger.logInfo("检测到公网 URL，直接使用", { imageUrl: normalizedImageUrl, projectId });
    finalImageUrl = normalizedImageUrl;
  } else {
    // 局域网/私有 HTTP URL → 通过后端 API 读取为 base64 → 上传 GitHub（避免跨域 fetch 问题）
    Logger.logInfo("检测到非公网 URL，通过后端 API 读取后上传到 GitHub", { imageUrl: normalizedImageUrl, projectId });
    try {
      const base64Data = await readMediaAsBase64(normalizedImageUrl);
      finalImageUrl = await uploadImageToGitHub(base64Data, projectId);
      Logger.logInfo("图片上传成功，获得 GitHub URL", { githubUrl: finalImageUrl });
    } catch (error) {
      Logger.logError("Sora", "图片读取/上传失败", error);
      throw new Error(
        `图片上传到 GitHub 失败: ${error instanceof Error ? error.message : "未知错误"}`
      );
    }
  }

  const createPayload = {
    model: "fal-ai/sora-2/image-to-video",
    params: {
      prompt,
      image_url: finalImageUrl,
      duration: normalizedDuration,
      model: "sora-2",
      aspect_ratio: aspectRatio
    },
    channel: null
  };

  Logger.logRequest("Sora 2.0", "createTask", SORA_CREATE_URL, createPayload);

  const createResponse = await fetch(SORA_CREATE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(createPayload)
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    const detail = extractDetailMessage(errorText);

    Logger.logError("Sora", "创建视频生成任务失败", {
      status: createResponse.status,
      error: detail,
      durationRequested: duration,
      durationNormalized: normalizedDuration,
      allowedDurations: SORA_ALLOWED_DURATIONS
    });

    if (createResponse.status === 400 && detail.includes("duration")) {
      throw new Error(
        `创建视频生成任务失败 (400): ${detail}（已将时长从 ${duration} 自动修正为 ${normalizedDuration} 后发起请求）`
      );
    }

    throw new Error(`创建视频生成任务失败 (${createResponse.status}): ${detail}`);
  }

  const createData: SoraTaskResponse = await createResponse.json();
  if (createData.code !== 200 || !createData.data?.task_id) {
    Logger.logError("Sora", "API返回错误", createData);
    throw new Error(`创建任务失败: ${createData.message || "未知错误"}`);
  }

  const taskId = createData.data.task_id;
  Logger.logInfo("Sora 视频生成任务已创建", { taskId, price: createData.data.price });

  const maxAttempts = 1800; // 约 60 分钟（1800 * 2s）
  const pollInterval = 2000;
  let attempts = 0;

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    attempts++;

    const queryResponse = await fetch(SORA_QUERY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ task_id: taskId })
    });

    if (!queryResponse.ok) {
      const errorText = await queryResponse.text();
      const detail = extractDetailMessage(errorText);
      Logger.logError("Sora", "查询任务状态失败", { status: queryResponse.status, error: detail });
      throw new Error(`查询任务状态失败 (${queryResponse.status}): ${detail}`);
    }

    const taskData: SoraQueryResponse = await queryResponse.json();
    if (taskData.code !== 200) {
      Logger.logError("Sora", "查询API返回错误", taskData);
      throw new Error(`查询任务失败: ${taskData.message || "未知错误"}`);
    }

    const status = (taskData.data.status || "").toLowerCase();

    if (onProgress) {
      let progress = 0;
      if (status === "pending") progress = 10;
      else if (status === "processing") progress = Math.min(10 + (attempts / maxAttempts) * 80, 90);
      else if (status === "completed" || status === "success") progress = 100;
      else progress = Math.min(10 + (attempts / maxAttempts) * 80, 90);
      onProgress(progress);
    }

    if (status === "completed" || status === "success") {
      const videoUrl = taskData.data.result?.output?.images?.[0];
      if (!videoUrl) throw new Error("任务成功但未返回视频 URL");
      Logger.logInfo("Sora 视频生成成功", { taskId, videoUrl });
      return videoUrl;
    }

    if (status === "failed" || status === "error") {
      const errorMsg = taskData.data.error || "未知错误";
      Logger.logError("Sora", "视频生成失败", { taskId, error: errorMsg });
      throw new Error(`视频生成失败: ${errorMsg}`);
    }
  }

  Logger.logError("Sora", "视频生成超时", { taskId, attempts });
  throw new Error("视频生成超时，请稍后重试");
};
