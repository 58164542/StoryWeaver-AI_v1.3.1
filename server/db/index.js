/**
 * LowDB 数据库初始化和管理
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');
const DB_FILE = join(DATA_DIR, 'db.json');
const DEFAULT_PREPROCESS_SEGMENT_PROMPT = readFileSync(join(__dirname, '../../System_Prompt/分段SKILL.md'), 'utf8');

function createDefaultSettings() {
  return {
    extractionModel: 'doubao-seed-2-0-pro-260215',
    projectTypeLabels: {
      'REAL_PERSON_COMMENTARY': '真人解说漫',
      'COMMENTARY_2D': '2D解说漫',
      'COMMENTARY_3D': '3D解说漫',
      'PREMIUM_2D': '2D精品',
      'PREMIUM_3D': '3D精品',
    },
    projectTypePrompts: {
      'REAL_PERSON_COMMENTARY': {
        characterExtraction: '真人解说类视频的角色提取提示词，需包含 name（禁止括号注释）、aliases（脚本中的别名别称列表）、description、role、appearance、personality',
        sceneExtraction: '真人解说类视频的场景提取提示词',
        storyboardBreakdown: '真人解说类视频的分镜拆分提示词',
        preprocessSegmentPrompt: DEFAULT_PREPROCESS_SEGMENT_PROMPT,
      },
      'COMMENTARY_2D': {
        characterExtraction: '2D解说类视频的角色提取提示词，需包含 name（禁止括号注释）、aliases（脚本中的别名别称列表）、description、role、appearance、personality',
        sceneExtraction: '2D解说类视频的场景提取提示词',
        storyboardBreakdown: '2D解说类视频的分镜拆分提示词',
        preprocessSegmentPrompt: DEFAULT_PREPROCESS_SEGMENT_PROMPT,
      },
      'COMMENTARY_3D': {
        characterExtraction: '3D解说类视频的角色提取提示词，需包含 name（禁止括号注释）、aliases（脚本中的别名别称列表）、description、role、appearance、personality',
        sceneExtraction: '3D解说类视频的场景提取提示词',
        storyboardBreakdown: '3D解说类视频的分镜拆分提示词',
        preprocessSegmentPrompt: DEFAULT_PREPROCESS_SEGMENT_PROMPT,
      },
      'PREMIUM_2D': {
        characterExtraction: '2D精品视频的角色提取提示词，需包含 name（禁止括号注释）、aliases（脚本中的别名别称列表）、description、role、appearance、personality',
        sceneExtraction: '2D精品视频的场景提取提示词',
        storyboardBreakdown: '2D精品视频的分镜拆分提示词',
        preprocessSegmentPrompt: DEFAULT_PREPROCESS_SEGMENT_PROMPT,
      },
      'PREMIUM_3D': {
        characterExtraction: '3D精品视频的角色提取提示词，需包含 name（禁止括号注释）、aliases（脚本中的别名别称列表）、description、role、appearance、personality',
        sceneExtraction: '3D精品视频的场景提取提示词',
        storyboardBreakdown: '3D精品视频的分镜拆分提示词',
        preprocessSegmentPrompt: DEFAULT_PREPROCESS_SEGMENT_PROMPT,
      },
    },
  };
}

// 默认数据结构
const DEFAULT_DATA = {
  projects: [],
  recycleBin: [],
  seedanceSessions: [],
  settings: createDefaultSettings(),
};

let db = null;

function ensureProjectId(project) {
  if (!project || typeof project !== 'object') return false;
  if (project.id) return false;

  project.id = project.projectId || project._id || uuidv4();
  return true;
}

function ensureSettingsDefaults(data) {
  let changed = false;
  const defaultSettings = createDefaultSettings();

  if (!data.settings || typeof data.settings !== 'object') {
    data.settings = defaultSettings;
    return true;
  }

  if (!data.settings.extractionModel) {
    data.settings.extractionModel = defaultSettings.extractionModel;
    changed = true;
  }

  if (!data.settings.projectTypeLabels || typeof data.settings.projectTypeLabels !== 'object') {
    data.settings.projectTypeLabels = { ...defaultSettings.projectTypeLabels };
    changed = true;
  }

  for (const [projectType, defaultLabel] of Object.entries(defaultSettings.projectTypeLabels)) {
    if (!data.settings.projectTypeLabels[projectType]) {
      data.settings.projectTypeLabels[projectType] = defaultLabel;
      changed = true;
    }
  }

  if (!data.settings.projectTypePrompts || typeof data.settings.projectTypePrompts !== 'object') {
    data.settings.projectTypePrompts = defaultSettings.projectTypePrompts;
    return true;
  }

  for (const [projectType, defaultPrompts] of Object.entries(defaultSettings.projectTypePrompts)) {
    const currentPrompts = data.settings.projectTypePrompts[projectType];

    if (!currentPrompts || typeof currentPrompts !== 'object') {
      data.settings.projectTypePrompts[projectType] = { ...defaultPrompts };
      changed = true;
      continue;
    }

    const mergedPrompts = { ...defaultPrompts, ...currentPrompts };
    const hasMissingField = Object.keys(defaultPrompts).some((key) => currentPrompts[key] === undefined);
    if (hasMissingField) {
      data.settings.projectTypePrompts[projectType] = mergedPrompts;
      changed = true;
    }
  }

  return changed;
}

/**
 * 初始化数据库
 */
