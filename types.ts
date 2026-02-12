
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

export type ProjectType = 'REAL_PERSON_COMMENTARY' | 'COMMENTARY_2D' | 'COMMENTARY_3D' | 'PREMIUM_2D' | 'PREMIUM_3D';

export interface ProjectTypeInstruction {
  storyboardImagePrefix: string; // 分镜生图提示词前缀
  videoGenerationPrefix: string; // 图生视频提示词前缀
  characterExtraction: string;   // 角色提取提示词
  sceneExtraction: string;       // 场景提取提示词
}

export interface GlobalSettings {
  extractionModel: string;
  projectTypePrompts: Record<ProjectType, ProjectTypeInstruction>;
}

export interface ProjectSettings {
  imageModel: string;
  videoModel: string;
  ttsModel: string;
  aspectRatio: '16:9' | '9:16' | '1:1' | '4:3' | '3:4';
  // imageStyle removed as requested
}

export interface Character {
  id: string;
  name: string;
  description: string;
  appearance: string;
  personality: string;
  role: 'Protagonist' | 'Antagonist' | 'Supporting';
  imageUrl?: string;
}

export interface Scene {
  id: string;
  name: string;
  description: string;
  environment: string;
  atmosphere: string;
  imageUrl?: string;
}

export interface StoryboardFrame {
  id: string;
  index: number;
  prompt: string;
  dialogue?: string;
  originalText: string;
  references: {
    characterIds: string[];
    sceneId?: string;
  };
  imageUrl?: string;
  isGenerating?: boolean;
  isGeneratingVideo?: boolean;
  isGeneratingAudio?: boolean;
  videoUrl?: string;
  audioUrl?: string;
}

export interface Episode {
  id: string;
  name: string;
  scriptContent: string;
  frames: StoryboardFrame[];
  updatedAt?: number;
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
  scenes: Scene[];
  episodes: Episode[];
}

export interface AnalysisResult {
  characters: Omit<Character, 'id'>[];
  scenes: Omit<Scene, 'id'>[];
}

export interface StoryboardBreakdownFrame {
  prompt: string;
  dialogue?: string;
  originalText: string;
  characterNames?: string[];
  sceneName?: string;
}

export interface StoryboardBreakdown {
  frames: StoryboardBreakdownFrame[];
}
