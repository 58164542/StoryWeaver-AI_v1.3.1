import 'dotenv/config';
import { loadEnvLocal } from '../utils/loadEnvLocal.js';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import browserService from './browser-service.js';
import SessionManager from './session-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

const app = express();
const PORT = process.env.SEEDANCE_PORT || process.env.PORT || 3005;
const HOST = process.env.SEEDANCE_HOST || '0.0.0.0';
const sessionManager = new SessionManager();

// 任务持久化文件路径（用于崩溃恢复）
const TASKS_PERSIST_PATH = process.env.SEEDANCE_TASKS_PATH || join(__dirname, 'data', 'seedance-tasks.json');
const LOCAL_MEDIA_VIDEO_DIR = process.env.LOCAL_MEDIA_VIDEO_DIR || join(PROJECT_ROOT, 'data', 'media', 'videos');

app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ============================================================
// 常量定义
// ============================================================
const JIMENG_BASE_URL = 'https://jimeng.jianying.com';
const DEFAULT_ASSISTANT_ID = 513695;
const VERSION_CODE = '8.4.0';
const PLATFORM_CODE = '7';
const WEB_ID = Math.random() * 999999999999999999 + 7000000000000000000;
const USER_ID = crypto.randomUUID().replace(/-/g, '');

const FAKE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-language': 'zh-CN,zh;q=0.9',
  'App-Sdk-Version': '48.0.0',
  'Cache-control': 'no-cache',
  Appid: String(DEFAULT_ASSISTANT_ID),
  Appvr: VERSION_CODE,
  Lan: 'zh-Hans',
  Loc: 'cn',
  Origin: 'https://jimeng.jianying.com',
  Pragma: 'no-cache',
  Priority: 'u=1, i',
  Referer: 'https://jimeng.jianying.com',
  Pf: PLATFORM_CODE,
  'Sec-Ch-Ua': '"Google Chrome";v="132", "Chromium";v="132", "Not_A Brand";v="8"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
};

const MODEL_MAP = {
  'seedance-2.0': 'dreamina_seedance_40_pro',
  'seedance-2.0-fast': 'dreamina_seedance_40',
};

const BENEFIT_TYPE_MAP = {
  'seedance-2.0': 'dreamina_video_seedance_20_pro',
  'seedance-2.0-fast': 'dreamina_seedance_20_fast',
};

const SEEDANCE_DRAFT_VERSION = '3.3.9';

const VIDEO_RESOLUTION = {
  '1:1': { width: 720, height: 720 },
  '4:3': { width: 960, height: 720 },
  '3:4': { width: 720, height: 960 },
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '21:9': { width: 1680, height: 720 },
};

// ============================================================
// 异步任务管理
// ============================================================
const tasks = new Map();
let taskCounter = 0;

const TASK_MEMORY_TTL = 30 * 60 * 1000; // 任务完成后在内存中保留 30 分钟

// ============================================================
// 全局 Session 等待队列
//   场景1：所有 session 并发满 → 任务排队等 release 通知
//   场景2：1310/4010 高峰冷却 → 任务排队等冷却结束后逐个唤醒
// ============================================================
const waitQueue = []; // Array<() => void>  每项是一个 resolve 函数
let peakCooldownEnd = 0;    // 高峰期冷却结束时间戳（0 = 无冷却）
let peakCooldownTimer = null; // 冷却定时器句柄

/** 唤醒等待队列中的前 count 个任务（默认 1 个） */
function drainWaitQueue(count = 1) {
  for (let i = 0; i < count && waitQueue.length > 0; i++) {
    waitQueue.shift()();
  }
}

/**
 * 触发高峰期冷却：waitMinutes 分钟后逐个（每 2 秒）唤醒等待任务
 * 已在冷却中时调用无效（不重置计时器）
 */
function triggerPeakCooldown(waitMinutes = 10) {
  if (peakCooldownTimer) return; // 已在冷却中，忽略重复触发
  peakCooldownEnd = Date.now() + waitMinutes * 60 * 1000;
  console.log(`[peak-cooldown] 高峰期限流，${waitMinutes} 分钟后逐个重试 (当前 ${waitQueue.length} 个任务排队)`);
  peakCooldownTimer = setTimeout(() => {
    peakCooldownEnd = 0;
    peakCooldownTimer = null;
    // 逐个唤醒，每 2 秒一个，避免同时重放造成再次 1310
    function notifyNext() {
      if (waitQueue.length > 0) {
        drainWaitQueue(1);
        if (waitQueue.length > 0) setTimeout(notifyNext, 2000);
      }
    }
    notifyNext();
  }, waitMinutes * 60 * 1000);
}

/**
 * 带排队的 acquire：
 * - 高峰冷却期内：进入 waitQueue 等待冷却结束
 * - 所有 session 并发满（503）：进入 waitQueue 等待 release 通知
 * - 始终返回一个有效 session，不抛出也不返回 null
 */
async function acquireOrWait(taskId) {
  while (true) {
    if (peakCooldownEnd > Date.now()) {
      // 高峰冷却期，进入队列等待唤醒
      await new Promise(resolve => waitQueue.push(resolve));
      continue;
    }
    const session = await sessionManager.acquireSession(taskId);
    if (session) return session;
    // 并发满，等待某个 release 后通知
    console.log(`[acquire-wait] taskId=${taskId} 并发满，等待 session 释放...`);
    await new Promise(resolve => waitQueue.push(resolve));
  }
}

/**
 * release + 唤醒一个等待者（封装所有 release 调用，确保队列持续流动）
 */
async function releaseAndDrain(sessionId, success, taskId) {
  await sessionManager.releaseSession(sessionId, success, taskId);
  drainWaitQueue(1);
}

function createTaskId() {
  return `task_${++taskCounter}_${Date.now()}`;
}

/** 任务完成（done/error）后立即调度内存清理，30 分钟后从 Map 中移除 */
function scheduleTaskCleanup(taskId) {
  const task = tasks.get(taskId);
  if (!task) return;
  if (!task.completedAt) task.completedAt = Date.now();
  const remaining = Math.max(0, task.completedAt + TASK_MEMORY_TTL - Date.now());
  setTimeout(() => tasks.delete(taskId), remaining);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, task] of tasks) {
    if (now - task.startTime > 5 * 60 * 60 * 1000) {
      tasks.delete(id);
    }
  }
}, 60000);

// ============================================================
// 工具函数
// ============================================================
function generateUUID() {
  return crypto.randomUUID();
}

function unixTimestamp() {
  return Math.floor(Date.now() / 1000);
}

function md5(value) {
  return crypto.createHash('md5').update(value).digest('hex');
}

function generateCookie(sessionId) {
  return [
    `_tea_web_id=${WEB_ID}`,
    'is_staff_user=false',
    'store-region=cn-gd',
    'store-region-src=uid',
    `uid_tt=${USER_ID}`,
    `uid_tt_ss=${USER_ID}`,
    `sid_tt=${sessionId}`,
    `sessionid=${sessionId}`,
    `sessionid_ss=${sessionId}`,
  ].join('; ');
}

function generateSign(uri) {
  const deviceTime = unixTimestamp();
  const sign = md5(
    `9e2c|${uri.slice(-7)}|${PLATFORM_CODE}|${VERSION_CODE}|${deviceTime}||11ac`
  );
  return { deviceTime, sign };
}

// ============================================================
// 下载 CDN 视频并保存到主后端 media 目录
// ============================================================
function getMainBackendUrl() {
  return process.env.MAIN_BACKEND_URL || 'http://localhost:3001';
}

async function syncVideoToMainBackend(projectId, episodeId, frameId, videoUrl) {
  if (!projectId || !episodeId || !frameId || !videoUrl) return false;

  try {
    const updateResp = await fetch(`${getMainBackendUrl()}/api/projects/${projectId}/frames/${frameId}/video`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeId, videoUrl }),
    });

    if (!updateResp.ok) {
      console.warn(`[sync-video] 回写分镜视频失败 (${updateResp.status})`);
      return false;
    }

    const result = await updateResp.json();
    console.log(`[sync-video] 已回写分镜视频: ${projectId}/${episodeId}/${frameId}, counted=${Boolean(result?.data?.recorded)}`);
    return true;
  } catch (err) {
    console.warn(`[sync-video] 回写异常: ${err.message}`);
    return false;
  }
}

