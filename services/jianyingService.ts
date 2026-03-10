import { v4 as uuidv4 } from 'uuid';
import type { Episode, StoryboardFrame, GlobalSettings, ProjectSettings } from '../types';
import { Logger } from '../utils/logger';

/**
 * 剪映工程导出服务
 * 格式参考 pyJianYingDraft 项目，确保素材结构与剪映完全兼容
 */

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// ─── 工具函数 ────────────────────────────────────────────────────────────────

const sec2us = (s: number): number => Math.round(s * 1_000_000);

const getCanvasSize = (ratio: string) => {
  const map: Record<string, { width: number; height: number }> = {
    '16:9': { width: 1920, height: 1080 },
    '9:16': { width: 1080, height: 1920 },
    '1:1':  { width: 1080, height: 1080 },
    '4:3':  { width: 1440, height: 1080 },
    '3:4':  { width: 1080, height: 1440 },
  };
  return map[ratio] ?? map['16:9'];
};

const normalizeMediaUrl = (url: string): string => {
  const t = String(url || '').trim();
  if (!t) return t;
  if (t.startsWith('/')) return `${API_BASE_URL}${t}`;
  return t;
};

const downloadFile = async (
  url: string,
  filename: string,
  dirHandle: FileSystemDirectoryHandle
): Promise<string> => {
  const normalized = normalizeMediaUrl(url);
  let response: Response | null = null;
  try { response = await fetch(normalized); } catch { /* ignore */ }
  if (!response?.ok) {
    response = await fetch(`${API_BASE_URL}/api/proxy?url=${encodeURIComponent(normalized)}`);
  }
  if (!response.ok) throw new Error(`Failed to fetch ${normalized}: ${response.statusText}`);
  const blob = await response.blob();
  const fh = await dirHandle.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
  return filename;
};

const downloadFileAsBlob = async (url: string): Promise<Blob> => {
  const normalized = normalizeMediaUrl(url);
  let response: Response | null = null;
  try { response = await fetch(normalized); } catch { /* ignore */ }
  if (!response?.ok) {
    response = await fetch(`${API_BASE_URL}/api/proxy?url=${encodeURIComponent(normalized)}`);
  }
  if (!response.ok) throw new Error(`Failed to fetch ${normalized}: ${response.statusText}`);
  return response.blob();
};

const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

const generatePlaceholderImageAsBase64 = async (
  width: number,
  height: number,
  color: string
): Promise<string> => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob(b => b ? res(b) : rej(new Error('blob failed')), 'image/png')
  );
  return blobToBase64(blob);
};

// ─── 素材 JSON 构建（严格对齐 pyJianYingDraft 格式）────────────────────────

/**
 * 视频素材（视频文件）
 * material_type = "video"
 */
const buildVideoMaterial = (id: string, absPath: string, name: string, durationUs: number, width: number, height: number) => ({
  audio_fade: null,
  category_id: '',
  category_name: 'local',
  check_flag: 63487,
  crop: {
    upper_left_x: 0.0, upper_left_y: 0.0,
    upper_right_x: 1.0, upper_right_y: 0.0,
    lower_left_x: 0.0, lower_left_y: 1.0,
    lower_right_x: 1.0, lower_right_y: 1.0,
  },
  crop_ratio: 'free',
  crop_scale: 1.0,
  duration: durationUs,
  height,
  id,
  local_material_id: '',
  material_id: id,
  material_name: name,
  media_path: '',
  path: absPath,
  type: 'video',
  width,
});

/**
 * 图片素材
 * material_type = "photo"，duration 固定 10800000000（3h，剪映规范）
 */
const buildPhotoMaterial = (id: string, absPath: string, name: string, width: number, height: number) => ({
  audio_fade: null,
  category_id: '',
  category_name: 'local',
  check_flag: 63487,
  crop: {
    upper_left_x: 0.0, upper_left_y: 0.0,
    upper_right_x: 1.0, upper_right_y: 0.0,
    lower_left_x: 0.0, lower_left_y: 1.0,
    lower_right_x: 1.0, lower_right_y: 1.0,
  },
  crop_ratio: 'free',
  crop_scale: 1.0,
  duration: 10_800_000_000, // 3h，图片素材固定值
  height,
  id,
  local_material_id: '',
  material_id: id,
  material_name: name,
  media_path: '',
  path: absPath,
  type: 'photo',
  width,
});

