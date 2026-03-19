/**
 * 小说分集切割工具
 * 支持番茄小说 txt 常见章节格式：
 * 1. 单独一行的纯数字（1、2、3...）
 * 2. 单独一行的中文数字（一、二、三...）
 * 3. 章节标题行（第1章、第二章、第3集：xxx）
 *
 * 兼容首个显式章节标记不是 1/一 的情况：
 * - 若首个标记是 1/一，则其前面的内容视为第一集引言，并入第一集
 * - 若首个标记大于 1/一，则其前面的正文视为上一章内容，单独切成一集
 */

export interface NovelEpisodeDraft {
  title: string;
  content: string;
}

const CHINESE_DIGIT_MAP: Record<string, number> = {
  '零': 0,
  '〇': 0,
  '一': 1,
  '二': 2,
  '两': 2,
  '三': 3,
  '四': 4,
  '五': 5,
  '六': 6,
  '七': 7,
  '八': 8,
  '九': 9,
  '壹': 1,
  '贰': 2,
  '叁': 3,
  '肆': 4,
  '伍': 5,
  '陆': 6,
  '柒': 7,
  '捌': 8,
  '玖': 9,
};

const CHINESE_UNIT_MAP: Record<string, number> = {
  '十': 10,
  '拾': 10,
  '百': 100,
  '佰': 100,
  '千': 1000,
  '仟': 1000,
  '万': 10000,
};

function normalizeMarkerLine(line: string): string {
  return line.trim().replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
}

function parseChineseNumber(value: string): number | null {
  if (!value) return null;

  const hasUnit = /[十拾百佰千仟万]/.test(value);
  if (!hasUnit && value.length > 1) {
    const digits = Array.from(value).map(char => CHINESE_DIGIT_MAP[char]);
    if (digits.some(digit => digit === undefined)) return null;
    const parsed = Number(digits.join(''));
    return parsed > 0 ? parsed : null;
  }

  let total = 0;
  let section = 0;
  let number = 0;

  for (const char of value) {
    if (char in CHINESE_DIGIT_MAP) {
      number = CHINESE_DIGIT_MAP[char];
      continue;
    }

    const unit = CHINESE_UNIT_MAP[char];
    if (!unit) return null;

    if (unit === 10000) {
      section = (section + (number || 1)) * unit;
      total += section;
      section = 0;
      number = 0;
      continue;
    }

    section += (number || 1) * unit;
    number = 0;
  }

  const parsed = total + section + number;
  return parsed > 0 ? parsed : null;
}

function parseChapterNumber(value: string): number | null {
  if (/^\d+$/.test(value)) {
    const parsed = parseInt(value, 10);
    return parsed > 0 ? parsed : null;
  }

  return parseChineseNumber(value);
}

/** 判断某行是否为章节序号行 */
function isChapterMarker(line: string): number | null {
  const trimmed = normalizeMarkerLine(line);
  if (!trimmed) return null;

  const standaloneMatch = trimmed.match(/^([0-9]+|[一二三四五六七八九十百千万两〇零壹贰叁肆伍陆柒捌玖拾佰仟]+)$/);
  if (standaloneMatch) {
    return parseChapterNumber(standaloneMatch[1]);
  }

  const titledMatch = trimmed.match(/^第([0-9]+|[一二三四五六七八九十百千万两〇零壹贰叁肆伍陆柒捌玖拾佰仟]+)[章节回集话卷篇](?:\s*[-—:：、.·]?\s*.*)?$/);
  if (titledMatch) {
    return parseChapterNumber(titledMatch[1]);
  }

  return null;
}

function buildEpisodeTitle(chapterNum: number): string {
  return `第 ${chapterNum} 集`;
}

function pushEpisode(episodes: NovelEpisodeDraft[], chapterNum: number, lines: string[]) {
  const content = lines.join('\n').trim();
  if (!content) return;

  episodes.push({
    title: buildEpisodeTitle(chapterNum),
    content,
  });
}

function splitNovelIntoEpisodesInternal(text: string): {
  episodes: NovelEpisodeDraft[];
  firstEpisodeHasPreamble: boolean;
} {
  const lines = text.split('\n');
  const episodes: NovelEpisodeDraft[] = [];

  let currentChapterNum: number | null = null;
  let currentLines: string[] = [];
  let firstEpisodeHasPreamble = false;
  let hasSeenMarker = false;

  for (const line of lines) {
    const markerNum = isChapterMarker(line);
    if (markerNum === null) {
      currentLines.push(line);
      continue;
    }

    if (!hasSeenMarker) {
      hasSeenMarker = true;
      const beforeFirstMarker = currentLines.join('\n').trim();

      if (markerNum === 1) {
        firstEpisodeHasPreamble = beforeFirstMarker.length > 0;
        currentChapterNum = markerNum;
        currentLines = beforeFirstMarker ? [beforeFirstMarker, ''] : [];
      } else {
        if (beforeFirstMarker) {
          pushEpisode(episodes, Math.max(markerNum - 1, 1), currentLines);
        }
        currentChapterNum = markerNum;
        currentLines = [];
      }
      continue;
    }

    if (currentChapterNum !== null) {
      pushEpisode(episodes, currentChapterNum, currentLines);
    }

    currentChapterNum = markerNum;
    currentLines = [];
  }

  if (currentChapterNum !== null) {
    pushEpisode(episodes, currentChapterNum, currentLines);
  }

  return { episodes, firstEpisodeHasPreamble };
}

/**
 * 检测文本中识别到的章节序号列表（用于预览）
 */
export function detectEpisodeTitles(text: string): string[] {
  const { episodes, firstEpisodeHasPreamble } = splitNovelIntoEpisodesInternal(text);
  return episodes.map((episode, index) => (
    index === 0 && firstEpisodeHasPreamble
      ? `${episode.title}（含引言）`
      : episode.title
  ));
}

/**
 * 将完整小说文本切割为分集草稿数组
 */
export function splitNovelIntoEpisodes(text: string): NovelEpisodeDraft[] {
  return splitNovelIntoEpisodesInternal(text).episodes;
}
