import React, { useState, useEffect, useCallback, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { 
  Project, Episode, ViewMode, ProjectTab, Character, Scene, StoryboardFrame, ProjectType, ProjectSettings, GlobalSettings 
} from './types';
import { Layout } from './components/Layout';
import { analyzeNovelScript, generateStoryboardBreakdown, generateImageAsset, generateVideoFromImage, generateSpeech } from './services/geminiService';
import { Loader2, Plus, Trash2, Save, Wand2, Image as ImageIcon, Play, Pause, SkipBack, SkipForward, Download, Users, Film, ArrowLeft, FileText, Clock, Settings, X, Link, Edit2, Check, LayoutGrid, Clapperboard, ChevronRight, ChevronLeft, Globe, Copy, CheckSquare, Square, GripVertical, MoreHorizontal, Volume2, Mic } from 'lucide-react';

// Default Settings
const DEFAULT_SETTINGS: ProjectSettings = {
  imageModel: 'gemini-2.5-flash-image',
  videoModel: 'veo-3.1-fast-generate-preview',
  ttsModel: 'gemini-2.5-flash-preview-tts',
  aspectRatio: '16:9',
  imageStyle: 'Cinematic, highly detailed, dramatic lighting, 4k'
};

const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  extractionModel: 'gemini-3-flash-preview',
  projectTypePrompts: {
    'NOVEL_VISUALIZATION': '你是一位专业的分镜师和剧本分析师。专门针对视觉改编分析小说文本。',
    'SHORT_VIDEO': '你是一位短视频内容创作者。分析剧本时请关注节奏、互动性和传播潜力。',
    'COMIC': '你是一位漫画编剧。请关注视觉分镜、拟声词文本和戏剧性姿势。',
    'OTHER': '分析文本中的视觉元素。'
  }
};

const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
    'NOVEL_VISUALIZATION': '小说可视化',
    'SHORT_VIDEO': '短视频',
    'COMIC': '漫画',
    'OTHER': '其他'
};

// --- Helper Components ---

interface FrameEditorModalProps {
  frame: StoryboardFrame;
  project: Project;
  onSave: (frameId: string, updates: Partial<StoryboardFrame>) => void;
  onClose: () => void;
}

