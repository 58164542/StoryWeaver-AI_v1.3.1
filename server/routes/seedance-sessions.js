/**
 * Seedance Session CRUD + 中心化调度路由
 * 存储在 LowDB db.data.seedanceSessions
 * 所有远程主机共享同一份配置和实时状态
 */
import { Router } from 'express';
import { getDatabase, saveDatabase } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// 任务占用槽位的最大存活时长：超过此时间未 release 视为已死亡（微服务崩溃/超时），自动释放
const TASK_TTL_MS = 3 * 60 * 60 * 1000; // 3 小时

/**
 * 清理 session 中超时的 activeTasks，返回是否有变化
 */
function expireActiveTasks(session) {
  if (!session.activeTasks) {
    session.activeTasks = [];
    session.currentTasks = 0;
    return true;
  }
  const now = Date.now();
  const before = session.activeTasks.length;
  session.activeTasks = session.activeTasks.filter(t => now - t.acquiredAt < TASK_TTL_MS);
  session.currentTasks = session.activeTasks.length;
  return session.activeTasks.length !== before;
}

// 定期扫描所有 session，自动清理超时任务（每 10 分钟）
setInterval(async () => {
  try {
    const db = getDatabase();
    const sessions = db.data.seedanceSessions || [];
    let changed = false;
    for (const s of sessions) {
      if (expireActiveTasks(s)) changed = true;
    }
    if (changed) await saveDatabase();
  } catch (err) {
    console.warn('[session-cleanup] 定期清理过期任务失败:', err.message);
  }
}, 10 * 60 * 1000);

