import { chromium } from 'playwright-core';

const SESSION_IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const BDMS_READY_TIMEOUT = 30000; // 30 seconds
const PAGE_GOTO_TIMEOUT = 60000; // 60 seconds (即梦首页在弱网下加载较慢)
const PAGE_GOTO_MAX_RETRIES = 2; // 导航失败最多重试次数

const BLOCKED_RESOURCE_TYPES = ['image', 'font', 'stylesheet', 'media'];
// 方法1: 扩展白名单，覆盖字节跳动全系安全指纹 SDK 域名
// 方法2: script 类型全部放行，确保 bdms/byted_acrawler 安全令牌能正常加载
// 两者同时启用以彻底解决 ret=4010 安全确认问题
const SCRIPT_WHITELIST_DOMAINS = [
  'vlabstatic.com',
  'bytescm.com',
  'jianying.com',
  'byteimg.com',
  // 方法1 新增：字节跳动 CDN / 安全指纹相关域名
  'bytetos.com',       // bdms 安全 SDK 主要 CDN
  'bytedance.com',
  'toutiao.com',
  'snssdk.com',
  'pstatp.com',
  'ixigua.com',
  'zjcdn.com',
  'bdstatic.com',
  'douyinpic.com',
  'douyinstatic.com',
];

class BrowserService {
  constructor() {
    this.browser = null;
    this.sessions = new Map();
  }

  async ensureBrowser() {
    if (this.browser) return this.browser;

    console.log('[browser] 正在启动 Chromium...');
    const isWindows = process.platform === 'win32';
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
    ];
    if (!isWindows) {
      args.push('--no-zygote', '--single-process');
    }
    this.browser = await chromium.launch({
      headless: true,
      args,
    });
    console.log('[browser] Chromium 已启动');
    return this.browser;
  }

  /**
   * 返回当前所有已缓存的 sessionId（原始 cookie 值）列表
   */
  getActiveSessions() {
    return Array.from(this.sessions.keys());
  }

  async getSession(sessionId, webId, userId) {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      // 检查浏览器上下文是否仍然健康（page 未关闭/崩溃）
      try {
        if (existing.page.isClosed()) {
          console.warn(`[browser] 会话 ${sessionId.substring(0, 8)}... 的 page 已关闭，重建上下文`);
          await this.closeSession(sessionId);
        } else {
          existing.lastUsed = Date.now();
          if (existing.idleTimer) {
            clearTimeout(existing.idleTimer);
          }
          existing.idleTimer = setTimeout(
            () => this.closeSession(sessionId),
            SESSION_IDLE_TIMEOUT
          );
          return existing;
        }
      } catch {
        console.warn(`[browser] 会话 ${sessionId.substring(0, 8)}... 状态异常，重建上下文`);
        await this.closeSession(sessionId);
      }
    }

    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    });

    // Inject cookies
    const cookies = [
      { name: '_tea_web_id', value: String(webId), domain: '.jianying.com', path: '/' },
      { name: 'is_staff_user', value: 'false', domain: '.jianying.com', path: '/' },
      { name: 'store-region', value: 'cn-gd', domain: '.jianying.com', path: '/' },
      { name: 'uid_tt', value: String(userId), domain: '.jianying.com', path: '/' },
      { name: 'sid_tt', value: sessionId, domain: '.jianying.com', path: '/' },
      { name: 'sessionid', value: sessionId, domain: '.jianying.com', path: '/' },
      { name: 'sessionid_ss', value: sessionId, domain: '.jianying.com', path: '/' },
    ];
    await context.addCookies(cookies);

    // Block non-essential resources
    await context.route('**/*', (route) => {
      const request = route.request();
      const resourceType = request.resourceType();
      const url = request.url();

      if (BLOCKED_RESOURCE_TYPES.includes(resourceType)) {
        return route.abort();
      }

      if (resourceType === 'script') {
        // 方法2: 放行所有 script，确保 bdms/byted_acrawler 安全令牌可完整加载
        // 即梦 ret=4010 安全验证依赖这些脚本生成合法指纹，不能随意屏蔽
        const isWhitelisted = SCRIPT_WHITELIST_DOMAINS.some((domain) =>
          url.includes(domain)
        );
        if (!isWhitelisted) return route.continue(); // 改为放行而非 abort
      }

      return route.continue();
    });

    const page = await context.newPage();

    console.log(`[browser] 正在导航到 jimeng.jianying.com (session: ${sessionId.substring(0, 8)}...)`);
    for (let attempt = 0; attempt <= PAGE_GOTO_MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[browser] 导航重试 (第${attempt}次)...`);
        }
        await page.goto('https://jimeng.jianying.com', {
          waitUntil: 'domcontentloaded',
          timeout: PAGE_GOTO_TIMEOUT,
        });
        break; // 成功则跳出重试
      } catch (navErr) {
        if (attempt === PAGE_GOTO_MAX_RETRIES) {
          // 最终失败：清理上下文后抛出
          try { await context.close(); } catch { /* ignore */ }
          this.sessions.delete(sessionId);
          throw new Error(`即梦页面导航失败（已重试${PAGE_GOTO_MAX_RETRIES}次，超时${PAGE_GOTO_TIMEOUT / 1000}秒）: ${navErr.message}`);
        }
        console.warn(`[browser] 导航超时 (第${attempt + 1}次): ${navErr.message}，即将重试...`);
        // 重试前刷新 page
        try { await page.reload({ waitUntil: 'commit', timeout: 10000 }); } catch { /* ignore */ }
      }
    }

    // Wait for bdms SDK to load
    try {
      await page.waitForFunction(
        () => {
          return (
            window.bdms?.init ||
            window.byted_acrawler ||
            window.fetch.toString().indexOf('native code') === -1
          );
        },
        { timeout: BDMS_READY_TIMEOUT }
      );
      console.log('[browser] bdms SDK 已就绪');
    } catch {
      console.warn('[browser] bdms SDK 等待超时，继续尝试...');
    }

    const session = {
      context,
      page,
      lastUsed: Date.now(),
      idleTimer: setTimeout(
        () => this.closeSession(sessionId),
        SESSION_IDLE_TIMEOUT
      ),
    };

    this.sessions.set(sessionId, session);
    console.log(`[browser] 会话已创建 (session: ${sessionId.substring(0, 8)}...)`);
    return session;
  }

  async closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }

    try {
      await session.context.close();
    } catch {
      // ignore
    }

    this.sessions.delete(sessionId);
    console.log(`[browser] 会话已关闭 (session: ${sessionId.substring(0, 8)}...)`);
  }

  async fetch(sessionId, webId, userId, url, options = {}) {
    const session = await this.getSession(sessionId, webId, userId);
    const { method = 'GET', headers = {}, body } = options;

    console.log(`[browser] 通过浏览器代理请求: ${method} ${url.substring(0, 80)}...`);

    const result = await session.page.evaluate(
      async ({ url, method, headers, body }) => {
        const resp = await fetch(url, {
          method,
          headers,
          body: body || undefined,
          credentials: 'include',
        });
        return resp.json();
      },
      { url, method, headers, body }
    );

    return result;
  }

  async close() {
    for (const [sessionId] of this.sessions) {
      await this.closeSession(sessionId);
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // ignore
      }
      this.browser = null;
      console.log('[browser] Chromium 已关闭');
    }
  }
}

const browserService = new BrowserService();
export default browserService;
