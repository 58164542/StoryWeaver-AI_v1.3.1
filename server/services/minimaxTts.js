import crypto from 'crypto';

const MINIMAX_API_URL = 'https://api.minimax.chat/v1/t2a_v2?GroupId=';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const buildTtsBody = ({
  text,
  model,
  voiceId,
  speed,
  volume,
  pitch,
  sampleRate,
  bitrate,
  audioFormat,
  channel,
  languageBoost,
  subtitleEnable,
  emotion
}) => {
  const body = {
    model,
    text,
    stream: false,
    audio_setting: {
      sample_rate: sampleRate,
      bitrate,
      format: audioFormat,
      channel
    }
  };

  // Mimic reference app behavior: some voices are served via timber_weights.
  const timberVoices = new Set([
    'fangqi_minimax',
    'weixue_minimax',
    'yingxiao_minimax',
    'jianmo_minimax',
    'zhuzixiao_minimax'
  ]);

  if (timberVoices.has(voiceId)) {
    body.timber_weights = [{ voice_id: voiceId, weight: 100 }];
    body.voice_setting = {
      voice_id: '',
      speed,
      vol: volume,
      pitch,
      emotion
    };
  } else {
    body.voice_setting = {
      voice_id: voiceId,
      speed,
      vol: volume,
      pitch,
      emotion
    };
  }

  if (languageBoost) {
    body.language_boost = languageBoost;
  }

  if (subtitleEnable) {
    body.subtitle_enable = true;
  }

  return body;
};

export async function minimaxTts({
  groupId,
  apiKey,
  text,
  model,
  voiceId,
  speed = 1.0,
  volume = 1.0,
  pitch = 0,
  sampleRate = 32000,
  bitrate = 128000,
  audioFormat = 'mp3',
  channel = 1,
  languageBoost = 'auto',
  subtitleEnable = false,
  emotion = 'neutral'
}) {
  const cleanGroupId = String(groupId ?? '').trim();
  const cleanApiKey = String(apiKey ?? '').trim();

  if (!cleanGroupId) throw new Error('MINIMAX_GROUP_ID is missing');
  if (!cleanApiKey) throw new Error('MINIMAX_API_KEY is missing');
  if (!text || !String(text).trim()) throw new Error('text is empty');

  const url = `${MINIMAX_API_URL}${encodeURIComponent(cleanGroupId)}`;
  const body = buildTtsBody({
    text,
    model,
    voiceId,
    speed,
    volume,
    pitch,
    sampleRate,
    bitrate,
    audioFormat,
    channel,
    languageBoost,
    subtitleEnable,
    emotion
  });

  const start = Date.now();
  let attempt = 0;
  let response;

  while (true) {
    attempt++;
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cleanApiKey}`
      },
      body: JSON.stringify(body)
    });

    if (response.ok) break;

    const errorText = await response.text();
    const isRateLimited = response.status === 429 || /rate\s*limit|rpm/i.test(errorText);
    if (!isRateLimited) {
      throw new Error(`MiniMax TTS error (${response.status}): ${errorText}`);
    }

    const retryAfter = Number(response.headers.get('retry-after') || '');
    const jitter = Math.floor(Math.random() * 250);
    const backoff = Math.min(60000, 1000 * Math.pow(2, Math.min(attempt, 6)));
    const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff) + jitter;

    if (Date.now() - start > 30 * 60 * 1000) {
      throw new Error(`MiniMax TTS error (429): rate limit exceeded too long`);
    }

    await sleep(waitMs);
  }

  const json = await response.json();
  const audioHex = json?.data?.audio;
  if (!audioHex || typeof audioHex !== 'string') {
    const msg = json?.base_resp?.status_msg || 'MiniMax response missing data.audio';
    throw new Error(msg);
  }

  const audioBuffer = Buffer.from(audioHex, 'hex');
  return { audioBuffer, meta: json };
}

export function buildAudioFilename({
  projectId,
  episodeId,
  frameId
}) {
  const hash = crypto
    .createHash('sha1')
    .update(`${projectId}::${episodeId}::${frameId}::${Date.now()}`)
    .digest('hex')
    .slice(0, 10);

  return `tts_${projectId}_${episodeId}_${frameId}_${hash}.mp3`;
}

export async function concatMp3Segments(segments) {
  // MP3 frame concatenation works reasonably for most encoders.
  // We insert short silence between lines by repeating a pre-generated mp3 chunk.
  // But since we don't have a native mp3 silence generator here, we just do raw concat.
  // The caller should generate silence segments via TTS if strict pause is required.
  const buffers = segments.filter(Boolean).map(s => Buffer.isBuffer(s) ? s : s.audioBuffer);
  return Buffer.concat(buffers);
}

export async function concatWithFixedPause({
  lineBuffers,
  pauseMs,
  makePauseBuffer
}) {
  const out = [];
  for (let i = 0; i < lineBuffers.length; i++) {
    out.push(lineBuffers[i]);
    if (i < lineBuffers.length - 1 && pauseMs > 0) {
      const pauseBuffer = await makePauseBuffer(pauseMs);
      if (pauseBuffer) out.push(pauseBuffer);
      // avoid rate-limit tight loops if pauseBuffer is generated remotely
      await sleep(50);
    }
  }
  return Buffer.concat(out);
}
