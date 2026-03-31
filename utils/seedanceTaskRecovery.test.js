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
  assert.match(appSource, /await commitFrameVideoSuccess\(currentProject\.id, currentEpisode\.id, frameId, videoUrl, frame\.videoDuration, frame\.seedanceTaskId \? `jimeng:\$\{frame\.seedanceTaskId\}` : undefined\)/, '重新获取结果时应带同一任务 key 走原子 frame 视频保存接口');
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

test('1310 cooldown is scoped to affected sessions instead of globally blocking all sessions', async () => {
  const [seedanceSource, sessionManagerSource, sessionsRouteSource] = await Promise.all([
    readProjectFile('server/seedance/index.js'),
    readProjectFile('server/seedance/session-manager.js'),
    readProjectFile('server/routes/seedance-sessions.js'),
  ]);

  assert.match(seedanceSource, /const\s+sessionCooldowns\s*=\s*new Map\(/, '微服务应维护按 session 的冷却表');
  assert.match(seedanceSource, /markSessionCooldown\(/, '1310\/4010 后应标记当前 session 冷却');
  assert.match(seedanceSource, /excludeSessionIds:\s*cooldownSessionIds/, '等待重试时应排除处于冷却中的 session');
  assert.doesNotMatch(seedanceSource, /peakCooldown/, '不应再使用全局 peakCooldown 阻塞全部账号');
  assert.match(sessionManagerSource, /acquireSession\(taskId, excludeSessionIds = \[\]\)/, 'session manager acquire 应支持排除指定 session');
  assert.match(sessionsRouteSource, /excludeSessionIds/, '中心后端 acquire 路由应支持排除指定 session');
});

test('seedance active task API exposes startTime for frontend task reconciliation', async () => {
  const [seedanceSource, serviceSource] = await Promise.all([
    readProjectFile('server/seedance/index.js'),
    readProjectFile('services/jimengSeedanceService.ts'),
  ]);

  assert.match(seedanceSource, /startTime:\s*task\.startTime/, '后端 /api/tasks 应返回 startTime');
  assert.match(serviceSource, /startTime:\s*number/, '前端 ActiveTask 类型应包含 startTime');
});

test('App groups active tasks by frame before rendering task bar', async () => {
  const appSource = await readProjectFile('App.tsx');

  assert.match(appSource, /const\s+activeFrameTasks\s*=\s*useMemo\(/, '应新增按分镜归并的 activeFrameTasks');
  assert.match(appSource, /const\s+frameKey\s*=\s*`\$\{task\.projectId\}:\$\{task\.episodeId\}:\$\{task\.frameId\}`/, '应按 project\/episode\/frame 归并 task');
  assert.match(appSource, /Array\.from\(activeFrameTasks\.values\(\)\)\.map\(/, '任务栏应渲染归并后的分镜任务而不是原始 activeTasks');
});

test('seedance service supports cancelling all active tasks for a frame', async () => {
  const [seedanceSource, appSource] = await Promise.all([
    readProjectFile('server/seedance/index.js'),
    readProjectFile('App.tsx'),
  ]);

  assert.match(seedanceSource, /app\.delete\('\/api\/tasks\/by-frame'/, '后端应提供按分镜批量取消接口');
  assert.match(seedanceSource, /cancelledTaskIds/, '按分镜取消接口应返回被取消的 task 列表');
  assert.match(appSource, /\/api\/tasks\/by-frame/, '前端取消分镜任务时应调用按分镜批量取消接口');
});

test('frame waiting\/loading UI prioritizes active backend tasks over stale local flags', async () => {
  const appSource = await readProjectFile('App.tsx');

  assert.match(appSource, /const\s+getFrameActiveTask\s*=\s*useCallback\(/, '应提供按 frame 查询后端活跃任务的 helper');
  assert.match(appSource, /backendTask\?\.status\s*===\s*'processing'\s*\?\s*'loading'/, '分镜展示应优先使用后端 processing 状态');
  assert.match(appSource, /backendTask\?\.status\s*===\s*'waiting'\s*\?\s*'waiting'/, '分镜展示应优先使用后端 waiting 状态');
});

test('seedance recovery is driven by backend active tasks including waiting tasks', async () => {
  const appSource = await readProjectFile('App.tsx');

  assert.match(appSource, /activeFrameTasks/, '恢复逻辑应依赖后端 activeTasks 归并结果');
  assert.match(appSource, /backendTask\.status\s*===\s*'waiting'/, '后端 waiting 任务应参与恢复');
  assert.match(appSource, /backendTask\.status\s*===\s*'processing'/, '后端 processing 任务应参与恢复');
  assert.match(appSource, /videoTaskStatus:\s*undefined/, '当后端不存在活跃任务时应清理本地残留状态');
});

test('App maps seedance error 2038, 2039 and 2043 to user-friendly copy', async () => {
  const appSource = await readProjectFile('App.tsx');
  const seedanceSource = await readProjectFile('server/seedance/index.js');

  assert.match(seedanceSource, /failCode === 2038/, '后端应识别 2038 错误码');
  assert.match(appSource, /输入的文字不符合平台规则/, '前端应把 2038 映射为用户可理解文案');
  assert.match(appSource, /输入的图片不符合平台规则/, '前端应把 2039 映射为用户可理解文案');
  assert.match(appSource, /视频生成结果未通过审核/, '前端应把 2043 映射为用户可理解文案');
});