/**
 * 用即梦 CDN 所需的 headers 下载视频，POST 到主后端 /api/media/upload 保存
 * 返回本地 URL（如 /api/media/videos/xxx.mp4）
 * 如果保存失败则回退返回原始 CDN URL
 */
async function downloadAndSaveVideo(cdnUrl, filename) {
  try {
    const response = await fetch(cdnUrl, {
      headers: {
        'User-Agent': FAKE_HEADERS['User-Agent'],
        Referer: 'https://jimeng.jianying.com/',
      },
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      console.warn(`[save-video] CDN 下载失败 (${response.status})，使用 proxy URL`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = (response.headers.get('content-type') || 'video/mp4').split(';')[0].trim();

    const base64Data = `data:${contentType};base64,${buffer.toString('base64')}`;
    const safeFilename = String(filename || `seedance_${Date.now()}`).replace(/[^a-zA-Z0-9._-]+/g, '_');

    const uploadResponse = await fetch(`${getMainBackendUrl()}/api/media/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64Data, filename: safeFilename }),
    });

    if (!uploadResponse.ok) {
      console.warn(`[save-video] 上传到主后端失败 (${uploadResponse.status})，使用 proxy URL`);
      return null;
    }

    const result = await uploadResponse.json();
    if (result.success && result.data?.url) {
      console.log(`[save-video] 视频已保存: ${result.data.url} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
      return result.data.url;
    }

    return null;
  } catch (err) {
    console.warn(`[save-video] 保存失败: ${err.message}，使用 proxy URL`);
    return null;
  }
}

// ============================================================
// 即梦 API 请求函数
// ============================================================
async function jimengRequest(method, uri, sessionId, options = {}) {
  const { deviceTime, sign } = generateSign(uri);
  const fullUrl = new URL(`${JIMENG_BASE_URL}${uri}`);

  const defaultParams = {
    aid: DEFAULT_ASSISTANT_ID,
    device_platform: 'web',
    region: 'cn',
    webId: WEB_ID,
    da_version: '3.3.2',
    web_component_open_flag: 1,
    web_version: '7.5.0',
    aigc_features: 'app_lip_sync',
    ...(options.params || {}),
  };

  for (const [key, value] of Object.entries(defaultParams)) {
    fullUrl.searchParams.set(key, String(value));
  }

  const headers = {
    ...FAKE_HEADERS,
    Cookie: generateCookie(sessionId),
    'Device-Time': String(deviceTime),
    Sign: sign,
    'Sign-Ver': '1',
    ...(options.headers || {}),
  };

  const fetchOptions = { method: method.toUpperCase(), headers };

  if (options.data) {
    headers['Content-Type'] = 'application/json';
    fetchOptions.body = JSON.stringify(options.data);
  }

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        console.log(`  [jimeng] 重试 ${uri} (第${attempt}次)`);
      }

      const response = await fetch(fullUrl.toString(), {
        ...fetchOptions,
        signal: AbortSignal.timeout(45000),
      });

      // 防止 shark 反爬返回 HTML 导致 json() 解析失败
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || !contentType.includes('json')) {
        const bodyText = await response.text().catch(() => '');
        throw new Error(`即梦请求非JSON响应 (HTTP ${response.status}, type=${contentType.split(';')[0]}): ${bodyText.substring(0, 200)}`);
      }

      const data = await response.json();

      if (isFinite(Number(data.ret))) {
        if (String(data.ret) === '0') return data.data;
        const errMsg = data.errmsg || String(data.ret);
        const retCode = String(data.ret);
        if (retCode === '5000' || retCode === '1006')
          throw Object.assign(
            new Error(`即梦积分不足或没有相关权益 (ret=${retCode})`),
            { isApiError: true, retCode }
          );
        throw Object.assign(
          new Error(`即梦API错误 (ret=${retCode}): ${errMsg}`),
          { isApiError: true, retCode }
        );
      }

      return data;
    } catch (err) {
      if (err.isApiError) throw err;
      if (attempt === 3) throw err;
      console.log(
        `  [jimeng] 请求 ${uri} 失败 (第${attempt + 1}次): ${err.message}`
      );
    }
  }
}

// ============================================================
// AWS4-HMAC-SHA256 签名
// ============================================================
function createAWSSignature(method, url, headers, accessKeyId, secretAccessKey, sessionToken, payload = '') {
  const urlObj = new URL(url);
  const pathname = urlObj.pathname || '/';

  const timestamp = headers['x-amz-date'];
  const date = timestamp.substr(0, 8);
  const region = 'cn-north-1';
  const service = 'imagex';

  const queryParams = [];
  urlObj.searchParams.forEach((value, key) => {
    queryParams.push([key, value]);
  });
  queryParams.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQueryString = queryParams.map(([k, v]) => `${k}=${v}`).join('&');

  const headersToSign = { 'x-amz-date': timestamp };
  if (sessionToken) headersToSign['x-amz-security-token'] = sessionToken;

  let payloadHash = crypto.createHash('sha256').update('').digest('hex');
  if (method.toUpperCase() === 'POST' && payload) {
    payloadHash = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
    headersToSign['x-amz-content-sha256'] = payloadHash;
  }

  const signedHeaders = Object.keys(headersToSign).map((k) => k.toLowerCase()).sort().join(';');
  const canonicalHeaders = Object.keys(headersToSign)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((k) => `${k.toLowerCase()}:${headersToSign[k].trim()}\n`)
    .join('');

  const canonicalRequest = [
    method.toUpperCase(), pathname, canonicalQueryString,
    canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', timestamp, credentialScope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  const kDate = crypto.createHmac('sha256', `AWS4${secretAccessKey}`).update(date).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// ============================================================
// CRC32 计算
// ============================================================
function calculateCRC32(buffer) {
  const crcTable = [];
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    crcTable[i] = crc;
  }

  let crc = 0 ^ -1;
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
  }
  return ((crc ^ -1) >>> 0).toString(16).padStart(8, '0');
}

