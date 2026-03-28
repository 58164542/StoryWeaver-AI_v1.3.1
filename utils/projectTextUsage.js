export function buildProjectTextUsagePayload({ provider, projectId, taskType, operationId, sourceId, result }) {
  if (!provider || !projectId || !taskType || !operationId || !sourceId) {
    return null;
  }

  const usage = result?.usage;
  const model = result?.model;
  if (!usage || !model) {
    return null;
  }

  return {
    provider,
    model,
    taskType,
    idempotencyKey: `${projectId}:${taskType}:${sourceId}:${operationId}`,
    usage,
  };
}