/**
 * 音频素材
 * type = "extract_music"
 */
const buildAudioMaterial = (id: string, absPath: string, name: string, durationUs: number) => ({
  app_id: 0,
  category_id: '',
  category_name: 'local',
  check_flag: 3,
  copyright_limit_type: 'none',
  duration: durationUs,
  effect_id: '',
  formula_id: '',
  id,
  local_material_id: id,
  music_id: id,
  name,
  path: absPath,
  source_platform: 0,
  type: 'extract_music',
  wave_points: [],
});

/**
 * Speed 素材（每个视频/音频 segment 都需要一个）
 */
const buildSpeedMaterial = (id: string, speed: number = 1.0) => ({
  curve_speed: null,
  id,
  mode: 0,
  speed,
  type: 'speed',
});

/**
 * 文本素材
 */
const buildTextMaterial = (id: string, text: string, durationUs: number) => {
  const contentJson = JSON.stringify({
    styles: [{
      fill: {
        alpha: 1.0,
        content: { render_type: 'solid', solid: { alpha: 1.0, color: [1.0, 1.0, 1.0] } },
      },
      range: [0, text.length],
      size: 5.0,
      bold: false,
      italic: false,
      underline: false,
      strokes: [],
    }],
    text,
  }, null, 0);

  return {
    id,
    content: contentJson,
    typesetting: 0,
    alignment: 1,       // 居中
    letter_spacing: 0,
    line_spacing: 0.02,
    line_feed: 1,
    line_max_width: 0.82,
    force_apply_line_max_width: false,
    check_flag: 7,
    type: 'subtitle',
    global_alpha: 1.0,
  };
};

// ─── Segment JSON 构建 ───────────────────────────────────────────────────────

const buildVideoSegment = (
  segId: string, materialId: string, speedId: string,
  targetStart: number, targetDuration: number,
  sourceStart: number, sourceDuration: number,
  renderIndex: number,
  speed: number = 1.0
) => ({
  // 通用基础字段
  enable_adjust: true,
  enable_color_correct_adjust: false,
  enable_color_curves: true,
  enable_color_match_adjust: false,
  enable_color_wheels: true,
  enable_lut: true,
  enable_smart_color_adjust: false,
  last_nonzero_volume: 1.0,
  reverse: false,
  track_attribute: 0,
  track_render_index: renderIndex,
  render_index: renderIndex,
  visible: true,
  id: segId,
  material_id: materialId,
  target_timerange: { start: targetStart, duration: targetDuration },
  source_timerange: { start: sourceStart, duration: sourceDuration },
  common_keyframes: [],
  keyframe_refs: [],
  // 媒体字段
  speed,
  volume: 1.0,
  extra_material_refs: [speedId],
  is_tone_modify: false,
  // 视觉字段
  clip: {
    alpha: 1.0,
    flip: { horizontal: false, vertical: false },
    rotation: 0.0,
    scale: { x: 1.0, y: 1.0 },
    transform: { x: 0.0, y: 0.0 },
  },
  uniform_scale: { on: true, value: 1.0 },
  hdr_settings: { intensity: 1.0, mode: 1, nits: 1000 },
});

const buildAudioSegment = (
  segId: string, materialId: string, speedId: string,
  targetStart: number, targetDuration: number,
  sourceStart: number, sourceDuration: number,
  renderIndex: number
) => ({
  enable_adjust: true,
  enable_color_correct_adjust: false,
  enable_color_curves: true,
  enable_color_match_adjust: false,
  enable_color_wheels: true,
  enable_lut: true,
  enable_smart_color_adjust: false,
  last_nonzero_volume: 1.0,
  reverse: false,
  track_attribute: 0,
  track_render_index: renderIndex,
  render_index: renderIndex,
  visible: true,
  id: segId,
  material_id: materialId,
  target_timerange: { start: targetStart, duration: targetDuration },
  source_timerange: { start: sourceStart, duration: sourceDuration },
  common_keyframes: [],
  keyframe_refs: [],
  speed: 1.0,
  volume: 1.0,
  extra_material_refs: [speedId],
  is_tone_modify: false,
  clip: null,
  hdr_settings: null,
});