// ============================================================
// 图片上传 (4步 ImageX 流程)
// ============================================================
async function uploadImageBuffer(buffer, sessionId) {
  console.log(`  [upload] 开始上传图片, 大小: ${buffer.length} 字节`);

  const tokenResult = await jimengRequest('post', '/mweb/v1/get_upload_token', sessionId, { data: { scene: 2 } });

  const { access_key_id, secret_access_key, session_token, service_id } = tokenResult;
  if (!access_key_id || !secret_access_key || !session_token) {
    throw new Error('获取上传令牌失败');
  }
  const actualServiceId = service_id || 'tb4s082cfz';
  console.log(`  [upload] 上传令牌获取成功: serviceId=${actualServiceId}`);

  const fileSize = buffer.length;
  const crc32 = calculateCRC32(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

  const timestamp = new Date().toISOString().replace(/[:\-]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const randomStr = Math.random().toString(36).substring(2, 12);
  const applyUrl = `https://imagex.bytedanceapi.com/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=${actualServiceId}&FileSize=${fileSize}&s=${randomStr}`;

  const reqHeaders = { 'x-amz-date': timestamp, 'x-amz-security-token': session_token };
  const authorization = createAWSSignature('GET', applyUrl, reqHeaders, access_key_id, secret_access_key, session_token);

  const applyResponse = await fetch(applyUrl, {
    method: 'GET',
    headers: {
      accept: '*/*',
      authorization,
      origin: 'https://jimeng.jianying.com',
      referer: 'https://jimeng.jianying.com/ai-tool/video/generate',
      'user-agent': FAKE_HEADERS['User-Agent'],
      'x-amz-date': timestamp,
      'x-amz-security-token': session_token,
    },
  });

  if (!applyResponse.ok) throw new Error(`申请上传权限失败: ${applyResponse.status}`);
  const applyResult = await applyResponse.json();
  if (applyResult?.ResponseMetadata?.Error)
    throw new Error(`申请上传权限失败: ${JSON.stringify(applyResult.ResponseMetadata.Error)}`);

  const uploadAddress = applyResult?.Result?.UploadAddress;
  if (!uploadAddress?.StoreInfos?.length || !uploadAddress?.UploadHosts?.length) {
    throw new Error('获取上传地址失败');
  }

  const storeInfo = uploadAddress.StoreInfos[0];
  const uploadHost = uploadAddress.UploadHosts[0];
  const uploadUrl = `https://${uploadHost}/upload/v1/${storeInfo.StoreUri}`;

  console.log(`  [upload] 上传图片到: ${uploadHost}`);

  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Accept: '*/*',
      Authorization: storeInfo.Auth,
      'Content-CRC32': crc32,
      'Content-Disposition': 'attachment; filename="undefined"',
      'Content-Type': 'application/octet-stream',
      Origin: 'https://jimeng.jianying.com',
      Referer: 'https://jimeng.jianying.com/ai-tool/video/generate',
      'User-Agent': FAKE_HEADERS['User-Agent'],
    },
    body: buffer,
  });

  if (!uploadResponse.ok) throw new Error(`图片上传失败: ${uploadResponse.status}`);
  console.log('  [upload] 图片文件上传成功');

  const commitUrl = `https://imagex.bytedanceapi.com/?Action=CommitImageUpload&Version=2018-08-01&ServiceId=${actualServiceId}`;
  const commitTimestamp = new Date().toISOString().replace(/[:\-]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const commitPayload = JSON.stringify({ SessionKey: uploadAddress.SessionKey, SuccessActionStatus: '200' });
  const payloadHash = crypto.createHash('sha256').update(commitPayload, 'utf8').digest('hex');

  const commitReqHeaders = {
    'x-amz-date': commitTimestamp,
    'x-amz-security-token': session_token,
    'x-amz-content-sha256': payloadHash,
  };
  const commitAuth = createAWSSignature('POST', commitUrl, commitReqHeaders, access_key_id, secret_access_key, session_token, commitPayload);

  const commitResponse = await fetch(commitUrl, {
    method: 'POST',
    headers: {
      accept: '*/*',
      authorization: commitAuth,
      'content-type': 'application/json',
      origin: 'https://jimeng.jianying.com',
      referer: 'https://jimeng.jianying.com/ai-tool/video/generate',
      'user-agent': FAKE_HEADERS['User-Agent'],
      'x-amz-date': commitTimestamp,
      'x-amz-security-token': session_token,
      'x-amz-content-sha256': payloadHash,
    },
    body: commitPayload,
  });

  if (!commitResponse.ok) throw new Error(`提交上传失败: ${commitResponse.status}`);
  const commitResult = await commitResponse.json();
  if (commitResult?.ResponseMetadata?.Error)
    throw new Error(`提交上传失败: ${JSON.stringify(commitResult.ResponseMetadata.Error)}`);

  if (!commitResult?.Result?.Results?.length) throw new Error('提交上传响应缺少结果');
  const result = commitResult.Result.Results[0];
  if (result.UriStatus !== 2000) throw new Error(`图片上传状态异常: UriStatus=${result.UriStatus}`);

  const imageUri = commitResult.Result?.PluginResult?.[0]?.ImageUri || result.Uri;
  console.log(`  [upload] 图片上传完成: ${imageUri}`);
  return imageUri;
}

// ============================================================
// 解析 prompt 中的图片占位符, 构建 meta_list
// ============================================================
function buildMetaListFromPrompt(prompt, imageCount) {
  const metaList = [];
  const placeholderRegex = /@(?:图|image)?(\d+)/gi;
  let lastIndex = 0;
  let match;

  while ((match = placeholderRegex.exec(prompt)) !== null) {
    if (match.index > lastIndex) {
      const textBefore = prompt.substring(lastIndex, match.index);
      if (textBefore.trim()) {
        metaList.push({ meta_type: 'text', text: textBefore });
      }
    }

    const imageIndex = parseInt(match[1]) - 1;
    if (imageIndex >= 0 && imageIndex < imageCount) {
      metaList.push({
        meta_type: 'image',
        text: '',
        material_ref: { material_idx: imageIndex },
      });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < prompt.length) {
    const remainingText = prompt.substring(lastIndex);
    if (remainingText.trim()) {
      metaList.push({ meta_type: 'text', text: remainingText });
    }
  }

  if (metaList.length === 0) {
    for (let i = 0; i < imageCount; i++) {
      if (i === 0) metaList.push({ meta_type: 'text', text: '使用' });
      metaList.push({ meta_type: 'image', text: '', material_ref: { material_idx: i } });
      if (i < imageCount - 1) metaList.push({ meta_type: 'text', text: '和' });
    }
    if (prompt && prompt.trim()) {
      metaList.push({ meta_type: 'text', text: `图片，${prompt}` });
    } else {
      metaList.push({ meta_type: 'text', text: '图片生成视频' });
    }
  }

  return metaList;
}


// ============================================================
// 任务持久化 — 崩溃恢复
// ============================================================

/**
 * 将内存中所有任务写入磁盘（仅 processing/done/error 状态）
 */
async function persistTasks() {
  const toSave = [];
  for (const [, task] of tasks) {
    toSave.push({
      id: task.id,
      status: task.status,
      startTime: task.startTime,
      historyId: task.historyId || null,
      jimengSessionId: task.jimengSessionId || null,
      sessionId: task.sessionId || null,
      sessionName: task.sessionName || null,
      projectId: task.projectId || null,
      episodeId: task.episodeId || null,
      frameId: task.frameId || null,
      progress: task.progress || null,
      result: task.result || null,
      error: task.error || null,
    });
  }
  try {
    await fs.mkdir(dirname(TASKS_PERSIST_PATH), { recursive: true });
    await fs.writeFile(TASKS_PERSIST_PATH, JSON.stringify(toSave, null, 2), 'utf8');
  } catch (e) {
    console.warn('[persist] 写入任务文件失败:', e.message);
  }
}

async function repairVideoSyncFromLocalFiles() {
  try {
    const entries = await fs.readdir(LOCAL_MEDIA_VIDEO_DIR, { withFileTypes: true });
    let repairedCount = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('_video.mp4')) continue;
      const match = entry.name.match(/^([0-9a-f-]+)_([0-9a-f-]+)_([0-9a-f-]+)_video\.[^.]+$/i);
      if (!match) continue;

      const [, projectId, episodeId, frameId] = match;
      const videoUrl = `/api/media/videos/${entry.name}`;
      const repaired = await syncVideoToMainBackend(projectId, episodeId, frameId, videoUrl);
      if (repaired) repairedCount++;
    }

    if (repairedCount > 0) {
      console.log(`[startup] 已补回填 ${repairedCount} 个历史视频结果`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[startup] 扫描历史视频回填失败:', err.message);
    }
  }
}

/**
 * 轮询 Jimeng historyId 直到任务完成，返回视频 CDN URL
 * 从 generateSeedanceVideo 中提取，可独立用于崩溃恢复
 * @param {boolean} isRecovery - 是否为恢复任务（恢复时跳过初始等待）
 */