export async function initDatabase() {
  try {
    // 确保 data 目录存在
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(join(DATA_DIR, 'media'), { recursive: true });
    await fs.mkdir(join(DATA_DIR, 'media', 'images'), { recursive: true });
    await fs.mkdir(join(DATA_DIR, 'media', 'videos'), { recursive: true });
    await fs.mkdir(join(DATA_DIR, 'media', 'audio'), { recursive: true });

    // 初始化 LowDB
    const adapter = new JSONFile(DB_FILE);
    db = new Low(adapter, DEFAULT_DATA);

    // 读取数据（如果文件不存在，使用默认数据）
    await db.read();

    // 如果文件为空或不存在，写入默认数据
    if (!db.data || !db.data.projects) {
      db.data = DEFAULT_DATA;
      await db.write();
      console.log('✅ 数据库初始化完成，使用默认数据');
    } else {
      let changed = false;

      if (!db.data.recycleBin) {
        db.data.recycleBin = [];
        changed = true;
      }

      if (!db.data.seedanceSessions) {
        db.data.seedanceSessions = [];
        changed = true;
      }

      for (const session of db.data.seedanceSessions) {
        if (session.maxConcurrent == null || session.maxConcurrent === 2 || session.maxConcurrent === 5) {
          session.maxConcurrent = 10;
          changed = true;
        }
        if (!session.activeTasks) {
          session.activeTasks = [];
          session.currentTasks = 0;
          changed = true;
        }
      }

      changed = ensureSettingsDefaults(db.data) || changed;

      for (const project of db.data.projects) {
        changed = ensureProjectId(project) || changed;
      }

      for (const project of db.data.recycleBin) {
        changed = ensureProjectId(project) || changed;
      }

      if (changed) {
        await db.write();
        console.log('✅ 已自动补齐旧项目缺失字段');
      }

      console.log('✅ 数据库加载成功');
    }

    return db;
  } catch (error) {
    console.error('❌ 数据库初始化失败:', error);
    throw error;
  }
}

/**
 * 获取数据库实例
 */
export function getDatabase() {
  if (!db) {
    throw new Error('数据库未初始化，请先调用 initDatabase()');
  }
  return db;
}

/**
 * 保存数据到文件
 */
export async function saveDatabase() {
  if (!db) {
    throw new Error('数据库未初始化');
  }
  await db.write();
}
