export function buildEpisodeFromPreprocessResult(episode, preprocessResult) {
  return {
    ...episode,
    scriptContent: preprocessResult?.content ?? episode.scriptContent,
    preprocessSegmentFailed: Boolean(preprocessResult?.failed),
  };
}

export function getFailedPreprocessEpisodes(episodes) {
  return (episodes ?? []).filter(episode => episode.preprocessSegmentFailed);
}
