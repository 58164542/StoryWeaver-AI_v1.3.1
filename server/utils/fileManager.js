/**
 * 媒体文件管理工具
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = join(__dirname, '../../data/media');

/**
 * 检测 Base64 数据的 MIME 类型
 */
function getMimeType(base64String) {
  const matches = base64String.match(/^data:([^;]+);base64,/);
  return matches ? matches[1] : null;
}

/**
 * 根据 MIME 类型获取媒体类型
 */
function getMediaType(mimeType) {
  if (!mimeType) return 'images';
  if (mimeType.startsWith('image/')) return 'images';
  if (mimeType.startsWith('video/')) return 'videos';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'images';
}

/**
 * 根据 MIME 类型获取文件扩展名
 */
function getFileExtension(mimeType) {
  if (!mimeType) return '.png';
  const extensionMap = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg'
  };
  return extensionMap[mimeType] || '.bin';
}

/**
 * 保存 Base64 媒体文件
 * @param {string} base64Data - Base64 编码的数据（包含 data:image/png;base64, 前缀）
 * @param {string} filename - 文件名（不含扩展名）
 * @returns {Promise<string>} - 返回完整的文件名（含扩展名）
 */
export async function saveMediaFile(base64Data, filename) {
  try {
    // 检测 MIME 类型
    const mimeType = getMimeType(base64Data);
    const mediaType = getMediaType(mimeType);
    const extension = getFileExtension(mimeType);

    // 确保文件名有正确的扩展名
    const fullFilename = filename.includes('.') ? filename : `${filename}${extension}`;

    // 移除 Base64 前缀
    const base64Content = base64Data.replace(/^data:[^;]+;base64,/, '');

    // 转换为 Buffer
    const buffer = Buffer.from(base64Content, 'base64');

    // 确保目录存在
    const targetDir = join(MEDIA_DIR, mediaType);
    await fs.mkdir(targetDir, { recursive: true });

    // 写入文件
    const filePath = join(targetDir, fullFilename);
    await fs.writeFile(filePath, buffer);

    console.log(`✅ 媒体文件已保存: ${mediaType}/${fullFilename}`);
    return fullFilename;
  } catch (error) {
    console.error('❌ 保存媒体文件失败:', error);
    throw error;
  }
}

/**
 * 删除媒体文件
 * @param {string} type - 媒体类型 (images/videos/audio)
 * @param {string} filename - 文件名
 */
export async function deleteMediaFile(type, filename) {
  try {
    const filePath = join(MEDIA_DIR, type, filename);
    await fs.unlink(filePath);
    console.log(`✅ 媒体文件已删除: ${type}/${filename}`);
  } catch (error) {
    // 忽略文件不存在的错误
    if (error.code !== 'ENOENT') {
      console.error('❌ 删除媒体文件失败:', error);
      throw error;
    }
  }
}

/**
 * 从 URL 提取文件名
 */
export function extractFilenameFromUrl(url) {
  if (!url) return null;
  const match = url.match(/\/(images|videos|audio)\/([^?]+)/);
  return match ? { type: match[1], filename: match[2] } : null;
}

/**
 * 删除项目关联的所有媒体文件
 * @param {object} project - 项目对象
 */
export async function deleteProjectMedia(project) {
  const filesToDelete = [];

  // 收集项目缩略图
  if (project.thumbnailUrl) {
    const file = extractFilenameFromUrl(project.thumbnailUrl);
    if (file) filesToDelete.push(file);
  }

  // 收集角色图片
  if (project.characters) {
    project.characters.forEach(char => {
      if (char.imageUrl) {
        const file = extractFilenameFromUrl(char.imageUrl);
        if (file) filesToDelete.push(file);
      }
    });
  }

  // 收集场景图片
  if (project.scenes) {
    project.scenes.forEach(scene => {
      if (scene.imageUrl) {
        const file = extractFilenameFromUrl(scene.imageUrl);
        if (file) filesToDelete.push(file);
      }
    });
  }

  // 收集剧集中的分镜媒体
  if (project.episodes) {
    project.episodes.forEach(episode => {
      if (episode.frames) {
        episode.frames.forEach(frame => {
          if (frame.imageUrl) {
            const file = extractFilenameFromUrl(frame.imageUrl);
            if (file) filesToDelete.push(file);
          }
          if (frame.videoUrl) {
            const file = extractFilenameFromUrl(frame.videoUrl);
            if (file) filesToDelete.push(file);
          }
          if (frame.audioUrl) {
            const file = extractFilenameFromUrl(frame.audioUrl);
            if (file) filesToDelete.push(file);
          }
        });
      }
    });
  }

  // 批量删除
  await Promise.all(
    filesToDelete.map(file => deleteMediaFile(file.type, file.filename))
  );

  console.log(`✅ 已删除项目 ${project.id} 的 ${filesToDelete.length} 个媒体文件`);
}

/**
 * 获取媒体文件完整路径
 */
export function getMediaPath(type, filename) {
  return join(MEDIA_DIR, type, filename);
}