async function pollSeedanceHistory(taskId, historyId, sessionId, isRecovery = false) {
  const task = tasks.get(taskId);
  if (!task) throw new Error(`任务 ${taskId} 不在内存中`);

  task.progress = isRecovery ? '恢复中，正在查询视频状态...' : '已提交，等待AI生成视频...';
  if (!isRecovery) {
    await new Promise((r) => setTimeout(r, 10 * 60 * 1000)); // 新任务首次等待 10 分钟
  }

  let status = 20;
  let failCode;
  let itemList = [];
  const maxRetries = 30; // 10分钟/次 × 30次 ≈ 5小时
  let consecutiveErrors = 0;

  for (let retryCount = 0; retryCount < maxRetries && status === 20; retryCount++) {
    try {
      const result = await jimengRequest('post', '/mweb/v1/get_history_by_ids', sessionId, {
        data: { history_ids: [historyId] },
      });

      consecutiveErrors = 0;

      const historyData = result?.history_list?.[0] || result?.[historyId];

      if (!historyData) {
        console.log(`[${taskId}] 轮询 #${retryCount + 1}: historyData 为空, result keys: ${JSON.stringify(Object.keys(result || {}))}`);
        const waitTime = Math.min(2000 * (retryCount + 1), 30000);
        console.log(`[${taskId}] 轮询 #${retryCount + 1}: 数据不存在，等待 ${waitTime}ms`);
        await new Promise((r) => setTimeout(r, waitTime));
        continue;
      }

      status = historyData.status;
      failCode = historyData.fail_code;
      itemList = historyData.item_list || [];

      const elapsed = Math.floor((Date.now() - task.startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;

      console.log(`[${taskId}] 轮询 #${retryCount + 1}: status=${status}, items=${itemList.length}, ${mins}分${secs}秒`);

      if (status === 30) {
        throw new Error(
          failCode === 2038
            ? '内容被过滤，请修改提示词后重试'
            : `视频生成失败，错误码: ${failCode}`
        );
      }

      if (status === 20) {
        if (elapsed < 120) {
          task.progress = 'AI正在生成视频，请耐心等待...';
        } else {
          task.progress = `视频生成中，已等待 ${mins} 分钟...`;
        }
        await new Promise((r) => setTimeout(r, 10 * 60 * 1000)); // 每 10 分钟轮询一次
      }
    } catch (error) {
      if (
        error.message?.includes('内容被过滤') ||
        error.message?.includes('生成失败') ||
        error.isApiError
      ) throw error;

      consecutiveErrors++;
      console.log(`[${taskId}] 轮询出错 (连续${consecutiveErrors}次): ${error.message}`);

      if (consecutiveErrors >= 10) {
        throw new Error(`轮询连续失败 ${consecutiveErrors} 次，最后错误: ${error.message}`);
      }

      const waitTime = 10 * 60 * 1000; // 出错后也等 10 分钟再重试
      await new Promise((r) => setTimeout(r, waitTime));
    }
  }

  if (status === 20) throw new Error('视频生成超时 (约5小时)，请稍后重试');

  // 获取高清视频URL
  task.progress = '正在获取高清视频...';
  const itemId = itemList?.[0]?.item_id || itemList?.[0]?.id || itemList?.[0]?.local_item_id || itemList?.[0]?.common_attr?.id;

  if (itemId) {
    try {
      const hqResult = await jimengRequest('post', '/mweb/v1/get_local_item_list', sessionId, {
        data: {
          item_id_list: [String(itemId)],
          pack_item_opt: { scene: 1, need_data_integrity: true },
          is_for_video_download: true,
        },
      });

      const hqItemList = hqResult?.item_list || hqResult?.local_item_list || [];
      const hqItem = hqItemList[0];

      // 扩展URL提取路径，优先提取 vlabvod.com 域名的URL
      const hqUrl =
        hqItem?.video?.transcoded_video?.origin?.video_url ||
        hqItem?.video?.transcoded_video?.video_url ||
        hqItem?.video?.download_url ||
        hqItem?.video?.play_url ||
        hqItem?.video?.url;

      if (hqUrl) {
        console.log(`[${taskId}] 高清视频URL获取成功: ${hqUrl.substring(0, 80)}...`);
        return hqUrl;
      }

      // 正则提取：优先匹配 vlabvod.com 域名
      const responseStr = JSON.stringify(hqResult);
      const urlMatch =
        responseStr.match(/https:\/\/v[0-9]+-[^\"\\]*\.vlabvod\.com\/[^\"\s\\]+/) ||
        responseStr.match(/https:\/\/v[0-9]+-artist\.vlabvod\.com\/[^\"\s\\]+/) ||
        responseStr.match(/https:\/\/v[0-9]+-dreamnia\.jimeng\.com\/[^\"\s\\]+/) ||
        responseStr.match(/https:\/\/v[0-9]+-[^\"\\]*\.jimeng\.com\/[^\"\s\\]+/);
      if (urlMatch?.[0]) {
        console.log(`[${taskId}] 正则提取到高清视频URL: ${urlMatch[0].substring(0, 80)}...`);
        return urlMatch[0];
      }

      console.log(`[${taskId}] 高清URL响应结构: ${responseStr.substring(0, 500)}...`);
    } catch (err) {
      console.log(`[${taskId}] 获取高清URL失败，使用预览URL: ${err.message}`);
    }
  }

  const videoUrl =
    itemList?.[0]?.video?.transcoded_video?.origin?.video_url ||
    itemList?.[0]?.video?.transcoded_video?.video_url ||
    itemList?.[0]?.video?.play_url ||
    itemList?.[0]?.video?.download_url ||
    itemList?.[0]?.video?.url;

  if (!videoUrl) throw new Error('未能获取视频URL');

  // 验证视频有效性：检查文件大小（仅警告，不阻断）
  try {
    const headResponse = await fetch(videoUrl, {
      method: 'HEAD',
      headers: {
        'User-Agent': FAKE_HEADERS['User-Agent'],
        Referer: 'https://jimeng.jianying.com/',
      },
      signal: AbortSignal.timeout(10000),
    });

    const contentLength = parseInt(headResponse.headers.get('content-length') || '0');
    if (contentLength > 0) {
      console.log(`[${taskId}] 视频URL验证通过 (${(contentLength / 1024 / 1024).toFixed(1)}MB)`);
    } else {
      console.warn(`[${taskId}] 无法获取视频大小，但继续使用该URL`);
    }
  } catch (validateErr) {
    console.warn(`[${taskId}] 视频验证失败（继续使用）: ${validateErr.message}`);
  }

  console.log(`[${taskId}] 最终视频URL: ${videoUrl.substring(0, 100)}...`);
  return videoUrl;
}

/**
 * 启动时加载持久化任务，恢复 processing 中的任务轮询
 */
async function loadAndResumeTasks() {
  try {
    const raw = await fs.readFile(TASKS_PERSIST_PATH, 'utf8');
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved) || saved.length === 0) return;

    let resumeCount = 0;
    for (const t of saved) {
      // done/error 任务：若超过 30 分钟窗口则跳过（无需再放入内存）
      if ((t.status === 'done' || t.status === 'error') && t.completedAt) {
        if (Date.now() - t.completedAt >= TASK_MEMORY_TTL) continue;
      }

      // 恢复到内存 Map
      tasks.set(t.id, {
        id: t.id,
        status: t.status,
        startTime: t.startTime,
        completedAt: t.completedAt || null,
        historyId: t.historyId || null,
        jimengSessionId: t.jimengSessionId || null,
        sessionId: t.sessionId || null,
        sessionName: t.sessionName || '已恢复',
        projectId: t.projectId || null,
        episodeId: t.episodeId || null,
        frameId: t.frameId || null,
        progress: t.status === 'processing'
          ? (t.historyId ? '微服务已重启，正在恢复轮询...' : '微服务已重启，任务未能恢复（尚未提交到即梦）')
          : (t.progress || ''),
        result: t.result || null,
        error: t.error || null,
      });

      // done/error 任务：恢复剩余的 30 分钟清理定时器
      if (t.status === 'done' || t.status === 'error') {
        scheduleTaskCleanup(t.id);
      }

      // 仅恢复已提交到即梦（有 historyId）的处理中任务
      if (t.status === 'processing' && t.historyId && t.jimengSessionId) {
        resumeCount++;
        const capturedId = t.id;
        const capturedHistoryId = t.historyId;
        const capturedSessionId = t.jimengSessionId;
        const capturedSessionUuid = t.sessionId;

        console.log(`[startup] 恢复任务 ${capturedId} (historyId: ${capturedHistoryId})`);

        (async () => {
          const task = tasks.get(capturedId);
          try {
            const videoUrl = await pollSeedanceHistory(capturedId, capturedHistoryId, capturedSessionId, true);
            task.progress = '正在保存视频到本地...';
            const localUrl = await downloadAndSaveVideo(videoUrl, `seedance_${capturedId}`);
            const finalUrl = localUrl || videoUrl;
            await syncVideoToMainBackend(task.projectId, task.episodeId, task.frameId, finalUrl);
            task.status = 'done';
            task.completedAt = Date.now();
            task.result = {
              created: Math.floor(Date.now() / 1000),
              data: [{ url: finalUrl, savedLocally: !!localUrl }],
            };
            scheduleTaskCleanup(capturedId);
            if (capturedSessionUuid) await releaseAndDrain(capturedSessionUuid, true, capturedId);
            console.log(`[startup] 任务 ${capturedId} 恢复成功`);
          } catch (err) {
            task.status = 'error';
            task.completedAt = Date.now();
            task.error = err.message || '恢复任务失败';
            scheduleTaskCleanup(capturedId);
            if (capturedSessionUuid) await releaseAndDrain(capturedSessionUuid, false, capturedId);
            console.error(`[startup] 任务 ${capturedId} 恢复失败: ${err.message}`);
          }
          await persistTasks();
        })();
      } else if (t.status === 'processing' && !t.historyId) {
        // 还未提交到即梦就崩溃了，无法恢复，标记为失败
        const task = tasks.get(t.id);
        task.status = 'error';
        task.completedAt = Date.now();
        task.error = '微服务重启前任务未能提交到即梦，请重新生成';
        scheduleTaskCleanup(t.id);
      }
    }

    console.log(`[startup] 从磁盘恢复了 ${saved.length} 个历史任务，其中 ${resumeCount} 个正在重新轮询`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[startup] 加载持久化任务失败:', err.message);
    }
  }
}

// ============================================================
// Seedance 2.0 视频生成 (完整流程)
// ============================================================
async function generateSeedanceVideo(taskId, { prompt, ratio, duration, imageBuffers, sessionId, model: requestModel }) {
  const task = tasks.get(taskId);
  const modelKey = requestModel && MODEL_MAP[requestModel] ? requestModel : 'seedance-2.0';
  const model = MODEL_MAP[modelKey];
  const benefitType = BENEFIT_TYPE_MAP[modelKey];
  const actualDuration = duration || 4;

  const resConfig = VIDEO_RESOLUTION[ratio] || VIDEO_RESOLUTION['4:3'];
  const { width, height } = resConfig;

  console.log(`[${taskId}] ${modelKey}: ${width}x${height} (${ratio}) ${actualDuration}秒`);
  console.log(`[${taskId}] 实际收到 ${imageBuffers.length} 张参考图进入生成流程`);

  // 第1步: 上传图片
  task.progress = '正在上传参考图片...';
  const uploadedImages = [];

  for (let i = 0; i < imageBuffers.length; i++) {
    const imageBuffer = imageBuffers[i];
    task.progress = `正在上传第 ${i + 1}/${imageBuffers.length} 张参考图片...`;
    console.log(`[${taskId}] 上传图片 ${i + 1}/${imageBuffers.length} (${(imageBuffer.length / 1024).toFixed(1)}KB)`);
    const imageUri = await uploadImageBuffer(imageBuffer, sessionId);
    uploadedImages.push({ uri: imageUri, width, height });
    console.log(`[${taskId}] 图片 ${i + 1} 上传成功`);
  }

  // 第2步: 构建 material_list 和 meta_list
  const materialList = uploadedImages.map((img) => ({
    type: '',
    id: generateUUID(),
    material_type: 'image',
    image_info: {
      type: 'image',
      id: generateUUID(),
      source_from: 'upload',
      platform_type: 1,
      name: '',
      image_uri: img.uri,
      aigc_image: { type: '', id: generateUUID() },
      width: img.width,
      height: img.height,
      format: '',
      uri: img.uri,
    },
  }));

  const metaList = buildMetaListFromPrompt(prompt || '', uploadedImages.length);

  const componentId = generateUUID();
  const submitId = generateUUID();

  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  const aspectRatio = `${width / divisor}:${height / divisor}`;

  const metricsExtra = JSON.stringify({
    isDefaultSeed: 1,
    originSubmitId: submitId,
    isRegenerate: false,
    enterFrom: 'click',
    position: 'page_bottom_box',
    functionMode: 'omni_reference',
    sceneOptions: JSON.stringify([{
      type: 'video',
      scene: 'BasicVideoGenerateButton',
      modelReqKey: model,
      videoDuration: actualDuration,
      reportParams: {
        enterSource: 'generate',
        vipSource: 'generate',
        extraVipFunctionKey: model,
        useVipFunctionDetailsReporterHoc: true,
      },
      materialTypes: [1],
    }]),
  });

  // 第3步: 提交生成请求 (通过浏览器代理绕过 shark 反爬)
  task.progress = '正在提交视频生成请求...';
  console.log(`[${taskId}] 提交生成请求: model=${model}, benefitType=${benefitType}`);

  const generateQueryParams = new URLSearchParams({
    aid: String(DEFAULT_ASSISTANT_ID),
    device_platform: 'web',
    region: 'cn',
    webId: String(WEB_ID),
    da_version: SEEDANCE_DRAFT_VERSION,
    web_component_open_flag: '1',
    web_version: '7.5.0',
    aigc_features: 'app_lip_sync',
  });
  const generateUrl = `${JIMENG_BASE_URL}/mweb/v1/aigc_draft/generate?${generateQueryParams}`;

  const generateBody = {
    extend: {
      root_model: model,
      m_video_commerce_info: {
        benefit_type: benefitType,
        resource_id: 'generate_video',
        resource_id_type: 'str',
        resource_sub_type: 'aigc',
      },
      m_video_commerce_info_list: [{
        benefit_type: benefitType,
        resource_id: 'generate_video',
        resource_id_type: 'str',
        resource_sub_type: 'aigc',
      }],
    },
    submit_id: submitId,
    metrics_extra: metricsExtra,
    draft_content: JSON.stringify({
      type: 'draft',
      id: generateUUID(),
      min_version: SEEDANCE_DRAFT_VERSION,
      min_features: ['AIGC_Video_UnifiedEdit'],
      is_from_tsn: true,
      version: SEEDANCE_DRAFT_VERSION,
      main_component_id: componentId,
      component_list: [{
        type: 'video_base_component',
        id: componentId,
        min_version: '1.0.0',
        aigc_mode: 'workbench',
        metadata: {
          type: '',
          id: generateUUID(),
          created_platform: 3,
          created_platform_version: '',
          created_time_in_ms: String(Date.now()),
          created_did: '',
        },
        generate_type: 'gen_video',
        abilities: {
          type: '',
          id: generateUUID(),
          gen_video: {
            type: '',
            id: generateUUID(),
            text_to_video_params: {
              type: '',
              id: generateUUID(),
              video_gen_inputs: [{
                type: '',
                id: generateUUID(),
                min_version: SEEDANCE_DRAFT_VERSION,
                prompt: '',
                video_mode: 2,
                fps: 24,
                duration_ms: actualDuration * 1000,
                idip_meta_list: [],
                unified_edit_input: {
                  type: '',
                  id: generateUUID(),
                  material_list: materialList,
                  meta_list: metaList,
                },
              }],
              video_aspect_ratio: aspectRatio,
              seed: Math.floor(Math.random() * 1000000000),
              model_req_key: model,
              priority: 0,
            },
            video_task_extra: metricsExtra,
          },
        },
        process_type: 1,
      }],
    }),
    http_common_info: { aid: DEFAULT_ASSISTANT_ID },
  };

  const generateResult = await browserService.fetch(
    sessionId, WEB_ID, USER_ID, generateUrl,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(generateBody) }
  );

  if (generateResult.ret !== undefined && String(generateResult.ret) !== '0') {
    const retCode = String(generateResult.ret);
    const errMsg = generateResult.errmsg || retCode;
    if (retCode === '5000' || retCode === '1006') throw Object.assign(new Error(`即梦积分不足或没有相关权益 (ret=${retCode})`), { isApiError: true, retCode });
    if (retCode === '4013') throw Object.assign(new Error(`即梦会员已过期 (ret=4013): ${errMsg}`), { isApiError: true, retCode, isMemberExpired: true });
    throw Object.assign(new Error(`即梦API错误 (ret=${retCode}): ${errMsg}`), { isApiError: true, retCode });
  }

  const aigcData = generateResult.data?.aigc_data;
  const historyId = aigcData?.history_record_id;
  if (!historyId) throw new Error('未获取到记录ID');

  console.log(`[${taskId}] 生成请求已提交, historyId: ${historyId}`);

  // 持久化 historyId + jimengSessionId，确保微服务崩溃后可恢复轮询
  const memTask = tasks.get(taskId);
  if (memTask) {
    memTask.historyId = historyId;
    memTask.jimengSessionId = sessionId;
    persistTasks().catch(e => console.warn('[persist] 持久化失败:', e.message));
  }

  // 第4步: 轮询获取结果（提取为独立函数，供崩溃恢复复用）
  return pollSeedanceHistory(taskId, historyId, sessionId);
}



// ============================================================
// Express 路由
// ============================================================

/**
 * 带自动轮换的视频生成：
 * - 遇到 ret=1006/5000（积分不足）时，标记当前 session 为 insufficient，释放后轮换
 * - 遇到 ret=1310（高峰期限流）时，不标记 insufficient，仅释放并轮换（账号仍可用于其他请求）
 * - 非可轮换错误（auth/网络等）直接抛出（调用方无需再次 release，已在此处处理）
 * - 成功时返回 { videoUrl, activeSession }，调用方负责 releaseSession(activeSession.id, true)
 */
async function generateWithAutoRetry(taskId, task, initialSession, genParams, imageBuffers) {
  let activeSession = initialSession;
  const triedSessionIds = new Set([initialSession.id]); // 跟踪本次请求已尝试的账号（防止 1310 无限循环）

  while (true) {
    try {
      const videoUrl = await generateSeedanceVideo(taskId, {
        ...genParams,
        imageBuffers,
        sessionId: activeSession.sessionId,
      });
      return { videoUrl, activeSession };
    } catch (genErr) {
      const isInsufficient = genErr.retCode === '5000' || genErr.retCode === '1006'
        || genErr.message?.includes('积分不足') || genErr.message?.includes('没有相关权益');
      const isPeakBusy = genErr.retCode === '1310'
        || genErr.message?.includes('高峰期') || genErr.message?.includes('无法提交更多任务');
      const isSecurityCheck = genErr.retCode === '4010'
        || genErr.message?.includes('安全确认');
      const isBrowserError = genErr.isBrowserError === true;
      const isNavError = genErr.isNavError === true; // 页面导航失败（超时/网络）
      const isMemberExpired = genErr.isMemberExpired === true || genErr.retCode === '4013'; // 会员已过期
      const isRotatable = isInsufficient || isPeakBusy || isSecurityCheck || isBrowserError || isNavError || isMemberExpired;

      if (!isRotatable) {
        // 非可轮换错误：释放当前 session 后抛出，调用方无需再 release
        await releaseAndDrain(activeSession.id, false, taskId);
        if (genErr.message?.includes('auth') || genErr.message?.includes('登录') || genErr.message?.includes('session')) {
          await sessionManager.markSessionStatus(activeSession.id, 'expired');
        }
        genErr.alreadyReleased = true;
        throw genErr;
      }

      const lastAccountName = activeSession.name;
      const reason = isInsufficient
        ? `积分不足 (ret=${genErr.retCode || '?'})`
        : isSecurityCheck
        ? `安全验证失败 (ret=4010)`
        : isMemberExpired
        ? `会员已过期 (ret=4013)`
        : isNavError
        ? `页面导航失败（Session ID 可能已过期）: ${genErr.message?.substring(0, 80)}`
        : isBrowserError
        ? `浏览器请求异常: ${genErr.message?.substring(0, 100)}`
        : `高峰期限流 (ret=1310)`;
      console.log(`[${taskId}] 账号 "${lastAccountName}" ${reason}，尝试切换账号...`);

      await releaseAndDrain(activeSession.id, false, taskId);
      if (isInsufficient) {
        // 积分不足：永久标记，需手动重置
        await sessionManager.markSessionStatus(activeSession.id, 'insufficient');
      } else if (isSecurityCheck) {
        // 安全验证失败(4010)：关闭浏览器上下文强制重建指纹，标记 security_check
        await browserService.closeSession(activeSession.sessionId);
        await sessionManager.markSessionStatus(activeSession.id, 'security_check');
      } else if (isMemberExpired) {
        // 会员已过期 (ret=4013)：账号会员到期，标记 member_expired
        await browserService.closeSession(activeSession.sessionId);
        await sessionManager.markSessionStatus(activeSession.id, 'member_expired');
        console.log(`[${taskId}] 账号 "${lastAccountName}" 会员已过期 (ret=4013)，已标记为 member_expired`);
      } else if (isNavError) {
        // 页面导航失败：Session ID 很可能已过期/失效，标记 expired
        await browserService.closeSession(activeSession.sessionId);
        await sessionManager.markSessionStatus(activeSession.id, 'expired');
        console.log(`[${taskId}] 账号 "${lastAccountName}" 导航失败，已标记为 expired，需要更换 Session ID`);
      } else if (isBrowserError) {
        // 浏览器错误：不标记状态，可能是临时网络问题，下次仍可用
        console.log(`[${taskId}] 浏览器错误，不标记账号状态，将尝试其他账号`);
      }
      // 注：高峰期(1310)不标记 insufficient，账号仍为 active，可接受其他请求

      const nextSession = await acquireOrWait(taskId);
      // 检查是否已尝试过该账号（1310 场景下账号仍为 active，可能被重新分配）
      if (triedSessionIds.has(nextSession.id)) {
        // 已获取的多余 slot 立即归还
        await releaseAndDrain(nextSession.id, false, taskId);

        // 积分不足：立即失败，无需排队等待
        if (isInsufficient) {
          const finalReason = `即梦所有账号积分不足，最后尝试账号：${lastAccountName}，已无可用账号重试`;
          throw Object.assign(new Error(finalReason), { alreadyReleased: true });
        }

        // 浏览器错误：所有账号都试过了，可能是网络问题或微服务异常
        if (isBrowserError) {
          const finalReason = `所有账号均遇到浏览器请求异常，最后错误: ${genErr.message?.substring(0, 150)}`;
          throw Object.assign(new Error(finalReason), { alreadyReleased: true });
        }

        // 导航失败 / 会员过期 / 1310 / 4010：进入等待队列，等待有其他账号可用后重试
        const waitReason = isNavError
          ? '页面导航失败（账号已标记过期）'
          : isMemberExpired
          ? '会员已过期 (ret=4013，账号已标记过期)'
          : isSecurityCheck ? '安全验证(4010)' : '高峰期限流(1310)';
        console.log(`[${taskId}] 所有可用账号已尝试（${waitReason}），进入等待队列...`);
        task.progress = `${waitReason}，等待其他账号可用后将自动重试...`;
        persistTasks().catch(e => console.warn('[persist] 等待重试持久化失败:', e.message));

        if (!isNavError && !isMemberExpired) {
          // 仅 1310/4010 触发冷却；导航失败/会员过期不冷却，等待账号释放即可
          triggerPeakCooldown();
        }
        triedSessionIds.clear();

        // 阻塞等待：有可用 slot 时由 acquireOrWait 内部唤醒
        const freshSession = await acquireOrWait(taskId);
        triedSessionIds.add(freshSession.id);
        activeSession = freshSession;
        task.sessionName = freshSession.name;
        task.jimengSessionId = freshSession.sessionId;
        task.progress = `已切换至账号"${freshSession.name}"，继续重试...`;
        persistTasks().catch(e => console.warn('[persist] 等待后切换账号持久化失败:', e.message));
        console.log(`[${taskId}] 等待结束，切换至账号 "${freshSession.name}"，继续重试...`);
        continue;
      }

      triedSessionIds.add(nextSession.id);
      activeSession = nextSession;
      task.sessionName = nextSession.name;
      task.jimengSessionId = nextSession.sessionId;
      task.progress = `已切换至账号"${nextSession.name}"，继续重试...`;
      persistTasks().catch(e => console.warn('[persist] 切换账号持久化失败:', e.message));
      console.log(`[${taskId}] 切换至账号 "${nextSession.name}"，继续重试...`);
    }
  }
}

// POST /api/generate-video-from-url - 接收图片URL（单图/多图），微服务自行下载
app.post('/api/generate-video-from-url', async (req, res) => {
  const startTime = Date.now();

  try {
    const { imageUrl, imageUrls, prompt, ratio, duration, model } = req.body;
    const projectId = req.body.projectId || null;
    const episodeId = req.body.episodeId || null;
    const frameId = req.body.frameId || null;
    const finalImageUrls = Array.isArray(imageUrls)
      ? imageUrls.filter(url => typeof url === 'string' && url.trim())
      : (imageUrl ? [imageUrl] : []);

    if (finalImageUrls.length === 0) {
      return res.status(400).json({ error: '缺少 imageUrl 或 imageUrls 参数' });
    }

    // 先创建 taskId，再 acquire（以便把 taskId 绑定到并发槽）
    const taskId = createTaskId();

    // 从中心后端获取可用 session（并发满时排队等待，不直接失败）
    const session = await acquireOrWait(taskId);
    const task = {
      id: taskId,
      status: 'processing',
      progress: '正在准备...',
      startTime,
      result: null,
      error: null,
      sessionId: session.id,
      jimengSessionId: session.sessionId,
      sessionName: session.name,
      projectId,
      episodeId,
      frameId,
    };
    tasks.set(taskId, task);

    console.log(`\n========== [${taskId}] 收到视频生成请求 (URL模式) ==========`);
    console.log(`  imageCount: ${finalImageUrls.length}`);
    console.log(`  prompt: ${(prompt || "").substring(0, 80)}${(prompt || "").length > 80 ? "..." : ""}`);
    console.log(`  model: ${model || "seedance-2.0"}, ratio: ${ratio || "4:3"}, duration: ${duration || 4}秒`);
    console.log(`  session: ${session.name} (${session.sessionId.substring(0, 8)}...)`);

    res.json({ taskId, sessionName: session.name });

    // 后台执行
    (async () => {
      try {
        // 下载图片
        task.progress = '正在下载参考图片...';
        const imageBuffers = [];
        for (let i = 0; i < finalImageUrls.length; i++) {
          const currentImageUrl = finalImageUrls[i];
          task.progress = `正在下载第 ${i + 1}/${finalImageUrls.length} 张参考图片...`;
          const imgResponse = await fetch(currentImageUrl, {
            headers: { 'User-Agent': FAKE_HEADERS['User-Agent'] },
            signal: AbortSignal.timeout(30000),
          });
          if (!imgResponse.ok) throw new Error(`下载图片失败: ${imgResponse.status}`);
          const arrayBuffer = await imgResponse.arrayBuffer();
          const imageBuffer = Buffer.from(arrayBuffer);
          imageBuffers.push(imageBuffer);
          console.log(`[${taskId}] 图片 ${i + 1} 下载完成: ${(imageBuffer.length / 1024).toFixed(1)}KB`);
        }

        const { videoUrl, activeSession } = await generateWithAutoRetry(
          taskId,
          task,
          session,
          { prompt, ratio: ratio || '4:3', duration: parseInt(duration) || 4, model: model || 'seedance-2.0' },
          imageBuffers,
        );

        // 文件名：优先用帧信息（可追溯），无帧信息时退回 taskId
        const videoFilename = (projectId && episodeId && frameId)
          ? `${projectId}_${episodeId}_${frameId}_video`
          : `seedance_${taskId}`;
        task.progress = '正在保存视频到本地...';
        const localUrl = await downloadAndSaveVideo(videoUrl, videoFilename);
        const finalUrl = localUrl || videoUrl;
        await syncVideoToMainBackend(projectId, episodeId, frameId, finalUrl);

        task.status = 'done';
        task.completedAt = Date.now();
        task.result = {
          created: Math.floor(Date.now() / 1000),
          data: [{ url: finalUrl, revised_prompt: prompt || '', savedLocally: !!localUrl }],
        };
        scheduleTaskCleanup(taskId);
        await releaseAndDrain(activeSession.id, true, taskId);
        await persistTasks();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`========== [${taskId}] 视频生成成功 (${elapsed}秒) ==========\n`);
      } catch (err) {
        task.status = 'error';
        task.completedAt = Date.now();
        task.error = err.message || '视频生成失败';
        scheduleTaskCleanup(taskId);

        // alreadyReleased 表示 generateWithAutoRetry 内部已经处理了 release/mark
        if (!err.alreadyReleased) {
          await releaseAndDrain(session.id, false, taskId);
          if (err.retCode === '5000' || err.retCode === '1006' || err.message?.includes('积分不足') || err.message?.includes('没有相关权益')) {
            await sessionManager.markSessionStatus(session.id, 'insufficient');
          } else if (err.retCode === '4010' || err.message?.includes('安全确认')) {
            await sessionManager.markSessionStatus(session.id, 'security_check');
            task.error = `即梦API错误 (ret=4010): 账号"${session.name}"需要安全确认，请刷新新页面重试`;
          } else if (err.message?.includes('auth') || err.message?.includes('登录') || err.message?.includes('session')) {
            await sessionManager.markSessionStatus(session.id, 'expired');
          }
        }

        await persistTasks();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.error(`========== [${taskId}] 视频生成失败 (${elapsed}秒): ${err.message} ==========\n`);
      }
    })();
  } catch (error) {
    console.error(`请求处理错误: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || '服务器内部错误' });
    }
  }
});

// POST /api/generate-video - 兼容原始 multipart 模式
app.post('/api/generate-video', upload.array('files', 20), async (req, res) => {
  const startTime = Date.now();

  try {
    const { prompt, ratio, duration, sessionId: reqSessionId, model } = req.body;
    const projectId = req.body.projectId || null;
    const episodeId = req.body.episodeId || null;
    const frameId = req.body.frameId || null;
    const files = req.files;

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'Seedance 2.0 需要至少上传一张参考图片' });
    }

    console.log(`[seedance] multipart 请求收到 ${files.length} 张参考图`);
    files.forEach((file, index) => {
      console.log(`[seedance] file[${index}] name=${file.originalname} size=${file.size} type=${file.mimetype}`);
    });

    // 先创建 taskId 并立即返回，让前端可以开始轮询状态
    const taskId = createTaskId();

    const task = {
      id: taskId,
      status: 'waiting',          // 初始状态：等待 session
      progress: '等待可用账号...',
      startTime,
      result: null,
      error: null,
      jimengSessionId: null,
      sessionName: null,
      projectId,
      episodeId,
      frameId,
    };
    tasks.set(taskId, task);

    const imageBuffers = files.map(file => file.buffer);

    // 先分配 session 再响应，确保前端能立即获取 sessionName
    (async () => {
      try {
        const genParams = {
          prompt,
          ratio: ratio || '4:3',
          duration: parseInt(duration) || 4,
          model: model || 'seedance-2.0',
        };

        let session;
        if (reqSessionId) {
          session = { id: 'manual', sessionId: reqSessionId, name: '手动指定' };
        } else {
          session = await acquireOrWait(taskId);
          task.jimengSessionId = session.sessionId;
          task.sessionId = session.id;
          task.sessionName = session.name;
          task.status = 'processing';
          task.progress = '正在准备...';
        }

        // 分配完 session 后立即响应前端
        if (!res.headersSent) {
          res.json({ taskId, sessionName: session.name });
        }

        let videoUrl;
        let activeSession;

        if (session.id === 'manual') {
          // 手动指定 session 不做轮换
          videoUrl = await generateSeedanceVideo(taskId, { ...genParams, imageBuffers, sessionId: session.sessionId });
          activeSession = session;
        } else {
          ({ videoUrl, activeSession } = await generateWithAutoRetry(taskId, task, session, genParams, imageBuffers));
        }

        // 文件名：优先用帧信息（可追溯），无帧信息时退回 taskId
        const videoFilename = (projectId && episodeId && frameId)
          ? `${projectId}_${episodeId}_${frameId}_video`
          : `seedance_${taskId}`;
        task.progress = '正在保存视频到本地...';
        const localUrl = await downloadAndSaveVideo(videoUrl, videoFilename);
        const finalUrl = localUrl || videoUrl;
        await syncVideoToMainBackend(projectId, episodeId, frameId, finalUrl);

        task.status = 'done';
        task.completedAt = Date.now();
        task.result = {
          created: Math.floor(Date.now() / 1000),
          data: [{ url: finalUrl, revised_prompt: prompt || '', savedLocally: !!localUrl }],
        };
        scheduleTaskCleanup(taskId);
        if (activeSession.id !== 'manual') await releaseAndDrain(activeSession.id, true, taskId);
        await persistTasks();
      } catch (err) {
        task.status = 'error';
        task.completedAt = Date.now();
        task.error = err.message || '视频生成失败';
        scheduleTaskCleanup(taskId);
        if (activeSession.id !== 'manual' && !err.alreadyReleased) {
          await releaseAndDrain(activeSession.id, false, taskId);
          if (err.retCode === '5000' || err.retCode === '1006' || err.message?.includes('积分不足') || err.message?.includes('没有相关权益')) {
            await sessionManager.markSessionStatus(activeSession.id, 'insufficient');
          }
        }
        await persistTasks();
      }
    })();
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || '服务器内部错误' });
    }
  }
});

// GET /api/task/:taskId - 轮询任务状态
app.get('/api/task/:taskId', (req, res) => {
  const task = tasks.get(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }

  const elapsed = Math.floor((Date.now() - task.startTime) / 1000);

  if (task.status === 'done') {
    res.json({ status: 'done', elapsed, result: task.result, sessionName: task.sessionName });
    return;
  }

  if (task.status === 'error') {
    res.json({ status: 'error', elapsed, error: task.error, sessionName: task.sessionName });
    return;
  }

  if (task.status === 'waiting') {
    res.json({ status: 'waiting', elapsed, progress: task.progress, sessionName: task.sessionName });
    return;
  }

  res.json({ status: 'processing', elapsed, progress: task.progress, sessionName: task.sessionName });
});

// GET /api/tasks - 获取所有任务列表
app.get('/api/tasks', (_req, res) => {
  const taskList = [];
  for (const [, task] of tasks) {
    if (task.status === 'processing' || task.status === 'waiting') {
      taskList.push({
        id: task.id,
        status: task.status,
        projectId: task.projectId,
        episodeId: task.episodeId,
        frameId: task.frameId,
        sessionName: task.sessionName,
        progress: task.progress,
        elapsed: Math.floor((Date.now() - task.startTime) / 1000)
      });
    }
  }
  res.json({ data: taskList });
});

// ============================================================
// Session 管理路由
// ============================================================

// GET /api/sessions - 返回所有 session 状态（脱敏）
app.get('/api/sessions', (_req, res) => {
  res.json({ data: sessionManager.getSessions() });
});

// POST /api/sessions - 添加 session
app.post('/api/sessions', async (req, res) => {
  try {
    const { sessionId, name } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: '缺少 sessionId' });
    }
    const session = await sessionManager.addSession(sessionId, name);
    res.json({ data: { ...session, sessionId: session.sessionId.substring(0, 8) + '***' } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sessions/:id - 删除 session
app.delete('/api/sessions/:id', async (req, res) => {
  const deleted = await sessionManager.removeSession(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: 'Session 不存在' });
  }
  res.json({ success: true });
});

// POST /api/sessions/:id/query-credits - 查询积分
app.post('/api/sessions/:id/query-credits', async (req, res) => {
  try {
    const result = await sessionManager.queryCredits(req.params.id, jimengRequest);
    res.json({ data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/sync - 从主后端同步 session 列表，并清理失效的浏览器上下文
app.post('/api/sessions/sync', async (_req, res) => {
  try {
    // 同步前：记录当前有效的 session cookie 集合
    const oldCookies = new Set(
      Array.from(sessionManager.sessionsCache.values()).map(s => s.sessionId).filter(Boolean)
    );

    await sessionManager.fetchFromBackend();

    // 同步后：获取最新的 session cookie 集合
    const newCookies = new Set(
      Array.from(sessionManager.sessionsCache.values()).map(s => s.sessionId).filter(Boolean)
    );

    // 关闭已删除或已更换 cookie 的旧浏览器上下文
    const activeBrowserSessions = browserService.getActiveSessions();
    let closedCount = 0;
    for (const browserSessionId of activeBrowserSessions) {
      if (!newCookies.has(browserSessionId)) {
        console.log(`[sync] 关闭失效的浏览器上下文: ${browserSessionId.substring(0, 8)}...`);
        await browserService.closeSession(browserSessionId);
        closedCount++;
      }
    }
    if (closedCount > 0) {
      console.log(`[sync] 已清理 ${closedCount} 个失效的浏览器上下文`);
    }

    res.json({ success: true, data: sessionManager.getSessions() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 视频代理
// ============================================================
app.get('/api/video-proxy', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: '缺少 url 参数' });
  }

  try {
    const response = await fetch(videoUrl, {
      headers: {
        'User-Agent': FAKE_HEADERS['User-Agent'],
        Referer: 'https://jimeng.jianying.com/',
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `视频获取失败: ${response.status}` });
    }

    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const contentLength = response.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const reader = response.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); return; }
        if (!res.write(value)) {
          await new Promise((r) => res.once('drain', r));
        }
      }
    };
    pump().catch((err) => {
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: '视频代理失败' });
    }
  }
});

// multer 错误处理
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ error: '文件大小超过限制 (最大20MB)' });
    if (err.code === 'LIMIT_FILE_COUNT')
      return res.status(400).json({ error: '文件数量超过限制 (最多5个)' });
    return res.status(400).json({ error: `上传错误: ${err.message}` });
  }
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    mode: 'seedance-multi-session',
    sessions: sessionManager.getSessions().length,
    activeSessions: sessionManager.getSessions().filter(s => s.status === 'active').length,
  });
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('[server] 收到 SIGTERM，正在关闭...');
  browserService.close().finally(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('[server] 收到 SIGINT，正在关闭...');
  browserService.close().finally(() => process.exit(0));
});

// 启动时从主后端同步 session，并恢复持久化任务
async function startup() {
  await loadEnvLocal();
  await fs.mkdir(dirname(TASKS_PERSIST_PATH), { recursive: true });
  await sessionManager.fetchFromBackend();
  await loadAndResumeTasks();
  await repairVideoSyncFromLocalFiles();

  app.listen(PORT, HOST, () => {
    const sessions = sessionManager.getSessions();
    console.log(`\n🚀 Seedance 微服务已启动: http://${HOST}:${PORT}`);
    console.log(`🌐 局域网访问请使用: http://<你的IP>:${PORT}`);
    console.log('🔗 直连即梦 API (jimeng.jianying.com)');
    console.log(`📊 已加载 ${sessions.length} 个 Session`);
    sessions.forEach(s => {
      console.log(`   - ${s.name}: ${s.status} (${s.sessionId})`);
    });
    console.log('');
  });
}

startup().catch(err => {
  console.error('启动失败:', err);
  // 即使同步失败也启动服务
  app.listen(PORT, HOST, () => {
    console.log(`\n🚀 Seedance 微服务已启动: http://${HOST}:${PORT} (无预加载 Session)`);
  });
});
