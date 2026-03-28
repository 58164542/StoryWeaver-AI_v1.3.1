const DEFAULT_PHASE = 'phase1';
const DEFAULT_COVERAGE = ['claude', 'seedance'];
const DISPLAY_TIME_OFFSET_MS = -2 * 60 * 60 * 1000;

const PHASE_LABELS = {
  phase1: '一期',
  phase2: '二期',
  phase3: '三期',
};

const COVERAGE_LABELS = {
  claude: 'Claude 文本任务',
  seedance: 'Seedance 成功视频',
  gemini: 'Gemini 文本任务',
  volcengine: 'Volcengine 文本任务',
};

const pad = (value) => String(value).padStart(2, '0');

const formatDateTime = (value) => {
  if (!value) {
    return null;
  }

  const date = new Date(value + DISPLAY_TIME_OFFSET_MS);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
};

export function buildProjectStatsSummary(project) {
  const stats = project?.stats;
  const totals = stats?.textUsage?.totals;
  const implementationProgress = stats?.implementationProgress;
  const coverage = Array.isArray(implementationProgress?.coverage) && implementationProgress.coverage.length > 0
    ? implementationProgress.coverage
    : DEFAULT_COVERAGE;
  const phase = implementationProgress?.phase || DEFAULT_PHASE;

  return {
    totalTokens: totals?.totalTokens ?? 0,
    requestCount: totals?.requestCount ?? 0,
    seedanceSuccessCount: stats?.videoGeneration?.seedanceSuccessCount ?? 0,
    phaseLabel: PHASE_LABELS[phase] || phase || PHASE_LABELS[DEFAULT_PHASE],
    coverageText: coverage.map((item) => COVERAGE_LABELS[item] || item).join('、'),
    activatedAtText: formatDateTime(implementationProgress?.statsActivatedAt) || '未启用',
    lastUpdatedAtText: formatDateTime(implementationProgress?.lastUpdatedAt) || '未更新',
  };
}
