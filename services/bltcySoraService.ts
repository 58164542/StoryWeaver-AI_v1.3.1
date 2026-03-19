import { Logger } from "../utils/logger";
import { uploadImageToGitHub, isBase64DataUrl } from "./githubImageService";
import { readMediaAsBase64 } from "./apiService";

const BLTCY_BASE_URL = "https://api.bltcy.ai";
const BLTCY_MODEL = "sora-2";
const BLTCY_WAN_MODEL = "wan2.6-i2v";

const getBltcyApiKey = (envKey: "BLTCY_API_KEY" | "BLTCY_VIP_API_KEY" | "BLTCY_WAN_API_KEY"): string => {
  const apiKey = process.env[envKey];
  if (!apiKey || apiKey === "PLACEHOLDER_API_KEY") {
    throw new Error(`请在 .env.local 文件中配置 ${envKey}`);
  }
  return apiKey;
};

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

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });

const dataUrlToBase64 = (dataUrl: string): string => {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    throw new Error("无效的 base64 data URL");
  }
  return dataUrl.slice(commaIndex + 1);
};

const normalizeBase64DataUrl = (value: string, fallbackMimeType: string = "image/jpeg"): string => {
  if (isBase64DataUrl(value)) return value;
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error("缺少图片数据");
  return `data:${fallbackMimeType};base64,${trimmed}`;
};

const convertBlobToJpegDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("canvas 不可用"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(async jpegBlob => {
        if (!jpegBlob) {
          reject(new Error("JPEG 转换失败"));
          return;
        }
        try {
          resolve(await blobToDataUrl(jpegBlob));
        } catch (error) {
          reject(error instanceof Error ? error : new Error("JPEG 读取失败"));
        }
      }, "image/jpeg", 0.92);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("图片加载失败"));
    };
    img.src = objectUrl;
  });

const isWanSupportedMimeType = (mimeType: string): boolean => {
  const normalized = mimeType.toLowerCase();
  return normalized === "image/jpeg" || normalized === "image/jpg" || normalized === "image/png";
};

const normalizeDataUrlForWan = async (dataUrl: string): Promise<string> => {
  const mimeType = dataUrl.match(/^data:([^;]+);base64,/)?.[1] ?? "image/jpeg";
  if (isWanSupportedMimeType(mimeType)) return dataUrl;
  const blob = await fetch(dataUrl).then(response => response.blob());
  return await convertBlobToJpegDataUrl(blob);
};

const ensureWanCompatibleImageUrl = async (
  imageUrl: string,
  githubImageUrl: string | undefined,
  projectId: string
): Promise<string> => {
  const primarySource = normalizeImageUrlInput(imageUrl);
  const fallbackSource = normalizeImageUrlInput(githubImageUrl ?? "");
  const source = primarySource || fallbackSource;
  if (!source) {
    throw new Error("生成视频失败: 缺少参考图");
  }

  let dataUrl: string;
  if (isBase64DataUrl(source)) {
    dataUrl = source;
  } else if (/^https?:\/\//i.test(source)) {
    try {
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      dataUrl = await blobToDataUrl(await response.blob());
    } catch (error) {
      if (source !== fallbackSource && fallbackSource && /^https?:\/\//i.test(fallbackSource)) {
        const fallbackResponse = await fetch(fallbackSource);
        if (!fallbackResponse.ok) {
          throw error;
        }
        dataUrl = await blobToDataUrl(await fallbackResponse.blob());
      } else if (isPublicHttpUrl(source)) {
        Logger.logInfo("BltcyWan 远程图片抓取失败，回退为直接使用公网 URL", { imageUrl: source });
        return source;
      } else {
        throw error;
      }
    }
  } else {
    dataUrl = await readMediaAsBase64(source);
  }

  const normalizedDataUrl = await normalizeDataUrlForWan(dataUrl);
  const uploadedUrl = await uploadImageToGitHub(normalizedDataUrl, projectId);
  Logger.logInfo("BltcyWan 兼容图上传成功", { githubUrl: uploadedUrl });
  return uploadedUrl;
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
  imageAsString: boolean = false,
  apiKeyEnv: "BLTCY_API_KEY" | "BLTCY_VIP_API_KEY" | "BLTCY_WAN_API_KEY" = "BLTCY_VIP_API_KEY"
): Promise<string> => {
  const apiKey = getBltcyApiKey(apiKeyEnv);

  // 柏拉图 Sora 2 改为直接传 base64；其他模型保持原有 URL 逻辑
  let finalImageUrl: string;
  const normalizedImageUrl = normalizeImageUrlInput(imageUrl);
  const normalizedGithubImageUrl = normalizeImageUrlInput(githubImageUrl ?? "");
  const shouldSendBase64Image = apiKeyEnv === "BLTCY_VIP_API_KEY" && model === BLTCY_MODEL;

  if (apiKeyEnv === "BLTCY_WAN_API_KEY") {
    try {
      finalImageUrl = await ensureWanCompatibleImageUrl(normalizedImageUrl, githubImageUrl, projectId);
    } catch (error) {
      Logger.logError("BltcyWan", "图片准备失败", error);
      throw new Error(`图片上传到 GitHub 失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  } else if (shouldSendBase64Image) {
    const source = normalizedImageUrl || normalizedGithubImageUrl;
    if (!source) {
      throw new Error("生成视频失败: 缺少参考图");
    }

    if (isBase64DataUrl(source)) {
      Logger.logInfo("BltcySora 检测到 Base64 图片，直接传给柏拉图 Sora", { projectId });
      finalImageUrl = source;
    } else {
      Logger.logInfo("BltcySora 读取图片为 Base64 后传给柏拉图 Sora", { imageUrl: source });
      try {
        finalImageUrl = await readMediaAsBase64(source);
      } catch (error) {
        Logger.logError("BltcySora", "图片读取为 Base64 失败", error);
        throw new Error(`图片读取为 Base64 失败: ${error instanceof Error ? error.message : "未知错误"}`);
      }
    }
  } else if (githubImageUrl) {
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
    images: shouldSendBase64Image
      ? [normalizeBase64DataUrl(finalImageUrl)]
      : imageAsString
        ? [dataUrlToBase64(finalImageUrl)]
        : [{ type: "url", url: finalImageUrl }],
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

export const generateVideoWithBltcyWan26 = (
  imageUrl: string,
  prompt: string,
  aspectRatio: "16:9" | "9:16" | "1:1" | "4:3" | "3:4",
  duration: number = 5,
  projectId: string,
  onProgress?: (progress: number) => void,
  githubImageUrl?: string
): Promise<string> =>
  generateVideoWithBltcySora(
    imageUrl,
    prompt,
    aspectRatio,
    duration,
    projectId,
    onProgress,
    githubImageUrl,
    BLTCY_WAN_MODEL,
    true,
    "BLTCY_WAN_API_KEY"
  );

export const generateVideoWithBltcyGrokVideo3 = (
  imageUrl: string,
  prompt: string,
  aspectRatio: "16:9" | "9:16" | "1:1" | "4:3" | "3:4",
  duration: number = 5,
  projectId: string,
  onProgress?: (progress: number) => void,
  githubImageUrl?: string
): Promise<string> =>
  generateVideoWithBltcySora(
    imageUrl,
    prompt,
    aspectRatio,
    duration,
    projectId,
    onProgress,
    githubImageUrl,
    "grok-video-3",
    true
  );
