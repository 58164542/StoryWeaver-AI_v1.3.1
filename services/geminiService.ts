
import { GoogleGenAI, Type, Modality } from "@google/genai";
import { AnalysisResult, StoryboardBreakdown, StoryboardBreakdownFrame, StoryboardDialogueLine } from "../types";
import { Logger } from "../utils/logger";

function stripGeminiNonJson(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/```json\s*/gi, '');
  cleaned = cleaned.replace(/```\s*/g, '');
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
  cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
  cleaned = cleaned.replace(/<\/think>/gi, '');
  cleaned = cleaned.replace(/<\/thinking>/gi, '');
  cleaned = cleaned.replace(/^\s*json\s*/i, '');
  return cleaned.trim();
}

function extractGeminiJson(text: string): string {
  const cleaned = stripGeminiNonJson(text);
  if (cleaned.startsWith('{') || cleaned.startsWith('[')) return cleaned;

  const firstObject = cleaned.indexOf('{');
  const lastObject = cleaned.lastIndexOf('}');
  if (firstObject !== -1 && lastObject !== -1 && lastObject > firstObject) {
    return cleaned.substring(firstObject, lastObject + 1).trim();
  }

  const firstArray = cleaned.indexOf('[');
  const lastArray = cleaned.lastIndexOf(']');
  if (firstArray !== -1 && lastArray !== -1 && lastArray > firstArray) {
    return cleaned.substring(firstArray, lastArray + 1).trim();
  }

  return cleaned;
}

// We create instances dynamically where needed to ensure fresh API key usage,
// but keep a default one for general text/image tasks.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export interface PromptRewriteResult {
  rewrittenPrompt: string;
  notes?: string;
}

export const rewriteImagePromptForPolicyComplianceGemini = async (
  originalPrompt: string,
  policyError?: string,
  model: string = 'gemini-3-flash-preview'
): Promise<PromptRewriteResult> => {
  const startTime = Date.now();

  Logger.logOperationStart('提示词合规改写（Gemini）', {
    model,
    originalPromptLength: originalPrompt.length,
    hasPolicyError: !!policyError
  });

  const prompt = `你是一个“分镜生图提示词”编辑器。用户的提示词触发了平台的内容政策拦截。\n\n请将下面的提示词改写为“合规版本”，要求：\n1) 保留剧情信息与画面意图（构图、镜头、角色关系、环境氛围）。\n2) 删除或替换可能触发政策的细节（如过度血腥、露骨性内容、未成年人性化、仇恨/歧视、违法活动等）。\n3) 不要输出任何规避/绕过审核的建议，不要输出提示审核关键词。\n4) 输出必须是纯 JSON：{\"rewrittenPrompt\": string, \"notes\"?: string }，禁止 Markdown。\n\n政策错误信息（如有）：\n${policyError ?? ''}\n\n原始提示词：\n${originalPrompt}`;

  const requestConfig = {
    model,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          rewrittenPrompt: { type: Type.STRING },
          notes: { type: Type.STRING }
        },
        required: ['rewrittenPrompt']
      }
    }
  };

  try {
    const response = await ai.models.generateContent(requestConfig);
    const duration = Date.now() - startTime;

    if (!response.text) {
      const error = new Error('Empty response from AI');
      Logger.logError('Gemini', '提示词合规改写', error);
      throw error;
    }

    const parsed = JSON.parse(extractGeminiJson(response.text)) as PromptRewriteResult;
    if (!parsed?.rewrittenPrompt || typeof parsed.rewrittenPrompt !== 'string') {
      throw new Error('Invalid rewrite JSON: missing rewrittenPrompt');
    }

    Logger.logOperationEnd('提示词合规改写（Gemini）', {
      rewrittenPromptLength: parsed.rewrittenPrompt.length
    }, duration);

    return parsed;
  } catch (error) {
    Logger.logError('Gemini', '提示词合规改写失败', error);
    throw error;
  }
};

