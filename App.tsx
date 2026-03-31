import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  Project, Episode, ViewMode, ProjectTab, Character, Scene, StoryboardFrame, ProjectType, ProjectSettings, GlobalSettings, ProjectTypeInstruction, StoryboardDialogueLine, CharacterVariant, SeedanceSession, AnalysisResult
} from './types';
import { Layout } from './components/Layout';
import { analyzeNovelScript as analyzeNovelScriptGemini, generateStoryboardBreakdown as generateStoryboardBreakdownGemini, generateImageAsset, generateVideoFromImage, generateSpeech } from './services/geminiService';
import { analyzeNovelScript as analyzeNovelScriptVolcengine, checkVolcengineConnectivity, generateStoryboardBreakdown as generateStoryboardBreakdownVolcengine, generateVideoWithVolcengine, rewriteImagePromptForPolicyCompliance } from './services/volcengineService';
import { generateVideoWithSeedance, generateVideoWithSeedanceMultiRef } from './services/seedanceService';
import { generateVideoWithSora } from './services/soraService';
import { generateVideoWithKlingOmni } from './services/klingService';
import { pollJimengSeedanceTask, submitJimengSeedanceImageToVideoTask, submitJimengSeedanceMultiRefTask, getActiveTasks, ActiveTask } from './services/jimengSeedanceService';
import { generateVideoWithBltcySora, generateVideoWithBltcyVeo3, generateVideoWithBltcyWan26, generateVideoWithBltcyGrokVideo3 } from './services/bltcySoraService';
import { generateImageWithBananaPro } from './services/bananaProService';
import { generateImageWithVolcengine } from './services/volcengineImageService';
import { generateImageWithBltcyBanana2 } from './services/bltcyOneApiImageService';
import { generateImageWithBltcyNanoBananaHd, generateImageWithBltcyNanoBananaPro } from './services/bltcyNanoBananaHdImageService';
import { exportToJianying } from './services/jianyingService';
import { Logger } from './utils/logger';
import { taskQueue } from './utils/taskQueue';
import { splitNovelIntoEpisodes, detectEpisodeTitles } from './utils/novelSplitter';
import { analyzeNovelScriptWithClaude, generateStoryboardBreakdownWithClaude, segmentEpisodeWithClaude, checkClaudeConnectivity, type SegmentEpisodeResult } from './services/claudeService';
import { createDuplicatedProject } from './utils/projectDuplication.js';
import { PREPROCESS_SEGMENT_CONCURRENCY, mapWithConcurrencyLimit } from './utils/segmentConcurrency.js';
import { buildEpisodeFromPreprocessResult, getFailedPreprocessEpisodes } from './utils/preprocessSegmentation.js';
import { buildProjectStatsSummary } from './utils/projectStatsView.js';
import { buildProjectTextUsagePayload } from './utils/projectTextUsage.js';
import { generateFrameAudioWithMinimax } from './services/ttsService';
import { Loader2, Plus, Trash2, Save, Wand2, Image as ImageIcon, Play, Pause, SkipBack, SkipForward, Download, Users, Film, ArrowLeft, FileText, Clock, Settings, X, Link, Edit2, Check, LayoutGrid, Clapperboard, ChevronRight, ChevronLeft, Globe, Copy, CheckSquare, Square, GripVertical, MoreHorizontal, Volume2, Mic, AlertCircle, RefreshCw, Eye, Upload, Search } from 'lucide-react';
import * as apiService from './services/apiService';

// Default Settings
const DEFAULT_SETTINGS: ProjectSettings = {
  imageModel: 'nano-banana-pro-vt',
  videoModel: 'doubao-seedance-1-5-pro-251215',
  ttsModel: 'minimax-speech-2.6-hd',
  aspectRatio: '16:9',
  videoDuration: 5,
};

const DEFAULT_PROJECT_PROMPTS = {
    storyboardImagePrefix: '电影级分镜，高质量，细节丰富',
    videoGenerationPrefix: '高质量视频，电影感，流畅的动作',
    multiRefVideoGenerationPrefix: '',
    characterExtraction: '请分析文本，提取主要角色。输出字段：name（禁止括号注释）、aliases（脚本中出现的别名别称）、description、role、appearance（完整的角色基础形象：体态外貌+日常常服，常服/日常装束归入此字段而非变体）、personality。同时提取角色的服装变体（variants）：仅提取文本中明确标注了"变体XX"编号的条目（如"变体01"、"变体02"、"#### 变体"），characterName（对应角色name）、name（变体名）、context（出现场景）、appearance（变体专属外貌含衣着细节）。常服/日常服装不得作为变体提取。',
    sceneExtraction: '请分析文本，提取主要场景。关注环境描写、氛围和光影。',
};

const DEFAULT_PREPROCESS_SEGMENT_PROMPT = `# 角色与任务
你是一位专业的AI视频分镜师与提示词工程师。你的任务是根据输入的【小说章节文案】，结合【故事情节】与【角色信息】，生成高质量、逻辑严密且符合物理规律的**分镜描述（Prompt）**与**视频生成提示词（Video Prompt）**。每1000字小说文案默认输出至少15个以上分镜；但若触发了【第4条·镜头精简与合并原则】，允许密度降至15个以下（不低于10个/1000字）。不要生成旁白内容，保留人物角色的内心OS（OS需要使用第一人称）。

# 输入信息

**故事情节：**
{{故事情节}}

**角色信息：**
{{角色信息}}

**场景信息：**
{{场景信息}}

**小说原文：**
{{小说原文}}

**推文文案：**
{{推文文案}}

**章节文案前分镜信息：**
{{前面分镜:2}}

**章节文案后分镜信息：**
{{后面分镜:2}}

**章节文案：**
{{章节文案}}


# 核心执行逻辑与原则

### 1. 零容忍原则（必须严格遵守）
* **对话原文锁定**：如果章节文案中包含对话，**必须100%逐字引用原文**，严禁修改一个字，严禁增加原文没有的对话。
* **违禁词清洗**：输出结果中严禁出现血腥、暴力、色情、低俗及政治敏感词汇。
* *处理方式*：检测到违禁概念时，自动替换为符合剧情逻辑的中性描述（例："嘴角流血"→"紧咬下唇，面色苍白"；"砍头"→"重击倒地"）。
* **格式标点**：所有输出内容的对话部分，必须使用中文双引号 \`""\`，**严禁**使用英文双引号 \`""\`。
* **场景信息**：给出的场景信息，必须对应，然后一字不改的放到我需要的位置。


### 2. 连贯性与物理逻辑（六维一致性）
* **状态继承**：当前分镜的起始状态（人物姿势、物品位置、伤痕状态）必须完美承接上一分镜的结束状态。
* **时空统一**：相邻分镜的光影（晨/午/晚）、天气、背景细节必须保持一致，除非有明确的时间跳跃描述。
* **口型同步**：
* 有台词时：角色必须有"张嘴说话、嘴唇闭合"的描述，且镜头必须保持稳定（不推拉）。
* 无台词时：严禁出现张嘴说话的动作描述。
* *内心OS*：角色嘴巴不动，仅通过表情或画外音表现。

### 3. 分镜增加原则与台词时长适配规则

#### A. 自动增加镜头
当出现以下任一情况时，必须自动增加分镜数量，禁止强行压缩到同一镜头：
1. **场景切换**：地点变化、时间变化、白天/夜晚切换。
2. **角色切换**：说话人变化、主视角变化、新角色登场。
3. **动作切换**：站起、转身、奔跑、跌倒、递东西、开门等关键动作。
4. **情绪切换**：平静→震惊、隐忍→爆发、冷笑→落泪等。
5. **信息重点**：出现关键道具、证据、手机画面、热搜、合同、诊断书等必须单独给镜头。
6. **对话过长**：同一段台词超过口播舒适时长，必须拆镜。

#### B. 台词时长硬约束（必须遵守）
* 单个分镜内若含明显可说出的完整台词，台词长度必须与镜头时长匹配。
* **默认规则**：
  * 0-3秒：适合短句（约 10-18 字）
  * 4-8秒：适合中短句（约 18-35 字）
  * 9-15秒：适合完整表达（约 35-60 字）
* 如果原文台词明显超过当前镜头可承载时长，**必须拆分为两个或多个连续分镜**，严禁把超长对白硬塞进 3-5 秒镜头。
* 拆分长对白时，必须保持：
  * 说话人连续一致
  * 情绪递进一致
  * 镜头角度可变化，但语义必须完整衔接

### 4. 镜头精简与合并原则（用于避免无意义碎镜）
满足以下条件时，允许合并镜头，以提升节奏流畅性：
1. 同一角色在同一地点连续进行弱变化动作（如“抬眼→沉默→攥紧手”）。
2. 同一情绪持续推进，且没有新信息点出现。
3. 没有新增对话、没有新增道具、没有新增角色关系变化。

**但注意：**
* 只要出现【动作切换 / 视角切换 / 关键信息点 / 长对白超时】，就不能合并。
* 精简镜头的目标是“去掉重复信息”，不是“压缩叙事密度”。

### 5. Prompt 生成要求（画面提示词）
每个分镜必须先输出一个用于生成首帧图/分镜图的 **Prompt**，要求：
* 必须包含：**场景 + 镜头景别 + 主体角色 + 动作状态 + 情绪氛围 + 光影/时间信息**。
* 必须明确人物身份，不可只写“男人/女人/女生/男生”，要写角色名。
* 服装、姿势、视线方向必须与上下文连续。
* Prompt 要适合直接用于图像生成，避免抽象空话。

### 6. Video Prompt 生成要求（视频提示词）
每个分镜必须输出与 Prompt 对应的 **Video Prompt**，要求：
* 必须描述：镜头运动、人物动作、表情变化、环境动态。
* 必须符合物理逻辑，动作不能跳变。
* 如果该镜头有对白：镜头尽量稳，强调口型与表情。
* 如果该镜头无对白：可增加适度运镜与氛围动作。
* 禁止写成抽象风格词堆砌，必须是可执行的镜头描述。

### 7. 输出格式要求（必须严格一致）
每个分镜必须按如下格式输出，不得增加解释：

1_【Prompt】
::~FIELD::~_[这里填写首帧图 Prompt]_::~FIELD::~_
【VideoPrompt】
场景：[场景信息原文粘贴]
衔接前置指令：[与上一镜的状态衔接]
【0-3秒】镜头：[动作/表情/运镜]；音效：[可选]
【4-8秒】镜头：[动作/表情/运镜]；音效：[可选]
【9-15秒】镜头：[动作/表情/运镜]；音效：[可选]
_::~RECORD::~_

---

# 开始执行
请严格按照以上格式与逻辑，解析输入的章节文案并生成结果。`;

const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  extractionModel: 'doubao-seed-2-0-pro-260215',
  preprocessModel: 'claude-sonnet-4-6',
  jianyingExportPathFull: '',
  projectTypeLabels: {
    'REAL_PERSON_COMMENTARY': '真人解说漫',
    'COMMENTARY_2D': '2D解说漫',
    'COMMENTARY_3D': '3D解说漫',
    'PREMIUM_2D': '2D精品',
    'PREMIUM_3D': '3D精品',
  },
  projectTypePrompts: {
    'REAL_PERSON_COMMENTARY': {
        assetImagePrefix: '真人实拍风格，写实摄影，4k分辨率，细腻的皮肤质感，自然光，角色参考图',
        sceneImagePrefix: '写实场景，真实世界环境，自然光照，写实摄影，4k分辨率，细腻质感',
        storyboardImagePrefix: '真人实拍风格，写实摄影，4k分辨率，细腻的皮肤质感，自然光',
        videoGenerationPrefix: '写实风格，真人电影感，自然的微表情',
        multiRefVideoGenerationPrefix: '',
        characterExtraction: '提取适合真人扮演的角色特征，输出字段：name（禁止括号注释）、aliases（脚本中出现的别名别称）、description、role、appearance（完整基础形象：面部五官、发型、体态+日常常服/默认服装）、personality。同时提取角色外貌变体（variants）：【变体识别规则】仅提取文本中明确标注了"变体XX"编号的条目（如"变体01""变体02""#### 变体"格式），常服/日常装束/默认服装归入主体 appearance 而非变体；每个变体输出 characterName、name（变体名）、context（出现场景）、appearance（变体专属外貌含衣着配饰）。',
        sceneExtraction: '提取写实的场景描述，关注真实世界的物理环境和光照。',
        storyboardBreakdown: '将文本拆解为真人实拍分镜。注重镜头语言的写实性，包括景别（特写、中景、全景）、机位（平视、仰视、俯视）和运镜方式（推拉摇移）。每个分镜应包含明确的演员表演指导和场景调度，适合真人拍摄执行。',
        preprocessSegmentPrompt: `# 角色与任务
你是一位专业的AI视频分镜师与提示词工程师。你的任务是根据输入的【小说章节文案】，结合【故事情节】与【角色信息】，生成高质量、逻辑严密且符合物理规律的**分镜描述（Prompt）**与**视频生成提示词（Video Prompt）**。每1000字小说文案默认输出至少15个以上分镜；但若触发了【第4条·镜头精简与合并原则】，允许密度降至15个以下（不低于10个/1000字）。不要生成旁白内容，保留人物角色的内心OS（OS需要使用第一人称）。

# 输入信息

**故事情节：**
{{故事情节}}

**角色信息：**
{{角色信息}}

**场景信息：**
{{场景信息}}

**小说原文：**
{{小说原文}}

**推文文案：**
{{推文文案}}

**章节文案前分镜信息：**
{{前面分镜:2}}

**章节文案后分镜信息：**
{{后面分镜:2}}

**章节文案：**
{{章节文案}}


# 核心执行逻辑与原则

### 1. 零容忍原则（必须严格遵守）
* **对话原文锁定**：如果章节文案中包含对话，**必须100%逐字引用原文**，严禁修改一个字，严禁增加原文没有的对话。
* **违禁词清洗**：输出结果中严禁出现血腥、暴力、色情、低俗及政治敏感词汇。
* *处理方式*：检测到违禁概念时，自动替换为符合剧情逻辑的中性描述（例："嘴角流血"→"紧咬下唇，面色苍白"；"砍头"→"重击倒地"）。
* **格式标点**：所有输出内容的对话部分，必须使用中文双引号 \`""\`，**严禁**使用英文双引号 \`""\`。
* **场景信息**：给出的场景信息，必须对应，然后一字不改的放到我需要的位置。


### 2. 连贯性与物理逻辑（六维一致性）
* **状态继承**：当前分镜的起始状态（人物姿势、物品位置、伤痕状态）必须完美承接上一分镜的结束状态。
* **时空统一**：相邻分镜的光影（晨/午/晚）、天气、背景细节必须保持一致，除非有明确的时间跳跃描述。
* **口型同步**：
* 有台词时：角色必须有"张嘴说话、嘴唇闭合"的描述，且镜头必须保持稳定（不推拉）。
* 无台词时：严禁出现张嘴说话的动作描述。
* *内心OS*：角色嘴巴不动，仅通过表情或画外音表现。

### 3. 分镜增加原则与台词时长适配规则

#### A. 自动增加镜头
默认基础时长为15秒。**但是**，如果当前【章节文案】中的对话内容过长、动作过于复杂，导致无法在15秒内自然演绎完成，**必须自动调整增加分镜**（例如将该分镜拆解为两个分镜），以确保表演节奏自然，严禁为了凑时长而加速念词或压缩表演。

#### B. 台词时长适配规则（核心重要规则！！！）
当角色有台词时，**必须先计算台词所需的秒数**，再安排分镜内其他镜头的时间分配。严禁拍脑袋随意分配，必须先算后排。

**第一步：计算台词所需秒数**

根据角色情绪和场景情境判断语速档位，再按字数计算：

| 语速档位 | 适用情境 | 语速 | 示例 |
|---------|---------|------|------|
| **快速** | 争吵、催促、惊慌、连珠炮式质问 | 约5-6字/秒 | "你疯了吗你知不知道你在做什么！"（14字≈3秒） |
| **正常** | 日常对话、陈述、命令、通知 | 约3-4字/秒 | "把兵符给我，我还能求陛下留你全尸。"（16字≈4-5秒） |
| **慢速** | 威胁、深情、悲伤、咬牙切齿、意味深长 | 约2-3字/秒 | "凌修……凌修在哪里？"（9字≈3-4秒，因虚弱+沙哑+停顿） |

**第二步：根据台词秒数安排分镜时间轴**

计算出台词所需秒数后，用15秒减去台词秒数，得到剩余可分配秒数，再安排其他镜头内容。

示例：
\`\`\`
台词："查！给我查！就算是把整个京城翻过来，也要把那个暗中下手的贼子给我揪出来！"
→ 字数：35字，情绪：暴怒命令，语速档位：正常偏快（约4字/秒）
→ 台词所需时间：约9秒
→ 剩余可分配时间：15-9 = 6秒
→ 分镜安排：【0-3秒】铺垫动作 +【4-12秒】台词镜头（9秒）+【13-15秒】收尾反应
\`\`\`

**第三步：超长台词的拆分规则**

如果单段台词计算后超过12秒（即剩余时间不足3秒，无法安排任何铺垫或收尾），则：
* **方案一**：该分镜只放这一段台词，成为"单台词分镜"（如【0-12秒】全部给台词，【13-15秒】给一个极简收尾）
* **方案二**：将台词按自然断句拆为两个分镜（如角色先说前半句，下一个分镜接后半句），每个分镜都有合理的铺垫和收尾空间

选择标准：如果台词内容有自然断点（如两句话之间有语气转折），优先方案二拆分；如果台词是一气呵成不可断的整句，用方案一。

**第四步：多人对话的处理**

同一个分镜内如果有多人对话（A说→B回应），按以下方式处理：
* 分别计算每人台词所需秒数
* 两人台词秒数之和 + 至少2秒切镜/反应时间 = 该分镜总需时长
* 若总需时长 ≤ 15秒：合并在同一分镜内
* 若总需时长 > 15秒：拆为两个分镜（A说一个分镜，B回应一个分镜）

### 4. 镜头精简与合并原则（核心重要规则！！！）

本产品用于AI漫剧短视频制作，每一个分镜都会消耗制作成本和观众注意力。**严禁出现"空泛镜头"**——即没有台词、没有内心OS、也没有关键剧情推进动作的镜头独占一整个15秒分镜。

#### A. 镜头价值判定标准
每个分镜在生成前，必须先判定它是否具有**高价值内容**。高价值内容的定义（至少满足其一）：
1. **有人物台词**（说话的镜头）
2. **有人物内心OS**（第一人称心理活动）
3. **有关键剧情动作**（打斗、突破、拥抱、跪下、摔倒等推动剧情发展的肢体动作）
4. **有强烈情绪转折**（角色表情发生显著变化，如从镇定到恐惧、从愤怒到崩溃）

#### B. 低价值内容的处理方式
以下内容**不可以**单独成为一个15秒分镜，必须合并到相邻分镜中作为其中一个时间段：
* 纯氛围铺垫（如"府内下人来回奔走"、"茶客低声议论"等群演画面）
* 纯环境展示（如"侯府大门紧闭"、"空旷的书房"等空镜/定场镜头）
* 纯过渡衔接（如"角色从A走到B"、"角色站起/坐下"等无内容的位移动作）
* 信息重复（如上一镜已经表达过"愤怒"，下一镜继续同样的"愤怒"而没有新的台词或情节推进）

**具体合并方式**：将低价值内容压缩为相邻高价值分镜中的**前3-5秒**（作为铺垫段）或**后3-5秒**（作为收尾段），而不是单独占用一个完整分镜。

#### C. 合并判定流程（生成每个分镜前必须执行）
\`\`\`
Step 1：本分镜是否包含台词/内心OS/关键动作/情绪转折？
  → 是：正常生成为独立分镜。
  → 否：进入Step 2。
Step 2：本分镜的内容能否作为前一个分镜的"收尾3-5秒"？
  → 能：合并到前一个分镜的尾部。
  → 不能（例如场景切换）：进入Step 3。
Step 3：本分镜的内容能否作为后一个分镜的"开头3-5秒"？
  → 能：合并到后一个分镜的头部。
  → 不能：极少数情况，允许独立存在，但时间压缩到5-8秒，严禁拉满15秒。
\`\`\`

#### D. 合并示例

**❌ 错误做法（空泛镜头独占分镜）**：
\`\`\`
分镜5：姜问天拳头砸案台，案面出现裂纹，亲信退出书房，姜问天独自喘息。（15秒，无台词无OS，纯氛围）
分镜6：姜池瑶躺在床上，双目无神，床头药汤已冷，下人经过门外。（15秒，无台词无OS，纯氛围）
→ 问题：两个镜头共30秒，既没有台词也没有内心OS，观众看30秒"空画面"会快速划走。
\`\`\`

**✅ 正确做法（合并压缩 + 内容填充）**：
\`\`\`
分镜5（合并后）：
【0-4秒】镜头：中景侧拍，书房内亲信低头鱼贯退出，姜问天独自撑着裂开的案台喘息；音效：脚步声远去+粗重喘息声；
【5-10秒】镜头：画面切至姜池瑶卧室，中景平拍，姜池瑶面色苍白卧于床上，双目无神，烛光映出空洞眼神；音效：烛火噼啪声+极轻风声；
【11-15秒】镜头：特写姜池瑶的眼睛，突然闪过一丝微光，目光从空洞变为锐利；音效：低沉心跳声；（姜池瑶内心OS）"所有人都在慌……可慌有什么用，我必须自己想。"
→ 同样的内容压缩到一个分镜内，末段有内心OS驱动剧情前进，观众不会觉得空。
\`\`\`

#### E. 15秒分配的优先级排序
当一个分镜内有多个内容需要分配时间时，按以下优先级排序：
1. **台词** → 最高优先，根据字数匹配秒数（约3-4字/秒的语速），必须给够时间
2. **内心OS** → 次高优先，同样按字数匹配秒数
3. **关键动作** → 中等优先，需给出动作完成的合理时间
4. **氛围/环境/过渡** → 最低优先，压缩到3-5秒，绝不单独占满15秒


### 5. 输出结构规范
任务需遍历输入中的每一条【章节文案】，生成对应的记录。每条记录包含三个字段，严格使用指定分隔符：
\`序号_::~FIELD::~_图片提示词_::~FIELD::~_视频提示词_::~RECORD::~_\`

#### A. 图片提示词 (Prompt) 规范
* **内容**：纯视觉描述，包含地点、时间、光线、景别、核心动作。
* **限制**：**不需要**列出角色映射（如 \`@zdh...\`），**严禁**包含任何乱七八糟的字符或非视觉描述。

#### B. 视频提示词 (Video Prompt) 规范
* **结构要求**：必须包含以下两部分：
1. **场景与衔接**：复述场景信息，并显式写出\`衔接前置指令\`（思考上一镜结尾如何过渡到本镜）。
2. **分镜脚本**：严格按时间轴的描述进行，禁止时长超过15秒，请合理安排分镜脚本。

---

# 视频提示词标准模板（默认15秒以内，不可超过）


**场景基础信息**：
场景：[直接复制输入的场景信息]，[补充时间/光线/氛围]。
衔接前置指令：承接上镜结尾[描述上一镜结束时的动作/状态]，本镜开始时[描述本镜起始状态，确保连贯]。

**时间轴脚本（每个镜头的时间以及镜头数量无需固定，但镜头总体时间不能超过15秒，以及单个镜头的时间必须适配画面以及人物台词说话的语速。例如：【镜头：特写陆承煜冷漠的脸，没有半分温情；音效：指尖掐进皮肉的紧绷声；（陆承煜说）"凝霜，你爹通敌叛国，苏家满门抄斩就在眼前，把兵符给我，我还能求陛下留你全尸。"】，那么该镜头就需要大概9秒左右的时间，那么剩下6秒的时间请合理分配给下一个镜头，如若下一个镜头也是长时间的镜头（超过剩余的分镜秒数），则该分镜可以只出现这么一个单一镜头，也就是该分镜的脚本格式如下：【0-9秒】镜头：特写陆承煜冷漠的脸，没有半分温情；音效：指尖掐进皮肉的紧绷声；（陆承煜说）"凝霜，你爹通敌叛国，苏家满门抄斩就在眼前，把兵符给我，我还能求陛下留你全尸。"）**：
**【0-3秒】**镜头：[景别]+[核心动作]；音效：[主音效]+[环境音]；[台词（必须用""）/画外音/内心OS]
**【4-8秒】**镜头：[镜头切换/互动反应]；音效：[关键音效]；[台词（必须用""）/画外音]
**【9-12秒】**镜头：[情绪特写/细节展示]；音效：[氛围音]；[台词/画外音/沉默说明]
**【13-15秒】**镜头：[下一镜铺垫/留白]；音效：[过渡音/渐弱]

---

# 输出示例（Reference）

1_【Videoprompt】
::~FIELD::~_CBD写字楼办公室内，晚上。中景镜头：拍摄林辰手抱一叠厚厚的打印文件，背景是现代化写字楼冰冷的大理石地面和反光的玻璃幕墙，突出夜晚的空旷与压抑。_::~FIELD::~_
场景：CBD写字楼办公室内，晚上，走廊灯光昏暗，背景是冰冷的大理石地面和反光的玻璃幕墙，营造夜晚的空旷与压抑氛围。
衔接前置指令：作为首个镜头，确立深夜加班基调，林辰状态疲惫，抱着文件准备离开。
【0-3秒】镜头：中景跟拍，林辰双手环抱一叠半人高的打印文件，脚步虚浮地走在写字楼走廊；音效：脚步声沉重拖沓+文件轻微晃动声；（林辰内心OS）"下午刚定稿，又要重打…"
【4-8秒】镜头：中景侧拍，特写他垂在身侧的左手，手腕上运动手环显示"23:42"，突然脚下踉跄；音效：心率预警声"滴滴"+文件滑落"哗啦"声；（林辰说）"就不能让我喘口气吗..."
【9-12秒】镜头：中景俯拍，林辰蹲下身捡文件，手指慌乱地捋顺，却不小心把页码弄乱；音效：手指摩擦纸张"沙沙"声+顶灯"滋滋"电流声；（林辰内心OS）"这工作什么时候是个头..."
【13-15秒】镜头：中景固定，林辰抱着整理好的文件重新站起，望向窗外雨夜；音效：窗外闷雷声；（林辰内心OS）"明天还要继续..."
_::~RECORD::~_

2_【Videoprompt】
::~FIELD::~_CBD写字楼办公室内，晚上。低角度特写：拍摄张岚傲慢地停在林辰身边，一只涂着深红指甲油的手递出一份文件，林辰接过时指关节因用力而泛白。_::~FIELD::~_
场景：CBD写字楼办公室内，晚上，走廊灯光昏暗，延续上镜的压抑氛围。
衔接前置指令：承接上镜结尾（林辰刚站稳），张岚突然入画，打断了林辰的思绪，制造冲突。
【0-4秒】镜头：低角度特写，一双黑色尖头高跟鞋重重踩在林辰脚边，镜头上移至张岚冷漠的脸；音效：高跟鞋"噔噔"声骤停；（张岚内心OS）"看他还能撑多久。"
【5-11秒】镜头：中景侧拍，张岚递出一份新的文件，指甲涂着深酒红色甲油；音效：纸张甩动的脆响；（张岚说）"林辰，这份整改通知，明早8点前，我要看到你手写的整改方案。"
【12-15秒】镜头：特写镜头，聚焦林辰的手指尖刚碰到文件，指关节瞬间绷紧泛白；音效：林辰压抑的呼吸声；（林辰说）"张总监，现在已经10点多了..."
_::~RECORD::~_

---

# 开始执行
请严格按照以上格式与逻辑，解析输入的章节文案并生成结果。`,
        preprocessSecondPassPrompt: ''
    },
    'COMMENTARY_2D': {
        assetImagePrefix: '2D平面动画风格，线条清晰，色彩鲜艳，夸张的表情，角色参考图',
        sceneImagePrefix: '2D平面动画背景，线条清晰，色彩鲜艳，扁平风格，背景设计',
        storyboardImagePrefix: '2D平面动画风格，线条清晰，色彩鲜艳，夸张的表情',
        videoGenerationPrefix: '2D动画风格，流畅的帧动画，生动',
        multiRefVideoGenerationPrefix: '',
        characterExtraction: '提取适合2D动画的角色特征，输出字段：name（禁止括号注释）、aliases（脚本中出现的别名别称）、description、role、appearance（完整基础形象：线条特征、发型、体型比例+日常常服/默认服装）、personality。同时提取角色外貌变体（variants）：【变体识别规则】仅提取文本中明确标注了"变体XX"编号的条目（如"变体01""变体02""#### 变体"格式），常服/日常装束归入主体 appearance 而非变体；每个变体输出 characterName、name（变体名）、context（出现场景）、appearance（变体专属外貌含服装视觉风格）。',
        sceneExtraction: '提取适合2D背景的场景描述，关注色彩搭配和构图。',
        storyboardBreakdown: '将文本拆解为2D动画分镜。强调动画的节奏感和表现力，注重角色的夸张表情和动作设计。每个分镜应描述关键帧动作、表情变化和画面构图，适合2D动画制作流程。',
        preprocessSegmentPrompt: DEFAULT_PREPROCESS_SEGMENT_PROMPT,
        preprocessSecondPassPrompt: ''
    },
    'COMMENTARY_3D': {
        assetImagePrefix: '3D动画风格，Blender渲染，皮克斯风格，立体感，柔和的光影，角色参考图',
        sceneImagePrefix: '3D动画场景，Blender渲染，皮克斯风格，立体感，环境光遮蔽，背景设计',
        storyboardImagePrefix: '3D动画风格，Blender渲染，皮克斯风格，立体感，柔和的光影',
        videoGenerationPrefix: '3D动画电影，流畅的动作捕捉，体积光',
        multiRefVideoGenerationPrefix: '',
        characterExtraction: '提取适合3D建模的角色特征，输出字段：name（禁止括号注释）、aliases（脚本中出现的别名别称）、description、role、appearance（完整基础形象：面部结构、发型、身形比例+日常常服/默认服装）、personality。同时提取角色外貌变体（variants）：【变体识别规则】仅提取文本中明确标注了"变体XX"编号的条目（如"变体01""变体02""#### 变体"格式），常服/日常装束归入主体 appearance 而非变体；每个变体输出 characterName、name（变体名）、context（出现场景）、appearance（变体专属外貌含服装3D材质）。',
        sceneExtraction: '提取3D场景描述，关注空间结构和环境光遮蔽。',
        storyboardBreakdown: '将文本拆解为3D动画分镜。注重三维空间的镜头运动和角色在空间中的位置关系。每个分镜应包含虚拟摄像机参数（焦距、景深）、角色动画时长和场景光照设置，适合3D动画制作。',
        preprocessSegmentPrompt: DEFAULT_PREPROCESS_SEGMENT_PROMPT,
        preprocessSecondPassPrompt: ''
    },
    'PREMIUM_2D': {
        assetImagePrefix: '大师级2D插画，新海诚风格，绝美的光影，极高的细节，角色参考图',
        sceneImagePrefix: '大师级2D场景插画，新海诚风格，绝美的光影，极高的细节，唯美背景',
        storyboardImagePrefix: '大师级2D插画，新海诚风格，绝美的光影，极高的细节',
        videoGenerationPrefix: '高预算2D动画电影，唯美意境，粒子特效',
        multiRefVideoGenerationPrefix: '',
        characterExtraction: '提取极具美感的角色设计，输出字段：name（禁止括号注释）、aliases（脚本中出现的别名别称）、description、role、appearance（完整基础形象：唯美风格的面部、发型、整体气质+日常常服/默认服装）、personality。同时提取角色外貌变体（variants）：【变体识别规则】仅提取文本中明确标注了"变体XX"编号的条目（如"变体01""变体02""#### 变体"格式），常服/日常装束归入主体 appearance 而非变体；每个变体输出 characterName、name（变体名）、context（出现场景）、appearance（变体专属外貌含服装艺术风格）。',
        sceneExtraction: '提取宏大的场景描述，关注天气、动态元素和艺术氛围。',
        storyboardBreakdown: '将文本拆解为高品质2D动画分镜。追求电影级的视觉美学，注重光影氛围、色彩情绪和细腻的画面细节。每个分镜应描述唯美的构图、动态的自然元素（云、光、粒子）和角色的微妙情感表达，适合高预算动画电影制作。',
        preprocessSegmentPrompt: DEFAULT_PREPROCESS_SEGMENT_PROMPT,
        preprocessSecondPassPrompt: ''
    },
    'PREMIUM_3D': {
        assetImagePrefix: '好莱坞大片级别，虚幻引擎5渲染，光线追踪，史诗感，角色参考图',
        sceneImagePrefix: '好莱坞大片级别，虚幻引擎5渲染，光线追踪，史诗级场景，宏大环境',
        storyboardImagePrefix: '好莱坞大片级别，虚幻引擎5渲染，光线追踪，史诗感',
        videoGenerationPrefix: '电影级特效，史诗镜头，震撼的视觉冲击',
        multiRefVideoGenerationPrefix: '',
        characterExtraction: '提取复杂的角色设计，输出字段：name（禁止括号注释）、aliases（脚本中出现的别名别称）、description、role、appearance（完整基础形象：史诗级面部特征、发型、体格+日常常服/默认服装）、personality。同时提取角色外貌变体（variants）：【变体识别规则】仅提取文本中明确标注了"变体XX"编号的条目（如"变体01""变体02""#### 变体"格式），常服/日常装束归入主体 appearance 而非变体；每个变体输出 characterName、name（变体名）、context（出现场景）、appearance（变体专属外貌含盔甲/服装好莱坞级别描述）。',
        sceneExtraction: '提取史诗级场景，关注巨大的建筑结构和复杂的气候系统。',
        storyboardBreakdown: '将文本拆解为好莱坞级别的3D分镜。追求史诗级的视觉冲击力，注重宏大的场景规模、复杂的镜头运动和震撼的特效设计。每个分镜应包含电影级的镜头语言、动态的环境效果（爆炸、天气、粒子）和角色的史诗动作，适合AAA级游戏或大片制作。',
        preprocessSegmentPrompt: DEFAULT_PREPROCESS_SEGMENT_PROMPT,
        preprocessSecondPassPrompt: ''
    }
  }
};

// Helper function to get project type label
const getProjectTypeLabel = (type: string, labels?: Record<string, string>): string => {
  if (labels && labels[type]) {
    return labels[type];
  }
  return type;
};

const migrateImageModel = (model?: string) => {
  if (model === 'nano-banana-pro') return 'nano-banana-pro-vt';
  return model ?? DEFAULT_SETTINGS.imageModel;
};

const resolveProjectId = (project: Project & { projectId?: string; _id?: string }) => {
  return project.id ?? project.projectId ?? project._id ?? '';
};

const normalizeProject = (project: Project): Project => ({
  ...project,
  thumbnailUrl: project.thumbnailUrl ? apiService.toAbsoluteApiUrl(project.thumbnailUrl) : project.thumbnailUrl,
  id: resolveProjectId(project as Project & { projectId?: string; _id?: string }),
  // 重置 character/variant/scene 的生成中间状态，防止刷新后按钮永久卡死
  characters: (project.characters ?? []).map(c => ({
    ...c,
    imageUrl: c.imageUrl ? apiService.toAbsoluteApiUrl(c.imageUrl) : c.imageUrl,
    progress: undefined,
    error: undefined
  })),
  variants: (project.variants ?? []).map(v => ({
    ...v,
    imageUrl: v.imageUrl ? apiService.toAbsoluteApiUrl(v.imageUrl) : v.imageUrl,
    progress: undefined,
    error: undefined
  })),
  scenes: (project.scenes ?? []).map(s => ({
    ...s,
    imageUrl: s.imageUrl ? apiService.toAbsoluteApiUrl(s.imageUrl) : s.imageUrl,
    progress: undefined,
    error: undefined
  })),
  settings: {
    ...DEFAULT_SETTINGS,
    ...(project.settings ?? {}),
    imageModel: migrateImageModel(project.settings?.imageModel)
  },
  episodeRecycleBin: project.episodeRecycleBin ?? [],
  episodes: (project.episodes ?? []).map(episode => ({
    ...episode,
    isProcessing: false,
    frames: (episode.frames ?? []).map(frame => {
      // 强制迁移：旧帧只有 prompt，补全 imagePrompt/videoPrompt
      const anyFrame = frame as any;
      const imagePrompt = typeof anyFrame.imagePrompt === 'string' ? anyFrame.imagePrompt : (anyFrame.prompt ?? '');
      const videoPrompt = typeof anyFrame.videoPrompt === 'string' ? anyFrame.videoPrompt : (anyFrame.prompt ?? '');
      return {
        ...frame,
        imageUrl: frame.imageUrl ? apiService.toAbsoluteApiUrl(frame.imageUrl) : frame.imageUrl,
        videoUrl: frame.videoUrl ? apiService.toAbsoluteApiUrl(frame.videoUrl) : frame.videoUrl,
        audioUrl: frame.audioUrl ? apiService.toAbsoluteApiUrl(frame.audioUrl) : frame.audioUrl,
        imagePrompt,
        videoPrompt,
        isGenerating: false,
        isGeneratingVideo: false,
        isGeneratingAudio: false,
        imageProgress: undefined,
        videoProgress: undefined,
        audioProgress: undefined
      };
    })
  }))
});

const normalizeProjects = (projects: Project[]): Project[] => projects.map(normalizeProject);

/**
 * 将图片上传/转存到后端，返回服务端 URL。
 * - Base64 Data URL → uploadMedia（已有逻辑）
 * - 外部 http/https URL → saveExternalImage（转存到本地，避免临时链接过期）
 * - 已是本地服务端 URL → 原样返回
 * 失败时回退到原 URL，不中断流程。
 */
const uploadImageIfBase64 = async (imageUrl: string, filename: string): Promise<string> => {
  if (!imageUrl) return imageUrl;
  if (imageUrl.startsWith('data:')) {
    try {
      const result = await apiService.uploadMedia(imageUrl, filename);
      return result.url;
    } catch (error) {
      console.warn('[uploadImage] Base64 上传失败，保留原值:', error);
      return imageUrl;
    }
  }
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    try {
      const result = await apiService.saveExternalImage(imageUrl, filename);
      return result.url;
    } catch (error) {
      console.warn('[uploadImage] 外链图片转存失败，保留原 URL:', error);
      return imageUrl;
    }
  }
  return imageUrl;
};

/**
 * 将项目中所有 Base64 格式的 imageUrl 上传到服务器并替换为 URL。
 * 用于启动时一次性迁移旧数据，返回是否有字段被修改。
 */
const migrateProjectImages = async (project: Project): Promise<{ migrated: Project; changed: boolean }> => {
  let changed = false;
  const p = { ...project };

  // 迁移 characters
  p.characters = await Promise.all((p.characters || []).map(async (c, ci) => {
    if (!c.imageUrl?.startsWith('data:')) return c;
    const url = await uploadImageIfBase64(c.imageUrl, `char_${p.id}_${ci}_${Date.now()}`);
    changed = true;
    return { ...c, imageUrl: url };
  }));

  // 迁移 variants
  p.variants = await Promise.all((p.variants || []).map(async (v, vi) => {
    if (!v.imageUrl?.startsWith('data:')) return v;
    const url = await uploadImageIfBase64(v.imageUrl, `variant_${p.id}_${vi}_${Date.now()}`);
    changed = true;
    return { ...v, imageUrl: url };
  }));

  // 迁移 scenes
  p.scenes = await Promise.all((p.scenes || []).map(async (s, si) => {
    if (!s.imageUrl?.startsWith('data:')) return s;
    const url = await uploadImageIfBase64(s.imageUrl, `scene_${p.id}_${si}_${Date.now()}`);
    changed = true;
    return { ...s, imageUrl: url };
  }));

  // 迁移 episodes -> frames
  p.episodes = await Promise.all((p.episodes || []).map(async ep => {
    const frames = await Promise.all((ep.frames || []).map(async f => {
      if (!f.imageUrl?.startsWith('data:')) return f;
      const url = await uploadImageIfBase64(f.imageUrl, `frame_${ep.id}_${f.id}_${Date.now()}`);
      changed = true;
      return { ...f, imageUrl: url };
    }));
    return { ...ep, frames };
  }));

  return { migrated: p, changed };
};

/**
 * 将 blob 转换为 JPEG 格式（canvas 重绘）。
 * 用于将 webp 等香蕉Pro不支持的格式转换为 JPEG。
 */
const convertBlobToJpeg = (blob: Blob): Promise<{ data: string; mimeType: string }> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('canvas 不可用')); return; }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(jpegBlob => {
        if (!jpegBlob) { reject(new Error('canvas toBlob 失败')); return; }
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          resolve({ data: result.split(',')[1] ?? '', mimeType: 'image/jpeg' });
        };
        reader.onerror = reject;
        reader.readAsDataURL(jpegBlob);
      }, 'image/jpeg', 0.92);
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('图片加载失败')); };
    img.src = objectUrl;
  });
};

/**
 * 将任意格式的 imageUrl（Base64 Data URL 或服务端 HTTP URL）转换为
 * 生图 API 需要的 { data, mimeType } 格式。
 * - Base64 Data URL：直接拆分；若为 webp 则转 JPEG
 * - HTTP URL：fetch 后转 Base64；若为 webp 则转 JPEG
 */
const imageUrlToRefData = async (
  imageUrl: string
): Promise<{ data: string; mimeType: string } | null> => {
  if (!imageUrl) return null;

  if (imageUrl.startsWith('data:')) {
    const [pfx, data] = imageUrl.split(',');
    const mimeType = pfx.match(/:(.*?);/)?.[1] ?? 'image/jpeg';
    if (!data) return null;
    if (mimeType === 'image/webp') {
      try {
        const blob = await fetch(imageUrl).then(r => r.blob());
        return await convertBlobToJpeg(blob);
      } catch {
        return { data, mimeType }; // 转换失败时回退原格式
      }
    }
    return { data, mimeType };
  }

  if (imageUrl.startsWith('http')) {
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) return null;
      const blob = await response.blob();
      const mimeType = blob.type || 'image/jpeg';
      if (mimeType === 'image/webp') {
        return await convertBlobToJpeg(blob);
      }
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          resolve(result.split(',')[1] ?? '');
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      if (!data) return null;
      return { data, mimeType };
    } catch {
      return null;
    }
  }

  return null;
};

const parseAliasInput = (value: string) => value
  .split(/[,\n，、]/)
  .map(item => item.trim())
  .filter(Boolean);

const extractParentheticalAliases = (value: string) => {
  const aliases: string[] = [];
  const cleaned = value.replace(/[（(]([^）)]+)[）)]/g, (_, alias) => {
    const normalized = String(alias || '').trim();
    if (normalized) aliases.push(normalized);
    return '';
  }).replace(/\s+/g, ' ').trim();
  return { cleaned: cleaned || value.trim(), aliases };
};

const normalizeCharacterInput = (name: string, aliases?: string[]) => {
  const { cleaned, aliases: fromName } = extractParentheticalAliases(name || '');
  const merged = [...(aliases ?? []), ...fromName]
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => item !== cleaned);
  const deduped = Array.from(new Set(merged));
  return { name: cleaned, aliases: deduped };
};

const normalizeForMatch = (value: string) => value.toLowerCase().trim();

const matchesToken = (token: string, query: string) => {
  const a = normalizeForMatch(token);
  const b = normalizeForMatch(query);
  return !!a && !!b && (a.includes(b) || b.includes(a));
};

const matchesCharacter = (character: Character, name: string) => {
  const tokens = [character.name, ...(character.aliases ?? [])];
  return tokens.some(token => matchesToken(token, name));
};

const buildCharacterAssetPrompt = (prefix: string, character: Character): string => {
  const aliasPart = (character.aliases ?? []).length > 0 ? `别名：${character.aliases?.join('、')}` : '';
  const parts = [
    prefix,
    `角色：${character.name}`,
    aliasPart,
    character.appearance,
  ]
    .map(v => String(v ?? '').trim())
    .filter(Boolean);
  return parts.join(', ');
};

const buildVariantAssetPrompt = (prefix: string, variant: CharacterVariant): string => {
  const parts = [
    prefix,
    `变体：${variant.name}`,
    variant.appearance
  ]
    .map(v => String(v ?? '').trim())
    .filter(Boolean);
  return parts.join(', ');
};

const isVolcengineImageModel = (model: string) => model.startsWith('doubao-seedream');
const isBananaProImageModel = (model: string) => model === 'nano-banana-pro' || model === 'nano-banana-pro-vt';
const isBltcyBanana2Model = (model: string) => model === 'bltcy-banana-2';
const isBltcyNanoBananaHdModel = (model: string) => model === 'bltcy-nano-banana-hd';
const isBltcyNanoBananaProModel = (model: string) => model === 'bltcy-nano-banana-pro';

const generateAssetImageWithSelectedModel = async (
  prompt: string,
  model: string,
  projectId: string,
  onProgress: (progress: number) => void
): Promise<string> => {
  if (isBananaProImageModel(model)) {
    return generateImageWithBananaPro(prompt, '16:9', [], '2K', onProgress, model);
  }
  if (isVolcengineImageModel(model)) {
    return generateImageWithVolcengine(prompt, '16:9', [], '2K', onProgress, model);
  }
  if (isBltcyBanana2Model(model)) {
    return generateImageWithBltcyBanana2(prompt, '16:9', [], projectId, onProgress);
  }
  if (isBltcyNanoBananaHdModel(model)) {
    return generateImageWithBltcyNanoBananaHd(prompt, '16:9', [], projectId, onProgress);
  }
  if (isBltcyNanoBananaProModel(model)) {
    return generateImageWithBltcyNanoBananaPro(prompt, '16:9', [], projectId, onProgress);
  }
  return generateImageAsset(prompt, '16:9', model);
};

const isClaudeChatModel = (model: string) => model.startsWith('claude-');

const splitDialogueStringToDialogues = (dialogue?: string): StoryboardDialogueLine[] | undefined => {
  const input = (dialogue ?? '').trim();
  if (!input) return undefined;

  const normalized = input
    .replace(/[“”]/g, '"')
    .replace(/[：:]/g, '：');

  const lines = normalized.split(/\r?\n+/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;

  const result: StoryboardDialogueLine[] = [];
  for (const line of lines) {
    const m = line.match(/^(.{1,20}?)：(.+)$/);
    if (m) {
      const speakerName = m[1].trim();
      const text = m[2].trim().replace(/^"|"$/g, '');
      if (text) result.push({ speakerName, text });
    } else {
      const text = line.replace(/^"|"$/g, '');
      if (text) result.push({ text });
    }
  }

  return result.length > 0 ? result : undefined;
};

const normalizeDialogues = (dialogues?: StoryboardDialogueLine[]): StoryboardDialogueLine[] | undefined => {
  const cleaned: Array<StoryboardDialogueLine | null> = (dialogues ?? []).map(d => {
    const speakerName = (d.speakerName ?? '').trim() || undefined;
    const text = (d.text ?? '').trim();
    if (!text) return null;
    return speakerName ? { speakerName, text } : { text };
  });

  const normalized = cleaned.filter((d): d is StoryboardDialogueLine => d !== null);
  return normalized.length > 0 ? normalized : undefined;
};

const mergeDialoguesToDisplayString = (dialogues?: StoryboardDialogueLine[]): string | undefined => {
  if (!dialogues || dialogues.length === 0) return undefined;
  return dialogues
    .map(d => (d.speakerName ? `${d.speakerName}：${d.text}` : d.text))
    .filter(Boolean)
    .join('\n');
};

const getFrameDialogues = (frame?: StoryboardFrame): StoryboardDialogueLine[] | undefined =>
  normalizeDialogues(frame?.dialogues) ?? splitDialogueStringToDialogues(frame?.dialogue);

const getDialoguesTextOnly = (dialogues?: StoryboardDialogueLine[]): string | undefined => {
  if (!dialogues || dialogues.length === 0) return undefined;
  const text = dialogues.map(d => (d.text ?? '').trim()).filter(Boolean).join('\n').trim();
  return text || undefined;
};

// --- Helper Components ---

// --- Find & Replace Modal ---
interface FindReplaceModalProps {
  projects: Project[];
  currentProject: Project;
  currentEpisode: Episode;
  onReplace: (updates: { projectId: string; episodeId: string; frames: StoryboardFrame[] }[]) => void;
  onClose: () => void;
}

const FindReplaceModal: React.FC<FindReplaceModalProps> = ({ projects, currentProject, currentEpisode, onReplace, onClose }) => {
  const [searchText, setSearchText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [replaceImagePrompt, setReplaceImagePrompt] = useState(true);
  const [replaceVideoPrompt, setReplaceVideoPrompt] = useState(true);
  const [scope, setScope] = useState<'current' | 'all'>('current');

  // Compute match stats
  const matchStats = React.useMemo(() => {
    if (!searchText) return { frameCount: 0, matchCount: 0 };
    const episodes: { projectId: string; episodeId: string; frames: StoryboardFrame[] }[] = [];
    if (scope === 'current') {
      episodes.push({ projectId: currentProject.id, episodeId: currentEpisode.id, frames: currentEpisode.frames });
    } else {
      for (const p of projects) {
        for (const ep of p.episodes) {
          episodes.push({ projectId: p.id, episodeId: ep.id, frames: ep.frames });
        }
      }
    }
    let frameCount = 0;
    let matchCount = 0;
    for (const { frames } of episodes) {
      for (const frame of frames) {
        let frameMatches = 0;
        if (replaceImagePrompt && frame.imagePrompt) {
          frameMatches += frame.imagePrompt.split(searchText).length - 1;
        }
        if (replaceVideoPrompt && frame.videoPrompt) {
          frameMatches += frame.videoPrompt.split(searchText).length - 1;
        }
        if (frameMatches > 0) {
          frameCount++;
          matchCount += frameMatches;
        }
      }
    }
    return { frameCount, matchCount };
  }, [searchText, replaceImagePrompt, replaceVideoPrompt, scope, projects, currentProject, currentEpisode]);

  const handleReplace = () => {
    if (!searchText || matchStats.matchCount === 0) return;
    const updates: { projectId: string; episodeId: string; frames: StoryboardFrame[] }[] = [];
    const episodeSources: { projectId: string; episodeId: string; frames: StoryboardFrame[] }[] = [];
    if (scope === 'current') {
      episodeSources.push({ projectId: currentProject.id, episodeId: currentEpisode.id, frames: currentEpisode.frames });
    } else {
      for (const p of projects) {
        for (const ep of p.episodes) {
          episodeSources.push({ projectId: p.id, episodeId: ep.id, frames: ep.frames });
        }
      }
    }
    for (const { projectId, episodeId, frames } of episodeSources) {
      let changed = false;
      const newFrames = frames.map(frame => {
        let newImagePrompt = frame.imagePrompt;
        let newVideoPrompt = frame.videoPrompt;
        if (replaceImagePrompt && newImagePrompt) {
          const replaced = newImagePrompt.replaceAll(searchText, replaceText);
          if (replaced !== newImagePrompt) { newImagePrompt = replaced; changed = true; }
        }
        if (replaceVideoPrompt && newVideoPrompt) {
          const replaced = newVideoPrompt.replaceAll(searchText, replaceText);
          if (replaced !== newVideoPrompt) { newVideoPrompt = replaced; changed = true; }
        }
        if (newImagePrompt !== frame.imagePrompt || newVideoPrompt !== frame.videoPrompt) {
          return { ...frame, imagePrompt: newImagePrompt, videoPrompt: newVideoPrompt };
        }
        return frame;
      });
      if (changed) {
        updates.push({ projectId, episodeId, frames: newFrames });
      }
    }
    onReplace(updates);
    alert(`已替换 ${matchStats.matchCount} 处`);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-gray-800 rounded-2xl w-full max-w-lg border border-gray-700 shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="p-5 border-b border-gray-700 flex justify-between items-center">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Search size={18} className="text-blue-500"/> 分镜提示词查找替换
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X size={24} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5">
          {/* Search / Replace inputs */}
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="block text-sm font-medium text-gray-300">查找</label>
              <input
                type="text"
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                placeholder="输入要查找的文本..."
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label className="block text-sm font-medium text-gray-300">替换为</label>
              <input
                type="text"
                value={replaceText}
                onChange={e => setReplaceText(e.target.value)}
                className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                placeholder="输入替换后的文本..."
              />
            </div>
          </div>

          {/* Prompt type checkboxes */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-400">替换范围</label>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                <input type="checkbox" checked={replaceImagePrompt} onChange={e => setReplaceImagePrompt(e.target.checked)} className="rounded bg-gray-700 border-gray-600 text-blue-500 focus:ring-blue-500" />
                imagePrompt (生图提示词)
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                <input type="checkbox" checked={replaceVideoPrompt} onChange={e => setReplaceVideoPrompt(e.target.checked)} className="rounded bg-gray-700 border-gray-600 text-blue-500 focus:ring-blue-500" />
                videoPrompt (视频提示词)
              </label>
            </div>
          </div>

          {/* Scope radio */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-400">作用范围</label>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                <input type="radio" name="scope" checked={scope === 'current'} onChange={() => setScope('current')} className="bg-gray-700 border-gray-600 text-blue-500 focus:ring-blue-500" />
                当前分集
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                <input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} className="bg-gray-700 border-gray-600 text-blue-500 focus:ring-blue-500" />
                所有分集
              </label>
            </div>
          </div>

          {/* Match stats */}
          <div className="text-sm text-gray-400 bg-gray-900/50 rounded-lg px-4 py-3">
            {searchText ? (
              matchStats.matchCount > 0
                ? <span>匹配结果：在 <span className="text-blue-400 font-medium">{matchStats.frameCount}</span> 个分镜中找到 <span className="text-blue-400 font-medium">{matchStats.matchCount}</span> 处匹配</span>
                : <span>未找到匹配</span>
            ) : (
              <span>请输入查找文本</span>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-gray-700 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors">
            取消
          </button>
          <button
            onClick={handleReplace}
            disabled={!searchText || matchStats.matchCount === 0}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:text-gray-400 text-white text-sm rounded-lg font-medium transition-colors"
          >
            全部替换
          </button>
        </div>
      </div>
    </div>
  );
};

interface FrameEditorModalProps {
  frame: StoryboardFrame;
  project: Project;
  onSave: (frameId: string, updates: Partial<StoryboardFrame>) => void;
  onClose: () => void;
}

const FrameEditorModal: React.FC<FrameEditorModalProps> = ({ frame, project, onSave, onClose }) => {
  const [imagePrompt, setImagePrompt] = useState(frame.imagePrompt);
  const [videoPrompt, setVideoPrompt] = useState(frame.videoPrompt);
  const [dialogueLines, setDialogueLines] = useState<StoryboardDialogueLine[]>(
    getFrameDialogues(frame) ?? []
  );
  const [selectedCharIds, setSelectedCharIds] = useState<string[]>(frame.references.characterIds);
  const [selectedSceneIds, setSelectedSceneIds] = useState<string[]>(
    frame.references.sceneIds ?? (frame.references.sceneId ? [frame.references.sceneId] : [])
  );
  const [selectedVariantIds, setSelectedVariantIds] = useState<string[]>(frame.references.variantIds ?? []);

  const toggleCharacter = (charId: string) => {
    setSelectedCharIds(prev =>
      prev.includes(charId) ? prev.filter(id => id !== charId) : [...prev, charId]
    );
  };

  const toggleVariant = (variantId: string) => {
    setSelectedVariantIds(prev =>
      prev.includes(variantId) ? prev.filter(id => id !== variantId) : [...prev, variantId]
    );
  };

  const toggleScene = (sceneId: string) => {
    setSelectedSceneIds(prev =>
      prev.includes(sceneId) ? prev.filter(id => id !== sceneId) : [...prev, sceneId]
    );
  };

  const handleSave = () => {
    const normalizedDialogues = normalizeDialogues(dialogueLines);
    const dialogue = mergeDialoguesToDisplayString(normalizedDialogues);
    onSave(frame.id, {
      imagePrompt,
      videoPrompt,
      dialogues: normalizedDialogues,
      dialogue: dialogue || undefined,
      references: {
        characterIds: selectedCharIds,
        variantIds: selectedVariantIds.length > 0 ? selectedVariantIds : undefined,
        sceneId: selectedSceneIds[0],      // 向后兼容，保留第一个场景
        sceneIds: selectedSceneIds.length > 0 ? selectedSceneIds : undefined,
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

          {/* Image Prompt Section */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-300 uppercase tracking-wider">生图提示词</label>
            <textarea
              value={imagePrompt}
              onChange={(e) => setImagePrompt(e.target.value)}
              className="w-full h-28 bg-gray-900 border border-gray-600 rounded-lg p-4 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all leading-relaxed"
              placeholder="描述静态画面内容，用于图片生成..."
            />
            <p className="text-xs text-gray-500">用于分镜图片生成，描述单帧构图、人物姿态、场景环境和光线。</p>
          </div>

          {/* Video Prompt Section */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-amber-400 uppercase tracking-wider">视频生成提示词</label>
            <textarea
              value={videoPrompt}
              onChange={(e) => setVideoPrompt(e.target.value)}
              className="w-full h-28 bg-gray-900 border border-amber-600/50 rounded-lg p-4 text-white placeholder-gray-500 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all leading-relaxed"
              placeholder="描述连贯动态内容，用于视频生成..."
            />
            <p className="text-xs text-gray-500">用于图生视频，描述连贯动作、起承转合和镜头运动。</p>
          </div>

          <div className="w-full h-px bg-gray-700" />

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-blue-400 uppercase tracking-wider">对白</label>
              <button
                onClick={() => setDialogueLines(prev => [...prev, { speakerName: '', text: '' }])}
                className="px-2 py-1 text-xs rounded bg-gray-700 text-gray-200 hover:bg-gray-600"
              >
                添加对白
              </button>
            </div>
            <div className="space-y-3">
              {dialogueLines.map((line, index) => (
                <div key={`${frame.id}-dialogue-${index}`} className="bg-gray-900 border border-gray-700 rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      list={`speaker-list-${frame.id}`}
                      value={line.speakerName ?? ''}
                      onChange={(e) => {
                        const value = e.target.value;
                        setDialogueLines(prev => prev.map((d, i) => i === index ? { ...d, speakerName: value } : d));
                      }}
                      className="w-40 bg-gray-950 border border-gray-700 rounded p-2 text-sm text-white"
                      placeholder="说话人（可空）"
                    />
                    <button
                      onClick={() => setDialogueLines(prev => prev.filter((_, i) => i !== index))}
                      className="ml-auto px-2 py-1 text-xs rounded bg-gray-800 text-gray-300 hover:text-white hover:bg-gray-700"
                    >
                      删除
                    </button>
                  </div>
                  <textarea
                    value={line.text ?? ''}
                    onChange={(e) => {
                      const value = e.target.value;
                      setDialogueLines(prev => prev.map((d, i) => i === index ? { ...d, text: value } : d));
                    }}
                    className="w-full h-20 bg-gray-950 border border-gray-700 rounded p-2 text-sm text-white"
                    placeholder="对白内容"
                  />
                </div>
              ))}
              {dialogueLines.length === 0 && (
                <div className="text-xs text-gray-500">暂无对白</div>
              )}
            </div>
            <datalist id={`speaker-list-${frame.id}`}>
              {project.characters.map(char => (
                <option key={char.id} value={char.name} />
              ))}
            </datalist>
          </div>

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

            {/* Variants */}
            {(project.variants ?? []).length > 0 && (
              <div className="mb-6">
                <label className="block text-xs font-medium text-gray-500 mb-2">变体资产 (角色服装/状态)</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {(project.variants ?? []).map(variant => {
                    const isSelected = selectedVariantIds.includes(variant.id);
                    const parentChar = project.characters.find(c => c.id === variant.characterId);
                    return (
                      <button
                        key={variant.id}
                        onClick={() => toggleVariant(variant.id)}
                        className={`flex items-center gap-2 p-2 rounded-lg border transition-all text-left group ${
                          isSelected
                          ? 'bg-purple-900/30 border-purple-500/50 ring-1 ring-purple-500/50'
                          : 'bg-gray-900 border-gray-700 hover:border-gray-500'
                        }`}
                      >
                        <div className={`w-8 h-8 rounded bg-gray-800 overflow-hidden shrink-0 ${!variant.imageUrl && 'flex items-center justify-center text-[10px]'}`}>
                          {variant.imageUrl ? <img src={variant.imageUrl} className="w-full h-full object-cover"/> : '?'}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className={`text-xs truncate block ${isSelected ? 'text-purple-200' : 'text-gray-400'}`}>
                            {parentChar ? `${parentChar.name}-${variant.name}` : variant.name}
                          </span>
                        </div>
                        {isSelected && <Check size={14} className="text-purple-400 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Scenes */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-2">场景 (可多选)</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <button
                  onClick={() => setSelectedSceneIds([])}
                  className={`flex items-center justify-center gap-2 p-2 rounded-lg border border-dashed transition-all text-sm ${
                    selectedSceneIds.length === 0
                    ? 'bg-gray-700 border-gray-500 text-white'
                    : 'bg-gray-900 border-gray-700 text-gray-500 hover:border-gray-500'
                  }`}
                >
                  无场景参考
                </button>
                {project.scenes.map(scene => {
                  const isSelected = selectedSceneIds.includes(scene.id);
                  return (
                    <button
                      key={scene.id}
                      onClick={() => toggleScene(scene.id)}
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

const MINIMAX_VOICE_CHOICES: Array<{ label: string; value: string }> = [
  { label: 'male-qn-qingse', value: 'male-qn-qingse' },
  { label: 'female-shaonv', value: 'female-shaonv' },
  { label: 'female-yujie', value: 'female-yujie' },
  { label: 'male-yifeng', value: 'male-yifeng' },
  { label: 'fangqi_minimax', value: 'fangqi_minimax' },
  { label: 'weixue_minimax', value: 'weixue_minimax' },
  { label: 'yingxiao_minimax', value: 'yingxiao_minimax' },
  { label: 'jianmo_minimax', value: 'jianmo_minimax' },
  { label: 'zhuzixiao_minimax', value: 'zhuzixiao_minimax' },
  { label: 'zhiqi_minimax', value: 'zhiqi_minimax' },
  { label: 'zhouxing_minimax', value: 'zhouxing_minimax' },
  { label: 'genghong_minimax', value: 'genghong_minimax' },
  { label: '害羞少女', value: 'Chinese (Mandarin)_BashfulGirl' },
  { label: '探索少女', value: 'Chinese (Mandarin)_ExplorativeGirl' },
  { label: '睿智少女', value: 'Chinese (Mandarin)_IntellectualGirl' },
  { label: '慵懒少女', value: 'Chinese (Mandarin)_Laid_BackGirl' },
  { label: '纯真少年', value: 'Chinese (Mandarin)_Pure-hearted_Boy' },
  { label: '诚恳大人', value: 'Chinese (Mandarin)_Sincere_Adult' },
  { label: '倔强挚友', value: 'Chinese (Mandarin)_Stubborn_Friend' },
  { label: '装逼男主', value: 'qinjue_minimax' },
  { label: '哭腔女性', value: 'linmiaomiao_minimax' },
  { label: '林妙妙', value: 'linmiaomiao2_minimax' },
  { label: '女频解说', value: 'xiaoshuonvpin' }
];

const AssetEditorModal: React.FC<AssetEditorModalProps> = ({ asset, type, onSave, onClose }) => {
  const [formData, setFormData] = useState<any>(asset);

  const handleSave = () => {
    if (type === 'character') {
      const normalized = normalizeCharacterInput(formData.name || '', formData.aliases);
      onSave(asset.id, { ...formData, name: normalized.name, aliases: normalized.aliases });
      onClose();
      return;
    }
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

           {type === 'character' && (
             <div>
               <label className="block text-sm font-medium text-gray-400 mb-1">别名</label>
               <input 
                 className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white" 
                 value={((formData as Character).aliases ?? []).join('，')}
                 onChange={e => setFormData({...formData, aliases: parseAliasInput(e.target.value)})}
               />
             </div>
           )}
           
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
                  <label className="block text-sm font-medium text-gray-400 mb-1">MiniMax 音色</label>
                  <select
                    className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white"
                    value={(formData as Character).voiceId || ''}
                    onChange={e => setFormData({ ...formData, voiceId: e.target.value || undefined })}
                  >
                    <option value="">(未设置)</option>
                    {MINIMAX_VOICE_CHOICES.map(v => (
                      <option key={v.value} value={v.value}>{v.label}</option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">该音色将用于分镜对白自动配音</p>
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
          <label className="block text-sm font-medium text-gray-400 mb-1">资产图像模型</label>
          <select
            value={formData.imageModel}
            onChange={e => setFormData({...formData, imageModel: e.target.value})}
            className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-white"
          >
            <option value="nano-banana-pro-vt">grsai中转_香蕉pro (推荐)</option>
            <option value="bltcy-banana-2">柏拉图中转_banana2 (2K)</option>
            <option value="bltcy-nano-banana-hd">柏拉图中转_nano banana (HD)</option>
            <option value="bltcy-nano-banana-pro">柏拉图中转_nano banana pro</option>
            <option value="doubao-seedream-4-5-251128">火山引擎 Seedream 4.5</option>
            <option value="gemini-2.5-flash-image">Gemini 2.5 Flash Image</option>
            <option value="gemini-3-pro-image-preview">Gemini 3 Pro Image (高质量)</option>
          </select>
          <p className="text-xs text-gray-500 mt-1">用于角色、场景、变体资产生图</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-400 mb-1">分镜图像模型</label>
          <select
            value={formData.storyboardImageModel ?? formData.imageModel}
            onChange={e => setFormData({...formData, storyboardImageModel: e.target.value})}
            className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-white"
          >
            <option value="nano-banana-pro-vt">grsai中转_香蕉pro (推荐)</option>
            <option value="bltcy-banana-2">柏拉图中转_banana2 (2K)</option>
            <option value="bltcy-nano-banana-hd">柏拉图中转_nano banana (HD)</option>
            <option value="bltcy-nano-banana-pro">柏拉图中转_nano banana pro</option>
            <option value="doubao-seedream-4-5-251128">火山引擎 Seedream 4.5</option>
            <option value="gemini-2.5-flash-image">Gemini 2.5 Flash Image</option>
            <option value="gemini-3-pro-image-preview">Gemini 3 Pro Image (高质量)</option>
          </select>
          <p className="text-xs text-gray-500 mt-1">用于分镜帧生图</p>
        </div>
        
        <div>
          <label className="block text-sm font-medium text-gray-400 mb-1">视频模型</label>
          <select
            value={formData.videoModel}
            onChange={e => setFormData({...formData, videoModel: e.target.value})}
            className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-white"
          >
            <option value="doubao-seedance-1-5-pro-251215">豆包 Seedance 1.5 Pro (推荐)</option>
            <option value="kling-v3-omni">可灵 Kling v3 Omni</option>
            <option value="jimeng-seedance-2.0">即梦 Seedance 2.0 Pro (直连)</option>
            <option value="jimeng-seedance-2.0-fast">即梦 Seedance 2.0 Fast (直连)</option>
            <option value="seedance-2.0-fast">速推 Seedance 2.0 (测试用)</option>
            <option value="sora-2.0">速推 Sora 2.0</option>
            <option value="bltcy-sora-2">柏拉图中转 Sora 2</option>
            <option value="bltcy-veo3">柏拉图中转 Veo 3.1</option>
            <option value="bltcy-wan-2-6">柏拉图中转 Wan 2.6</option>
            <option value="bltcy-grok-video-3">柏拉图中转 grok-video-3</option>
            <option value="veo-3.1-fast-generate-preview">Veo 3.1 Fast</option>
            <option value="veo-3.1-generate-preview">Veo 3.1 High Quality</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-400 mb-1">视频时长（秒）</label>
          <input
            type="number"
            min="2"
            max="12"
            value={formData.videoDuration}
            onChange={e => setFormData({...formData, videoDuration: parseInt(e.target.value) || 5})}
            className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-white"
          />
          <p className="text-xs text-gray-500 mt-1">范围: 2-12 秒</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-400 mb-1">语音模型 (TTS)</label>
          <select
            value={formData.ttsModel}
            onChange={e => setFormData({...formData, ttsModel: e.target.value})}
            className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-white"
          >
            <option value="minimax-speech-2.6-hd">MiniMax speech-2.6-hd</option>
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
  onClose: () => void,
  defaultProjectType?: ProjectType
}> = ({ settings, onSave, onClose, defaultProjectType }) => {
  const DEFAULT_PROJECT_TYPE_KEYS = new Set(['REAL_PERSON_COMMENTARY', 'COMMENTARY_2D', 'COMMENTARY_3D', 'PREMIUM_2D', 'PREMIUM_3D']);

  const [localSettings, setLocalSettings] = useState(settings);
  const [activeTab, setActiveTab] = useState<string>(defaultProjectType || 'REAL_PERSON_COMMENTARY');
  const [jianyingPathDisplay, setJianyingPathDisplay] = useState<string>(settings.jianyingExportPath || '未设置');
  const [seedanceSessions, setSeedanceSessions] = useState<SeedanceSession[]>([]);
  const [seedanceSessionIdInput, setSeedanceSessionIdInput] = useState('');
  const [seedanceSessionNameInput, setSeedanceSessionNameInput] = useState('');
  const [editingSeedanceSessionId, setEditingSeedanceSessionId] = useState<string | null>(null);
  const [editingSeedanceSessionValue, setEditingSeedanceSessionValue] = useState('');
  const [seedanceLoading, setSeedanceLoading] = useState(false);

  // Custom type management
  const [showAddTypeModal, setShowAddTypeModal] = useState(false);
  const [newTypeLabel, setNewTypeLabel] = useState('');
  const [copyFromType, setCopyFromType] = useState('REAL_PERSON_COMMENTARY');
  const [editingTypeKey, setEditingTypeKey] = useState<string | null>(null);
  const [editingTypeLabel, setEditingTypeLabel] = useState('');

  useEffect(() => {
    setLocalSettings(settings);
    setJianyingPathDisplay(settings.jianyingExportPath || '未设置');
  }, [settings]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const loadSeedanceSessions = async () => {
      try {
        const sessions = await apiService.getSeedanceSessionsStatus();
        setSeedanceSessions(Array.isArray(sessions) ? sessions : []);
      } catch (error) {
        console.error('加载 Seedance 会话状态失败:', error);
      }
    };

    loadSeedanceSessions();
    timer = setInterval(loadSeedanceSessions, 5000);

    return () => {
      if (timer) clearInterval(timer);
    };
  }, []);

  const updatePrompt = (field: keyof ProjectTypeInstruction, value: string) => {
      console.log(`📝 更新提示词 [${activeTab}] ${field}:`, value.substring(0, 50) + '...');
      setLocalSettings(prev => ({
          ...prev,
          projectTypePrompts: {
              ...prev.projectTypePrompts,
              [activeTab]: {
                  ...prev.projectTypePrompts[activeTab],
                  [field]: value
              }
          }
      }));
  };

  const handleSave = () => {
    console.log('💾 保存全局设置', {
      extractionModel: localSettings.extractionModel,
      projectTypes: Object.keys(localSettings.projectTypePrompts),
      currentTab: activeTab,
      jianyingExportPath: localSettings.jianyingExportPath,
      jianyingExportPathFull: localSettings.jianyingExportPathFull
    });
    onSave(localSettings);
    // 不关闭窗口，让用户可以继续编辑其他项目类型
  };

  const handleExtractionModelChange = (value: string) => {
    const nextSettings = { ...localSettings, extractionModel: value };
    setLocalSettings(nextSettings);
  };

  const handleClose = () => {
    console.log('❌ 取消全局设置修改');
    setLocalSettings(settings);
    setJianyingPathDisplay(settings.jianyingExportPath || '未设置');
    onClose();
  };

  const refreshSeedanceSessions = async () => {
    const sessions = await apiService.getSeedanceSessionsStatus();
    setSeedanceSessions(Array.isArray(sessions) ? sessions : []);
  };

  const handleAddSeedanceSession = async () => {
    if (!seedanceSessionIdInput.trim()) {
      alert('请输入 Session ID');
      return;
    }

    try {
      setSeedanceLoading(true);
      await apiService.addSeedanceSession(seedanceSessionIdInput.trim(), seedanceSessionNameInput.trim() || `账号${seedanceSessions.length + 1}`);
      await apiService.syncSeedanceSessions();
      await refreshSeedanceSessions();
      setSeedanceSessionIdInput('');
      setSeedanceSessionNameInput('');
    } catch (error) {
      alert('添加 Seedance Session 失败：' + (error as Error).message);
    } finally {
      setSeedanceLoading(false);
    }
  };

  const handleDeleteSeedanceSession = async (id: string) => {
    try {
      setSeedanceLoading(true);
      await apiService.deleteSeedanceSession(id);
      await apiService.syncSeedanceSessions();
      await refreshSeedanceSessions();
    } catch (error) {
      alert('删除 Seedance Session 失败：' + (error as Error).message);
    } finally {
      setSeedanceLoading(false);
    }
  };

  const handleToggleSeedanceSession = async (session: SeedanceSession) => {
    try {
      setSeedanceLoading(true);
      await apiService.updateSeedanceSession(session.id, {
        status: session.status === 'disabled' ? 'active' : 'disabled'
      });
      await apiService.syncSeedanceSessions();
      await refreshSeedanceSessions();
    } catch (error) {
      alert('更新 Seedance Session 状态失败：' + (error as Error).message);
    } finally {
      setSeedanceLoading(false);
    }
  };

  const handleStartEditSeedanceSessionId = async (session: SeedanceSession) => {
    setEditingSeedanceSessionId(session.id);
    setEditingSeedanceSessionValue('加载中...');
    try {
      const fullSessionId = await apiService.getSeedanceSessionFullById(session.id);
      setEditingSeedanceSessionValue(fullSessionId ?? '');
    } catch {
      setEditingSeedanceSessionValue('');
    }
  };

  const handleSaveSeedanceSessionId = async (session: SeedanceSession) => {
    if (!editingSeedanceSessionValue.trim()) {
      alert('请输入新的 Session ID');
      return;
    }

    try {
      setSeedanceLoading(true);
      const updateData: any = {
        sessionId: editingSeedanceSessionValue.trim()
      };

      // 如果当前是过期状态，保存新 ID 时自动恢复为 active
      if (session.status === 'expired' || session.status === 'member_expired') {
        updateData.status = 'active';
      }

      await apiService.updateSeedanceSession(session.id, updateData);
      await apiService.syncSeedanceSessions();
      await refreshSeedanceSessions();
      setEditingSeedanceSessionId(null);
      setEditingSeedanceSessionValue('');
    } catch (error) {
      alert('更新 Session ID 失败：' + (error as Error).message);
    } finally {
      setSeedanceLoading(false);
    }
  };

  const handleCancelEditSeedanceSessionId = () => {
    setEditingSeedanceSessionId(null);
    setEditingSeedanceSessionValue('');
  };

  const getSeedanceStatusLabel = (status: SeedanceSession['status']) => {
    if (status === 'active') return '可用';
    if (status === 'expired') return 'Session过期';
    if (status === 'member_expired') return '会员过期';
    if (status === 'insufficient') return '积分不足';
    if (status === 'security_check') return '需安全验证';
    return '禁用';
  };

  const getSeedanceStatusClass = (status: SeedanceSession['status']) => {
    if (status === 'active') return 'bg-green-500/15 text-green-300 border-green-500/30';
    if (status === 'expired') return 'bg-red-500/15 text-red-300 border-red-500/30';
    if (status === 'member_expired') return 'bg-purple-500/15 text-purple-300 border-purple-500/30';
    if (status === 'insufficient') return 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30';
    if (status === 'security_check') return 'bg-orange-500/15 text-orange-300 border-orange-500/30';
    return 'bg-gray-500/15 text-gray-300 border-gray-500/30';
  };

  const handleAddCustomType = () => {
    if (!newTypeLabel.trim()) {
      alert('请输入项目类型名称');
      return;
    }

    // Generate unique key
    const newTypeKey = `CUSTOM_${Date.now()}`;

    // Copy prompts from selected type
    const sourcePrompts = localSettings.projectTypePrompts[copyFromType];
    if (!sourcePrompts) {
      alert('复制源类型失败');
      return;
    }

    setLocalSettings(prev => ({
      ...prev,
      projectTypePrompts: {
        ...prev.projectTypePrompts,
        [newTypeKey]: { ...sourcePrompts }
      },
      projectTypeLabels: {
        ...prev.projectTypeLabels,
        [newTypeKey]: newTypeLabel.trim()
      }
    }));

    setActiveTab(newTypeKey);
    setShowAddTypeModal(false);
    setNewTypeLabel('');
    setCopyFromType('REAL_PERSON_COMMENTARY');
  };

  const handleDeleteCustomType = (typeKey: string) => {
    if (DEFAULT_PROJECT_TYPE_KEYS.has(typeKey)) {
      alert('无法删除内置项目类型');
      return;
    }

    if (!confirm(`确认要删除项目类型 "${getProjectTypeLabel(typeKey, localSettings.projectTypeLabels)}" 吗？`)) {
      return;
    }

    setLocalSettings(prev => {
      const newPrompts = { ...prev.projectTypePrompts };
      const newLabels = { ...prev.projectTypeLabels };
      delete newPrompts[typeKey];
      delete newLabels[typeKey];

      return {
        ...prev,
        projectTypePrompts: newPrompts,
        projectTypeLabels: newLabels
      };
    });

    // Switch to first default type if current tab was deleted
    if (activeTab === typeKey) {
      setActiveTab('REAL_PERSON_COMMENTARY');
    }
  };

  const handleRenameCustomType = (typeKey: string) => {
    if (DEFAULT_PROJECT_TYPE_KEYS.has(typeKey)) {
      alert('无法重命名内置项目类型');
      return;
    }

    setEditingTypeKey(typeKey);
    setEditingTypeLabel(localSettings.projectTypeLabels?.[typeKey] || typeKey);
  };

  const handleSaveCustomTypeLabel = () => {
    if (!editingTypeKey || !editingTypeLabel.trim()) {
      setEditingTypeKey(null);
      setEditingTypeLabel('');
      return;
    }

    setLocalSettings(prev => ({
      ...prev,
      projectTypeLabels: {
        ...prev.projectTypeLabels,
        [editingTypeKey]: editingTypeLabel.trim()
      }
    }));

    setEditingTypeKey(null);
    setEditingTypeLabel('');
  };

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
              onChange={(e) => handleExtractionModelChange(e.target.value)}
              className="w-full bg-gray-900 border border-gray-600 rounded p-3 text-white focus:border-green-500 focus:outline-none"
            >
              <option value="doubao-seed-2-0-pro-260215">豆包 Seed 2.0 Pro (推荐 - 火山引擎)</option>
              <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (Univibe 中转)</option>
              <option value="gemini-3-flash-preview">Gemini 3 Flash (快速)</option>
              <option value="gemini-3-pro-preview">Gemini 3 Pro (高推理 - 较慢)</option>
              <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
            </select>
          </section>

          <div className="w-full h-px bg-gray-700"></div>

          {/* Preprocess Model Selection */}
          <section>
            <h3 className="text-md font-bold text-white mb-3">预处理模型</h3>
            <p className="text-sm text-gray-400 mb-3">用于资产提取、角色提取、场景提取的Claude模型。</p>
            <select
              value={localSettings.preprocessModel || 'claude-sonnet-4-6'}
              onChange={(e) => {
                const nextSettings = { ...localSettings, preprocessModel: e.target.value };
                setLocalSettings(nextSettings);
              }}
              className="w-full bg-gray-900 border border-gray-600 rounded p-3 text-white focus:border-green-500 focus:outline-none"
            >
              <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
              <option value="claude-opus-4-6">Claude Opus 4.6</option>
              <option value="claude-opus-4-6-thinking">Claude Opus 4.6 Thinking</option>
            </select>
          </section>

          <div className="w-full h-px bg-gray-700"></div>

          {/* Multi-Ref Video Model */}
          <section>
            <h3 className="text-md font-bold text-white mb-3">多参考生视频模型</h3>
            <p className="text-sm text-gray-400 mb-3">多参考生成模式下使用的视频生成模型。</p>
            <select
              value={localSettings.multiRefVideoModel || 'seedance_2.0_fast'}
              onChange={(e) => {
                const nextSettings = { ...localSettings, multiRefVideoModel: e.target.value };
                setLocalSettings(nextSettings);
              }}
              className="w-full bg-gray-900 border border-gray-600 rounded p-3 text-white focus:border-green-500 focus:outline-none"
            >
              <option value="seedance_2.0_fast">Seedance 2.0 Fast（速推，推荐）</option>
              <option value="seedance_2.0">Seedance 2.0</option>
            </select>
          </section>

          <div className="w-full h-px bg-gray-700"></div>

          {/* Jianying Export Settings */}
          <section>
            <h3 className="text-md font-bold text-white mb-3">剪映工程导出</h3>
            <p className="text-sm text-gray-400 mb-3">设置剪映工程文件的导出目录和相关参数。</p>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-2">剪映工程目录</label>
                <div className="bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white text-sm">
                  <span className="truncate">{jianyingPathDisplay}</span>
                </div>
                <p className="text-xs text-gray-500 mt-1">从 .env.local 配置读取（网络驱动器共享）</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-2">剪映工程完整路径</label>
                <div className="bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white text-sm break-all">
                  {localSettings.jianyingExportPathFull || '未配置'}
                </div>
                <p className="text-xs text-gray-500 mt-1">从 .env.local 配置读取</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-2">图片默认时长（秒）</label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={localSettings.defaultImageDuration || 3}
                    onChange={(e) => {
                      const nextSettings = { ...localSettings, defaultImageDuration: Number(e.target.value) };
                      setLocalSettings(nextSettings);
                    }}
                    className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:border-green-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-2">空分镜占位颜色</label>
                  <div className="flex gap-2">
                    <input
                      type="color"
                      value={localSettings.placeholderColor || '#000000'}
                      onChange={(e) => {
                        const nextSettings = { ...localSettings, placeholderColor: e.target.value };
                        setLocalSettings(nextSettings);
                      }}
                      className="w-12 h-9 bg-gray-900 border border-gray-600 rounded cursor-pointer"
                    />
                    <input
                      type="text"
                      value={localSettings.placeholderColor || '#000000'}
                      onChange={(e) => {
                        const nextSettings = { ...localSettings, placeholderColor: e.target.value };
                        setLocalSettings(nextSettings);
                      }}
                      className="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:border-green-500 focus:outline-none font-mono"
                      placeholder="#000000"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-400 mb-2">
                  TTS 语速 <span className="text-green-400 font-bold">{(localSettings.ttsSpeed ?? 1.0).toFixed(1)}x</span>
                </label>
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  value={localSettings.ttsSpeed ?? 1.0}
                  onChange={(e) => {
                    const nextSettings = { ...localSettings, ttsSpeed: Number(e.target.value) };
                    setLocalSettings(nextSettings);
                  }}
                  className="w-full accent-green-500"
                />
                <div className="flex justify-between text-xs text-gray-500 mt-1">
                  <span>0.5x 慢速</span>
                  <span>1.0x 正常</span>
                  <span>2.0x 快速</span>
                </div>
              </div>
            </div>
          </section>

          <div className="w-full h-px bg-gray-700"></div>

          <section>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-md font-bold text-white">即梦 Seedance 2.0 会话管理</h3>
                <p className="text-sm text-gray-400 mt-1">管理 Session ID、查看实时状态与积分余量。</p>
              </div>
              {seedanceLoading && <Loader2 size={16} className="animate-spin text-gray-400" />}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
              <input
                type="text"
                value={seedanceSessionIdInput}
                onChange={(e) => setSeedanceSessionIdInput(e.target.value)}
                className="md:col-span-2 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:border-green-500 focus:outline-none"
                placeholder="输入即梦 sessionid"
              />
              <input
                type="text"
                value={seedanceSessionNameInput}
                onChange={(e) => setSeedanceSessionNameInput(e.target.value)}
                className="bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:border-green-500 focus:outline-none"
                placeholder="显示名称（可选）"
              />
            </div>
            <div className="flex justify-end mb-4">
              <button
                onClick={handleAddSeedanceSession}
                className="px-4 py-2 bg-green-600 rounded text-white hover:bg-green-500 text-sm"
              >
                添加 Session
              </button>
            </div>

            <div className="space-y-3">
              {seedanceSessions.length === 0 && (
                <div className="bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-sm text-gray-400">
                  暂无 Seedance Session，请先添加。
                </div>
              )}
              {seedanceSessions.map((session) => (
                <div key={session.id} className="bg-gray-900 border border-gray-700 rounded-xl p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-white font-medium">{session.name}</span>
                        <span className={`px-2 py-0.5 rounded-full text-xs border ${getSeedanceStatusClass(session.status)}`}>
                          {getSeedanceStatusLabel(session.status)}
                        </span>
                      </div>
                      {editingSeedanceSessionId === session.id ? (
                        <div className="flex flex-col sm:flex-row gap-2">
                          <input
                            type="text"
                            value={editingSeedanceSessionValue}
                            onChange={(e) => setEditingSeedanceSessionValue(e.target.value)}
                            className="flex-1 bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:border-green-500 focus:outline-none"
                            placeholder="输入新的 Session ID（留空则不修改）"
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleSaveSeedanceSessionId(session)}
                              className="px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 text-white text-xs"
                            >
                              保存 ID
                            </button>
                            <button
                              onClick={handleCancelEditSeedanceSessionId}
                              className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-white text-xs"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : null}
                      <div className="text-xs text-gray-400 flex flex-wrap gap-x-4 gap-y-1">
                        <span>并发 {session.currentTasks}/{session.maxConcurrent}</span>
                        <span>成功 {session.successCount}</span>
                        <span>失败 {session.failCount}</span>
                        <span>总任务 {session.totalTasks}</span>
                        <span>积分 {session.credits ?? '未知'}</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => handleStartEditSeedanceSessionId(session)}
                        className="px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs"
                      >
                        编辑 Session ID
                      </button>
                      <button
                        onClick={() => handleToggleSeedanceSession(session)}
                        className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-white text-xs"
                      >
                        {session.status === 'disabled' ? '启用' : '禁用'}
                      </button>
                      <button
                        onClick={() => handleDeleteSeedanceSession(session.id)}
                        className="px-3 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white text-xs"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="w-full h-px bg-gray-700"></div>

          {/* System Instructions */}
          <section>
             <h3 className="text-md font-bold text-white mb-3">项目类型指令</h3>
             <p className="text-sm text-gray-400 mb-4">自定义每种项目类型使用的系统指令（提示词前缀）。</p>
             
             {/* Tabs */}
             <div className="flex flex-col gap-3 pb-2 mb-2">
               <div className="flex gap-2 overflow-x-auto pb-2 custom-scrollbar flex-wrap">
                  {(Object.keys(localSettings.projectTypePrompts) as string[]).map(type => {
                    const isDefault = DEFAULT_PROJECT_TYPE_KEYS.has(type);
                    const isEditing = editingTypeKey === type;
                    const typeLabel = getProjectTypeLabel(type, localSettings.projectTypeLabels);

                    return (
                      <div key={type} className="flex items-center gap-1">
                        {isEditing ? (
                          <div className="flex gap-1">
                            <input
                              type="text"
                              value={editingTypeLabel}
                              onChange={(e) => setEditingTypeLabel(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveCustomTypeLabel();
                                if (e.key === 'Escape') { setEditingTypeKey(null); setEditingTypeLabel(''); }
                              }}
                              autoFocus
                              className="px-2 py-1 rounded text-xs bg-gray-900 border border-gray-600 text-white focus:border-green-500 focus:outline-none"
                            />
                            <button
                              onClick={handleSaveCustomTypeLabel}
                              className="p-1.5 rounded bg-green-600 hover:bg-green-500 text-white"
                            >
                              <Check size={12} />
                            </button>
                            <button
                              onClick={() => { setEditingTypeKey(null); setEditingTypeLabel(''); }}
                              className="p-1.5 rounded bg-gray-700 hover:bg-gray-600 text-white"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setActiveTab(type)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-colors border ${
                              activeTab === type
                              ? 'bg-green-600 text-white border-green-500'
                              : 'bg-gray-700 text-gray-400 border-transparent hover:text-gray-200'
                            }`}
                          >
                            {typeLabel}
                          </button>
                        )}
                        {!isDefault && !isEditing && (
                          <div className="flex gap-1">
                            <button
                              onClick={() => handleRenameCustomType(type)}
                              className="p-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition"
                              title="重命名"
                            >
                              <Edit2 size={12} />
                            </button>
                            <button
                              onClick={() => handleDeleteCustomType(type)}
                              className="p-1.5 rounded bg-red-600/20 hover:bg-red-600/40 text-red-300 hover:text-red-200 transition"
                              title="删除"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
               </div>

               {/* Add custom type button */}
               <button
                 onClick={() => setShowAddTypeModal(true)}
                 className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white border border-blue-500 transition-colors w-fit"
               >
                 <Plus size={14} />
                 新增项目类型
               </button>

               {/* Add Type Modal */}
               {showAddTypeModal && (
                 <div className="bg-gray-900 border border-gray-600 rounded-lg p-4 space-y-3">
                   <div>
                     <label className="block text-xs font-bold text-white mb-1">类型名称</label>
                     <input
                       type="text"
                       value={newTypeLabel}
                       onChange={(e) => setNewTypeLabel(e.target.value)}
                       placeholder="例如：科幻3D"
                       className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:border-green-500 focus:outline-none"
                       onKeyDown={(e) => {
                         if (e.key === 'Enter') handleAddCustomType();
                         if (e.key === 'Escape') setShowAddTypeModal(false);
                       }}
                     />
                   </div>
                   <div>
                     <label className="block text-xs font-bold text-white mb-1">复制提示词来自</label>
                     <select
                       value={copyFromType}
                       onChange={(e) => setCopyFromType(e.target.value)}
                       className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:border-green-500 focus:outline-none"
                     >
                       {(Object.keys(localSettings.projectTypePrompts) as string[]).map(type => (
                         <option key={type} value={type}>
                           {getProjectTypeLabel(type, localSettings.projectTypeLabels)}
                         </option>
                       ))}
                     </select>
                   </div>
                   <div className="flex gap-2">
                     <button
                       onClick={handleAddCustomType}
                       className="flex-1 px-3 py-2 rounded bg-green-600 hover:bg-green-500 text-white text-sm font-bold transition"
                     >
                       创建
                     </button>
                     <button
                       onClick={() => {
                         setShowAddTypeModal(false);
                         setNewTypeLabel('');
                       }}
                       className="flex-1 px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 text-white text-sm font-bold transition"
                     >
                       取消
                     </button>
                   </div>
                 </div>
               )}
             </div>
             
             <div className="space-y-4">
                 <div>
                     <label className="block text-xs font-bold text-orange-400 mb-1 uppercase tracking-wider">角色/变体生图提示词前缀</label>
                     <textarea
                        value={localSettings.projectTypePrompts[activeTab].assetImagePrefix}
                        onChange={(e) => updatePrompt('assetImagePrefix', e.target.value)}
                        className="w-full h-20 bg-gray-900 border border-gray-600 rounded-lg p-3 text-white text-sm focus:border-green-500 focus:outline-none"
                     />
                 </div>
                 <div>
                     <label className="block text-xs font-bold text-yellow-400 mb-1 uppercase tracking-wider">场景生图提示词前缀</label>
                     <textarea
                        value={localSettings.projectTypePrompts[activeTab].sceneImagePrefix || ''}
                        onChange={(e) => updatePrompt('sceneImagePrefix', e.target.value)}
                        className="w-full h-20 bg-gray-900 border border-gray-600 rounded-lg p-3 text-white text-sm focus:border-yellow-500 focus:outline-none"
                     />
                 </div>
                 <div>
                     <label className="block text-xs font-bold text-blue-400 mb-1 uppercase tracking-wider">分镜生图提示词前缀</label>
                     <textarea
                        value={localSettings.projectTypePrompts[activeTab].storyboardImagePrefix}
                        onChange={(e) => updatePrompt('storyboardImagePrefix', e.target.value)}
                        className="w-full h-20 bg-gray-900 border border-gray-600 rounded-lg p-3 text-white text-sm focus:border-green-500 focus:outline-none"
                     />
                 </div>
                 <div>
                     <label className="block text-xs font-bold text-purple-400 mb-1 uppercase tracking-wider">图生视频提示词前缀</label>
                     <textarea
                        value={localSettings.projectTypePrompts[activeTab].videoGenerationPrefix}
                        onChange={(e) => updatePrompt('videoGenerationPrefix', e.target.value)}
                        className="w-full h-20 bg-gray-900 border border-gray-600 rounded-lg p-3 text-white text-sm focus:border-green-500 focus:outline-none"
                     />
                 </div>
                 <div>
                     <label className="block text-xs font-bold text-pink-400 mb-1 uppercase tracking-wider">多参考生视频提示词前缀</label>
                     <textarea
                        value={localSettings.projectTypePrompts[activeTab].multiRefVideoGenerationPrefix || ''}
                        onChange={(e) => updatePrompt('multiRefVideoGenerationPrefix' as any, e.target.value)}
                        className="w-full h-20 bg-gray-900 border border-gray-600 rounded-lg p-3 text-white text-sm focus:border-green-500 focus:outline-none"
                        placeholder="可选：多参考模式下追加的风格/约束（为空则使用“图生视频提示词前缀”）"
                     />
                     <p className="text-xs text-gray-500 mt-1">开启“多参考生成”时会优先使用这里的前缀；留空则回退为“图生视频提示词前缀”。</p>
                 </div>
                 <div className="grid grid-cols-2 gap-4">
                     <div>
                         <label className="block text-xs font-bold text-yellow-400 mb-1 uppercase tracking-wider">角色提取提示词</label>
                         <textarea
                            value={localSettings.projectTypePrompts[activeTab].characterExtraction}
                            onChange={(e) => updatePrompt('characterExtraction', e.target.value)}
                            className="w-full h-32 bg-gray-900 border border-gray-600 rounded-lg p-3 text-white text-sm focus:border-green-500 focus:outline-none"
                         />
                     </div>
                     <div>
                         <label className="block text-xs font-bold text-green-400 mb-1 uppercase tracking-wider">场景提取提示词</label>
                         <textarea
                            value={localSettings.projectTypePrompts[activeTab].sceneExtraction}
                            onChange={(e) => updatePrompt('sceneExtraction', e.target.value)}
                            className="w-full h-32 bg-gray-900 border border-gray-600 rounded-lg p-3 text-white text-sm focus:border-green-500 focus:outline-none"
                         />
                     </div>
                 </div>
                 <div>
                     <label className="block text-xs font-bold text-purple-400 mb-1 uppercase tracking-wider">分镜拆解提示词</label>
                     <textarea
                        value={localSettings.projectTypePrompts[activeTab].storyboardBreakdown}
                        onChange={(e) => updatePrompt('storyboardBreakdown', e.target.value)}
                        className="w-full h-32 bg-gray-900 border border-gray-600 rounded-lg p-3 text-white text-sm focus:border-green-500 focus:outline-none"
                        placeholder="定义如何将文本拆解为分镜的策略..."
                     />
                 </div>
                 <div>
                     <label className="block text-xs font-bold text-indigo-400 mb-1 uppercase tracking-wider">分段预处理提示词（导演分段 SKILL）</label>
                     <textarea
                        value={localSettings.projectTypePrompts[activeTab].preprocessSegmentPrompt || ''}
                        onChange={(e) => updatePrompt('preprocessSegmentPrompt', e.target.value)}
                        className="w-full h-40 bg-gray-900 border border-gray-600 rounded-lg p-3 text-white text-sm focus:border-indigo-500 focus:outline-none font-mono text-xs"
                        placeholder="定义小说文本分段处理的提示词（用于导演分段 SKILL）..."
                     />
                    <p className="text-xs text-gray-500 mt-1">{'用于小说预处理阶段，将整本小说按逻辑分段。支持模板变量：{{故事情节}}、{{角色信息}}、{{场景信息}}、{{小说原文}}、{{推文文案}}、{{前面分镜:2}}、{{后面分镜:2}}、{{章节文案}}'}</p>
                 </div>
                 <div>
                     <label className="block text-xs font-bold text-teal-400 mb-1 uppercase tracking-wider">二次加工提示词（可选）</label>
                     <textarea
                        value={localSettings.projectTypePrompts[activeTab].preprocessSecondPassPrompt || ''}
                        onChange={(e) => updatePrompt('preprocessSecondPassPrompt' as any, e.target.value)}
                        className="w-full h-40 bg-gray-900 border border-gray-600 rounded-lg p-3 text-white text-sm focus:border-teal-500 focus:outline-none font-mono text-xs"
                        placeholder="可选：分段后再用此提示词处理一遍结果..."
                     />
                    <p className="text-xs text-gray-500 mt-1">{'启用后，导演分段的结果会再经过此提示词处理一遍。留空则不启用。支持相同模板变量：{{故事情节}}、{{角色信息}}、{{场景信息}}、{{小说原文}}、{{推文文案}}、{{前面分镜:2}}、{{后面分镜:2}}、{{章节文案}}'}</p>
                 </div>
             </div>
          </section>
        </div>

        <div className="p-5 border-t border-gray-700 bg-gray-850 rounded-b-2xl flex justify-end gap-3">
          <button onClick={handleClose} className="px-5 py-2.5 rounded-lg text-gray-300 hover:bg-gray-700 font-medium transition-colors">
            取消
          </button>
          <button onClick={handleSave} className="px-6 py-2.5 bg-green-600 rounded-lg text-white hover:bg-green-500 font-medium shadow-lg shadow-green-900/20 flex items-center gap-2 transition-all">
            <Save size={18} /> 保存设置
          </button>
        </div>
      </div>
    </div>
  );
};


// VariantEditorModal
interface VariantEditorModalProps {
  variant: CharacterVariant;
  characters: Character[];
  onSave: (id: string, updates: Partial<CharacterVariant>) => void;
  onClose: () => void;
}

const VariantEditorModal: React.FC<VariantEditorModalProps> = ({ variant, characters, onSave, onClose }) => {
  const [formData, setFormData] = useState<CharacterVariant>(variant);

  const handleSave = () => {
    onSave(variant.id, formData);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <div className="bg-gray-800 rounded-2xl w-full max-w-lg border border-gray-700 shadow-2xl flex flex-col max-h-[90vh]">
        <div className="p-5 border-b border-gray-700 flex justify-between items-center rounded-t-2xl">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Edit2 size={18} className="text-purple-400"/> 编辑变体资产
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X size={24} /></button>
        </div>
        <div className="p-6 overflow-y-auto custom-scrollbar space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">所属角色</label>
            <select
              value={formData.characterId}
              onChange={e => setFormData({ ...formData, characterId: e.target.value })}
              className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-white text-sm"
            >
              {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">变体名称</label>
            <input
              className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-white text-sm"
              value={formData.name}
              onChange={e => setFormData({ ...formData, name: e.target.value })}
              placeholder="如：东宫大婚·太子妃宫装"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">出现场景（可选）</label>
            <input
              className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-white text-sm"
              value={formData.context ?? ''}
              onChange={e => setFormData({ ...formData, context: e.target.value })}
              placeholder="如：东宫大婚时"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">变体外貌描述</label>
            <textarea
              className="w-full h-28 bg-gray-700 border border-gray-600 rounded p-2 text-white text-sm resize-none"
              value={formData.appearance}
              onChange={e => setFormData({ ...formData, appearance: e.target.value })}
              placeholder="详细描述此变体的服装、配饰等外貌特征..."
            />
          </div>
        </div>
        <div className="p-5 border-t border-gray-700 rounded-b-2xl flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 rounded-lg text-gray-300 hover:bg-gray-700 font-medium">取消</button>
          <button onClick={handleSave} className="px-6 py-2.5 bg-purple-600 rounded-lg text-white hover:bg-purple-500 font-medium flex items-center gap-2">
            <Save size={18} /> 保存
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
  const [selectedEpisodeIds, setSelectedEpisodeIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<string>(ProjectTab.SCRIPT);

  // 资产和分集的保存快照（用于细粒度保存）
  const savedAssetsRef = useRef<Map<string, string> | null>(null); // projectId -> JSON.stringify(assets)
  const savedEpisodesRef = useRef<Map<string, number> | null>(null); // episodeId -> updatedAt

  // Global Settings State
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings>(DEFAULT_GLOBAL_SETTINGS);
  const [showGlobalSettingsModal, setShowGlobalSettingsModal] = useState(false);
  const [isGlobalSettingsInitialized, setIsGlobalSettingsInitialized] = useState(false);
  const savedGlobalSettingsRef = useRef<string | null>(null);
  const seedanceRecoveryStartedRef = useRef(false);
  const seedancePollingFramesRef = useRef<Set<string>>(new Set());
  const [activeTasks, setActiveTasks] = useState<ActiveTask[]>([]);

  const persistFrameVideoState = useCallback((
    projectId: string,
    episodeId: string,
    frameId: string,
    updater: (frame: StoryboardFrame) => StoryboardFrame
  ) => {
    setProjects(prev => prev.map(p => {
      if (p.id !== projectId) return p;
      return {
        ...p,
        updatedAt: Date.now(),
        episodes: p.episodes.map(e => {
          if (e.id !== episodeId) return e;
          const updatedEp = {
            ...e,
            updatedAt: Date.now(),
            frames: e.frames.map(f => f.id === frameId ? updater(f) : f)
          };
          apiService.updateEpisode(projectId, episodeId, updatedEp).catch(err =>
            console.error('[视频状态保存] 分集保存失败:', err)
          );
          return updatedEp;
        })
      };
    }));
  }, []);

  const commitFrameVideoSuccess = useCallback(async (
    projectId: string,
    episodeId: string,
    frameId: string,
    videoUrl: string,
    videoDuration?: number,
    successTaskKey?: string
  ) => {
    const response = await apiService.updateFrameVideo(projectId, episodeId, frameId, { videoUrl, videoDuration, successTaskKey });
    const nextStats = response?.data?.stats;

    setProjects(prev => prev.map(p => {
      if (p.id !== projectId) return p;
      return {
        ...p,
        updatedAt: Date.now(),
        stats: nextStats ?? p.stats,
        episodes: p.episodes.map(e => {
          if (e.id !== episodeId) return e;
          return {
            ...e,
            updatedAt: Date.now(),
            frames: e.frames.map(f => f.id === frameId ? {
              ...f,
              videoUrl,
              videoDuration: videoDuration ?? f.videoDuration,
              isGeneratingVideo: false,
              videoTaskStatus: undefined,
              videoQueuePosition: undefined,
              videoProgress: undefined,
              videoError: undefined,
              seedanceTaskUpdatedAt: Date.now(),
            } : f),
          };
        }),
      };
    }));
  }, []);

  const startSeedanceTaskPolling = useCallback(async (
    projectId: string,
    episodeId: string,
    frameId: string,
    taskId: string,
    videoDuration: number
  ) => {
    if (seedancePollingFramesRef.current.has(frameId)) return;
    seedancePollingFramesRef.current.add(frameId);

    // 从 state 中实时获取项目/分集/分镜信息
    const getLogInfo = () => {
      const project = projects.find(p => p.id === projectId);
      const episode = project?.episodes.find(e => e.id === episodeId);
      const frame = episode?.frames.find(f => f.id === frameId);
      return {
        projectName: project?.name || '未知',
        episodeName: episode?.name || '未知',
        frameIndex: frame ? frame.index + 1 : '?',
        sessionName: frame?.videoSessionName || ''
      };
    };

    const logInfo = getLogInfo();
    const logPrefix = `[Seedance轮询] 项目: ${logInfo.projectName} | 分集: ${logInfo.episodeName} | 分镜 #${logInfo.frameIndex}`;

    console.log(`${logPrefix} | 开始轮询任务: ${taskId}${logInfo.sessionName ? ` | 账号: ${logInfo.sessionName}` : ''}`);

    persistFrameVideoState(projectId, episodeId, frameId, frame => ({
      ...frame,
      isGeneratingVideo: true,
      videoTaskStatus: 'waiting',
      videoQueuePosition: undefined,
      videoProgress: 0,
      videoError: undefined,
      seedanceTaskId: taskId,
      seedanceTaskUpdatedAt: Date.now(),
    }));

    try {
      let videoUrl = await pollJimengSeedanceTask(taskId, (progress, sessionName) => {
        const logInfo = getLogInfo();
        const logPrefix = `[Seedance轮询] 项目: ${logInfo.projectName} | 分集: ${logInfo.episodeName} | 分镜 #${logInfo.frameIndex}`;

        // 首次获取到账号名称时输出
        if (sessionName && progress <= 5) {
          console.log(`${logPrefix} | 已分配账号: ${sessionName}`);
        }

        console.log(`${logPrefix} | 进度: ${progress}% | 账号: ${sessionName || '获取中'}`);
        setProjects(prev => prev.map(p => p.id !== projectId ? p : {
          ...p,
          episodes: p.episodes.map(e => e.id !== episodeId ? e : {
            ...e,
            frames: e.frames.map(f => f.id === frameId ? {
              ...f,
              isGeneratingVideo: true,
              videoTaskStatus: 'loading',
              videoQueuePosition: undefined,
              videoProgress: progress,
              videoSessionName: sessionName,
            } : f)
          })
        }));
      });

      if (!videoUrl.startsWith('/api/media/')) {
        const savedVideo = await apiService.saveExternalVideo(videoUrl, `${projectId}_${episodeId}_${frameId}_video`);
        videoUrl = savedVideo.url;
      }
      videoUrl = apiService.toAbsoluteApiUrl(videoUrl);
      const finalLogInfo = getLogInfo();
      console.log(`[视频生成完成] 项目: ${finalLogInfo.projectName} | 分集: ${finalLogInfo.episodeName} | 分镜 #${finalLogInfo.frameIndex} | videoUrl=${videoUrl}`);

      await commitFrameVideoSuccess(projectId, episodeId, frameId, videoUrl, videoDuration, `jimeng:${taskId}`);
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      Logger.logError('App', `生成视频失败 [taskId=${taskId}] [frameId=${frameId}]`, normalizedError);
      const errorMessage = normalizedError.message;
      persistFrameVideoState(projectId, episodeId, frameId, frame => ({
        ...frame,
        isGeneratingVideo: false,
        videoTaskStatus: undefined,
        videoQueuePosition: undefined,
        videoProgress: undefined,
        videoError: mapVideoErrorMessage(errorMessage),
        seedanceTaskId: undefined,
        seedanceTaskUpdatedAt: Date.now(),
      }));
      throw error;
    } finally {
      seedancePollingFramesRef.current.delete(frameId);
    }
  }, [persistFrameVideoState, projects]);

  const enqueueFrameVideoGeneration = useCallback((project: Project, episode: Episode, frameId: string) => {
    const projectId = project.id;
    const episodeId = episode.id;
    const model = project.settings.videoModel;
    const aspectRatio = project.settings.aspectRatio;
    const videoDuration = project.settings.videoDuration || 5;
    const multiRefMode = project.settings.multiRefVideoMode ?? false;
    const prompts = globalSettings.projectTypePrompts[project.type] ?? globalSettings.projectTypePrompts['REAL_PERSON_COMMENTARY'];
    const prefix = prompts.videoGenerationPrefix;

    const frame = episode.frames.find(f => f.id === frameId);
    if (!frame) return;
    if (!multiRefMode && !frame.imageUrl) return;

    console.log(`[视频生成] 项目: ${project.name} | 分集: ${episode.name} | 分镜 #${frame.index + 1} | 模型: ${model}`);

    let multiRefImages: string[] = [];
    let multiRefMapping = '';
    let multiRefFullPrompt = '';

    if (multiRefMode) {
      const multiRefPrefix = (prompts.multiRefVideoGenerationPrefix || '').trim() || prefix;
      let imgIndex = 1;

      const multiRefDebug = {
        frameId,
        frameIndex: frame.index,
        characterIds: [...frame.references.characterIds],
        variantIds: [...(frame.references.variantIds ?? [])],
        sceneIds: [...(frame.references.sceneIds ?? (frame.references.sceneId ? [frame.references.sceneId] : []))],
        collected: [] as Array<{ type: 'character' | 'variant' | 'scene'; id: string; name: string; hasImage: boolean }>,
      };

      frame.references.characterIds.forEach(charId => {
        const char = project.characters.find(c => c.id === charId);
        multiRefDebug.collected.push({
          type: 'character',
          id: charId,
          name: char?.name || '(未找到角色)',
          hasImage: !!char?.imageUrl,
        });
        if (char?.imageUrl) {
          multiRefImages.push(char.imageUrl);
          multiRefMapping += `【@${imgIndex}为${char.name}】`;
          imgIndex++;
        }
      });

      for (const variantId of (frame.references.variantIds ?? [])) {
        const variant = (project.variants ?? []).find(v => v.id === variantId);
        multiRefDebug.collected.push({
          type: 'variant',
          id: variantId,
          name: variant?.name || '(未找到变体)',
          hasImage: !!variant?.imageUrl,
        });
        if (variant?.imageUrl) {
          multiRefImages.push(variant.imageUrl);
          const parentChar = project.characters.find(c => c.id === variant.characterId);
          const variantLabel = parentChar ? `${parentChar.name}的${variant.name}` : variant.name;
          multiRefMapping += `【@${imgIndex}为${variantLabel}】`;
          imgIndex++;
        }
      }

      const effectiveSceneIds = frame.references.sceneIds
        ?? (frame.references.sceneId ? [frame.references.sceneId] : []);
      for (const sceneId of effectiveSceneIds) {
        const scene = project.scenes.find(s => s.id === sceneId);
        multiRefDebug.collected.push({
          type: 'scene',
          id: sceneId,
          name: scene?.name || '(未找到场景)',
          hasImage: !!scene?.imageUrl,
        });
        if (scene?.imageUrl) {
          multiRefImages.push(scene.imageUrl);
          multiRefMapping += `【@${imgIndex}为${scene.name}】`;
          imgIndex++;
        }
      }

      multiRefFullPrompt = `${multiRefPrefix} ${multiRefMapping} ${frame.videoPrompt}`.trim();

      console.log('[多参考视频] 收集结果', {
        ...multiRefDebug,
        finalImageCount: multiRefImages.length,
        finalPrompt: multiRefFullPrompt,
      });
    }

    const fullVideoPrompt = `${prefix} ${frame.videoPrompt}`;
    const capturedImageUrl = frame.imageUrl ?? '';
    const multiRefModel = globalSettings.multiRefVideoModel || 'seedance_2.0_fast';

    const onProgress = (progress: number, sessionName?: string) => {
      setProjects(prev => prev.map(p => p.id !== projectId ? p : {
        ...p,
        episodes: p.episodes.map(e => e.id !== episodeId ? e : {
          ...e,
          frames: e.frames.map(f => f.id === frameId ? {
            ...f,
            videoProgress: progress,
            videoSessionName: sessionName,
            videoTaskStatus: progress <= 1 ? 'waiting' : 'loading'
          } : f)
        })
      }));
    };

    const task = {
      id: uuidv4(),
      type: 'video' as const,
      targetId: frameId,
      projectId,
      episodeId,
      execute: async () => {
        let videoUrl: string;

        if (multiRefMode) {
          const jimengMultiRefModel = multiRefModel === 'seedance_2.0' ? 'seedance-2.0' : 'seedance-2.0-fast';
          const taskId = await submitJimengSeedanceMultiRefTask(
            multiRefImages.length > 0 ? multiRefImages : (capturedImageUrl ? [capturedImageUrl] : []),
            multiRefFullPrompt,
            aspectRatio,
            videoDuration,
            projectId,
            jimengMultiRefModel,
            episodeId,
            frameId
          );
          await startSeedanceTaskPolling(projectId, episodeId, frameId, taskId, videoDuration);
          return;
        } else if (model === 'kling-v3-omni') {
          videoUrl = await generateVideoWithKlingOmni(
            capturedImageUrl, fullVideoPrompt, aspectRatio, videoDuration, projectId, onProgress, frame.githubImageUrl
          );
        } else if (model.startsWith('doubao-seedance')) {
          try {
            videoUrl = await generateVideoWithVolcengine(
              capturedImageUrl, fullVideoPrompt, aspectRatio, videoDuration, onProgress
            );
          } catch (volcErr: any) {
            const volcErrMsg: string = volcErr?.message ?? String(volcErr);
            if (
              volcErrMsg.includes('InputImageSensitiveContentDetected') ||
              volcErrMsg.toLowerCase().includes('output video may contain sensitive')
            ) {
              console.warn('[视频生成] 豆包 Seedance 内容审核拦截，自动切换到速推 Sora 2.0 重试...');
              videoUrl = await generateVideoWithSora(
                capturedImageUrl, fullVideoPrompt, aspectRatio, videoDuration, projectId, onProgress, frame.githubImageUrl
              );
            } else {
              throw volcErr;
            }
          }
        } else if (model.startsWith('jimeng-seedance')) {
          const jimengModel = model === 'jimeng-seedance-2.0' ? 'seedance-2.0' : 'seedance-2.0-fast';
          const taskId = await submitJimengSeedanceImageToVideoTask(
            capturedImageUrl,
            fullVideoPrompt,
            aspectRatio,
            videoDuration,
            projectId,
            jimengModel,
            frame.githubImageUrl,
            episodeId,
            frameId
          );
          await startSeedanceTaskPolling(projectId, episodeId, frameId, taskId, videoDuration);
          return;
        } else if (model.startsWith('seedance-2')) {
          videoUrl = await generateVideoWithSeedance(
            capturedImageUrl, fullVideoPrompt, aspectRatio, videoDuration, projectId, onProgress
          );
        } else if (model.startsWith('sora-2')) {
          videoUrl = await generateVideoWithSora(
            capturedImageUrl, fullVideoPrompt, aspectRatio, videoDuration, projectId, onProgress, frame.githubImageUrl
          );
        } else if (model === 'bltcy-sora-2') {
          videoUrl = await generateVideoWithBltcySora(
            capturedImageUrl, fullVideoPrompt, aspectRatio, videoDuration, projectId, onProgress, frame.githubImageUrl, 'sora-2'
          );
        } else if (model === 'bltcy-veo3') {
          videoUrl = await generateVideoWithBltcyVeo3(
            capturedImageUrl, fullVideoPrompt, aspectRatio, videoDuration, projectId, onProgress, frame.githubImageUrl
          );
        } else if (model === 'bltcy-wan-2-6') {
          videoUrl = await generateVideoWithBltcyWan26(
            capturedImageUrl, fullVideoPrompt, aspectRatio, videoDuration, projectId, onProgress, frame.githubImageUrl
          );
        } else if (model === 'bltcy-grok-video-3') {
          videoUrl = await generateVideoWithBltcyGrokVideo3(
            capturedImageUrl, fullVideoPrompt, aspectRatio, videoDuration, projectId, onProgress, frame.githubImageUrl
          );
        } else {
          videoUrl = await generateVideoFromImage(capturedImageUrl, fullVideoPrompt, model);
        }

        if (!videoUrl.startsWith('/api/media/')) {
          const savedVideo = await apiService.saveExternalVideo(videoUrl, `${projectId}_${episodeId}_${frameId}_video`);
          videoUrl = savedVideo.url;
        }
        videoUrl = apiService.toAbsoluteApiUrl(videoUrl);
        console.log(`[视频生成完成] 项目: ${project.name} | 分集: ${episode.name} | 分镜 #${frame.index + 1} | videoUrl=${videoUrl}`);

        const seedanceSuccessTaskKey = model.startsWith('seedance-2') ? `seedance:${projectId}:${episodeId}:${frameId}:${videoUrl}` : undefined;
        await commitFrameVideoSuccess(projectId, episodeId, frameId, videoUrl, videoDuration, seedanceSuccessTaskKey);
      },
      onError: (error: string) => {
        Logger.logError('App', '生成视频失败', error);
        persistFrameVideoState(projectId, episodeId, frameId, currentFrame => ({
          ...currentFrame,
          isGeneratingVideo: false,
          videoTaskStatus: undefined,
          videoQueuePosition: undefined,
          videoProgress: undefined,
          videoError: mapVideoErrorMessage(error),
          seedanceTaskId: undefined,
          seedanceTaskUpdatedAt: Date.now(),
        }));
      }
    };

    persistFrameVideoState(projectId, episodeId, frameId, currentFrame => ({
      ...currentFrame,
      isGeneratingVideo: false,
      videoTaskStatus: 'waiting',
      videoQueuePosition: undefined,
      videoProgress: 0,
      videoError: undefined,
      seedanceTaskId: undefined,
      seedanceTaskUpdatedAt: Date.now(),
    }));

    taskQueue.enqueue(task);
  }, [globalSettings, persistFrameVideoState, startSeedanceTaskPolling]);

  // Storyboard View State
  const [storyboardViewMode, setStoryboardViewMode] = useState<'GRID' | 'TIMELINE'>('GRID');
  const [currentPlaybackIndex, setCurrentPlaybackIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const timelineVideoRef = useRef<HTMLVideoElement>(null);
  const timelineAudioRef = useRef<HTMLAudioElement>(null);
  // Ref to the "advance to next frame" function for the current frame.
  // When audio drives advancement (video+audio frames), video.onEnded must not also advance.
  const audioEndedHandlerRef = useRef<(() => void) | null>(null);
  const [selectedFrameIds, setSelectedFrameIds] = useState<string[]>([]); // Batch selection
  const [useVideoPromptForImage, setUseVideoPromptForImage] = useState(false); // 用视频提示词生图
  const [draggedFrameIndex, setDraggedFrameIndex] = useState<number | null>(null); // For Drag & Drop

  // Asset Management State
  const [selectedCharacterIds, setSelectedCharacterIds] = useState<string[]>([]);
  const [selectedSceneIds, setSelectedSceneIds] = useState<string[]>([]);
  const [selectedVariantIds, setSelectedVariantIds] = useState<string[]>([]);
  const [editingAsset, setEditingAsset] = useState<{type: 'character' | 'scene', id: string} | null>(null);
  const [editingVariant, setEditingVariant] = useState<{ id: string } | null>(null);
  const [previewVariant, setPreviewVariant] = useState<{ id: string } | null>(null);

  // Modal State
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showRecycleBinModal, setShowRecycleBinModal] = useState(false);
  const [recycleBinProjects, setRecycleBinProjects] = useState<Array<Project & { deletedAt?: number }>>([]);
  const [isRecycleBinLoading, setIsRecycleBinLoading] = useState(false);
  const [showEpisodeRecycleBinModal, setShowEpisodeRecycleBinModal] = useState(false);
  const [episodeRecycleBin, setEpisodeRecycleBin] = useState<Array<Episode & { deletedAt: number }>>([]);
  const [isEpisodeRecycleBinLoading, setIsEpisodeRecycleBinLoading] = useState(false);
  const [isOpeningProject, setIsOpeningProject] = useState(false);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [editingFrameId, setEditingFrameId] = useState<string | null>(null); // For FrameEditorModal
  const [showFindReplace, setShowFindReplace] = useState(false); // For FindReplaceModal
  const [showFolderPrompt, setShowFolderPrompt] = useState(false); // For folder selection prompt
  const [previewFrameId, setPreviewFrameId] = useState<string | null>(null);
  const [previewFrameMode, setPreviewFrameMode] = useState<'image' | 'video'>('image');
  const [previewAsset, setPreviewAsset] = useState<{ type: 'character' | 'scene'; id: string } | null>(null);

  type PreprocessTaskStage = 'connectivity' | 'asset_extraction' | 'segmenting' | 'second_pass' | 'completed' | 'failed' | 'interrupted';
  type PreprocessTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
  type PreprocessTaskState = {
    id: string;
    type: 'novel' | 'episode';
    projectId: string;
    episodeId?: string;
    episodeName?: string;
    status: PreprocessTaskStatus;
    stage: PreprocessTaskStage;
    error?: string;
    resultAppliedAt?: number;
    input?: {
      episodeDrafts?: Array<{ title: string; content: string }>;
      episodeId?: string;
      episodeName?: string;
      originalContent?: string;
    };
    progress: {
      total: number;
      completed: number;
      currentEpisodeName?: string;
      assetExtractionDone?: boolean;
      secondPassCompleted?: number;
    };
    results: {
      analysis?: AnalysisResult;
      segmentedScripts?: Array<SegmentEpisodeResult | null>;
      finalScripts?: Array<SegmentEpisodeResult | null>;
      secondPassFailedIndexes?: number[];
      episodeResult?: { content: string; failed: boolean; secondPassFailed?: boolean };
      availableProviders?: Array<'univibe' | 'bltcy' | 'cc580'>;
    };
  };

  // 小说预处理 Modal
  const [showNovelPreprocessModal, setShowNovelPreprocessModal] = useState(false);
  const [preprocessNovelText, setPreprocessNovelText] = useState('');
  const [isPreprocessing, setIsPreprocessing] = useState(false);
  const [enableSecondPass, setEnableSecondPass] = useState(false);
  const [enableAutoStoryboard, setEnableAutoStoryboard] = useState(false);
  const [storyboardProgress, setStoryboardProgress] = useState<{ current: number; total: number; currentName: string } | null>(null);
  const [showEpisodePreprocessModal, setShowEpisodePreprocessModal] = useState(false);
  const [isEpisodePreprocessing, setIsEpisodePreprocessing] = useState(false);
  const [enableEpisodeSecondPass, setEnableEpisodeSecondPass] = useState(false);
  const [episodePreprocessResult, setEpisodePreprocessResult] = useState<string | null>(null);
  const [showEpisodePreprocessPreview, setShowEpisodePreprocessPreview] = useState(false);
  const [activeNovelPreprocessTaskId, setActiveNovelPreprocessTaskId] = useState<string | null>(null);
  const [activeEpisodePreprocessTaskId, setActiveEpisodePreprocessTaskId] = useState<string | null>(null);
  const [novelPreprocessTaskState, setNovelPreprocessTaskState] = useState<PreprocessTaskState | null>(null);
  const [episodePreprocessTaskState, setEpisodePreprocessTaskState] = useState<PreprocessTaskState | null>(null);

  // Claude 提供商切换（预处理失败重试）
  const [showClaudeProviderModal, setShowClaudeProviderModal] = useState(false);
  const [preprocessRetryData, setPreprocessRetryData] = useState<{
    episodeDrafts: any[];
    latestDirectorSkillPrompt: string;
    systemInstruction: string;
    textForAssets: string;
    error: Error;
  } | null>(null);

  // Auto-rewrite + retry guard (avoid infinite loops)
  const autoRewriteRetryRef = useRef<Set<string>>(new Set());

  const isPolicyViolationError = (error: string): boolean => {
    const msg = (error ?? '').toLowerCase();

    // BananaPro: explicit mapped CN messages
    if (error.includes('违反内容政策')) return true;

    // Common moderation / policy keywords across providers
    return (
      msg.includes('moderation') ||
      msg.includes('content policy') ||
      msg.includes('content_policy') ||
      msg.includes('safety') ||
      msg.includes('nsfw') ||
      msg.includes('色情') ||
      msg.includes('未成年人') ||
      msg.includes('血腥') ||
      msg.includes('暴力') ||
      msg.includes('审核拦截') ||
      msg.includes('内容不合规')
    );
  };

  // Export State
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportMessage, setExportMessage] = useState('');
  const [isExportingStoryboardZip, setIsExportingStoryboardZip] = useState(false);
  const [storyboardZipMessage, setStoryboardZipMessage] = useState('');
  const [isExportingAssetZip, setIsExportingAssetZip] = useState(false);
  const [assetZipMessage, setAssetZipMessage] = useState('');

  const [newProjectData, setNewProjectData] = useState<{name: string, type: ProjectType, settings: ProjectSettings}>({
    name: '',
    type: 'REAL_PERSON_COMMENTARY',
    settings: { ...DEFAULT_SETTINGS }
  });

  // ===== 辅助函数：更新 Episode 的处理状态 =====
  const setEpisodeProcessing = (episodeId: string, isProcessing: boolean) => {
    setProjects(prevProjects =>
      prevProjects.map(project =>
        project.id === currentProjectId
          ? {
              ...project,
              episodes: project.episodes.map(ep =>
                ep.id === episodeId ? { ...ep, isProcessing } : ep
              )
            }
          : project
      )
    );
  };

  // Computed
  const currentProject = projects.find(p => p.id === currentProjectId);
  const currentEpisode = currentProject?.episodes.find(e => e.id === currentEpisodeId);
  const projectStatsSummary = buildProjectStatsSummary(currentProject);

  const recordTextUsage = useCallback(async ({
    provider,
    projectId,
    taskType,
    sourceId,
    operationId,
    result,
  }: {
    provider: 'claude' | 'gemini' | 'volcengine';
    projectId: string;
    taskType: string;
    sourceId: string;
    operationId: string;
    result: { usage?: any; model?: string } | null | undefined;
  }) => {
    const payload = buildProjectTextUsagePayload({
      provider,
      projectId,
      taskType,
      sourceId,
      operationId,
      result,
    });

    if (!payload) {
      return;
    }

    try {
      await apiService.recordProjectTextUsage(projectId, payload);
    } catch (error) {
      console.error(`[项目统计] ${provider} token 上报失败:`, error);
    }
  }, []);
  const failedPreprocessEpisodes = getFailedPreprocessEpisodes(currentProject?.episodes ?? []);
  const activeFrameTasks = useMemo(() => {
    const grouped = new Map<string, ActiveTask>();
    for (const task of activeTasks) {
      const frameKey = `${task.projectId}:${task.episodeId}:${task.frameId}`;
      const existing = grouped.get(frameKey);
      if (!existing) {
        grouped.set(frameKey, task);
        continue;
      }
      const score = (item: ActiveTask) => item.status === 'processing' ? 2 : 1;
      if (score(task) > score(existing) || (score(task) === score(existing) && task.startTime > existing.startTime)) {
        grouped.set(frameKey, task);
      }
    }
    return grouped;
  }, [activeTasks]);

  const getFrameActiveTask = useCallback((projectId: string, episodeId: string, frameId: string) => {
    return activeFrameTasks.get(`${projectId}:${episodeId}:${frameId}`);
  }, [activeFrameTasks]);

  const getDerivedFrameVideoTaskStatus = useCallback((projectId: string | undefined, episodeId: string | undefined, frame: StoryboardFrame | undefined) => {
    const backendTask = projectId && episodeId && frame ? getFrameActiveTask(projectId, episodeId, frame.id) : undefined;
    const videoTaskStatus = backendTask?.status === 'processing' ? 'loading' : backendTask?.status === 'waiting' ? 'waiting' : frame?.videoTaskStatus;
    return { backendTask, videoTaskStatus };
  }, [getFrameActiveTask]);

  const mapVideoErrorMessage = useCallback((message: string) => {
    if (!message) return message;
    let normalized = message;
    if (normalized.includes('2038') || normalized.includes('内容被过滤')) {
      normalized = normalized.replace(/内容被过滤，请修改提示词后重试|视频生成失败，错误码:\s*2038/g, '输入的文字不符合平台规则');
    }
    if (normalized.includes('2039') || normalized.includes('图片不符合平台规则')) {
      normalized = normalized.replace(/视频生成失败，错误码:\s*2039|图片不符合平台规则/g, '输入的图片不符合平台规则');
    }
    if (normalized.includes('2043') || normalized.includes('未通过审核')) {
      normalized = normalized.replace(/视频生成失败，错误码:\s*2043|结果未通过审核|未通过审核/g, '视频生成结果未通过审核');
    }
    return normalized;
  }, []);

  const hasAnyAssetImages = Boolean(
    currentProject && (
      (currentProject.characters || []).some(character => !!character.imageUrl) ||
      (currentProject.variants || []).some(variant => !!variant.imageUrl) ||
      (currentProject.scenes || []).some(scene => !!scene.imageUrl)
    )
  );
  const editingFrame = currentEpisode?.frames.find(f => f.id === editingFrameId);
  const previewFrame = currentEpisode?.frames.find(f => f.id === previewFrameId);
  const deriveFrameVideoState = useCallback((projectId: string | undefined, episodeId: string | undefined, frame: StoryboardFrame | undefined) => {
    if (!projectId || !episodeId || !frame) {
      return {
        backendTask: undefined,
        videoTaskStatus: frame?.videoTaskStatus,
        videoQueuePosition: frame?.videoQueuePosition,
        isGeneratingVideo: frame?.isGeneratingVideo,
        videoSessionName: frame?.videoSessionName,
      };
    }

    const backendTask = getFrameActiveTask(projectId, episodeId, frame.id);
    if (backendTask) {
      return {
        backendTask,
        videoTaskStatus: backendTask.status === 'processing' ? 'loading' : 'waiting',
        videoQueuePosition: backendTask.status === 'waiting' ? undefined : undefined,
        isGeneratingVideo: true,
        videoSessionName: backendTask.sessionName || frame.videoSessionName,
      };
    }

    return {
      backendTask: undefined,
      videoTaskStatus: frame.videoTaskStatus,
      videoQueuePosition: frame.videoQueuePosition,
      isGeneratingVideo: frame.isGeneratingVideo,
      videoSessionName: frame.videoSessionName,
    };
  }, [getFrameActiveTask]);
  const previewAssetItem = previewAsset
    ? previewAsset.type === 'character'
      ? currentProject?.characters.find(c => c.id === previewAsset.id)
      : currentProject?.scenes.find(s => s.id === previewAsset.id)
    : undefined;

  // --- Effects ---
  useEffect(() => {
    const unsubscribe = taskQueue.subscribe((statuses) => {
      setProjects(prev => prev.map(project => ({
        ...project,
        episodes: project.episodes.map(episode => ({
          ...episode,
          frames: episode.frames.map(frame => {
            const status = Array.from(statuses.values()).find(s => s.type === 'video' && s.targetId === frame.id && (s.status === 'queued' || s.status === 'running'));
            if (!status) {
              if (frame.videoTaskStatus === 'waiting' && !frame.seedanceTaskId) {
                return { ...frame, videoTaskStatus: 'waiting', videoQueuePosition: undefined };
              }
              if (frame.videoTaskStatus === 'loading' && frame.seedanceTaskId) {
                return { ...frame, isGeneratingVideo: true, videoTaskStatus: 'loading', videoQueuePosition: undefined };
              }
              if (frame.videoTaskStatus || frame.videoQueuePosition !== undefined) {
                return { ...frame, videoTaskStatus: frame.isGeneratingVideo ? 'loading' : undefined, videoQueuePosition: undefined };
              }
              return frame;
            }

            return {
              ...frame,
              isGeneratingVideo: status.status === 'running' ? true : frame.isGeneratingVideo,
              videoTaskStatus: status.status === 'queued' ? 'waiting' : 'loading',
              videoQueuePosition: status.status === 'queued' ? status.queuePosition : undefined,
            };
          })
        }))
      })));
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    // 初始化：从后端加载项目和全局设置
    const initializeApp = async () => {
      try {
        console.log('🔄 正在从后端加载数据...');

        // 检查服务器连接
        const isServerOnline = await apiService.checkHealth();
        if (!isServerOnline) {
          console.error('❌ 无法连接到服务器，请确保后端服务器正在运行');
          alert('无法连接到服务器！\n\n请确保:\n1. 后端服务器已启动 (npm run server)\n2. 服务器地址正确 (http://localhost:3001)');
          setIsGlobalSettingsInitialized(true);
          return;
        }

        // 加载所有项目
        try {
          const loadedProjects = await apiService.getAllProjects();
          const normalizedProjects = normalizeProjects(loadedProjects);

          // 初始化资产和分集快照
          savedAssetsRef.current = new Map(normalizedProjects.map(p => [
            p.id,
            JSON.stringify({ characters: p.characters, scenes: p.scenes, variants: p.variants })
          ]));
          savedEpisodesRef.current = new Map();
          normalizedProjects.forEach(p => {
            p.episodes.forEach(e => {
              savedEpisodesRef.current!.set(e.id, e.updatedAt);
            });
          });

          setProjects(normalizedProjects);
          console.log(`✅ 已加载 ${loadedProjects.length} 个项目`);

          // 后台迁移旧 Base64 图片为服务器 URL（非阻塞，不影响启动速度）
          void (async () => {
            let migratedCount = 0;
            for (const project of normalizedProjects) {
              try {
                const { migrated, changed } = await migrateProjectImages(project);
                if (changed) {
                  migrated.updatedAt = Date.now();
                  await apiService.updateProject(migrated.id, migrated);
                  setProjects(prev => prev.map(p => p.id === migrated.id ? migrated : p));
                  migratedCount++;
                }
              } catch (err) {
                console.warn(`[迁移] 项目 ${project.id} Base64 图片迁移失败:`, err);
              }
            }
            if (migratedCount > 0) {
              console.log(`✅ 已完成 ${migratedCount} 个项目的 Base64 图片迁移`);
            }
          })();

          const projectsNeedingMigration = loadedProjects.filter((project: Project) => {
            const imageModel = project.settings?.imageModel;
            return imageModel === 'nano-banana-pro' || !imageModel;
          });

          if (projectsNeedingMigration.length > 0) {
            const normalizedById = new Map(normalizedProjects.map(p => [p.id, p]));
            await Promise.all(
              projectsNeedingMigration
                .map(p => normalizedById.get(p.id))
                .filter((p): p is Project => !!p)
                .map(p => apiService.updateProject(p.id, p))
            );
          }
        } catch (error) {
          console.error('❌ 加载项目失败:', error);
        }

        // 加载全局设置
        try {
          const loadedSettings = await apiService.getSettings();
          const supportedExtractionModels = [
            'doubao-seed-2-0-pro-260215',
            'claude-sonnet-4-6',
            'gemini-3-flash-preview',
            'gemini-3-pro-preview',
            'gemini-2.5-flash'
          ];

          let needsMigration = false;
          const migratedSettings: GlobalSettings = {
            extractionModel: loadedSettings.extractionModel,
            preprocessModel: loadedSettings.preprocessModel || 'claude-sonnet-4-6',
            projectTypePrompts: loadedSettings.projectTypePrompts || {},
            projectTypeLabels: loadedSettings.projectTypeLabels || { ...DEFAULT_GLOBAL_SETTINGS.projectTypeLabels },
            // 剪映路径从 .env.local 读取（所有客户端共享网络驱动器）
            jianyingExportPath: import.meta.env.VITE_JIANYING_EXPORT_PATH || '',
            jianyingExportPathFull: import.meta.env.VITE_JIANYING_EXPORT_PATH_FULL || '',
          };

          if (!supportedExtractionModels.includes(migratedSettings.extractionModel)) {
            migratedSettings.extractionModel = DEFAULT_GLOBAL_SETTINGS.extractionModel;
            needsMigration = true;
          }

          Object.keys(DEFAULT_GLOBAL_SETTINGS.projectTypePrompts).forEach((type) => {
            const projectType = type as ProjectType;
            const defaultPrompts = DEFAULT_GLOBAL_SETTINGS.projectTypePrompts[projectType];
            const currentPrompts = migratedSettings.projectTypePrompts[projectType];

            if (!currentPrompts) {
              migratedSettings.projectTypePrompts[projectType] = { ...defaultPrompts };
              needsMigration = true;
              return;
            }

            const hasMissingFields = Object.keys(defaultPrompts).some((key) => {
              return currentPrompts[key as keyof ProjectTypeInstruction] === undefined;
            });

            if (hasMissingFields) {
              migratedSettings.projectTypePrompts[projectType] = { ...defaultPrompts, ...currentPrompts };
              needsMigration = true;
            }
          });

          Object.keys(DEFAULT_GLOBAL_SETTINGS.projectTypeLabels || {}).forEach((type) => {
            if (!migratedSettings.projectTypeLabels?.[type]) {
              migratedSettings.projectTypeLabels = {
                ...migratedSettings.projectTypeLabels,
                [type]: DEFAULT_GLOBAL_SETTINGS.projectTypeLabels?.[type] || type,
              };
              needsMigration = true;
            }
          });

          if (needsMigration) {
            console.log('🔄 全局设置数据迁移：已添加缺失的字段');
            setGlobalSettings(migratedSettings);
            savedGlobalSettingsRef.current = JSON.stringify(migratedSettings);
            await apiService.updateSettings(migratedSettings);
          } else {
            console.log('✅ 全局设置加载成功');
            setGlobalSettings(migratedSettings);
            savedGlobalSettingsRef.current = JSON.stringify(migratedSettings);
          }
        } catch (error) {
          console.error('❌ 加载全局设置失败，使用默认设置:', error);
          setGlobalSettings(DEFAULT_GLOBAL_SETTINGS);
          savedGlobalSettingsRef.current = JSON.stringify(DEFAULT_GLOBAL_SETTINGS);
        }

        // 标记全局设置已初始化完成
        setIsGlobalSettingsInitialized(true);
        console.log('✅ 应用初始化完成');
      } catch (error) {
        console.error('❌ 初始化应用失败:', error);
        alert('初始化失败：' + (error as Error).message);
        setGlobalSettings(DEFAULT_GLOBAL_SETTINGS);
        setIsGlobalSettingsInitialized(true);
      }
    };

    initializeApp();
  }, []);

  // 轮询活动任务
  useEffect(() => {
    const pollTasks = async () => {
      try {
        const tasks = await getActiveTasks();
        setActiveTasks(tasks);
      } catch (err) {
        console.warn('[活动任务] 获取失败:', err);
      }
    };
    pollTasks();
    const interval = setInterval(pollTasks, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!isGlobalSettingsInitialized || seedanceRecoveryStartedRef.current) return;
    if (projects.length === 0) return;

    seedanceRecoveryStartedRef.current = true;

    const activeTaskByFrameKey = new Map(Array.from(activeFrameTasks.entries()));

    projects.forEach(project => {
      project.episodes.forEach(episode => {
        episode.frames.forEach(frame => {
          const frameKey = `${project.id}:${episode.id}:${frame.id}`;
          const backendTask = activeTaskByFrameKey.get(frameKey);

          if (backendTask) {
            void startSeedanceTaskPolling(
              project.id,
              episode.id,
              frame.id,
              backendTask.id,
              frame.videoDuration ?? project.settings.videoDuration ?? 5
            ).catch(() => {});
            return;
          }

          if (frame.videoTaskStatus === 'waiting' || frame.videoTaskStatus === 'loading' || frame.isGeneratingVideo) {
            persistFrameVideoState(project.id, episode.id, frame.id, currentFrame => ({
              ...currentFrame,
              isGeneratingVideo: false,
              videoTaskStatus: undefined,
              videoQueuePosition: undefined,
              videoProgress: undefined,
            }));
          }
        });
      });
    });
  }, [activeFrameTasks, isGlobalSettingsInitialized, projects, startSeedanceTaskPolling, persistFrameVideoState]);

  useEffect(() => {
    // 自动保存资产到后端（只在资产修改后保存）
    if (savedAssetsRef.current === null) return;
    if (!currentProject) return;

    const currentAssets = {
      characters: currentProject.characters,
      scenes: currentProject.scenes,
      variants: currentProject.variants
    };
    const currentSnapshot = JSON.stringify(currentAssets);
    const savedSnapshot = savedAssetsRef.current.get(currentProject.id);

    if (savedSnapshot === currentSnapshot) {
      return; // 未修改，跳过保存
    }

    const saveAssets = async () => {
      try {
        await apiService.updateProjectAssets(currentProject.id, currentAssets);
        savedAssetsRef.current!.set(currentProject.id, currentSnapshot);
        console.log(`✅ 已自动保存项目资产: ${currentProject.name}`);
      } catch (error) {
        console.error('资产保存失败:', error);
      }
    };

    const timeoutId = setTimeout(saveAssets, 500);
    return () => clearTimeout(timeoutId);
  }, [currentProject?.characters, currentProject?.scenes, currentProject?.variants, currentProject?.id]);

  useEffect(() => {
    // 自动保存分集到后端（只在分镜/TTS 操作后保存）
    if (savedEpisodesRef.current === null) return;
    if (!currentProject || !currentEpisode) return;

    const savedAt = savedEpisodesRef.current.get(currentEpisode.id);
    if (savedAt === currentEpisode.updatedAt) {
      return; // 未修改，跳过保存
    }

    const saveEpisode = async () => {
      try {
        await apiService.updateEpisode(currentProject.id, currentEpisode.id, currentEpisode);
        savedEpisodesRef.current!.set(currentEpisode.id, currentEpisode.updatedAt);
        console.log(`✅ 已自动保存分集: ${currentProject.name} / ${currentEpisode.name}`);
      } catch (error) {
        console.error('分集保存失败:', error);
      }
    };

    const timeoutId = setTimeout(saveEpisode, 500);
    return () => clearTimeout(timeoutId);
  }, [currentEpisode?.updatedAt, currentEpisode?.id, currentProject?.id]);


  // Reset selection when changing tabs or episodes
  useEffect(() => {
    setSelectedFrameIds([]);
    setSelectedCharacterIds([]);
    setSelectedSceneIds([]);
  }, [activeTab, currentEpisodeId]);

  const applyNovelPreprocessTaskResult = useCallback(async (task: PreprocessTaskState) => {
    if (!currentProject || task.resultAppliedAt) return;

    const analysis = task.results.analysis;
    const finalScripts = task.results.finalScripts ?? task.results.segmentedScripts;
    if (!analysis || !finalScripts || finalScripts.length === 0) {
      throw new Error('预处理任务结果不完整，无法应用');
    }

    const episodeDrafts = task.input?.episodeDrafts && task.input.episodeDrafts.length > 0
      ? task.input.episodeDrafts
      : splitNovelIntoEpisodes(preprocessNovelText);
    if (episodeDrafts.length === 0) {
      throw new Error('当前未找到可应用的章节草稿，请重新选择原始 txt 文件');
    }
    if (episodeDrafts.length !== finalScripts.length) {
      throw new Error('当前章节拆分结果与任务结果数量不一致，请重新发起预处理');
    }

    const now = Date.now();
    const newEpisodes: Episode[] = episodeDrafts.map((draft, i) => buildEpisodeFromPreprocessResult({
      id: uuidv4(),
      name: draft.title,
      scriptContent: draft.content,
      frames: [],
      updatedAt: now + i,
    }, finalScripts[i] || undefined));

    const existingCharNames = new Set(currentProject.characters.map(c => c.name));
    const existingSceneNames = new Set(currentProject.scenes.map(s => s.name));

    const newCharacters: Character[] = (analysis.characters || [])
      .filter(c => !existingCharNames.has(c.name))
      .map(c => {
        const normalized = normalizeCharacterInput(c.name, c.aliases);
        return { ...c, ...normalized, id: uuidv4(), aliases: normalized.aliases };
      });

    const newScenes: Scene[] = (analysis.scenes || [])
      .filter(s => !existingSceneNames.has(s.name))
      .map(s => ({ ...s, id: uuidv4() }));

    const allCharacters = [...currentProject.characters, ...newCharacters];
    const existingVariantKeys = new Set((currentProject.variants ?? []).map(v => `${v.characterId}::${v.name}`));
    const newVariants: CharacterVariant[] = (analysis.variants ?? [])
      .map(v => {
        const char = allCharacters.find(c => c.name === v.characterName || (c.aliases ?? []).includes(v.characterName));
        if (!char) return null;
        const key = `${char.id}::${v.name}`;
        if (existingVariantKeys.has(key)) return null;
        return { id: uuidv4(), characterId: char.id, name: v.name, context: v.context, appearance: v.appearance } as CharacterVariant;
      })
      .filter((v): v is CharacterVariant => v !== null);

    const updatedProject = {
      ...currentProject,
      episodes: [...currentProject.episodes, ...newEpisodes],
      characters: [...currentProject.characters, ...newCharacters],
      scenes: [...currentProject.scenes, ...newScenes],
      variants: [...(currentProject.variants ?? []), ...newVariants],
      updatedAt: Date.now(),
    };

    await apiService.updateProject(currentProject.id, updatedProject);
    setProjects(prev => prev.map(p => p.id === currentProject.id ? updatedProject : p));
    newEpisodes.forEach(e => savedEpisodesRef.current?.set(e.id, e.updatedAt));
    await apiService.markPreprocessTaskApplied(task.id);
    setNovelPreprocessTaskState(prev => prev && prev.id === task.id ? { ...prev, resultAppliedAt: Date.now() } : prev);

    setShowNovelPreprocessModal(false);
    setPreprocessNovelText('');

    const secondPassFailedIndexes = task.results.secondPassFailedIndexes ?? [];
    const failedTitles = episodeDrafts
      .filter((_, i) => finalScripts[i]?.failed)
      .map(d => `• ${d.title}`);
    const secondPassFailedTitles = episodeDrafts
      .filter((_, i) => secondPassFailedIndexes.includes(i))
      .map(d => `• ${d.title}`);

    const messages: string[] = [];
    if (failedTitles.length > 0) {
      messages.push(`分段失败（${failedTitles.length} 个，已用原文填充，可通过单集预处理重试）：\n${failedTitles.join('\n')}`);
    }
    if (secondPassFailedTitles.length > 0) {
      messages.push(`二次加工失败（${secondPassFailedTitles.length} 个，已回退为章节原始文本）：\n${secondPassFailedTitles.join('\n')}`);
    }
    if (messages.length > 0) {
      alert(`预处理完成，但存在以下问题：\n\n${messages.join('\n\n')}`);
    }

    // 自动分镜拆解
    if (enableAutoStoryboard) {
      const successEpisodes = newEpisodes.filter((_, i) => !finalScripts[i]?.failed);
      if (successEpisodes.length > 0) {
        executeAutoStoryboard(updatedProject, successEpisodes);
      }
    }
  }, [currentProject, preprocessNovelText, enableAutoStoryboard]);

  const applyEpisodePreprocessTaskResult = useCallback(async (task: PreprocessTaskState) => {
    if (!currentEpisode || !task.results.episodeResult) return;
    if (task.resultAppliedAt) return;

    const result = task.results.episodeResult;
    setEpisodePreprocessResult(result.content);
    setShowEpisodePreprocessModal(false);
    setShowEpisodePreprocessPreview(true);
    await apiService.markPreprocessTaskApplied(task.id);
    setEpisodePreprocessTaskState(prev => prev && prev.id === task.id ? { ...prev, resultAppliedAt: Date.now() } : prev);

    if (result.secondPassFailed) {
      alert('二次加工失败，预览内容已回退为分集原始文本。');
    }
  }, [currentEpisode]);

  const executeAutoStoryboard = async (project: Project, episodes: Episode[]) => {
    const failedList: string[] = [];
    const total = episodes.length;

    for (let i = 0; i < total; i++) {
      const episode = episodes[i];
      setStoryboardProgress({ current: i + 1, total, currentName: episode.name });

      try {
        const prompts = globalSettings.projectTypePrompts[project.type] ?? globalSettings.projectTypePrompts['REAL_PERSON_COMMENTARY'];
        const model = globalSettings.extractionModel;
        const isVolcengineModel = model.startsWith('doubao');
        const isClaudeModel = isClaudeChatModel(model);

        const characterChoices = project.characters.map(c => ({ name: c.name, aliases: c.aliases ?? [] }));
        const sceneChoices = project.scenes.map(s => ({ name: s.name }));
        const variantChoices = (project.variants ?? []).map(v => ({
          name: v.name,
          characterName: project.characters.find(c => c.id === v.characterId)?.name ?? '',
          context: v.context ?? ''
        }));

        const assetMatchingInstruction = `你必须在以下"候选资产列表"中为每个分镜匹配引用资产：

1) 角色匹配规则：
- frame.characterNames 必须只填写候选角色的 name（禁止输出别称/原文中的称呼/括号注释）
- 允许你根据 aliases 做理解，但最终输出必须是候选的 name
- 若该帧无可匹配角色：请输出 characterNames: [] 或直接省略 characterNames 字段

2) 场景匹配规则：
- frame.sceneNames 填写候选场景的 name 列表（可匹配多个场景，禁止输出自造场景名）
- 若该帧无可匹配场景：请直接省略 sceneNames 字段（不要输出空数组）

3) 变体资产匹配规则：
- frame.variantNames 填写候选变体资产的 name（角色特定服装/外貌版本）
- 当该帧场景/文本明确涉及某角色的特定服装或特殊外貌状态时，填写对应变体名
- 变体名必须完全匹配候选变体资产的 name（禁止自造变体名）
- 若无匹配变体：省略 variantNames 字段

4) 对白输出规则：
- 优先输出 frame.dialogues: [{ speakerName, text }, ...]
- speakerName 必须是候选角色列表里的 name（严格一致），不要输出别称
- narration/独白/未明确说话人：省略 speakerName（或给空字符串）
- 一个分镜内允许多个说话人、多段对白，按出现顺序输出
- 可选：同时输出 frame.dialogue 作为兼容字段（多行 "说话人：台词"）

候选角色列表（name + aliases）：\n${JSON.stringify(characterChoices)}\n
候选变体资产列表（name + characterName + context）：\n${JSON.stringify(variantChoices)}\n
候选场景列表（name）：\n${JSON.stringify(sceneChoices)}\n`;

        const storyboardSystemInstruction = `${prompts.storyboardBreakdown}\n\n${assetMatchingInstruction}`;
        const breakdown = isClaudeModel
          ? await generateStoryboardBreakdownWithClaude(episode.scriptContent, storyboardSystemInstruction)
          : isVolcengineModel
          ? await generateStoryboardBreakdownVolcengine(episode.scriptContent, model, storyboardSystemInstruction)
          : await generateStoryboardBreakdownGemini(episode.scriptContent, model, storyboardSystemInstruction);

        const newFrames: StoryboardFrame[] = breakdown.frames.map((f, idx) => {
          const charIds = (f.characterNames || [])
            .map(name => project.characters.find(c => matchesCharacter(c, name))?.id)
            .filter((id): id is string => !!id);

          const variantIds = (f.variantNames || [])
            .map(name => (project.variants ?? []).find(v => v.name === name)?.id)
            .filter((id): id is string => !!id);

          const variantOwnerCharIds = new Set(
            variantIds
              .map(vid => (project.variants ?? []).find(v => v.id === vid)?.characterId)
              .filter((id): id is string => !!id)
          );
          const dedupedCharIds = charIds.filter(cid => !variantOwnerCharIds.has(cid));

          const sceneNames = (f.sceneNames ?? (f.sceneName ? [f.sceneName] : []));
          const sceneIds = sceneNames
            .map(name => project.scenes.find(s => s.name.toLowerCase().includes(name.toLowerCase()))?.id)
            .filter((id): id is string => !!id);
          const deduped = [...new Set(sceneIds)];

          const dialogues = normalizeDialogues(f.dialogues) ?? splitDialogueStringToDialogues(f.dialogue);
          const dialogue = mergeDialoguesToDisplayString(dialogues) ?? f.dialogue;

          return {
            id: uuidv4(),
            index: idx,
            imagePrompt: f.imagePrompt,
            videoPrompt: f.videoPrompt,
            dialogues,
            dialogue,
            originalText: f.originalText,
            references: {
              characterIds: [...new Set(dedupedCharIds)],
              variantIds: variantIds.length > 0 ? [...new Set(variantIds)] : undefined,
              sceneId: deduped[0],
              sceneIds: deduped.length > 0 ? deduped : undefined,
            }
          };
        });

        const updatedEpisode = { ...episode, frames: newFrames, updatedAt: Date.now() };
        await apiService.updateProject(project.id, {
          ...project,
          episodes: project.episodes.map(ep => ep.id === episode.id ? updatedEpisode : ep)
        });
        setProjects(prev => prev.map(p =>
          p.id === project.id
            ? { ...p, episodes: p.episodes.map(ep => ep.id === episode.id ? updatedEpisode : ep) }
            : p
        ));
      } catch (error) {
        console.error(`分镜拆解失败: ${episode.name}`, error);
        failedList.push(episode.name);
      }
    }

    setStoryboardProgress(null);
    setShowNovelPreprocessModal(false);
    setPreprocessNovelText('');

    if (failedList.length > 0) {
      alert(`分镜拆解完成，${failedList.length} 个分集失败：\n${failedList.map(n => `• ${n}`).join('\n')}`);
    }
  };

  const startPreprocessTaskPolling = useCallback((taskId: string, type: 'novel' | 'episode') => {
    const poll = async () => {
      try {
        const task = await apiService.getPreprocessTask(taskId) as PreprocessTaskState;
        if (type === 'novel') {
          setNovelPreprocessTaskState(task);
          if (task.status === 'completed' && !task.resultAppliedAt) {
            await applyNovelPreprocessTaskResult(task);
          }
          if (task.status === 'failed' || task.status === 'interrupted') {
            setIsPreprocessing(false);
          }
          if (task.status !== 'pending' && task.status !== 'running') {
            if (task.status === 'completed' || task.status === 'failed' || task.status === 'interrupted') {
              setActiveNovelPreprocessTaskId(null);
            }
            return true;
          }
        }

        if (type === 'episode') {
          setEpisodePreprocessTaskState(task);
          if (task.status === 'completed' && !task.resultAppliedAt) {
            await applyEpisodePreprocessTaskResult(task);
          }
          if (task.status === 'failed' || task.status === 'interrupted') {
            setIsEpisodePreprocessing(false);
          }
          if (task.status !== 'pending' && task.status !== 'running') {
            if (task.status === 'completed' || task.status === 'failed' || task.status === 'interrupted') {
              setActiveEpisodePreprocessTaskId(null);
            }
            return true;
          }
        }
      } catch (error) {
        console.error('轮询预处理任务失败:', error);
      }
      return false;
    };

    void poll();
    const timer = setInterval(() => {
      void (async () => {
        const done = await poll();
        if (done) clearInterval(timer);
      })();
    }, 2000);

    return timer;
  }, [applyNovelPreprocessTaskResult, applyEpisodePreprocessTaskResult, preprocessNovelText]);

  useEffect(() => {
    if (!currentProject) return;

    let cancelled = false;
    let novelTimer: ReturnType<typeof setInterval> | null = null;
    let episodeTimer: ReturnType<typeof setInterval> | null = null;

    const handleTaskState = async (task: PreprocessTaskState) => {
      if (cancelled) return;

      if (task.type === 'novel') {
        setNovelPreprocessTaskState(task);
        if (task.status === 'pending' || task.status === 'running') {
          setIsPreprocessing(true);
          setActiveNovelPreprocessTaskId(task.id);
        } else {
          setIsPreprocessing(false);
        }

        if (task.status === 'completed' && !task.resultAppliedAt && preprocessNovelText.trim()) {
          await applyNovelPreprocessTaskResult(task);
        }
      }

      if (task.type === 'episode') {
        setEpisodePreprocessTaskState(task);
        if (task.status === 'pending' || task.status === 'running') {
          setIsEpisodePreprocessing(true);
          setActiveEpisodePreprocessTaskId(task.id);
        } else {
          setIsEpisodePreprocessing(false);
        }

        if (task.status === 'completed' && !task.resultAppliedAt) {
          await applyEpisodePreprocessTaskResult(task);
        }
      }
    };

    const pollTask = async (taskId: string, type: 'novel' | 'episode') => {
      try {
        const task = await apiService.getPreprocessTask(taskId) as PreprocessTaskState;
        await handleTaskState(task);

        if (task.status !== 'pending' && task.status !== 'running') {
          if (type === 'novel' && novelTimer) {
            clearInterval(novelTimer);
            novelTimer = null;
          }
          if (type === 'episode' && episodeTimer) {
            clearInterval(episodeTimer);
            episodeTimer = null;
          }
        }
      } catch (error) {
        console.error('轮询预处理任务失败:', error);
      }
    };

    const restoreTasks = async () => {
      try {
        const tasks = await apiService.listPreprocessTasks(currentProject.id) as PreprocessTaskState[];
        if (cancelled || !Array.isArray(tasks)) return;

        const latestNovel = tasks.find(task => task.type === 'novel' && !task.resultAppliedAt && (task.status === 'pending' || task.status === 'running' || task.status === 'interrupted' || task.status === 'completed')) || null;
        const latestEpisode = tasks.find(task => task.type === 'episode' && task.episodeId === currentEpisodeId && !task.resultAppliedAt && (task.status === 'pending' || task.status === 'running' || task.status === 'interrupted' || task.status === 'completed')) || null;

        if (latestNovel) {
          await handleTaskState(latestNovel);
          if (latestNovel.status === 'pending' || latestNovel.status === 'running') {
            novelTimer = setInterval(() => {
              void pollTask(latestNovel.id, 'novel');
            }, 2000);
          }
        } else {
          setNovelPreprocessTaskState(null);
        }

        if (latestEpisode) {
          await handleTaskState(latestEpisode);
          if (latestEpisode.status === 'pending' || latestEpisode.status === 'running') {
            episodeTimer = setInterval(() => {
              void pollTask(latestEpisode.id, 'episode');
            }, 2000);
          }
        } else {
          setEpisodePreprocessTaskState(null);
        }
      } catch (error) {
        console.error('恢复预处理任务失败:', error);
      }
    };

    void restoreTasks();

    return () => {
      cancelled = true;
      if (novelTimer) clearInterval(novelTimer);
      if (episodeTimer) clearInterval(episodeTimer);
    };
  }, [currentProject?.id, currentEpisodeId, preprocessNovelText, applyNovelPreprocessTaskResult, applyEpisodePreprocessTaskResult]);

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

    // Shared advance-frame function used by both audio.onended and the image timer
    const advanceFrame = () => {
      if (currentPlaybackIndex < currentEpisode.frames.length - 1) {
        setCurrentPlaybackIndex(prev => prev + 1);
      } else {
        setIsPlaying(false);
        setCurrentPlaybackIndex(0);
      }
    };

    const hasAudio = !!frame.audioUrl;

    // Start audio (changing src also stops any previously playing audio)
    if (hasAudio && timelineAudioRef.current) {
      timelineAudioRef.current.src = frame.audioUrl!;
      timelineAudioRef.current.currentTime = 0;
      timelineAudioRef.current.play().catch(e => console.warn('[播放] 音频播放失败:', e));
    } else if (timelineAudioRef.current) {
      timelineAudioRef.current.pause();
      timelineAudioRef.current.src = '';
    }

    if (frame.videoUrl) {
      // --- Video frame ---
      // When audio is present: set playbackRate so video aligns with audio length,
      // and let audio.onended drive frame advancement.
      // When no audio: playbackRate = 1, video.onended drives advancement.
      audioEndedHandlerRef.current = hasAudio ? advanceFrame : null;

      const videoEl = timelineVideoRef.current;
      if (videoEl) {
        // Abort flag: prevents the canplay callback from firing after the frame
        // has already changed (effect cleanup runs before the next effect).
        let aborted = false;

        const applyRateAndPlay = () => {
          videoEl.oncanplay = null;
          if (aborted) return;
          if (hasAudio && frame.audioDuration) {
            // Use stored videoDuration first; fall back to element's natural duration
            const naturalDuration = frame.videoDuration ?? videoEl.duration;
            if (naturalDuration && naturalDuration > 0) {
              videoEl.playbackRate = Math.min(4, Math.max(0.25, naturalDuration / frame.audioDuration));
            } else {
              videoEl.playbackRate = 1;
            }
          } else {
            videoEl.playbackRate = 1;
          }
          videoEl.play().catch(e => console.warn('[播放] 视频播放失败:', e));
        };

        // Assign new source and reload; oncanplay fires when enough data is buffered
        videoEl.src = frame.videoUrl;
        videoEl.currentTime = 0;
        videoEl.load();
        videoEl.oncanplay = applyRateAndPlay;

        return () => {
          aborted = true;
          videoEl.oncanplay = null;
        };
      }
    } else {
      // --- Image / empty frame ---
      // Pause and clear the shared video element so the previous video stops completely
      const videoEl = timelineVideoRef.current;
      if (videoEl) {
        videoEl.pause();
        videoEl.removeAttribute('src');
        videoEl.load();
      }
      // audio.onended is not used here; a fixed timer drives advancement
      audioEndedHandlerRef.current = null;
      const duration = frame.audioDuration ? Math.ceil(frame.audioDuration * 1000) : 4000;
      const timer = setTimeout(advanceFrame, duration);
      return () => clearTimeout(timer);
    }
  }, [isPlaying, currentPlaybackIndex, currentEpisode]);

  // Pause video and audio when playback is stopped
  useEffect(() => {
    if (!isPlaying) {
      timelineVideoRef.current?.pause();
      timelineAudioRef.current?.pause();
    }
  }, [isPlaying]);

  // --- Handlers ---

  const handleVideoEnded = () => {
    // When audio is driving frame advancement (audioEndedHandlerRef is set),
    // ignore video.onended so we don't advance before the audio finishes.
    if (audioEndedHandlerRef.current) return;

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
      type: 'REAL_PERSON_COMMENTARY',
      settings: { ...DEFAULT_SETTINGS }
    });
    setShowCreateModal(true);
  };

  const handleOpenProject = async (projectId: string) => {
    if (!projectId) {
      alert('该项目缺少 ID，请重启后端让旧项目数据自动迁移后再试。');
      return;
    }

    setIsOpeningProject(true);
    setOpeningProjectId(projectId);

    try {
      const latest = await apiService.getProject(projectId);
      const normalized = normalizeProject(latest);

      // 同步资产快照
      savedAssetsRef.current?.set(
        normalized.id,
        JSON.stringify({ characters: normalized.characters, scenes: normalized.scenes, variants: normalized.variants })
      );

      // 同步分集快照
      normalized.episodes.forEach(e => {
        savedEpisodesRef.current?.set(e.id, e.updatedAt);
      });

      // 用最新版本覆盖本地缓存
      setProjects(prev => prev.map(p => p.id === normalized.id ? normalized : p));

      setCurrentProjectId(normalized.id);
      setCurrentEpisodeId(null);
      setViewMode(ViewMode.PROJECT_DETAIL);

      console.log(`✅ 已加载最新项目数据: ${normalized.name}`);
    } catch (error) {
      console.error('打开项目失败:', error);
      alert('打开项目失败：' + (error as Error).message);
    } finally {
      setIsOpeningProject(false);
      setOpeningProjectId(null);
    }
  };

  const normalizeGlobalSettingsFromServer = (loadedSettings: any): GlobalSettings => {
    const supportedExtractionModels = [
      'doubao-seed-2-0-pro-260215',
      'claude-sonnet-4-6',
      'gemini-3-flash-preview',
      'gemini-3-pro-preview',
      'gemini-2.5-flash'
    ];

    const extractionModel = supportedExtractionModels.includes(loadedSettings?.extractionModel)
      ? loadedSettings.extractionModel
      : DEFAULT_GLOBAL_SETTINGS.extractionModel;

    const projectTypePrompts = (loadedSettings?.projectTypePrompts || {}) as Record<string, Partial<ProjectTypeInstruction>>;

    // Start with defaults for all prompts
    const normalizedPrompts = {} as Record<string, ProjectTypeInstruction>;
    (Object.keys(DEFAULT_GLOBAL_SETTINGS.projectTypePrompts) as string[]).forEach((projectType) => {
      const defaultPrompts = DEFAULT_GLOBAL_SETTINGS.projectTypePrompts[projectType];
      const currentPrompts = projectTypePrompts[projectType] || {};
      normalizedPrompts[projectType] = { ...defaultPrompts, ...currentPrompts } as ProjectTypeInstruction;
    });

    // Preserve custom types from server
    Object.keys(projectTypePrompts).forEach((projectType) => {
      if (!normalizedPrompts[projectType]) {
        // Custom type not in defaults, preserve it
        normalizedPrompts[projectType] = projectTypePrompts[projectType] as ProjectTypeInstruction;
      }
    });

    // Merge labels: start with defaults, then apply server labels
    const mergedLabels = { ...DEFAULT_GLOBAL_SETTINGS.projectTypeLabels };
    if (loadedSettings?.projectTypeLabels) {
      Object.entries(loadedSettings.projectTypeLabels).forEach(([key, label]) => {
        // Protect built-in label keys from being overwritten by server data
        const DEFAULT_TYPE_KEYS = new Set(['REAL_PERSON_COMMENTARY', 'COMMENTARY_2D', 'COMMENTARY_3D', 'PREMIUM_2D', 'PREMIUM_3D']);
        if (!DEFAULT_TYPE_KEYS.has(key) || !mergedLabels[key]) {
          mergedLabels[key] = label as string;
        }
      });
    }

    return {
      extractionModel,
      preprocessModel: loadedSettings?.preprocessModel || 'claude-sonnet-4-6',
      projectTypePrompts: normalizedPrompts,
      projectTypeLabels: mergedLabels,
      multiRefVideoModel: loadedSettings?.multiRefVideoModel,
      // 剪映路径从 .env.local 读取（所有客户端共享网络驱动器）
      jianyingExportPath: import.meta.env.VITE_JIANYING_EXPORT_PATH || '',
      jianyingExportPathFull: import.meta.env.VITE_JIANYING_EXPORT_PATH_FULL || '',
      defaultImageDuration: loadedSettings?.defaultImageDuration,
      placeholderColor: loadedSettings?.placeholderColor,
      ttsSpeed: loadedSettings?.ttsSpeed,
    };
  };

  const handleOpenProjectSettingsModal = async (projectId: string) => {
    if (!projectId) {
      alert('该项目缺少 ID，请重启后端让旧项目数据自动迁移后再试。');
      return;
    }

    try {
      const latest = await apiService.getProject(projectId);
      const normalized = normalizeProject(latest);

      // 用最新版本覆盖本地缓存
      setProjects(prev => prev.map(p => p.id === normalized.id ? normalized : p));
    } catch (error) {
      console.error('加载最新项目设置失败:', error);
      alert('加载最新项目设置失败：' + (error as Error).message);
    } finally {
      setShowSettingsModal(true);
    }
  };

  const handleOpenGlobalSettingsModal = async () => {
    try {
      const loadedSettings = await apiService.getSettings();
      const normalizedSettings = normalizeGlobalSettingsFromServer(loadedSettings);

      setGlobalSettings(normalizedSettings);
      savedGlobalSettingsRef.current = JSON.stringify(normalizedSettings);

      console.log('✅ 已加载最新全局设置');
    } catch (error) {
      console.error('加载最新全局设置失败:', error);
      alert('加载最新全局设置失败：' + (error as Error).message);
    } finally {
      setShowGlobalSettingsModal(true);
    }
  };

  const handleCreateProject = async () => {
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
      variants: [],
      scenes: [],
      episodes: []
    };

    try {
      // 调用后端API创建项目
      await apiService.createProject(newProject);

      // 初始化资产快照
      savedAssetsRef.current?.set(
        newProject.id,
        JSON.stringify({ characters: [], scenes: [], variants: [] })
      );

      setProjects([...projects, newProject]);
      setCurrentProjectId(newProject.id);
      setShowCreateModal(false);
      setViewMode(ViewMode.PROJECT_DETAIL);
      console.log(`✅ 项目 "${newProject.name}" 创建成功`);
    } catch (error) {
      console.error('创建项目失败:', error);
      alert('创建项目失败：' + (error as Error).message);
    }
  };

  const handleDuplicateProject = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    const sourceProject = projects.find(p => p.id === projectId);
    if (!sourceProject) return;

    const duplicatedProject = createDuplicatedProject(sourceProject);

    try {
      await apiService.createProject(duplicatedProject);

      savedAssetsRef.current?.set(
        duplicatedProject.id,
        JSON.stringify({
          characters: duplicatedProject.characters,
          scenes: duplicatedProject.scenes,
          variants: duplicatedProject.variants,
        })
      );
      duplicatedProject.episodes.forEach(episode => {
        savedEpisodesRef.current?.set(episode.id, episode.updatedAt);
      });

      setProjects(prev => [duplicatedProject, ...prev]);
      console.log(`✅ 项目 "${duplicatedProject.name}" 复制成功`);
    } catch (error) {
      console.error('复制项目失败:', error);
      alert('复制项目失败：' + (error as Error).message);
    }
  };

  const handleDeleteProject = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    const project = projects.find(p => p.id === projectId);
    if (!project) return;
    if (!confirm(`确定要删除项目 "${project.name}" 吗？`)) return;
    try {
      await apiService.deleteProject(projectId);
      setProjects(prev => prev.filter(p => p.id !== projectId));
      if (currentProjectId === projectId) {
        setCurrentProjectId(null);
        setSelectedEpisodeIds(new Set());
        setViewMode(ViewMode.PROJECT_LIST);
      }
    } catch (error) {
      console.error('删除项目失败:', error);
      alert('删除项目失败：' + (error as Error).message);
    }
  };

  const handleOpenRecycleBin = async () => {
    setShowRecycleBinModal(true);
    setIsRecycleBinLoading(true);
    try {
      const data = await apiService.getRecycleBin();
      setRecycleBinProjects(data);
    } catch (error) {
      console.error('加载回收站失败:', error);
      alert('加载回收站失败：' + (error as Error).message);
    } finally {
      setIsRecycleBinLoading(false);
    }
  };

  const handleRestoreProject = async (projectId: string) => {
    try {
      const restored = await apiService.restoreProject(projectId);

      // 初始化资产和分集快照
      savedAssetsRef.current?.set(
        restored.id,
        JSON.stringify({ characters: restored.characters, scenes: restored.scenes, variants: restored.variants })
      );
      restored.episodes.forEach((e: Episode) => {
        savedEpisodesRef.current?.set(e.id, e.updatedAt);
      });

      setProjects(prev => [...prev, restored]);
      setRecycleBinProjects(prev => prev.filter(p => p.id !== projectId));
    } catch (error) {
      console.error('恢复项目失败:', error);
      alert('恢复项目失败：' + (error as Error).message);
    }
  };

  const handlePermanentDelete = async (projectId: string) => {
    if (!confirm('确定要永久删除该项目吗？此操作不可恢复。')) return;
    try {
      await apiService.deleteProjectPermanently(projectId);
      setRecycleBinProjects(prev => prev.filter(p => p.id !== projectId));
    } catch (error) {
      console.error('永久删除项目失败:', error);
      alert('永久删除项目失败：' + (error as Error).message);
    }
  };

  const handleImportProject = async () => {
    // 导入功能暂时保留文件选择器，但可以考虑通过后端实现
    try {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.swproj,.json';

      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;

        try {
          const text = await file.text();
          const projectData = JSON.parse(text);
          const normalizedProject = normalizeProject(projectData);

          // 检查是否已存在相同ID的项目
          const existingProject = projects.find(p => p.id === normalizedProject.id);
          if (existingProject) {
            if (!confirm(`项目 "${normalizedProject.name}" 已存在，是否覆盖？`)) {
              return;
            }
            // 覆盖现有项目（更新后端）
            await apiService.updateProject(normalizedProject.id, normalizedProject);

            // 同步资产和分集快照
            savedAssetsRef.current?.set(
              normalizedProject.id,
              JSON.stringify({ characters: normalizedProject.characters, scenes: normalizedProject.scenes, variants: normalizedProject.variants })
            );
            normalizedProject.episodes.forEach(e => {
              savedEpisodesRef.current?.set(e.id, e.updatedAt);
            });

            setProjects(prev => prev.map(p => p.id === normalizedProject.id ? normalizedProject : p));
          } else {
            // 添加新项目（创建到后端）
            await apiService.createProject(normalizedProject);

            // 初始化资产和分集快照
            savedAssetsRef.current?.set(
              normalizedProject.id,
              JSON.stringify({ characters: normalizedProject.characters, scenes: normalizedProject.scenes, variants: normalizedProject.variants })
            );
            normalizedProject.episodes.forEach(e => {
              savedEpisodesRef.current?.set(e.id, e.updatedAt);
            });

            setProjects(prev => [...prev, normalizedProject]);
          }
          alert(`项目 "${normalizedProject.name}" 导入成功！`);
        } catch (error) {
          console.error('导入项目失败:', error);
          alert('导入项目失败，请检查文件格式是否正确');
        }
      };

      input.click();
    } catch (error) {
      console.error('导入项目失败:', error);
      alert('导入项目失败');
    }
  };

  const handleExportProject = async () => {
    if (!currentProject) return;
    try {
      // 导出为 JSON 文件
      const jsonData = JSON.stringify(currentProject, null, 2);
      const blob = new Blob([jsonData], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${currentProject.name}.swproj`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      alert('项目导出成功！');
    } catch (error) {
      console.error('导出项目失败:', error);
      alert('导出项目失败');
    }
  };

  const handleUpdateSettings = async (newSettings: ProjectSettings) => {
    if (!currentProject) return;

    try {
      // 调用细粒度 API，只更新 settings 字段
      await apiService.updateProjectSettings(currentProject.id, newSettings);

      // 更新本地状态
      setProjects(prev => prev.map(p =>
        p.id === currentProject.id ? { ...p, settings: newSettings, updatedAt: Date.now() } : p
      ));

      setShowSettingsModal(false);
      console.log(`✅ 项目设置已保存: ${currentProject.name}`);
    } catch (error) {
      console.error('保存项目设置失败:', error);
      alert('保存项目设置失败：' + (error as Error).message);
    }
  };

  const handleCreateEpisode = async () => {
    if (!currentProject) return;
    const newEpisode: Episode = {
      id: uuidv4(),
      name: `第 ${currentProject.episodes.length + 1} 章`,
      scriptContent: '',
      frames: [],
      updatedAt: Date.now()
    };

    const updatedProject = {
      ...currentProject,
      episodes: [...currentProject.episodes, newEpisode],
      updatedAt: Date.now()
    };

    setProjects(prev => prev.map(p =>
      p.id === currentProject.id
        ? updatedProject
        : p
    ));

    try {
      await apiService.updateProject(currentProject.id, updatedProject);
      savedEpisodesRef.current?.set(newEpisode.id, newEpisode.updatedAt);
    } catch (error) {
      console.error('创建分集失败:', error);
      alert('创建分集失败：' + (error as Error).message);
      setProjects(prev => prev.map(p => p.id === currentProject.id ? currentProject : p));
    }
  };

  const handleNovelPreprocess = async () => {
    if (!currentProject || !preprocessNovelText.trim()) return;

    const episodeDrafts = splitNovelIntoEpisodes(preprocessNovelText);
    if (episodeDrafts.length === 0) {
      alert('未检测到章节标记，请确认文本中包含纯数字、中文数字，或”第X章/集/回/话”等章节标题');
      return;
    }

    setIsPreprocessing(true);
    try {
      const prompts = globalSettings.projectTypePrompts[currentProject.type] ?? globalSettings.projectTypePrompts['REAL_PERSON_COMMENTARY'];
      const existingContext = buildExistingAssetsContext(
        currentProject.characters,
        currentProject.scenes,
        currentProject.variants ?? []
      );
      const systemInstruction = `${prompts.characterExtraction}\n\n${prompts.sceneExtraction}${existingContext}`;
      const { content: segmentPrompt } = await apiService.getSegmentSkillPrompt(currentProject.type);
      const secondPassPrompt = prompts.preprocessSecondPassPrompt?.trim();
      const result = await apiService.createNovelPreprocessTask({
        projectId: currentProject.id,
        projectType: currentProject.type,
        novelText: preprocessNovelText,
        episodeDrafts,
        systemInstruction,
        segmentPrompt,
        secondPassPrompt,
        enableSecondPass,
      }) as { taskId: string };

      setActiveNovelPreprocessTaskId(result.taskId);
      const task = await apiService.getPreprocessTask(result.taskId) as PreprocessTaskState;
      setNovelPreprocessTaskState(task);
      startPreprocessTaskPolling(result.taskId, 'novel');
    } catch (error) {
      console.error('小说预处理失败:', error);
      alert('预处理失败：' + (error as Error).message);
      setIsPreprocessing(false);
    }
  };

  const handleEpisodePreprocess = async () => {
    if (!currentProject || !currentEpisode?.scriptContent.trim()) return;
    setIsEpisodePreprocessing(true);
    try {
      const { content: segmentPrompt } = await apiService.getSegmentSkillPrompt(currentProject.type);
      const prompts = globalSettings.projectTypePrompts[currentProject.type]
        ?? globalSettings.projectTypePrompts['REAL_PERSON_COMMENTARY'];
      const secondPassPrompt = prompts.preprocessSecondPassPrompt?.trim();
      const result = await apiService.createEpisodePreprocessTask({
        projectId: currentProject.id,
        episodeId: currentEpisode.id,
        episodeName: currentEpisode.name,
        content: currentEpisode.scriptContent,
        segmentPrompt,
        secondPassPrompt,
        enableSecondPass: enableEpisodeSecondPass,
      }) as { taskId: string };

      setActiveEpisodePreprocessTaskId(result.taskId);
      const task = await apiService.getPreprocessTask(result.taskId) as PreprocessTaskState;
      setEpisodePreprocessTaskState(task);
      startPreprocessTaskPolling(result.taskId, 'episode');
    } catch (error) {
      alert('预处理失败：' + (error as Error).message);
      setIsEpisodePreprocessing(false);
    }
  };

  const handleRetryPreprocessWithNewProvider = async (provider: 'univibe' | 'bltcy') => {
    if (!preprocessRetryData || !currentProject) return;

    setShowClaudeProviderModal(false);
    setIsPreprocessing(true);

    try {
      console.log(`🔄 [小说预处理] 使用${provider === 'bltcy' ? '柏拉图中转' : 'Univibe'} Claude`);

      // 重新执行资产提取和分段
      const analysis = await analyzeNovelScriptWithClaude(
        preprocessRetryData.textForAssets,
        preprocessRetryData.systemInstruction,
        provider,
        globalSettings.preprocessModel as any
      );
      await recordTextUsage({ provider: 'claude',
        projectId: currentProject.id,
        taskType: 'assetExtraction',
        sourceId: currentEpisodeId || 'novel-preprocess',
        operationId: `retry-provider-analysis-${provider}`,
        result: analysis,
      });

      const segmentedScripts = await mapWithConcurrencyLimit(
        preprocessRetryData.episodeDrafts,
        PREPROCESS_SEGMENT_CONCURRENCY,
        async draft => {
          const result = await segmentEpisodeWithClaude(
            draft.content,
            preprocessRetryData.latestDirectorSkillPrompt,
            draft.title,
            { fullNovelText: preprocessNovelText },
            provider,
            globalSettings.preprocessModel as any
          );
          await recordTextUsage({ provider: 'claude',
            projectId: currentProject.id,
            taskType: 'preprocessSegment',
            sourceId: draft.title,
            operationId: `retry-provider-primary-${provider}`,
            result,
          });
          if (result.failed) {
            throw new Error(`分集「${draft.title}」Claude API 失败，预处理中断`);
          }
          return result;
        }
      );

      // 二次加工（与主流程一致）
      const retryPrompts = globalSettings.projectTypePrompts[currentProject.type] ?? globalSettings.projectTypePrompts['REAL_PERSON_COMMENTARY'];
      const retrySecondPassPrompt = retryPrompts.preprocessSecondPassPrompt?.trim();
      let finalScripts = segmentedScripts;
      if (enableSecondPass && retrySecondPassPrompt) {
        finalScripts = await mapWithConcurrencyLimit(
          segmentedScripts,
          PREPROCESS_SEGMENT_CONCURRENCY,
          async (result, index) => {
            if (result.failed) return result;
            const label = preprocessRetryData.episodeDrafts[index].title + '(二次加工)';
            const secondPassResult = await segmentEpisodeWithClaude(result.content, retrySecondPassPrompt, label, {
              fullNovelText: preprocessNovelText,
            }, provider, globalSettings.preprocessModel as any);
            await recordTextUsage({ provider: 'claude',
              projectId: currentProject.id,
              taskType: 'preprocessSecondPass',
              sourceId: preprocessRetryData.episodeDrafts[index].title,
              operationId: `retry-provider-second-pass-${provider}`,
              result: secondPassResult,
            });
            return secondPassResult.failed ? result : secondPassResult;
          }
        );
      }

      // 构建新分集和资产（逻辑与原处理相同）
      const now = Date.now();
      const newEpisodes: Episode[] = preprocessRetryData.episodeDrafts.map((draft, i) => buildEpisodeFromPreprocessResult({
        id: uuidv4(),
        name: draft.title,
        scriptContent: draft.content,
        frames: [],
        updatedAt: now + i,
      }, finalScripts[i]));

      const existingCharNames = new Set(currentProject.characters.map(c => c.name));
      const existingSceneNames = new Set(currentProject.scenes.map(s => s.name));

      const newCharacters: Character[] = analysis.characters
        .filter(c => !existingCharNames.has(c.name))
        .map(c => {
          const normalized = normalizeCharacterInput(c.name, c.aliases);
          return { ...c, ...normalized, id: uuidv4(), aliases: normalized.aliases };
        });

      const newScenes: Scene[] = analysis.scenes
        .filter(s => !existingSceneNames.has(s.name))
        .map(s => ({ ...s, id: uuidv4() }));

      const allCharacters = [...currentProject.characters, ...newCharacters];
      const existingVariantKeys = new Set(
        (currentProject.variants ?? []).map(v => `${v.characterId}::${v.name}`)
      );
      const newVariants: CharacterVariant[] = (analysis.variants ?? [])
        .map(v => {
          const char = allCharacters.find(
            c => c.name === v.characterName || (c.aliases ?? []).includes(v.characterName)
          );
          if (!char) return null;
          const key = `${char.id}::${v.name}`;
          if (existingVariantKeys.has(key)) return null;
          return { id: uuidv4(), characterId: char.id, name: v.name, context: v.context, appearance: v.appearance } as CharacterVariant;
        })
        .filter((v): v is CharacterVariant => v !== null);

      const updatedProject = {
        ...currentProject,
        episodes: [...currentProject.episodes, ...newEpisodes],
        characters: [...currentProject.characters, ...newCharacters],
        scenes: [...currentProject.scenes, ...newScenes],
        variants: [...(currentProject.variants ?? []), ...newVariants],
        updatedAt: Date.now(),
      };

      setProjects(prev => prev.map(p => p.id === currentProject.id ? updatedProject : p));
      await apiService.updateProject(currentProject.id, updatedProject);
      newEpisodes.forEach(e => savedEpisodesRef.current?.set(e.id, e.updatedAt));

      setShowNovelPreprocessModal(false);
      setPreprocessNovelText('');
      setPreprocessRetryData(null);

      alert(`✅ 预处理成功！已使用${provider === 'bltcy' ? '柏拉图中转' : 'Univibe'} Claude。`);
    } catch (error) {
      console.error('重试预处理失败:', error);
      alert('重试失败：' + (error as Error).message);
    } finally {
      setIsPreprocessing(false);
    }
  };

  const handleRetryFailedPreprocessEpisodes = async () => {
    if (!currentProject || failedPreprocessEpisodes.length === 0 || isPreprocessing) return;

    setIsPreprocessing(true);
    try {
      const { content: latestDirectorSkillPrompt } = await apiService.getSegmentSkillPrompt(currentProject.type);
      const retryResults = await mapWithConcurrencyLimit(
        failedPreprocessEpisodes,
        PREPROCESS_SEGMENT_CONCURRENCY,
        async episode => {
          const primary = await segmentEpisodeWithClaude(episode.scriptContent, latestDirectorSkillPrompt, episode.name, {
            fullNovelText: preprocessNovelText || undefined,
          }, 'univibe', globalSettings.preprocessModel as any);
          await recordTextUsage({ provider: 'claude',
            projectId: currentProject.id,
            taskType: 'preprocessSegment',
            sourceId: episode.id,
            operationId: 'retry-failed-primary-univibe',
            result: primary,
          });
          if (!primary.failed) return primary;
          Logger.logError('App', '预处理分集重试失败，切换柏拉图中转 Claude 重试', {
            episodeName: episode.name
          });
          const secondary = await segmentEpisodeWithClaude(episode.scriptContent, latestDirectorSkillPrompt, episode.name, {
            fullNovelText: preprocessNovelText || undefined,
          }, 'bltcy', globalSettings.preprocessModel as any);
          await recordTextUsage({ provider: 'claude',
            projectId: currentProject.id,
            taskType: 'preprocessSegment',
            sourceId: episode.id,
            operationId: 'retry-failed-secondary-bltcy',
            result: secondary,
          });
          if (secondary.failed) {
            throw new Error(`分集「${episode.name}」两个 Claude API 均失败，重试中断`);
          }
          return secondary;
        }
      );

      const retryResultMap = new Map(failedPreprocessEpisodes.map((episode, index) => [episode.id, retryResults[index]]));
      const updatedProject = {
        ...currentProject,
        episodes: currentProject.episodes.map(episode => {
          const retryResult = retryResultMap.get(episode.id);
          if (!retryResult) return episode;
          return buildEpisodeFromPreprocessResult({
            ...episode,
            updatedAt: Date.now(),
          }, retryResult);
        }),
        updatedAt: Date.now(),
      };

      setProjects(prev => prev.map(p => p.id === currentProject.id ? updatedProject : p));
      await apiService.updateProject(currentProject.id, updatedProject);
      updatedProject.episodes.forEach(episode => savedEpisodesRef.current?.set(episode.id, episode.updatedAt));
    } catch (error) {
      console.error('重试预处理失败分集失败:', error);
      alert('重试失败：' + (error as Error).message);
    } finally {
      setIsPreprocessing(false);
    }
  };

  const handleDeleteEpisode = async (e: React.MouseEvent, episodeId: string) => {
    e.stopPropagation();
    if (!currentProject) return;
    if (!confirm('确定要删除此分集吗？删除后可在分集回收站中恢复。')) return;

    try {
      await apiService.deleteEpisode(currentProject.id, episodeId);

      // API 成功后再更新前端 state
      setProjects(prev => prev.map(p =>
        p.id === currentProject.id
          ? { ...p, episodes: p.episodes.filter(ep => ep.id !== episodeId) }
          : p
      ));
      savedEpisodesRef.current?.delete(episodeId);
    } catch (error) {
      console.error('删除分集失败:', error);
      alert('删除分集失败：' + (error as Error).message);
    }
  };

  const handleDeleteSelectedEpisodes = async () => {
    if (!currentProject || selectedEpisodeIds.size === 0) return;
    if (!confirm(`确定要删除选中的 ${selectedEpisodeIds.size} 个分集吗？删除后可在分集回收站中恢复。`)) return;

    const idsToDelete = [...selectedEpisodeIds];
    try {
      // 串行执行，避免 LowDB 并发写覆盖
      for (const id of idsToDelete) {
        await apiService.deleteEpisode(currentProject.id, id);
      }

      // 全部成功后更新 state
      setProjects(prev => prev.map(p =>
        p.id === currentProject.id
          ? { ...p, episodes: p.episodes.filter(ep => !selectedEpisodeIds.has(ep.id)) }
          : p
      ));
      idsToDelete.forEach(id => savedEpisodesRef.current?.delete(id));
      setSelectedEpisodeIds(new Set());
    } catch (error) {
      console.error('批量删除分集失败:', error);
      alert('批量删除分集失败：' + (error as Error).message);
    }
  };

  // ==================== 分集回收站 ====================

  const handleOpenEpisodeRecycleBin = async () => {
    if (!currentProject) return;
    setShowEpisodeRecycleBinModal(true);
    setIsEpisodeRecycleBinLoading(true);
    try {
      const data = await apiService.getEpisodeRecycleBin(currentProject.id);
      // 按删除时间倒序排列（最近删的在最前面）
      setEpisodeRecycleBin(
        [...data].sort((a: any, b: any) => (b.deletedAt || 0) - (a.deletedAt || 0))
      );
    } catch (error) {
      console.error('获取分集回收站失败:', error);
      alert('获取分集回收站失败：' + (error as Error).message);
    } finally {
      setIsEpisodeRecycleBinLoading(false);
    }
  };

  const handleRestoreEpisode = async (episodeId: string) => {
    if (!currentProject) return;
    try {
      const restored = await apiService.restoreEpisode(currentProject.id, episodeId);

      // 从回收站 UI 中移除
      setEpisodeRecycleBin(prev => prev.filter(ep => ep.id !== episodeId));

      // 将恢复的分集追加到项目 episodes 末尾
      setProjects(prev => prev.map(p =>
        p.id === currentProject.id
          ? { ...p, episodes: [...p.episodes, restored] }
          : p
      ));

      // 初始化恢复分集的保存快照
      savedEpisodesRef.current?.set(restored.id, restored.updatedAt);
    } catch (error) {
      console.error('恢复分集失败:', error);
      alert('恢复分集失败：' + (error as Error).message);
    }
  };

  const handlePermanentDeleteEpisode = async (episodeId: string) => {
    if (!confirm('确定要永久删除此分集吗？此操作不可撤销。')) return;
    if (!currentProject) return;
    try {
      await apiService.deleteEpisodePermanently(currentProject.id, episodeId);
      setEpisodeRecycleBin(prev => prev.filter(ep => ep.id !== episodeId));
    } catch (error) {
      console.error('永久删除分集失败:', error);
      alert('永久删除分集失败：' + (error as Error).message);
    }
  };

  const handleRenameEpisode = (e: React.MouseEvent, episodeId: string) => {
    e.stopPropagation();
    if (!currentProject) return;
    const episode = currentProject.episodes.find(ep => ep.id === episodeId);
    if (!episode) return;
    const nextName = prompt("重命名分集", episode.name)?.trim();
    if (!nextName || nextName === episode.name) return;
    handleUpdateEpisode(currentProject.id, episodeId, { name: nextName });
  };

  const handleRenameProject = (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    const project = projects.find(p => p.id === projectId);
    if (!project) return;
    const nextName = prompt("重命名项目", project.name)?.trim();
    if (!nextName || nextName === project.name) return;
    handleUpdateProject(projectId, { name: nextName });
  };

  const handleDuplicateEpisode = async (e: React.MouseEvent, episodeId: string) => {
    e.stopPropagation();
    if (!currentProject) return;
    const source = currentProject.episodes.find(ep => ep.id === episodeId);
    if (!source) return;
    const newEpisodeId = uuidv4();
    const frames = await Promise.all(source.frames.map(async f => {
      const newFrameId = uuidv4();
      const imageUrl = await uploadImageIfBase64(
        f.imageUrl || '',
        `frame_${newEpisodeId}_${newFrameId}_${Date.now()}`
      );
      return {
        ...f,
        id: newFrameId,
        imageUrl: imageUrl || undefined,
        isGenerating: false,
        isGeneratingVideo: false,
        isGeneratingAudio: false,
        imageProgress: undefined,
        videoProgress: undefined,
        audioProgress: undefined,
        videoTaskStatus: undefined,
        imageError: undefined,
        videoError: undefined,
        audioError: undefined,
      };
    }));
    const duplicated = {
      ...source,
      id: newEpisodeId,
      name: `${source.name} - 副本`,
      updatedAt: Date.now(),
      frames,
    };
    const sourceIndex = currentProject.episodes.findIndex(ep => ep.id === episodeId);
    const newEpisodes = [...currentProject.episodes];
    newEpisodes.splice(sourceIndex + 1, 0, duplicated);

    // 直接修改 episodes 数组，不触发项目级保存
    setProjects(prev => prev.map(p =>
      p.id === currentProject.id
        ? { ...p, episodes: newEpisodes }
        : p
    ));

    // 初始化新分集的保存快照
    savedEpisodesRef.current?.set(duplicated.id, duplicated.updatedAt);
  };

  const handleUpdateProject = (projectId: string, updates: Partial<Project>) => {
    setProjects(prev => prev.map(p => p.id === projectId ? { ...p, ...updates, updatedAt: Date.now() } : p));

    // 按 updates 内容路由到对应的细粒度 API，避免整体保存
    if ('name' in updates || 'type' in updates) {
      const meta: { name?: string; type?: string } = {};
      if (updates.name !== undefined) meta.name = updates.name;
      if (updates.type !== undefined) meta.type = updates.type;
      if (Object.keys(meta).length > 0) {
        apiService.updateProjectMeta(projectId, meta).catch(e => console.error('项目元数据保存失败:', e));
      }
    }

    if ('settings' in updates && updates.settings !== undefined) {
      apiService.updateProjectSettings(projectId, updates.settings).catch(e => console.error('项目设置保存失败:', e));
    }

    // characters / scenes / variants 的变化由资产 useEffect（500ms 防抖）自动处理
  };

  const handleUpdateEpisode = (projectId: string, episodeId: string, updates: Partial<Episode>) => {
    setProjects(prev => prev.map(p => {
      if (p.id !== projectId) return p;
      return {
        ...p,
        // 不再 bump project.updatedAt，分集修改不触发项目级保存
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
        imagePrompt: "空场景",
        videoPrompt: "空场景",
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

  const handleInvertFrameSelection = () => {
      if (!currentEpisode) return;
      const allIds = currentEpisode.frames.map(f => f.id);
      setSelectedFrameIds(allIds.filter(id => !selectedFrameIds.includes(id)));
  };

  const handleSelectMissing = (type: 'image' | 'video' | 'audio') => {
      if (!currentEpisode) return;
      let ids: string[] = [];
      if (type === 'image') ids = currentEpisode.frames.filter(f => !f.imageUrl && !f.isGenerating).map(f => f.id);
      if (type === 'video') ids = currentEpisode.frames.filter(f => !f.videoUrl && !f.isGeneratingVideo && f.videoTaskStatus !== 'waiting').map(f => f.id);
      if (type === 'audio') ids = currentEpisode.frames.filter(f => !f.audioUrl && !f.isGeneratingAudio).map(f => f.id);
      setSelectedFrameIds(ids);
  };

  // 6. Batch Generation
  const handleBatchGenerate = async (type: 'image' | 'video' | 'audio') => {
      if (!currentProject || !currentEpisode || selectedFrameIds.length === 0) return;

      const frameIdsToProcess = [...selectedFrameIds];

      if (type === 'image') {
        // 批量生成图片 - 使用任务队列
        frameIdsToProcess.forEach(frameId => {
          const frame = currentEpisode.frames.find(f => f.id === frameId);
          if (frame) {
            handleGenerateFrameImage(frameId, useVideoPromptForImage ? frame.videoPrompt : frame.imagePrompt);
          }
        });
      } else if (type === 'video') {
        // 批量生成视频 - 通过任务队列并发执行
        // 新一轮批量前恢复所有"积分不足"的 session，让它们重新参与调度
        await apiService.resetInsufficientSessions();
        const multiRefMode = currentProject.settings.multiRefVideoMode ?? false;
        frameIdsToProcess.forEach(frameId => {
          const frame = currentEpisode.frames.find(f => f.id === frameId);
          if (multiRefMode || frame?.imageUrl) {
            handleGenerateFrameVideo(frameId);
          }
        });
      } else if (type === 'audio') {
        // 批量生成音频 - 顺序处理
        for (const frameId of frameIdsToProcess) {
          const frame = currentEpisode.frames.find(f => f.id === frameId);
          if (frame?.dialogue || frame?.imagePrompt) {
            await handleGenerateFrameAudio(frameId);
          }
        }
      }
  };

  // --- Asset Management Handlers ---

  const handleAddAsset = (type: 'character' | 'scene') => {
      if (!currentProject) return;
      const id = uuidv4();
      if (type === 'character') {
          const newChar: Character = {
              id,
              name: '新角色',
              aliases: [],
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

      const projectId = currentProject.id;
      const typePrompts = globalSettings.projectTypePrompts[currentProject.type] ?? globalSettings.projectTypePrompts['REAL_PERSON_COMMENTARY'];
      const prefix = typePrompts.assetImagePrefix;
      const scenePrefix = typePrompts.sceneImagePrefix || '';
      const model = currentProject.settings.imageModel;
      const tasks = selectedIds.map(id => {
        let description = '';
        let prompt = '';
        if (type === 'character') {
          const char = currentProject.characters.find(c => c.id === id);
          if (!char) return null;
          prompt = buildCharacterAssetPrompt(prefix, char);
        } else {
          const scene = currentProject.scenes.find(s => s.id === id);
          if (!scene) return null;
          description = scene.environment;
          prompt = scenePrefix ? `${scenePrefix}, ${description}` : description;
        }

        return {
          id: uuidv4(),
          type: type as 'character' | 'scene',
          targetId: id,
          projectId: projectId,
          execute: async () => {
            setProjects(prevProjects => {
              const newProjects = [...prevProjects];
              const projIndex = newProjects.findIndex(p => p.id === projectId);
              if (projIndex === -1) return prevProjects;

              const newProj = { ...newProjects[projIndex] };
              if (type === 'character') {
                newProj.characters = newProj.characters.map(c =>
                  c.id === id ? { ...c, progress: 0, error: undefined } : c
                );
              } else {
                newProj.scenes = newProj.scenes.map(s =>
                  s.id === id ? { ...s, progress: 0, error: undefined } : s
                );
              }
              newProjects[projIndex] = newProj;
              return newProjects;
            });
            let imageUrl = await generateAssetImageWithSelectedModel(
              prompt,
              model,
              projectId,
              (progress) => {
                setProjects(prevProjects => {
                  const newProjects = [...prevProjects];
                  const projIndex = newProjects.findIndex(p => p.id === projectId);
                  if (projIndex === -1) return prevProjects;

                  const newProj = { ...newProjects[projIndex] };
                  if (type === 'character') {
                    newProj.characters = newProj.characters.map(c =>
                      c.id === id ? { ...c, progress, error: undefined } : c
                    );
                  } else {
                    newProj.scenes = newProj.scenes.map(s =>
                      s.id === id ? { ...s, progress, error: undefined } : s
                    );
                  }
                  newProjects[projIndex] = newProj;
                  return newProjects;
                });
              }
            );

            // 上传图片到服务端，避免 Base64 内嵌导致项目 JSON 过大
            imageUrl = await uploadImageIfBase64(imageUrl, `${type}_${id}_${Date.now()}`);

            // 完成更新
            setProjects(prevProjects => {
              const newProjects = [...prevProjects];
              const projIndex = newProjects.findIndex(p => p.id === projectId);
              if (projIndex === -1) return prevProjects;

              const newProj = { ...newProjects[projIndex] };
              if (type === 'character') {
                newProj.characters = newProj.characters.map(c =>
                  c.id === id ? { ...c, imageUrl, progress: undefined, error: undefined } : c
                );
              } else {
                newProj.scenes = newProj.scenes.map(s =>
                  s.id === id ? { ...s, imageUrl, progress: undefined, error: undefined } : s
                );
              }
              newProj.updatedAt = Date.now();
              newProjects[projIndex] = newProj;
              return newProjects;
            });
          },
          onError: (error: string) => {
            // 错误更新
            setProjects(prevProjects => {
              const newProjects = [...prevProjects];
              const projIndex = newProjects.findIndex(p => p.id === projectId);
              if (projIndex === -1) return prevProjects;

              const newProj = { ...newProjects[projIndex] };
              if (type === 'character') {
                newProj.characters = newProj.characters.map(c =>
                  c.id === id ? { ...c, progress: undefined, error } : c
                );
              } else {
                newProj.scenes = newProj.scenes.map(s =>
                  s.id === id ? { ...s, progress: undefined, error } : s
                );
              }
              newProj.updatedAt = Date.now();
              newProjects[projIndex] = newProj;
              return newProjects;
            });
          }
        };
      }).filter(task => task !== null);

      // 批量加入队列
      taskQueue.enqueueBatch(tasks);
  };

  const handleUploadAssetImage = async (type: 'character' | 'scene', id: string) => {
    if (!currentProject) return;

    // 创建文件选择器
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';

    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        // 读取文件为 Base64
        const reader = new FileReader();
        reader.onload = async (event) => {
          const base64Data = event.target?.result as string;

          try {
            // 上传到服务器
            const filename = `${type}_${id}_${Date.now()}`;
            const result = await apiService.uploadMedia(base64Data, filename);

            // 更新项目中的资产图片 URL
            const imageUrl = result.url;

            setProjects(prevProjects => {
              const newProjects = [...prevProjects];
              const projIndex = newProjects.findIndex(p => p.id === currentProject.id);
              if (projIndex === -1) return prevProjects;

              const newProj = { ...newProjects[projIndex] };
              if (type === 'character') {
                newProj.characters = newProj.characters.map(c =>
                  c.id === id ? { ...c, imageUrl, progress: undefined, error: undefined } : c
                );
              } else {
                newProj.scenes = newProj.scenes.map(s =>
                  s.id === id ? { ...s, imageUrl, progress: undefined, error: undefined } : s
                );
              }
              newProj.updatedAt = Date.now();
              newProjects[projIndex] = newProj;
              return newProjects;
            });

            Logger.logInfo('上传资产图片', { type, id, filename });
          } catch (error) {
            Logger.logError('App', '上传资产图片失败', error);

            // 更新错误状态
            setProjects(prevProjects => {
              const newProjects = [...prevProjects];
              const projIndex = newProjects.findIndex(p => p.id === currentProject.id);
              if (projIndex === -1) return prevProjects;

              const newProj = { ...newProjects[projIndex] };
              if (type === 'character') {
                newProj.characters = newProj.characters.map(c =>
                  c.id === id ? { ...c, error: '上传失败' } : c
                );
              } else {
                newProj.scenes = newProj.scenes.map(s =>
                  s.id === id ? { ...s, error: '上传失败' } : s
                );
              }
              newProj.updatedAt = Date.now();
              newProjects[projIndex] = newProj;
              return newProjects;
            });
          }
        };

        reader.readAsDataURL(file);
      } catch (error) {
        Logger.logError('App', '读取文件失败', error);
      }
    };

    // 触发文件选择
    input.click();
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

  const handleInvertAssetSelection = (type: 'character' | 'scene') => {
      if (!currentProject) return;
      if (type === 'character') {
          const allIds = currentProject.characters.map(c => c.id);
          setSelectedCharacterIds(allIds.filter(id => !selectedCharacterIds.includes(id)));
      } else {
          const allIds = currentProject.scenes.map(s => s.id);
          setSelectedSceneIds(allIds.filter(id => !selectedSceneIds.includes(id)));
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

  // --- Variant Asset Handlers ---

  const handleAddVariant = (characterId?: string) => {
      if (!currentProject) return;
      const id = uuidv4();
      const newVariant: CharacterVariant = {
          id,
          characterId: characterId ?? (currentProject.characters[0]?.id ?? ''),
          name: '新变体',
          context: '',
          appearance: ''
      };
      handleUpdateProject(currentProject.id, { variants: [...(currentProject.variants ?? []), newVariant] });
      setEditingVariant({ id });
  };

  const handleDeleteVariant = (variantId: string) => {
      if (!currentProject) return;
      if (!confirm('确定要删除此变体资产吗？')) return;
      handleUpdateProject(currentProject.id, { variants: (currentProject.variants ?? []).filter(v => v.id !== variantId) });
      setSelectedVariantIds(prev => prev.filter(id => id !== variantId));
  };

  const handleBatchDeleteVariants = () => {
      if (!currentProject || selectedVariantIds.length === 0) return;
      if (!confirm(`确定要删除选中的 ${selectedVariantIds.length} 个变体资产吗？`)) return;
      handleUpdateProject(currentProject.id, { variants: (currentProject.variants ?? []).filter(v => !selectedVariantIds.includes(v.id)) });
      setSelectedVariantIds([]);
  };

  const handleSaveVariantUpdate = (variantId: string, updates: Partial<CharacterVariant>) => {
      if (!currentProject) return;
      const updatedVariants = (currentProject.variants ?? []).map(v => v.id === variantId ? { ...v, ...updates } : v);
      handleUpdateProject(currentProject.id, { variants: updatedVariants });
  };

  const handleSelectAllVariants = () => {
      if (!currentProject) return;
      setSelectedVariantIds((currentProject.variants ?? []).map(v => v.id));
  };

  const handleDeselectAllVariants = () => setSelectedVariantIds([]);

  const handleInvertVariantSelection = () => {
      if (!currentProject) return;
      const allIds = (currentProject.variants ?? []).map(v => v.id);
      setSelectedVariantIds(allIds.filter(id => !selectedVariantIds.includes(id)));
  };

  const handleSelectMissingVariantImages = () => {
      if (!currentProject) return;
      setSelectedVariantIds((currentProject.variants ?? []).filter(v => !v.imageUrl).map(v => v.id));
  };

  const toggleVariantSelection = (id: string) => {
      setSelectedVariantIds(prev => prev.includes(id) ? prev.filter(pid => pid !== id) : [...prev, id]);
  };

  const handleUploadVariantImage = async (variantId: string) => {
      if (!currentProject) return;
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onloadend = async () => {
              const base64Data = reader.result as string;
              const imageUrl = await uploadImageIfBase64(base64Data, `variant_${variantId}_${Date.now()}`);
              const updatedVariants = (currentProject.variants ?? []).map(v => v.id === variantId ? { ...v, imageUrl } : v);
              handleUpdateProject(currentProject.id, { variants: updatedVariants });
          };
          reader.readAsDataURL(file);
      };
      input.click();
  };

  const handleGenerateVariantImage = async (variantId: string) => {
      if (!currentProject) return;
      const variant = (currentProject.variants ?? []).find(v => v.id === variantId);
      if (!variant) return;
      const parentChar = currentProject.characters.find(c => c.id === variant.characterId);
      if (!parentChar) return;

      const projectId = currentProject.id;
      const typePrompts = globalSettings.projectTypePrompts[currentProject.type] ?? globalSettings.projectTypePrompts['REAL_PERSON_COMMENTARY'];
      const prefix = typePrompts.assetImagePrefix;
      const prompt = buildVariantAssetPrompt(prefix, variant);
      const model = currentProject.settings.imageModel;
      const isBananaProModel = isBananaProImageModel(model);
      const isVolcengineModel = isVolcengineImageModel(model);
      const isBltcyModel = isBltcyBanana2Model(model);
      const isBltcyNanoBananaHd = isBltcyNanoBananaHdModel(model);
      const charReferenceImages: { name: string; data: string; mimeType: string }[] = [];
      if (parentChar.imageUrl) {
          const refData = await imageUrlToRefData(parentChar.imageUrl);
          if (refData) charReferenceImages.push({ name: parentChar.name, ...refData });
      }

      const task = {
          id: uuidv4(),
          type: 'variant' as const,
          targetId: variantId,
          projectId,
          execute: async () => {
              setProjects(prev => prev.map(p => p.id !== projectId ? p : {
                  ...p,
                  variants: (p.variants ?? []).map(v => v.id === variantId ? { ...v, progress: 0, error: undefined } : v)
              }));

              let imageUrl: string;
              if (isBananaProModel) {
                  imageUrl = await generateImageWithBananaPro(
                      prompt, '16:9', charReferenceImages, '2K',
                      (progress) => {
                          setProjects(prev => prev.map(p => p.id !== projectId ? p : {
                              ...p,
                              variants: (p.variants ?? []).map(v => v.id === variantId ? { ...v, progress, error: undefined } : v)
                          }));
                      },
                      model
                  );
              } else if (isVolcengineModel) {
                  imageUrl = await generateImageWithVolcengine(
                      prompt, '16:9', charReferenceImages, '2K',
                      (progress) => {
                          setProjects(prev => prev.map(p => p.id !== projectId ? p : {
                              ...p,
                              variants: (p.variants ?? []).map(v => v.id === variantId ? { ...v, progress, error: undefined } : v)
                          }));
                      },
                      model
                  );
              } else if (isBltcyModel) {
                  // 使用柏拉图 One-API banana2 (2K)
                  imageUrl = await generateImageWithBltcyBanana2(
                      prompt, '16:9', charReferenceImages, projectId,
                      (progress) => {
                          setProjects(prev => prev.map(p => p.id !== projectId ? p : {
                              ...p,
                              variants: (p.variants ?? []).map(v => v.id === variantId ? { ...v, progress, error: undefined } : v)
                          }));
                      }
                  );
              } else if (isBltcyNanoBananaHd) {
                  // 使用柏拉图中转 nano banana (HD)
                  imageUrl = await generateImageWithBltcyNanoBananaHd(
                      prompt, '16:9', charReferenceImages, projectId,
                      (progress) => {
                          setProjects(prev => prev.map(p => p.id !== projectId ? p : {
                              ...p,
                              variants: (p.variants ?? []).map(v => v.id === variantId ? { ...v, progress, error: undefined } : v)
                          }));
                      }
                  );
              } else if (isBltcyNanoBananaProModel(model)) {
                  // 使用柏拉图中转 nano banana pro
                  imageUrl = await generateImageWithBltcyNanoBananaPro(
                      prompt, '16:9', charReferenceImages, projectId,
                      (progress) => {
                          setProjects(prev => prev.map(p => p.id !== projectId ? p : {
                              ...p,
                              variants: (p.variants ?? []).map(v => v.id === variantId ? { ...v, progress, error: undefined } : v)
                          }));
                      }
                  );
              } else {
                  imageUrl = await generateImageAsset(prompt, '16:9', model);
              }

              // 上传图片到服务端，避免 Base64 内嵌导致项目 JSON 过大
              imageUrl = await uploadImageIfBase64(imageUrl, `variant_${variantId}_${Date.now()}`);

              setProjects(prev => prev.map(p => p.id !== projectId ? p : {
                  ...p,
                  updatedAt: Date.now(),
                  variants: (p.variants ?? []).map(v => v.id === variantId ? { ...v, imageUrl, progress: undefined, error: undefined } : v)
              }));
          },
          onError: (error: string) => {
              setProjects(prev => prev.map(p => p.id !== projectId ? p : {
                  ...p,
                  updatedAt: Date.now(),
                  variants: (p.variants ?? []).map(v => v.id === variantId ? { ...v, progress: undefined, error } : v)
              }));
          }
      };
      taskQueue.enqueue(task);
  };

  const handleBatchGenerateVariants = async () => {
      if (!currentProject || selectedVariantIds.length === 0) return;
      for (const variantId of selectedVariantIds) {
          await handleGenerateVariantImage(variantId);
      }
  };



  // 将现有资产名字列表拼成提示词上下文，注入 systemInstruction，让 LLM 只提取缺少的资产
  const buildExistingAssetsContext = (
    characters: Character[],
    scenes: Scene[],
    variants: CharacterVariant[]
  ): string => {
    const parts: string[] = [];
    if (characters.length)
      parts.push(`现有角色（已存在，请勿重复提取）：${characters.map(c => c.name).join('、')}`);
    if (variants.length)
      parts.push(`现有变体（已存在，请勿重复提取）：${variants.map(v => v.name).join('、')}`);
    if (scenes.length)
      parts.push(`现有场景（已存在，请勿重复提取）：${scenes.map(s => s.name).join('、')}`);
    if (!parts.length) return '';
    return '\n\n【现有资产列表】\n' + parts.join('\n');
  };

  // 资产提取（角色和场景）
  const handleExtractAssets = async () => {
    if (!currentProject || !currentEpisode || !currentEpisode.scriptContent) return;

    const startTime = Date.now();
    Logger.logOperationStart('资产提取', {
      projectId: currentProject.id,
      projectName: currentProject.name,
      projectType: currentProject.type,
      episodeId: currentEpisode.id,
      episodeName: currentEpisode.name,
      scriptLength: currentEpisode.scriptContent.length
    });

    try {
      // 1. Get Settings for this Project Type
      const prompts = globalSettings.projectTypePrompts[currentProject.type] ?? globalSettings.projectTypePrompts['REAL_PERSON_COMMENTARY'];
      const model = globalSettings.extractionModel;

      if (model.startsWith('doubao')) {
        const connectivity = await checkVolcengineConnectivity();
        if (!connectivity.ok) {
          alert(`豆包连通性检测失败：${connectivity.error}`);
          return;
        }
      }

      setEpisodeProcessing(currentEpisode.id, true);

      Logger.logInfo('使用的模型和提示词配置', {
        model,
        projectType: currentProject.type,
        prompts: {
          characterExtraction: prompts.characterExtraction.substring(0, 50) + '...',
          sceneExtraction: prompts.sceneExtraction.substring(0, 50) + '...'
        }
      });

      const existingContext = buildExistingAssetsContext(
        currentProject.characters,
        currentProject.scenes,
        currentProject.variants ?? []
      );
      const systemInstruction = `${prompts.characterExtraction}\n\n${prompts.sceneExtraction}${existingContext}`;

      // 2. Extract Assets - 根据模型选择不同的服务
      const isVolcengineModel = model.startsWith('doubao');
      const isClaudeModel = isClaudeChatModel(model);

      Logger.logInfo('选择的服务', {
        service: isVolcengineModel ? '火山引擎' : isClaudeModel ? 'Claude' : 'Gemini',
        model
      });

      const analysis = isClaudeModel
        ? await analyzeNovelScriptWithClaude(currentEpisode.scriptContent, systemInstruction, undefined, globalSettings.preprocessModel as any)
        : isVolcengineModel
        ? await analyzeNovelScriptVolcengine(currentEpisode.scriptContent, model, systemInstruction)
        : await analyzeNovelScriptGemini(currentEpisode.scriptContent, model, systemInstruction);

      if (isClaudeModel) {
        await recordTextUsage({ provider: 'claude',
          projectId: currentProject.id,
          taskType: 'assetExtraction',
          sourceId: currentEpisode.id,
          operationId: 'extract-assets',
          result: analysis as { usage?: any; model?: string },
        });
      } else if (isVolcengineModel) {
        await recordTextUsage({ provider: 'volcengine',
          projectId: currentProject.id,
          taskType: 'assetExtraction',
          sourceId: currentEpisode.id,
          operationId: 'extract-assets',
          result: analysis as { usage?: any; model?: string },
        });
      } else {
        await recordTextUsage({ provider: 'gemini',
          projectId: currentProject.id,
          taskType: 'assetExtraction',
          sourceId: currentEpisode.id,
          operationId: 'extract-assets',
          result: analysis as { usage?: any; model?: string },
        });
      }

      Logger.logInfo('角色和场景提取完成', {
        charactersCount: analysis.characters.length,
        scenesCount: analysis.scenes.length
      });

      const newCharacters: Character[] = analysis.characters.map(c => {
        const normalized = normalizeCharacterInput(c.name, c.aliases);
        return { ...c, ...normalized, id: uuidv4(), aliases: normalized.aliases };
      });
      const newScenes: Scene[] = analysis.scenes.map(s => ({ ...s, id: uuidv4() }));

      // 将 AI 提取的变体映射到已提取的角色 ID
      const allCharacters = [...currentProject.characters, ...newCharacters];
      const newVariants: CharacterVariant[] = (analysis.variants ?? [])
        .map(v => {
          const char = allCharacters.find(c =>
            c.name === v.characterName || (c.aliases ?? []).includes(v.characterName)
          );
          if (!char) return null;
          return {
            id: uuidv4(),
            characterId: char.id,
            name: v.name,
            context: v.context,
            appearance: v.appearance
          } as CharacterVariant;
        })
        .filter((v): v is CharacterVariant => v !== null);

      // 合并新资产到现有列表
      const mergedCharacters = [...currentProject.characters, ...newCharacters];
      const mergedScenes = [...currentProject.scenes, ...newScenes];
      const mergedVariants = [...(currentProject.variants ?? []), ...newVariants];

      Logger.logInfo('合并资产', {
        existingCharacters: currentProject.characters.length,
        newCharacters: newCharacters.length,
        totalCharacters: mergedCharacters.length,
        existingScenes: currentProject.scenes.length,
        newScenes: newScenes.length,
        totalScenes: mergedScenes.length,
        newVariants: newVariants.length,
        totalVariants: mergedVariants.length
      });

      // Update Project State
      handleUpdateProject(currentProject.id, {
        characters: mergedCharacters,
        scenes: mergedScenes,
        variants: mergedVariants
      });

      const duration = Date.now() - startTime;
      Logger.logOperationEnd('资产提取', {
        success: true,
        totalCharacters: mergedCharacters.length,
        totalScenes: mergedScenes.length
      }, duration);

      // 先重置处理状态，再切换标签页（避免DOM更新冲突）
      setEpisodeProcessing(currentEpisode.id, false);

      // 使用 setTimeout 确保状态更新完成后再切换标签页
      setTimeout(() => {
        setActiveTab(ProjectTab.ASSETS);
      }, 0);

    } catch (error) {
      Logger.logError('App', '资产提取失败', error);
      console.error(error);
      setEpisodeProcessing(currentEpisode.id, false);
    }
  };

  // 提取人物（仅角色 + 变体）
  const handleExtractCharacters = async () => {
    if (!currentProject || !currentEpisode || !currentEpisode.scriptContent) return;

    const startTime = Date.now();
    Logger.logOperationStart('提取人物', {
      projectId: currentProject.id,
      projectName: currentProject.name,
      projectType: currentProject.type,
      episodeId: currentEpisode.id,
      episodeName: currentEpisode.name,
      scriptLength: currentEpisode.scriptContent.length
    });

    try {
      // 1. Get Settings for this Project Type
      const prompts = globalSettings.projectTypePrompts[currentProject.type] ?? globalSettings.projectTypePrompts['REAL_PERSON_COMMENTARY'];
      const model = globalSettings.extractionModel;

      if (model.startsWith('doubao')) {
        const connectivity = await checkVolcengineConnectivity();
        if (!connectivity.ok) {
          alert(`豆包连通性检测失败：${connectivity.error}`);
          return;
        }
      }

      setEpisodeProcessing(currentEpisode.id, true);

      Logger.logInfo('使用的模型和提示词配置', {
        model,
        projectType: currentProject.type,
        prompts: {
          characterExtraction: prompts.characterExtraction.substring(0, 50) + '...'
        }
      });

      const existingContext = buildExistingAssetsContext(
        currentProject.characters,
        [],
        currentProject.variants ?? []
      );
      const systemInstruction = `${prompts.characterExtraction}${existingContext}`;

      // 2. Extract Characters - 根据模型选择不同的服务
      const isVolcengineModel = model.startsWith('doubao');
      const isClaudeModel = isClaudeChatModel(model);

      Logger.logInfo('选择的服务', {
        service: isVolcengineModel ? '火山引擎' : isClaudeModel ? 'Claude' : 'Gemini',
        model
      });

      const analysis = isClaudeModel
        ? await analyzeNovelScriptWithClaude(currentEpisode.scriptContent, systemInstruction, undefined, globalSettings.preprocessModel as any)
        : isVolcengineModel
        ? await analyzeNovelScriptVolcengine(currentEpisode.scriptContent, model, systemInstruction)
        : await analyzeNovelScriptGemini(currentEpisode.scriptContent, model, systemInstruction);

      if (isClaudeModel) {
        await recordTextUsage({ provider: 'claude',
          projectId: currentProject.id,
          taskType: 'assetExtraction',
          sourceId: currentEpisode.id,
          operationId: 'extract-characters',
          result: analysis as { usage?: any; model?: string },
        });
      } else if (isVolcengineModel) {
        await recordTextUsage({ provider: 'volcengine',
          projectId: currentProject.id,
          taskType: 'assetExtraction',
          sourceId: currentEpisode.id,
          operationId: 'extract-characters',
          result: analysis as { usage?: any; model?: string },
        });
      } else {
        await recordTextUsage({ provider: 'gemini',
          projectId: currentProject.id,
          taskType: 'assetExtraction',
          sourceId: currentEpisode.id,
          operationId: 'extract-characters',
          result: analysis as { usage?: any; model?: string },
        });
      }

      Logger.logInfo('人物提取完成', {
        charactersCount: (analysis.characters ?? []).length,
        variantsCount: (analysis.variants ?? []).length
      });

      const newCharacters: Character[] = (analysis.characters ?? []).map(c => {
        const normalized = normalizeCharacterInput(c.name, c.aliases);
        return { ...c, ...normalized, id: uuidv4(), aliases: normalized.aliases };
      });

      // 将 AI 提取的变体映射到已提取的角色 ID
      const allCharacters = [...currentProject.characters, ...newCharacters];
      const newVariants: CharacterVariant[] = (analysis.variants ?? [])
        .map(v => {
          const char = allCharacters.find(c =>
            c.name === v.characterName || (c.aliases ?? []).includes(v.characterName)
          );
          if (!char) return null;
          return {
            id: uuidv4(),
            characterId: char.id,
            name: v.name,
            context: v.context,
            appearance: v.appearance
          } as CharacterVariant;
        })
        .filter((v): v is CharacterVariant => v !== null);

      // 合并新资产到现有列表
      const mergedCharacters = [...currentProject.characters, ...newCharacters];
      const mergedVariants = [...(currentProject.variants ?? []), ...newVariants];

      Logger.logInfo('合并人物资产', {
        existingCharacters: currentProject.characters.length,
        newCharacters: newCharacters.length,
        totalCharacters: mergedCharacters.length,
        newVariants: newVariants.length,
        totalVariants: mergedVariants.length
      });

      // Update Project State
      handleUpdateProject(currentProject.id, {
        characters: mergedCharacters,
        variants: mergedVariants
      });

      const duration = Date.now() - startTime;
      Logger.logOperationEnd('提取人物', {
        success: true,
        totalCharacters: mergedCharacters.length,
        totalVariants: mergedVariants.length
      }, duration);

      // 先重置处理状态，再切换标签页（避免DOM更新冲突）
      setEpisodeProcessing(currentEpisode.id, false);

      // 使用 setTimeout 确保状态更新完成后再切换标签页
      setTimeout(() => {
        setActiveTab(ProjectTab.ASSETS);
      }, 0);

    } catch (error) {
      Logger.logError('App', '提取人物失败', error);
      console.error(error);
      setEpisodeProcessing(currentEpisode.id, false);
    }
  };

  // 提取场景（仅场景）
  const handleExtractScenes = async () => {
    if (!currentProject || !currentEpisode || !currentEpisode.scriptContent) return;

    const startTime = Date.now();
    Logger.logOperationStart('提取场景', {
      projectId: currentProject.id,
      projectName: currentProject.name,
      projectType: currentProject.type,
      episodeId: currentEpisode.id,
      episodeName: currentEpisode.name,
      scriptLength: currentEpisode.scriptContent.length
    });

    try {
      // 1. Get Settings for this Project Type
      const prompts = globalSettings.projectTypePrompts[currentProject.type] ?? globalSettings.projectTypePrompts['REAL_PERSON_COMMENTARY'];
      const model = globalSettings.extractionModel;

      if (model.startsWith('doubao')) {
        const connectivity = await checkVolcengineConnectivity();
        if (!connectivity.ok) {
          alert(`豆包连通性检测失败：${connectivity.error}`);
          return;
        }
      }

      setEpisodeProcessing(currentEpisode.id, true);

      Logger.logInfo('使用的模型和提示词配置', {
        model,
        projectType: currentProject.type,
        prompts: {
          sceneExtraction: prompts.sceneExtraction.substring(0, 50) + '...'
        }
      });

      const existingContext = buildExistingAssetsContext(
        [],
        currentProject.scenes,
        []
      );
      const systemInstruction = `${prompts.sceneExtraction}${existingContext}`;

      // 2. Extract Scenes - 根据模型选择不同的服务
      const isVolcengineModel = model.startsWith('doubao');
      const isClaudeModel = isClaudeChatModel(model);
      const analyzeNovelScript = isVolcengineModel
        ? analyzeNovelScriptVolcengine
        : isClaudeModel
        ? analyzeNovelScriptWithClaude
        : analyzeNovelScriptGemini;

      Logger.logInfo('选择的服务', {
        service: isVolcengineModel ? '火山引擎' : isClaudeModel ? 'Claude' : 'Gemini',
        model
      });

      const analysis = isClaudeModel
        ? await analyzeNovelScriptWithClaude(currentEpisode.scriptContent, systemInstruction, undefined, globalSettings.preprocessModel as any)
        : isVolcengineModel
        ? await analyzeNovelScriptVolcengine(currentEpisode.scriptContent, model, systemInstruction)
        : await analyzeNovelScriptGemini(currentEpisode.scriptContent, model, systemInstruction);

      if (isClaudeModel) {
        await recordTextUsage({ provider: 'claude',
          projectId: currentProject.id,
          taskType: 'assetExtraction',
          sourceId: currentEpisode.id,
          operationId: 'extract-scenes',
          result: analysis as { usage?: any; model?: string },
        });
      } else if (isVolcengineModel) {
        await recordTextUsage({ provider: 'volcengine',
          projectId: currentProject.id,
          taskType: 'assetExtraction',
          sourceId: currentEpisode.id,
          operationId: 'extract-scenes',
          result: analysis as { usage?: any; model?: string },
        });
      } else {
        await recordTextUsage({ provider: 'gemini',
          projectId: currentProject.id,
          taskType: 'assetExtraction',
          sourceId: currentEpisode.id,
          operationId: 'extract-scenes',
          result: analysis as { usage?: any; model?: string },
        });
      }

      Logger.logInfo('场景提取完成', {
        scenesCount: (analysis.scenes ?? []).length
      });

      const newScenes: Scene[] = (analysis.scenes ?? []).map(s => ({ ...s, id: uuidv4() }));

      // 合并新资产到现有列表
      const mergedScenes = [...currentProject.scenes, ...newScenes];

      Logger.logInfo('合并场景资产', {
        existingScenes: currentProject.scenes.length,
        newScenes: newScenes.length,
        totalScenes: mergedScenes.length
      });

      // Update Project State
      handleUpdateProject(currentProject.id, {
        scenes: mergedScenes
      });

      const duration = Date.now() - startTime;
      Logger.logOperationEnd('提取场景', {
        success: true,
        totalScenes: mergedScenes.length
      }, duration);

      // 先重置处理状态，再切换标签页（避免DOM更新冲突）
      setEpisodeProcessing(currentEpisode.id, false);

      // 使用 setTimeout 确保状态更新完成后再切换标签页
      setTimeout(() => {
        setActiveTab(ProjectTab.ASSETS);
      }, 0);

    } catch (error) {
      Logger.logError('App', '提取场景失败', error);
      console.error(error);
      setEpisodeProcessing(currentEpisode.id, false);
    }
  };

  // 分镜拆解
  const handleGenerateStoryboard = async () => {
    if (!currentProject || !currentEpisode || !currentEpisode.scriptContent) return;

    const startTime = Date.now();
    Logger.logOperationStart('分镜拆解', {
      projectId: currentProject.id,
      projectName: currentProject.name,
      projectType: currentProject.type,
      episodeId: currentEpisode.id,
      episodeName: currentEpisode.name,
      scriptLength: currentEpisode.scriptContent.length,
      existingCharacters: currentProject.characters.length,
      existingScenes: currentProject.scenes.length
    });

    setEpisodeProcessing(currentEpisode.id, true);
    try {
      // 1. Get Settings for this Project Type
      const prompts = globalSettings.projectTypePrompts[currentProject.type] ?? globalSettings.projectTypePrompts['REAL_PERSON_COMMENTARY'];
      const model = globalSettings.extractionModel;

      Logger.logInfo('使用的模型和提示词配置', {
        model,
        projectType: currentProject.type,
        storyboardBreakdown: prompts.storyboardBreakdown.substring(0, 50) + '...'
      });

      // 2. Breakdown Storyboard - 根据模型选择不同的服务
      const isVolcengineModel = model.startsWith('doubao');
      const isClaudeModel = isClaudeChatModel(model);
      const generateStoryboardBreakdown = isVolcengineModel
        ? generateStoryboardBreakdownVolcengine
        : isClaudeModel
        ? generateStoryboardBreakdownWithClaude
        : generateStoryboardBreakdownGemini;

      Logger.logInfo('选择的服务', {
        service: isVolcengineModel ? '火山引擎' : isClaudeModel ? 'Claude' : 'Gemini',
        model
      });

      const characterChoices = currentProject.characters.map(c => ({
        name: c.name,
        aliases: c.aliases ?? []
      }));
      const sceneChoices = currentProject.scenes.map(s => ({ name: s.name }));
      const variantChoices = (currentProject.variants ?? []).map(v => ({
        name: v.name,
        characterName: currentProject.characters.find(c => c.id === v.characterId)?.name ?? '',
        context: v.context ?? ''
      }));

      const assetMatchingInstruction = `你必须在以下”候选资产列表”中为每个分镜匹配引用资产：

1) 角色匹配规则：
- frame.characterNames 必须只填写候选角色的 name（禁止输出别称/原文中的称呼/括号注释）
- 允许你根据 aliases 做理解，但最终输出必须是候选的 name
- 若该帧无可匹配角色：请输出 characterNames: [] 或直接省略 characterNames 字段

2) 场景匹配规则：
- frame.sceneNames 填写候选场景的 name 列表（可匹配多个场景，禁止输出自造场景名）
- 若该帧无可匹配场景：请直接省略 sceneNames 字段（不要输出空数组）

3) 变体资产匹配规则：
- frame.variantNames 填写候选变体资产的 name（角色特定服装/外貌版本）
- 当该帧场景/文本明确涉及某角色的特定服装或特殊外貌状态时，填写对应变体名
- 变体名必须完全匹配候选变体资产的 name（禁止自造变体名）
- 若无匹配变体：省略 variantNames 字段

4) 对白输出规则：
- 优先输出 frame.dialogues: [{ speakerName, text }, ...]
- speakerName 必须是候选角色列表里的 name（严格一致），不要输出别称
- narration/独白/未明确说话人：省略 speakerName（或给空字符串）
- 一个分镜内允许多个说话人、多段对白，按出现顺序输出
- 可选：同时输出 frame.dialogue 作为兼容字段（多行 “说话人：台词”）

候选角色列表（name + aliases）：\n${JSON.stringify(characterChoices)}\n
候选变体资产列表（name + characterName + context）：\n${JSON.stringify(variantChoices)}\n
候选场景列表（name）：\n${JSON.stringify(sceneChoices)}\n`;

      const storyboardSystemInstruction = `${prompts.storyboardBreakdown}\n\n${assetMatchingInstruction}`;
      const breakdown = isClaudeModel
        ? await generateStoryboardBreakdownWithClaude(currentEpisode.scriptContent, storyboardSystemInstruction, undefined, globalSettings.preprocessModel as any)
        : isVolcengineModel
        ? await generateStoryboardBreakdownVolcengine(currentEpisode.scriptContent, model, storyboardSystemInstruction)
        : await generateStoryboardBreakdownGemini(currentEpisode.scriptContent, model, storyboardSystemInstruction);

      if (isClaudeModel) {
        await recordTextUsage({ provider: 'claude',
          projectId: currentProject.id,
          taskType: 'storyboardBreakdown',
          sourceId: currentEpisode.id,
          operationId: 'generate-storyboard',
          result: breakdown as { usage?: any; model?: string },
        });
      } else if (isVolcengineModel) {
        await recordTextUsage({ provider: 'volcengine',
          projectId: currentProject.id,
          taskType: 'storyboardBreakdown',
          sourceId: currentEpisode.id,
          operationId: 'generate-storyboard',
          result: breakdown as { usage?: any; model?: string },
        });
      } else {
        await recordTextUsage({ provider: 'gemini',
          projectId: currentProject.id,
          taskType: 'storyboardBreakdown',
          sourceId: currentEpisode.id,
          operationId: 'generate-storyboard',
          result: breakdown as { usage?: any; model?: string },
        });
      }

      Logger.logInfo('分镜分解完成', {
        framesCount: breakdown.frames.length
      });

      const newFrames: StoryboardFrame[] = breakdown.frames.map((f, idx) => {
        const charIds = (f.characterNames || [])
          .map(name => currentProject.characters.find(c => matchesCharacter(c, name))?.id)
          .filter((id): id is string => !!id);

        const variantIds = (f.variantNames || [])
          .map(name => (currentProject.variants ?? []).find(v => v.name === name)?.id)
          .filter((id): id is string => !!id);

        // 如果某角色已有变体被引用，则从 characterIds 中移除该角色，避免重复引用
        const variantOwnerCharIds = new Set(
          variantIds
            .map(vid => (currentProject.variants ?? []).find(v => v.id === vid)?.characterId)
            .filter((id): id is string => !!id)
        );
        const dedupedCharIds = charIds.filter(cid => !variantOwnerCharIds.has(cid));

        const sceneNames = (f.sceneNames ?? (f.sceneName ? [f.sceneName] : []));
        const sceneIds = sceneNames
          .map(name => currentProject.scenes.find(s => s.name.toLowerCase().includes(name.toLowerCase()))?.id)
          .filter((id): id is string => !!id);
        const deduped = [...new Set(sceneIds)];

        const dialogues = normalizeDialogues(f.dialogues) ?? splitDialogueStringToDialogues(f.dialogue);
        const dialogue = mergeDialoguesToDisplayString(dialogues) ?? f.dialogue;

        return {
          id: uuidv4(),
          index: idx,
          imagePrompt: f.imagePrompt,
          videoPrompt: f.videoPrompt,
          dialogues,
          dialogue,
          originalText: f.originalText,
          references: {
            characterIds: [...new Set(dedupedCharIds)],
            variantIds: variantIds.length > 0 ? [...new Set(variantIds)] : undefined,
            sceneId: deduped[0],
            sceneIds: deduped.length > 0 ? deduped : undefined,
          }
        };
      });

      Logger.logInfo('分镜帧映射完成', {
        framesCount: newFrames.length,
        framesWithCharacters: newFrames.filter(f => f.references.characterIds.length > 0).length,
        framesWithScene: newFrames.filter(f => f.references.sceneIds && f.references.sceneIds.length > 0).length
      });

      // Update Episode State
      handleUpdateEpisode(currentProject.id, currentEpisode.id, {
        frames: newFrames
      });

      const duration = Date.now() - startTime;
      Logger.logOperationEnd('分镜拆解', {
        success: true,
        totalFrames: newFrames.length
      }, duration);

      // 先重置处理状态，再切换标签页（避免DOM更新冲突）
      setEpisodeProcessing(currentEpisode.id, false);

      // 使用 setTimeout 确保状态更新完成后再切换标签页
      setTimeout(() => {
        setActiveTab(ProjectTab.STORYBOARD);
      }, 0);

    } catch (error) {
      Logger.logError('App', '分镜拆解失败', error);
      console.error(error);
      setEpisodeProcessing(currentEpisode.id, false);
    }
  };

  const handleGenerateAssetImage = async (type: 'character' | 'scene', id: string, description: string) => {
    if (!currentProject) return;

    const projectId = currentProject.id;
    const typePrompts = globalSettings.projectTypePrompts[currentProject.type] ?? globalSettings.projectTypePrompts['REAL_PERSON_COMMENTARY'];
    const prefix = typePrompts.assetImagePrefix;
    const scenePrefix = typePrompts.sceneImagePrefix || '';
    const prompt = type === 'character'
      ? (() => {
        const char = currentProject.characters.find(c => c.id === id);
        return char ? buildCharacterAssetPrompt(prefix, char) : `${prefix}, ${description}`;
      })()
      : scenePrefix ? `${scenePrefix}, ${description}` : description;
    const model = currentProject.settings.imageModel;
    const task = {
      id: uuidv4(),
      type: type as 'character' | 'scene',
      targetId: id,
      projectId: projectId,
      execute: async () => {
        setProjects(prevProjects => {
          const newProjects = [...prevProjects];
          const projIndex = newProjects.findIndex(p => p.id === projectId);
          if (projIndex === -1) return prevProjects;

          const newProj = { ...newProjects[projIndex] };
          if (type === 'character') {
            newProj.characters = newProj.characters.map(c =>
              c.id === id ? { ...c, progress: 0, error: undefined } : c
            );
          } else {
            newProj.scenes = newProj.scenes.map(s =>
              s.id === id ? { ...s, progress: 0, error: undefined } : s
            );
          }
          newProjects[projIndex] = newProj;
          return newProjects;
        });
        let imageUrl = await generateAssetImageWithSelectedModel(
          prompt,
          model,
          projectId,
          (progress) => {
            setProjects(prevProjects => {
              const newProjects = [...prevProjects];
              const projIndex = newProjects.findIndex(p => p.id === projectId);
              if (projIndex === -1) return prevProjects;

              const newProj = { ...newProjects[projIndex] };
              if (type === 'character') {
                newProj.characters = newProj.characters.map(c =>
                  c.id === id ? { ...c, progress, error: undefined } : c
                );
              } else {
                newProj.scenes = newProj.scenes.map(s =>
                  s.id === id ? { ...s, progress, error: undefined } : s
                );
              }
              newProjects[projIndex] = newProj;
              return newProjects;
            });
          }
        );

        // 上传图片到服务端，避免 Base64 内嵌导致项目 JSON 过大
        imageUrl = await uploadImageIfBase64(imageUrl, `${type}_${id}_${Date.now()}`);

        // 完成更新
        setProjects(prevProjects => {
          const newProjects = [...prevProjects];
          const projIndex = newProjects.findIndex(p => p.id === projectId);
          if (projIndex === -1) return prevProjects;

          const newProj = { ...newProjects[projIndex] };
          if (type === 'character') {
            newProj.characters = newProj.characters.map(c =>
              c.id === id ? { ...c, imageUrl, progress: undefined, error: undefined } : c
            );
          } else {
            newProj.scenes = newProj.scenes.map(s =>
              s.id === id ? { ...s, imageUrl, progress: undefined, error: undefined } : s
            );
          }
          newProj.updatedAt = Date.now();
          newProjects[projIndex] = newProj;
          return newProjects;
        });
      },
      onError: (error: string) => {
        // 错误更新
        setProjects(prevProjects => {
          const newProjects = [...prevProjects];
          const projIndex = newProjects.findIndex(p => p.id === projectId);
          if (projIndex === -1) return prevProjects;

          const newProj = { ...newProjects[projIndex] };
          if (type === 'character') {
            newProj.characters = newProj.characters.map(c =>
              c.id === id ? { ...c, progress: undefined, error } : c
            );
          } else {
            newProj.scenes = newProj.scenes.map(s =>
              s.id === id ? { ...s, progress: undefined, error } : s
            );
          }
          newProj.updatedAt = Date.now();
          newProjects[projIndex] = newProj;
          return newProjects;
        });
      }
    };

    // 加入队列
    taskQueue.enqueue(task);
  };

  const handleGenerateFrameImage = async (frameId: string, prompt: string) => {
    if (!currentProject || !currentEpisode) return;

    const projectId = currentProject.id;
    const episodeId = currentEpisode.id;
    const typePrompts = globalSettings.projectTypePrompts[currentProject.type] ?? globalSettings.projectTypePrompts['REAL_PERSON_COMMENTARY'];
    const prefix = typePrompts.storyboardImagePrefix;
    const aspectRatio = currentProject.settings.aspectRatio || '16:9';
    const model = currentProject.settings.storyboardImageModel ?? currentProject.settings.imageModel;
    const isBananaProModel = isBananaProImageModel(model);
    const isVolcengineModel = isVolcengineImageModel(model);
    const isBltcyModel = isBltcyBanana2Model(model);
    const isBltcyNanoBananaHd = isBltcyNanoBananaHdModel(model);
    const frame = currentEpisode.frames.find(f => f.id === frameId);
    if (!frame) return;

    const referenceImages: { name: string, data: string, mimeType: string }[] = [];

    // Add Characters
    for (const charId of frame.references.characterIds) {
      const char = currentProject.characters.find(c => c.id === charId);
      if (char && char.imageUrl) {
        const refData = await imageUrlToRefData(char.imageUrl);
        if (refData) {
          referenceImages.push({ name: char.name, ...refData });
          console.log(`[分镜生图] 角色参考图: ${char.name}`, { hasImageUrl: true, dataLength: refData.data.length });
        }
      }
    }

    // Add Scenes（支持多场景，向后兼容单 sceneId）
    const effectiveSceneIds = frame.references.sceneIds
      ?? (frame.references.sceneId ? [frame.references.sceneId] : []);
    for (const sceneId of effectiveSceneIds) {
      const scene = currentProject.scenes.find(s => s.id === sceneId);
      if (scene && scene.imageUrl) {
        const refData = await imageUrlToRefData(scene.imageUrl);
        if (refData) {
          referenceImages.push({ name: scene.name, ...refData });
          console.log(`[分镜生图] 场景参考图: ${scene.name}`, { hasImageUrl: true, dataLength: refData.data.length });
        }
      }
    }

    // Add Variants (变体参考图：如角色特定服装版本)
    for (const variantId of (frame.references.variantIds ?? [])) {
      const variant = (currentProject.variants ?? []).find(v => v.id === variantId);
      if (variant && variant.imageUrl) {
        const refData = await imageUrlToRefData(variant.imageUrl);
        if (refData) {
          referenceImages.push({ name: variant.name, ...refData });
          console.log(`[分镜生图] 变体参考图: ${variant.name}`, { hasImageUrl: true, dataLength: refData.data.length });
        }
      }
    }

    console.log('[分镜生图] 参考图组装结果', {
      frameId,
      frameIndex: frame.index,
      model,
      characterIds: frame.references.characterIds,
      sceneIds: frame.references.sceneIds ?? (frame.references.sceneId ? [frame.references.sceneId] : []),
      referenceImagesCount: referenceImages.length,
      referenceImages: referenceImages.map(img => ({
        name: img.name,
        mimeType: img.mimeType,
        dataLength: img.data?.length ?? 0,
        hasData: !!img.data
      }))
    });

    // 创建任务
    const task = {
      id: uuidv4(),
      type: 'storyboard' as const,
      targetId: frameId,
      projectId: projectId,
      episodeId: episodeId,
      execute: async () => {
        // 标记为生成中
        setProjects(prevProjects => {
          const newProjects = [...prevProjects];
          const projIndex = newProjects.findIndex(p => p.id === projectId);
          if (projIndex === -1) return prevProjects;

          const newProj = { ...newProjects[projIndex] };
          const epIndex = newProj.episodes.findIndex(e => e.id === episodeId);
          if (epIndex === -1) return prevProjects;

          newProj.episodes[epIndex].frames = newProj.episodes[epIndex].frames.map(f =>
            f.id === frameId ? {
              ...f,
              isGenerating: true,
              imageProgress: 0,
              imageError: undefined
            } : f
          );
          newProjects[projIndex] = newProj;
          return newProjects;
        });

        let imageUrl: string;
        if (isBananaProModel) {
          // 使用香蕉Pro服务
          imageUrl = await generateImageWithBananaPro(
            `${prefix}\n\n${prompt}`,
            aspectRatio,
            referenceImages,
            '2K',
            (progress) => {
              // 更新进度
              setProjects(prevProjects => {
                const newProjects = [...prevProjects];
                const projIndex = newProjects.findIndex(p => p.id === projectId);
                if (projIndex === -1) return prevProjects;

                const newProj = { ...newProjects[projIndex] };
                const epIndex = newProj.episodes.findIndex(e => e.id === episodeId);
                if (epIndex === -1) return prevProjects;

                newProj.episodes[epIndex].frames = newProj.episodes[epIndex].frames.map(f =>
                  f.id === frameId ? {
                    ...f,
                    isGenerating: true,
                    imageProgress: progress,
                    imageError: undefined
                  } : f
                );
                newProjects[projIndex] = newProj;
                return newProjects;
              });
            },
            model
          );
        } else if (isVolcengineModel) {
          // 使用火山引擎服务
          imageUrl = await generateImageWithVolcengine(
            `${prefix}\n\n${prompt}`,
            aspectRatio,
            referenceImages,
            '2K',
            (progress) => {
              // 更新进度
              setProjects(prevProjects => {
                const newProjects = [...prevProjects];
                const projIndex = newProjects.findIndex(p => p.id === projectId);
                if (projIndex === -1) return prevProjects;

                const newProj = { ...newProjects[projIndex] };
                const epIndex = newProj.episodes.findIndex(e => e.id === episodeId);
                if (epIndex === -1) return prevProjects;

                newProj.episodes[epIndex].frames = newProj.episodes[epIndex].frames.map(f =>
                  f.id === frameId ? {
                    ...f,
                    isGenerating: true,
                    imageProgress: progress,
                    imageError: undefined
                  } : f
                );
                newProjects[projIndex] = newProj;
                return newProjects;
              });
            },
            model
          );
        } else if (isBltcyModel) {
          // 使用柏拉图 One-API banana2 (2K)
          imageUrl = await generateImageWithBltcyBanana2(
            `${prefix}\n\n${prompt}`,
            aspectRatio,
            referenceImages,
            projectId,
            (progress) => {
              setProjects(prevProjects => {
                const newProjects = [...prevProjects];
                const projIndex = newProjects.findIndex(p => p.id === projectId);
                if (projIndex === -1) return prevProjects;

                const newProj = { ...newProjects[projIndex] };
                const epIndex = newProj.episodes.findIndex(e => e.id === episodeId);
                if (epIndex === -1) return prevProjects;

                newProj.episodes[epIndex].frames = newProj.episodes[epIndex].frames.map(f =>
                  f.id === frameId ? {
                    ...f,
                    isGenerating: true,
                    imageProgress: progress,
                    imageError: undefined
                  } : f
                );
                newProjects[projIndex] = newProj;
                return newProjects;
              });
            }
          );
        } else if (isBltcyNanoBananaHd) {
          // 使用柏拉图中转 nano banana (HD)
          imageUrl = await generateImageWithBltcyNanoBananaHd(
            `${prefix}\n\n${prompt}`,
            aspectRatio,
            referenceImages,
            projectId,
            (progress) => {
              setProjects(prevProjects => {
                const newProjects = [...prevProjects];
                const projIndex = newProjects.findIndex(p => p.id === projectId);
                if (projIndex === -1) return prevProjects;

                const newProj = { ...newProjects[projIndex] };
                const epIndex = newProj.episodes.findIndex(e => e.id === episodeId);
                if (epIndex === -1) return prevProjects;

                newProj.episodes[epIndex].frames = newProj.episodes[epIndex].frames.map(f =>
                  f.id === frameId ? {
                    ...f,
                    isGenerating: true,
                    imageProgress: progress,
                    imageError: undefined
                  } : f
                );
                newProjects[projIndex] = newProj;
                return newProjects;
              });
            }
          );
        } else if (isBltcyNanoBananaProModel(model)) {
          // 使用柏拉图中转 nano banana pro
          imageUrl = await generateImageWithBltcyNanoBananaPro(
            `${prefix}\n\n${prompt}`,
            aspectRatio,
            referenceImages,
            projectId,
            (progress) => {
              setProjects(prevProjects => {
                const newProjects = [...prevProjects];
                const projIndex = newProjects.findIndex(p => p.id === projectId);
                if (projIndex === -1) return prevProjects;

                const newProj = { ...newProjects[projIndex] };
                const epIndex = newProj.episodes.findIndex(e => e.id === episodeId);
                if (epIndex === -1) return prevProjects;

                newProj.episodes[epIndex].frames = newProj.episodes[epIndex].frames.map(f =>
                  f.id === frameId ? {
                    ...f,
                    isGenerating: true,
                    imageProgress: progress,
                    imageError: undefined
                  } : f
                );
                newProjects[projIndex] = newProj;
                return newProjects;
              });
            }
          );
        } else {
          // 使用Gemini服务
          imageUrl = await generateImageAsset(prompt, aspectRatio, model, referenceImages, prefix);
        }

        // 上传图片到服务端，避免 Base64 内嵌导致项目 JSON 过大
        imageUrl = await uploadImageIfBase64(imageUrl, `frame_${episodeId}_${frameId}_${Date.now()}`);

        // 完成更新
        setProjects(prevProjects => {
          const newProjects = [...prevProjects];
          const projIndex = newProjects.findIndex(p => p.id === projectId);
          if (projIndex === -1) return prevProjects;

          const newProj = { ...newProjects[projIndex] };
          const epIndex = newProj.episodes.findIndex(e => e.id === episodeId);
          if (epIndex === -1) return prevProjects;

          newProj.episodes[epIndex].frames = newProj.episodes[epIndex].frames.map(f =>
            f.id === frameId ? {
              ...f,
              imageUrl,
              isGenerating: false,
              imageProgress: undefined,
              imageError: undefined
            } : f
          );
          newProj.episodes[epIndex] = {
            ...newProj.episodes[epIndex],
            updatedAt: Date.now()
          };
          newProj.updatedAt = Date.now();
          newProjects[projIndex] = newProj;
          return newProjects;
        });
      },
      onError: (error: string) => {
        // 错误更新
        setProjects(prevProjects => {
          const newProjects = [...prevProjects];
          const projIndex = newProjects.findIndex(p => p.id === projectId);
          if (projIndex === -1) return prevProjects;

          const newProj = { ...newProjects[projIndex] };
          const epIndex = newProj.episodes.findIndex(e => e.id === episodeId);
          if (epIndex === -1) return prevProjects;

          newProj.episodes[epIndex].frames = newProj.episodes[epIndex].frames.map(f =>
            f.id === frameId ? {
              ...f,
              isGenerating: false,
              imageProgress: undefined,
              imageError: error
            } : f
          );
          newProj.updatedAt = Date.now();
          newProjects[projIndex] = newProj;
          return newProjects;
        });

        // 内容政策违规：自动改写提示词并重试一次（无需用户确认）
        try {
          if (!isPolicyViolationError(error)) return;

          const retryKey = `${projectId}:${episodeId}:${frameId}`;
          if (autoRewriteRetryRef.current.has(retryKey)) return;
          autoRewriteRetryRef.current.add(retryKey);

          const currentFrame = currentEpisode?.frames.find(f => f.id === frameId);
          const originalPrompt = (prompt ?? '').trim() || (currentFrame?.imagePrompt ?? '').trim();
          if (!originalPrompt) return;

          (async () => {
            try {
              // 使用豆包模型改写违规提示词
              const rewriteModel = globalSettings.extractionModel || 'doubao-seed-2-0-pro-260215';
              const { rewrittenPrompt, notes } = await rewriteImagePromptForPolicyCompliance(originalPrompt, error, rewriteModel);
              const cleaned = (rewrittenPrompt ?? '').trim();
              if (!cleaned || cleaned === originalPrompt) return;

              console.log('[MODERATION] auto-rewrite retry', { frameId, model: rewriteModel, notes });

              // 轻量 PATCH 保存：只更新文本字段，不发送整个项目（避免 request entity too large）
              try {
                await apiService.updateFrameTextFields(projectId, episodeId, frameId, { imagePrompt: cleaned });
              } catch (saveErr) {
                console.warn('[MODERATION] 轻量保存失败，将依赖分集自动保存', saveErr);
              }

              // 更新 React 状态（UI 显示新提示词）
              setProjects(prev => prev.map(p => {
                if (p.id !== projectId) return p;
                return {
                  ...p,
                  episodes: p.episodes.map(ep => {
                    if (ep.id !== episodeId) return ep;
                    return {
                      ...ep,
                      frames: ep.frames.map(f => f.id !== frameId ? f : { ...f, imagePrompt: cleaned })
                    };
                  })
                };
              }));

              handleGenerateFrameImage(frameId, cleaned);
            } catch (e) {
              console.error('[MODERATION] auto-rewrite error', e);
            }
          })();
        } catch (e) {
          console.error('[MODERATION] policy-check error', e);
        }
      }
    };

    // 加入队列
    taskQueue.enqueue(task);
  };

  const handleGenerateFrameVideo = (frameId: string) => {
    if (!currentProject || !currentEpisode) return;
    enqueueFrameVideoGeneration(currentProject, currentEpisode, frameId);
  };

  const handleCancelFrameVideo = async (frameId: string) => {
    if (!currentProject || !currentEpisode) return;

    const frame = currentEpisode.frames.find(f => f.id === frameId);
    if (!frame) return;

    console.log(`[取消视频] 项目: ${currentProject.name} | 分集: ${currentEpisode.name} | 分镜 #${frame.index + 1}`);

    const cancelled = taskQueue.cancelByTarget(frameId);

    persistFrameVideoState(currentProject.id, currentEpisode.id, frameId, f => ({
      ...f,
      isGeneratingVideo: false,
      videoTaskStatus: undefined,
      videoQueuePosition: undefined,
      videoProgress: undefined,
      videoError: undefined,
    }));

    try {
      const response = await fetch(`${apiService.SEEDANCE_API_URL}/api/tasks/by-frame`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: currentProject.id,
          episodeId: currentEpisode.id,
          frameId,
        }),
      });
      const data = await response.json().catch(() => ({}));
      console.log(`[取消视频] 后端按分镜取消完成: cancelled=${data.cancelledCount ?? 0}`);
    } catch (err) {
      console.warn(`[取消视频] 后端按分镜取消失败:`, err);
    }

    console.log(`[取消视频] 队列取消=${cancelled}`);
  };

  const handleRefetchVideoResult = async (frameId: string) => {
    if (!currentProject || !currentEpisode) return;
    const frame = currentEpisode.frames.find(f => f.id === frameId);
    if (!frame) return;

    try {
      let videoUrl: string;

      if (frame.seedanceTaskId) {
        // 有任务ID：重新轮询获取最新URL
        persistFrameVideoState(currentProject.id, currentEpisode.id, frameId, frame => ({
          ...frame,
          isGeneratingVideo: true,
          videoTaskStatus: 'loading',
          videoQueuePosition: undefined,
          videoProgress: frame.videoProgress ?? 0,
          videoError: undefined,
          seedanceTaskUpdatedAt: Date.now(),
        }));

        videoUrl = await pollJimengSeedanceTask(frame.seedanceTaskId, (progress) => {
          persistFrameVideoState(currentProject.id, currentEpisode.id, frameId, f => ({
            ...f,
            isGeneratingVideo: true,
            videoTaskStatus: 'loading',
            videoQueuePosition: undefined,
            videoProgress: progress,
            videoError: undefined,
            seedanceTaskUpdatedAt: Date.now(),
          }));
        });

        if (!videoUrl.startsWith('/api/media/')) {
          const savedVideo = await apiService.saveExternalVideo(videoUrl, `${currentProject.id}_${currentEpisode.id}_${frameId}_video`);
          videoUrl = savedVideo.url;
        }
        videoUrl = apiService.toAbsoluteApiUrl(videoUrl);

        await commitFrameVideoSuccess(currentProject.id, currentEpisode.id, frameId, videoUrl, frame.videoDuration, frame.seedanceTaskId ? `jimeng:${frame.seedanceTaskId}` : undefined);
      } else if (frame.videoUrl && (frame.videoUrl.includes('jimeng.com') || frame.videoUrl.includes('vlabvod.com'))) {
        // 无任务ID但有即梦URL：通过后端代理保存
        const savedVideo = await apiService.saveExternalVideo(frame.videoUrl, `${currentProject.id}_${currentEpisode.id}_${frameId}_video`);
        videoUrl = apiService.toAbsoluteApiUrl(savedVideo.url);

        persistFrameVideoState(currentProject.id, currentEpisode.id, frameId, f => ({
          ...f,
          videoUrl,
        }));

        alert('视频已通过代理保存，请关闭弹窗重新打开查看');
      } else {
        alert('该分镜无法重新获取：既没有任务ID，也不是即梦视频');
      }
    } catch (error) {
      console.error('重新获取视频失败:', error);
      alert(`重新获取失败: ${error instanceof Error ? error.message : String(error)}`);
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
        const dialogues = getFrameDialogues(frame);

        if (!dialogues || dialogues.length === 0) {
             throw new Error("No dialogues found for TTS");
        }

        const narrator = currentProject.characters.find(c => c.name === '旁白');
        if (!narrator || !narrator.voiceId) {
          throw new Error("未找到名为「旁白」且已设置 MiniMax 音色的角色资产。请先新建旁白角色并选择音色。");
        }

        const { url: audioUrl, durationSeconds } = await generateFrameAudioWithMinimax({
          projectId: currentProject.id,
          episodeId: currentEpisodeId || currentEpisode.id,
          frameId,
          dialogues,
          characters: currentProject.characters,
          pauseMs: 100,
          speed: globalSettings.ttsSpeed ?? 1.0
        });

        setProjects(prev => prev.map(p => {
            if (p.id !== currentProject.id) return p;
            return {
                ...p,
                updatedAt: Date.now(),
                episodes: p.episodes.map(e => {
                    if (e.id !== currentEpisodeId) return e;
                    return {
                        ...e,
                        frames: e.frames.map(f => f.id === frameId ? { ...f, audioUrl, isGeneratingAudio: false, audioDuration: durationSeconds ?? undefined } : f)
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
                updatedAt: Date.now(),
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

  const handleExportToJianying = async () => {
    if (!currentProject || !currentEpisode) {
      alert('请先选择一个项目和剧集');
      return;
    }

    if (!globalSettings.jianyingExportPath) {
      alert('请先在全局设置中配置剪映工程导出目录');
      handleOpenGlobalSettingsModal();
      return;
    }

    try {
      setIsExporting(true);
      setExportProgress(0);
      setExportMessage('准备导出...');

      await exportToJianying(
        currentEpisode,
        currentProject.name,
        currentProject.settings,
        globalSettings,
        (current, total, message) => {
          setExportProgress(current);
          setExportMessage(message);
        }
      );

      alert('剪映工程导出成功！');
    } catch (error) {
      console.error('导出失败:', error);
      alert('导出失败：' + (error as Error).message);
    } finally {
      setIsExporting(false);
      setExportProgress(0);
      setExportMessage('');
    }
  };

  const handleExportStoryboardZip = async () => {
    if (!currentProject || !currentEpisode) {
      alert('请先选择一个项目和剧集');
      return;
    }

    if (!currentEpisode.frames.length) {
      alert('当前分集没有分镜内容');
      return;
    }

    try {
      setIsExportingStoryboardZip(true);
      setStoryboardZipMessage('正在生成 ZIP...');

      const result = await apiService.exportEpisodeStoryboardImagesZip(currentProject.id, currentEpisode.id);
      const downloadUrl = `${result.downloadUrl}?filename=${encodeURIComponent(result.filename)}`;
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setStoryboardZipMessage(`已导出 ${result.exportedCount} 张，跳过 ${result.skippedCount} 张`);
    } catch (error) {
      console.error('导出分镜图 ZIP 失败:', error);
      alert('导出分镜图 ZIP 失败：' + (error as Error).message);
      setStoryboardZipMessage('');
    } finally {
      setIsExportingStoryboardZip(false);
    }
  };

  const handleExportAssetZip = async () => {
    if (!currentProject) {
      alert('请先选择一个项目');
      return;
    }

    if (!hasAnyAssetImages) {
      alert('当前项目没有可导出的资产图');
      return;
    }

    try {
      setIsExportingAssetZip(true);
      setAssetZipMessage('正在生成 ZIP...');

      const result = await apiService.exportProjectAssetImagesZip(currentProject.id);
      const downloadUrl = `${result.downloadUrl}?filename=${encodeURIComponent(result.filename)}`;
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setAssetZipMessage(`已导出 ${result.exportedCount} 张，跳过 ${result.skippedCount} 张`);
    } catch (error) {
      console.error('导出资产图 ZIP 失败:', error);
      alert('导出资产图 ZIP 失败：' + (error as Error).message);
      setAssetZipMessage('');
    } finally {
      setIsExportingAssetZip(false);
    }
  };


  // --- Views ---

  // Task Progress Bar (shown across all views)
  const taskProgressBar = activeFrameTasks.size > 0 && (
    <div className="fixed top-0 left-0 right-0 bg-blue-900/95 backdrop-blur-sm border-b border-blue-700 z-50 px-4 py-2">
      <div className="flex items-center gap-4 overflow-x-auto">
        <span className="text-sm font-medium text-blue-200 whitespace-nowrap">正在生成 ({activeFrameTasks.size}):</span>
        {Array.from(activeFrameTasks.values()).map(task => {
          const project = projects.find(p => p.id === task.projectId);
          const episode = project?.episodes.find(e => e.id === task.episodeId);
          const frameIndex = episode?.frames.findIndex(f => f.id === task.frameId);
          return (
            <div key={`${task.projectId}:${task.episodeId}:${task.frameId}`} className="flex items-center gap-2 bg-blue-800/50 px-3 py-1 rounded text-xs whitespace-nowrap">
              <Loader2 size={12} className="animate-spin text-blue-300" />
              <span className="text-blue-100">
                {project?.name || '未知项目'} / {episode?.name || '未知分集'} / 分镜#{(frameIndex ?? -1) + 1}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );

  // 1. Project List View
  if (viewMode === ViewMode.PROJECT_LIST) {
    return (
      <>
        {taskProgressBar}
        <div className={`min-h-screen bg-gray-900 text-white p-8 relative ${activeFrameTasks.size > 0 ? 'pt-20' : ''}`}>
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
                  onClick={handleImportProject}
                  className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-4 py-3 rounded-lg flex items-center gap-2 font-medium transition-all border border-gray-700"
                  title="导入项目"
                >
                  <Download size={20} /> <span className="hidden sm:inline">导入</span>
                </button>
                <button
                  onClick={handleOpenRecycleBin}
                  className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-4 py-3 rounded-lg flex items-center gap-2 font-medium transition-all border border-gray-700"
                  title="回收站"
                >
                  <Trash2 size={20} /> <span className="hidden sm:inline">回收站</span>
                </button>
                <button
                  onClick={handleOpenGlobalSettingsModal}
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
                onClick={() => handleOpenProject(project.id)}
                className="bg-gray-800 border border-gray-700 rounded-xl p-6 hover:border-blue-500/50 hover:bg-gray-750 transition-all cursor-pointer group flex flex-col h-64"
              >
                <div className="flex-1 bg-gray-900 rounded-lg mb-4 flex items-center justify-center overflow-hidden border border-gray-800 relative">
                  {project.thumbnailUrl ? (
                    <img src={project.thumbnailUrl} alt={project.name} className="w-full h-full object-cover" />
                  ) : (
                    <ImageIcon className="text-gray-700 w-12 h-12 group-hover:text-blue-500 transition-colors" />
                  )}

                  {isOpeningProject && openingProjectId === project.id && (
                    <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-2">
                      <Loader2 className="animate-spin text-blue-500 w-6 h-6" />
                      <span className="text-xs text-blue-200 font-medium">正在加载最新版本...</span>
                    </div>
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
                        <span className="text-xs bg-gray-700 px-2 py-0.5 rounded text-gray-300 w-fit mb-1">{getProjectTypeLabel(project.type, globalSettings.projectTypeLabels)}</span>
                        <p className="text-sm text-gray-500">编辑于: {new Date(project.updatedAt).toLocaleDateString()}</p>
                     </div>
                     <div className="flex items-center gap-2 text-xs text-gray-400">
                        <Users size={12}/> {project.characters.length}
                        <button
                          onClick={(e) => handleRenameProject(e, project.id)}
                          className="p-1 rounded bg-black/40 text-gray-400 hover:text-emerald-400 hover:bg-gray-800 transition-colors"
                          title="重命名项目"
                        >
                          <Edit2 size={12} />
                        </button>
                        <button
                          onClick={(e) => handleDuplicateProject(e, project.id)}
                          className="p-1 rounded bg-black/40 text-gray-400 hover:text-blue-400 hover:bg-gray-800 transition-colors"
                          title="复制项目"
                        >
                          <Copy size={12} />
                        </button>
                        <button
                          onClick={(e) => handleDeleteProject(e, project.id)}
                          className="p-1 rounded bg-black/40 text-gray-400 hover:text-red-400 hover:bg-gray-800 transition-colors"
                          title="删除项目"
                        >
                          <Trash2 size={12} />
                        </button>
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
                defaultProjectType={currentProject?.type}
                onSave={async (s) => {
                  try {
                    await apiService.updateSettings(s);
                    setGlobalSettings(s);
                    savedGlobalSettingsRef.current = JSON.stringify(s);
                    console.log('💾 全局设置已保存', {
                      extractionModel: s.extractionModel,
                      projectTypes: Object.keys(s.projectTypePrompts)
                    });
                  } catch (error) {
                    console.error('❌ 全局设置保存失败:', error);
                    alert('全局设置保存失败：' + (error as Error).message);
                  }
                }}
                onClose={() => setShowGlobalSettingsModal(false)}
            />
        )}

        {showRecycleBinModal && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
            <div className="bg-gray-800 rounded-2xl w-full max-w-3xl overflow-hidden border border-gray-700 shadow-2xl flex flex-col max-h-[90vh]">
              <div className="p-5 border-b border-gray-700 flex justify-between items-center">
                <h2 className="text-xl font-bold">回收站</h2>
                <button onClick={() => setShowRecycleBinModal(false)} className="text-gray-400 hover:text-white transition-colors">
                  <X size={24} />
                </button>
              </div>
              <div className="p-6 overflow-y-auto flex-1">
                {isRecycleBinLoading ? (
                  <div className="text-gray-400 text-sm">加载中...</div>
                ) : recycleBinProjects.length === 0 ? (
                  <div className="text-center py-16 text-gray-500">
                    <div className="text-lg mb-2">回收站为空</div>
                    <div className="text-sm opacity-70">删除的项目会出现在这里</div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {recycleBinProjects.map((project) => (
                      <div key={project.id} className="bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 flex items-center justify-between">
                        <div className="min-w-0">
                          <div className="text-white font-medium truncate">{project.name}</div>
                          <div className="text-xs text-gray-500 mt-1 flex items-center gap-2">
                            <span className="bg-gray-700 px-2 py-0.5 rounded">{getProjectTypeLabel(project.type, globalSettings.projectTypeLabels)}</span>
                            <span>删除时间: {project.deletedAt ? new Date(project.deletedAt).toLocaleString() : '-'}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleRestoreProject(project.id)}
                            className="px-3 py-1.5 rounded bg-green-600/20 text-green-300 hover:bg-green-600/40 text-xs font-medium flex items-center gap-1"
                          >
                            <RefreshCw size={12} /> 恢复
                          </button>
                          <button
                            onClick={() => handlePermanentDelete(project.id)}
                            className="px-3 py-1.5 rounded bg-red-600/20 text-red-300 hover:bg-red-600/40 text-xs font-medium flex items-center gap-1"
                          >
                            <Trash2 size={12} /> 永久删除
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
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
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                               {Object.keys(globalSettings.projectTypePrompts).map(type => (
                                 <button
                                   key={type}
                                   onClick={() => setNewProjectData({...newProjectData, type})}
                                   className={`p-2 rounded-lg border text-xs font-bold transition-all text-center ${
                                     newProjectData.type === type 
                                     ? 'bg-blue-600 text-white border-blue-500 shadow-lg shadow-blue-900/50' 
                                     : 'bg-gray-700 border-transparent text-gray-400 hover:bg-gray-600'
                                   }`}
                                 >
                                              {getProjectTypeLabel(type, globalSettings.projectTypeLabels)}
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
                              <label className="block text-xs font-medium text-gray-500 mb-1 uppercase">资产图像模型</label>
                              <select
                                value={newProjectData.settings.imageModel}
                                onChange={e => setNewProjectData({...newProjectData, settings: {...newProjectData.settings, imageModel: e.target.value}})}
                                className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white text-sm"
                              >
                                <option value="nano-banana-pro-vt">grsai中转_香蕉pro (推荐)</option>
                                <option value="bltcy-banana-2">柏拉图中转_banana2 (2K)</option>
                                <option value="bltcy-nano-banana-hd">柏拉图中转_nano banana (HD)</option>
            <option value="bltcy-nano-banana-pro">柏拉图中转_nano banana pro</option>
                                <option value="doubao-seedream-4-5-251128">火山引擎 Seedream 4.5</option>
                                <option value="gemini-2.5-flash-image">Gemini 2.5 Flash Image</option>
                                <option value="gemini-3-pro-image-preview">Gemini 3 Pro Image (高质量)</option>
                              </select>
                              <p className="text-xs text-gray-600 mt-0.5">角色/场景/变体生图</p>
                            </div>
                         </div>

                         <div className="mb-4">
                            <div>
                              <label className="block text-xs font-medium text-gray-500 mb-1 uppercase">分镜图像模型</label>
                              <select
                                value={newProjectData.settings.storyboardImageModel ?? newProjectData.settings.imageModel}
                                onChange={e => setNewProjectData({...newProjectData, settings: {...newProjectData.settings, storyboardImageModel: e.target.value}})}
                                className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white text-sm"
                              >
                                <option value="nano-banana-pro-vt">grsai中转_香蕉pro (推荐)</option>
                                <option value="bltcy-banana-2">柏拉图中转_banana2 (2K)</option>
                                <option value="bltcy-nano-banana-hd">柏拉图中转_nano banana (HD)</option>
            <option value="bltcy-nano-banana-pro">柏拉图中转_nano banana pro</option>
                                <option value="doubao-seedream-4-5-251128">火山引擎 Seedream 4.5</option>
                                <option value="gemini-2.5-flash-image">Gemini 2.5 Flash Image</option>
                                <option value="gemini-3-pro-image-preview">Gemini 3 Pro Image (高质量)</option>
                              </select>
                              <p className="text-xs text-gray-600 mt-0.5">分镜帧生图</p>
                            </div>
                         </div>
                         
                         <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                              <label className="block text-xs font-medium text-gray-500 mb-1 uppercase">视频模型</label>
                              <select
                                value={newProjectData.settings.videoModel}
                                onChange={e => setNewProjectData({...newProjectData, settings: {...newProjectData.settings, videoModel: e.target.value}})}
                                className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white text-sm"
                              >
                                <option value="doubao-seedance-1-5-pro-251215">豆包 Seedance 1.5 Pro (推荐)</option>
                                <option value="kling-v3-omni">可灵 Kling v3 Omni</option>
                                <option value="jimeng-seedance-2.0">即梦 Seedance 2.0 Pro (直连)</option>
                                <option value="jimeng-seedance-2.0-fast">即梦 Seedance 2.0 Fast (直连)</option>
                                <option value="seedance-2.0-fast">速推 Seedance 2.0 (测试用)</option>
                                <option value="sora-2.0">速推 Sora 2.0</option>
                                <option value="bltcy-sora-2">柏拉图中转 Sora 2</option>
                                <option value="bltcy-veo3">柏拉图中转 Veo 3.1</option>
            <option value="bltcy-wan-2-6">柏拉图中转 Wan 2.6</option>
                                <option value="bltcy-grok-video-3">柏拉图中转 grok-video-3</option>
                                <option value="veo-3.1-fast-generate-preview">Veo 3.1 Fast</option>
                                <option value="veo-3.1-generate-preview">Veo 3.1 High Quality</option>
                              </select>
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-500 mb-1 uppercase">视频时长（秒）</label>
                              <input
                                type="number"
                                min="2"
                                max="12"
                                value={newProjectData.settings.videoDuration}
                                onChange={e => setNewProjectData({...newProjectData, settings: {...newProjectData.settings, videoDuration: parseInt(e.target.value) || 5}})}
                                className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white text-sm"
                              />
                            </div>
                         </div>

                         <div>
                            <div>
                              <label className="block text-xs font-medium text-gray-500 mb-1 uppercase">语音模型 (TTS)</label>
                              <select
                                value={newProjectData.settings.ttsModel}
                                onChange={e => setNewProjectData({...newProjectData, settings: {...newProjectData.settings, ttsModel: e.target.value}})}
                                className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white text-sm"
                              >
                                <option value="minimax-speech-2.6-hd">MiniMax speech-2.6-hd</option>
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
      </>
    );
  }

  // 2. Project Detail (Episode List) View
  if (viewMode === ViewMode.PROJECT_DETAIL) {
    if (!currentProject) return null;

    return (
      <>
        {taskProgressBar}
        <div className="h-screen h-[100dvh] bg-gray-900 text-white flex flex-col overflow-hidden">
        {/* Header */}
        <header className={`h-16 bg-gray-950 border-b border-gray-800 flex items-center justify-between px-6 shrink-0 ${activeFrameTasks.size > 0 ? 'mt-14' : ''}`}>
           <div className="flex items-center gap-4">
              <button 
                onClick={() => { setSelectedEpisodeIds(new Set()); setViewMode(ViewMode.PROJECT_LIST); }}
                className="p-2 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-white transition-colors"
              >
                <ArrowLeft size={20} />
              </button>
              <div>
                <h1 className="text-lg font-bold text-white flex items-center gap-2">
                  {currentProject.name}
                  <span className="px-2 py-0.5 rounded-full bg-gray-800 text-[10px] text-gray-400 border border-gray-700">{getProjectTypeLabel(currentProject.type, globalSettings.projectTypeLabels)}</span>
                </h1>
                <p className="text-xs text-gray-500">项目概览</p>
              </div>
           </div>
           <div className="flex items-center gap-3">
              <button
                onClick={handleExportProject}
                className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors flex items-center gap-2 text-sm"
                title="导出项目"
              >
                 <Download size={18} /> <span className="hidden sm:inline">导出</span>
              </button>
              <button
                onClick={() => handleOpenProjectSettingsModal(currentProject.id)}
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
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-8 max-w-6xl mx-auto w-full pb-10">
           <div className="flex justify-between items-center mb-8">
              <div className="space-y-2">
                <h2 className="text-2xl font-bold flex items-center gap-2">
                  <FileText className="text-purple-500"/> 分集列表
                </h2>
                {failedPreprocessEpisodes.length > 0 && (
                  <div className="text-sm text-amber-300 bg-amber-900/20 border border-amber-700/40 rounded-lg px-3 py-2 inline-flex items-center gap-2">
                    <AlertCircle size={16} />
                    有 {failedPreprocessEpisodes.length} 个分集预处理分段失败，当前展示的是回退原文。
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3">
                {selectedEpisodeIds.size > 0 && (
                  <>
                    <button
                      onClick={() => {
                        if (!currentProject) return;
                        if (selectedEpisodeIds.size === currentProject.episodes.length) {
                          setSelectedEpisodeIds(new Set());
                        } else {
                          setSelectedEpisodeIds(new Set(currentProject.episodes.map(e => e.id)));
                        }
                      }}
                      className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-all"
                    >
                      {currentProject && selectedEpisodeIds.size === currentProject.episodes.length ? '取消全选' : '全选'}
                    </button>
                    <button
                      onClick={handleDeleteSelectedEpisodes}
                      className="bg-red-600 hover:bg-red-500 text-white px-4 py-2.5 rounded-lg flex items-center gap-2 text-sm font-medium transition-all"
                    >
                      <Trash2 size={16} /> 删除 ({selectedEpisodeIds.size})
                    </button>
                    <div className="w-px h-8 bg-gray-700" />
                  </>
                )}
                {failedPreprocessEpisodes.length > 0 && (
                  <button
                    onClick={handleRetryFailedPreprocessEpisodes}
                    disabled={isPreprocessing}
                    className="bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-lg flex items-center gap-2 font-medium transition-all"
                  >
                    {isPreprocessing ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
                    重试失败预处理 ({failedPreprocessEpisodes.length})
                  </button>
                )}
                <button
                  onClick={() => setShowNovelPreprocessModal(true)}
                  className="bg-gray-700 hover:bg-gray-600 text-white px-5 py-2.5 rounded-lg flex items-center gap-2 font-medium transition-all"
                >
                  <FileText size={18} /> 小说预处理
                </button>
                <button
                  onClick={handleOpenEpisodeRecycleBin}
                  className="bg-gray-700 hover:bg-gray-600 text-gray-300 px-5 py-2.5 rounded-lg flex items-center gap-2 font-medium transition-all"
                  title="分集回收站"
                >
                  <Trash2 size={18} /> 回收站
                </button>
                <button
                  onClick={handleCreateEpisode}
                  className="bg-purple-600 hover:bg-purple-500 text-white px-5 py-2.5 rounded-lg flex items-center gap-2 font-medium transition-all"
                >
                  <Plus size={18} /> 新建分集
                </button>
              </div>
           </div>

           <div className="mb-6 bg-gray-800/40 border border-gray-700/80 rounded-2xl p-5 sm:p-6">
             <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
               <div className="space-y-1">
                 <h3 className="text-lg font-semibold text-white">项目统计</h3>
                 <p className="text-sm text-gray-400 leading-relaxed">当前为{projectStatsSummary.phaseLabel}能力，只统计已接入范围，历史数据不回填。</p>
               </div>
               <div className="text-xs text-gray-500 lg:text-right">
                 <div>覆盖范围：{projectStatsSummary.coverageText}</div>
                 <div>启用时间：{projectStatsSummary.activatedAtText}</div>
                 <div>最近更新：{projectStatsSummary.lastUpdatedAtText}</div>
               </div>
             </div>
             <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
               <div className="rounded-xl border border-gray-700 bg-gray-900/60 p-4">
                 <div className="text-xs text-gray-500">文本 Token 总量</div>
                 <div className="mt-2 text-2xl font-semibold text-white">{projectStatsSummary.totalTokens.toLocaleString()}</div>
               </div>
               <div className="rounded-xl border border-gray-700 bg-gray-900/60 p-4">
                 <div className="text-xs text-gray-500">文本请求次数</div>
                 <div className="mt-2 text-2xl font-semibold text-white">{projectStatsSummary.requestCount.toLocaleString()}</div>
               </div>
               <div className="rounded-xl border border-gray-700 bg-gray-900/60 p-4">
                 <div className="text-xs text-gray-500">Seedance 成功视频累计</div>
                 <div className="mt-2 text-2xl font-semibold text-white">{projectStatsSummary.seedanceSuccessCount.toLocaleString()}</div>
               </div>
             </div>
           </div>

           <div className="grid grid-cols-1 gap-4">
              {currentProject.episodes.map((episode, index) => (
                 <div
                   key={episode.id}
                   onClick={() => {
                      if (selectedEpisodeIds.size > 0) {
                        setSelectedEpisodeIds(prev => {
                          const next = new Set(prev);
                          next.has(episode.id) ? next.delete(episode.id) : next.add(episode.id);
                          return next;
                        });
                        return;
                      }
                      setCurrentEpisodeId(episode.id);
                      setViewMode(ViewMode.EPISODE_DETAIL);
                      setActiveTab(ProjectTab.SCRIPT);
                    }}
                   className={`bg-gray-800 border rounded-xl p-5 hover:border-purple-500/50 hover:bg-gray-750 transition-all cursor-pointer group flex items-center justify-between ${selectedEpisodeIds.has(episode.id) ? 'border-purple-500 bg-purple-500/5' : 'border-gray-700'}`}
                 >
                    <div className="flex items-center gap-6">
                       <button
                         onClick={(e) => {
                           e.stopPropagation();
                           setSelectedEpisodeIds(prev => {
                             const next = new Set(prev);
                             next.has(episode.id) ? next.delete(episode.id) : next.add(episode.id);
                             return next;
                           });
                         }}
                         className="flex-shrink-0 text-gray-500 hover:text-purple-400 transition-colors"
                       >
                         {selectedEpisodeIds.has(episode.id) ? <CheckSquare size={20} className="text-purple-400" /> : <Square size={20} />}
                       </button>
                       <div className="w-12 h-12 bg-gray-900 rounded-lg flex items-center justify-center text-gray-600 font-bold text-lg border border-gray-800">
                          {index + 1}
                       </div>
                       <div>
                          <div className="flex items-center gap-2 mb-1">
                             <h3 className="text-lg font-semibold text-white group-hover:text-purple-400 transition-colors">{episode.name}</h3>
                             {episode.preprocessSegmentFailed && (
                               <span className="inline-flex items-center gap-1 rounded-full border border-amber-700/50 bg-amber-900/30 px-2 py-0.5 text-xs text-amber-200">
                                 <AlertCircle size={12} />
                                 预处理失败
                               </span>
                             )}
                          </div>
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
                         onClick={(e) => handleRenameEpisode(e, episode.id)}
                         title="重命名分集"
                         className="p-2 hover:bg-gray-800 text-gray-500 hover:text-white rounded-lg transition-colors"
                      >
                         <Edit2 size={18} />
                      </button>
                       <button
                          onClick={(e) => handleDuplicateEpisode(e, episode.id)}
                          title="复制分集"
                          className="p-2 hover:bg-blue-900/30 text-gray-500 hover:text-blue-400 rounded-lg transition-colors"
                       >
                          <Copy size={18} />
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
        </div>

        {/* 小说预处理 Modal */}
        {showNovelPreprocessModal && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
            <div className="bg-gray-800 rounded-2xl w-full max-w-2xl border border-gray-700 shadow-2xl flex flex-col max-h-[90vh]">
              <div className="p-5 border-b border-gray-700 flex justify-between items-center">
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <FileText size={18} className="text-purple-400" /> 小说预处理
                </h2>
                <button
                  onClick={() => { setShowNovelPreprocessModal(false); setPreprocessNovelText(''); }}
                  className="text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={!!storyboardProgress}
                >
                  <X size={24} />
                </button>
              </div>
              <div className="p-6 flex flex-col gap-4 overflow-y-auto custom-scrollbar flex-1">
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-2">选择番茄小说 txt 文件</label>
                  <label className={`flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${preprocessNovelText ? 'border-purple-500 bg-purple-900/10' : 'border-gray-600 hover:border-gray-500 bg-gray-900'}`}>
                    <div className="flex flex-col items-center gap-2 text-gray-400">
                      <Upload size={24} className={preprocessNovelText ? 'text-purple-400' : ''} />
                      {preprocessNovelText ? (
                        <span className="text-sm text-purple-300">文件已加载，共 {preprocessNovelText.length.toLocaleString()} 字</span>
                      ) : (
                        <span className="text-sm">点击选择 .txt 文件</span>
                      )}
                    </div>
                    <input
                      type="file"
                      accept=".txt"
                      className="hidden"
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = ev => setPreprocessNovelText((ev.target?.result as string) ?? '');
                        reader.readAsText(file, 'UTF-8');
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
                {preprocessNovelText.trim() && (() => {
                  const titles = detectEpisodeTitles(preprocessNovelText);
                  return (
                    <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
                      <p className="text-xs font-medium text-gray-400 mb-2">
                        识别预览：检测到 <span className="text-purple-400 font-bold">{titles.length}</span> 个分集
                      </p>
                      {titles.length > 0 ? (
                        <ul className="space-y-1 max-h-40 overflow-y-auto custom-scrollbar">
                          {titles.map((t, i) => (
                            <li key={i} className="text-sm text-gray-300 flex items-center gap-2">
                              <span className="text-purple-500 text-xs w-6 shrink-0">{i + 1}.</span> {t}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-sm text-yellow-400">未检测到章节序号，请确认文件格式正确</p>
                      )}
                    </div>
                  );
                })()}
                <p className="text-xs text-gray-500">资产提取将使用文本前 30000 字；分集将追加到现有列表。</p>
                {novelPreprocessTaskState && !novelPreprocessTaskState.resultAppliedAt && (
                  <div className="bg-gray-900 rounded-lg p-4 border border-gray-700 space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-300">任务状态</span>
                      <span className={`font-medium ${novelPreprocessTaskState.status === 'completed' ? 'text-green-400' : novelPreprocessTaskState.status === 'failed' || novelPreprocessTaskState.status === 'interrupted' ? 'text-red-400' : 'text-purple-300'}`}>
                        {novelPreprocessTaskState.status === 'pending' ? '等待中' : novelPreprocessTaskState.status === 'running' ? '处理中' : novelPreprocessTaskState.status === 'completed' ? '已完成' : novelPreprocessTaskState.status === 'interrupted' ? '已中断' : '失败'}
                      </span>
                    </div>
                    <div className="text-xs text-gray-400">
                      阶段：{novelPreprocessTaskState.stage === 'connectivity' ? '连通性检测' : novelPreprocessTaskState.stage === 'asset_extraction' ? '资产提取' : novelPreprocessTaskState.stage === 'segmenting' ? '分段处理中' : novelPreprocessTaskState.stage === 'second_pass' ? '二次加工' : novelPreprocessTaskState.stage === 'interrupted' ? '服务重启中断' : novelPreprocessTaskState.stage === 'failed' ? '任务失败' : '处理完成'}
                    </div>
                    <div className="text-xs text-gray-400">
                      进度：{novelPreprocessTaskState.progress.completed}/{novelPreprocessTaskState.progress.total}
                      {novelPreprocessTaskState.progress.currentEpisodeName ? ` · 当前：${novelPreprocessTaskState.progress.currentEpisodeName}` : ''}
                    </div>
                    <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-purple-500 h-2 transition-all duration-300"
                        style={{ width: `${novelPreprocessTaskState.progress.total > 0 ? (novelPreprocessTaskState.progress.completed / novelPreprocessTaskState.progress.total) * 100 : 0}%` }}
                      />
                    </div>
                    {novelPreprocessTaskState.error && (
                      <div className="text-xs text-red-300 whitespace-pre-wrap">{novelPreprocessTaskState.error}</div>
                    )}
                  </div>
                )}
                {(() => {
                  const typePrompts = globalSettings.projectTypePrompts[currentProject?.type ?? 'REAL_PERSON_COMMENTARY'] ?? globalSettings.projectTypePrompts['REAL_PERSON_COMMENTARY'];
                  const hasSecondPassPrompt = !!typePrompts.preprocessSecondPassPrompt?.trim();
                  return (
                    <label className={`flex items-center gap-2 select-none ${hasSecondPassPrompt ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
                      <input
                        type="checkbox"
                        checked={enableSecondPass}
                        onChange={e => setEnableSecondPass(e.target.checked)}
                        disabled={!hasSecondPassPrompt || isPreprocessing}
                        className="accent-teal-500 w-4 h-4"
                      />
                      <span className="text-sm text-gray-300">启用二次加工</span>
                      {!hasSecondPassPrompt && <span className="text-xs text-gray-500">（请先在项目类型指令中配置二次加工提示词）</span>}
                    </label>
                  );
                })()}
                <label className="flex items-center gap-2 select-none cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enableAutoStoryboard}
                    onChange={e => setEnableAutoStoryboard(e.target.checked)}
                    disabled={isPreprocessing || !!storyboardProgress}
                    className="accent-purple-500 w-4 h-4"
                  />
                  <span className="text-sm text-gray-300">一键分镜</span>
                  <span className="text-xs text-gray-500">（预处理完成后自动对成功分集执行分镜拆解）</span>
                </label>
                {storyboardProgress && (
                  <div className="bg-gray-900 rounded-lg p-4 border border-purple-700 space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-300">分镜拆解进度</span>
                      <span className="font-medium text-purple-300">{storyboardProgress.current}/{storyboardProgress.total}</span>
                    </div>
                    <div className="text-xs text-gray-400">当前：{storyboardProgress.currentName}</div>
                    <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-purple-500 h-2 transition-all duration-300"
                        style={{ width: `${(storyboardProgress.current / storyboardProgress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
              <div className="p-5 border-t border-gray-700 flex justify-end gap-3">
                <button
                  onClick={() => { setShowNovelPreprocessModal(false); setPreprocessNovelText(''); }}
                  className="px-5 py-2.5 rounded-lg text-gray-300 hover:bg-gray-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={isPreprocessing || !!storyboardProgress}
                >
                  取消
                </button>
                <button
                  onClick={handleNovelPreprocess}
                  disabled={isPreprocessing || !!storyboardProgress || !preprocessNovelText.trim() || detectEpisodeTitles(preprocessNovelText).length === 0}
                  className="px-6 py-2.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-white font-medium flex items-center gap-2 transition-colors"
                >
                  {isPreprocessing ? <><Loader2 size={16} className="animate-spin" /> 处理中...</> : storyboardProgress ? <><Loader2 size={16} className="animate-spin" /> 分镜拆解中...</> : '开始预处理'}
                </button>
              </div>
            </div>
          </div>
        )}

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

        {showGlobalSettingsModal && (
          <GlobalSettingsModal
            settings={globalSettings}
            defaultProjectType={currentProject?.type}
            onSave={async (s) => {
              try {
                await apiService.updateSettings(s);
                setGlobalSettings(s);
                savedGlobalSettingsRef.current = JSON.stringify(s);
                console.log('💾 全局设置已保存', {
                  extractionModel: s.extractionModel,
                  projectTypes: Object.keys(s.projectTypePrompts)
                });
              } catch (error) {
                console.error('❌ 全局设置保存失败:', error);
                alert('全局设置保存失败：' + (error as Error).message);
              }
            }}
            onClose={() => setShowGlobalSettingsModal(false)}
          />
        )}

        {/* 分集回收站 Modal */}
        {showEpisodeRecycleBinModal && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
            <div className="bg-gray-800 rounded-2xl w-full max-w-3xl overflow-hidden border border-gray-700 shadow-2xl flex flex-col max-h-[90vh]">
              <div className="p-5 border-b border-gray-700 flex justify-between items-center shrink-0">
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <Trash2 size={18} className="text-gray-400" /> 分集回收站
                </h2>
                <button
                  onClick={() => setShowEpisodeRecycleBinModal(false)}
                  className="text-gray-400 hover:text-white transition-colors"
                >
                  <X size={24} />
                </button>
              </div>
              <div className="p-6 overflow-y-auto flex-1">
                {isEpisodeRecycleBinLoading ? (
                  <div className="text-gray-400 text-sm flex items-center gap-2">
                    <Loader2 size={16} className="animate-spin" /> 加载中...
                  </div>
                ) : episodeRecycleBin.length === 0 ? (
                  <div className="text-center py-16 text-gray-500">
                    <div className="text-lg mb-2">回收站为空</div>
                    <div className="text-sm opacity-70">删除的分集会出现在这里</div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {episodeRecycleBin.map((episode) => (
                      <div
                        key={episode.id}
                        className="bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 flex items-center justify-between"
                      >
                        <div className="min-w-0">
                          <div className="text-white font-medium truncate">{episode.name}</div>
                          <div className="text-xs text-gray-500 mt-1 flex items-center gap-3">
                            <span>{episode.scriptContent?.length ?? 0} 字</span>
                            <span>{episode.frames?.length ?? 0} 分镜</span>
                            <span>删除时间: {new Date(episode.deletedAt).toLocaleString()}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-4">
                          <button
                            onClick={() => handleRestoreEpisode(episode.id)}
                            className="px-3 py-1.5 rounded bg-green-600/20 text-green-300 hover:bg-green-600/40 text-xs font-medium flex items-center gap-1 transition-colors"
                          >
                            <RefreshCw size={12} /> 恢复
                          </button>
                          <button
                            onClick={() => handlePermanentDeleteEpisode(episode.id)}
                            className="px-3 py-1.5 rounded bg-red-600/20 text-red-300 hover:bg-red-600/40 text-xs font-medium flex items-center gap-1 transition-colors"
                          >
                            <Trash2 size={12} /> 永久删除
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        </div>
      </>
    );
  }

  // 3. Episode Editor View
  if (viewMode === ViewMode.EPISODE_DETAIL) {
    if (!currentProject || !currentEpisode) return null;

    // 当前分集是否在处理（资产提取/分镜拆解等）
    const isCurrentEpisodeProcessing = currentEpisode.isProcessing ?? false;

    return (
      <>
        {taskProgressBar}
        <Layout
          title={`${currentProject.name} / ${currentEpisode.name}`}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onBack={() => {
             setCurrentEpisodeId(null);
             setViewMode(ViewMode.PROJECT_DETAIL);
          }}
          hasTaskBar={activeFrameTasks.size > 0}
          headerRight={
              <button
                onClick={handleOpenGlobalSettingsModal}
                className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-4 py-2 rounded-md transition flex items-center gap-2 text-sm border border-gray-700"
              >
                <Globe size={16} /> 全局设置
              </button>
          }
        >
          {activeTab === ProjectTab.SCRIPT && (
            <div className="max-w-4xl mx-auto h-full flex flex-col gap-4">
              <div className="bg-gray-800/40 border border-gray-700/80 rounded-2xl p-5 sm:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                  <div className="space-y-1">
                    <h2 className="text-2xl font-bold flex items-center gap-2">
                      <FileText size={20} className="text-blue-400" />
                      剧本导入
                    </h2>
                    <p className="text-gray-400 text-sm leading-relaxed">在此粘贴小说文本，分别执行资产提取和分镜拆解。</p>
                  </div>
                  <div className="flex flex-wrap gap-2 sm:justify-end">
                    <button
                      onClick={handleExtractCharacters}
                      disabled={isCurrentEpisodeProcessing || !currentEpisode.scriptContent}
                      className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2.5 rounded-xl inline-flex items-center gap-2 text-sm font-medium transition-all shadow-sm shadow-blue-900/30"
                    >
                      {isCurrentEpisodeProcessing ? <Loader2 className="animate-spin" /> : <Users size={18} />}
                      提取人物
                    </button>
                    <button
                      onClick={handleExtractScenes}
                      disabled={isCurrentEpisodeProcessing || !currentEpisode.scriptContent}
                      className="bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2.5 rounded-xl inline-flex items-center gap-2 text-sm font-medium transition-all shadow-sm shadow-green-900/30"
                    >
                      {isCurrentEpisodeProcessing ? <Loader2 className="animate-spin" /> : <ImageIcon size={18} />}
                      提取场景
                    </button>
                    <button
                      onClick={handleExtractAssets}
                      disabled={isCurrentEpisodeProcessing || !currentEpisode.scriptContent}
                      className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2.5 rounded-xl inline-flex items-center gap-2 text-sm font-medium transition-all shadow-sm shadow-black/20"
                    >
                      {isCurrentEpisodeProcessing ? <Loader2 className="animate-spin" /> : <Users size={18} />}
                      资产提取
                    </button>
                    <button
                      onClick={handleGenerateStoryboard}
                      disabled={isCurrentEpisodeProcessing || !currentEpisode.scriptContent}
                      className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2.5 rounded-xl inline-flex items-center gap-2 text-sm font-medium transition-all shadow-sm shadow-purple-900/30"
                    >
                      {isCurrentEpisodeProcessing ? <Loader2 className="animate-spin" /> : <Clapperboard size={18} />}
                      分镜拆解
                    </button>
                    <button
                      onClick={() => setShowEpisodePreprocessModal(true)}
                      disabled={isCurrentEpisodeProcessing || !currentEpisode.scriptContent}
                      className="bg-teal-600 hover:bg-teal-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2.5 rounded-xl inline-flex items-center gap-2 text-sm font-medium transition-all shadow-sm shadow-teal-900/30"
                    >
                      <Wand2 size={18} />
                      预处理
                    </button>
                  </div>
                </div>
              </div>
              {currentEpisode.preprocessSegmentFailed && (
                <div className="bg-amber-900/20 border border-amber-700/40 rounded-2xl px-4 py-3 text-sm text-amber-200 flex items-center gap-2">
                  <AlertCircle size={16} className="shrink-0" />
                  当前分集在小说预处理分段时失败，现使用回退原文。返回分集列表可点击“重试失败预处理”。
                </div>
              )}
              <textarea
                className="flex-1 w-full bg-gray-800 border border-gray-700 rounded-2xl p-6 sm:p-7 text-gray-100 focus:outline-none focus:border-purple-500 resize-none font-serif leading-relaxed text-base sm:text-lg shadow-inner"
                placeholder="在此粘贴章节内容..."
                value={currentEpisode.scriptContent}
                onChange={(e) => handleUpdateEpisode(currentProject.id, currentEpisode.id, { scriptContent: e.target.value })}
              />
            </div>
          )}

        {/* ... (ASSETS, STORYBOARD, EXPORT tabs remain unchanged conceptually, but logic for generation updates below) ... */}
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
                      <button onClick={() => handleInvertAssetSelection('character')} className="text-xs text-gray-400 hover:text-white px-2 py-1 bg-gray-800 rounded border border-gray-700">
                          反选
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
                        {char.imageUrl && (
                          <button onClick={() => setPreviewAsset({ type: 'character', id: char.id })} className="p-1.5 bg-black/60 text-gray-300 hover:text-white hover:bg-gray-700 rounded" title="预览图片">
                            <Eye size={14} />
                          </button>
                        )}
                        <button onClick={() => handleUploadAssetImage('character', char.id)} className="p-1.5 bg-black/60 text-gray-300 hover:text-white hover:bg-green-600 rounded" title="上传图片">
                            <Upload size={14} />
                        </button>
                        <button onClick={() => setEditingAsset({type: 'character', id: char.id})} className="p-1.5 bg-black/60 text-gray-300 hover:text-white hover:bg-blue-600 rounded">
                            <Edit2 size={14} />
                        </button>
                        <button onClick={() => handleDeleteAsset('character', char.id)} className="p-1.5 bg-black/60 text-gray-300 hover:text-red-400 hover:bg-gray-800 rounded">
                            <Trash2 size={14} />
                        </button>
                    </div>

                    {char.error && (
                      <div className="absolute top-2 right-12 group/error z-20" onClick={e => e.stopPropagation()}>
                        <AlertCircle className="w-5 h-5 text-red-500 drop-shadow-lg" />
                        <div className="absolute right-0 top-6 w-48 bg-red-900/95 border border-red-700 rounded-lg p-2 text-xs text-red-100 opacity-0 group-hover/error:opacity-100 transition-opacity pointer-events-none shadow-lg">
                          {char.error}
                        </div>
                      </div>
                    )}

                    <div className="aspect-square bg-gray-900 rounded-md overflow-hidden relative group/img">
                      {char.imageUrl ? (
                        <img src={char.imageUrl} alt={char.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-700">无图片</div>
                      )}

                      {/* 进度显示 */}
                      {char.progress !== undefined && char.progress < 100 && (
                        <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-2">
                          <Loader2 className="animate-spin text-blue-500 w-6 h-6" />
                          <span className="text-xs text-blue-300 font-medium">
                            生成中 {Math.round(char.progress)}%
                          </span>
                        </div>
                      )}

                      <button
                        onClick={(e) => {
                            e.stopPropagation();
                            handleGenerateAssetImage('character', char.id, `${char.appearance}, ${char.personality}`);
                        }}
                        disabled={char.progress !== undefined}
                        className="absolute inset-0 bg-black/60 flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity text-white font-medium gap-2 disabled:cursor-not-allowed disabled:opacity-0"
                      >
                        <Wand2 size={16} /> 生成
                      </button>
                    </div>
                    <div>
                      <h3 className="font-bold text-white">{char.name}</h3>
                      <span className="text-xs text-blue-400 bg-blue-400/10 px-2 py-0.5 rounded">{char.role}</span>
                    </div>
                    {char.aliases && char.aliases.length > 0 && (
                      <p className="text-xs text-gray-500 line-clamp-1">{char.aliases.join('、')}</p>
                    )}
                    <p className="text-xs text-gray-400 line-clamp-3">{char.description}</p>
                  </div>
                )})}
              </div>
             </section>

             <div className="w-full h-px bg-gray-800" />

             {/* Variants Section */}
             <section>
              <div className="flex justify-between items-center mb-4">
                  <h2 className="text-xl font-bold flex items-center gap-2">
                    <Clapperboard size={20} className="text-purple-400"/> 变体资产
                    <span className="text-sm font-normal text-gray-500 ml-2">({(currentProject.variants ?? []).length})</span>
                  </h2>
                  <div className="flex items-center gap-2">
                      <button onClick={(currentProject.variants ?? []).length > 0 && selectedVariantIds.length === (currentProject.variants ?? []).length ? handleDeselectAllVariants : handleSelectAllVariants} className="text-xs text-gray-400 hover:text-white px-2 py-1 bg-gray-800 rounded border border-gray-700">
                          {selectedVariantIds.length === (currentProject.variants ?? []).length && (currentProject.variants ?? []).length > 0 ? "取消全选" : "全选"}
                      </button>
                      <button onClick={handleInvertVariantSelection} className="text-xs text-gray-400 hover:text-white px-2 py-1 bg-gray-800 rounded border border-gray-700">
                          反选
                      </button>
                      <button onClick={handleSelectMissingVariantImages} className="text-xs text-gray-400 hover:text-white px-2 py-1 bg-gray-800 rounded border border-gray-700">
                          选中无图
                      </button>
                      {selectedVariantIds.length > 0 && (
                          <>
                            <button onClick={handleBatchGenerateVariants} className="flex items-center gap-1 text-xs bg-purple-600 hover:bg-purple-500 text-white px-2 py-1 rounded">
                                <Wand2 size={12}/> 批量生成
                            </button>
                            <button onClick={handleBatchDeleteVariants} className="flex items-center gap-1 text-xs bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-600/30 px-2 py-1 rounded">
                                <Trash2 size={12}/> 删除选中
                            </button>
                          </>
                      )}
                      <button onClick={() => handleAddVariant()} className="flex items-center gap-1 text-xs bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded">
                          <Plus size={12}/> 新建变体
                      </button>
                  </div>
              </div>
              {(currentProject.variants ?? []).length === 0 && (
                <p className="text-sm text-gray-500 text-center py-8">暂无变体资产。提取角色资产时将自动识别 【词条】 格式的服装变体，也可手动新建。</p>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {(currentProject.variants ?? []).map(variant => {
                  const isSelected = selectedVariantIds.includes(variant.id);
                  const parentChar = currentProject.characters.find(c => c.id === variant.characterId);
                  return (
                  <div key={variant.id}
                    className={`bg-gray-800 border rounded-lg p-4 flex flex-col gap-3 hover:border-gray-600 transition-all relative group ${isSelected ? 'border-purple-500 ring-1 ring-purple-500' : 'border-gray-700'}`}
                    onClick={() => toggleVariantSelection(variant.id)}
                  >
                    <div className="absolute top-2 left-2 z-10" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => toggleVariantSelection(variant.id)}
                          className={`p-1 rounded shadow-sm backdrop-blur-md transition-all ${
                              isSelected ? 'bg-purple-600 text-white' : 'bg-black/50 text-gray-400 hover:text-white'
                          }`}
                        >
                          {isSelected ? <CheckSquare size={16}/> : <Square size={16}/>}
                        </button>
                    </div>

                    <div className="absolute top-2 right-2 z-10 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                        {variant.imageUrl && (
                          <button onClick={() => setPreviewVariant({ id: variant.id })} className="p-1.5 bg-black/60 text-gray-300 hover:text-white hover:bg-gray-700 rounded" title="预览图片">
                            <Eye size={14} />
                          </button>
                        )}
                        <button onClick={() => handleUploadVariantImage(variant.id)} className="p-1.5 bg-black/60 text-gray-300 hover:text-white hover:bg-green-600 rounded" title="上传图片">
                            <Upload size={14} />
                        </button>
                        <button onClick={() => setEditingVariant({ id: variant.id })} className="p-1.5 bg-black/60 text-gray-300 hover:text-white hover:bg-purple-600 rounded">
                            <Edit2 size={14} />
                        </button>
                        <button onClick={() => handleDeleteVariant(variant.id)} className="p-1.5 bg-black/60 text-gray-300 hover:text-red-400 hover:bg-gray-800 rounded">
                            <Trash2 size={14} />
                        </button>
                    </div>

                    {variant.error && (
                      <div className="absolute top-2 right-12 group/error z-20" onClick={e => e.stopPropagation()}>
                        <AlertCircle className="w-5 h-5 text-red-500 drop-shadow-lg" />
                        <div className="absolute right-0 top-6 w-48 bg-red-900/95 border border-red-700 rounded-lg p-2 text-xs text-red-100 opacity-0 group-hover/error:opacity-100 transition-opacity pointer-events-none shadow-lg">
                          {variant.error}
                        </div>
                      </div>
                    )}

                    <div className="aspect-square bg-gray-900 rounded-md overflow-hidden relative group/img">
                      {variant.imageUrl ? (
                        <img src={variant.imageUrl} alt={variant.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-700">无图片</div>
                      )}

                      {variant.progress !== undefined && variant.progress < 100 && (
                        <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-2">
                          <Loader2 className="animate-spin text-purple-500 w-6 h-6" />
                          <span className="text-xs text-purple-300 font-medium">生成中 {Math.round(variant.progress)}%</span>
                        </div>
                      )}

                      <button
                        onClick={(e) => { e.stopPropagation(); handleGenerateVariantImage(variant.id); }}
                        disabled={variant.progress !== undefined}
                        className="absolute inset-0 bg-black/60 flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity text-white font-medium gap-2 disabled:cursor-not-allowed disabled:opacity-0"
                      >
                        <Wand2 size={16} /> 生成
                      </button>
                    </div>
                    <div>
                      <h3 className="font-bold text-white text-sm leading-tight">{variant.name}</h3>
                      {parentChar && (
                        <span className="text-xs text-purple-400 bg-purple-400/10 px-2 py-0.5 rounded mt-1 inline-block">{parentChar.name}</span>
                      )}
                    </div>
                    {variant.context && <p className="text-xs text-gray-500 line-clamp-1">{variant.context}</p>}
                    <p className="text-xs text-gray-400 line-clamp-3">{variant.appearance}</p>
                  </div>
                  );
                })}
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
                      <button onClick={() => handleInvertAssetSelection('scene')} className="text-xs text-gray-400 hover:text-white px-2 py-1 bg-gray-800 rounded border border-gray-700">
                          反选
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
                        {scene.imageUrl && (
                          <button onClick={() => setPreviewAsset({ type: 'scene', id: scene.id })} className="p-1.5 bg-black/60 text-gray-300 hover:text-white hover:bg-gray-700 rounded" title="预览图片">
                            <Eye size={14} />
                          </button>
                        )}
                        <button onClick={() => handleUploadAssetImage('scene', scene.id)} className="p-1.5 bg-black/60 text-gray-300 hover:text-white hover:bg-green-600 rounded" title="上传图片">
                            <Upload size={14} />
                        </button>
                        <button onClick={() => setEditingAsset({type: 'scene', id: scene.id})} className="p-1.5 bg-black/60 text-gray-300 hover:text-white hover:bg-blue-600 rounded">
                            <Edit2 size={14} />
                        </button>
                        <button onClick={() => handleDeleteAsset('scene', scene.id)} className="p-1.5 bg-black/60 text-gray-300 hover:text-red-400 hover:bg-gray-800 rounded">
                            <Trash2 size={14} />
                        </button>
                    </div>

                    {scene.error && (
                      <div className="absolute top-2 right-12 group/error z-20" onClick={e => e.stopPropagation()}>
                        <AlertCircle className="w-4 h-4 text-red-500 drop-shadow-lg" />
                        <div className="absolute right-0 top-5 w-48 bg-red-900/95 border border-red-700 rounded-lg p-2 text-[10px] text-red-100 opacity-0 group-hover/error:opacity-100 transition-opacity pointer-events-none shadow-lg">
                          {scene.error}
                        </div>
                      </div>
                    )}

                    <div className="w-24 h-24 bg-gray-900 rounded-md overflow-hidden shrink-0 relative group/img">
                       {scene.imageUrl ? (
                        <img src={scene.imageUrl} alt={scene.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-700">无图片</div>
                      )}

                      {/* 进度显示 - 更小的尺寸 */}
                      {scene.progress !== undefined && scene.progress < 100 && (
                        <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-1">
                          <Loader2 className="animate-spin text-green-500 w-4 h-4" />
                          <span className="text-[10px] text-green-300 font-medium">
                            {Math.round(scene.progress)}%
                          </span>
                        </div>
                      )}

                       <button
                        onClick={(e) => {
                            e.stopPropagation();
                            handleGenerateAssetImage('scene', scene.id, scene.environment);
                        }}
                        disabled={scene.progress !== undefined}
                        className="absolute inset-0 bg-black/60 flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity text-white disabled:cursor-not-allowed disabled:opacity-0"
                      >
                        <Wand2 size={16} /> 生成
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
          <div className="flex flex-col h-full min-h-0 overflow-hidden">
             {/* Storyboard Header & Toolbar */}
             <header className="mb-4 shrink-0 bg-gray-800/50 p-3 rounded-xl border border-gray-800 backdrop-blur-sm">
                <div className="flex flex-col gap-3">
                    {/* Top Row: Title & View Switch */}
                    <div className="flex justify-between items-center">
                        <div className="flex items-center gap-3">
                            <h2 className="text-xl font-bold flex items-center gap-2">
                                <Film size={20} className="text-blue-500"/>
                                分镜管理
                                <span className="text-sm font-normal text-gray-400 bg-gray-800 px-2 py-0.5 rounded-full border border-gray-700">
                                    {currentEpisode.frames.length} 个镜头
                                </span>
                            </h2>
                            {/* 多参考生成开关 */}
                            <button
                                onClick={() => handleUpdateProject(currentProject.id, { settings: { ...currentProject.settings, multiRefVideoMode: !currentProject.settings.multiRefVideoMode } })}
                                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${
                                    currentProject.settings.multiRefVideoMode
                                    ? 'bg-purple-600/20 border-purple-500 text-purple-300'
                                    : 'bg-gray-800 border-gray-600 text-gray-400 hover:border-gray-500'
                                }`}
                                title="开启后，生成视频时使用分镜关联的资产参考图，而非分镜图"
                            >
                                <Users size={12} />
                                多参考生成 {currentProject.settings.multiRefVideoMode ? '开' : '关'}
                            </button>
                            {/* 用视频提示词生图开关 */}
                            <button
                                onClick={() => setUseVideoPromptForImage(v => !v)}
                                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${
                                    useVideoPromptForImage
                                    ? 'bg-amber-600/20 border-amber-500 text-amber-300'
                                    : 'bg-gray-800 border-gray-600 text-gray-400 hover:border-gray-500'
                                }`}
                                title="开启后，生图时使用视频提示词而非生图提示词（前缀不变）"
                            >
                                <Film size={12} />
                                视频词生图 {useVideoPromptForImage ? '开' : '关'}
                            </button>
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

                            <button onClick={handleInvertFrameSelection} className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-700">
                                反选
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
                             <div className="w-px h-4 bg-gray-700 mx-1"></div>
                             <button
                                 onClick={() => setShowFindReplace(true)}
                                 className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded font-medium"
                             >
                                 <Search size={14}/> 查找替换
                             </button>
                        </div>
                    </div>
                </div>
             </header>

             {/* GRID VIEW */}
             {storyboardViewMode === 'GRID' && (
               <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-6 overflow-y-auto pb-8 pr-4 custom-scrollbar" style={{ scrollbarGutter: 'stable' }}>
                 {currentEpisode.frames.map((frame, index) => {
                   const isSelected = selectedFrameIds.includes(frame.id);
                   const isDragging = draggedFrameIndex === index;

                   return (
                   <div
                        key={frame.id}
                        className={`bg-gray-800 border rounded-xl overflow-hidden flex flex-col group relative transition-all duration-200 min-h-[400px] ${
                            isSelected ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-700 hover:border-gray-500'
                        } ${isDragging ? 'opacity-50' : 'opacity-100'}`}
                        style={isDragging ? { transform: 'scale(0.98)' } : undefined}
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
                        {frame.videoUrl && !frame.isGeneratingVideo && (
                          <button
                              onClick={() => {
                                setPreviewFrameMode('video');
                                setPreviewFrameId(frame.id);
                              }}
                              className="p-1.5 bg-black/60 text-gray-300 hover:text-white hover:bg-purple-600 rounded backdrop-blur-md transition-colors"
                              title="播放视频"
                          >
                              <Play size={14} className="ml-0.5" />
                          </button>
                        )}
                        {(frame.imageUrl || frame.videoUrl) && (
                          <button
                              onClick={() => {
                                setPreviewFrameMode('image');
                                setPreviewFrameId(frame.id);
                              }}
                              className="p-1.5 bg-black/60 text-gray-300 hover:text-white hover:bg-gray-700 rounded backdrop-blur-md transition-colors"
                              title="预览分镜"
                          >
                              <Eye size={14} />
                          </button>
                        )}
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
                     <div className="aspect-video bg-gray-950 relative group/image" style={{ minHeight: '200px' }}>
                       {frame.imageUrl ? (
                         <img src={frame.imageUrl} alt="Storyboard" className="w-full h-full object-cover pointer-events-none" width="640" height="360" loading="lazy" />
                       ) : frame.videoUrl ? (
                         <video
                           src={frame.videoUrl}
                           className="w-full h-full object-cover pointer-events-none"
                           muted
                           preload="metadata"
                           onLoadedMetadata={(e) => { (e.target as HTMLVideoElement).currentTime = 0.1; }}
                         />
                       ) : (
                         <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-600 p-6 text-center pointer-events-none">
                            <ImageIcon size={32} className="mb-2 opacity-50"/>
                            <p className="text-xs max-w-xs line-clamp-2">{frame.imagePrompt}</p>
                         </div>
                       )}
                       
                       {(() => {
                         const derived = deriveFrameVideoState(currentProject?.id, currentEpisode?.id, frame);
                         return (frame.isGenerating || derived.isGeneratingVideo || derived.videoTaskStatus === 'waiting') && (
                           <div className={`absolute inset-0 bg-black/70 flex items-center justify-center z-10 flex-col gap-2 ${derived.videoTaskStatus === 'waiting' ? '' : 'pointer-events-none'}`}>
                             <Loader2 className={`w-8 h-8 ${derived.videoTaskStatus === 'waiting' ? 'text-yellow-400' : 'animate-spin text-blue-500'}`} />

                             {/* 显示进度百分比 */}
                             {frame.isGenerating && frame.imageProgress !== undefined ? (
                               <span className="text-xs text-blue-300 font-medium">
                                 生成中 {Math.round(frame.imageProgress)}%
                               </span>
                             ) : derived.videoTaskStatus === 'waiting' ? (
                              <div className="flex flex-col items-center gap-1">
                                <span className="text-xs text-yellow-300 font-medium">
                                  {derived.backendTask?.progress || (derived.videoQueuePosition ? `队列等待中 · 前面还有 ${Math.max(derived.videoQueuePosition - 1, 0)} 个` : '队列等待中...')}
                                </span>
                                <button
                                  onClick={() => handleCancelFrameVideo(frame.id)}
                                  className="text-xs text-red-400 hover:text-red-300 underline"
                                >
                                  取消
                                </button>
                              </div>
                            ) : derived.isGeneratingVideo && frame.videoProgress !== undefined ? (
                              <div className="flex flex-col items-center gap-1">
                             <span className="text-xs text-purple-300 font-medium">
                               生成视频 {Math.round(frame.videoProgress)}%
                             </span>
                             <span className="text-[9px] text-gray-400">
                               {derived.videoSessionName || '获取账号中...'}
                             </span>
                            </div>
                           ) : (
                             <span className="text-xs text-blue-300 font-medium">
                               {derived.isGeneratingVideo ? '正在生成视频...' : '正在生成图片...'}
                             </span>
                           )}
                         </div>
                       );
                     })()}

                       {/* 错误显示 - 在卡片右上角 */}
                       {(frame.imageError || frame.videoError) && (
                         <div className="absolute top-2 right-2 group/error z-20">
                           <AlertCircle className="w-5 h-5 text-red-500 drop-shadow-lg" />
                           <div className="absolute right-0 top-6 w-56 bg-red-900/95 border border-red-700 rounded-lg p-2 text-xs text-red-100 opacity-0 group-hover/error:opacity-100 transition-opacity pointer-events-none shadow-lg whitespace-pre-wrap break-words">
                             {frame.videoError ? mapVideoErrorMessage(frame.videoError) : frame.imageError}
                           </div>
                         </div>
                       )}

                       {/* Quick Action Overlay */}
                       <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/image:opacity-100 transition-opacity flex items-center justify-center gap-2">
                          <button 
                            onClick={() => handleGenerateFrameImage(frame.id, useVideoPromptForImage ? frame.videoPrompt : frame.imagePrompt)}
                            className="bg-blue-600 hover:bg-blue-500 text-white p-2 rounded-full shadow-lg flex items-center justify-center"
                            title="生成图片"
                          >
                             <Wand2 size={20} />
                          </button>
                          {(() => {
                            const derived = deriveFrameVideoState(currentProject?.id, currentEpisode?.id, frame);
                            return (
                              <>
                                {frame.imageUrl && (
                                  <button
                                    onClick={() => handleGenerateFrameVideo(frame.id)}
                                    disabled={derived.isGeneratingVideo || derived.videoTaskStatus === 'waiting'}
                                    className="bg-purple-600 hover:bg-purple-500 disabled:bg-purple-900/60 disabled:text-purple-300/60 text-white p-2 rounded-full shadow-lg flex items-center justify-center"
                                    title={derived.videoTaskStatus === 'waiting' ? '视频队列等待中' : '生成视频'}
                                  >
                                    <Film size={20} />
                                  </button>
                                )}
                                {!frame.imageUrl && currentProject.settings.multiRefVideoMode && (
                                  <button
                                    onClick={() => handleGenerateFrameVideo(frame.id)}
                                    disabled={derived.isGeneratingVideo || derived.videoTaskStatus === 'waiting'}
                                    className="bg-purple-600 hover:bg-purple-500 disabled:bg-purple-900/60 disabled:text-purple-300/60 text-white p-2 rounded-full shadow-lg flex items-center justify-center"
                                    title={derived.videoTaskStatus === 'waiting' ? '视频队列等待中' : '多参考生成视频'}
                                  >
                                    <Film size={20} />
                                  </button>
                                )}
                              </>
                            );
                          })()}
                       </div>
                       
                       {/* Frame Number */}
                       <div className="absolute bottom-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded backdrop-blur-sm border border-white/10 pointer-events-none">
                         #{index + 1}
                       </div>

                       {/* Reference Indicators */}
                       <div className="absolute bottom-2 left-2 flex gap-1 pointer-events-none">
                          {frame.videoUrl && (
                            <div className="bg-purple-600/70 px-1.5 py-0.5 rounded text-[10px] text-white flex items-center gap-1 border border-purple-400/40" title={frame.videoSessionName ? `视频已生成 · 账号: ${frame.videoSessionName}` : "视频已生成"}>
                               <Film size={8} /> 视频{frame.videoSessionName ? ` · ${frame.videoSessionName}` : ''}
                            </div>
                          )}
                          {frame.references.characterIds.length > 0 && (
                            <div className="bg-black/60 px-1.5 py-0.5 rounded text-[10px] text-blue-300 flex items-center gap-1 border border-blue-500/30" title="Uses Character Reference">
                               <Users size={8} /> {frame.references.characterIds.length}
                            </div>
                          )}
                          {(() => {
                            const sceneCount = (frame.references.sceneIds ?? (frame.references.sceneId ? [frame.references.sceneId] : [])).length;
                            return sceneCount > 0 ? (
                              <div className="bg-black/60 px-1.5 py-0.5 rounded text-[10px] text-green-300 flex items-center gap-1 border border-green-500/30" title="Uses Scene Reference">
                                <ImageIcon size={8} /> {sceneCount}
                              </div>
                            ) : null;
                          })()}
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
                          className="text-sm text-gray-300 leading-snug line-clamp-3 cursor-text mb-2 pr-6 max-h-[4.5rem] overflow-hidden"
                          onClick={() => setEditingFrameId(frame.id)}
                          title={frame.imagePrompt}
                       >
                         {frame.imagePrompt}
                       </p>
                       
                       {/* Dialogue and Audio Section */}
                       <div className="mt-auto bg-gray-900/50 p-2 rounded border border-gray-700/50 flex flex-col gap-2 min-h-[60px]">
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
                                            disabled={!getDialoguesTextOnly(getFrameDialogues(frame)) && !frame.imagePrompt}
                                        >
                                            <Mic size={14} />
                                        </button>
                                    )}
                                </div>
                            </div>
                            {(() => {
                              const dialogues = getFrameDialogues(frame);
                              const display = mergeDialoguesToDisplayString(dialogues) ?? frame.dialogue;
                              if (dialogues && dialogues.length > 0) {
                                return (
                                  <div className="space-y-1">
                                    {dialogues.slice(0, 3).map((d, i) => (
                                      <div key={i} className="text-xs text-gray-300 leading-snug">
                                        {d.speakerName ? (
                                          <span className="text-blue-300 font-medium">{d.speakerName}：</span>
                                        ) : null}
                                        <span>{d.text}</span>
                                      </div>
                                    ))}
                                    {dialogues.length > 3 ? (
                                      <div className="text-[10px] text-gray-500">……</div>
                                    ) : null}
                                  </div>
                                );
                              }
                              if (display) {
                                return <p className="text-xs text-gray-300 italic whitespace-pre-line">"{display}"</p>;
                              }
                              return <p className="text-[10px] text-gray-600 italic">无对白 (将朗读提示词)</p>;
                            })()}
                       </div>
                       
                       {/* Reference List (Visual Check) */}
                       {(frame.references.characterIds.length > 0 || (frame.references.sceneIds ?? (frame.references.sceneId ? [frame.references.sceneId] : [])).length > 0) && (
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
                             {(frame.references.sceneIds ?? (frame.references.sceneId ? [frame.references.sceneId] : [])).map(sid => {
                                const s = currentProject.scenes.find(sc => sc.id === sid);
                                if (!s) return null;
                                return (
                                   <span key={sid} className={`text-[10px] px-1.5 py-0.5 rounded bg-green-900/30 text-green-400 border border-green-800 ${!s.imageUrl ? 'opacity-50 dashed border-gray-700 text-gray-500' : ''}`}>
                                      {s.name}
                                   </span>
                                )
                             })}
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
                <div className="flex flex-col h-full min-h-0 gap-4">
                  {/* Hidden audio player for timeline playback */}
                  <audio
                    ref={timelineAudioRef}
                    className="hidden"
                    onEnded={() => audioEndedHandlerRef.current?.()}
                  />
                  {/* Player Window */}
                  <div className="flex-1 min-h-0 bg-black rounded-xl overflow-hidden relative flex flex-col">
                     {/* Video/Image Area */}
                     <div className="flex-1 min-h-0 flex items-center justify-center relative bg-gray-950">
                        {(() => {
                            const frame = currentEpisode.frames[currentPlaybackIndex];
                            if (!frame) return <div className="text-gray-600">无可用分镜</div>;

                            return (
                                <>
                                    {/* Persistent video element — never unmounted, src controlled by useEffect.
                                        Keeping it in the DOM avoids the AbortError caused by key-based remounting. */}
                                    <video
                                        ref={timelineVideoRef}
                                        className={`w-full h-full object-contain${frame.videoUrl ? '' : ' hidden'}`}
                                        muted
                                        playsInline
                                        onEnded={handleVideoEnded}
                                    />
                                    {!frame.videoUrl && frame.imageUrl && (
                                        <img
                                            src={frame.imageUrl}
                                            className="w-full h-full object-contain animate-fadeIn"
                                            alt={`Frame ${frame.index}`}
                                            key={`img-${frame.id}`}
                                        />
                                    )}
                                    {!frame.videoUrl && !frame.imageUrl && (
                                        <div className="flex flex-col items-center justify-center text-gray-600 p-8 text-center max-w-md">
                                            <ImageIcon size={48} className="mb-4 opacity-30"/>
                                            <p className="text-lg font-medium text-gray-500">尚未生成视觉内容</p>
                                            <p className="text-sm opacity-50 mt-2">{frame.imagePrompt}</p>
                                        </div>
                                    )}
                                </>
                            );
                        })()}
                        
                         {/* Loading Overlay */}
                         {(() => {
                           const playbackFrame = currentEpisode.frames[currentPlaybackIndex];
                           const derivedPlayback = deriveFrameVideoState(currentProject?.id, currentEpisode?.id, playbackFrame);
                           return (derivedPlayback.isGeneratingVideo || derivedPlayback.videoTaskStatus === 'waiting') && (
                            <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center z-20">
                                <Loader2 className={`w-10 h-10 mb-2 ${derivedPlayback.videoTaskStatus === 'waiting' ? 'text-yellow-400' : 'animate-spin text-purple-500'}`}/>
                                <span className="text-white font-medium">{derivedPlayback.videoTaskStatus === 'waiting' ? (derivedPlayback.backendTask?.progress || '队列等待中...') : '正在生成视频...'}</span>
                            </div>
                           );
                         })()}

                         {currentEpisode.frames[currentPlaybackIndex]?.videoError && (
                            <div className="absolute top-16 left-4 right-4 bg-red-900/85 border border-red-700 rounded-lg px-3 py-2 text-red-100 text-xs z-20 whitespace-pre-wrap break-words">
                              {mapVideoErrorMessage(currentEpisode.frames[currentPlaybackIndex]?.videoError || '')}
                            </div>
                         )}

                         {/* Overlay Info */}
                         <div className="absolute top-4 left-4 bg-black/60 px-3 py-1.5 rounded-lg backdrop-blur-md text-white border border-white/10 z-10">
                            <span className="font-bold text-blue-400 mr-2">#{currentPlaybackIndex + 1}</span> 
                            <span className="text-sm opacity-90">
                              {(() => {
                                const frame = currentEpisode.frames[currentPlaybackIndex];
                                const dialogues = getFrameDialogues(frame);
                                const display = mergeDialoguesToDisplayString(dialogues) ?? frame?.dialogue;
                                const firstLine = (display ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0];
                                return firstLine ? `"${firstLine}"` : '无对白';
                              })()}
                            </span>
                         </div>
                         
                         {/* Generate Video Action (If Image Exists but No Video) */}
                         {(() => {
                           const playbackFrame = currentEpisode.frames[currentPlaybackIndex];
                           const derivedPlayback = deriveFrameVideoState(currentProject?.id, currentEpisode?.id, playbackFrame);
                           return playbackFrame?.imageUrl && !playbackFrame?.videoUrl && !derivedPlayback.isGeneratingVideo && (
                            <div className="absolute bottom-20 right-8 z-10">
                                <button
                                    onClick={() => handleGenerateFrameVideo(playbackFrame.id)}
                                    disabled={derivedPlayback.videoTaskStatus === 'waiting'}
                                    className="bg-purple-600 hover:bg-purple-500 disabled:bg-purple-900/60 disabled:text-purple-300/60 text-white px-4 py-2 rounded-full shadow-xl flex items-center gap-2 font-medium transition-all hover:scale-105"
                                >
                                    <Film size={18} /> {derivedPlayback.videoTaskStatus === 'waiting' ? '视频排队中' : '生成视频'}
                                </button>
                            </div>
                           );
                         })()}
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
                                        <span className="text-[10px] line-clamp-2">{frame.imagePrompt}</span>
                                    </div>
                                )}

                                {frame.videoUrl && !frame.isGeneratingVideo && frame.videoTaskStatus !== 'waiting' && (
                                    <div className="absolute top-1 left-1 bg-purple-600 rounded-full p-1 shadow-md z-10">
                                        <Film size={10} className="text-white"/>
                                    </div>
                                )}

                                {(() => {
                                    const derived = deriveFrameVideoState(currentProject?.id, currentEpisode?.id, frame);
                                    return (derived.isGeneratingVideo || derived.videoTaskStatus === 'waiting') && (
                                        <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-1 z-10">
                                            <Loader2 size={18} className={derived.videoTaskStatus === 'waiting' ? 'text-yellow-300' : 'animate-spin text-purple-300'} />
                                            <span className={`text-[10px] font-medium ${derived.videoTaskStatus === 'waiting' ? 'text-yellow-200' : 'text-purple-200'}`}>
                                                {derived.videoTaskStatus === 'waiting' ? (derived.backendTask?.progress || '队列等待中') : frame.videoProgress !== undefined ? `视频 ${Math.round(frame.videoProgress)}%` : '视频生成中'}
                                            </span>
                                            <span className="text-[9px] text-gray-400">
                                                {derived.videoSessionName || '获取账号中...'}
                                            </span>
                                        </div>
                                    );
                                })()}

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
                  导出当前分集的剪映工程、分镜图压缩包，或当前项目的资产图压缩包。
                </p>

                {isExporting ? (
                  <div className="space-y-4">
                    <div className="flex items-center justify-center gap-3 text-blue-400">
                      <Loader2 className="animate-spin" size={24} />
                      <span className="font-medium">{exportMessage}</span>
                    </div>
                    <div className="w-full bg-gray-700 rounded-full h-2">
                      <div
                        className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${exportProgress}%` }}
                      />
                    </div>
                    <p className="text-sm text-gray-500">{exportProgress}%</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                     <button
                       onClick={handleExportToJianying}
                       disabled={!currentEpisode || !currentEpisode.frames.length}
                       className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white py-3 rounded-lg font-medium flex items-center justify-center gap-2 transition-colors"
                     >
                       <Download size={18} /> 导出剪映工程
                     </button>
                     <button
                       onClick={handleExportStoryboardZip}
                       disabled={isExportingStoryboardZip || !currentEpisode || !currentEpisode.frames.length}
                       className="w-full bg-gray-700 hover:bg-gray-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white py-3 rounded-lg font-medium flex items-center justify-center gap-2 transition-colors"
                     >
                       {isExportingStoryboardZip ? <Loader2 className="animate-spin" size={18} /> : <Download size={18} />}
                       导出分镜图 ZIP
                     </button>
                     <button
                       onClick={handleExportAssetZip}
                       disabled={isExportingAssetZip || !currentProject || !hasAnyAssetImages}
                       className="w-full bg-gray-700 hover:bg-gray-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white py-3 rounded-lg font-medium flex items-center justify-center gap-2 transition-colors"
                     >
                       {isExportingAssetZip ? <Loader2 className="animate-spin" size={18} /> : <Download size={18} />}
                       导出资产图 ZIP
                     </button>
                     {storyboardZipMessage && (
                       <p className="text-sm text-gray-300">{storyboardZipMessage}</p>
                     )}
                     {assetZipMessage && (
                       <p className="text-sm text-gray-300">{assetZipMessage}</p>
                     )}
                     {!globalSettings.jianyingExportPath && (
                       <p className="text-sm text-yellow-400 flex items-center justify-center gap-2">
                         <AlertCircle size={16} />
                         请先在全局设置中配置剪映工程目录
                       </p>
                     )}
                     {!currentEpisode && (
                       <p className="text-sm text-gray-500">
                         请先选择当前分集
                       </p>
                     )}
                     {currentEpisode && !currentEpisode.frames.length && (
                       <p className="text-sm text-gray-500">
                         当前剧集没有分镜内容
                       </p>
                     )}
                     {currentProject && !hasAnyAssetImages && (
                       <p className="text-sm text-gray-500">
                         当前项目没有可导出的资产图
                       </p>
                     )}
                  </div>
                )}
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

        {/* Find & Replace Modal */}
        {showFindReplace && currentProject && currentEpisode && (
          <FindReplaceModal
            projects={projects}
            currentProject={currentProject}
            currentEpisode={currentEpisode}
            onReplace={(updates) => {
              for (const { projectId, episodeId, frames } of updates) {
                handleUpdateEpisode(projectId, episodeId, { frames });
              }
            }}
            onClose={() => setShowFindReplace(false)}
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
        {previewFrame && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm" onClick={() => setPreviewFrameId(null)}>
            <div className="bg-gray-900 rounded-2xl w-full max-w-4xl border border-gray-700 shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <div className="p-4 border-b border-gray-700 flex justify-between items-center">
                <div className="text-sm text-gray-400">分镜预览 #{previewFrame.index + 1}</div>
                <div className="flex items-center gap-2">
                  {previewFrame.videoUrl && (
                    <a
                      href={previewFrame.videoUrl}
                      download={`frame-${previewFrame.index + 1}.mp4`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-800 text-gray-200 hover:bg-gray-700 transition-colors text-sm"
                    >
                      <Download size={16} /> 下载视频
                    </a>
                  )}
                  {(previewFrame.seedanceTaskId || previewFrame.videoUrl?.includes('jimeng.com') || previewFrame.videoUrl?.includes('vlabvod.com')) && (
                    <button
                      onClick={() => handleRefetchVideoResult(previewFrame.id)}
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors text-sm"
                      title="重新从即梦API获取视频URL"
                    >
                      <RefreshCw size={16} /> 重新获取
                    </button>
                  )}
                  <button onClick={() => setPreviewFrameId(null)} className="text-gray-400 hover:text-white transition-colors">
                    <X size={20} />
                  </button>
                </div>
              </div>
              <div className="bg-black flex items-center justify-center">
                {previewFrameMode === 'video' && previewFrame.videoUrl ? (
                  <video src={previewFrame.videoUrl} controls className="w-full max-h-[70vh]" poster={previewFrame.imageUrl} />
                ) : previewFrame.imageUrl ? (
                  <img src={previewFrame.imageUrl} alt="Storyboard Preview" className="w-full max-h-[70vh] object-contain" />
                ) : previewFrame.videoUrl ? (
                  <video src={previewFrame.videoUrl} controls className="w-full max-h-[70vh]" />
                ) : (
                  <div className="h-64 w-full flex items-center justify-center text-gray-500">暂无可预览内容</div>
                )}
              </div>
              <div className="p-4 text-sm text-gray-300 border-t border-gray-700">
                <div className="text-xs text-gray-500 mb-1">生图提示词</div>
                <div className="line-clamp-3">{previewFrame.imagePrompt || previewFrame.prompt}</div>
              </div>
            </div>
          </div>
        )}
        {previewAssetItem && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm" onClick={() => setPreviewAsset(null)}>
            <div className="bg-gray-900 rounded-2xl w-full max-w-3xl border border-gray-700 shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <div className="p-4 border-b border-gray-700 flex justify-between items-center">
                <div className="text-sm text-gray-400">{previewAssetItem.name} 预览</div>
                <button onClick={() => setPreviewAsset(null)} className="text-gray-400 hover:text-white transition-colors">
                  <X size={20} />
                </button>
              </div>
              <div className="bg-black flex items-center justify-center">
                {'imageUrl' in previewAssetItem && previewAssetItem.imageUrl ? (
                  <img src={previewAssetItem.imageUrl} alt={previewAssetItem.name} className="w-full max-h-[70vh] object-contain" />
                ) : (
                  <div className="h-64 w-full flex items-center justify-center text-gray-500">暂无可预览内容</div>
                )}
              </div>
            </div>
          </div>
        )}
        {editingVariant && currentProject && (() => {
          const variant = (currentProject.variants ?? []).find(v => v.id === editingVariant.id);
          if (!variant) return null;
          return (
            <VariantEditorModal
              variant={variant}
              characters={currentProject.characters}
              onSave={handleSaveVariantUpdate}
              onClose={() => setEditingVariant(null)}
            />
          );
        })()}
        {previewVariant && currentProject && (() => {
          const variant = (currentProject.variants ?? []).find(v => v.id === previewVariant.id);
          if (!variant?.imageUrl) return null;
          return (
            <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm" onClick={() => setPreviewVariant(null)}>
              <div className="bg-gray-900 rounded-2xl w-full max-w-3xl border border-gray-700 shadow-2xl flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
                <div className="p-4 border-b border-gray-700 flex justify-between items-center">
                  <div className="text-sm text-gray-400">{variant.name} 变体预览</div>
                  <button onClick={() => setPreviewVariant(null)} className="text-gray-400 hover:text-white"><X size={20} /></button>
                </div>
                <div className="bg-black flex items-center justify-center">
                  <img src={variant.imageUrl} alt={variant.name} className="w-full max-h-[70vh] object-contain" />
                </div>
              </div>
            </div>
          );
        })()}
        </Layout>

        {showGlobalSettingsModal && (
          <GlobalSettingsModal
            settings={globalSettings}
            defaultProjectType={currentProject?.type}
            onSave={async (s) => {
              try {
                await apiService.updateSettings(s);
                setGlobalSettings(s);
                savedGlobalSettingsRef.current = JSON.stringify(s);
                console.log('💾 全局设置已保存', {
                  extractionModel: s.extractionModel,
                  projectTypes: Object.keys(s.projectTypePrompts)
                });
              } catch (error) {
                console.error('❌ 全局设置保存失败:', error);
                alert('全局设置保存失败：' + (error as Error).message);
              }
            }}
            onClose={() => setShowGlobalSettingsModal(false)}
          />
        )}

        {/* 单集预处理配置 Modal */}
        {showEpisodePreprocessModal && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
            <div className="bg-gray-800 rounded-2xl w-full max-w-md border border-gray-700 shadow-2xl">
              <div className="p-5 border-b border-gray-700 flex justify-between items-center">
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <Wand2 size={18} className="text-teal-400" /> 单集预处理
                </h2>
                <button
                  onClick={() => setShowEpisodePreprocessModal(false)}
                  disabled={isEpisodePreprocessing}
                  className="text-gray-400 hover:text-white disabled:opacity-50"
                >
                  <X size={24} />
                </button>
              </div>
              <div className="p-6 flex flex-col gap-4">
                <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
                  <p className="text-sm text-gray-300">
                    当前分集：<span className="text-teal-300 font-medium">{currentEpisode.name}</span>
                  </p>
                  <p className="text-xs text-gray-500 mt-1">共 {currentEpisode.scriptContent.length.toLocaleString()} 字</p>
                </div>
                <p className="text-xs text-gray-500">仅对当前分集文本执行导演分段，不提取资产。分段完成后将展示预览供你确认。</p>
                {episodePreprocessTaskState && !episodePreprocessTaskState.resultAppliedAt && (
                  <div className="bg-gray-900 rounded-lg p-4 border border-gray-700 space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-300">任务状态</span>
                      <span className={`font-medium ${episodePreprocessTaskState.status === 'completed' ? 'text-green-400' : episodePreprocessTaskState.status === 'failed' || episodePreprocessTaskState.status === 'interrupted' ? 'text-red-400' : 'text-teal-300'}`}>
                        {episodePreprocessTaskState.status === 'pending' ? '等待中' : episodePreprocessTaskState.status === 'running' ? '处理中' : episodePreprocessTaskState.status === 'completed' ? '已完成' : episodePreprocessTaskState.status === 'interrupted' ? '已中断' : '失败'}
                      </span>
                    </div>
                    <div className="text-xs text-gray-400">
                      阶段：{episodePreprocessTaskState.stage === 'connectivity' ? '连通性检测' : episodePreprocessTaskState.stage === 'segmenting' ? '分段处理中' : episodePreprocessTaskState.stage === 'second_pass' ? '二次加工' : episodePreprocessTaskState.stage === 'interrupted' ? '服务重启中断' : episodePreprocessTaskState.stage === 'failed' ? '任务失败' : '处理完成'}
                    </div>
                    {episodePreprocessTaskState.error && (
                      <div className="text-xs text-red-300 whitespace-pre-wrap">{episodePreprocessTaskState.error}</div>
                    )}
                  </div>
                )}
                {(() => {
                  const typePrompts = globalSettings.projectTypePrompts[currentProject.type] ?? globalSettings.projectTypePrompts['REAL_PERSON_COMMENTARY'];
                  const hasSecondPassPrompt = !!typePrompts.preprocessSecondPassPrompt?.trim();
                  return (
                    <label className={`flex items-center gap-2 select-none ${hasSecondPassPrompt ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
                      <input
                        type="checkbox"
                        checked={enableEpisodeSecondPass}
                        onChange={e => setEnableEpisodeSecondPass(e.target.checked)}
                        disabled={!hasSecondPassPrompt || isEpisodePreprocessing}
                        className="accent-teal-500 w-4 h-4"
                      />
                      <span className="text-sm text-gray-300">启用二次加工</span>
                      {!hasSecondPassPrompt && <span className="text-xs text-gray-500">（请先配置二次加工提示词）</span>}
                    </label>
                  );
                })()}
              </div>
              <div className="p-5 border-t border-gray-700 flex justify-end gap-3">
                <button
                  onClick={() => setShowEpisodePreprocessModal(false)}
                  disabled={isEpisodePreprocessing}
                  className="px-5 py-2.5 rounded-lg text-gray-300 hover:bg-gray-700 font-medium disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  onClick={handleEpisodePreprocess}
                  disabled={isEpisodePreprocessing}
                  className="px-6 py-2.5 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-white font-medium flex items-center gap-2 transition-colors"
                >
                  {isEpisodePreprocessing ? <><Loader2 size={16} className="animate-spin" /> 处理中...</> : '开始预处理'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 单集预处理结果预览 Modal */}
        {showEpisodePreprocessPreview && episodePreprocessResult !== null && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
            <div className="bg-gray-800 rounded-2xl w-full max-w-2xl border border-gray-700 shadow-2xl flex flex-col max-h-[90vh]">
              <div className="p-5 border-b border-gray-700 flex justify-between items-center">
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <FileText size={18} className="text-teal-400" /> 预处理结果预览
                </h2>
                <button
                  onClick={() => { setShowEpisodePreprocessPreview(false); setEpisodePreprocessResult(null); }}
                  className="text-gray-400 hover:text-white"
                >
                  <X size={24} />
                </button>
              </div>
              <div className="p-5 flex-1 overflow-hidden flex flex-col gap-3">
                <p className="text-xs text-gray-400">
                  共 {episodePreprocessResult.length.toLocaleString()} 字。确认后将替换「{currentEpisode.name}」的剧本内容。
                </p>
                <textarea
                  readOnly
                  value={episodePreprocessResult}
                  className="flex-1 w-full bg-gray-900 border border-gray-700 rounded-xl p-4 text-gray-200 resize-none font-serif text-sm leading-relaxed custom-scrollbar focus:outline-none"
                />
              </div>
              <div className="p-5 border-t border-gray-700 flex justify-end gap-3">
                <button
                  onClick={() => { setShowEpisodePreprocessPreview(false); setEpisodePreprocessResult(null); }}
                  className="px-5 py-2.5 rounded-lg text-gray-300 hover:bg-gray-700 font-medium"
                >
                  取消
                </button>
                <button
                  onClick={() => {
                    handleUpdateEpisode(currentProject.id, currentEpisode.id, { scriptContent: episodePreprocessResult! });
                    setShowEpisodePreprocessPreview(false);
                    setEpisodePreprocessResult(null);
                  }}
                  className="px-6 py-2.5 bg-teal-600 hover:bg-teal-500 rounded-lg text-white font-medium flex items-center gap-2 transition-colors"
                >
                  确认替换
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  return null; // Should not happen
};

export default App;
