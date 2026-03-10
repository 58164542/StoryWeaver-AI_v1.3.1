import express from 'express';
import fs from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  minimaxTts,
  buildAudioFilename,
  concatWithFixedPause
} from '../services/minimaxTts.js';

const router = express.Router();
const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_DIR = join(__dirname, '../../data');
const MEDIA_DIR = join(DATA_DIR, 'media');
const AUDIO_DIR = join(MEDIA_DIR, 'audio');

const ensureAudioDir = async () => {
  await fs.mkdir(AUDIO_DIR, { recursive: true });
};

const buildTextFromDialogues = (dialogues) => {
  const cleaned = (Array.isArray(dialogues) ? dialogues : [])
    .map(d => {
      const speaker = String(d?.speakerName ?? '').trim();
      const text = String(d?.text ?? '').trim();
      if (!text) return null;
      return { speakerName: speaker || undefined, text };
    })
    .filter(Boolean);

  return cleaned;
};

const getMp3DurationSeconds = async (filePath) => {
  try {
    const file = await fs.readFile(filePath);

    // Minimal MP3 duration calc based on CBR bitrate from first frame header.
    // Works best with CBR which is typical for MiniMax "bitrate" setting.
    const sizeBytes = file.length;

    // Skip ID3v2 tag if present
    let offset = 0;
    if (file.length >= 10 && file.toString('utf8', 0, 3) === 'ID3') {
      const b6 = file[6] & 0x7f;
      const b7 = file[7] & 0x7f;
      const b8 = file[8] & 0x7f;
      const b9 = file[9] & 0x7f;
      const tagSize = (b6 << 21) | (b7 << 14) | (b8 << 7) | b9;
      offset = 10 + tagSize;
    }

    // Find first frame sync 0xFFEx
    while (offset + 4 < file.length) {
      if (file[offset] === 0xff && (file[offset + 1] & 0xe0) === 0xe0) {
        break;
      }
      offset++;
    }

    if (offset + 4 >= file.length) return null;

    const header = file.readUInt32BE(offset);
    const bitrateIndex = (header >> 12) & 0x0f;
    // MPEG1 Layer3 bitrate table (kbps)
    const bitrates = [
      null, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, null
    ];
    const kbps = bitrates[bitrateIndex];
    if (!kbps) return null;

    const seconds = (sizeBytes * 8) / (kbps * 1000);
    if (!Number.isFinite(seconds)) return null;
    return seconds;
  } catch {
    return null;
  }
};

router.post('/minimax/frame', async (req, res) => {
  try {
    const {
      projectId,
      episodeId,
      frameId,
      dialogues,
      characterVoices,
      model = 'speech-2.6-hd',
      pauseMs = 100,
      emotion = 'neutral',
      speed = 1.0
    } = req.body || {};

    if (!projectId || !episodeId || !frameId) {
      return res.status(400).json({ success: false, error: 'Missing projectId/episodeId/frameId' });
    }

    const groupId = process.env.MINIMAX_GROUP_ID;
    const apiKey = process.env.MINIMAX_API_KEY;

    if (!groupId || !apiKey) {
      return res.status(500).json({
        success: false,
        error: 'Missing MINIMAX_GROUP_ID or MINIMAX_API_KEY in .env.local'
      });
    }

    const lines = buildTextFromDialogues(dialogues);
    if (lines.length === 0) {
      return res.status(400).json({ success: false, error: 'No dialogues text to speak' });
    }

    const voiceMap = characterVoices && typeof characterVoices === 'object' ? characterVoices : {};

    const lineBuffers = [];
    for (const line of lines) {
      const speakerKey = line.speakerName || '__NARRATOR__';
      const voiceId = voiceMap[speakerKey];
      if (!voiceId) {
        return res.status(400).json({
          success: false,
          error: `No voice mapping for speaker: ${speakerKey}. Please set voice in assets.`
        });
      }

      const { audioBuffer } = await minimaxTts({
        groupId: String(groupId).trim(),
        apiKey: String(apiKey).trim(),
        text: line.text,
        model,
        voiceId,
        speed,
        emotion
      });

      lineBuffers.push(audioBuffer);
    }

    await ensureAudioDir();

    const makePauseBuffer = async (ms) => {
      if (!ms || ms <= 0) return null;

      const pauseText = '.';
      const { audioBuffer } = await minimaxTts({
        groupId: String(groupId).trim(),
        apiKey: String(apiKey).trim(),
        text: pauseText,
        model,
        voiceId: voiceMap['__NARRATOR__'],
        emotion: 'neutral'
      });
      return audioBuffer;
    };

    const finalBuffer = await concatWithFixedPause({
      lineBuffers,
      pauseMs,
      makePauseBuffer
    });

    const filename = buildAudioFilename({ projectId, episodeId, frameId });
    const fullPath = join(AUDIO_DIR, filename);
    await fs.writeFile(fullPath, finalBuffer);

    const durationSeconds = await getMp3DurationSeconds(fullPath);

    const url = `/api/media/audio/${filename}`;

    res.json({
      success: true,
      data: {
        url,
        durationSeconds
      }
    });
  } catch (error) {
    console.error('MiniMax frame TTS failed:', error);
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

export default router;
