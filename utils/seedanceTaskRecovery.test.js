import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(currentDir, '..');

async function readProjectFile(relativePath) {
  return readFile(path.join(rootDir, relativePath), 'utf8');
}

test('seedance service exposes submit and poll helpers for task recovery', async () => {
  const serviceSource = await readProjectFile('services/jimengSeedanceService.ts');

  assert.match(serviceSource, /export\s+const\s+submitJimengSeedanceImageToVideoTask\s*=\s*async/, '应导出单图提交 helper');
  assert.match(serviceSource, /export\s+const\s+submitJimengSeedanceMultiRefTask\s*=\s*async/, '应导出多参考提交 helper');
  assert.match(serviceSource, /export\s+const\s+pollJimengSeedanceTask\s*=\s*async/, '应导出轮询 helper');
});

test('App persists seedance waiting and loading state for recovery', async () => {
  const appSource = await readProjectFile('App.tsx');

  assert.match(appSource, /seedanceTaskId:\s*undefined,\s*seedanceTaskUpdatedAt:\s*Date\.now\(\)/, 'waiting 状态应清空 taskId 并记录更新时间');
  assert.match(appSource, /seedanceTaskId:\s*taskId,\s*seedanceTaskUpdatedAt:\s*Date\.now\(\)/, 'loading 状态应保存 taskId 并记录更新时间');
  assert.match(appSource, /frame\.videoTaskStatus === 'waiting' && !frame\.seedanceTaskId/, '刷新后应自动重建 waiting 队列');
  assert.match(appSource, /frame\.videoTaskStatus === 'loading' && frame\.seedanceTaskId/, '刷新后应恢复 loading 轮询');
});

test('App refetches recovered seedance video through atomic frame save path', async () => {
  const appSource = await readProjectFile('App.tsx');

  assert.match(appSource, /if \(!videoUrl\.startsWith\('\/api\/media\/'\)\) \{[\s\S]*?saveExternalVideo\(/, '重新获取结果时应先转存外部视频');
  assert.match(appSource, /videoUrl = apiService\.toAbsoluteApiUrl\(videoUrl\)/, '重新获取结果时应标准化视频 URL');
  assert.match(appSource, /await commitFrameVideoSuccess\(currentProject\.id, currentEpisode\.id, frameId, videoUrl(?:, [^)]*)?\)/, '重新获取结果时应走原子 frame 视频保存接口');
});

test('App marks refetched seedance task as loading before polling again', async () => {
  const appSource = await readProjectFile('App.tsx');

  assert.match(appSource, /persistFrameVideoState\(currentProject\.id, currentEpisode\.id, frameId, frame => \(\{[\s\S]*?isGeneratingVideo:\s*true,[\s\S]*?videoTaskStatus:\s*'loading',[\s\S]*?videoError:\s*undefined,[\s\S]*?seedanceTaskUpdatedAt:\s*Date\.now\(\)/, '重新获取结果前应先写入 loading 状态');
});

test('ret=4010 marks session as security_check, rotates to next account, and refreshes browser context', async () => {
  const [seedanceSource, typesSource, sessionsRouteSource, browserSource] = await Promise.all([
    readProjectFile('server/seedance/index.js'),
    readProjectFile('types.ts'),
    readProjectFile('server/routes/seedance-sessions.js'),
    readProjectFile('server/seedance/browser-service.js'),
  ]);

  // SeedanceSession status 类型应包含 security_check
  assert.match(typesSource, /security_check/, 'SeedanceSession.status 应包含 security_check');

  // generateWithAutoRetry 应把 4010 当作可轮换错误
  assert.match(seedanceSource, /4010/, 'seedance index.js 应处理 ret=4010');
  assert.match(seedanceSource, /security_check/, 'seedance index.js 应标记 session 为 security_check');
  // 4010 时应关闭浏览器上下文（强制下次重建指纹）——在 isSecurityCheck 分支中调用
  assert.match(seedanceSource, /isSecurityCheck/, '应有 isSecurityCheck 变量检测 4010');
  assert.match(seedanceSource, /browserService\.closeSession/, '4010 时应调用 browserService.closeSession 重建指纹');

  // session 重置逻辑应处理 security_check
  assert.match(sessionsRouteSource, /security_check/, 'seedance-sessions 路由应处理 security_check 状态');

  // browser-service 应导出 closeSession 方法
  assert.match(browserSource, /closeSession/, 'browser-service 应有 closeSession 方法');
});

test('ret=1310 and ret=4010 wait and retry instead of terminating', async () => {
  const seedanceSource = await readProjectFile('server/seedance/index.js');

  // 1310/4010 所有账号用尽时应等待而非直接 throw
  assert.match(seedanceSource, /isPeakBusy\s*\|\|\s*isSecurityCheck/, '1310 和 4010 应共享等待重试逻辑');
  assert.match(seedanceSource, /等待其他账号可用后将自动重试/, '应更新 task.progress 为等待状态');
  assert.match(seedanceSource, /triedSessionIds\.clear\(\)/, '等待后应清空 triedSessionIds 重新轮换');

  // 积分不足仍应立即失败
  assert.match(seedanceSource, /isInsufficient/, '应区分积分不足场景');
  assert.match(seedanceSource, /积分不足：立即失败，无需排队等待/, '积分不足时应立即 throw 不等待');
});
