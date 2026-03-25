/**
 * Claude API 反向代理
 * 将浏览器的 Claude 请求通过后端转发，避免 CORS 问题
 * API Key 存放在服务端 process.env，不暴露给前端
 */
import { Router } from 'express';

const router = Router();

const ANTHROPIC_VERSION = '2023-06-01';

const PROVIDER_UPSTREAM = {
  univibe: 'https://cc.580ai.net/v1/messages',
  bltcy: 'https://api.bltcy.ai/v1/messages',
};

function getApiKey(provider) {
  if (provider === 'univibe') {
    return process.env.CC580AI_API_KEY || '';
  }
  if (provider === 'bltcy') {
    return process.env.BLTCY_API_KEY || process.env.VITE_BLTCY_API_KEY || '';
  }
  return '';
}

function buildUpstreamHeaders(provider, apiKey, stream) {
  const base = {
    'anthropic-version': ANTHROPIC_VERSION,
    'Content-Type': 'application/json',
    'Accept': stream ? 'text/event-stream' : 'application/json',
  };
  if (provider === 'bltcy') {
    return { ...base, 'Authorization': `Bearer ${apiKey}` };
  }
  return { ...base, 'x-api-key': apiKey };
}

// POST /api/claude/proxy — 统一代理入口（流式 + 非流式均支持）
router.post('/proxy', async (req, res) => {
  const { provider = 'univibe', ...payload } = req.body;

  const upstreamUrl = PROVIDER_UPSTREAM[provider];
  if (!upstreamUrl) {
    return res.status(400).json({ error: `未知的 Claude provider: ${provider}` });
  }

  const apiKey = getApiKey(provider);
  if (!apiKey) {
    return res.status(500).json({ error: `未配置 ${provider} API Key（请在 .env.local 中设置）` });
  }

  const isStream = payload.stream === true;

  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: buildUpstreamHeaders(provider, apiKey, isStream),
      body: JSON.stringify(payload),
    });

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.status(upstream.status);

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        res.write(errText);
        res.end();
        return;
      }

      const reader = upstream.body.getReader();
      req.on('close', () => reader.cancel().catch(() => {}));
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } else {
      const text = await upstream.text();
      res
        .status(upstream.status)
        .setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json')
        .send(text);
    }
  } catch (err) {
    console.error('[claude-proxy] 上游请求失败:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: `Claude 代理请求失败: ${err.message}` });
    }
  }
});

export default router;