export const analyzeNovelScript = async (
  text: string,
  model: string = 'gemini-3-flash-preview',
  systemInstruction?: string
): Promise<AnalysisResult> => {
  const startTime = Date.now();

  Logger.logOperationStart('分析小说文本（Gemini）', {
    model,
    textLength: text.length,
    hasSystemInstruction: !!systemInstruction
  });

  const prompt = `
    Analyze the following novel text. Extract the key characters, their appearance variants, and scenes.
    Return a JSON object with three arrays: 'characters', 'variants', and 'scenes'.

    For characters, include:
    - name (no parentheses, no bracketed notes)
    - aliases (all alternate names or nicknames found in the text)
    - description
    - role (Protagonist, Antagonist, Supporting)
    - appearance (COMPLETE base image: physical features face/hair/body + everyday default outfit 常服/日常装束. Include the default outfit here, NOT as a variant)
    - personality

    For variants (character appearance variants like different outfits/states), include:
    - characterName (must match a character's name exactly)
    - name (variant name, e.g. "离府素衣", "东宫太子妃吉服")
    - context (when/where this variant appears)
    - appearance (detailed description of this variant's specific outfit and look)
    STRICT RULE: Only extract sections explicitly labeled with a variant number like "变体01", "变体02", "#### 变体XX" format.
    Do NOT extract everyday outfits (常服/日常装束/默认服装) as variants — those belong in the character's appearance field.

    For scenes, include: name, description, environment, atmosphere.

    Text to analyze:
    ${text.substring(0, 30000)}
  `;

  const requestConfig = {
    model: model,
    contents: prompt,
    config: {
      systemInstruction: systemInstruction,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          characters: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                aliases: { type: Type.ARRAY, items: { type: Type.STRING } },
                description: { type: Type.STRING },
                appearance: { type: Type.STRING },
                personality: { type: Type.STRING },
                role: { type: Type.STRING },
              }
            }
          },
          variants: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                characterName: { type: Type.STRING },
                name: { type: Type.STRING },
                context: { type: Type.STRING },
                appearance: { type: Type.STRING },
              }
            }
          },
          scenes: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                description: { type: Type.STRING },
                environment: { type: Type.STRING },
                atmosphere: { type: Type.STRING },
              }
            }
          }
        }
      }
    }
  };

  Logger.logRequest('Gemini', 'generateContent', 'Google GenAI API', requestConfig);

  try {
    const response = await ai.models.generateContent(requestConfig);

    const duration = Date.now() - startTime;
    Logger.logResponse('Gemini', 200, {
      hasText: !!response.text,
      textLength: response.text?.length || 0
    }, duration);

    if (response.text) {
      const result = JSON.parse(extractGeminiJson(response.text)) as AnalysisResult;

      Logger.logOperationEnd('分析小说文本（Gemini）', {
        charactersCount: result.characters.length,
        scenesCount: result.scenes.length
      }, duration);

      return result;
    }

    const error = new Error("Empty response from AI");
    Logger.logError('Gemini', '分析小说文本', error);
    throw error;
  } catch (error) {
    Logger.logError('Gemini', '分析小说文本失败', error);
    throw error;
  }
};

const normalizeGeminiStoryboardBreakdown = (raw: unknown): StoryboardBreakdown => {
  const isValidFrame = (f: any): boolean =>
    f && typeof f === 'object' && typeof f.originalText === 'string' &&
    (typeof f.imagePrompt === 'string' || typeof f.prompt === 'string');

  const normalizeFrame = (f: any): StoryboardBreakdownFrame => {
    const imagePrompt = typeof f.imagePrompt === 'string' ? f.imagePrompt : (f.prompt ?? '');
    const videoPrompt = typeof f.videoPrompt === 'string' ? f.videoPrompt : (f.prompt ?? '');
    return { ...f, imagePrompt, videoPrompt };
  };

  if (raw && typeof raw === 'object' && Array.isArray((raw as any).frames)) {
    return { frames: (raw as any).frames.filter(isValidFrame).map(normalizeFrame) };
  }
  if (Array.isArray(raw)) {
    const frames = (raw as any[]).filter(isValidFrame).map(normalizeFrame) as StoryboardBreakdownFrame[];
    return { frames };
  }
  throw new Error('Invalid storyboard breakdown JSON');
};

const mergeDialoguesToDialogueString = (dialogues?: StoryboardDialogueLine[]): string | undefined => {
  if (!dialogues || dialogues.length === 0) return undefined;
  return dialogues
    .map(d => {
      const speaker = (d.speakerName ?? '').trim();
      const text = (d.text ?? '').trim();
      if (!text) return '';
      return speaker ? `${speaker}：${text}` : text;
    })
    .filter(Boolean)
    .join('\n');
};