// GET /api/seedance-sessions — 列出所有 session（含实时状态，sessionId 脱敏）
router.get('/', (req, res) => {
  try {
    const db = getDatabase();
    const sessions = (db.data.seedanceSessions || []).map(s => ({
      ...s,
      sessionId: s.sessionId ? s.sessionId.substring(0, 8) + '***' : '',
    }));
    res.json({ success: true, data: sessions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/seedance-sessions/full — 列出所有 session（含完整 sessionId，仅供微服务内部使用）
router.get('/full', (req, res) => {
  try {
    const db = getDatabase();
    const sessions = db.data.seedanceSessions || [];
    res.json({ success: true, data: sessions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/seedance-sessions — 添加新 session
router.post('/', async (req, res) => {
  try {
    const { sessionId, name } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: '缺少 sessionId' });
    }

    const db = getDatabase();
    if (!db.data.seedanceSessions) {
      db.data.seedanceSessions = [];
    }

    const session = {
      id: uuidv4(),
      sessionId,
      name: name || `账号${db.data.seedanceSessions.length + 1}`,
      status: 'active',
      credits: null,
      lastUsed: 0,
      currentTasks: 0,
      activeTasks: [],
      totalTasks: 0,
      successCount: 0,
      failCount: 0,
      maxConcurrent: 10,
      createdAt: Date.now(),
    };

    db.data.seedanceSessions.push(session);
    await saveDatabase();

    res.json({ success: true, data: session });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/seedance-sessions/reset-insufficient — 批量恢复积分不足的 session 为 active（新一轮生成前调用）
router.post('/reset-insufficient', async (req, res) => {
  try {
    const db = getDatabase();
    const sessions = db.data.seedanceSessions || [];
    let resetCount = 0;
    for (const s of sessions) {
      if (s.status === 'insufficient' || s.status === 'security_check') {
        s.status = 'active';
        resetCount++;
      }
    }
    if (resetCount > 0) await saveDatabase();
    res.json({ success: true, resetCount });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/seedance-sessions/acquire — 原子获取一个可用 session（全局 Round-Robin）
router.post('/acquire', async (req, res) => {
  try {
    const { taskId } = req.body;
    const db = getDatabase();
    const sessions = db.data.seedanceSessions || [];
    const now = Date.now();

    // 先对所有 session 执行超时清理（利用每次 acquire 的时机顺带清理，不等定时器）
    for (const s of sessions) {
      expireActiveTasks(s);
    }

    const available = sessions
      .filter(s => s.status === 'active' && (s.currentTasks || 0) < (s.maxConcurrent || 10))
      .sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));

    if (available.length === 0) {
      return res.status(503).json({ success: false, error: '没有可用的即梦 Session，请在设置中添加' });
    }

    const session = available[0];
    const activeTaskId = taskId || uuidv4();
    if (!session.activeTasks) session.activeTasks = [];
    session.activeTasks.push({ taskId: activeTaskId, acquiredAt: now });
    session.currentTasks = session.activeTasks.length;
    session.lastUsed = now;
    session.totalTasks = (session.totalTasks || 0) + 1;

    await saveDatabase();

    // 返回完整 sessionId 供微服务使用，附带本次分配的 taskId
    res.json({ success: true, data: { ...session, _acquiredTaskId: activeTaskId } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/seedance-sessions/:id/release — 释放 session（任务完成/失败）
router.post('/:id/release', async (req, res) => {
  try {
    const { success: taskSuccess, taskId } = req.body;
    const db = getDatabase();
    const sessions = db.data.seedanceSessions || [];
    const session = sessions.find(s => s.id === req.params.id);

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session 不存在' });
    }

    if (!session.activeTasks) session.activeTasks = [];

    if (taskId) {
      // 精准移除对应 taskId
      session.activeTasks = session.activeTasks.filter(t => t.taskId !== taskId);
    } else {
      // 兜底：移除最旧的一个（向后兼容未传 taskId 的调用方）
      session.activeTasks.shift();
    }
    session.currentTasks = session.activeTasks.length;

    if (taskSuccess) {
      session.successCount = (session.successCount || 0) + 1;
    } else {
      session.failCount = (session.failCount || 0) + 1;
    }

    await saveDatabase();
    res.json({ success: true, data: session });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/seedance-sessions/:id/status — 更新实时状态（status/credits 等）
router.post('/:id/status', async (req, res) => {
  try {
    const db = getDatabase();
    const sessions = db.data.seedanceSessions || [];
    const session = sessions.find(s => s.id === req.params.id);

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session 不存在' });
    }

    const allowedFields = ['status', 'credits'];
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) {
        session[key] = req.body[key];
      }
    }

    await saveDatabase();
    res.json({ success: true, data: session });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/seedance-sessions/:id/reset-tasks — 管理端重置当前任务数（异常恢复）
router.post('/:id/reset-tasks', async (req, res) => {
  try {
    const db = getDatabase();
    const sessions = db.data.seedanceSessions || [];
    const session = sessions.find(s => s.id === req.params.id);

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session 不存在' });
    }

    session.activeTasks = [];
    session.currentTasks = 0;
    await saveDatabase();
    res.json({ success: true, data: session });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /sync — 微服务批量同步（保留兼容，但不再是主链路）
router.put('/sync', async (req, res) => {
  try {
    const { sessions } = req.body;
    if (!Array.isArray(sessions)) {
      return res.status(400).json({ success: false, error: '缺少 sessions 数组' });
    }

    const db = getDatabase();
    if (!db.data.seedanceSessions) {
      db.data.seedanceSessions = [];
    }

    for (const incoming of sessions) {
      const existing = db.data.seedanceSessions.find(s => s.id === incoming.id);
      if (existing) {
        existing.status = incoming.status;
        existing.credits = incoming.credits;
        existing.lastUsed = incoming.lastUsed;
        existing.totalTasks = incoming.totalTasks;
        existing.successCount = incoming.successCount;
        existing.failCount = incoming.failCount;
        existing.maxConcurrent = incoming.maxConcurrent ?? existing.maxConcurrent;
      }
    }

    await saveDatabase();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/seedance-sessions/:id — 更新 session 配置字段
router.put('/:id', async (req, res) => {
  try {
    const db = getDatabase();
    const sessions = db.data.seedanceSessions || [];
    const session = sessions.find(s => s.id === req.params.id);

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session 不存在' });
    }

    const allowedFields = ['sessionId', 'name', 'status', 'maxConcurrent', 'credits', 'lastUsed', 'totalTasks', 'successCount', 'failCount'];
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) {
        session[key] = req.body[key];
      }
    }

    await saveDatabase();
    res.json({ success: true, data: session });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/seedance-sessions/:id — 删除 session
router.delete('/:id', async (req, res) => {
  try {
    const db = getDatabase();
    if (!db.data.seedanceSessions) {
      return res.status(404).json({ success: false, error: 'Session 不存在' });
    }

    const index = db.data.seedanceSessions.findIndex(s => s.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Session 不存在' });
    }

    db.data.seedanceSessions.splice(index, 1);
    await saveDatabase();

    res.json({ success: true, message: 'Session 已删除' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
