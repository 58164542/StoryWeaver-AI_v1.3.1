
export enum ViewMode {
  PROJECT_LIST = 'PROJECT_LIST',
  PROJECT_DETAIL = 'PROJECT_DETAIL', // This is now the Episode List view
  EPISODE_DETAIL = 'EPISODE_DETAIL', // This is the Editor view
}

export enum ProjectTab {
  SCRIPT = 'SCRIPT',
  ASSETS = 'ASSETS',
  STORYBOARD = 'STORYBOARD',
  EXPORT = 'EXPORT',
}

export type ProjectType = string;

export interface ProjectTypeInstruction {
  assetImagePrefix: string;      // 角色/变体生图提示词前缀
  sceneImagePrefix: string;      // 场景生图提示词前缀
  storyboardImagePrefix: string; // 分镜生图提示词前缀
  videoGenerationPrefix: string; // 图生视频提示词前缀
  multiRefVideoGenerationPrefix?: string; // 多参考生视频提示词前缀
  characterExtraction: string;   // 角色提取提示词
  sceneExtraction: string;       // 场景提取提示词
  storyboardBreakdown: string;   // 分镜拆解提示词
  preprocessSegmentPrompt: string; // 小说预处理分段提示词
  preprocessSecondPassPrompt?: string; // 预处理二次加工提示词（可选）
}

export interface GlobalSettings {
  extractionModel: string;
  multiRefVideoModel?: string; // 多参考生视频模型
  projectTypePrompts: Record<string, ProjectTypeInstruction>;
  projectTypeLabels?: Record<string, string>; // 项目类型的自定义显示名称
  jianyingExportPath?: string; // 剪映工程导出目录路径
  jianyingExportPathFull?: string; // 剪映工程导出目录完整路径
  defaultImageDuration?: number; // 图片默认时长（秒），默认3秒
  placeholderColor?: string; // 空分镜占位颜色，默认黑色 #000000
  ttsSpeed?: number; // TTS 语速，范围 0.5-2.0，默认 1.0
}

export interface SeedanceSession {
  id: string;
  name: string;
  status: 'active' | 'expired' | 'insufficient' | 'disabled' | 'security_check';
  credits: number | null;
  lastUsed: number;
  currentTasks: number;
  totalTasks: number;
  successCount: number;
  failCount: number;
  maxConcurrent: number;
  createdAt: number;
}

export interface ProjectSettings {
  imageModel: string;           // 资产图像模型（角色/场景/变体生图）
  storyboardImageModel?: string; // 分镜图像模型（分镜帧生图，默认同资产模型）
  videoModel: string;
  ttsModel: string;
  aspectRatio: '16:9' | '9:16' | '1:1' | '4:3' | '3:4';
  videoDuration: number; // 视频时长（秒），范围 2-12
  multiRefVideoMode?: boolean; // 多参考生成：用关联资产图片生成视频
  // imageStyle removed as requested
}

export interface Character {
  id: string;
  name: string;
  aliases?: string[];
  description: string;
  appearance: string;
  personality: string;
  role: 'Protagonist' | 'Antagonist' | 'Supporting';
  imageUrl?: string;

  // MiniMax TTS voice selection for this character
  voiceId?: string;

  progress?: number;  // 0-100
  error?: string;     // 错误信息
}

export interface CharacterVariant {
  id: string;
  characterId: string;  // 所属角色 ID
  name: string;         // 变体名称，如 "东宫大婚·太子妃宫装"
  context?: string;     // 出现场景描述，如 "东宫大婚时"
  appearance: string;   // 变体专属外貌描述
  imageUrl?: string;
  progress?: number;  // 0-100
  error?: string;
}

export interface Scene {
  id: string;
  name: string;
  description: string;
  environment: string;
  atmosphere: string;
  imageUrl?: string;
  progress?: number;  // 0-100
  error?: string;     // 错误信息
}

export interface StoryboardFrame {
  id: string;
  index: number;

  // 分镜拆解输出：区分“生图提示词”和“视频生成提示词”
  imagePrompt: string;
  videoPrompt: string;

  // 兼容旧字段：旧项目/旧数据可能只存在 prompt
  prompt?: string;

  dialogue?: string;
  dialogues?: StoryboardDialogueLine[];
  originalText: string;
  references: {
    characterIds: string[];
    variantIds?: string[];  // 变体资产 ID，用于替代/补充角色参考图
    sceneId?: string;       // 旧字段，向后兼容（单场景）
    sceneIds?: string[];    // 新字段，支持多场景
  };
  imageUrl?: string;
  githubImageUrl?: string; // GitHub 上传后的 HTTP URL（用于 Seedance 2.0）
  isGenerating?: boolean;
  isGeneratingVideo?: boolean;
  isGeneratingAudio?: boolean;
  videoUrl?: string;
  audioUrl?: string;
  audioDuration?: number; // 音频实际时长（秒）
  videoDuration?: number; // 视频实际长（秒）
  imageProgress?: number;  // 0-100
  videoProgress?: number;  // 0-100
  audioProgress?: number;  // 0-100
  videoTaskStatus?: 'waiting' | 'loading'; // 视频任务状态：排队中/生成中
  videoQueuePosition?: number; // 视频任务在队列中的位置（从 1 开始，不含当前运行中的任务）
  seedanceTaskId?: string; // Seedance 微服务任务 ID，用于刷新/重启后恢复轮询
  seedanceTaskUpdatedAt?: number; // 最近一次 Seedance 任务状态更新时间
  imageError?: string;     // 图片生成错误
  videoError?: string;     // 视频生成错误
  audioError?: string;     // 音频生成错误
}

export interface Episode {
  id: string;
  name: string;
  scriptContent: string;
  frames: StoryboardFrame[];
  updatedAt?: number;
  isProcessing?: boolean;  // 该分集是否正在处理（资产提取/分镜拆解等）
  preprocessSegmentFailed?: boolean; // 小说预处理分段失败，当前 scriptContent 为回退原文
}

export interface Project {
  id: string;
  name: string;
  type: ProjectType;
  settings: ProjectSettings;
  createdAt: number;
  updatedAt: number;
  thumbnailUrl?: string;
  characters: Character[];
  variants: CharacterVariant[];  // 角色变体资产（如服装变体）
  scenes: Scene[];
  episodes: Episode[];
}

export interface AnalysisResult {
  characters: Omit<Character, 'id'>[];
  scenes: Omit<Scene, 'id'>[];
  variants?: Array<{
    characterName: string;  // 对应角色的 name
    name: string;
    context?: string;
    appearance: string;
  }>;
}

export interface StoryboardDialogueLine {
  speakerName?: string; //
  text: string;
}

export interface StoryboardBreakdownFrame {
  // 分镜拆解输出：区分“生图提示词”和“视频生成提示词”
  imagePrompt: string;
  videoPrompt: string;

  // 兼容旧字段：旧服务/旧数据可能只存在 prompt
  prompt?: string;

  dialogue?: string;
  dialogues?: StoryboardDialogueLine[];
  originalText: string;
  characterNames?: string[];
  variantNames?: string[];  // 变体资产名称，如 "东宫大婚·太子妃宫装"
  sceneName?: string;   // 旧字段，向后兼容
  sceneNames?: string[]; // 新字段，支持多场景匹配
}

export interface StoryboardBreakdown {
  frames: StoryboardBreakdownFrame[];
}