const buildTextSegment = (
  segId: string, materialId: string,
  targetStart: number, targetDuration: number,
  renderIndex: number
) => ({
  enable_adjust: true,
  enable_color_correct_adjust: false,
  enable_color_curves: true,
  enable_color_match_adjust: false,
  enable_color_wheels: true,
  enable_lut: true,
  enable_smart_color_adjust: false,
  last_nonzero_volume: 1.0,
  reverse: false,
  track_attribute: 0,
  track_render_index: renderIndex,
  render_index: renderIndex,
  visible: true,
  id: segId,
  material_id: materialId,
  target_timerange: { start: targetStart, duration: targetDuration },
  source_timerange: null,
  common_keyframes: [],
  keyframe_refs: [],
  speed: 1.0,
  volume: 1.0,
  extra_material_refs: [],
  is_tone_modify: false,
  clip: {
    alpha: 1.0,
    flip: { horizontal: false, vertical: false },
    rotation: 0.0,
    scale: { x: 1.0, y: 1.0 },
    transform: { x: 0.0, y: -0.8 }, // 字幕默认位置
  },
  uniform_scale: { on: true, value: 1.0 },
});

// ─── draft_content.json 顶层结构 ─────────────────────────────────────────────

const buildDraftContent = (
  canvas: { width: number; height: number },
  materials: Record<string, unknown[]>,
  tracks: unknown[],
  totalDurationUs: number
) => ({
  canvas_config: { height: canvas.height, ratio: 'original', width: canvas.width },
  color_space: 0,
  config: {
    adjust_max_index: 1,
    attachment_info: [],
    combination_max_index: 1,
    export_range: null,
    extract_audio_last_index: 1,
    lyrics_recognition_id: '',
    lyrics_sync: true,
    lyrics_taskinfo: [],
    maintrack_adsorb: true,
    material_save_mode: 0,
    multi_language_current: 'none',
    multi_language_list: [],
    multi_language_main: 'none',
    multi_language_mode: 'none',
    original_sound_last_index: 1,
    record_audio_last_index: 1,
    sticker_max_index: 1,
    subtitle_keywords_config: null,
    subtitle_recognition_id: '',
    subtitle_sync: true,
    subtitle_taskinfo: [],
    system_font_list: [],
    video_mute: false,
    zoom_info_params: null,
  },
  cover: null,
  create_time: 0,
  duration: totalDurationUs,
  extra_info: null,
  fps: 30.0,
  free_render_index_mode_on: false,
  group_container: null,
  id: uuidv4().toUpperCase(),
  keyframe_graph_list: [],
  keyframes: {
    adjusts: [], audios: [], effects: [], filters: [],
    handwrites: [], stickers: [], texts: [], videos: [],
  },
  last_modified_platform: { app_id: 3704, app_source: 'lv', app_version: '5.9.0', os: 'windows' },
  materials,
  mutable_config: null,
  name: '',
  new_version: '110.0.0',
  platform: { app_id: 3704, app_source: 'lv', app_version: '5.9.0', os: 'windows' },
  relationships: [],
  render_index_track_mode_on: false,
  retouch_cover: null,
  source: 'default',
  static_cover_image_path: '',
  time_marks: null,
  tracks,
  update_time: 0,
  version: 360000,
});

// ─── draft_meta_info.json ────────────────────────────────────────────────────

const buildDraftMeta = (draftId: string, draftName: string, rootPath: string, totalDurationUs: number) => ({
  cloud_package_completed_time: '',
  draft_cloud_capcut_purchase_info: '',
  draft_cloud_last_action_download: false,
  draft_cloud_materials: [],
  draft_cloud_purchase_info: '',
  draft_cloud_template_id: '',
  draft_cloud_tutorial_info: '',
  draft_cloud_videocut_purchase_info: '',
  draft_cover: '',
  draft_deeplink_url: '',
  draft_enterprise_info: {
    draft_enterprise_extra: '',
    draft_enterprise_id: '',
    draft_enterprise_name: '',
    enterprise_material: [],
  },
  draft_fold_path: '',
  draft_id: draftId,
  draft_is_ai_packaging_used: false,
  draft_is_ai_shorts: false,
  draft_is_ai_translate: false,
  draft_is_article_video_draft: false,
  draft_is_from_deeplink: 'false',
  draft_is_invisible: false,
  draft_materials: [
    { type: 0, value: [] }, { type: 1, value: [] }, { type: 2, value: [] },
    { type: 3, value: [] }, { type: 6, value: [] }, { type: 7, value: [] },
    { type: 8, value: [] },
  ],
  draft_materials_copied_info: [],
  draft_name: draftName,
  draft_new_version: '',
  draft_removable_storage_device: '',
  draft_root_path: rootPath,
  draft_segment_extra_info: [],
  draft_type: '',
  tm_draft_cloud_completed: '',
  tm_draft_cloud_modified: 0,
  tm_draft_removed: 0,
  tm_duration: totalDurationUs,
});