const splitDialogueStringToDialogues = (dialogue?: string): StoryboardDialogueLine[] | undefined => {
  const input = (dialogue ?? '').trim();
  if (!input) return undefined;

  const normalized = input
    .replace(/[“”]/g, '"')
    .replace(/[：:]/g, '：');

  const lines = normalized.split(/\r?\n+/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;

  const result: StoryboardDialogueLine[] = [];
  for (const line of lines) {
    const m = line.match(/^(.{1,20}?)：(.+)$/);
    if (m) {
      const speakerName = m[1].trim();
      const text = m[2].trim().replace(/^"|"$/g, '');
      if (text) result.push({ speakerName, text });
    } else {
      const text = line.replace(/^"|"$/g, '');
      if (text) result.push({ text });
    }
  }

  return result.length > 0 ? result : undefined;
};

export const generateStoryboardBreakdown = async (
  text: string,
  model: string = 'gemini-3-flash-preview',
  systemInstruction?: string
): Promise<StoryboardBreakdown> => {
  const startTime = Date.now();

  Logger.logOperationStart('生成分镜分解（Gemini）', {
    model,
    textLength: text.length,
    hasSystemInstruction: !!systemInstruction
  });

  const prompt = `
    Break down the following novel text into visual storyboard frames.
    Return a JSON object with an array 'frames'.

    Each frame should include:
    - imagePrompt: A detailed static visual description for an image generator. Focus on single-frame composition, character appearance/pose, scene environment, and lighting atmosphere. Should be concrete and suitable for direct image generation.
    - videoPrompt: A detailed, continuous visual description for a video generator. Include complete linear action with cause-and-effect flow. If the original text lacks sufficient content for a continuous motion shot, supplement with additional details and sub-shots.
    - dialogues: An array of dialogue lines, each item is { speakerName, text }.
      - speakerName: MUST be one of the character names appearing in characterNames. If narration/unknown speaker, omit speakerName.
      - text: The spoken line content.
      - There may be multiple speakers and multiple lines in one frame.
    - dialogue: (optional) A merged string version for compatibility.
    - originalText: The segment of the original text this frame covers.
    - characterNames: A list of character names or aliases present in this frame.
    - sceneName: The name of the scene where this takes place.

    Text:
    ${text.substring(0, 30000)}
  `;

  const requestConfig = {
    model: model,
    contents: prompt,
    config: {
      systemInstruction: systemInstruction,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          frames: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                imagePrompt: { type: Type.STRING },
                videoPrompt: { type: Type.STRING },
                dialogue: { type: Type.STRING },
                dialogues: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      speakerName: { type: Type.STRING },
                      text: { type: Type.STRING }
                    }
                  }
                },
                originalText: { type: Type.STRING },
                characterNames: { type: Type.ARRAY, items: { type: Type.STRING } },
                sceneName: { type: Type.STRING },
              }
            }
          }
        }
      }
    }
  };

  Logger.logRequest('Gemini', 'generateContent', 'Google GenAI API', requestConfig);

  try {
    const response = await ai.models.generateContent(requestConfig);

    const duration = Date.now() - startTime;
    Logger.logResponse('Gemini', 200, {
      hasText: !!response.text,
      textLength: response.text?.length || 0
    }, duration);

    if (response.text) {
      const parsed = JSON.parse(extractGeminiJson(response.text)) as unknown;
      const result = normalizeGeminiStoryboardBreakdown(parsed);

      result.frames = result.frames.map(frame => {
        const structured = frame.dialogues;
        const merged = frame.dialogue;

        if (structured && structured.length > 0) {
          return { ...frame, dialogue: mergeDialoguesToDialogueString(structured) };
        }
        if (merged) {
          return { ...frame, dialogues: splitDialogueStringToDialogues(merged) };
        }
        return frame;
      });

      Logger.logOperationEnd('生成分镜分解（Gemini）', {
        framesCount: result.frames.length
      }, duration);

      return result;
    }

    const error = new Error("Empty response from AI");
    Logger.logError('Gemini', '生成分镜分解', error);
    throw error;
  } catch (error) {
    Logger.logError('Gemini', '生成分镜分解失败', error);
    throw error;
  }
};

interface ReferenceImage {
  name: string;
  data: string; // base64 string
  mimeType: string;
}

