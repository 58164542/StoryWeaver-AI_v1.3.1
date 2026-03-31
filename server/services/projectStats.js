const STATS_COVERAGE = ['claude', 'seedance'];
const PHASE2_TEXT_PROVIDERS = ['gemini', 'volcengine'];
const MAX_TEXT_USAGE_KEYS = 500;
const MAX_SEEDANCE_SUCCESS_TASK_KEYS = 5000;

function createTokenBucket() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requestCount: 0,
  };
}

function normalizeUsage(usage) {
  const inputTokens = Number(
    usage?.inputTokens
    ?? usage?.input_tokens
    ?? usage?.prompt_tokens
    ?? usage?.promptTokenCount
    ?? 0
  ) || 0;
  const outputTokens = Number(
    usage?.outputTokens
    ?? usage?.output_tokens
    ?? usage?.completion_tokens
    ?? usage?.candidatesTokenCount
    ?? 0
  ) || 0;
  const explicitTotal = Number(
    usage?.totalTokens
    ?? usage?.total_tokens
    ?? usage?.totalTokenCount
    ?? 0
  ) || 0;

  return {
    inputTokens,
    outputTokens,
    totalTokens: explicitTotal || (inputTokens + outputTokens),
  };
}

function applyUsage(bucket, usage) {
  bucket.inputTokens += usage.inputTokens;
  bucket.outputTokens += usage.outputTokens;
  bucket.totalTokens += usage.totalTokens;
  bucket.requestCount += 1;
}

function trimDedupeKeys(keys, maxSize) {
  if (keys.length <= maxSize) return;
  keys.splice(0, keys.length - maxSize);
}

export function createDefaultProjectStats(now = Date.now()) {
  return {
    textUsage: {
      totals: createTokenBucket(),
      providers: {},
    },
    videoGeneration: {
      seedanceSuccessCount: 0,
    },
    implementationProgress: {
      phase: 'phase1',
      coverage: [...STATS_COVERAGE],
      statsActivatedAt: now,
      lastUpdatedAt: now,
    },
    dedupe: {
      textUsageKeys: [],
      seedanceSuccessTaskKeys: [],
    },
  };
}

export function ensureProjectStats(project, now = Date.now()) {
  let changed = false;

  if (!project.stats || typeof project.stats !== 'object') {
    project.stats = createDefaultProjectStats(now);
    return true;
  }

  if (!project.stats.textUsage || typeof project.stats.textUsage !== 'object') {
    project.stats.textUsage = { totals: createTokenBucket(), providers: {} };
    changed = true;
  }

  if (!project.stats.textUsage.totals || typeof project.stats.textUsage.totals !== 'object') {
    project.stats.textUsage.totals = createTokenBucket();
    changed = true;
  }

  if (!project.stats.textUsage.providers || typeof project.stats.textUsage.providers !== 'object') {
    project.stats.textUsage.providers = {};
    changed = true;
  }

  if (!project.stats.videoGeneration || typeof project.stats.videoGeneration !== 'object') {
    project.stats.videoGeneration = { seedanceSuccessCount: 0 };
    changed = true;
  }

  if (typeof project.stats.videoGeneration.seedanceSuccessCount !== 'number') {
    project.stats.videoGeneration.seedanceSuccessCount = 0;
    changed = true;
  }

  if (!project.stats.implementationProgress || typeof project.stats.implementationProgress !== 'object') {
    project.stats.implementationProgress = {
      phase: 'phase1',
      coverage: [...STATS_COVERAGE],
      statsActivatedAt: now,
      lastUpdatedAt: now,
    };
    changed = true;
  }

  if (!Array.isArray(project.stats.implementationProgress.coverage)) {
    project.stats.implementationProgress.coverage = [...STATS_COVERAGE];
    changed = true;
  }

  if (!project.stats.implementationProgress.phase) {
    project.stats.implementationProgress.phase = 'phase1';
    changed = true;
  }

  if (typeof project.stats.implementationProgress.statsActivatedAt !== 'number') {
    project.stats.implementationProgress.statsActivatedAt = now;
    changed = true;
  }

  if (typeof project.stats.implementationProgress.lastUpdatedAt !== 'number') {
    project.stats.implementationProgress.lastUpdatedAt = now;
    changed = true;
  }

  if (!project.stats.dedupe || typeof project.stats.dedupe !== 'object') {
    project.stats.dedupe = {
      textUsageKeys: [],
      seedanceSuccessTaskKeys: [],
    };
    changed = true;
  }

  if (!Array.isArray(project.stats.dedupe.textUsageKeys)) {
    project.stats.dedupe.textUsageKeys = [];
    changed = true;
  }

  if (!Array.isArray(project.stats.dedupe.seedanceSuccessTaskKeys)) {
    project.stats.dedupe.seedanceSuccessTaskKeys = [];
    changed = true;
  }

  return changed;
}

