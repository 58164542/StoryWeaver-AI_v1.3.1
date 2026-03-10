/**
 * 火山引擎图像生成服务
 * API文档: https://www.volcengine.com/docs/82379/1666945
 * 模型: doubao-seedream-4-5-251128
 */

import { buildPromptWithRefs } from '../utils/imagePromptUtils';

const VOLCENGINE_IMAGE_API_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";

interface ReferenceImage {
  name: string;
  data: string;
  mimeType: string;
}

type ProgressCallback = (progress: number) => void;

interface VolcengineImageRequest {
  model: string;
  prompt: string;
  image?: string | string[];  // 参考图像，支持URL或Base64编码
  size: string;  // 2K 或具体像素值如 "2048x2048"
  response_format?: 'url' | 'b64_json';
  watermark?: boolean;
  stream?: boolean;
  sequential_image_generation?: 'auto' | 'disabled';
}

interface VolcengineImageData {
  url?: string;
  b64_json?: string;
  size?: string;
  error?: {
    code: string;
    message: string;
  };
}

interface VolcengineImageResponse {
  model: string;
  created: number;
  data: VolcengineImageData[];
  usage?: {
    generated_images: number;
    output_tokens: number;
    total_tokens: number;
  };
  error?: {
    code: string;
    message: string;
  };
}

// 流式响应事件类型
interface StreamPartialSucceeded {
  type: 'image_generation.partial_succeeded';
  model: string;
  created: number;
  image_index: number;
  url?: string;
  b64_json?: string;
  size: string;
}

interface StreamCompleted {
  type: 'image_generation.completed';
  model: string;
  created: number;
  usage: {
    generated_images: number;
    output_tokens: number;
    total_tokens: number;
  };
}

interface StreamError {
  error: {
    code: string;
    message: string;
  };
}

type StreamEvent = StreamPartialSucceeded | StreamCompleted | StreamError;

/**
 * 宽高比映射到推荐的像素值（2K分辨率）
 */
const ASPECT_RATIO_TO_SIZE: Record<string, string> = {
  '1:1': '2048x2048',
  '16:9': '2848x1600',
  '9:16': '1600x2848',
  '4:3': '2304x1728',
  '3:4': '1728x2304',
  '3:2': '2496x1664',
  '2:3': '1664x2496',
  '21:9': '3136x1344'
};

/**
 * 下载图片并转换为Base64 Data URL
 */
async function downloadAndConvertImage(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`下载图片失败: ${response.status}`);
    }

    const blob = await response.blob();

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.error('图片下载转换失败:', error);
    throw error;
  }
}

/**
 * 将参考图像转换为火山引擎API接受的格式
 */
function formatReferenceImages(referenceImages: ReferenceImage[]): string | string[] | undefined {
  if (referenceImages.length === 0) {
    return undefined;
  }

  // 转换为标准Base64格式: data:image/<type>;base64,<data>
  const formattedImages = referenceImages.map(img => {
    // 如果已经是完整的data URL，直接返回
    if (img.data.startsWith('data:')) {
      return img.data;
    }
    // 否则构建完整的data URL
    return `data:${img.mimeType};base64,${img.data}`;
  });

  // 单张图片返回字符串，多张图片返回数组
  return formattedImages.length === 1 ? formattedImages[0] : formattedImages;
}

/**
 * 使用火山引擎Seedream模型生成图像
 *
 * @param prompt 图像描述提示词
 * @param aspectRatio 宽高比 (16:9, 9:16, 1:1, 4:3, 3:4, 3:2, 2:3, 21:9)
 * @param referenceImages 参考图像数组（可选，最多14张）
 * @param imageSize 图像大小，默认2K
 * @param onProgress 进度回调函数（仅在流式模式下有效）
 * @returns Base64 Data URL格式的图像
 */
