/**
 * 媒体文件相关的 API 路由
 */
import express from 'express';
import { saveMediaFile, deleteMediaFile, getMediaPath } from '../utils/fileManager.js';
import fs from 'fs/promises';

const router = express.Router();

/**
 * POST /api/media/upload
 * 上传媒体文件（Base64 格式）
 *
 * Request body:
 * {
 *   "base64Data": "data:image/png;base64,...",
 *   "filename": "character_abc123"
 * }
 */
router.post('/upload', async (req, res) => {
  try {
    const { base64Data, filename } = req.body;

    if (!base64Data || !filename) {
      return res.status(400).json({
        success: false,
        error: '缺少必需字段: base64Data 和 filename'
      });
    }

    // 保存文件
    const savedFilename = await saveMediaFile(base64Data, filename);

    // 确定媒体类型
    const mimeType = base64Data.match(/^data:([^;]+);base64,/)?.[1];
    let mediaType = 'images';
    if (mimeType?.startsWith('video/')) mediaType = 'videos';
    if (mimeType?.startsWith('audio/')) mediaType = 'audio';

    // 返回访问 URL
    const url = `/api/media/${mediaType}/${savedFilename}`;

    res.json({
      success: true,
      data: {
        filename: savedFilename,
        url,
        type: mediaType
      }
    });
  } catch (error) {
    console.error('上传媒体文件失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 通用：拉取外部媒体文件（图片或视频）并保存到本地媒体目录
 * hint: 'images' | 'videos' — 优先级低于 content-type 判断，仅在无法从响应头推断时使用
 */
async function saveExternalMediaCore(externalUrl, filename, hint) {
  const trimmed = String(externalUrl || '').trim();

  // 已经是本地 API 地址，直接返回
  const localMatch = trimmed.match(/\/api\/media\/(images|videos|audio)\/([^?#]+)/);
  if (localMatch) {
    return {
      filename: decodeURIComponent(localMatch[2]),
      url: localMatch[0],
      type: localMatch[1]
    };
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('仅支持 http/https 媒体地址');
  }

  // 即梦/字节 CDN 需要 User-Agent 和 Referer，否则返回 500
  const fetchHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  };
  if (/jimeng\.com|dreamnia|byteimg\.com|bytedance/i.test(trimmed)) {
    fetchHeaders['Referer'] = 'https://jimeng.jianying.com/';
  }

  const response = await fetch(trimmed, { headers: fetchHeaders });
  if (!response.ok) {
    throw new Error(`拉取外部媒体失败 (${response.status})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentTypeHeader = (response.headers.get('content-type') || '').split(';')[0].trim();

  let sourcePathname = '';
  try { sourcePathname = new URL(trimmed).pathname; } catch { /* ignore */ }
  const sourceExt = sourcePathname.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/)?.[1]?.toLowerCase();

  const mimeByExt = {
    // 图片
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
    // 视频
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    m4v: 'video/mp4', avi: 'video/x-msvideo',
  };
  const extByMime = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
    'image/gif': '.gif', 'image/avif': '.avif',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  };

  // 推断 MIME：优先响应头，其次扩展名，最后 hint
  let mimeType = '';
  if (contentTypeHeader && (contentTypeHeader.startsWith('image/') || contentTypeHeader.startsWith('video/'))) {
    mimeType = contentTypeHeader;
  } else if (sourceExt && mimeByExt[sourceExt]) {
    mimeType = mimeByExt[sourceExt];
  } else {
    mimeType = hint === 'images' ? 'image/jpeg' : 'video/mp4';
  }

  // 推断媒体类型文件夹
  const mediaType = mimeType.startsWith('image/') ? 'images' : 'videos';

  // 推断文件扩展名
  const inferredExt = extByMime[mimeType] || (mediaType === 'images' ? '.jpg' : '.mp4');
  const safeBase = String(filename || `external_${Date.now()}`)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || `external_${Date.now()}`;
  const finalFilename = safeBase.includes('.') ? safeBase : `${safeBase}${inferredExt}`;

  const base64Data = `data:${mimeType};base64,${buffer.toString('base64')}`;
  const savedFilename = await saveMediaFile(base64Data, finalFilename);
  const localUrl = `/api/media/${mediaType}/${savedFilename}`;

  return { filename: savedFilename, url: localUrl, type: mediaType };
}

/**
 * POST /api/media/save-external-video
 * 拉取外部视频并保存到本地媒体目录
 */
router.post('/save-external-video', async (req, res) => {
  try {
    const { url, filename } = req.body;
    if (!url) return res.status(400).json({ success: false, error: '缺少必需字段: url' });
    const result = await saveExternalMediaCore(url, filename, 'videos');
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('保存外部视频到本地失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/media/save-external-image
 * 拉取外部图片并保存到本地媒体目录
 */
router.post('/save-external-image', async (req, res) => {
  try {
    const { url, filename } = req.body;
    if (!url) return res.status(400).json({ success: false, error: '缺少必需字段: url' });
    const result = await saveExternalMediaCore(url, filename, 'images');
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('保存外部图片到本地失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/media/:type/:filename
 * 删除媒体文件
 */
router.delete('/:type/:filename', async (req, res) => {
  try {
    const { type, filename } = req.params;

    if (!['images', 'videos', 'audio'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: '无效的媒体类型，必须是 images, videos 或 audio'
      });
    }

    await deleteMediaFile(type, filename);

    res.json({ success: true, message: '文件已删除' });
  } catch (error) {
    console.error('删除媒体文件失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/media/:type/:filename
 * 获取媒体文件
 */
router.get('/:type/:filename', async (req, res) => {
  try {
    const { type, filename } = req.params;

    if (!['images', 'videos', 'audio'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: '无效的媒体类型'
      });
    }

    const filePath = getMediaPath(type, filename);

    // 检查文件是否存在
    try {
      await fs.access(filePath);
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: '文件不存在'
      });
    }

    // 发送文件
    res.sendFile(filePath);
  } catch (error) {
    console.error('获取媒体文件失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/media/read-as-base64
 * 将后端媒体文件读取为 base64 DataURL，供前端通过 API 绕过跨域问题获取
 *
 * Request body: { url: "http://172.30.30.220:3001/api/media/images/xxx.png" }
 * Response:     { success: true, data: { base64Data: "data:image/png;base64,..." } }
 */
router.post('/read-as-base64', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: '缺少 url 参数' });
    }

    const normalizedUrl = String(url).trim();
    let buffer;
    let mimeType = 'image/jpeg';

    // 本地媒体文件
    const match = normalizedUrl.match(/\/api\/media\/(images|videos|audio)\/([^?#]+)/);
    if (match) {
      const [, type, filename] = match;
      const filePath = getMediaPath(type, filename);

      try {
        await fs.access(filePath);
      } catch {
        return res.status(404).json({ success: false, error: '文件不存在' });
      }

      buffer = await fs.readFile(filePath);
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav' };
      mimeType = mimeMap[ext] || 'image/jpeg';
    } else if (/^https?:\/\//i.test(normalizedUrl)) {
      const response = await fetch(normalizedUrl);
      if (!response.ok) {
        return res.status(response.status).json({ success: false, error: `远程文件读取失败 (${response.status})` });
      }
      const arrayBuffer = await response.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
      mimeType = (response.headers.get('content-type') || '').split(';')[0].trim() || 'image/jpeg';
    } else {
      return res.status(400).json({ success: false, error: '无效的媒体 URL，仅支持本地媒体 URL 或公网 http/https URL' });
    }

    const base64Data = `data:${mimeType};base64,${buffer.toString('base64')}`;
    res.json({ success: true, data: { base64Data } });
  } catch (error) {
    console.error('读取媒体文件为 base64 失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/media/info/:type/:filename
 * 获取媒体文件信息（不返回文件内容）
 */
router.get('/info/:type/:filename', async (req, res) => {
  try {
    const { type, filename } = req.params;

    if (!['images', 'videos', 'audio'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: '无效的媒体类型'
      });
    }

    const filePath = getMediaPath(type, filename);

    // 获取文件信息
    const stats = await fs.stat(filePath);

    res.json({
      success: true,
      data: {
        filename,
        type,
        size: stats.size,
        createdAt: stats.birthtime,
        modifiedAt: stats.mtime
      }
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({
        success: false,
        error: '文件不存在'
      });
    }
    console.error('获取文件信息失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
