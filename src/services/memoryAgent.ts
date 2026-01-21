/**
 * 记忆Agent服务
 * 负责记忆的检索和学习
 * 支持多重身份识别和名称归属
 */

import { extractMemory, TranslateCharacterInfo } from './llmService';
import {
  WorkMemory,
  CharacterInfo,
  NameVariantType,
  getWorkMemory,
  createWorkMemory,
  mergeMemory,
  saveWorkMemory,
  findPrimaryName
} from '../storage/indexedDB';

export interface MemoryContext {
  characters: Record<string, TranslateCharacterInfo>;
  nameMappings: Record<string, string>;
  style?: string;
}

/**
 * 获取作品的记忆上下文（用于翻译）
 * 包含别名和名称变体信息
 */
export async function getMemoryContext(workId: string): Promise<MemoryContext> {
  const memory = await getWorkMemory(workId);
  
  if (!memory) {
    return {
      characters: {},
      nameMappings: {}
    };
  }
  
  // 转换为翻译所需的格式（包含别名和名称变体）
  const characters: Record<string, TranslateCharacterInfo> = {};
  
  for (const [name, info] of Object.entries(memory.characters)) {
    const charInfo: TranslateCharacterInfo = {
      gender: info.gender,
      traits: info.traits
    };
    
    // 添加别名信息
    if (info.aliases && info.aliases.length > 0) {
      charInfo.aliases = info.aliases;
    }
    
    // 添加名称变体信息
    if (info.nameVariants && info.nameVariants.length > 0) {
      charInfo.nameVariants = info.nameVariants.map(v => ({
        original: v.original,
        translation: v.translation,
        type: v.type
      }));
    }
    
    characters[name] = charInfo;
  }
  
  return {
    characters,
    nameMappings: memory.nameMappings,
    style: memory.style
  };
}

/**
 * 初始化作品记忆（冷启动）
 */
export async function initializeMemory(
  workId: string,
  metadata?: {
    title?: string;
    source?: string;
    characters?: string[];      // 从Tag提取的角色列表
    relationships?: string[];   // 从Tag提取的关系
    tags?: string[];            // 其他标签（用于推断风格）
  }
): Promise<WorkMemory> {
  let memory = await getWorkMemory(workId);
  
  if (memory) {
    // 已有记忆，更新访问时间
    memory.lastVisited = Date.now();
    await saveWorkMemory(memory);
    return memory;
  }
  
  // 创建新记忆
  memory = createWorkMemory(workId, metadata?.title, metadata?.source);
  
  // 从Tag初始化角色
  if (metadata?.characters) {
    for (const char of metadata.characters) {
      memory.characters[char] = {
        original: char
      };
    }
  }
  
  // 从Tag推断关系
  if (metadata?.relationships) {
    for (const rel of metadata.relationships) {
      // 解析关系标签，如 "A/B" 或 "A & B"
      const cpMatch = rel.match(/(.+)\/(.+)/);
      const friendMatch = rel.match(/(.+)\s*&\s*(.+)/);
      
      if (cpMatch) {
        const [, char1, char2] = cpMatch;
        if (memory.characters[char1.trim()]) {
          memory.characters[char1.trim()].relations = {
            ...(memory.characters[char1.trim()].relations || {}),
            [char2.trim()]: 'CP'
          };
        }
      } else if (friendMatch) {
        const [, char1, char2] = friendMatch;
        if (memory.characters[char1.trim()]) {
          memory.characters[char1.trim()].relations = {
            ...(memory.characters[char1.trim()].relations || {}),
            [char2.trim()]: '朋友'
          };
        }
      }
    }
  }
  
  // 从Tag推断风格
  if (metadata?.tags) {
    const styleHints: string[] = [];
    
    for (const tag of metadata.tags) {
      const tagLower = tag.toLowerCase();
      
      if (tagLower.includes('fluff') || tagLower.includes('甜')) {
        styleHints.push('甜文');
      } else if (tagLower.includes('angst') || tagLower.includes('虐')) {
        styleHints.push('虐文');
      } else if (tagLower.includes('crack') || tagLower.includes('搞笑')) {
        styleHints.push('搞笑');
      } else if (tagLower.includes('dark') || tagLower.includes('黑暗')) {
        styleHints.push('黑暗');
      } else if (tagLower.includes('romance') || tagLower.includes('恋爱')) {
        styleHints.push('恋爱');
      }
    }
    
    if (styleHints.length > 0) {
      memory.style = styleHints.join('、') + '风格';
    }
  }
  
  await saveWorkMemory(memory);
  return memory;
}

/**
 * 学习结果
 */
export interface LearnResult {
  learned: {
    characters: Record<string, { gender?: string; traits?: string[] }>;
    nameMappings: Record<string, string>;
    identityMerges: number;      // 合并了多少身份
    nameVariants: number;        // 识别了多少名称变体
  };
  memory: WorkMemory;
  logs: string[];  // 学习日志
}

/**
 * 学习新内容（翻译后调用）
 * 自动处理多重身份和名称归属
 */