export const generateImageWithVolcengine = async (
  prompt: string,
  aspectRatio: string = '16:9',
  referenceImages: ReferenceImage[] = [],
  imageSize: '1K' | '2K' | '4K' = '2K',
  onProgress?: ProgressCallback,
  model: string = 'doubao-seedream-4-5-251128'
): Promise<string> => {
  const apiKey = process.env.ARK_API_KEY;

  if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
    throw new Error('请在 .env.local 文件中配置 ARK_API_KEY');
  }

  // 获取对应宽高比的推荐尺寸
  const sizeValue = ASPECT_RATIO_TO_SIZE[aspectRatio] || '2048x2048';

  // 准备参考图像
  const imageParam = formatReferenceImages(referenceImages);

  // 构建含参考图对应关系的完整提示词（使用共享工具函数，新增服务时同样必须调用）
  const fullPrompt = buildPromptWithRefs(prompt, referenceImages);

  // 根据是否需要进度回调决定使用流式或非流式
  const useStream = !!onProgress;

  const requestBody: VolcengineImageRequest = {
    model,
    prompt: fullPrompt,
    size: sizeValue,
    response_format: 'b64_json',  // 使用Base64返回，避免再次下载
    watermark: true,
    stream: useStream,
    sequential_image_generation: 'disabled'  // 关闭组图功能，只生成单张
  };

  // 只在有参考图时添加image参数
  if (imageParam) {
    requestBody.image = imageParam;
  }

  try {
    console.log('[火山引擎] 发送请求', {
      url: VOLCENGINE_IMAGE_API_URL,
      model: requestBody.model,
      promptLength: requestBody.prompt.length,
      size: requestBody.size,
      stream: requestBody.stream,
      hasImage: !!requestBody.image,
      imageType: Array.isArray(requestBody.image) ? `array[${requestBody.image.length}]` : typeof requestBody.image,
      imageLengths: Array.isArray(requestBody.image)
        ? requestBody.image.map((s: string) => s.length)
        : requestBody.image ? [requestBody.image.length] : []
    });

    const response = await fetch(VOLCENGINE_IMAGE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    console.log('[火山引擎] 响应状态', { status: response.status, ok: response.ok });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`火山引擎 API 错误 (${response.status}): ${errorText}`);
    }

    // 流式响应处理
    if (useStream) {
      return await handleStreamResponse(response, onProgress!);
    }

    // 非流式响应处理
    const result: VolcengineImageResponse = await response.json();

    if (result.error) {
      throw new Error(`火山引擎生成失败: ${result.error.message} (${result.error.code})`);
    }

    if (!result.data || result.data.length === 0) {
      throw new Error('未收到生成的图像数据');
    }

    const imageData = result.data[0];

    // 检查单个图像是否有错误
    if (imageData.error) {
      throw new Error(`图像生成失败: ${imageData.error.message} (${imageData.error.code})`);
    }

    if (imageData.b64_json) {
      // 返回Base64 Data URL格式
      return `data:image/jpeg;base64,${imageData.b64_json}`;
    } else if (imageData.url) {
      // 如果返回的是URL，下载并转换
      console.log('火山引擎生成成功，正在下载图片...');
      return await downloadAndConvertImage(imageData.url);
    } else {
      throw new Error('响应中缺少图像数据');
    }
  } catch (error) {
    console.error('[火山引擎] 生成失败', { error: String(error), stack: (error as Error).stack });
    console.error('火山引擎图像生成失败:', error);
    throw error;
  }
};

/**
 * 处理流式响应
 */
async function handleStreamResponse(
  response: Response,
  onProgress: ProgressCallback
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('无法读取响应流');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let generatedImage: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const eventData: StreamEvent = JSON.parse(line.slice(6));

            // 处理图像生成成功事件
            if ('type' in eventData && eventData.type === 'image_generation.partial_succeeded') {
              const data = eventData as StreamPartialSucceeded;

              // 模拟进度（因为火山引擎流式响应没有进度百分比）
              onProgress(50);

              if (data.b64_json) {
                generatedImage = `data:image/jpeg;base64,${data.b64_json}`;
              } else if (data.url) {
                generatedImage = await downloadAndConvertImage(data.url);
              }
            }

            // 处理完成事件
            if ('type' in eventData && eventData.type === 'image_generation.completed') {
              onProgress(100);
            }

            // 处理错误事件
            if ('error' in eventData && eventData.error) {
              throw new Error(`${eventData.error.message} (${eventData.error.code})`);
            }
          } catch (parseError) {
            console.error('解析响应数据失败:', parseError);
            // 继续处理下一行
          }
        }
      }
    }

    if (!generatedImage) {
      throw new Error('未收到有效的生成结果');
    }

    return generatedImage;
  } catch (error) {
    console.error('流式响应处理失败:', error);
    throw error;
  }
}
