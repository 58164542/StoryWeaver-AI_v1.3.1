import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuplicatedProject } from './projectDuplication.js';

test('createDuplicatedProject duplicates project with fresh ids and remapped references', () => {
  const source = {
    id: 'project-1',
    name: '原项目',
    type: 'COMMENTARY_2D',
    settings: {
      imageModel: 'nano-banana-pro-vt',
      storyboardImageModel: 'nano-banana-pro-vt',
      videoModel: 'doubao-seedance-1-5-pro-251215',
      ttsModel: 'minimax-speech-2.6-hd',
      aspectRatio: '16:9',
      videoDuration: 5,
    },
    createdAt: 100,
    updatedAt: 200,
    thumbnailUrl: '/thumb.jpg',
    characters: [
      {
        id: 'char-1',
        name: '角色A',
        description: 'desc',
        appearance: 'look',
        personality: 'kind',
        role: 'Protagonist',
        imageUrl: '/char.jpg',
      },
    ],
    variants: [
      {
        id: 'variant-1',
        characterId: 'char-1',
        name: '角色A·宫装',
        appearance: 'variant look',
        imageUrl: '/variant.jpg',
      },
    ],
    scenes: [
      {
        id: 'scene-1',
        name: '场景A',
        description: 'scene desc',
        environment: 'env',
        atmosphere: 'warm',
        imageUrl: '/scene.jpg',
      },
    ],
    episodes: [
      {
        id: 'episode-1',
        name: '第1集',
        scriptContent: 'script',
        updatedAt: 300,
        isProcessing: true,
        frames: [
          {
            id: 'frame-1',
            index: 1,
            imagePrompt: 'img prompt',
            videoPrompt: 'video prompt',
            originalText: 'text',
            references: {
              characterIds: ['char-1'],
              variantIds: ['variant-1'],
              sceneIds: ['scene-1'],
            },
            imageUrl: '/frame.jpg',
            isGenerating: true,
            isGeneratingVideo: true,
            isGeneratingAudio: true,
            imageProgress: 50,
            videoProgress: 60,
            audioProgress: 70,
            imageError: 'x',
            videoError: 'y',
            audioError: 'z',
          },
        ],
      },
    ],
  };

  const ids = ['project-2', 'char-2', 'variant-2', 'scene-2', 'episode-2', 'frame-2'];
  const duplicated = createDuplicatedProject(source, {
    generateId: () => ids.shift(),
    now: () => 999,
  });

  assert.equal(duplicated.id, 'project-2');
  assert.equal(duplicated.name, '原项目 - 副本');
  assert.equal(duplicated.createdAt, 999);
  assert.equal(duplicated.updatedAt, 999);

  assert.equal(duplicated.characters[0].id, 'char-2');
  assert.equal(duplicated.variants[0].id, 'variant-2');
  assert.equal(duplicated.variants[0].characterId, 'char-2');
  assert.equal(duplicated.scenes[0].id, 'scene-2');
  assert.equal(duplicated.episodes[0].id, 'episode-2');
  assert.equal(duplicated.episodes[0].updatedAt, 999);
  assert.equal(duplicated.episodes[0].isProcessing, false);
  assert.equal(duplicated.episodes[0].frames[0].id, 'frame-2');
  assert.deepEqual(duplicated.episodes[0].frames[0].references, {
    characterIds: ['char-2'],
    variantIds: ['variant-2'],
    sceneIds: ['scene-2'],
  });
  assert.equal(duplicated.episodes[0].frames[0].isGenerating, false);
  assert.equal(duplicated.episodes[0].frames[0].isGeneratingVideo, false);
  assert.equal(duplicated.episodes[0].frames[0].isGeneratingAudio, false);
  assert.equal(duplicated.episodes[0].frames[0].imageProgress, undefined);
  assert.equal(duplicated.episodes[0].frames[0].videoProgress, undefined);
  assert.equal(duplicated.episodes[0].frames[0].audioProgress, undefined);
  assert.equal(duplicated.episodes[0].frames[0].imageError, undefined);
  assert.equal(duplicated.episodes[0].frames[0].videoError, undefined);
  assert.equal(duplicated.episodes[0].frames[0].audioError, undefined);

  assert.equal(source.id, 'project-1');
  assert.equal(source.characters[0].id, 'char-1');
  assert.equal(source.episodes[0].id, 'episode-1');
  assert.deepEqual(source.episodes[0].frames[0].references, {
    characterIds: ['char-1'],
    variantIds: ['variant-1'],
    sceneIds: ['scene-1'],
  });
});
