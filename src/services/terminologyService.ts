/**
 * 术语库服务
 * 管理用户手动设置的翻译对
 */

export interface TerminologyEntry {
  original: string;      // 原文
  translated: string;    // 译文
  caseSensitive: boolean; // 是否区分大小写
  createdAt: number;
}

export interface Terminology {
  entries: TerminologyEntry[];
}

/**
 * 创建空术语库
 */
export function createTerminology(): Terminology {
  return { entries: [] };
}

/**
 * 添加术语
 */
export function addTerm(
  terminology: Terminology,
  original: string,
  translated: string,
  caseSensitive = false
): Terminology {
  // 检查是否已存在
  const existingIndex = terminology.entries.findIndex(
    e => e.original.toLowerCase() === original.toLowerCase()
  );

  const newEntry: TerminologyEntry = {
    original,
    translated,
    caseSensitive,
    createdAt: Date.now()
  };

  if (existingIndex >= 0) {
    // 更新已有的
    const newEntries = [...terminology.entries];
    newEntries[existingIndex] = newEntry;
    return { entries: newEntries };
  } else {
    // 添加新的
    return { entries: [...terminology.entries, newEntry] };
  }
}

/**
 * 删除术语
 */
export function removeTerm(terminology: Terminology, original: string): Terminology {
  return {
    entries: terminology.entries.filter(
      e => e.original.toLowerCase() !== original.toLowerCase()
    )
  };
}

/**
 * 转换为简单的映射对象（供翻译使用）
 */
export function toMapping(terminology: Terminology): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const entry of terminology.entries) {
    mapping[entry.original] = entry.translated;
  }
  return mapping;
}

/**
 * AC自动机匹配（简化版）
 * 在文本中找出所有术语出现的位置
 */
export function matchTerms(
  text: string,
  terminology: Terminology
): Array<{ start: number; end: number; original: string; translated: string }> {
  const matches: Array<{ start: number; end: number; original: string; translated: string }> = [];

  // 按长度降序排序，优先匹配长的术语
  const sortedEntries = [...terminology.entries].sort(
    (a, b) => b.original.length - a.original.length
  );

  for (const entry of sortedEntries) {
    const searchText = entry.caseSensitive ? text : text.toLowerCase();
    const searchTerm = entry.caseSensitive ? entry.original : entry.original.toLowerCase();
    
    let pos = 0;
    while ((pos = searchText.indexOf(searchTerm, pos)) !== -1) {
      // 检查是否与已有匹配重叠
      const overlaps = matches.some(
        m => (pos >= m.start && pos < m.end) || (pos + entry.original.length > m.start && pos + entry.original.length <= m.end)
      );

      if (!overlaps) {
        matches.push({
          start: pos,
          end: pos + entry.original.length,
          original: text.substring(pos, pos + entry.original.length), // 保留原始大小写
          translated: entry.translated
        });
      }
      pos++;
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}

/**
 * 从JSON导入术语库
 */
export function importFromJson(json: string): Terminology {
  try {
    const data = JSON.parse(json);
    if (Array.isArray(data)) {
      // 简单数组格式：[["原文", "译文"], ...]
      return {
        entries: data.map(([original, translated]) => ({
          original,
          translated,
          caseSensitive: false,
          createdAt: Date.now()
        }))
      };
    } else if (typeof data === 'object') {
      // 对象格式：{"原文": "译文", ...}
      return {
        entries: Object.entries(data).map(([original, translated]) => ({
          original,
          translated: translated as string,
          caseSensitive: false,
          createdAt: Date.now()
        }))
      };
    }
  } catch (error) {
    console.error('导入术语库失败:', error);
  }
  return createTerminology();
}

/**
 * 导出为JSON
 */
export function exportToJson(terminology: Terminology): string {
  const obj: Record<string, string> = {};
  for (const entry of terminology.entries) {
    obj[entry.original] = entry.translated;
  }
  return JSON.stringify(obj, null, 2);
}