// ─── 字幕文本提取 ─────────────────────────────────────────────────────────────

const extractSubtitle = (frame: StoryboardFrame): string => {
  if (frame.dialogues?.length) {
    return frame.dialogues.map(d => (d.text || '').trim()).filter(Boolean).join('\n').trim();
  }
  if (!frame.dialogue) return '';
  return frame.dialogue
    .split(/\r?\n+/)
    .map(line => {
      const m = line.trim().match(/^.{1,20}：(.+)$/);
      return (m ? m[1] : line).trim();
    })
    .filter(Boolean)
    .join('\n')
    .trim();
};

// ─── IndexedDB ───────────────────────────────────────────────────────────────
// ─── 主导出函数 ───────────────────────────────────────────────────────────────

export const exportToJianying = async (
  episode: Episode,
  projectName: string,
  projectSettings: ProjectSettings,
  globalSettings: GlobalSettings,
  onProgress?: (current: number, total: number, message: string) => void
): Promise<void> => {
  Logger.logInfo('Starting Jianying export', { episodeName: episode.name });

  if (!globalSettings.jianyingExportPath)
    throw new Error('请先在全局设置中指定剪映工程导出目录');
  if (!globalSettings.jianyingExportPathFull?.trim())
    throw new Error('请在全局设置中填写"剪映工程完整路径"（JianyingPro Drafts 的真实磁盘路径）');

  onProgress?.(0, 100, '初始化导出会话...');

  const canvas = getCanvasSize(projectSettings.aspectRatio);
  const normalizedRoot = (globalSettings.jianyingExportPathFull || '').trim().replace(/[/\\]+/g, '\\');
  const sanitizedName = `${projectName}_${episode.name}`.replace(/[<>:"/\\|?*]/g, '_');
  const projectRoot = `${normalizedRoot}\\${sanitizedName}`;
  const absAssetPath = (filename: string) => `${projectRoot}\\assets\\${filename}`;

  const defaultImgDur = globalSettings.defaultImageDuration || 3;
  const placeholderColor = globalSettings.placeholderColor || '#000000';

  // ── 建立导出会话（服务端创建目录）──
  const initResp = await fetch(`${API_BASE_URL}/api/jianying/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectName, episodeName: episode.name }),
  });
  if (!initResp.ok) {
    const e = await initResp.json().catch(() => ({}));
    throw new Error(`导出初始化失败: ${e.error || initResp.statusText}`);
  }
  const { sessionId } = await initResp.json();

  // ── 逐文件上传到服务端 ──
  const uploadFile = async (filename: string, data: string): Promise<void> => {
    const resp = await fetch(`${API_BASE_URL}/api/jianying/upload-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, filename, data }),
    });
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(`文件上传失败 [${filename}]: ${e.error || resp.statusText}`);
    }
  };

  // 素材列表
  const videoMaterials: ReturnType<typeof buildVideoMaterial | typeof buildPhotoMaterial>[] = [];
  const audioMaterials: ReturnType<typeof buildAudioMaterial>[] = [];
  const textMaterials: ReturnType<typeof buildTextMaterial>[] = [];
  const speedMaterials: ReturnType<typeof buildSpeedMaterial>[] = [];

  // 轨道片段列表
  const videoSegments: unknown[] = [];
  const audioSegments: unknown[] = [];
  const textSegments: unknown[] = [];

  const frames = [...episode.frames]
    .filter(f => f.videoUrl || f.imageUrl || f.dialogue || f.dialogues?.length || f.audioUrl)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  let currentUs = 0;

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    onProgress?.(5 + Math.floor((i / frames.length) * 78), 100, `处理分镜 ${i + 1}/${frames.length}...`);

    // ── 时长计算：以音频为基准对齐 ──
    const hasAudio = !!frame.audioUrl?.trim();
    const rawAudioDur = Number(frame.audioDuration);
    const audioDurSec: number | null = hasAudio && Number.isFinite(rawAudioDur) && rawAudioDur > 0
      ? rawAudioDur : null;

    const rawVideoDur = Number(frame.videoDuration);
    const videoOriginalDurSec = Number.isFinite(rawVideoDur) && rawVideoDur > 0
      ? rawVideoDur : null;

    // 时间轴显示时长：有音频则以音频为准，否则以视频/默认为准
    const targetDurSec = audioDurSec ?? videoOriginalDurSec ?? defaultImgDur;
    const targetDurUs = sec2us(targetDurSec);

    // ── 视觉素材 ──
    const matId = uuidv4();
    const speedId = uuidv4();

    // 先尝试拉取视频，URL 失效时降级为图片，不中断导出
    let videoBlob: Blob | null = null;
    if (frame.videoUrl) {
      try {
        videoBlob = await downloadFileAsBlob(frame.videoUrl);
      } catch (e) {
        Logger.logInfo(`分镜 ${frame.index + 1} 视频链接失效，降级使用图片导出`, { url: frame.videoUrl, error: String(e) });
        videoBlob = null;
      }
    }

    // 变速计算：只有视频实际可用时才做变速对齐
    const canApplySpeed = !!(videoBlob && audioDurSec && videoOriginalDurSec);
    const visualSpeedRatio = canApplySpeed
      ? videoOriginalDurSec! / audioDurSec!
      : 1.0;

    // source_timerange：视频用原始时长，图片/占位用目标时长
    const videoOriginalDurUs = videoOriginalDurSec ? sec2us(videoOriginalDurSec) : targetDurUs;
    const sourceDurUs = videoBlob ? videoOriginalDurUs : targetDurUs;

    if (videoBlob) {
      const ext = frame.videoUrl!.includes('.mp4') ? 'mp4' : 'mov';
      const filename = `video_${frame.index}_${uuidv4()}.${ext}`;
      const base64 = await blobToBase64(videoBlob);
      await uploadFile(filename, base64);
      // 素材 duration 存视频原始时长（剪映规范：素材时长 = 源文件时长）
      videoMaterials.push(buildVideoMaterial(matId, absAssetPath(filename), filename, videoOriginalDurUs, canvas.width, canvas.height));
    } else if (frame.imageUrl) {
      let imageBlob: Blob | null = null;
      try {
        imageBlob = await downloadFileAsBlob(frame.imageUrl);
      } catch (e) {
        Logger.logInfo(`分镜 ${frame.index + 1} 图片链接失效，降级使用占位图导出`, { url: frame.imageUrl, error: String(e) });
      }
      if (imageBlob) {
        const ext = frame.imageUrl.toLowerCase().includes('.png') ? 'png' : 'jpg';
        const filename = `image_${frame.index}_${uuidv4()}.${ext}`;
        const base64 = await blobToBase64(imageBlob);
        await uploadFile(filename, base64);
        videoMaterials.push(buildPhotoMaterial(matId, absAssetPath(filename), filename, canvas.width, canvas.height));
      } else {
        const filename = `placeholder_${frame.index}_${uuidv4()}.png`;
        const base64 = await generatePlaceholderImageAsBase64(canvas.width, canvas.height, placeholderColor);
        await uploadFile(filename, base64);
        videoMaterials.push(buildPhotoMaterial(matId, absAssetPath(filename), filename, canvas.width, canvas.height));
      }
    } else {
      // 占位图（黑色 PNG），作为 photo 类型
      const filename = `placeholder_${frame.index}_${uuidv4()}.png`;
      const base64 = await generatePlaceholderImageAsBase64(canvas.width, canvas.height, placeholderColor);
      await uploadFile(filename, base64);
      videoMaterials.push(buildPhotoMaterial(matId, absAssetPath(filename), filename, canvas.width, canvas.height));
    }

    speedMaterials.push(buildSpeedMaterial(speedId, visualSpeedRatio));
    videoSegments.push(buildVideoSegment(
      uuidv4(), matId, speedId,
      currentUs, targetDurUs,   // target：时间轴上的展示时长
      0, sourceDurUs,           // source：消耗的源素材时长
      0,
      visualSpeedRatio          // speed：变速比 = source / target
    ));

    // ── 音频素材 ──
    if (hasAudio) {
      const audioMatId = uuidv4();
      const audioSpeedId = uuidv4();
      const ext = frame.audioUrl!.includes('.flac') ? 'flac' : frame.audioUrl!.includes('.pcm') ? 'pcm' : 'mp3';
      const filename = `audio_${frame.index}_${uuidv4()}.${ext}`;
      const blob = await downloadFileAsBlob(frame.audioUrl!);
      const base64 = await blobToBase64(blob);
      await uploadFile(filename, base64);

      // 音频以实际时长为准，无时长信息则与视觉时长保持一致
      const audioDurUs = audioDurSec ? sec2us(audioDurSec) : targetDurUs;

      audioMaterials.push(buildAudioMaterial(audioMatId, absAssetPath(filename), filename, audioDurUs));
      speedMaterials.push(buildSpeedMaterial(audioSpeedId, 1.0));
      audioSegments.push(buildAudioSegment(
        uuidv4(), audioMatId, audioSpeedId,
        currentUs, audioDurUs,
        0, audioDurUs,
        0
      ));
    }

    // ── 字幕 ──
    const subtitle = extractSubtitle(frame);
    if (subtitle) {
      const textMatId = uuidv4();
      textMaterials.push(buildTextMaterial(textMatId, subtitle, targetDurUs));
      textSegments.push(buildTextSegment(uuidv4(), textMatId, currentUs, targetDurUs, 15000));
    }

    currentUs += targetDurUs;
  }

  onProgress?.(85, 100, '生成剪映工程文件...');

  // ── 组装 materials ──
  const materials: Record<string, unknown[]> = {
    ai_translates: [], audio_balances: [], audio_effects: [], audio_fades: [],
    audio_track_indexes: [], audios: audioMaterials, beats: [], canvases: [],
    chromas: [], color_curves: [], digital_humans: [], drafts: [], effects: [],
    flowers: [], green_screens: [], handwrites: [], hsl: [], images: [],
    log_color_wheels: [], loudnesses: [], manual_deformations: [], masks: [],
    material_animations: [], material_colors: [], multi_language_refs: [],
    placeholders: [], plugin_effects: [], primary_color_wheels: [],
    realtime_denoises: [], shapes: [], smart_crops: [], smart_relights: [],
    sound_channel_mappings: [], speeds: speedMaterials, stickers: [],
    tail_leaders: [], text_templates: [], texts: textMaterials, time_marks: [],
    transitions: [], video_effects: [], video_trackings: [], videos: videoMaterials,
    vocal_beautifys: [], vocal_separations: [],
  };

  // ── 组装 tracks ──
  const tracks: unknown[] = [
    {
      attribute: 0, flag: 0,
      id: uuidv4(), is_default_name: true, name: '',
      segments: videoSegments, type: 'video',
    },
    ...(audioSegments.length > 0 ? [{
      attribute: 0, flag: 0,
      id: uuidv4(), is_default_name: true, name: '',
      segments: audioSegments, type: 'audio',
    }] : []),
    ...(textSegments.length > 0 ? [{
      attribute: 0, flag: 0,
      id: uuidv4(), is_default_name: true, name: '',
      segments: textSegments, type: 'text',
    }] : []),
  ];

  const draftId = uuidv4().toUpperCase();
  const draftContent = buildDraftContent(canvas, materials, tracks, currentUs);
  draftContent.id = draftId;

  const draftMeta = buildDraftMeta(draftId, sanitizedName, projectRoot, currentUs);

  onProgress?.(92, 100, '写入剪映工程文件...');

  // ── 发送 JSON 完成导出（仅 JSON，无二进制）──
  const response = await fetch(`${API_BASE_URL}/api/jianying/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, draftContent, draftMeta }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`服务器导出失败: ${error.error || response.statusText}`);
  }

  onProgress?.(100, 100, '导出完成！');
  Logger.logInfo('Jianying export completed', { frames: frames.length, duration: currentUs / 1e6 });
};
