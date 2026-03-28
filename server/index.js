/**
 * StoryWeaver AI 后端服务器
 * Express + LowDB
 */
import { loadEnvLocal } from './utils/loadEnvLocal.js';
import express from 'express';
import cors from 'cors';
import { initDatabase, getDatabase, saveDatabase } from './db/index.js';
import projectsRouter from './routes/projects.js';
import mediaRouter from './routes/media.js';
import ttsRouter from './routes/tts.js';
import jianyingRouter from './routes/jianying.js';
import klingRouter from './routes/kling.js';
import seedanceSessionsRouter from './routes/seedance-sessions.js';
import claudeRouter from './routes/claude.js';
import preprocessTasksRouter from './routes/preprocess-tasks.js';
import { initPreprocessTaskManager } from './services/preprocessTaskManager.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFile } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const segmentSkillPromptPath = join(__dirname, '../System_Prompt/分段SKILL.md');

const app = express();
const PORT = process.env.PORT || 3001;

// 中间件
app.use(cors()); // 允许跨域访问
app.use(express.json({ limit: '50mb' })); // 解析 JSON，支持大文件（Base64）
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 请求日志
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// API 路由
app.use('/api/projects', projectsRouter);
app.use('/api/media', mediaRouter);
app.use('/api/tts', ttsRouter);
app.use('/api/jianying', jianyingRouter);
app.use('/api/kling', klingRouter);
app.use('/api/seedance-sessions', seedanceSessionsRouter);
app.use('/api/claude', claudeRouter);
app.use('/api/preprocess', preprocessTasksRouter);

app.get('/api/system-prompts/segment-skill', async (req, res) => {
  try {
    const content = await readFile(segmentSkillPromptPath, 'utf8');
    res.json({ success: true, data: { content } });
  } catch (error) {
    console.error('读取分段 prompt 失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 全局设置
app.get('/api/settings', (req, res) => {
  try {
    const db = getDatabase();
    res.json({ success: true, data: db.data.settings });
  } catch (error) {
    console.error('获取设置失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const db = getDatabase();
    db.data.settings = req.body;
    await saveDatabase();

    console.log('✅ 全局设置已更新');
    res.json({ success: true, data: db.data.settings });
  } catch (error) {
    console.error('更新设置失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/recycle-bin', async (req, res) => {
  try {
    const db = getDatabase();
    res.json({ success: true, data: db.data.recycleBin || [] });
  } catch (error) {
    console.error('获取回收站失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/recycle-bin/:id/restore', async (req, res) => {
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

app.delete('/api/recycle-bin/:id', async (req, res) => {
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

app.get('/api/proxy', async (req, res) => {
  try {
    const target = req.query.url;
    if (!target || typeof target !== 'string') {
      return res.status(400).json({ success: false, error: '缺少 url 参数' });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(target);
    } catch {
      return res.status(400).json({ success: false, error: '无效的 url' });
    }

    if (parsedUrl.protocol !== 'https:') {
      return res.status(400).json({ success: false, error: '仅支持 https 协议' });
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    const isAllowedHost = hostname.endsWith('volces.com') || hostname.endsWith('volces.com.cn');
    if (!isAllowedHost) {
      return res.status(403).json({ success: false, error: '禁止访问该域名' });
    }

    const response = await fetch(parsedUrl.toString());
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).send(text);
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.send(buffer);
  } catch (error) {
    console.error('代理请求失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'StoryWeaver AI 服务器运行中' });
});

// 未匹配的 API 统一返回 JSON，避免前端把 HTML 当 JSON 解析
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: `API 路由不存在: ${req.method} ${req.originalUrl}`,
  });
});

// 提供静态文件服务（打包后的前端）
app.use(express.static(join(__dirname, '../dist')));

// SPA 路由回退（所有未匹配的路由返回 index.html）
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '../dist/index.html'));
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({
    success: false,
    error: err.message || '服务器内部错误'
  });
});

// 启动服务器
async function startServer() {
  try {
    // Load .env.local for local dev
    await loadEnvLocal();

    // 初始化数据库
    await initDatabase();
    await initPreprocessTaskManager();

    // 监听所有网络接口（允许局域网访问）
    app.listen(PORT, '0.0.0.0', () => {
      console.log('\n' + '='.repeat(60));
      console.log('🚀 StoryWeaver AI 服务器已启动！');
      console.log('='.repeat(60));
      console.log(`📍 本地访问: http://localhost:${PORT}`);
      console.log(`🌐 局域网访问: http://<你的IP>:${PORT}`);
      console.log('💡 提示: 使用 ipconfig (Windows) 或 ifconfig (Mac/Linux) 查看本机IP');
      console.log('='.repeat(60) + '\n');
    });
  } catch (error) {
    console.error('❌ 服务器启动失败:', error);
    process.exit(1);
  }
}

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n👋 服务器正在关闭...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 服务器正在关闭...');
  process.exit(0);
});

startServer();