export const generateImageAsset = async (
  prompt: string,
  aspectRatio: '16:9' | '1:1' | '9:16' | '4:3' | '3:4' = '16:9',
  model: string = 'gemini-2.5-flash-image',
  referenceImages: ReferenceImage[] = [],
  stylePrefix: string = ''
): Promise<string> => {
  const startTime = Date.now();

  Logger.logOperationStart('生成图像资产（Gemini）', {
    model,
    aspectRatio,
    promptLength: prompt.length,
    referenceImagesCount: referenceImages.length,
    hasStylePrefix: !!stylePrefix
  });

  try {
    const parts: any[] = [];

    // Construct text prompt following the structure:
    // [Prefix] + [Reference Assets Context] + [Frame Prompt]

    let fullTextPrompt = "";

    if (stylePrefix) {
      fullTextPrompt += `${stylePrefix}\n\n`;
    }

    if (referenceImages.length > 0) {
      fullTextPrompt += "Reference Assets:\n";
      referenceImages.forEach((img, index) => {
        // Add image part to the payload
        parts.push({
          inlineData: {
            mimeType: img.mimeType,
            data: img.data
          }
        });
        fullTextPrompt += `Image ${index + 1}: ${img.name}\n`;
      });
      fullTextPrompt += "Use the above images as strict references for the characters/scenes described below.\n\n";
    }

    fullTextPrompt += `Storyboard Content: ${prompt}`;

    // Add the constructed text part
    parts.push({ text: fullTextPrompt });

    console.log('[Gemini] 发送请求', {
      model,
      aspectRatio,
      partsCount: parts.length,
      partsTypes: parts.map(p => p.inlineData ? `inlineData(${p.inlineData.mimeType}, len=${p.inlineData.data?.length})` : 'text'),
      promptLength: fullTextPrompt.length
    });

    const requestConfig = {
      model: model,
      contents: { parts },
      config: {
        imageConfig: {
          aspectRatio: aspectRatio,
          // imageSize is only for gemini-3-pro-image-preview
          imageSize: model === 'gemini-3-pro-image-preview' ? "2K" : undefined
        }
      }
    };

    Logger.logRequest('Gemini', 'generateContent (Image)', 'Google GenAI API', {
      model,
      aspectRatio,
      partsCount: parts.length
    });

    const response = await ai.models.generateContent(requestConfig);

    const duration = Date.now() - startTime;

    console.log('[Gemini] 响应', {
      candidatesCount: response.candidates?.length ?? 0,
      partsCount: response.candidates?.[0]?.content?.parts?.length ?? 0,
      partTypes: response.candidates?.[0]?.content?.parts?.map((p: any) => p.inlineData ? 'inlineData' : 'text') ?? []
    });

    // Check for inline data
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData && part.inlineData.data) {
        const imageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        Logger.logOperationEnd('生成图像资产（Gemini）', {
          imageSize: part.inlineData.data.length,
          mimeType: part.inlineData.mimeType
        }, duration);
        return imageUrl;
      }
    }

    const error = new Error("No image data found in response");
    Logger.logError('Gemini', '生成图像资产', { response });
    throw error;
  } catch (error) {
    console.error('[Gemini] 生成失败', { error: String(error), stack: (error as Error).stack });
    Logger.logError('Gemini', '生成图像资产失败', error);
    throw error;
  }
};

export const generateVideoFromImage = async (
  imageDataUrl: string,
  prompt: string,
  model: string = 'veo-3.1-fast-generate-preview'
): Promise<string> => {
  const startTime = Date.now();

  Logger.logOperationStart('生成视频（Gemini Veo）', {
    model,
    promptLength: prompt.length,
    imageDataUrlLength: imageDataUrl.length
  });

  try {
    // 1. Check for API Key Selection (Specific for Veo)
    if (typeof window !== 'undefined' && (window as any).aistudio) {
      const aistudio = (window as any).aistudio;
      const hasKey = await aistudio.hasSelectedApiKey();
      if (!hasKey) {
        Logger.logInfo('需要选择 API 密钥');
        await aistudio.openSelectKey();
      }
    }

    // Create a fresh instance to ensure we use the potentially newly selected key
    const videoAi = new GoogleGenAI({ apiKey: process.env.API_KEY });

    // 2. Parse Image
    const [prefix, base64Data] = imageDataUrl.split(',');
    const mimeType = prefix.match(/:(.*?);/)![1];

    Logger.logInfo('解析图像数据', {
      mimeType,
      base64Length: base64Data.length
    });

    // 3. Start Operation
    Logger.logRequest('Gemini Veo', 'generateVideos', 'Google GenAI API', {
      model,
      prompt,
      imageMimeType: mimeType,
      numberOfVideos: 1
    });

    let operation = await videoAi.models.generateVideos({
      model,
      prompt: prompt,
      image: {
        imageBytes: base64Data,
        mimeType: mimeType
      },
      config: {
        numberOfVideos: 1,
        // Default to what Veo supports or what's standard.
        // Not setting resolution/aspectRatio lets model infer or use defaults.
      }
    });

    Logger.logInfo('视频生成操作已启动，开始轮询状态', {
      operationName: operation.name
    });

    // 4. Poll for completion
    let pollCount = 0;
    while (!operation.done) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Poll every 5s
      pollCount++;
      Logger.logInfo(`轮询视频操作状态 (第 ${pollCount} 次)`, {
        operationName: operation.name
      });
      operation = await videoAi.operations.getVideosOperation({operation: operation});
    }

    const pollDuration = Date.now() - startTime;
    Logger.logInfo('视频生成完成', {
      pollCount,
      totalDuration: `${pollDuration}ms`
    });

    // 5. Get Result
    const videoUri = operation.response?.generatedVideos?.[0]?.video?.uri;
    if (!videoUri) {
      const error = new Error("Video generation completed but no URI returned.");
      Logger.logError('Gemini Veo', '视频生成', { operation });
      throw error;
    }

    Logger.logInfo('开始下载生成的视频', { videoUri });

    // 6. Fetch Video Bytes
    const videoResponse = await fetch(`${videoUri}&key=${process.env.API_KEY}`);
    if (!videoResponse.ok) {
      const error = new Error("Failed to download generated video.");
      Logger.logError('Gemini Veo', '下载视频失败', {
        status: videoResponse.status,
        statusText: videoResponse.statusText
      });
      throw error;
    }

    const blob = await videoResponse.blob();
    const blobUrl = URL.createObjectURL(blob);

    const duration = Date.now() - startTime;
    Logger.logOperationEnd('生成视频（Gemini Veo）', {
      videoSize: blob.size,
      blobUrl
    }, duration);

    return blobUrl;

  } catch (error: any) {
    if (error.message?.includes('Requested entity was not found') && typeof window !== 'undefined' && (window as any).aistudio) {
      // Handle race condition/expired key by re-prompting
      Logger.logInfo('API 密钥过期或未找到，重新提示选择');
      await (window as any).aistudio.openSelectKey();
      // In a real app we might retry, but here we just throw to let user try again
    }
    Logger.logError('Gemini Veo', '生成视频失败', error);
    throw error;
  }
}

