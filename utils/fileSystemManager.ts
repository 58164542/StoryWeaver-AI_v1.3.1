/**
 * File System Manager
 * 管理文件系统访问，实现自动保存到本地文件
 *
 * 注意：目录句柄存储在全局变量中，每次启动应用时需要重新选择工作文件夹
 * 这样可以实现跨浏览器同步（只要选择同一个文件夹）
 */

// 全局变量声明
declare global {
  interface Window {
    __workDirectoryHandle?: FileSystemDirectoryHandle;
  }
}

async function saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  window.__workDirectoryHandle = handle;
}

async function getDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  return window.__workDirectoryHandle ?? null;
}

/**
 * 检查浏览器是否支持 File System Access API
 */
export function isFileSystemSupported(): boolean {
  return 'showDirectoryPicker' in window;
}

/**
 * 检查浏览器是否支持导出/导入文件选择器
 */
export function isFilePickerSupported(): boolean {
  return 'showSaveFilePicker' in window && 'showOpenFilePicker' in window;
}

/**
 * 请求用户选择工作目录（首次使用）
 */
export async function requestWorkDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!isFileSystemSupported()) {
    throw new Error('当前浏览器不支持文件系统访问API，请使用Chrome、Edge等现代浏览器');
  }

  try {
    const handle = await (window as any).showDirectoryPicker({
      mode: 'readwrite',
      startIn: 'documents'
    });

    // 保存句柄到 IndexedDB
    await saveDirectoryHandle(handle);

    return handle;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error('用户取消了目录选择');
    }
    throw error;
  }
}

/**
 * 获取工作目录句柄（如果已授权）
 */
export async function getWorkDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const handle = await getDirectoryHandle();

    if (!handle) {
      return null;
    }

    // 验证权限是否仍然有效
    const permission = await (handle as any).queryPermission({ mode: 'readwrite' });
    if (permission === 'granted') {
      return handle;
    }

    // 尝试重新请求权限
    const requestPermission = await (handle as any).requestPermission({ mode: 'readwrite' });
    if (requestPermission === 'granted') {
      return handle;
    }

    return null;
  } catch (error) {
    console.error('获取工作目录失败:', error);
    return null;
  }
}

/**
 * 确保工作目录已授权（如果没有则请求）
 */
export async function ensureWorkDirectory(): Promise<FileSystemDirectoryHandle> {
  let handle = await getWorkDirectory();

  if (!handle) {
    handle = await requestWorkDirectory();
  }

  return handle;
}

/**
 * 保存项目到文件
 */
export async function saveProjectToFile(
  projectId: string,
  projectData: any
): Promise<void> {
  try {
    const dirHandle = await ensureWorkDirectory();

    // 创建文件名（使用项目ID）
    const fileName = `${projectId}.swproj`;

    // 获取或创建文件
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });

    // 创建可写流
    const writable = await fileHandle.createWritable();

    // 写入数据
    const jsonData = JSON.stringify(projectData, null, 2);
    await writable.write(jsonData);
    await writable.close();

    console.log(`项目已保存: ${fileName}`);
  } catch (error) {
    console.error('保存项目失败:', error);
    throw error;
  }
}

/**
 * 从文件加载项目
 */
export async function loadProjectFromFile(projectId: string): Promise<any | null> {
  try {
    const dirHandle = await getWorkDirectory();

    if (!dirHandle) {
      return null;
    }

    const fileName = `${projectId}.swproj`;

    try {
      const fileHandle = await dirHandle.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      const text = await file.text();
      return JSON.parse(text);
    } catch (error) {
      // 文件不存在
      return null;
    }
  } catch (error) {
    console.error('加载项目失败:', error);
    return null;
  }
}

/**
 * 列出所有项目文件
 */
export async function listProjectFiles(): Promise<string[]> {
  try {
    const dirHandle = await getWorkDirectory();

    if (!dirHandle) {
      return [];
    }

    const projectIds: string[] = [];

    for await (const entry of (dirHandle as any).values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.swproj')) {
        // 提取项目ID（去掉.swproj后缀）
        const projectId = entry.name.replace('.swproj', '');
        projectIds.push(projectId);
      }
    }

    return projectIds;
  } catch (error) {
    console.error('列出项目文件失败:', error);
    return [];
  }
}

/**
 * 删除项目文件
 */
export async function deleteProjectFile(projectId: string): Promise<void> {
  try {
    const dirHandle = await getWorkDirectory();

    if (!dirHandle) {
      throw new Error('未授权工作目录');
    }

    const fileName = `${projectId}.swproj`;
    await dirHandle.removeEntry(fileName);

    console.log(`项目已删除: ${fileName}`);
  } catch (error) {
    console.error('删除项目失败:', error);
    throw error;
  }
}

/**
 * 导出项目（下载到用户选择的位置）
 */
export async function exportProject(projectData: any, projectName: string): Promise<void> {
  const jsonData = JSON.stringify(projectData, null, 2);
  const fileName = `${projectName}.swproj`;

  // 检查是否支持 File System Access API
  if (isFilePickerSupported()) {
    try {
      // 使用 showSaveFilePicker 让用户选择保存位置
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: fileName,
        types: [{
          description: 'StoryWeaver Project',
          accept: { 'application/json': ['.swproj'] }
        }]
      });

      const writable = await handle.createWritable();
      await writable.write(jsonData);
      await writable.close();

      console.log('项目已导出');
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        console.log('用户取消了导出');
        return;
      }
      console.error('导出项目失败:', error);
      throw error;
    }
  } else {
    // 降级方案：使用传统的 Blob 下载方式
    try {
      const blob = new Blob([jsonData], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      console.log('项目已导出（使用降级方案）');
    } catch (error) {
      console.error('导出项目失败:', error);
      throw error;
    }
  }
}

/**
 * 导入项目（从用户选择的文件）
 */
export async function importProject(): Promise<any | null> {
  // 检查是否支持 File System Access API
  if (isFilePickerSupported()) {
    try {
      const [fileHandle] = await (window as any).showOpenFilePicker({
        types: [{
          description: 'StoryWeaver Project',
          accept: { 'application/json': ['.swproj', '.json'] }
        }],
        multiple: false
      });

      const file = await fileHandle.getFile();
      const text = await file.text();
      const projectData = JSON.parse(text);

      console.log('项目已导入');
      return projectData;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        console.log('用户取消了导入');
        return null;
      }
      console.error('导入项目失败:', error);
      throw error;
    }
  } else {
    // 降级方案：使用传统的 file input 方式
    return new Promise((resolve, reject) => {
      try {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.swproj,.json';

        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (!file) {
            console.log('用户取消了导入');
            resolve(null);
            return;
          }

          try {
            const text = await file.text();
            const projectData = JSON.parse(text);
            console.log('项目已导入（使用降级方案）');
            resolve(projectData);
          } catch (error) {
            console.error('导入项目失败:', error);
            reject(error);
          }
        };

        input.oncancel = () => {
          console.log('用户取消了导入');
          resolve(null);
        };

        input.click();
      } catch (error) {
        console.error('导入项目失败:', error);
        reject(error);
      }
    });
  }
}
