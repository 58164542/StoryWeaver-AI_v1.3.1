/**
 * 剪映工程导出 API
 * 服务端导出，写入到本机的网络驱动器
 *
 * 导出流程（分批上传）：
 *   1. POST /init         建立会话+目录，返回 sessionId
 *   2. POST /upload-file  逐文件上传（每次一个）
 *   3. POST /finalize     写入 JSON，完成导出
 */
import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

console.log('✅ 剪映导出路由已加载');

// ── 会话存储（内存）──────────────────────────────────────────────────────────
// sessionId → { projectDir, assetsDir }
const sessions = new Map();

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 分钟后自动清理

// ── 工具：读取并校验导出路径 ─────────────────────────────────────────────────
const getExportPath = () => {
  const p = process.env.JIANYING_EXPORT_PATH_FULL || '';
  if (!p) throw new Error('服务器未配置剪映导出路径');
  return p;
};

// ── POST /init ────────────────────────────────────────────────────────────────
// 创建导出目录，返回 sessionId
router.post('/init', async (req, res) => {
  try {
    const exportPath = getExportPath();
    const { projectName, episodeName } = req.body;
    if (!projectName || !episodeName) {
      return res.status(400).json({ success: false, error: '缺少 projectName 或 episodeName' });
    }

    const sanitizedName = `${projectName}_${episodeName}`.replace(/[<>:"/\\|?*]/g, '_');
    const projectDir = path.join(exportPath, sanitizedName);
    const assetsDir = path.join(projectDir, 'assets');

    await fs.mkdir(assetsDir, { recursive: true });

    const sessionId = uuidv4();
    sessions.set(sessionId, { projectDir, assetsDir });

    // 超时自动清理会话（防止内存泄漏）
    setTimeout(() => sessions.delete(sessionId), SESSION_TTL_MS);

    console.log(`📁 剪映导出会话已建立: ${projectDir} [sessionId=${sessionId}]`);
    res.json({ success: true, sessionId });
  } catch (error) {
    console.error('❌ 剪映 init 失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── POST /upload-file ─────────────────────────────────────────────────────────
// 上传单个媒体文件（base64），追加到会话目录
router.post('/upload-file', async (req, res) => {
  try {
    const { sessionId, filename, data } = req.body;

    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(400).json({ success: false, error: '无效的 sessionId，请重新初始化导出' });
    }
    if (!filename || !data) {
      return res.status(400).json({ success: false, error: '缺少 filename 或 data' });
    }

    const buffer = Buffer.from(data, 'base64');
    await fs.writeFile(path.join(session.assetsDir, filename), buffer);

    res.json({ success: true });
  } catch (error) {
    console.error('❌ 剪映 upload-file 失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── POST /finalize ────────────────────────────────────────────────────────────
// 写入 draft_content.json 和 draft_meta_info.json，完成导出
router.post('/finalize', async (req, res) => {
  try {
    const { sessionId, draftContent, draftMeta } = req.body;

    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(400).json({ success: false, error: '无效的 sessionId，请重新初始化导出' });
    }
    if (!draftContent || !draftMeta) {
      return res.status(400).json({ success: false, error: '缺少 draftContent 或 draftMeta' });
    }

    await fs.writeFile(
      path.join(session.projectDir, 'draft_content.json'),
      JSON.stringify(draftContent, null, 2)
    );
    await fs.writeFile(
      path.join(session.projectDir, 'draft_meta_info.json'),
      JSON.stringify(draftMeta, null, 2)
    );

    const { projectDir } = session;
    sessions.delete(sessionId); // 会话使命完成，立即清理

    console.log(`✅ 剪映工程已导出: ${projectDir}`);
    res.json({ success: true, message: '导出成功', path: projectDir });
  } catch (error) {
    console.error('❌ 剪映 finalize 失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── POST /export（保留旧接口，兼容备用）────────────────────────────────────────
router.post('/export', async (req, res) => {
  try {
    const JIANYING_EXPORT_PATH_FULL = process.env.JIANYING_EXPORT_PATH_FULL || '';

    console.log('🔍 剪映导出路径配置:', {
      JIANYING_EXPORT_PATH_FULL,
      allEnvKeys: Object.keys(process.env).filter(k => k.includes('JIANYING'))
    });

    if (!JIANYING_EXPORT_PATH_FULL) {
      return res.status(400).json({
        success: false,
        error: '服务器未配置剪映导出路径'
      });
    }

    const { projectName, episodeName, draftContent, draftMeta, files } = req.body;

    if (!projectName || !episodeName || !draftContent || !draftMeta) {
      return res.status(400).json({
        success: false,
        error: '缺少必要参数'
      });
    }

    const sanitizedName = `${projectName}_${episodeName}`.replace(/[<>:"/\\|?*]/g, '_');
    const projectDir = path.join(JIANYING_EXPORT_PATH_FULL, sanitizedName);
    const assetsDir = path.join(projectDir, 'assets');

    await fs.mkdir(assetsDir, { recursive: true });

    await fs.writeFile(
      path.join(projectDir, 'draft_content.json'),
      JSON.stringify(draftContent, null, 2)
    );
    await fs.writeFile(
      path.join(projectDir, 'draft_meta_info.json'),
      JSON.stringify(draftMeta, null, 2)
    );

    if (files && Array.isArray(files)) {
      for (const file of files) {
        const { filename, data } = file;
        if (!filename || !data) continue;
        const buffer = Buffer.from(data, 'base64');
        await fs.writeFile(path.join(assetsDir, filename), buffer);
      }
    }

    console.log(`✅ 剪映工程已导出: ${projectDir}`);
    res.json({ success: true, message: '导出成功', path: projectDir });
  } catch (error) {
    console.error('❌ 剪映导出失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
