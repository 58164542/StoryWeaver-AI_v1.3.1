import { Logger } from "../utils/logger";
import { uploadImageToGitHub, isBase64DataUrl } from "./githubImageService";
import { readMediaAsBase64 } from "./apiService";

const BLTCY_BASE_URL = "https://api.bltcy.ai";
const BLTCY_MODEL = "sora-2";

interface BltcyVideoJob {
  task_id: string;
  status: string;
  generations?: Array<{ id: string; url: string }>;
  error?: { message: string };
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

export const generateVideoWithBltcySora = async (
  imageUrl: string,
  prompt: string,
  aspectRatio: "16:9" | "9:16" | "1:1" | "4:3" | "3:4",
  duration: number = 5,
  projectId: string,
  onProgress?: (progress: number) => void,
  githubImageUrl?: string,
  model: string = BLTCY_MODEL,
  imageAsString: boolean = false
): Promise<string> => {
  const apiKey = process.env.BLTCY_API_KEY;
  if (!apiKey || apiKey === "PLACEHOLDER_API_KEY") {
    throw new Error("请在 .env.local 文件中配置 BLTCY_API_KEY");
  }

  // 确保图片 URL 为可公开访问的地址
  let finalImageUrl: string;
  const normalizedImageUrl = normalizeImageUrlInput(imageUrl);
  if (githubImageUrl) {
    Logger.logInfo("BltcySora 使用已有 GitHub URL", { githubImageUrl });
    finalImageUrl = githubImageUrl;
  } else if (isBase64DataUrl(normalizedImageUrl)) {
    Logger.logInfo("BltcySora 检测到 Base64 图片，开始上传到 GitHub", { projectId });
    try {
      finalImageUrl = await uploadImageToGitHub(normalizedImageUrl, projectId);
      Logger.logInfo("BltcySora 图片上传成功", { githubUrl: finalImageUrl });
    } catch (error) {
      Logger.logError("BltcySora", "Base64 图片上传失败", error);
      throw new Error(`图片上传到 GitHub 失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  } else if (isPublicHttpUrl(normalizedImageUrl)) {
    Logger.logInfo("BltcySora 检测到公网 URL，直接使用", { imageUrl: normalizedImageUrl });
    finalImageUrl = normalizedImageUrl;
  } else {
    Logger.logInfo("BltcySora 检测到非公网 URL，通过后端 API 读取后上传到 GitHub", { imageUrl: normalizedImageUrl });
    try {
      const base64Data = await readMediaAsBase64(normalizedImageUrl);
      finalImageUrl = await uploadImageToGitHub(base64Data, projectId);
      Logger.logInfo("BltcySora 图片上传成功", { githubUrl: finalImageUrl });
    } catch (error) {
      Logger.logError("BltcySora", "图片读取/上传失败", error);
      throw new Error(`图片上传到 GitHub 失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  const createPayload = {
    model,
    prompt,
    images: imageAsString ? [finalImageUrl] : [{ type: "url", url: finalImageUrl }],
    duration,
    aspect_ratio: aspectRatio,
  };

  const createUrl = `${BLTCY_BASE_URL}/v2/videos/generations`;
  Logger.logRequest("BltcySora", "createJob", createUrl, createPayload);

  const createResponse = await fetch(createUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createPayload),
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    Logger.logError("BltcySora", "创建视频生成任务失败", {
      status: createResponse.status,
      error: errorText,
    });
    throw new Error(`创建视频生成任务失败 (${createResponse.status}): ${errorText}`);
  }

  const job: BltcyVideoJob = await createResponse.json();
  // 首次调试：打印完整响应，确认字段结构后可删除
  console.log('[BltcySora] 创建任务完整响应:', JSON.stringify(job, null, 2));
  if (!job.task_id) {
    Logger.logError("BltcySora", "API 返回未包含任务 ID", job);
    throw new Error("创建任务失败: 未获取到任务 ID");
  }

  Logger.logInfo("BltcySora 视频生成任务已创建", { taskId: job.task_id });

  const maxAttempts = 720; // 约 60 分钟（720 * 5s）
  const pollInterval = 5000;
  let attempts = 0;

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    attempts++;

    const queryResponse = await fetch(`${BLTCY_BASE_URL}/v2/videos/generations/${job.task_id}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!queryResponse.ok) {
      const errorText = await queryResponse.text();
      Logger.logError("BltcySora", "查询任务状态失败", {
        status: queryResponse.status,
        error: errorText,
      });
      throw new Error(`查询任务状态失败 (${queryResponse.status}): ${errorText}`);
    }

    const jobStatus: BltcyVideoJob = await queryResponse.json();
    // 首次调试：打印轮询响应，确认字段结构后可删除
    if (attempts === 1) console.log('[BltcySora] 首次轮询完整响应:', JSON.stringify(jobStatus, null, 2));
    const status = (jobStatus.status || "").toLowerCase();
    Logger.logInfo("BltcySora 任务状态", { taskId: job.task_id, status, attempts });

    if (onProgress) {
      let progress = 0;
      if (status === "queued") progress = 10;
      else if (status === "processing") progress = Math.min(10 + (attempts / maxAttempts) * 80, 90);
      else if (status === "completed") progress = 100;
      onProgress(progress);
    }

    if (status === "completed") {
      const videoUrl = jobStatus.generations?.[0]?.url;
      if (!videoUrl) throw new Error("任务成功但未返回视频 URL");
      Logger.logInfo("BltcySora 视频生成成功", { taskId: job.task_id, videoUrl });
      return videoUrl;
    }

    if (status === "failed" || status === "failure") {
      const errorMsg = jobStatus.error?.message || "未知错误";
      Logger.logError("BltcySora", "视频生成失败", { taskId: job.task_id, error: errorMsg });
      throw new Error(`视频生成失败: ${errorMsg}`);
    }
  }

  Logger.logError("BltcySora", "视频生成超时", { taskId: job.task_id, attempts });
  throw new Error("视频生成超时，请稍后重试");
};

export const generateVideoWithBltcyVeo3 = (
  imageUrl: string,
  prompt: string,
  aspectRatio: "16:9" | "9:16" | "1:1" | "4:3" | "3:4",
  duration: number = 5,
  projectId: string,
  onProgress?: (progress: number) => void,
  githubImageUrl?: string
): Promise<string> =>
  generateVideoWithBltcySora(imageUrl, prompt, aspectRatio, duration, projectId, onProgress, githubImageUrl, "veo3.1", true);
