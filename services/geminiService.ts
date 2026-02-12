
import { GoogleGenAI, Type, Modality } from "@google/genai";
import { AnalysisResult, StoryboardBreakdown } from "../types";

// We create instances dynamically where needed to ensure fresh API key usage, 
// but keep a default one for general text/image tasks.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// Constants for models
// const TEXT_MODEL = 'gemini-3-flash-preview'; // REMOVED: Now passed dynamically
// const IMAGE_MODEL = 'gemini-2.5-flash-image'; // Passed dynamically or default

export const analyzeNovelScript = async (
  text: string, 
  model: string = 'gemini-3-flash-preview',
  systemInstruction?: string
): Promise<AnalysisResult> => {
  const prompt = `
    Analyze the following novel text. Extract the key characters and scenes.
    Return a JSON object with two arrays: 'characters' and 'scenes'.
    
    For characters, include: name, description, appearance, personality, role (Protagonist, Antagonist, Supporting).
    For scenes, include: name, description, environment, atmosphere.

    Text to analyze:
    ${text.substring(0, 30000)}
  `;

  try {
    const response = await ai.models.generateContent({
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
                  description: { type: Type.STRING },
                  appearance: { type: Type.STRING },
                  personality: { type: Type.STRING },
                  role: { type: Type.STRING },
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
    });

    if (response.text) {
      return JSON.parse(response.text) as AnalysisResult;
    }
    throw new Error("Empty response from AI");
  } catch (error) {
    console.error("Error analyzing novel:", error);
    throw error;
  }
};

export const generateStoryboardBreakdown = async (
  text: string,
  model: string = 'gemini-3-flash-preview',
  systemInstruction?: string
): Promise<StoryboardBreakdown> => {
  const prompt = `
    Break down the following novel text into visual storyboard frames.
    Return a JSON object with an array 'frames'.
    
    Each frame should include:
    - prompt: A detailed visual description for an image generator.
    - dialogue: Any spoken dialogue in this beat.
    - originalText: The segment of the original text this frame covers.
    - characterNames: A list of character names present in this frame (must match names from analysis).
    - sceneName: The name of the scene where this takes place.

    Text:
    ${text.substring(0, 30000)}
  `;

  try {
    const response = await ai.models.generateContent({
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
                  prompt: { type: Type.STRING },
                  dialogue: { type: Type.STRING },
                  originalText: { type: Type.STRING },
                  characterNames: { type: Type.ARRAY, items: { type: Type.STRING } },
                  sceneName: { type: Type.STRING },
                }
              }
            }
          }
        }
      }
    });

    if (response.text) {
      return JSON.parse(response.text) as StoryboardBreakdown;
    }
    throw new Error("Empty response from AI");
  } catch (error) {
    console.error("Error generating storyboard:", error);
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
  referenceImages: ReferenceImage[] = []
): Promise<string> => {
  try {
    const parts: any[] = [];

    // Add reference images first
    // And build a prefix prompt to explain references
    let referenceContext = "";
    
    if (referenceImages.length > 0) {
      referenceContext += "Reference Images:\n";
      referenceImages.forEach((img, index) => {
        // Add image part
        parts.push({
          inlineData: {
            mimeType: img.mimeType,
            data: img.data
          }
        });
        referenceContext += `Image ${index + 1}: ${img.name}\n`;
      });
      referenceContext += "Use the above images as strict references for the characters/scenes described below.\n\n";
    }

    // Add the main prompt text
    parts.push({ text: referenceContext + "Prompt: " + prompt });

    const response = await ai.models.generateContent({
      model: model,
      contents: { parts },
      config: {
        imageConfig: {
          aspectRatio: aspectRatio,
          // imageSize is only for gemini-3-pro-image-preview
          imageSize: model === 'gemini-3-pro-image-preview' ? "1K" : undefined
        }
      }
    });

    // Check for inline data
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData && part.inlineData.data) {
        return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
      }
    }
    
    throw new Error("No image data found in response");
  } catch (error) {
    console.error("Error generating image:", error);
    throw error;
  }
};

export const generateVideoFromImage = async (
  imageDataUrl: string,
  prompt: string,
  model: string = 'veo-3.1-fast-generate-preview'
): Promise<string> => {
  try {
    // 1. Check for API Key Selection (Specific for Veo)
    if (typeof window !== 'undefined' && (window as any).aistudio) {
      const aistudio = (window as any).aistudio;
      const hasKey = await aistudio.hasSelectedApiKey();
      if (!hasKey) {
        await aistudio.openSelectKey();
      }
    }

    // Create a fresh instance to ensure we use the potentially newly selected key
    const videoAi = new GoogleGenAI({ apiKey: process.env.API_KEY });

    // 2. Parse Image
    const [prefix, base64Data] = imageDataUrl.split(',');
    const mimeType = prefix.match(/:(.*?);/)![1];

    // 3. Start Operation
    console.log("Starting video generation with prompt:", prompt);
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

    // 4. Poll for completion
    while (!operation.done) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Poll every 5s
      console.log("Polling video operation...");
      operation = await videoAi.operations.getVideosOperation({operation: operation});
    }

    // 5. Get Result
    const videoUri = operation.response?.generatedVideos?.[0]?.video?.uri;
    if (!videoUri) {
      throw new Error("Video generation completed but no URI returned.");
    }

    // 6. Fetch Video Bytes
    const videoResponse = await fetch(`${videoUri}&key=${process.env.API_KEY}`);
    if (!videoResponse.ok) throw new Error("Failed to download generated video.");
    
    const blob = await videoResponse.blob();
    return URL.createObjectURL(blob);

  } catch (error: any) {
    if (error.message?.includes('Requested entity was not found') && typeof window !== 'undefined' && (window as any).aistudio) {
      // Handle race condition/expired key by re-prompting
       await (window as any).aistudio.openSelectKey();
       // In a real app we might retry, but here we just throw to let user try again
    }
    console.error("Error generating video:", error);
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
   try {
    const response = await ai.models.generateContent({
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
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) throw new Error("No audio data returned");

    // Decode Base64 to binary
    const binaryString = atob(base64Audio);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Convert raw PCM to WAV blob
    const wavBlob = pcmToWav(bytes);
    return URL.createObjectURL(wavBlob);

   } catch (error) {
     console.error("Error generating speech:", error);
     throw error;
   }
}
