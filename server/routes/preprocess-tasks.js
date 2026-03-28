import { Router } from 'express';
import { getPreprocessTaskManager } from '../services/preprocessTaskManager.js';

const router = Router();

router.post('/novel', async (req, res) => {
  try {
    const {
      projectId,
      projectType,
      novelText,
      episodeDrafts,
      systemInstruction,
      segmentPrompt,
      secondPassPrompt,
      enableSecondPass,
    } = req.body || {};

    if (!projectId) {
      return res.status(400).json({ success: false, error: '缺少 projectId' });
    }
    if (!novelText || typeof novelText !== 'string') {
      return res.status(400).json({ success: false, error: '缺少 novelText' });
    }
    if (!Array.isArray(episodeDrafts) || episodeDrafts.length === 0) {
      return res.status(400).json({ success: false, error: '缺少 episodeDrafts' });
    }
    if (!systemInstruction || typeof systemInstruction !== 'string') {
      return res.status(400).json({ success: false, error: '缺少 systemInstruction' });
    }
    if (!segmentPrompt || typeof segmentPrompt !== 'string') {
      return res.status(400).json({ success: false, error: '缺少 segmentPrompt' });
    }

    const taskManager = getPreprocessTaskManager();
    const task = await taskManager.createNovelTask({
      projectId,
      projectType,
      novelText,
      episodeDrafts,
      systemInstruction,
      segmentPrompt,
      secondPassPrompt,
      enableSecondPass,
    });

    res.json({ success: true, data: { taskId: task.id } });
  } catch (error) {
    console.error('创建小说预处理任务失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/episode', async (req, res) => {
  try {
    const {
      projectId,
      episodeId,
      episodeName,
      content,
      segmentPrompt,
      secondPassPrompt,
      enableSecondPass,
    } = req.body || {};

    if (!projectId) {
      return res.status(400).json({ success: false, error: '缺少 projectId' });
    }
    if (!episodeId) {
      return res.status(400).json({ success: false, error: '缺少 episodeId' });
    }
    if (!episodeName || typeof episodeName !== 'string') {
      return res.status(400).json({ success: false, error: '缺少 episodeName' });
    }
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ success: false, error: '缺少 content' });
    }
    if (!segmentPrompt || typeof segmentPrompt !== 'string') {
      return res.status(400).json({ success: false, error: '缺少 segmentPrompt' });
    }

    const taskManager = getPreprocessTaskManager();
    const task = await taskManager.createEpisodeTask({
      projectId,
      episodeId,
      episodeName,
      content,
      segmentPrompt,
      secondPassPrompt,
      enableSecondPass,
    });

    res.json({ success: true, data: { taskId: task.id } });
  } catch (error) {
    console.error('创建单集预处理任务失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/tasks/:taskId', (req, res) => {
  try {
    const taskManager = getPreprocessTaskManager();
    const task = taskManager.getTask(req.params.taskId);
    if (!task) {
      return res.status(404).json({ success: false, error: '任务不存在' });
    }
    res.json({ success: true, data: task });
  } catch (error) {
    console.error('获取预处理任务失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/tasks', (req, res) => {
  try {
    const taskManager = getPreprocessTaskManager();
    const tasks = taskManager.listTasks(req.query.projectId ? String(req.query.projectId) : undefined);
    res.json({ success: true, data: tasks });
  } catch (error) {
    console.error('获取预处理任务列表失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/tasks/:taskId/applied', async (req, res) => {
  try {
    const taskManager = getPreprocessTaskManager();
    const task = await taskManager.markTaskApplied(req.params.taskId);
    res.json({ success: true, data: task });
  } catch (error) {
    console.error('标记预处理任务已应用失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/tasks/:taskId', async (req, res) => {
  try {
    const taskManager = getPreprocessTaskManager();
    await taskManager.deleteTask(req.params.taskId);
    res.json({ success: true, data: { deleted: true } });
  } catch (error) {
    console.error('删除预处理任务失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
