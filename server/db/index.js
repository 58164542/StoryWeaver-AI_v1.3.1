/**
 * LowDB 数据库初始化和管理
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import fs from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');
const DB_FILE = join(DATA_DIR, 'db.json');

// 默认数据结构
const DEFAULT_DATA = {
  projects: [],
  recycleBin: [],
  settings: {
    extractionModel: 'doubao-seed-1-8-251228',
    projectTypePrompts: {
      'REAL_PERSON_COMMENTARY': {
        characterExtraction: '真人解说类视频的角色提取提示词，需包含 name（禁止括号注释）、aliases（脚本中的别名别称列表）、description、role、appearance、personality',
        sceneExtraction: '真人解说类视频的场景提取提示词',
        storyboardBreakdown: '真人解说类视频的分镜拆分提示词'
      },
      'COMMENTARY_2D': {
        characterExtraction: '2D解说类视频的角色提取提示词，需包含 name（禁止括号注释）、aliases（脚本中的别名别称列表）、description、role、appearance、personality',
        sceneExtraction: '2D解说类视频的场景提取提示词',
        storyboardBreakdown: '2D解说类视频的分镜拆分提示词'
      },
      'COMMENTARY_3D': {
        characterExtraction: '3D解说类视频的角色提取提示词，需包含 name（禁止括号注释）、aliases（脚本中的别名别称列表）、description、role、appearance、personality',
        sceneExtraction: '3D解说类视频的场景提取提示词',
        storyboardBreakdown: '3D解说类视频的分镜拆分提示词'
      },
      'PREMIUM_2D': {
        characterExtraction: '2D精品视频的角色提取提示词，需包含 name（禁止括号注释）、aliases（脚本中的别名别称列表）、description、role、appearance、personality',
        sceneExtraction: '2D精品视频的场景提取提示词',
        storyboardBreakdown: '2D精品视频的分镜拆分提示词'
      },
      'PREMIUM_3D': {
        characterExtraction: '3D精品视频的角色提取提示词，需包含 name（禁止括号注释）、aliases（脚本中的别名别称列表）、description、role、appearance、personality',
        sceneExtraction: '3D精品视频的场景提取提示词',
        storyboardBreakdown: '3D精品视频的分镜拆分提示词'
      }
    }
  }
};

let db = null;

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
      if (!db.data.recycleBin) {
        db.data.recycleBin = [];
        await db.write();
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
