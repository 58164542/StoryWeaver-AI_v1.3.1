/**
 * 项目相关的 API 路由
 */
import express from 'express';
import { getDatabase, saveDatabase } from '../db/index.js';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import JSZip from 'jszip';
import { extractFilenameFromUrl, getMediaPath } from '../utils/fileManager.js';

const router = express.Router();
const __dirname = dirname(fileURLToPath(import.meta.url));
const RECYCLE_DIR = join(__dirname, '../../data/recycle_bin');
const EXPORT_DIR = join(__dirname, '../../data/exports');
const STORYBOARD_ZIP_TTL_MS = 30 * 60 * 1000;
const storyboardZipDownloads = new Map();

function sanitizeFileSegment(value, fallback = '未命名') {
  const sanitized = String(value || '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[\s.]+$/g, '')
    .trim();

  return sanitized || fallback;
}

function encodeContentDispositionFilename(filename) {
  return encodeURIComponent(filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function cleanupStoryboardZipToken(token) {
  const entry = storyboardZipDownloads.get(token);
  if (!entry) return;

  storyboardZipDownloads.delete(token);
  clearTimeout(entry.timeoutId);
  fs.unlink(entry.zipPath).catch(error => {
    if (error.code !== 'ENOENT') {
      console.error('清理临时分镜 ZIP 失败:', error);
    }
  });
}

function scheduleStoryboardZipCleanup(token, zipPath) {
  const timeoutId = setTimeout(() => cleanupStoryboardZipToken(token), STORYBOARD_ZIP_TTL_MS);
  storyboardZipDownloads.set(token, { zipPath, timeoutId });
}

/**
 * GET /api/projects
 * 获取所有项目列表（含完整数据）
 */
router.get('/', async (req, res) => {
  try {
    const db = getDatabase();
    res.json({ success: true, data: db.data.projects });
  } catch (error) {
    console.error('获取项目列表失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/projects/recycle-bin
 * 获取回收站列表
 */
router.get('/recycle-bin', async (req, res) => {
  try {
    const db = getDatabase();
    res.json({ success: true, data: db.data.recycleBin || [] });
  } catch (error) {
    console.error('获取回收站失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/projects/recycle-bin/:id/restore
 * 恢复回收站中的项目
 */
router.post('/recycle-bin/:id/restore', async (req, res) => {
  try {
    const db = getDatabase();
    const recycleBin = db.data.recycleBin || [];
    const entryIndex = recycleBin.findIndex(p => p.id === req.params.id);

    if (entryIndex === -1) {
      return res.status(404).json({ success: false, error: '回收站项目不存在' });
    }

    const restored = { ...recycleBin[entryIndex] };
    delete restored.deletedAt;
    restored.updatedAt = Date.now();

    db.data.projects.push(restored);
    recycleBin.splice(entryIndex, 1);
    db.data.recycleBin = recycleBin;
    await saveDatabase();

    res.json({ success: true, data: restored });
  } catch (error) {
    console.error('恢复项目失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/projects/recycle-bin/:id
 * 永久删除回收站项目
 */
router.delete('/recycle-bin/:id', async (req, res) => {
  try {
    const db = getDatabase();
    const recycleBin = db.data.recycleBin || [];
    const entryIndex = recycleBin.findIndex(p => p.id === req.params.id);

    if (entryIndex === -1) {
      return res.status(404).json({ success: false, error: '回收站项目不存在' });
    }

    recycleBin.splice(entryIndex, 1);
    db.data.recycleBin = recycleBin;
    await saveDatabase();

    res.json({ success: true, message: '项目已永久删除' });
  } catch (error) {
    console.error('永久删除项目失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/projects/:id
 * 获取单个项目的完整数据
 */
router.get('/:id', async (req, res) => {
  try {
    const db = getDatabase();
    const project = db.data.projects.find(p => p.id === req.params.id);

    if (!project) {
      return res.status(404).json({ success: false, error: '项目不存在' });
    }

    res.json({ success: true, data: project });
  } catch (error) {
    console.error('获取项目失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/projects
 * 创建新项目
 */
router.post('/', async (req, res) => {
  try {
    const db = getDatabase();
    const newProject = req.body;

    // 确保项目有必需的字段
    if (!newProject.id || !newProject.name) {
      return res.status(400).json({ success: false, error: '缺少必需字段' });
    }

    // 检查项目ID是否已存在
    if (db.data.projects.find(p => p.id === newProject.id)) {
      return res.status(400).json({ success: false, error: '项目ID已存在' });
    }

    // 添加时间戳
    newProject.createdAt = newProject.createdAt || Date.now();
    newProject.updatedAt = Date.now();

    // 添加到数据库
    db.data.projects.push(newProject);
    await saveDatabase();

    console.log(`✅ 项目已创建: ${newProject.name}`);
    res.json({ success: true, data: newProject });
  } catch (error) {
    console.error('创建项目失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/projects/:id/settings
 * 只更新项目设置（不覆盖其他数据）
 */
router.put('/:id/settings', async (req, res) => {
  try {
    const db = getDatabase();
    const projectIndex = db.data.projects.findIndex(p => p.id === req.params.id);

    if (projectIndex === -1) {
      return res.status(404).json({ success: false, error: '项目不存在' });
    }

    const project = db.data.projects[projectIndex];
    const newSettings = req.body;

    // 只更新 settings 字段
    project.settings = newSettings;
    project.updatedAt = Date.now();

    await saveDatabase();

    console.log(`✅ 项目设置已更新: ${project.name}`);
    res.json({ success: true, data: project });
  } catch (error) {
    console.error('更新项目设置失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/projects/:id/assets
 * 只更新项目资产（characters/scenes/variants）
 */
router.put('/:id/assets', async (req, res) => {
  try {
    const db = getDatabase();
    const projectIndex = db.data.projects.findIndex(p => p.id === req.params.id);

    if (projectIndex === -1) {
      return res.status(404).json({ success: false, error: '项目不存在' });
    }

    const project = db.data.projects[projectIndex];
    const { characters, scenes, variants } = req.body;

    // 只更新资产字段
    if (characters !== undefined) project.characters = characters;
    if (scenes !== undefined) project.scenes = scenes;
    if (variants !== undefined) project.variants = variants;
    project.updatedAt = Date.now();

    await saveDatabase();

    console.log(`✅ 项目资产已更新: ${project.name}`);
    res.json({ success: true, data: project });
  } catch (error) {
    console.error('更新项目资产失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/projects/:id/episodes/:episodeId
 * 只更新单个分集（不覆盖其他分集和项目数据）
 */
router.put('/:id/episodes/:episodeId', async (req, res) => {
  try {
    const db = getDatabase();
    const projectIndex = db.data.projects.findIndex(p => p.id === req.params.id);

    if (projectIndex === -1) {
      return res.status(404).json({ success: false, error: '项目不存在' });
    }

    const project = db.data.projects[projectIndex];
    const episodeIndex = (project.episodes || []).findIndex(e => e.id === req.params.episodeId);

    if (episodeIndex === -1) {
      return res.status(404).json({ success: false, error: '分集不存在' });
    }

    const updatedEpisode = req.body;
    updatedEpisode.updatedAt = Date.now();

    // 只更新指定分集
    project.episodes[episodeIndex] = updatedEpisode;
    project.updatedAt = Date.now();

    await saveDatabase();

    console.log(`✅ 分集已更新: ${project.name} / ${updatedEpisode.name}`);
    res.json({ success: true, data: project });
  } catch (error) {
    console.error('更新分集失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/projects/:id/episodes/:episodeId/storyboard-images/export
 * 生成当前分集分镜图 ZIP 并返回临时下载链接
 */
router.post('/:id/episodes/:episodeId/storyboard-images/export', async (req, res) => {
  try {
    const { id: projectId, episodeId } = req.params;
    const db = getDatabase();
    const project = db.data.projects.find(p => p.id === projectId);

    if (!project) {
      return res.status(404).json({ success: false, error: '项目不存在' });
    }

    const episodeIndex = (project.episodes || []).findIndex(episode => episode.id === episodeId);
    if (episodeIndex === -1) {
      return res.status(404).json({ success: false, error: '分集不存在' });
    }

    const episode = project.episodes[episodeIndex];
    const framesWithOrder = (episode.frames || []).map((frame, originalOrder) => ({ frame, originalOrder }));
    const sortedFrames = framesWithOrder.sort((a, b) => {
      const aIndex = typeof a.frame.index === 'number' ? a.frame.index : a.originalOrder;
      const bIndex = typeof b.frame.index === 'number' ? b.frame.index : b.originalOrder;
      return aIndex - bIndex;
    });

    const exportableFrames = [];
    let skippedCount = 0;
    const usedNames = new Set();
    const episodeOrder = String(episodeIndex + 1).padStart(2, '0');
    const safeEpisodeName = sanitizeFileSegment(episode.name, '未命名分集');

    for (const { frame, originalOrder } of sortedFrames) {
      if (!frame.imageUrl) {
        skippedCount += 1;
        continue;
      }

      const parsed = extractFilenameFromUrl(frame.imageUrl);
      if (!parsed || parsed.type !== 'images') {
        skippedCount += 1;
        continue;
      }

      const mediaPath = getMediaPath('images', parsed.filename);
      try {
        await fs.access(mediaPath);
      } catch {
        skippedCount += 1;
        continue;
      }

      const frameNumber = String((typeof frame.index === 'number' ? frame.index : originalOrder) + 1).padStart(3, '0');
      const originalExt = extname(parsed.filename) || '.jpg';
      let zipEntryName = `E${episodeOrder}_${safeEpisodeName}_F${frameNumber}${originalExt}`;

      if (usedNames.has(zipEntryName)) {
        let duplicateIndex = 2;
        const baseName = `E${episodeOrder}_${safeEpisodeName}_F${frameNumber}`;
        do {
          zipEntryName = `${baseName}_${duplicateIndex}${originalExt}`;
          duplicateIndex += 1;
        } while (usedNames.has(zipEntryName));
      }

      usedNames.add(zipEntryName);
      exportableFrames.push({ mediaPath, zipEntryName });
    }

    if (exportableFrames.length === 0) {
      return res.status(400).json({ success: false, error: '当前分集没有可导出的分镜图' });
    }

    await fs.mkdir(EXPORT_DIR, { recursive: true });

    const filename = `${project.id}_${episode.id}_${Date.now()}_storyboard_images.zip`;
    const zipPath = join(EXPORT_DIR, filename);
    const zip = new JSZip();

    for (const item of exportableFrames) {
      const buffer = await fs.readFile(item.mediaPath);
      zip.file(item.zipEntryName, buffer);
    }

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    await fs.writeFile(zipPath, zipBuffer);

    const token = uuidv4();
    scheduleStoryboardZipCleanup(token, zipPath);

    return res.json({
      success: true,
      data: {
        downloadUrl: `/api/projects/${projectId}/episodes/${episodeId}/storyboard-images/download/${token}`,
        filename: `E${episodeOrder}_${safeEpisodeName}_storyboard_images.zip`,
        exportedCount: exportableFrames.length,
        skippedCount,
      },
    });
  } catch (error) {
    console.error('导出分镜图 ZIP 失败:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/projects/:id/episodes/:episodeId/storyboard-images/download/:token
 * 下载当前分集分镜图 ZIP
 */
router.get('/:id/episodes/:episodeId/storyboard-images/download/:token', async (req, res) => {
  const { token } = req.params;
  const entry = storyboardZipDownloads.get(token);

  if (!entry) {
    return res.status(404).json({ success: false, error: '下载链接已失效或不存在' });
  }

  try {
    await fs.access(entry.zipPath);

    const downloadName = sanitizeFileSegment(req.query.filename, 'storyboard_images.zip');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeContentDispositionFilename(downloadName)}`);

    const stream = createReadStream(entry.zipPath);
    stream.on('error', error => {
      console.error('读取分镜 ZIP 失败:', error);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: '读取 ZIP 文件失败' });
      } else {
        res.end();
      }
    });

    stream.pipe(res);
  } catch (error) {
    cleanupStoryboardZipToken(token);
    return res.status(404).json({ success: false, error: '下载文件不存在或已过期' });
  }
});

/**
 * PUT /api/projects/:id
 * 更新项目（完整更新，用于导入/复制等场景）
 */
router.put('/:id', async (req, res) => {
  try {
    const db = getDatabase();
    const projectIndex = db.data.projects.findIndex(p => p.id === req.params.id);

    if (projectIndex === -1) {
      return res.status(404).json({ success: false, error: '项目不存在' });
    }

    const updatedProject = req.body;
    updatedProject.updatedAt = Date.now();

    // 更新项目
    db.data.projects[projectIndex] = updatedProject;
    await saveDatabase();

    console.log(`✅ 项目已更新: ${updatedProject.name}`);
    res.json({ success: true, data: updatedProject });
  } catch (error) {
    console.error('更新项目失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/projects/:id
 * 删除项目（同时删除关联的媒体文件）
 */
router.delete('/:id', async (req, res) => {
  try {
    const db = getDatabase();
    const projectIndex = db.data.projects.findIndex(p => p.id === req.params.id);

    if (projectIndex === -1) {
      return res.status(404).json({ success: false, error: '项目不存在' });
    }

    const project = db.data.projects[projectIndex];
    const deletedAt = Date.now();
    const recycleEntry = { ...project, deletedAt };

    if (!db.data.recycleBin) {
      db.data.recycleBin = [];
    }

    db.data.recycleBin.push(recycleEntry);
    db.data.projects.splice(projectIndex, 1);

    await fs.mkdir(RECYCLE_DIR, { recursive: true });
    const recycleFile = join(RECYCLE_DIR, `${deletedAt}_${project.id}.json`);
    await fs.writeFile(recycleFile, JSON.stringify(recycleEntry, null, 2), 'utf-8');

    await saveDatabase();

    console.log(`✅ 项目已移入回收站: ${project.name}`);
    res.json({ success: true, message: '项目已移入回收站' });
  } catch (error) {
    console.error('删除项目失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /api/projects/:id/frames/:frameId
 * 轻量更新单个分镜的文本字段（imagePrompt / videoPrompt 等）。
 * 请求体：{ episodeId: string, imagePrompt?: string, videoPrompt?: string }
 * 不需要传输整个项目（含 base64 图片），避免 request entity too large。
 */
router.patch('/:id/frames/:frameId', async (req, res) => {
  try {
    const { id: projectId, frameId } = req.params;
    const { episodeId, ...textUpdates } = req.body;

    if (!episodeId) {
      return res.status(400).json({ success: false, error: '缺少 episodeId 字段' });
    }

    const db = getDatabase();
    const project = db.data.projects.find(p => p.id === projectId);

    if (!project) {
      return res.status(404).json({ success: false, error: '项目不存在' });
    }

    const episode = (project.episodes || []).find(e => e.id === episodeId);
    if (!episode) {
      return res.status(404).json({ success: false, error: '分集不存在' });
    }

    const frameIndex = (episode.frames || []).findIndex(f => f.id === frameId);
    if (frameIndex === -1) {
      return res.status(404).json({ success: false, error: '分镜不存在' });
    }

    // 只更新文本字段，不触及 imageUrl / videoUrl / audioUrl 等大字段
    const allowedKeys = ['imagePrompt', 'videoPrompt', 'originalText', 'dialogue', 'dialogues', 'imageError', 'videoError'];
    const safeUpdates = {};
    for (const key of allowedKeys) {
      if (key in textUpdates) safeUpdates[key] = textUpdates[key];
    }

    episode.frames[frameIndex] = { ...episode.frames[frameIndex], ...safeUpdates };
    project.updatedAt = Date.now();

    await saveDatabase();

    console.log(`✅ 分镜文本已更新: project=${projectId}, frame=${frameId}`);
    res.json({ success: true, data: { projectId, episodeId, frameId, updatedAt: project.updatedAt } });
  } catch (error) {
    console.error('更新分镜文本失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
