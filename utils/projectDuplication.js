import { v4 as uuidv4 } from 'uuid';

function remapIds(ids = [], idMap = new Map()) {
  return ids.map(id => idMap.get(id) ?? id);
}

export function createDuplicatedProject(source, options = {}) {
  const generateId = options.generateId ?? uuidv4;
  const now = options.now ?? Date.now;
  const timestamp = now();
  const duplicatedProjectId = generateId();

  const characterIdMap = new Map();
  const variantIdMap = new Map();
  const sceneIdMap = new Map();

  const duplicatedCharacters = (source.characters ?? []).map(character => {
    const newId = generateId();
    characterIdMap.set(character.id, newId);
    return { ...character, id: newId };
  });

  const duplicatedVariants = (source.variants ?? []).map(variant => {
    const newId = generateId();
    variantIdMap.set(variant.id, newId);
    return {
      ...variant,
      id: newId,
      characterId: characterIdMap.get(variant.characterId) ?? variant.characterId,
    };
  });

  const duplicatedScenes = (source.scenes ?? []).map(scene => {
    const newId = generateId();
    sceneIdMap.set(scene.id, newId);
    return { ...scene, id: newId };
  });

  const duplicatedEpisodes = (source.episodes ?? []).map(episode => ({
    ...episode,
    id: generateId(),
    updatedAt: timestamp,
    isProcessing: false,
    frames: (episode.frames ?? []).map(frame => ({
      ...frame,
      id: generateId(),
      references: (() => {
        const references = {
          ...frame.references,
          characterIds: remapIds(frame.references?.characterIds, characterIdMap),
        };

        if (frame.references?.variantIds) {
          references.variantIds = remapIds(frame.references.variantIds, variantIdMap);
        } else {
          delete references.variantIds;
        }

        if (frame.references?.sceneId) {
          references.sceneId = sceneIdMap.get(frame.references.sceneId) ?? frame.references.sceneId;
        } else {
          delete references.sceneId;
        }

        if (frame.references?.sceneIds) {
          references.sceneIds = remapIds(frame.references.sceneIds, sceneIdMap);
        } else {
          delete references.sceneIds;
        }

        return references;
      })(),
      isGenerating: false,
      isGeneratingVideo: false,
      isGeneratingAudio: false,
      imageProgress: undefined,
      videoProgress: undefined,
      audioProgress: undefined,
      imageError: undefined,
      videoError: undefined,
      audioError: undefined,
    })),
  }));

  return {
    ...source,
    id: duplicatedProjectId,
    name: `${source.name} - 副本`,
    createdAt: timestamp,
    updatedAt: timestamp,
    characters: duplicatedCharacters,
    variants: duplicatedVariants,
    scenes: duplicatedScenes,
    episodes: duplicatedEpisodes,
  };
}
