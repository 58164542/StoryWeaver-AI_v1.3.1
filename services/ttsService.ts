import type { Character, StoryboardDialogueLine } from '../types';

export interface FrameTtsRequest {
  projectId: string;
  episodeId: string;
  frameId: string;
  dialogues: StoryboardDialogueLine[];
  characters: Character[];
  pauseMs?: number;
  speed?: number; // 语速，范围 0.5-2.0，默认 1.0
}

export interface FrameTtsResponse {
  url: string;
  durationSeconds?: number | null;
}

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export async function generateFrameAudioWithMinimax(req: FrameTtsRequest): Promise<FrameTtsResponse> {
  const characterVoices: Record<string, string> = {};
  for (const c of req.characters) {
    if (c?.name && c.voiceId) {
      characterVoices[c.name] = c.voiceId;
    }
  }

  if (!characterVoices['__NARRATOR__']) {
    const narrator = req.characters.find(c => c.name === '旁白');
    if (narrator?.voiceId) {
      characterVoices['__NARRATOR__'] = narrator.voiceId;
    }
  }

  const response = await fetch(`${API_BASE_URL}/api/tts/minimax/frame`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: req.projectId,
      episodeId: req.episodeId,
      frameId: req.frameId,
      dialogues: req.dialogues,
      characterVoices,
      model: 'speech-2.6-hd',
      pauseMs: req.pauseMs ?? 100,
      speed: req.speed ?? 1.0
    })
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(json?.error || `HTTP ${response.status}`);
  }
  if (!json?.success) {
    throw new Error(json?.error || 'TTS request failed');
  }

  const data = json.data as { url: string; durationSeconds?: number | null };
  const url = data?.url;
  if (!url) {
    throw new Error('Missing audio url');
  }

  if (url.startsWith('/')) {
    return { ...data, url: `${API_BASE_URL}${url}` };
  }
  return data;
}
