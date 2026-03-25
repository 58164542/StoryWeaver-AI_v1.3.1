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

test('project type prompts include preprocess segment prompt and preprocess uses settings instead of API fetch', async () => {
  const [typesSource, appSource, dbSource, apiServiceSource] = await Promise.all([
    readProjectFile('types.ts'),
    readProjectFile('App.tsx'),
    readProjectFile('server/db/index.js'),
    readProjectFile('services/apiService.ts'),
  ]);

  assert.match(typesSource, /preprocessSegmentPrompt:\s*string;/, 'ProjectTypeInstruction 应新增 preprocessSegmentPrompt 字段');
  assert.match(appSource, /updatePrompt\('preprocessSegmentPrompt', e\.target\.value\)/, '全局设置面板应支持编辑 preprocessSegmentPrompt');
  assert.match(appSource, /preprocessSegmentPrompt/, '小说预处理相关代码应引用 preprocessSegmentPrompt');
  // getSegmentSkillPrompt 现在读取 settings.projectTypePrompts[type].preprocessSegmentPrompt，不再调旧文件接口
  assert.match(apiServiceSource, /prompts\.preprocessSegmentPrompt/, 'apiService.getSegmentSkillPrompt 应从 settings.projectTypePrompts 读取而非旧文件接口');
  assert.doesNotMatch(apiServiceSource, /\/api\/system-prompts\/segment-skill/, 'getSegmentSkillPrompt 不应再调旧文件接口');
  assert.match(dbSource, /preprocessSegmentPrompt:/, 'LowDB 默认 settings 应补齐 preprocessSegmentPrompt');
});

test('bltcy Claude provider uses correct proxy architecture', async () => {
  const claudeServiceSource = await readProjectFile('services/claudeService.ts');

  // 应通过后端代理调用，URL 包含 /api/claude/proxy
  assert.match(claudeServiceSource, /\/api\/claude\/proxy/, '应通过后端代理 /api/claude/proxy 调用');

  // bltcy 作为 provider 类型应存在
  assert.match(claudeServiceSource, /bltcy/, '应支持 bltcy provider');

  // HTML 防御函数必须存在
  assert.match(claudeServiceSource, /assertNotHtmlResponse/, '应有 HTML 响应防御函数');
});

test('custom project type labels are preserved during settings init and db defaults', async () => {
  const [appSource, dbSource] = await Promise.all([
    readProjectFile('App.tsx'),
    readProjectFile('server/db/index.js'),
  ]);

  assert.match(appSource, /projectTypeLabels:\s*loadedSettings\.projectTypeLabels\s*\|\|\s*\{\s*\.\.\.DEFAULT_GLOBAL_SETTINGS\.projectTypeLabels\s*\}/, '应用初始化迁移应保留后端返回的 projectTypeLabels');
  assert.match(dbSource, /projectTypeLabels:\s*\{[\s\S]*REAL_PERSON_COMMENTARY[\s\S]*PREMIUM_3D[\s\S]*\}/, 'LowDB 默认 settings 应包含 projectTypeLabels');
  assert.match(dbSource, /if\s*\(!data\.settings\.projectTypeLabels\s*\|\|\s*typeof data\.settings\.projectTypeLabels\s*!==\s*'object'\)/, '旧数据库迁移应补齐缺失的 projectTypeLabels');
});

test('Claude connectivity check exists and is called before preprocessing', async () => {
  const [claudeSource, appSource] = await Promise.all([
    readProjectFile('services/claudeService.ts'),
    readProjectFile('App.tsx'),
  ]);

  // claudeService 应导出连通性检查函数
  assert.match(claudeSource, /export\s+(async\s+)?function\s+checkClaudeConnectivity/, 'claudeService 应导出 checkClaudeConnectivity 函数');
  // 函数应接受 provider 参数并返回 { ok, error? }
  assert.match(claudeSource, /AbortController/, 'checkClaudeConnectivity 应使用 AbortController 做超时控制');

  // 整本预处理入口应调用连通性检查
  assert.match(appSource, /checkClaudeConnectivity/, 'App.tsx 应调用 checkClaudeConnectivity');
});