export function recordProjectTextUsage(project, payload) {
  ensureProjectStats(project, payload.now);

  const { provider, model, taskType, idempotencyKey, now = Date.now() } = payload;
  if (!provider || !model || !taskType || !idempotencyKey) return false;

  const dedupeKeys = project.stats.dedupe.textUsageKeys;
  if (dedupeKeys.includes(idempotencyKey)) {
    return false;
  }

  const normalizedUsage = normalizeUsage(payload.usage);
  const providerBucket = project.stats.textUsage.providers[provider] || {
    totals: createTokenBucket(),
    models: {},
  };
  const modelBucket = providerBucket.models[model] || {
    totals: createTokenBucket(),
    taskTypes: {},
  };
  const taskBucket = modelBucket.taskTypes[taskType] || createTokenBucket();

  applyUsage(project.stats.textUsage.totals, normalizedUsage);
  applyUsage(providerBucket.totals, normalizedUsage);
  applyUsage(modelBucket.totals, normalizedUsage);
  applyUsage(taskBucket, normalizedUsage);

  modelBucket.taskTypes[taskType] = taskBucket;
  providerBucket.models[model] = modelBucket;
  project.stats.textUsage.providers[provider] = providerBucket;

  dedupeKeys.push(idempotencyKey);
  trimDedupeKeys(dedupeKeys, MAX_TEXT_USAGE_KEYS);

  const coverage = project.stats.implementationProgress.coverage;
  if (PHASE2_TEXT_PROVIDERS.includes(provider) && !coverage.includes(provider)) {
    coverage.push(provider);
    project.stats.implementationProgress.phase = 'phase2';
  }

  project.stats.implementationProgress.lastUpdatedAt = now;
  return true;
}

export function recordProjectSeedanceVideoSuccess(project, payload) {
  ensureProjectStats(project, payload.now);

  const successTaskKey = payload.successTaskKey;
  if (!successTaskKey) return false;

  const dedupeKeys = project.stats.dedupe.seedanceSuccessTaskKeys;
  if (dedupeKeys.includes(successTaskKey)) {
    return false;
  }

  dedupeKeys.push(successTaskKey);
  trimDedupeKeys(dedupeKeys, MAX_SEEDANCE_SUCCESS_TASK_KEYS);
  project.stats.videoGeneration.seedanceSuccessCount += 1;
  project.stats.implementationProgress.lastUpdatedAt = payload.now || Date.now();
  return true;
}

export function applyProjectFrameVideoSuccess(project, payload) {
  ensureProjectStats(project, payload.now);

  const episode = Array.isArray(project.episodes)
    ? project.episodes.find(item => item.id === payload.episodeId)
    : null;
  if (!episode) {
    throw new Error('分集不存在');
  }

  const frame = Array.isArray(episode.frames)
    ? episode.frames.find(item => item.id === payload.frameId)
    : null;
  if (!frame) {
    throw new Error('分镜不存在');
  }

  const hadVideo = Boolean(frame.videoUrl);
  frame.videoUrl = payload.videoUrl;
  frame.isGeneratingVideo = false;
  frame.videoProgress = undefined;
  frame.videoError = undefined;
  frame.seedanceTaskUpdatedAt = payload.now || Date.now();
  if (payload.videoDuration !== undefined) {
    frame.videoDuration = payload.videoDuration;
  }

  let recorded = false;
  if (payload.successTaskKey) {
    recorded = recordProjectSeedanceVideoSuccess(project, payload);
  }

  return { recorded, frame };
}
