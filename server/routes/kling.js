import express from 'express';
import crypto from 'crypto';

const router = express.Router();
const KLING_VIDEO_ENDPOINT = 'https://api-beijing.klingai.com/v1/videos/omni-video';

const getKlingToken = () => {
  const accessKey = process.env.KLING_ACCESS_KEY;
  const secretKey = process.env.KLING_SECRET_KEY;
  const directToken = process.env.KLING_API_TOKEN || process.env.KLING_API_KEY;

  if (directToken) return directToken;
  if (!accessKey || !secretKey) return null;

  const base64UrlEncode = (str) =>
    Buffer.from(str).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { iss: accessKey, exp: now + 1800, nbf: now - 5 };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signature = crypto.createHmac('sha256', secretKey).update(signingInput).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${signingInput}.${signature}`;
};

/**
 * POST /api/kling/token
 * 生成可灵 JWT Token 返回给前端（备用，当前前端已不直接调用）
 */
router.post('/token', (req, res) => {
  try {
    const token = getKlingToken();
    if (!token) {
      return res.status(400).json({ success: false, error: '请在 .env.local 中配置 KLING_API_TOKEN 或 KLING_ACCESS_KEY / KLING_SECRET_KEY' });
    }
    res.json({ success: true, data: { token } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/kling/videos
 * 代理：创建可灵视频生成任务
 */
router.post('/videos', async (req, res) => {
  try {
    const token = getKlingToken();
    if (!token) {
      return res.status(400).json({ success: false, error: '请在 .env.local 中配置 KLING_API_TOKEN 或 KLING_ACCESS_KEY / KLING_SECRET_KEY' });
    }

    const upstream = await fetch(KLING_VIDEO_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });

    const text = await upstream.text();
    res.status(upstream.status).set('Content-Type', 'application/json').send(text);
  } catch (error) {
    console.error('Kling 创建任务代理失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/kling/videos/:taskId
 * 代理：查询可灵视频任务状态
 */
router.get('/videos/:taskId', async (req, res) => {
  try {
    const token = getKlingToken();
    if (!token) {
      return res.status(400).json({ success: false, error: '请在 .env.local 中配置 KLING_API_TOKEN 或 KLING_ACCESS_KEY / KLING_SECRET_KEY' });
    }

    const upstream = await fetch(`${KLING_VIDEO_ENDPOINT}/${req.params.taskId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });

    const text = await upstream.text();
    res.status(upstream.status).set('Content-Type', 'application/json').send(text);
  } catch (error) {
    console.error('Kling 查询任务代理失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
