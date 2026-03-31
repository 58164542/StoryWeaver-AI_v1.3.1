/**
 * SessionManager — 中心后端客户端模式
 * 所有 Session 配置和实时状态以中心后端为唯一真源
 * 微服务只通过 API 调用中心后端进行 acquire/release/status 操作
 */

function getMainBackendUrl() {
  return process.env.MAIN_BACKEND_URL || 'http://localhost:3001';
}

class SessionManager {
  constructor() {
    /** @type {Map<string, object>} 轻量本地缓存，仅用于展示，不参与分配决策 */
    this.sessionsCache = new Map();
  }

  /**
   * 从中心后端拉取 session 列表（含完整 sessionId）
   */
  async fetchFromBackend() {
    try {
      const response = await fetch(`${getMainBackendUrl()}/api/seedance-sessions/full`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      const sessions = result.data || result;
      if (Array.isArray(sessions)) {
        this.sessionsCache.clear();
        for (const s of sessions) {
          this.sessionsCache.set(s.id, s);
        }
        console.log(`[session-manager] 从中心后端加载了 ${sessions.length} 个 session`);
      }
    } catch (err) {
      console.warn('[session-manager] 从中心后端拉取 session 失败:', err.message);
    }
  }

  /**
   * 返回所有 session（sessionId 脱敏，用于展示）
   */
  getSessions() {
    return Array.from(this.sessionsCache.values()).map(s => ({
      ...s,
      sessionId: s.sessionId ? s.sessionId.substring(0, 8) + '***' : '',
    }));
  }

  /**
   * 从中心后端原子获取一个可用 session
   * @param {string} [taskId] 微服务侧的任务ID，用于精准追踪并发占用
   * @returns {Promise<object|null>} 包含完整 sessionId 的 session 对象
   */
  async acquireSession(taskId, excludeSessionIds = []) {
    try {
      const response = await fetch(`${getMainBackendUrl()}/api/seedance-sessions/acquire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, excludeSessionIds }),
      });

      if (response.status === 503) {
        return null; // 没有可用 session
      }

      if (!response.ok) {
        throw new Error(`acquire 失败: HTTP ${response.status}`);
      }

      const result = await response.json();
      const session = result.data;

      // 更新本地缓存
      if (session) {
        this.sessionsCache.set(session.id, session);
      }

      return session;
    } catch (err) {
      console.error('[session-manager] acquireSession 失败:', err.message);
      return null;
    }
  }

  /**
   * 通知中心后端释放 session
   * @param {string} id session 的内部 UUID
   * @param {boolean} success 任务是否成功
   * @param {string} [taskId] 对应的微服务任务ID，用于精准移除并发占用
   */
  async releaseSession(id, success, taskId) {
    try {
      const response = await fetch(`${getMainBackendUrl()}/api/seedance-sessions/${id}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success, taskId }),
      });

      if (!response.ok) {
        console.warn(`[session-manager] releaseSession 失败: HTTP ${response.status}`);
      }

      // 刷新本地缓存
      await this.fetchFromBackend();
    } catch (err) {
      console.error('[session-manager] releaseSession 失败:', err.message);
    }
  }

  /**
   * 通知中心后端更新 session 状态
   */
  async markSessionStatus(id, status) {
    try {
      const cached = this.sessionsCache.get(id);
      console.log(`[session-manager] Session "${cached?.name || id}" 状态变更: ${status}`);

      const response = await fetch(`${getMainBackendUrl()}/api/seedance-sessions/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });

      if (!response.ok) {
        console.warn(`[session-manager] markSessionStatus 失败: HTTP ${response.status}`);
      }

      // 更新本地缓存
      if (cached) {
        cached.status = status;
      }
    } catch (err) {
      console.error('[session-manager] markSessionStatus 失败:', err.message);
    }
  }

  /**
   * 查询指定 session 的积分余量
   */
  async queryCredits(id, jimengRequestFn) {
    const cached = this.sessionsCache.get(id);
    if (!cached) throw new Error('Session 不存在');

    try {
      const result = await jimengRequestFn(
        'post',
        '/mweb/v1/get_credit_balance',
        cached.sessionId,
        { data: {} }
      );

      const credits = result?.credit_balance ?? result?.balance ?? null;

      // 更新中心后端
      if (credits !== null) {
        await fetch(`${getMainBackendUrl()}/api/seedance-sessions/${id}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credits }),
        });
        cached.credits = credits;
      }

      return { credits: cached.credits, raw: result };
    } catch (err) {
      if (err.message?.includes('ret=') && !err.message?.includes('ret=0')) {
        if (err.message.includes('5000')) {
          await this.markSessionStatus(id, 'insufficient');
        } else {
          await this.markSessionStatus(id, 'expired');
        }
      }
      throw err;
    }
  }

  /**
   * 添加新 session（通过中心后端）
   */
  async addSession(sessionId, name) {
    try {
      const response = await fetch(`${getMainBackendUrl()}/api/seedance-sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, name }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      const session = result.data;

      if (session) {
        this.sessionsCache.set(session.id, session);
      }

      return session;
    } catch (err) {
      console.error('[session-manager] addSession 失败:', err.message);
      throw err;
    }
  }

  /**
   * 删除 session（通过中心后端）
   */
  async removeSession(id) {
    try {
      const response = await fetch(`${getMainBackendUrl()}/api/seedance-sessions/${id}`, {
        method: 'DELETE',
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.sessionsCache.delete(id);
      return true;
    } catch (err) {
      console.error('[session-manager] removeSession 失败:', err.message);
      return false;
    }
  }

  /**
   * 更新 session 字段（通过中心后端）
   */
  async updateSession(id, updates) {
    try {
      const response = await fetch(`${getMainBackendUrl()}/api/seedance-sessions/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      const session = result.data;

      if (session) {
        this.sessionsCache.set(session.id, session);
      }

      return session;
    } catch (err) {
      console.error('[session-manager] updateSession 失败:', err.message);
      return null;
    }
  }

  // 兼容：不再需要 syncToBackend / loadSessions，保留空方法避免调用报错
  async syncToBackend() {}
  loadSessions() {}
}

export default SessionManager;