const FrameEditorModal: React.FC<FrameEditorModalProps> = ({ frame, project, onSave, onClose }) => {
  const [prompt, setPrompt] = useState(frame.prompt);
  const [selectedCharIds, setSelectedCharIds] = useState<string[]>(frame.references.characterIds);
  const [selectedSceneId, setSelectedSceneId] = useState<string | undefined>(frame.references.sceneId);

  const toggleCharacter = (charId: string) => {
    setSelectedCharIds(prev => 
      prev.includes(charId) ? prev.filter(id => id !== charId) : [...prev, charId]
    );
  };

  const handleSave = () => {
    onSave(frame.id, {
      prompt,
      references: {
        characterIds: selectedCharIds,
        sceneId: selectedSceneId
      }
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <div className="bg-gray-800 rounded-2xl w-full max-w-2xl border border-gray-700 shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-5 border-b border-gray-700 flex justify-between items-center bg-gray-850 rounded-t-2xl">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Edit2 size={18} className="text-blue-500"/> 编辑分镜 #{frame.index + 1}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X size={24} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto custom-scrollbar space-y-6">
          
          {/* Prompt Section */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-300 uppercase tracking-wider">画面提示词</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full h-32 bg-gray-900 border border-gray-600 rounded-lg p-4 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all leading-relaxed"
              placeholder="描述画面内容..."
            />
            <p className="text-xs text-gray-500">编辑提示词以优化AI生成结果。这将覆盖自动生成的描述。</p>
          </div>

          <div className="w-full h-px bg-gray-700" />

          {/* Asset References Section */}
          <div>
            <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider mb-4 flex items-center gap-2">
              <Link size={14}/> 参考资产
            </h3>
            
            {/* Characters */}
            <div className="mb-6">
              <label className="block text-xs font-medium text-gray-500 mb-2">角色 (选择以包含)</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {project.characters.map(char => {
                  const isSelected = selectedCharIds.includes(char.id);
                  return (
                    <button
                      key={char.id}
                      onClick={() => toggleCharacter(char.id)}
                      className={`flex items-center gap-2 p-2 rounded-lg border transition-all text-left group ${
                        isSelected 
                        ? 'bg-blue-900/30 border-blue-500/50 ring-1 ring-blue-500/50' 
                        : 'bg-gray-900 border-gray-700 hover:border-gray-500'
                      }`}
                    >
                      <div className={`w-8 h-8 rounded bg-gray-800 overflow-hidden shrink-0 ${!char.imageUrl && 'flex items-center justify-center text-[10px]'}`}>
                        {char.imageUrl ? <img src={char.imageUrl} className="w-full h-full object-cover"/> : '?'}
                      </div>
                      <span className={`text-sm truncate flex-1 ${isSelected ? 'text-blue-200' : 'text-gray-400'}`}>
                        {char.name}
                      </span>
                      {isSelected && <Check size={14} className="text-blue-400" />}
                    </button>
                  );
                })}
                {project.characters.length === 0 && <p className="text-xs text-gray-500 col-span-3">项目资产中未找到角色。</p>}
              </div>
            </div>

            {/* Scenes */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-2">场景 (选择一个)</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <button
                  onClick={() => setSelectedSceneId(undefined)}
                  className={`flex items-center justify-center gap-2 p-2 rounded-lg border border-dashed transition-all text-sm ${
                    selectedSceneId === undefined
                    ? 'bg-gray-700 border-gray-500 text-white' 
                    : 'bg-gray-900 border-gray-700 text-gray-500 hover:border-gray-500'
                  }`}
                >
                  无场景参考
                </button>
                {project.scenes.map(scene => {
                  const isSelected = selectedSceneId === scene.id;
                  return (
                    <button
                      key={scene.id}
                      onClick={() => setSelectedSceneId(scene.id)}
                      className={`flex items-center gap-2 p-2 rounded-lg border transition-all text-left ${
                        isSelected 
                        ? 'bg-green-900/30 border-green-500/50 ring-1 ring-green-500/50' 
                        : 'bg-gray-900 border-gray-700 hover:border-gray-500'
                      }`}
                    >
                      <div className={`w-8 h-8 rounded bg-gray-800 overflow-hidden shrink-0 ${!scene.imageUrl && 'flex items-center justify-center text-[10px]'}`}>
                        {scene.imageUrl ? <img src={scene.imageUrl} className="w-full h-full object-cover"/> : '?'}
                      </div>
                      <span className={`text-sm truncate flex-1 ${isSelected ? 'text-green-200' : 'text-gray-400'}`}>
                        {scene.name}
                      </span>
                      {isSelected && <Check size={14} className="text-green-400" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-gray-700 bg-gray-850 rounded-b-2xl flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 rounded-lg text-gray-300 hover:bg-gray-700 font-medium transition-colors">
            取消
          </button>
          <button onClick={handleSave} className="px-6 py-2.5 bg-blue-600 rounded-lg text-white hover:bg-blue-500 font-medium shadow-lg shadow-blue-900/20 flex items-center gap-2 transition-all">
            <Save size={18} /> 保存修改
          </button>
        </div>
      </div>
    </div>
  );
};

interface AssetEditorModalProps {
  asset: Character | Scene;
  type: 'character' | 'scene';
  onSave: (id: string, updates: Partial<Character> | Partial<Scene>) => void;
  onClose: () => void;
}

const AssetEditorModal: React.FC<AssetEditorModalProps> = ({ asset, type, onSave, onClose }) => {
  const [formData, setFormData] = useState<any>(asset);

  const handleSave = () => {
    onSave(asset.id, formData);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <div className="bg-gray-800 rounded-2xl w-full max-w-lg border border-gray-700 shadow-2xl flex flex-col">
        <div className="p-5 border-b border-gray-700 flex justify-between items-center bg-gray-850 rounded-t-2xl">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Edit2 size={18} className="text-blue-500"/> 编辑{type === 'character' ? '角色' : '场景'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors"><X size={24} /></button>
        </div>
        <div className="p-6 overflow-y-auto space-y-4">
           <div>
             <label className="block text-sm font-medium text-gray-400 mb-1">名称</label>
             <input 
               className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white" 
               value={formData.name}
               onChange={e => setFormData({...formData, name: e.target.value})}
             />
           </div>
           
           <div>
             <label className="block text-sm font-medium text-gray-400 mb-1">描述</label>
             <textarea 
               className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white h-24" 
               value={formData.description}
               onChange={e => setFormData({...formData, description: e.target.value})}
             />
           </div>

           {type === 'character' && (
             <>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">角色定位</label>
                  <select
                    className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white"
                    value={(formData as Character).role}
                    onChange={e => setFormData({...formData, role: e.target.value})}
                  >
                    <option value="Protagonist">主角 (Protagonist)</option>
                    <option value="Antagonist">反派 (Antagonist)</option>
                    <option value="Supporting">配角 (Supporting)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">外貌特征</label>
                  <textarea 
                    className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white h-20" 
                    value={(formData as Character).appearance}
                    onChange={e => setFormData({...formData, appearance: e.target.value})}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">性格特点</label>
                  <textarea 
                    className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white h-20" 
                    value={(formData as Character).personality}
                    onChange={e => setFormData({...formData, personality: e.target.value})}
                  />
                </div>
             </>
           )}

           {type === 'scene' && (
             <>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">环境细节</label>
                  <textarea 
                    className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white h-20" 
                    value={(formData as Scene).environment}
                    onChange={e => setFormData({...formData, environment: e.target.value})}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">氛围</label>
                  <textarea 
                    className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white h-20" 
                    value={(formData as Scene).atmosphere}
                    onChange={e => setFormData({...formData, atmosphere: e.target.value})}
                  />
                </div>
             </>
           )}
        </div>
        <div className="p-5 border-t border-gray-700 bg-gray-850 rounded-b-2xl flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded text-gray-300 hover:bg-gray-700">取消</button>
          <button onClick={handleSave} className="px-4 py-2 bg-blue-600 rounded text-white hover:bg-blue-500">保存</button>
        </div>
      </div>
    </div>
  );
};

const ProjectSettingsForm: React.FC<{
    initialData: ProjectSettings, 
    onSave: (s: ProjectSettings) => void,
    onCancel: () => void
  }> = ({ initialData, onSave, onCancel }) => {
    const [formData, setFormData] = useState(initialData);

    return (
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-400 mb-1">图像模型</label>
          <select 
            value={formData.imageModel} 
            onChange={e => setFormData({...formData, imageModel: e.target.value})}
            className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-white"
          >
            <option value="gemini-2.5-flash-image">Gemini 2.5 Flash Image</option>
            <option value="gemini-3-pro-image-preview">Gemini 3 Pro Image (高质量)</option>
          </select>
        </div>
        
        <div>
          <label className="block text-sm font-medium text-gray-400 mb-1">视频模型</label>
          <select 
            value={formData.videoModel} 
            onChange={e => setFormData({...formData, videoModel: e.target.value})}
            className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-white"
          >
            <option value="veo-3.1-fast-generate-preview">Veo 3.1 Fast</option>
            <option value="veo-3.1-generate-preview">Veo 3.1 High Quality</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-400 mb-1">语音模型 (TTS)</label>
          <select 
            value={formData.ttsModel} 
            onChange={e => setFormData({...formData, ttsModel: e.target.value})}
            className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-white"
          >
            <option value="gemini-2.5-flash-preview-tts">Gemini 2.5 Flash TTS</option>
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">宽高比</label>
            <select 
              value={formData.aspectRatio} 
              onChange={e => setFormData({...formData, aspectRatio: e.target.value as any})}
              className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-white"
            >
              <option value="16:9">16:9 (横屏视频)</option>
              <option value="9:16">9:16 (竖屏)</option>
              <option value="1:1">1:1 (方形)</option>
              <option value="4:3">4:3</option>
              <option value="3:4">3:4</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-400 mb-1">全局艺术风格提示词</label>
          <textarea 
            value={formData.imageStyle} 
            onChange={e => setFormData({...formData, imageStyle: e.target.value})}
            className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-white h-20 text-sm"
            placeholder="例如：赛博朋克, 霓虹灯光, 黑暗氛围..."
          />
          <p className="text-xs text-gray-500 mt-1">此提示词将附加到所有图像生成请求中。</p>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onCancel} className="px-4 py-2 rounded text-gray-300 hover:bg-gray-700">取消</button>
          <button onClick={() => onSave(formData)} className="px-4 py-2 bg-blue-600 rounded text-white hover:bg-blue-500">保存设置</button>
        </div>
      </div>
    );
  };

const GlobalSettingsModal: React.FC<{
  settings: GlobalSettings,
  onSave: (s: GlobalSettings) => void,
  onClose: () => void
}> = ({ settings, onSave, onClose }) => {
  const [localSettings, setLocalSettings] = useState(settings);
  const [activeTab, setActiveTab] = useState<ProjectType>('NOVEL_VISUALIZATION');

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <div className="bg-gray-800 rounded-2xl w-full max-w-2xl border border-gray-700 shadow-2xl flex flex-col max-h-[90vh]">
        <div className="p-5 border-b border-gray-700 flex justify-between items-center bg-gray-850 rounded-t-2xl">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Globe size={18} className="text-green-500"/> 全局设置
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto custom-scrollbar space-y-8">
          {/* Model Selection */}
          <section>
            <h3 className="text-md font-bold text-white mb-3">分镜提取模型</h3>
            <p className="text-sm text-gray-400 mb-3">选择用于分析剧本和生成分镜细分的LLM。</p>
            <select
              value={localSettings.extractionModel}
              onChange={(e) => setLocalSettings({...localSettings, extractionModel: e.target.value})}
              className="w-full bg-gray-900 border border-gray-600 rounded p-3 text-white focus:border-green-500 focus:outline-none"
            >
              <option value="gemini-3-flash-preview">Gemini 3 Flash (推荐 - 快速)</option>
              <option value="gemini-3-pro-preview">Gemini 3 Pro (高推理 - 较慢)</option>
              <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
            </select>
          </section>

          <div className="w-full h-px bg-gray-700"></div>

          {/* System Instructions */}
          <section>
             <h3 className="text-md font-bold text-white mb-3">项目类型指令</h3>
             <p className="text-sm text-gray-400 mb-4">自定义每种项目类型使用的系统指令（提示词前缀）。</p>
             
             {/* Tabs */}
             <div className="flex gap-2 overflow-x-auto pb-2 mb-2 custom-scrollbar">
                {(Object.keys(localSettings.projectTypePrompts) as ProjectType[]).map(type => (
                   <button
                     key={type}
                     onClick={() => setActiveTab(type)}
                     className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-colors border ${
                        activeTab === type 
                        ? 'bg-green-600 text-white border-green-500' 
                        : 'bg-gray-700 text-gray-400 border-transparent hover:text-gray-200'
                     }`}
                   >
                      {PROJECT_TYPE_LABELS[type]}
                   </button>
                ))}
             </div>
             
             <textarea
               value={localSettings.projectTypePrompts[activeTab]}
               onChange={(e) => setLocalSettings({
                 ...localSettings, 
                 projectTypePrompts: {
                    ...localSettings.projectTypePrompts,
                    [activeTab]: e.target.value
                 }
               })}
               className="w-full h-40 bg-gray-900 border border-gray-600 rounded-lg p-4 text-white placeholder-gray-600 focus:border-green-500 focus:outline-none leading-relaxed text-sm"
               placeholder={`输入 ${PROJECT_TYPE_LABELS[activeTab]} 的系统指令...`}
             />
             <p className="text-xs text-gray-500 mt-2">此文本将作为前缀添加到发送给 Gemini 的分析提示词中。</p>
          </section>
        </div>

        <div className="p-5 border-t border-gray-700 bg-gray-850 rounded-b-2xl flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 rounded-lg text-gray-300 hover:bg-gray-700 font-medium transition-colors">
            取消
          </button>
          <button onClick={() => { onSave(localSettings); onClose(); }} className="px-6 py-2.5 bg-green-600 rounded-lg text-white hover:bg-green-500 font-medium shadow-lg shadow-green-900/20 flex items-center gap-2 transition-all">
            <Save size={18} /> 保存设置
          </button>
        </div>
      </div>
    </div>
  );
};


const App: React.FC = () => {
  // --- State ---
  const [viewMode, setViewMode] = useState<ViewMode>(ViewMode.PROJECT_LIST);
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [currentEpisodeId, setCurrentEpisodeId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>(ProjectTab.SCRIPT);
  const [isProcessing, setIsProcessing] = useState(false);

  // Global Settings State
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings>(DEFAULT_GLOBAL_SETTINGS);
  const [showGlobalSettingsModal, setShowGlobalSettingsModal] = useState(false);

  // Storyboard View State
  const [storyboardViewMode, setStoryboardViewMode] = useState<'GRID' | 'TIMELINE'>('GRID');
  const [currentPlaybackIndex, setCurrentPlaybackIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const [selectedFrameIds, setSelectedFrameIds] = useState<string[]>([]); // Batch selection
  const [draggedFrameIndex, setDraggedFrameIndex] = useState<number | null>(null); // For Drag & Drop

  // Asset Management State
  const [selectedCharacterIds, setSelectedCharacterIds] = useState<string[]>([]);
  const [selectedSceneIds, setSelectedSceneIds] = useState<string[]>([]);
  const [editingAsset, setEditingAsset] = useState<{type: 'character' | 'scene', id: string} | null>(null);

  // Modal State
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [editingFrameId, setEditingFrameId] = useState<string | null>(null); // For FrameEditorModal

  const [newProjectData, setNewProjectData] = useState<{name: string, type: ProjectType, settings: ProjectSettings}>({
    name: '',
    type: 'NOVEL_VISUALIZATION',
    settings: { ...DEFAULT_SETTINGS }
  });
  
  // Computed
  const currentProject = projects.find(p => p.id === currentProjectId);
  const currentEpisode = currentProject?.episodes.find(e => e.id === currentEpisodeId);
  const editingFrame = currentEpisode?.frames.find(f => f.id === editingFrameId);

  // --- Effects ---
  useEffect(() => {
    // Load projects from local storage on mount (Mock persistence)
    const savedProjects = localStorage.getItem('sw_projects');
    if (savedProjects) {
      try {
        setProjects(JSON.parse(savedProjects));
      } catch (e) {
        console.error("Failed to load projects", e);
      }
    }

    // Load Global Settings
    const savedGlobalSettings = localStorage.getItem('sw_global_settings');
    if (savedGlobalSettings) {
        try {
            setGlobalSettings(JSON.parse(savedGlobalSettings));
        } catch (e) {
            console.error("Failed to load global settings", e);
        }
    }
  }, []);

  useEffect(() => {
    // Save projects on change
    if (projects.length > 0) {
      localStorage.setItem('sw_projects', JSON.stringify(projects));
    }
  }, [projects]);

  useEffect(() => {
      // Save global settings
      localStorage.setItem('sw_global_settings', JSON.stringify(globalSettings));
  }, [globalSettings]);

  // Reset selection when changing tabs or episodes
  useEffect(() => {
    setSelectedFrameIds([]);
    setSelectedCharacterIds([]);
    setSelectedSceneIds([]);
  }, [activeTab, currentEpisodeId]);

  // Playback Logic
  useEffect(() => {
    if (!isPlaying || !currentEpisode) return;

    const frame = currentEpisode.frames[currentPlaybackIndex];
    if (!frame) {
      setIsPlaying(false);
      return;
    }

    // Scroll to current frame in timeline
    if (timelineScrollRef.current) {
        const frameEl = timelineScrollRef.current.children[currentPlaybackIndex] as HTMLElement;
        if (frameEl) {
            frameEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
    }

    // If no video, auto advance after 4 seconds
    // If video exists, we rely on onEnded handler in the video element
    if (!frame.videoUrl) {
      const timer = setTimeout(() => {
        if (currentPlaybackIndex < currentEpisode.frames.length - 1) {
          setCurrentPlaybackIndex(prev => prev + 1);
        } else {
          setIsPlaying(false); // End of list
          setCurrentPlaybackIndex(0); // Reset to start
        }
      }, 4000); // 4 seconds per slide for images
      return () => clearTimeout(timer);
    }
  }, [isPlaying, currentPlaybackIndex, currentEpisode]);

  // --- Handlers ---

  const handleVideoEnded = () => {
    if (currentEpisode && currentPlaybackIndex < currentEpisode.frames.length - 1) {
      setCurrentPlaybackIndex(prev => prev + 1);
    } else {
      setIsPlaying(false);
      setCurrentPlaybackIndex(0);
    }
  };

  const openCreateModal = () => {
    setNewProjectData({
      name: '',
      type: 'NOVEL_VISUALIZATION',
      settings: { ...DEFAULT_SETTINGS }
    });
    setShowCreateModal(true);
  };

  const handleCreateProject = () => {
    if (!newProjectData.name.trim()) {
      alert("请输入项目名称");
      return;
    }

    const newProject: Project = {
      id: uuidv4(),
      name: newProjectData.name,
      type: newProjectData.type,
      settings: newProjectData.settings,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      characters: [],
      scenes: [],
      episodes: [] 
    };
    
    setProjects([...projects, newProject]);
    setCurrentProjectId(newProject.id);
    setShowCreateModal(false);
    setViewMode(ViewMode.PROJECT_DETAIL); 
  };

  const handleUpdateSettings = (newSettings: ProjectSettings) => {
    if (!currentProject) return;
    handleUpdateProject(currentProject.id, { settings: newSettings });
    setShowSettingsModal(false);
  };

  const handleCreateEpisode = () => {
    if (!currentProject) return;
    const newEpisode: Episode = {
      id: uuidv4(),
      name: `第 ${currentProject.episodes.length + 1} 章`,
      scriptContent: '',
      frames: [],
      updatedAt: Date.now()
    };
    handleUpdateProject(currentProject.id, {
      episodes: [...currentProject.episodes, newEpisode]
    });
  };

  const handleDeleteEpisode = (e: React.MouseEvent, episodeId: string) => {
    e.stopPropagation();
    if (!currentProject) return;
    if (confirm("确定要删除此分集吗？")) {
      handleUpdateProject(currentProject.id, {
        episodes: currentProject.episodes.filter(ep => ep.id !== episodeId)
      });
    }
  };

  const handleUpdateProject = (projectId: string, updates: Partial<Project>) => {
    setProjects(prev => prev.map(p => p.id === projectId ? { ...p, ...updates, updatedAt: Date.now() } : p));
  };

  const handleUpdateEpisode = (projectId: string, episodeId: string, updates: Partial<Episode>) => {
    setProjects(prev => prev.map(p => {
      if (p.id !== projectId) return p;
      return {
        ...p,
        episodes: p.episodes.map(e => e.id === episodeId ? { ...e, ...updates, updatedAt: Date.now() } : e)
      };
    }));
  };

  const handleSaveFrameUpdate = (frameId: string, updates: Partial<StoryboardFrame>) => {
    if (!currentProject || !currentEpisode) return;
    const updatedFrames = currentEpisode.frames.map(f => f.id === frameId ? { ...f, ...updates } : f);
    handleUpdateEpisode(currentProject.id, currentEpisode.id, { frames: updatedFrames });
  };

  // --- Storyboard Management & Batch Ops ---

  // 1. Add New Blank Frame
  const handleAddNewFrame = () => {
    if (!currentProject || !currentEpisode) return;
    const newFrame: StoryboardFrame = {
        id: uuidv4(),
        index: currentEpisode.frames.length,
        prompt: "空场景",
        originalText: "",
        references: { characterIds: [] }
    };
    handleUpdateEpisode(currentProject.id, currentEpisode.id, {
        frames: [...currentEpisode.frames, newFrame]
    });
  };

  // 2. Duplicate Frame
  const handleDuplicateFrame = (frameToCopy: StoryboardFrame) => {
      if (!currentProject || !currentEpisode) return;
      const newFrame: StoryboardFrame = {
          ...frameToCopy,
          id: uuidv4(),
          index: currentEpisode.frames.length,
          imageUrl: undefined, // Don't copy generated assets? Or maybe optional. Usually prefer creating new variations.
          videoUrl: undefined,
          isGenerating: false,
          isGeneratingVideo: false,
          audioUrl: undefined,
          isGeneratingAudio: false
      };
      // Insert after current
      const idx = currentEpisode.frames.findIndex(f => f.id === frameToCopy.id);
      const newFrames = [...currentEpisode.frames];
      newFrames.splice(idx + 1, 0, newFrame);
      
      // Re-index
      const reindexed = newFrames.map((f, i) => ({ ...f, index: i }));
      
      handleUpdateEpisode(currentProject.id, currentEpisode.id, { frames: reindexed });
  };

  // 3. Delete Selected Frames
  const handleDeleteSelectedFrames = () => {
      if (!currentProject || !currentEpisode || selectedFrameIds.length === 0) return;
      if (!confirm(`确定要删除选中的 ${selectedFrameIds.length} 个分镜吗？`)) return;

      const remainingFrames = currentEpisode.frames
          .filter(f => !selectedFrameIds.includes(f.id))
          .map((f, i) => ({ ...f, index: i }));

      handleUpdateEpisode(currentProject.id, currentEpisode.id, { frames: remainingFrames });
      setSelectedFrameIds([]);
  };

  // 4. Drag & Drop Reordering
  const handleDragStart = (e: React.DragEvent, index: number) => {
      setDraggedFrameIndex(index);
      // Required for Firefox
      e.dataTransfer.effectAllowed = 'move'; 
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
      e.preventDefault(); // Necessary to allow dropping
      e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
      e.preventDefault();
      if (draggedFrameIndex === null || !currentProject || !currentEpisode) return;
      if (draggedFrameIndex === dropIndex) return;

      const newFrames = [...currentEpisode.frames];
      const [draggedItem] = newFrames.splice(draggedFrameIndex, 1);
      newFrames.splice(dropIndex, 0, draggedItem);

      // Re-index
      const reindexed = newFrames.map((f, i) => ({ ...f, index: i }));
      handleUpdateEpisode(currentProject.id, currentEpisode.id, { frames: reindexed });
      setDraggedFrameIndex(null);
  };

  // 5. Selection Logic
  const toggleFrameSelection = (frameId: string) => {
      setSelectedFrameIds(prev => 
          prev.includes(frameId) ? prev.filter(id => id !== frameId) : [...prev, frameId]
      );
  };

  const handleSelectAll = () => {
      if (!currentEpisode) return;
      setSelectedFrameIds(currentEpisode.frames.map(f => f.id));
  };

  const handleDeselectAll = () => {
      setSelectedFrameIds([]);
  };

  const handleSelectMissing = (type: 'image' | 'video' | 'audio') => {
      if (!currentEpisode) return;
      let ids: string[] = [];
      if (type === 'image') ids = currentEpisode.frames.filter(f => !f.imageUrl).map(f => f.id);
      if (type === 'video') ids = currentEpisode.frames.filter(f => !f.videoUrl).map(f => f.id);
      if (type === 'audio') ids = currentEpisode.frames.filter(f => !f.audioUrl).map(f => f.id);
      setSelectedFrameIds(ids);
  };

  // 6. Batch Generation
  const handleBatchGenerate = async (type: 'image' | 'video' | 'audio') => {
      if (!currentProject || !currentEpisode || selectedFrameIds.length === 0) return;
      
      const frameIdsToProcess = [...selectedFrameIds];
      
      // Process sequentially to avoid overwhelming rate limits (could optimize to batches of 3-5 later)
      for (const frameId of frameIdsToProcess) {
          const frame = currentEpisode.frames.find(f => f.id === frameId);
          // Skip if already has asset (optional, but let's allow overwrite if user explicitly selected)
          
          if (type === 'image') {
               await handleGenerateFrameImage(frameId, frame?.prompt || "");
          } else if (type === 'video') {
               if (frame?.imageUrl) {
                   await handleGenerateFrameVideo(frameId);
               }
          } else if (type === 'audio') {
              if (frame?.dialogue || frame?.prompt) {
                  await handleGenerateFrameAudio(frameId);
              }
          }
      }
      alert("批量生成任务完成！");
  };

  // --- Asset Management Handlers ---

  const handleAddAsset = (type: 'character' | 'scene') => {
      if (!currentProject) return;
      const id = uuidv4();
      if (type === 'character') {
          const newChar: Character = {
              id,
              name: '新角色',
              description: '描述这个角色...',
              appearance: '',
              personality: '',
              role: 'Supporting'
          };
          handleUpdateProject(currentProject.id, { characters: [...currentProject.characters, newChar] });
          setEditingAsset({ type: 'character', id });
      } else {
          const newScene: Scene = {
              id,
              name: '新场景',
              description: '描述这个场景...',
              environment: '',
              atmosphere: ''
          };
          handleUpdateProject(currentProject.id, { scenes: [...currentProject.scenes, newScene] });
          setEditingAsset({ type: 'scene', id });
      }
  };

  const handleDeleteAsset = (type: 'character' | 'scene', id: string) => {
      if (!currentProject) return;
      if (!confirm(`确定要删除此${type === 'character' ? '角色' : '场景'}吗？`)) return;
      
      if (type === 'character') {
          handleUpdateProject(currentProject.id, { characters: currentProject.characters.filter(c => c.id !== id) });
          setSelectedCharacterIds(prev => prev.filter(pid => pid !== id));
      } else {
          handleUpdateProject(currentProject.id, { scenes: currentProject.scenes.filter(s => s.id !== id) });
          setSelectedSceneIds(prev => prev.filter(pid => pid !== id));
      }
  };

  const handleBatchDeleteAssets = (type: 'character' | 'scene') => {
      if (!currentProject) return;
      const selectedIds = type === 'character' ? selectedCharacterIds : selectedSceneIds;
      if (selectedIds.length === 0) return;

      if (!confirm(`确定要删除选中的 ${selectedIds.length} 个${type === 'character' ? '角色' : '场景'}吗？`)) return;

      if (type === 'character') {
          handleUpdateProject(currentProject.id, { characters: currentProject.characters.filter(c => !selectedIds.includes(c.id)) });
          setSelectedCharacterIds([]);
      } else {
          handleUpdateProject(currentProject.id, { scenes: currentProject.scenes.filter(s => !selectedIds.includes(s.id)) });
          setSelectedSceneIds([]);
      }
  };

  const handleBatchGenerateAssets = async (type: 'character' | 'scene') => {
      if (!currentProject) return;
      const selectedIds = type === 'character' ? selectedCharacterIds : selectedSceneIds;
      if (selectedIds.length === 0) return;

      for (const id of selectedIds) {
          if (type === 'character') {
              const char = currentProject.characters.find(c => c.id === id);
              if (char) await handleGenerateAssetImage('character', id, `${char.appearance}, ${char.personality}`);
          } else {
              const scene = currentProject.scenes.find(s => s.id === id);
              if (scene) await handleGenerateAssetImage('scene', id, `${scene.environment}, ${scene.atmosphere}`);
          }
      }
      alert("批量资产生成完成！");
  };

  const handleSelectAllAssets = (type: 'character' | 'scene') => {
      if (!currentProject) return;
      if (type === 'character') {
          setSelectedCharacterIds(currentProject.characters.map(c => c.id));
      } else {
          setSelectedSceneIds(currentProject.scenes.map(s => s.id));
      }
  };

  const handleDeselectAllAssets = (type: 'character' | 'scene') => {
      if (type === 'character') {
          setSelectedCharacterIds([]);
      } else {
          setSelectedSceneIds([]);
      }
  };

  const handleSelectMissingAssetImages = (type: 'character' | 'scene') => {
      if (!currentProject) return;
      if (type === 'character') {
          setSelectedCharacterIds(currentProject.characters.filter(c => !c.imageUrl).map(c => c.id));
      } else {
          setSelectedSceneIds(currentProject.scenes.filter(s => !s.imageUrl).map(s => s.id));
      }
  };

  const toggleAssetSelection = (type: 'character' | 'scene', id: string) => {
      if (type === 'character') {
          setSelectedCharacterIds(prev => prev.includes(id) ? prev.filter(pid => pid !== id) : [...prev, id]);
      } else {
          setSelectedSceneIds(prev => prev.includes(id) ? prev.filter(pid => pid !== id) : [...prev, id]);
      }
  };

  const handleSaveAssetUpdate = (id: string, updates: any) => {
      if (!currentProject) return;
      if (editingAsset?.type === 'character') {
          const updatedChars = currentProject.characters.map(c => c.id === id ? { ...c, ...updates } : c);
          handleUpdateProject(currentProject.id, { characters: updatedChars });
      } else {
          const updatedScenes = currentProject.scenes.map(s => s.id === id ? { ...s, ...updates } : s);
          handleUpdateProject(currentProject.id, { scenes: updatedScenes });
      }
  };


  // --- Core AI Logic ---

  const handleAnalyzeScript = async () => {
    if (!currentProject || !currentEpisode || !currentEpisode.scriptContent) return;
    setIsProcessing(true);
    try {
      // 1. Get Settings for this Project Type
      const systemInstruction = globalSettings.projectTypePrompts[currentProject.type];
      const model = globalSettings.extractionModel;

      // 2. Extract Assets
      const analysis = await analyzeNovelScript(currentEpisode.scriptContent, model, systemInstruction);
      
      const newCharacters: Character[] = analysis.characters.map(c => ({ ...c, id: uuidv4() }));
      const newScenes: Scene[] = analysis.scenes.map(s => ({ ...s, id: uuidv4() }));

      // Merge new assets with existing ones (simple concat for now, in real app check duplicates)
      const mergedCharacters = [...currentProject.characters, ...newCharacters];
      const mergedScenes = [...currentProject.scenes, ...newScenes];

      // 3. Breakdown Storyboard
      const breakdown = await generateStoryboardBreakdown(currentEpisode.scriptContent, model, systemInstruction);
      const newFrames: StoryboardFrame[] = breakdown.frames.map((f, idx) => {
        // Map names to IDs
        const charIds = (f.characterNames || [])
          .map(name => mergedCharacters.find(c => c.name.toLowerCase().includes(name.toLowerCase()))?.id)
          .filter((id): id is string => !!id);
        
        const sceneId = f.sceneName 
          ? mergedScenes.find(s => s.name.toLowerCase().includes(f.sceneName!.toLowerCase()))?.id
          : undefined;

        return {
          id: uuidv4(),
          index: idx,
          prompt: f.prompt,
          dialogue: f.dialogue,
          originalText: f.originalText,
          references: { 
            characterIds: [...new Set(charIds)], // Dedupe
            sceneId: sceneId 
          }
        };
      });

      // Update Project State
      handleUpdateProject(currentProject.id, {
        characters: mergedCharacters,
        scenes: mergedScenes
      });

      handleUpdateEpisode(currentProject.id, currentEpisode.id, {
        frames: newFrames
      });

      // Move to Assets tab to review
      setActiveTab(ProjectTab.ASSETS);

    } catch (error) {
      console.error(error);
      alert("分析失败，请重试。");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleGenerateAssetImage = async (type: 'character' | 'scene', id: string, description: string) => {
    if (!currentProject) return;
    
    setIsProcessing(true);
    try {
      // Use Project Settings for Style
      const style = currentProject.settings.imageStyle || '';
      const prompt = `${style}, ${description}`;
      // Assets usually 1:1
      const imageUrl = await generateImageAsset(prompt, '1:1', currentProject.settings.imageModel);
      
      if (type === 'character') {
        const updatedChars = currentProject.characters.map(c => c.id === id ? { ...c, imageUrl } : c);
        handleUpdateProject(currentProject.id, { characters: updatedChars });
      } else {
        const updatedScenes = currentProject.scenes.map(s => s.id === id ? { ...s, imageUrl } : s);
        handleUpdateProject(currentProject.id, { scenes: updatedScenes });
      }
    } catch (e) {
      alert("图片生成失败");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleGenerateFrameImage = async (frameId: string, prompt: string) => {
    if (!currentProject || !currentEpisode) return;

    // 1. Mark frame as generating
    // Use functional update to ensure we are working with latest state if called in loop
    setProjects(prevProjects => {
        const projIndex = prevProjects.findIndex(p => p.id === currentProject.id);
        if (projIndex === -1) return prevProjects;
        const newProj = { ...prevProjects[projIndex] };
        
        const epIndex = newProj.episodes.findIndex(e => e.id === currentEpisodeId);
        if (epIndex === -1) return prevProjects;
        const newEp = { ...newProj.episodes[epIndex] };
        
        newEp.frames = newEp.frames.map(f => f.id === frameId ? { ...f, isGenerating: true } : f);
        newProj.episodes[epIndex] = newEp;
        
        const newProjs = [...prevProjects];
        newProjs[projIndex] = newProj;
        return newProjs;
    });

    try {
      const freshProject = projects.find(p => p.id === currentProject.id); 
      
      // Correct approach for API payload construction:
      const frame = currentEpisode.frames.find(f => f.id === frameId);
      if (!frame) return; 

      // 2. Prepare Reference Images (Construct locally)
      const referenceImages: { name: string, data: string, mimeType: string }[] = [];

      // Add Characters
      frame.references.characterIds.forEach(charId => {
        const char = currentProject.characters.find(c => c.id === charId);
        if (char && char.imageUrl) {
           const [prefix, data] = char.imageUrl.split(',');
           const mimeType = prefix.match(/:(.*?);/)![1];
           referenceImages.push({ name: char.name, data: data, mimeType: mimeType });
        }
      });

      // Add Scene
      if (frame.references.sceneId) {
        const scene = currentProject.scenes.find(s => s.id === frame.references.sceneId);
        if (scene && scene.imageUrl) {
           const [prefix, data] = scene.imageUrl.split(',');
           const mimeType = prefix.match(/:(.*?);/)![1];
           referenceImages.push({ name: scene.name, data: data, mimeType: mimeType });
        }
      }

      // 3. Generate
      const style = currentProject.settings.imageStyle || 'Cinematic';
      const aspectRatio = currentProject.settings.aspectRatio || '16:9';
      const model = currentProject.settings.imageModel;
      const enhancedPrompt = `${style}, ${prompt}`; 
      
      const imageUrl = await generateImageAsset(enhancedPrompt, aspectRatio, model, referenceImages);

      // 4. Update frame with image
      setProjects(prev => prev.map(p => {
          if (p.id !== currentProject.id) return p;
          return {
              ...p,
              episodes: p.episodes.map(e => {
                  if (e.id !== currentEpisodeId) return e;
                  return {
                      ...e,
                      frames: e.frames.map(f => f.id === frameId ? { ...f, imageUrl, isGenerating: false } : f)
                  };
              })
          };
      }));

    } catch (e) {
      console.error(e);
      // Reset generating state
      setProjects(prev => prev.map(p => {
          if (p.id !== currentProject.id) return p;
          return {
              ...p,
              episodes: p.episodes.map(e => {
                  if (e.id !== currentEpisodeId) return e;
                  return {
                      ...e,
                      frames: e.frames.map(f => f.id === frameId ? { ...f, isGenerating: false } : f)
                  };
              })
          };
      }));
    }
  };

  const handleGenerateFrameVideo = async (frameId: string) => {
    if (!currentProject || !currentEpisode) return;

    // Use functional update for marking state
    setProjects(prev => prev.map(p => {
        if (p.id !== currentProject.id) return p;
        return {
            ...p,
            episodes: p.episodes.map(e => {
                if (e.id !== currentEpisodeId) return e;
                return {
                    ...e,
                    frames: e.frames.map(f => f.id === frameId ? { ...f, isGeneratingVideo: true } : f)
                };
            })
        };
    }));

    try {
      const frame = currentProject.episodes.find(e => e.id === currentEpisodeId)?.frames.find(f => f.id === frameId);
      
      if (!frame || !frame.imageUrl) {
        // Reset
        setProjects(prev => prev.map(p => {
          if (p.id !== currentProject.id) return p;
          return {
              ...p,
              episodes: p.episodes.map(e => {
                  if (e.id !== currentEpisodeId) return e;
                  return {
                      ...e,
                      frames: e.frames.map(f => f.id === frameId ? { ...f, isGeneratingVideo: false } : f)
                  };
              })
          };
        }));
        return;
      }

      const model = currentProject.settings.videoModel;
      const videoUrl = await generateVideoFromImage(frame.imageUrl, frame.prompt, model);

      // 4. Update frame with video
      setProjects(prev => prev.map(p => {
          if (p.id !== currentProject.id) return p;
          return {
              ...p,
              episodes: p.episodes.map(e => {
                  if (e.id !== currentEpisodeId) return e;
                  return {
                      ...e,
                      frames: e.frames.map(f => f.id === frameId ? { ...f, videoUrl, isGeneratingVideo: false } : f)
                  };
              })
          };
      }));
    } catch (e) {
      console.error(e);
      setProjects(prev => prev.map(p => {
          if (p.id !== currentProject.id) return p;
          return {
              ...p,
              episodes: p.episodes.map(e => {
                  if (e.id !== currentEpisodeId) return e;
                  return {
                      ...e,
                      frames: e.frames.map(f => f.id === frameId ? { ...f, isGeneratingVideo: false } : f)
                  };
              })
          };
      }));
    }
  };

  const handleGenerateFrameAudio = async (frameId: string) => {
    if (!currentProject || !currentEpisode) return;
    
    // Set loading state
    setProjects(prev => prev.map(p => {
        if (p.id !== currentProject.id) return p;
        return {
            ...p,
            episodes: p.episodes.map(e => {
                if (e.id !== currentEpisodeId) return e;
                return {
                    ...e,
                    frames: e.frames.map(f => f.id === frameId ? { ...f, isGeneratingAudio: true } : f)
                };
            })
        };
    }));

    try {
        const frame = currentProject.episodes.find(e => e.id === currentEpisodeId)?.frames.find(f => f.id === frameId);
        
        // Prefer dialogue, fallback to prompt for narration
        const textToSpeak = frame?.dialogue || frame?.prompt;

        if (!textToSpeak) {
             throw new Error("No text found for TTS");
        }

        const model = currentProject.settings.ttsModel;
        const audioUrl = await generateSpeech(textToSpeak, model);

        setProjects(prev => prev.map(p => {
            if (p.id !== currentProject.id) return p;
            return {
                ...p,
                episodes: p.episodes.map(e => {
                    if (e.id !== currentEpisodeId) return e;
                    return {
                        ...e,
                        frames: e.frames.map(f => f.id === frameId ? { ...f, audioUrl, isGeneratingAudio: false } : f)
                    };
                })
            };
        }));
    } catch(e) {
        console.error(e);
        setProjects(prev => prev.map(p => {
            if (p.id !== currentProject.id) return p;
            return {
                ...p,
                episodes: p.episodes.map(e => {
                    if (e.id !== currentEpisodeId) return e;
                    return {
                        ...e,
                        frames: e.frames.map(f => f.id === frameId ? { ...f, isGeneratingAudio: false } : f)
                    };
                })
            };
        }));
    }
  };


  // --- Views ---

  // 1. Project List View
  if (viewMode === ViewMode.PROJECT_LIST) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-8 relative">
        <div className="max-w-6xl mx-auto">
          <header className="flex justify-between items-center mb-12">
            <div>
              <h1 className="text-3xl font-bold mb-2 flex items-center gap-3">
                 <Film className="text-blue-500" /> StoryWeaver AI
              </h1>
              <p className="text-gray-400">管理您的故事和可视化项目</p>
            </div>
            <div className="flex gap-3">
                <button 
                  onClick={() => setShowGlobalSettingsModal(true)}
                  className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-4 py-3 rounded-lg flex items-center gap-2 font-medium transition-all border border-gray-700"
                  title="全局设置"
                >
                  <Globe size={20} /> <span className="hidden sm:inline">全局设置</span>
                </button>
                <button 
                  onClick={openCreateModal}
                  className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-3 rounded-lg flex items-center gap-2 font-medium transition-all shadow-lg shadow-blue-900/30"
                >
                  <Plus size={20} /> 新建项目
                </button>
            </div>
          </header>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects.map(project => (
              <div 
                key={project.id}
                onClick={() => { setCurrentProjectId(project.id); setViewMode(ViewMode.PROJECT_DETAIL); }}
                className="bg-gray-800 border border-gray-700 rounded-xl p-6 hover:border-blue-500/50 hover:bg-gray-750 transition-all cursor-pointer group flex flex-col h-64"
              >
                <div className="flex-1 bg-gray-900 rounded-lg mb-4 flex items-center justify-center overflow-hidden border border-gray-800 relative">
                  {project.thumbnailUrl ? (
                    <img src={project.thumbnailUrl} alt={project.name} className="w-full h-full object-cover" />
                  ) : (
                    <ImageIcon className="text-gray-700 w-12 h-12 group-hover:text-blue-500 transition-colors" />
                  )}
                  {/* Overlay for episode count */}
                  <div className="absolute top-2 right-2 bg-black/60 backdrop-blur-md px-2 py-1 rounded text-xs text-white">
                     {project.episodes.length} 集
                  </div>
                </div>
                <div>
                  <h3 className="text-xl font-semibold mb-1 truncate">{project.name}</h3>
                  <div className="flex justify-between items-center mt-2">
                     <div className="flex flex-col">
                        <span className="text-xs bg-gray-700 px-2 py-0.5 rounded text-gray-300 w-fit mb-1">{PROJECT_TYPE_LABELS[project.type]}</span>
                        <p className="text-sm text-gray-500">编辑于: {new Date(project.updatedAt).toLocaleDateString()}</p>
                     </div>
                     <div className="flex items-center gap-2 text-xs text-gray-400">
                        <Users size={12}/> {project.characters.length}
                     </div>
                  </div>
                </div>
              </div>
            ))}
            
            {projects.length === 0 && (
              <div className="col-span-full text-center py-20 text-gray-500 bg-gray-800/50 rounded-2xl border border-dashed border-gray-700">
                <Film className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="text-lg mb-2">暂无项目</p>
                <p className="text-sm opacity-60">创建您的第一个小说可视化项目以开始。</p>
              </div>
            )}
          </div>
        </div>

        {/* Global Settings Modal */}
        {showGlobalSettingsModal && (
            <GlobalSettingsModal 
                settings={globalSettings}
                onSave={setGlobalSettings}
                onClose={() => setShowGlobalSettingsModal(false)}
            />
        )}

        {/* Create Project Modal */}
        {showCreateModal && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
             <div className="bg-gray-800 rounded-2xl w-full max-w-2xl overflow-hidden border border-gray-700 shadow-2xl flex flex-col max-h-[90vh]">
                <div className="p-6 border-b border-gray-700 flex justify-between items-center shrink-0">
                   <h2 className="text-xl font-bold">新建项目</h2>
                   <button onClick={() => setShowCreateModal(false)}><X className="text-gray-400 hover:text-white"/></button>
                </div>
                
                <div className="p-6 overflow-y-auto flex-1">
                    <div className="space-y-6">
                      {/* Basic Info */}
                      <div className="space-y-4">
                         <div>
                            <label className="block text-sm font-medium text-gray-400 mb-1">项目名称 <span className="text-red-500">*</span></label>
                            <input 
                              type="text" 
                              autoFocus
                              className="w-full bg-gray-900 border border-gray-600 rounded-lg p-3 text-white focus:border-blue-500 focus:outline-none placeholder-gray-600"
                              placeholder="例如：最后的星舰"
                              value={newProjectData.name}
                              onChange={e => setNewProjectData({...newProjectData, name: e.target.value})}
                            />
                         </div>
                         
                         <div>
                            <label className="block text-sm font-medium text-gray-400 mb-2">项目类型</label>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                               {(['NOVEL_VISUALIZATION', 'SHORT_VIDEO', 'COMIC', 'OTHER'] as ProjectType[]).map(type => (
                                 <button
                                   key={type}
                                   onClick={() => setNewProjectData({...newProjectData, type})}
                                   className={`p-2 rounded-lg border text-xs font-bold transition-all text-center ${
                                     newProjectData.type === type 
                                     ? 'bg-blue-600 text-white border-blue-500 shadow-lg shadow-blue-900/50' 
                                     : 'bg-gray-700 border-transparent text-gray-400 hover:bg-gray-600'
                                   }`}
                                 >
                                   {PROJECT_TYPE_LABELS[type]}
                                 </button>
                               ))}
                            </div>
                         </div>
                      </div>

                      <div className="w-full h-px bg-gray-700"></div>

                      {/* Settings */}
                      <div>
                         <h3 className="text-md font-bold text-white mb-4 flex items-center gap-2">
                           <Settings size={16} className="text-blue-400"/> 项目默认设置
                         </h3>
                         <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                            <div>
                              <label className="block text-xs font-medium text-gray-500 mb-1 uppercase">宽高比</label>
                              <select 
                                value={newProjectData.settings.aspectRatio} 
                                onChange={e => setNewProjectData({...newProjectData, settings: {...newProjectData.settings, aspectRatio: e.target.value as any}})}
                                className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white text-sm"
                              >
                                <option value="16:9">16:9 (横屏视频)</option>
                                <option value="9:16">9:16 (竖屏)</option>
                                <option value="1:1">1:1 (方形)</option>
                                <option value="4:3">4:3</option>
                                <option value="3:4">3:4</option>
                              </select>
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-500 mb-1 uppercase">图像模型</label>
                              <select 
                                value={newProjectData.settings.imageModel} 
                                onChange={e => setNewProjectData({...newProjectData, settings: {...newProjectData.settings, imageModel: e.target.value}})}
                                className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white text-sm"
                              >
                                <option value="gemini-2.5-flash-image">Gemini 2.5 Flash Image</option>
                                <option value="gemini-3-pro-image-preview">Gemini 3 Pro Image (高质量)</option>
                              </select>
                            </div>
                         </div>
                         
                         <div className="mb-4">
                            <label className="block text-xs font-medium text-gray-500 mb-1 uppercase">艺术风格提示词</label>
                            <textarea 
                              value={newProjectData.settings.imageStyle} 
                              onChange={e => setNewProjectData({...newProjectData, settings: {...newProjectData.settings, imageStyle: e.target.value}})}
                              className="w-full bg-gray-900 border border-gray-600 rounded p-3 text-white text-sm h-24 focus:border-blue-500 focus:outline-none"
                              placeholder="描述全局视觉风格（例如：赛博朋克, 霓虹灯光, 水彩画...）"
                            />
                         </div>
                         
                         <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                              <label className="block text-xs font-medium text-gray-500 mb-1 uppercase">视频模型</label>
                              <select 
                                value={newProjectData.settings.videoModel} 
                                onChange={e => setNewProjectData({...newProjectData, settings: {...newProjectData.settings, videoModel: e.target.value}})}
                                className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white text-sm"
                              >
                                <option value="veo-3.1-fast-generate-preview">Veo 3.1 Fast</option>
                                <option value="veo-3.1-generate-preview">Veo 3.1 High Quality</option>
                              </select>
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-500 mb-1 uppercase">语音模型 (TTS)</label>
                              <select 
                                value={newProjectData.settings.ttsModel} 
                                onChange={e => setNewProjectData({...newProjectData, settings: {...newProjectData.settings, ttsModel: e.target.value}})}
                                className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white text-sm"
                              >
                                <option value="gemini-2.5-flash-preview-tts">Gemini 2.5 Flash TTS</option>
                              </select>
                            </div>
                         </div>
                      </div>
                    </div>
                </div>

                <div className="p-6 border-t border-gray-700 bg-gray-850 flex justify-end gap-3 shrink-0">
                   <button onClick={() => setShowCreateModal(false)} className="px-5 py-2.5 rounded-lg text-gray-300 hover:bg-gray-700 font-medium">取消</button>
                   <button onClick={handleCreateProject} className="px-6 py-2.5 bg-blue-600 rounded-lg text-white hover:bg-blue-500 font-medium shadow-lg shadow-blue-900/50">新建项目</button>
                </div>
             </div>
          </div>
        )}
      </div>
    );
  }

  // 2. Project Detail (Episode List) View
  if (viewMode === ViewMode.PROJECT_DETAIL) {
    if (!currentProject) return null;

    return (
      <div className="min-h-screen bg-gray-900 text-white flex flex-col">
        {/* Header */}
        <header className="h-16 bg-gray-950 border-b border-gray-800 flex items-center justify-between px-6 shrink-0">
           <div className="flex items-center gap-4">
              <button 
                onClick={() => setViewMode(ViewMode.PROJECT_LIST)}
                className="p-2 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-white transition-colors"
              >
                <ArrowLeft size={20} />
              </button>
              <div>
                <h1 className="text-lg font-bold text-white flex items-center gap-2">
                  {currentProject.name}
                  <span className="px-2 py-0.5 rounded-full bg-gray-800 text-[10px] text-gray-400 border border-gray-700">{PROJECT_TYPE_LABELS[currentProject.type]}</span>
                </h1>
                <p className="text-xs text-gray-500">项目概览</p>
              </div>
           </div>
           <div className="flex items-center gap-3">
              <button 
                onClick={() => setShowSettingsModal(true)}
                className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors flex items-center gap-2 text-sm"
              >
                 <Settings size={18} /> <span className="hidden sm:inline">设置</span>
              </button>
              <div className="w-px h-6 bg-gray-800 mx-1"></div>
              <div className="px-3 py-1 bg-gray-800 rounded text-xs text-gray-400">
                 {currentProject.episodes.length} 集
              </div>
              <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-500 to-purple-500 border-2 border-gray-800"></div>
           </div>
        </header>

        {/* Content */}
        <div className="flex-1 p-8 max-w-6xl mx-auto w-full">
           <div className="flex justify-between items-center mb-8">
              <h2 className="text-2xl font-bold flex items-center gap-2">
                <FileText className="text-purple-500"/> 分集列表
              </h2>
              <button 
                onClick={handleCreateEpisode}
                className="bg-purple-600 hover:bg-purple-500 text-white px-5 py-2.5 rounded-lg flex items-center gap-2 font-medium transition-all"
              >
                <Plus size={18} /> 新建分集
              </button>
           </div>

           <div className="grid grid-cols-1 gap-4">
              {currentProject.episodes.map((episode, index) => (
                 <div 
                   key={episode.id}
                   onClick={() => { 
                      setCurrentEpisodeId(episode.id); 
                      setViewMode(ViewMode.EPISODE_DETAIL);
                      setActiveTab(ProjectTab.SCRIPT); 
                    }}
                   className="bg-gray-800 border border-gray-700 rounded-xl p-5 hover:border-purple-500/50 hover:bg-gray-750 transition-all cursor-pointer group flex items-center justify-between"
                 >
                    <div className="flex items-center gap-6">
                       <div className="w-12 h-12 bg-gray-900 rounded-lg flex items-center justify-center text-gray-600 font-bold text-lg border border-gray-800">
                          {index + 1}
                       </div>
                       <div>
                          <h3 className="text-lg font-semibold text-white mb-1 group-hover:text-purple-400 transition-colors">{episode.name}</h3>
                          <div className="flex items-center gap-4 text-sm text-gray-500">
                             <span className="flex items-center gap-1"><Clock size={14}/> {new Date(episode.updatedAt || Date.now()).toLocaleDateString()}</span>
                             <span>{episode.scriptContent.length > 0 ? `${episode.scriptContent.length} 字` : '空剧本'}</span>
                             <span>{episode.frames.length} 分镜</span>
                          </div>
                       </div>
                    </div>
                    <div className="flex items-center gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
                       <button className="px-4 py-2 bg-purple-600/10 text-purple-400 rounded-lg text-sm font-medium hover:bg-purple-600 hover:text-white transition-colors">
                          打开编辑器
                       </button>
                       <button 
                          onClick={(e) => handleDeleteEpisode(e, episode.id)}
                          className="p-2 hover:bg-red-900/30 text-gray-500 hover:text-red-400 rounded-lg transition-colors"
                       >
                          <Trash2 size={18} />
                       </button>
                    </div>
                 </div>
              ))}

              {currentProject.episodes.length === 0 && (
                 <div className="text-center py-16 border-2 border-dashed border-gray-800 rounded-xl">
                    <p className="text-gray-500 mb-4">暂无分集。</p>
                    <button onClick={handleCreateEpisode} className="text-purple-400 hover:text-purple-300 font-medium">
                       创建第一个分集
                    </button>
                 </div>
              )}
           </div>
        </div>

        {/* Project Settings Modal */}
        {showSettingsModal && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
             <div className="bg-gray-800 rounded-2xl w-full max-w-lg border border-gray-700 shadow-2xl p-6">
                <div className="flex justify-between items-center mb-6">
                   <h2 className="text-xl font-bold">项目设置</h2>
                   <button onClick={() => setShowSettingsModal(false)}><X className="text-gray-400 hover:text-white"/></button>
                </div>
                <ProjectSettingsForm 
                   initialData={currentProject.settings}
                   onSave={handleUpdateSettings}
                   onCancel={() => setShowSettingsModal(false)}
                />
             </div>
          </div>
        )}
      </div>
    );
  }

  // 3. Episode Editor View
  if (viewMode === ViewMode.EPISODE_DETAIL) {
    if (!currentProject || !currentEpisode) return null;

    return (
      <Layout 
        title={`${currentProject.name} / ${currentEpisode.name}`}
        activeTab={activeTab} 
        onTabChange={setActiveTab}
        onBack={() => {
           setCurrentEpisodeId(null);
           setViewMode(ViewMode.PROJECT_DETAIL);
        }}
      >
        {activeTab === ProjectTab.SCRIPT && (
          <div className="max-w-4xl mx-auto h-full flex flex-col">
            <div className="mb-6 flex justify-between items-end">
              <div>
                <h2 className="text-2xl font-bold mb-2">剧本导入</h2>
                <p className="text-gray-400">在此粘贴小说文本。AI将自动提取角色和场景。</p>
              </div>
              <button 
                onClick={handleAnalyzeScript}
                disabled={isProcessing || !currentEpisode.scriptContent}
                className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2 rounded-lg flex items-center gap-2 transition-all"
              >
                {isProcessing ? <Loader2 className="animate-spin" /> : <Wand2 size={18} />}
                分析剧本
              </button>
            </div>
            <textarea
              className="flex-1 w-full bg-gray-800 border border-gray-700 rounded-xl p-6 text-gray-100 focus:outline-none focus:border-purple-500 resize-none font-serif leading-relaxed text-lg shadow-inner"
              placeholder="在此粘贴章节内容..."
              value={currentEpisode.scriptContent}
              onChange={(e) => handleUpdateEpisode(currentProject.id, currentEpisode.id, { scriptContent: e.target.value })}
            />
          </div>
        )}

        {activeTab === ProjectTab.ASSETS && (
          <div className="space-y-8 pb-12">
            <div className="bg-blue-900/20 border border-blue-900/50 p-4 rounded-lg flex gap-3 text-sm text-blue-200 mb-6">
               <Users size={18} className="shrink-0" />
               <p>资产在整个项目 "{currentProject.name}" 中共享。此处的更改将影响所有分集。</p>
            </div>

             {/* Characters Section */}
             <section>
              <div className="flex justify-between items-center mb-4">
                  <h2 className="text-xl font-bold flex items-center gap-2">
                    <Users size={20} className="text-blue-400"/> 角色 
                    <span className="text-sm font-normal text-gray-500 ml-2">({currentProject.characters.length})</span>
                  </h2>
                  <div className="flex items-center gap-2">
                      <button onClick={selectedCharacterIds.length === currentProject.characters.length ? () => handleDeselectAllAssets('character') : () => handleSelectAllAssets('character')} className="text-xs text-gray-400 hover:text-white px-2 py-1 bg-gray-800 rounded border border-gray-700">
                          {selectedCharacterIds.length === currentProject.characters.length && currentProject.characters.length > 0 ? "取消全选" : "全选"}
                      </button>
                      <button onClick={() => handleSelectMissingAssetImages('character')} className="text-xs text-gray-400 hover:text-white px-2 py-1 bg-gray-800 rounded border border-gray-700">
                          选中无图
                      </button>
                      {selectedCharacterIds.length > 0 && (
                          <>
                            <button onClick={() => handleBatchGenerateAssets('character')} className="flex items-center gap-1 text-xs bg-blue-600 hover:bg-blue-500 text-white px-2 py-1 rounded">
                                <Wand2 size={12}/> 批量生成
                            </button>
                            <button onClick={() => handleBatchDeleteAssets('character')} className="flex items-center gap-1 text-xs bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-600/30 px-2 py-1 rounded">
                                <Trash2 size={12}/> 删除选中
                            </button>
                          </>
                      )}
                      <button onClick={() => handleAddAsset('character')} className="flex items-center gap-1 text-xs bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded">
                          <Plus size={12}/> 新建角色
                      </button>
                  </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {currentProject.characters.map(char => {
                  const isSelected = selectedCharacterIds.includes(char.id);
                  return (
                  <div key={char.id} 
                    className={`bg-gray-800 border rounded-lg p-4 flex flex-col gap-3 hover:border-gray-600 transition-all relative group ${isSelected ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-700'}`}
                    onClick={() => toggleAssetSelection('character', char.id)}
                  >
                    <div className="absolute top-2 left-2 z-10" onClick={e => e.stopPropagation()}>
                         <button 
                            onClick={() => toggleAssetSelection('character', char.id)}
                            className={`p-1 rounded shadow-sm backdrop-blur-md transition-all ${
                                isSelected ? 'bg-blue-600 text-white' : 'bg-black/50 text-gray-400 hover:text-white'
                            }`}
                        >
                            {isSelected ? <CheckSquare size={16}/> : <Square size={16}/>}
                        </button>
                    </div>

                    <div className="absolute top-2 right-2 z-10 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                        <button onClick={() => setEditingAsset({type: 'character', id: char.id})} className="p-1.5 bg-black/60 text-gray-300 hover:text-white hover:bg-blue-600 rounded">
                            <Edit2 size={14} />
                        </button>
                        <button onClick={() => handleDeleteAsset('character', char.id)} className="p-1.5 bg-black/60 text-gray-300 hover:text-red-400 hover:bg-gray-800 rounded">
                            <Trash2 size={14} />
                        </button>
                    </div>

                    <div className="aspect-square bg-gray-900 rounded-md overflow-hidden relative group/img">
                      {char.imageUrl ? (
                        <img src={char.imageUrl} alt={char.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-700">无图片</div>
                      )}
                      <button 
                        onClick={(e) => {
                            e.stopPropagation();
                            handleGenerateAssetImage('character', char.id, `${char.appearance}, ${char.personality}`);
                        }}
                        className="absolute inset-0 bg-black/60 flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity text-white font-medium gap-2"
                      >
                        <Wand2 size={16} /> 生成
                      </button>
                    </div>
                    <div>
                      <h3 className="font-bold text-white">{char.name}</h3>
                      <span className="text-xs text-blue-400 bg-blue-400/10 px-2 py-0.5 rounded">{char.role}</span>
                    </div>
                    <p className="text-xs text-gray-400 line-clamp-3">{char.description}</p>
                  </div>
                )})}
              </div>
             </section>

             <div className="w-full h-px bg-gray-800" />

             {/* Scenes Section */}
             <section>
              <div className="flex justify-between items-center mb-4">
                  <h2 className="text-xl font-bold flex items-center gap-2">
                    <ImageIcon size={20} className="text-green-400"/> 场景
                    <span className="text-sm font-normal text-gray-500 ml-2">({currentProject.scenes.length})</span>
                  </h2>
                   <div className="flex items-center gap-2">
                      <button onClick={selectedSceneIds.length === currentProject.scenes.length ? () => handleDeselectAllAssets('scene') : () => handleSelectAllAssets('scene')} className="text-xs text-gray-400 hover:text-white px-2 py-1 bg-gray-800 rounded border border-gray-700">
                          {selectedSceneIds.length === currentProject.scenes.length && currentProject.scenes.length > 0 ? "取消全选" : "全选"}
                      </button>
                      <button onClick={() => handleSelectMissingAssetImages('scene')} className="text-xs text-gray-400 hover:text-white px-2 py-1 bg-gray-800 rounded border border-gray-700">
                          选中无图
                      </button>
                      {selectedSceneIds.length > 0 && (
                          <>
                            <button onClick={() => handleBatchGenerateAssets('scene')} className="flex items-center gap-1 text-xs bg-blue-600 hover:bg-blue-500 text-white px-2 py-1 rounded">
                                <Wand2 size={12}/> 批量生成
                            </button>
                            <button onClick={() => handleBatchDeleteAssets('scene')} className="flex items-center gap-1 text-xs bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-600/30 px-2 py-1 rounded">
                                <Trash2 size={12}/> 删除选中
                            </button>
                          </>
                      )}
                      <button onClick={() => handleAddAsset('scene')} className="flex items-center gap-1 text-xs bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded">
                          <Plus size={12}/> 新建场景
                      </button>
                  </div>
              </div>
               <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {currentProject.scenes.map(scene => {
                  const isSelected = selectedSceneIds.includes(scene.id);
                  return (
                  <div key={scene.id} 
                    className={`bg-gray-800 border rounded-lg p-4 flex gap-4 hover:border-gray-600 transition-all relative group ${isSelected ? 'border-green-500 ring-1 ring-green-500' : 'border-gray-700'}`}
                    onClick={() => toggleAssetSelection('scene', scene.id)}
                  >
                    <div className="absolute top-2 left-2 z-10" onClick={e => e.stopPropagation()}>
                         <button 
                            onClick={() => toggleAssetSelection('scene', scene.id)}
                            className={`p-1 rounded shadow-sm backdrop-blur-md transition-all ${
                                isSelected ? 'bg-green-600 text-white' : 'bg-black/50 text-gray-400 hover:text-white'
                            }`}
                        >
                            {isSelected ? <CheckSquare size={16}/> : <Square size={16}/>}
                        </button>
                    </div>

                    <div className="absolute top-2 right-2 z-10 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                        <button onClick={() => setEditingAsset({type: 'scene', id: scene.id})} className="p-1.5 bg-black/60 text-gray-300 hover:text-white hover:bg-blue-600 rounded">
                            <Edit2 size={14} />
                        </button>
                        <button onClick={() => handleDeleteAsset('scene', scene.id)} className="p-1.5 bg-black/60 text-gray-300 hover:text-red-400 hover:bg-gray-800 rounded">
                            <Trash2 size={14} />
                        </button>
                    </div>

                    <div className="w-24 h-24 bg-gray-900 rounded-md overflow-hidden shrink-0 relative group/img">
                       {scene.imageUrl ? (
                        <img src={scene.imageUrl} alt={scene.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-700">无图片</div>
                      )}
                       <button 
                        onClick={(e) => {
                            e.stopPropagation();
                            handleGenerateAssetImage('scene', scene.id, `${scene.environment}, ${scene.atmosphere}`);
                        }}
                        className="absolute inset-0 bg-black/60 flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity text-white"
                      >
                        <Wand2 size={16} />
                      </button>
                    </div>
                    <div className="flex-1 min-w-0 pt-2">
                      <h3 className="font-bold text-white truncate">{scene.name}</h3>
                      <p className="text-xs text-gray-400 mt-1 line-clamp-3">{scene.description}</p>
                    </div>
                  </div>
                )})}
              </div>
             </section>
          </div>
        )}

        {activeTab === ProjectTab.STORYBOARD && (
          <div className="flex flex-col h-full overflow-hidden">
             {/* Storyboard Header & Toolbar */}
             <header className="mb-4 shrink-0 bg-gray-800/50 p-3 rounded-xl border border-gray-800 backdrop-blur-sm">
                <div className="flex flex-col gap-3">
                    {/* Top Row: Title & View Switch */}
                    <div className="flex justify-between items-center">
                        <div>
                            <h2 className="text-xl font-bold flex items-center gap-2">
                                <Film size={20} className="text-blue-500"/>
                                分镜管理
                                <span className="text-sm font-normal text-gray-400 bg-gray-800 px-2 py-0.5 rounded-full border border-gray-700">
                                    {currentEpisode.frames.length} 个镜头
                                </span>
                            </h2>
                        </div>
                        <div className="flex bg-gray-900 p-1 rounded-lg border border-gray-700">
                            <button 
                                onClick={() => setStoryboardViewMode('GRID')}
                                className={`p-2 rounded flex items-center gap-2 text-sm font-medium transition-all ${
                                storyboardViewMode === 'GRID' 
                                ? 'bg-gray-700 text-white shadow-sm' 
                                : 'text-gray-400 hover:text-white'
                                }`}
                            >
                                <LayoutGrid size={16} /> 网格
                            </button>
                            <button 
                                onClick={() => setStoryboardViewMode('TIMELINE')}
                                className={`p-2 rounded flex items-center gap-2 text-sm font-medium transition-all ${
                                storyboardViewMode === 'TIMELINE' 
                                ? 'bg-gray-700 text-white shadow-sm' 
                                : 'text-gray-400 hover:text-white'
                                }`}
                            >
                                <Clapperboard size={16} /> 时间轴
                            </button>
                        </div>
                    </div>

                    <div className="w-full h-px bg-gray-700/50"></div>

                    {/* Bottom Row: Batch Tools */}
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        {/* Selection Tools */}
                        <div className="flex items-center gap-2">
                            <button 
                                onClick={selectedFrameIds.length === currentEpisode.frames.length ? handleDeselectAll : handleSelectAll}
                                className="flex items-center gap-2 px-3 py-1.5 rounded bg-gray-700/50 hover:bg-gray-700 text-sm transition-colors"
                            >
                                {selectedFrameIds.length > 0 && selectedFrameIds.length === currentEpisode.frames.length ? <CheckSquare size={16} className="text-blue-400"/> : <Square size={16}/>}
                                <span>全选</span>
                            </button>
                            
                            <div className="w-px h-4 bg-gray-700 mx-1"></div>

                            <button onClick={() => handleSelectMissing('image')} className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-700">
                                选中无图片
                            </button>
                            <button onClick={() => handleSelectMissing('video')} className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-700">
                                选中无视频
                            </button>
                            <button onClick={() => handleSelectMissing('audio')} className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-700">
                                选中无音频
                            </button>

                            {selectedFrameIds.length > 0 && (
                                <span className="ml-2 text-xs text-blue-400 font-medium">已选中 {selectedFrameIds.length} 项</span>
                            )}
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-2">
                             {selectedFrameIds.length > 0 ? (
                                <>
                                    <button 
                                        onClick={() => handleBatchGenerate('image')}
                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded font-medium shadow-lg shadow-blue-900/20"
                                    >
                                        <Wand2 size={14}/> 批量生图
                                    </button>
                                    <button 
                                        onClick={() => handleBatchGenerate('video')}
                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs rounded font-medium shadow-lg shadow-purple-900/20"
                                    >
                                        <Film size={14}/> 批量生视频
                                    </button>
                                    <button 
                                        onClick={() => handleBatchGenerate('audio')}
                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-600 hover:bg-yellow-500 text-white text-xs rounded font-medium shadow-lg shadow-yellow-900/20"
                                    >
                                        <Volume2 size={14}/> 批量TTS
                                    </button>
                                    <div className="w-px h-4 bg-gray-700 mx-1"></div>
                                    <button 
                                        onClick={handleDeleteSelectedFrames}
                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/40 text-red-400 text-xs rounded font-medium border border-red-600/20"
                                    >
                                        <Trash2 size={14}/> 删除选中
                                    </button>
                                </>
                             ) : (
                                <button 
                                    onClick={handleAddNewFrame}
                                    className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded font-medium"
                                >
                                    <Plus size={14}/> 新增空白分镜
                                </button>
                             )}
                        </div>
                    </div>
                </div>
             </header>

             {/* GRID VIEW */}
             {storyboardViewMode === 'GRID' && (
               <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-6 overflow-y-auto pb-8 pr-2 custom-scrollbar">
                 {currentEpisode.frames.map((frame, index) => {
                   const isSelected = selectedFrameIds.includes(frame.id);
                   const isDragging = draggedFrameIndex === index;

                   return (
                   <div 
                        key={frame.id} 
                        className={`bg-gray-800 border rounded-xl overflow-hidden flex flex-col group relative transition-all duration-200 ${
                            isSelected ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-700 hover:border-gray-500'
                        } ${isDragging ? 'opacity-30 scale-95' : 'opacity-100'}`}
                        draggable
                        onDragStart={(e) => handleDragStart(e, index)}
                        onDragOver={(e) => handleDragOver(e, index)}
                        onDrop={(e) => handleDrop(e, index)}
                    >
                     {/* Checkbox Overlay */}
                     <div className="absolute top-2 left-2 z-20" onClick={(e) => e.stopPropagation()}>
                        <button 
                            onClick={() => toggleFrameSelection(frame.id)}
                            className={`p-1 rounded shadow-sm backdrop-blur-md transition-all ${
                                isSelected ? 'bg-blue-600 text-white' : 'bg-black/50 text-gray-400 hover:text-white'
                            }`}
                        >
                            {isSelected ? <CheckSquare size={16}/> : <Square size={16}/>}
                        </button>
                     </div>

                     {/* Drag Handle Indicator (Visual only, whole card is draggable) */}
                     <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 opacity-0 group-hover:opacity-100 transition-opacity cursor-move bg-black/50 px-2 py-0.5 rounded-full">
                         <GripVertical size={12} className="text-gray-400" />
                     </div>

                     {/* Action Menu (Top Right) */}
                     <div className="absolute top-2 right-2 z-20 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                        <button 
                             onClick={() => handleDuplicateFrame(frame)}
                             className="p-1.5 bg-black/60 text-gray-300 hover:text-white hover:bg-blue-600 rounded backdrop-blur-md transition-colors"
                             title="复制分镜"
                        >
                             <Copy size={14} />
                        </button>
                        <button 
                             onClick={(e) => {
                                 e.stopPropagation();
                                 if(confirm('确定删除此分镜吗？')) {
                                     setSelectedFrameIds([frame.id]); // Hack to reuse delete logic
                                     // Actually simpler to just call logic directly but let's be safe
                                     const newFrames = currentEpisode.frames.filter(f => f.id !== frame.id).map((f, i) => ({...f, index: i}));
                                     handleUpdateEpisode(currentProject.id, currentEpisode.id, { frames: newFrames });
                                 }
                             }}
                             className="p-1.5 bg-black/60 text-gray-300 hover:text-red-400 hover:bg-gray-800 rounded backdrop-blur-md transition-colors"
                             title="删除分镜"
                        >
                             <Trash2 size={14} />
                        </button>
                     </div>


                     {/* Image Area */}
                     <div className="aspect-video bg-gray-950 relative group/image">
                       {frame.imageUrl ? (
                         <img src={frame.imageUrl} alt="Storyboard" className="w-full h-full object-cover pointer-events-none" />
                       ) : (
                         <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-600 p-6 text-center pointer-events-none">
                            <ImageIcon size={32} className="mb-2 opacity-50"/>
                            <p className="text-xs max-w-xs line-clamp-2">{frame.prompt}</p>
                         </div>
                       )}
                       
                       {(frame.isGenerating || frame.isGeneratingVideo) && (
                         <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-10 flex-col gap-2 pointer-events-none">
                           <Loader2 className="animate-spin text-blue-500 w-8 h-8" />
                           <span className="text-xs text-blue-300 font-medium">{frame.isGeneratingVideo ? '正在生成视频...' : '正在生成图片...'}</span>
                         </div>
                       )}

                       {/* Video Indicator */}
                       {frame.videoUrl && !frame.isGeneratingVideo && (
                          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                              <div className="w-12 h-12 rounded-full bg-black/50 backdrop-blur border border-white/20 flex items-center justify-center">
                                  <Play size={24} fill="white" className="ml-1 text-white"/>
                              </div>
                          </div>
                       )}

                       {/* Quick Action Overlay */}
                       <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/image:opacity-100 transition-opacity flex items-center justify-center gap-2">
                          <button 
                            onClick={() => handleGenerateFrameImage(frame.id, frame.prompt)}
                            className="bg-blue-600 hover:bg-blue-500 text-white p-2 rounded-full shadow-lg flex items-center justify-center"
                            title="生成图片"
                          >
                             <Wand2 size={20} />
                          </button>
                          {frame.imageUrl && (
                              <button 
                                onClick={() => handleGenerateFrameVideo(frame.id)}
                                className="bg-purple-600 hover:bg-purple-500 text-white p-2 rounded-full shadow-lg flex items-center justify-center"
                                title="生成视频"
                              >
                                <Film size={20} />
                              </button>
                          )}
                       </div>
                       
                       {/* Frame Number */}
                       <div className="absolute bottom-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded backdrop-blur-sm border border-white/10 pointer-events-none">
                         #{index + 1}
                       </div>

                       {/* Reference Indicators */}
                       <div className="absolute bottom-2 left-2 flex gap-1 pointer-events-none">
                          {frame.references.characterIds.length > 0 && (
                            <div className="bg-black/60 px-1.5 py-0.5 rounded text-[10px] text-blue-300 flex items-center gap-1 border border-blue-500/30" title="Uses Character Reference">
                               <Users size={8} /> {frame.references.characterIds.length}
                            </div>
                          )}
                          {frame.references.sceneId && (
                            <div className="bg-black/60 px-1.5 py-0.5 rounded text-[10px] text-green-300 flex items-center gap-1 border border-green-500/30" title="Uses Scene Reference">
                               <ImageIcon size={8} /> 1
                            </div>
                          )}
                       </div>
                     </div>

                     {/* Text Content */}
                     <div className="p-4 flex-1 flex flex-col gap-2 relative">
                       {/* Edit Button */}
                       <button 
                         onClick={() => setEditingFrameId(frame.id)}
                         className="absolute top-4 right-4 text-gray-500 hover:text-white transition-colors"
                         title="Edit Prompt & References"
                       >
                          <Edit2 size={16} />
                       </button>

                       <div className="text-xs text-gray-500 uppercase font-bold tracking-wider mb-1">提示词</div>
                       <p 
                          className="text-sm text-gray-300 leading-snug line-clamp-3 hover:line-clamp-none transition-all cursor-text mb-2 pr-6"
                          onClick={() => setEditingFrameId(frame.id)}
                       >
                         {frame.prompt}
                       </p>
                       
                       {/* Dialogue and Audio Section */}
                       <div className="mt-auto bg-gray-900/50 p-2 rounded border border-gray-700/50 flex flex-col gap-2">
                            <div className="flex justify-between items-center">
                                <div className="text-[10px] text-blue-400 font-bold">对白</div>
                                {/* Audio Controls */}
                                <div className="flex items-center gap-1">
                                    {frame.isGeneratingAudio ? (
                                        <Loader2 size={12} className="animate-spin text-yellow-500"/>
                                    ) : frame.audioUrl ? (
                                        <div className="flex items-center gap-2">
                                            <audio src={frame.audioUrl} id={`audio-${frame.id}`} />
                                            <button 
                                                onClick={() => {
                                                    const audio = document.getElementById(`audio-${frame.id}`) as HTMLAudioElement;
                                                    audio?.play();
                                                }}
                                                className="p-1 hover:bg-yellow-600/20 text-yellow-500 rounded transition-colors"
                                                title="Play Audio"
                                            >
                                                <Volume2 size={14} />
                                            </button>
                                             <button 
                                                onClick={() => handleGenerateFrameAudio(frame.id)}
                                                className="p-1 hover:bg-gray-700 text-gray-500 hover:text-white rounded transition-colors"
                                                title="Regenerate Audio"
                                            >
                                                <Mic size={12} />
                                            </button>
                                        </div>
                                    ) : (
                                        <button 
                                            onClick={() => handleGenerateFrameAudio(frame.id)}
                                            className="p-1 hover:bg-gray-700 text-gray-500 hover:text-yellow-500 rounded transition-colors"
                                            title="Generate Audio (TTS)"
                                            disabled={!frame.dialogue && !frame.prompt}
                                        >
                                            <Mic size={14} />
                                        </button>
                                    )}
                                </div>
                            </div>
                            {frame.dialogue ? (
                                <p className="text-xs text-gray-300 italic">"{frame.dialogue}"</p>
                            ) : (
                                <p className="text-[10px] text-gray-600 italic">无对白 (将朗读提示词)</p>
                            )}
                       </div>
                       
                       {/* Reference List (Visual Check) */}
                       {(frame.references.characterIds.length > 0 || frame.references.sceneId) && (
                          <div className="mt-2 flex flex-wrap gap-1">
                             {frame.references.characterIds.map(cid => {
                                const c = currentProject.characters.find(char => char.id === cid);
                                if (!c) return null;
                                return (
                                   <span key={cid} className={`text-[10px] px-1.5 py-0.5 rounded bg-blue-900/30 text-blue-400 border border-blue-800 ${!c.imageUrl ? 'opacity-50 dashed border-gray-700 text-gray-500' : ''}`}>
                                      {c.name}
                                   </span>
                                )
                             })}
                             {frame.references.sceneId && (() => {
                                const s = currentProject.scenes.find(sc => sc.id === frame.references.sceneId);
                                if (!s) return null;
                                return (
                                   <span className={`text-[10px] px-1.5 py-0.5 rounded bg-green-900/30 text-green-400 border border-green-800 ${!s.imageUrl ? 'opacity-50 dashed border-gray-700 text-gray-500' : ''}`}>
                                      {s.name}
                                   </span>
                                )
                             })()}
                          </div>
                       )}
                     </div>
                   </div>
                   );
                 })}
               </div>
             )}

             {/* TIMELINE VIEW */}
             {storyboardViewMode === 'TIMELINE' && (
                <div className="flex flex-col h-full gap-4">
                  {/* Player Window */}
                  <div className="flex-1 bg-black rounded-xl overflow-hidden relative flex flex-col">
                     {/* Video/Image Area */}
                     <div className="flex-1 flex items-center justify-center relative bg-gray-950">
                        {(() => {
                            const frame = currentEpisode.frames[currentPlaybackIndex];
                            if (!frame) return <div className="text-gray-600">无可用分镜</div>;

                            if (frame.videoUrl) {
                                return (
                                    <video 
                                        src={frame.videoUrl} 
                                        className="w-full h-full object-contain"
                                        autoPlay={isPlaying}
                                        controls={false} // Custom controls below
                                        onEnded={handleVideoEnded}
                                        key={`video-${frame.id}`} // Force re-render on change
                                    />
                                );
                            } else if (frame.imageUrl) {
                                return (
                                    <img 
                                        src={frame.imageUrl} 
                                        className="w-full h-full object-contain animate-fadeIn"
                                        alt={`Frame ${frame.index}`}
                                        key={`img-${frame.id}`}
                                    />
                                )
                            } else {
                                return (
                                    <div className="flex flex-col items-center justify-center text-gray-600 p-8 text-center max-w-md">
                                        <ImageIcon size={48} className="mb-4 opacity-30"/>
                                        <p className="text-lg font-medium text-gray-500">尚未生成视觉内容</p>
                                        <p className="text-sm opacity-50 mt-2">{frame.prompt}</p>
                                    </div>
                                )
                            }
                        })()}
                        
                         {/* Loading Overlay */}
                         {(currentEpisode.frames[currentPlaybackIndex]?.isGeneratingVideo) && (
                            <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center z-20">
                                <Loader2 className="animate-spin text-purple-500 w-10 h-10 mb-2"/>
                                <span className="text-white font-medium">正在生成视频...</span>
                            </div>
                         )}

                         {/* Overlay Info */}
                         <div className="absolute top-4 left-4 bg-black/60 px-3 py-1.5 rounded-lg backdrop-blur-md text-white border border-white/10 z-10">
                            <span className="font-bold text-blue-400 mr-2">#{currentPlaybackIndex + 1}</span> 
                            <span className="text-sm opacity-90">
                              {currentEpisode.frames[currentPlaybackIndex]?.dialogue 
                                ? `"${currentEpisode.frames[currentPlaybackIndex].dialogue}"` 
                                : '无对白'}
                            </span>
                         </div>
                         
                         {/* Generate Video Action (If Image Exists but No Video) */}
                         {currentEpisode.frames[currentPlaybackIndex]?.imageUrl && !currentEpisode.frames[currentPlaybackIndex]?.videoUrl && !currentEpisode.frames[currentPlaybackIndex]?.isGeneratingVideo && (
                            <div className="absolute bottom-20 right-8 z-10">
                                <button 
                                    onClick={() => handleGenerateFrameVideo(currentEpisode.frames[currentPlaybackIndex].id)}
                                    className="bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-full shadow-xl flex items-center gap-2 font-medium transition-all hover:scale-105"
                                >
                                    <Film size={18} /> 生成视频
                                </button>
                            </div>
                         )}
                     </div>

                     {/* Controls Bar */}
                     <div className="h-16 bg-gray-900 border-t border-gray-800 flex items-center justify-center gap-6 px-6 shrink-0">
                        <button 
                            className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-full transition-colors"
                            onClick={() => setCurrentPlaybackIndex(Math.max(0, currentPlaybackIndex - 1))}
                        >
                            <SkipBack size={24} />
                        </button>
                        
                        <button 
                            className={`w-12 h-12 rounded-full flex items-center justify-center transition-all ${
                                isPlaying 
                                ? 'bg-red-500 hover:bg-red-600 text-white shadow-lg shadow-red-900/30' 
                                : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/30'
                            }`}
                            onClick={() => setIsPlaying(!isPlaying)}
                        >
                            {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" className="ml-1" />}
                        </button>

                        <button 
                            className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-full transition-colors"
                            onClick={() => setCurrentPlaybackIndex(Math.min(currentEpisode.frames.length - 1, currentPlaybackIndex + 1))}
                        >
                            <SkipForward size={24} />
                        </button>
                     </div>
                  </div>

                  {/* Timeline Strip */}
                  <div className="h-40 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col shrink-0">
                      <div className="px-4 py-2 bg-gray-950 border-b border-gray-800 flex justify-between items-center text-xs font-bold text-gray-500 uppercase tracking-wider">
                         <span>时间轴序列</span>
                         <span>{currentEpisode.frames.length} 分镜</span>
                      </div>
                      <div 
                        ref={timelineScrollRef}
                        className="flex-1 overflow-x-auto overflow-y-hidden flex items-center px-4 gap-3 custom-scrollbar"
                      >
                         {currentEpisode.frames.map((frame, index) => (
                             <div 
                                key={frame.id}
                                className={`flex-shrink-0 w-48 h-28 rounded-lg overflow-hidden border-2 relative group cursor-pointer transition-all ${
                                    currentPlaybackIndex === index 
                                    ? 'border-blue-500 ring-2 ring-blue-500/30 scale-105 z-10' 
                                    : 'border-gray-700 hover:border-gray-500 opacity-60 hover:opacity-100'
                                }`}
                                onClick={() => {
                                    setCurrentPlaybackIndex(index);
                                    setIsPlaying(false);
                                }}
                             >
                                {frame.imageUrl ? (
                                    <img src={frame.imageUrl} className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full bg-gray-800 flex flex-col items-center justify-center text-gray-600 p-2 text-center">
                                        <ImageIcon size={16} className="mb-1"/>
                                        <span className="text-[10px] line-clamp-2">{frame.prompt}</span>
                                    </div>
                                )}

                                {frame.videoUrl && (
                                    <div className="absolute top-1 left-1 bg-purple-600 rounded-full p-1 shadow-md z-10">
                                        <Film size={10} className="text-white"/>
                                    </div>
                                )}
                                
                                <div className="absolute bottom-1 right-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded backdrop-blur-sm">
                                    #{index + 1}
                                </div>

                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setEditingFrameId(frame.id);
                                    }}
                                    className="absolute top-1 right-1 p-1 bg-gray-900/80 text-gray-400 hover:text-white rounded hover:bg-blue-600 transition-colors opacity-0 group-hover:opacity-100"
                                >
                                    <Edit2 size={12} />
                                </button>
                             </div>
                         ))}
                      </div>
                  </div>
                </div>
             )}
          </div>
        )}

        {activeTab === ProjectTab.EXPORT && (
          <div className="h-full flex flex-col items-center justify-center text-center p-8">
             <div className="bg-gray-800 p-8 rounded-2xl border border-gray-700 max-w-lg w-full">
                <Film className="w-16 h-16 text-blue-500 mx-auto mb-6" />
                <h2 className="text-2xl font-bold mb-2">导出项目</h2>
                <p className="text-gray-400 mb-8">
                  准备好进入剪辑软件了吗？导出兼容编辑软件的项目数据或下载所有资产。
                </p>
                
                <div className="space-y-4">
                   <button className="w-full bg-blue-600 hover:bg-blue-500 text-white py-3 rounded-lg font-medium flex items-center justify-center gap-2">
                     <Download size={18} /> 下载 JSON (剪映兼容)
                   </button>
                   <button className="w-full bg-gray-700 hover:bg-gray-600 text-white py-3 rounded-lg font-medium flex items-center justify-center gap-2">
                     <Download size={18} /> 下载所有资产 (ZIP)
                   </button>
                </div>
             </div>
          </div>
        )}
        
        {/* Frame Editor Modal */}
        {editingFrameId && editingFrame && currentProject && (
          <FrameEditorModal 
            frame={editingFrame} 
            project={currentProject} 
            onSave={handleSaveFrameUpdate}
            onClose={() => setEditingFrameId(null)} 
          />
        )}
        
        {/* Asset Editor Modal */}
        {editingAsset && currentProject && (() => {
           const asset = editingAsset.type === 'character' 
             ? currentProject.characters.find(c => c.id === editingAsset.id)
             : currentProject.scenes.find(s => s.id === editingAsset.id);
           if (!asset) return null;
           return (
             <AssetEditorModal 
               asset={asset} 
               type={editingAsset.type} 
               onSave={handleSaveAssetUpdate}
               onClose={() => setEditingAsset(null)}
             />
           );
        })()}
      </Layout>
    );
  }

  return null; // Should not happen
};

export default App;