export async function learnFromTranslation(
  workId: string,
  originalText: string,
  translatedText: string,
  options?: {
    useAI?: boolean;  // 是否使用AI提取（更准确但有成本）
  }
): Promise<LearnResult> {
  const existingMemory = await getWorkMemory(workId) || createWorkMemory(workId);
  
  const logs: string[] = [];
  let newCharacters: Record<string, { gender?: string; traits?: string[] }> = {};
  let newNameMappings: Record<string, string> = {};
  let identityMerges: Array<{ primaryName: string; aliases: string[] }> = [];
  let nameVariants: Array<{
    original: string;
    translation: string;
    belongsTo: string;
    type: NameVariantType;
  }> = [];
  let style: string | undefined;
  
  if (options?.useAI !== false) {
    // 使用AI提取记忆
    try {
      const extracted = await extractMemory(
        originalText,
        translatedText,
        {
          characters: existingMemory.characters,
          nameMappings: existingMemory.nameMappings,
          aliasIndex: existingMemory.aliasIndex
        }
      );
      
      newCharacters = extracted.newCharacters;
      newNameMappings = extracted.newNameMappings;
      style = extracted.style;
      
      // 处理多重身份识别
      if (extracted.identityMerges && extracted.identityMerges.length > 0) {
        for (const merge of extracted.identityMerges) {
          logs.push(`🔗 识别多重身份: ${merge.primaryName} = ${merge.aliases.join(', ')} (${merge.reason})`);
          identityMerges.push({
            primaryName: merge.primaryName,
            aliases: merge.aliases
          });
        }
      }
      
      // 处理名称变体
      if (extracted.nameVariants && extracted.nameVariants.length > 0) {
        for (const variant of extracted.nameVariants) {
          logs.push(`📝 识别名称归属: ${variant.original}→${variant.translation} 属于[${variant.belongsTo}] (${variant.type})`);
          nameVariants.push({
            original: variant.original,
            translation: variant.translation,
            belongsTo: variant.belongsTo,
            type: variant.type as NameVariantType
          });
        }
      }
      
      // 记录角色信息
      for (const [name, info] of Object.entries(newCharacters)) {
        logs.push(`👤 识别角色: ${name} (${info.gender || '性别未知'})`);
      }
      
      // 记录风格
      if (style) {
        logs.push(`🎨 识别风格: ${style}`);
      }
      
    } catch (error) {
      console.error('AI记忆提取失败，使用规则提取:', error);
      logs.push(`⚠️ AI提取失败: ${error}`);
      // 降级到规则提取
      const ruleExtracted = extractByRules(originalText, translatedText);
      newNameMappings = ruleExtracted.nameMappings;
    }
  } else {
    // 仅使用规则提取
    const ruleExtracted = extractByRules(originalText, translatedText);
    newNameMappings = ruleExtracted.nameMappings;
  }
  
  // 合并到记忆（包含身份合并和名称变体）
  const updatedMemory = await mergeMemory(workId, {
    characters: newCharacters,
    nameMappings: newNameMappings,
    identityMerges,
    nameVariants,
    style
  });
  
  return {
    learned: {
      characters: newCharacters,
      nameMappings: newNameMappings,
      identityMerges: identityMerges.length,
      nameVariants: nameVariants.length
    },
    memory: updatedMemory,
    logs
  };
}

/**
 * 基于规则提取名称映射（轻量级，无AI成本）
 */
function extractByRules(
  originalText: string,
  translatedText: string
): {
  nameMappings: Record<string, string>;
} {
  const nameMappings: Record<string, string> = {};
  
  // 简单规则：查找引号中的内容
  // 日文名字模式
  const japaneseNamePattern = /([一-龯ぁ-んァ-ン]+(?:さん|くん|ちゃん|様|先生)?)/g;
  const japaneseNames = originalText.match(japaneseNamePattern) || [];
  
  // 英文名字模式（首字母大写）
  const englishNamePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g;
  const englishNames = originalText.match(englishNamePattern) || [];
  
  // 这里只做标记，实际映射需要对比译文
  // 简化处理：依赖AI提取
  
  return { nameMappings };
}

/**
 * 重置作品记忆
 */
export async function resetMemory(workId: string): Promise<WorkMemory> {
  const memory = createWorkMemory(workId);
  await saveWorkMemory(memory);
  return memory;
}

/**
 * 手动修正记忆
 */
export async function correctMemory(
  workId: string,
  corrections: {
    nameMappings?: Record<string, string>;
    characters?: Record<string, { gender?: string; traits?: string[] }>;
  }
): Promise<WorkMemory> {
  let memory = await getWorkMemory(workId);
  
  if (!memory) {
    memory = createWorkMemory(workId);
  }
  
  if (corrections.nameMappings) {
    memory.nameMappings = {
      ...memory.nameMappings,
      ...corrections.nameMappings
    };
  }
  
  if (corrections.characters) {
    for (const [name, info] of Object.entries(corrections.characters)) {
      memory.characters[name] = {
        ...(memory.characters[name] || {}),
        ...info
      };
    }
  }
  
  await saveWorkMemory(memory);
  return memory;
}