// Helper: Convert PCM to WAV for browser playback
function pcmToWav(pcmData: Uint8Array, sampleRate: number = 24000, numChannels: number = 1): Blob {
  const buffer = new ArrayBuffer(44 + pcmData.length);
  const view = new DataView(buffer);

  // RIFF identifier
  writeString(view, 0, 'RIFF');
  // file length
  view.setUint32(4, 36 + pcmData.length, true);
  // RIFF type
  writeString(view, 8, 'WAVE');
  // format chunk identifier
  writeString(view, 12, 'fmt ');
  // format chunk length
  view.setUint32(16, 16, true);
  // sample format (raw)
  view.setUint16(20, 1, true);
  // channel count
  view.setUint16(22, numChannels, true);
  // sample rate
  view.setUint32(24, sampleRate, true);
  // byte rate (sampleRate * blockAlign)
  view.setUint32(28, sampleRate * numChannels * 2, true);
  // block align (channel count * bytes per sample)
  view.setUint16(32, numChannels * 2, true);
  // bits per sample
  view.setUint16(34, 16, true);
  // data chunk identifier
  writeString(view, 36, 'data');
  // data chunk length
  view.setUint32(40, pcmData.length, true);

  // Write PCM data
  const pcmBytes = new Uint8Array(buffer, 44);
  pcmBytes.set(pcmData);

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

export const generateSpeech = async (
  text: string,
  model: string = 'gemini-2.5-flash-preview-tts',
  voiceName: string = 'Kore' // Aoede, Charon, Fenrir, Kore, Puck
): Promise<string> => {
  const startTime = Date.now();

  Logger.logOperationStart('生成语音（Gemini TTS）', {
    model,
    voiceName,
    textLength: text.length
  });

  try {
    const requestConfig = {
      model: model,
      contents: { parts: [{ text }] },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName }
          }
        }
      }
    };

    Logger.logRequest('Gemini TTS', 'generateContent', 'Google GenAI API', {
      model,
      voiceName,
      textPreview: text.substring(0, 100) + (text.length > 100 ? '...' : '')
    });

    const response = await ai.models.generateContent(requestConfig);

    const duration = Date.now() - startTime;

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      const error = new Error("No audio data returned");
      Logger.logError('Gemini TTS', '生成语音', { response });
      throw error;
    }

    Logger.logInfo('收到音频数据，开始解码', {
      base64Length: base64Audio.length
    });

    // Decode Base64 to binary
    const binaryString = atob(base64Audio);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    Logger.logInfo('转换 PCM 为 WAV 格式', {
      pcmSize: bytes.length
    });

    // Convert raw PCM to WAV blob
    const wavBlob = pcmToWav(bytes);
    const audioUrl = URL.createObjectURL(wavBlob);

    Logger.logOperationEnd('生成语音（Gemini TTS）', {
      wavSize: wavBlob.size,
      audioUrl
    }, duration);

    return audioUrl;

  } catch (error) {
    Logger.logError('Gemini TTS', '生成语音失败', error);
    throw error;
  }
}
