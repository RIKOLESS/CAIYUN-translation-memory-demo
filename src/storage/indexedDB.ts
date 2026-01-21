/**
 * IndexedDB 存储服务
 * 用于持久化记忆数据
 */

import { openDB, DBSchema, IDBPDatabase } from 'idb';

// 数据库结构定义
interface TranslationMemoryDB extends DBSchema {
  memories: {
    key: string;  // 作品ID
    value: WorkMemory;
    indexes: { 'by-lastVisited': number };
  };
  settings: {
    key: string;
    value: unknown;
  };
}

// 名称变体类型
export type NameVariantType = 'fullName' | 'firstName' | 'lastName' | 'nickname' | 'codename' | 'title';

// 名称变体信息
export interface NameVariant {
  original: string;           // 原文（如：Rei）
  translation: string;        // 译文（如：零）
  type: NameVariantType;      // 类型（如：firstName）
}

// 角色信息（支持多重身份）
export interface CharacterInfo {
  primaryName: string;               // 主名称/真名（如：降谷零）
  aliases: string[];                 // 别名/化名（如：安室透、波本）
  originalNames: string[];           // 原文中的所有写法
  gender?: string;                   // 性别
  traits?: string[];                 // 性格特征
  nameVariants: NameVariant[];       // 名称变体（Rei→零 属于这个角色）
  relations?: Record<string, string>; // 与其他角色的关系
  firstAppear?: number;              // 首次出现章节
}

// 作品记忆结构
export interface WorkMemory {
  workId: string;                    // 作品ID（AO3的work_id或自定义）
  title?: string;                    // 作品标题
  source?: string;                   // 来源（ao3/pixiv/custom）
  
  // 角色信息（增强版：支持多重身份）
  characters: Record<string, CharacterInfo>;
  
  // 名称翻译映射（简单映射，向后兼容）
  nameMappings: Record<string, string>;
  
  // 别名索引（快速查找：别名 -> 主名称）
  aliasIndex: Record<string, string>;
  
  // 风格信息
  style?: string;
  
  // 元信息
  createdAt: number;
  lastVisited: number;
  totalChapters?: number;
  lastChapter?: number;
}

const DB_NAME = 'translation-memory-db';
const DB_VERSION = 1;

let db: IDBPDatabase<TranslationMemoryDB> | null = null;

/**
 * 初始化数据库
 */
export async function initDB(): Promise<IDBPDatabase<TranslationMemoryDB>> {
  if (db) return db;
  
  db = await openDB<TranslationMemoryDB>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      // 创建memories存储
      if (!database.objectStoreNames.contains('memories')) {
        const memoryStore = database.createObjectStore('memories', {
          keyPath: 'workId'
        });
        memoryStore.createIndex('by-lastVisited', 'lastVisited');
      }
      
      // 创建settings存储
      if (!database.objectStoreNames.contains('settings')) {
        database.createObjectStore('settings');
      }
    }
  });
  
  return db;
}

/**
 * 获取作品记忆
 */
export async function getWorkMemory(workId: string): Promise<WorkMemory | undefined> {
  const database = await initDB();
  return database.get('memories', workId);
}

/**
 * 保存作品记忆
 */
export async function saveWorkMemory(memory: WorkMemory): Promise<void> {
  const database = await initDB();
  memory.lastVisited = Date.now();
  await database.put('memories', memory);
}

/**
 * 创建新的作品记忆
 */
export function createWorkMemory(workId: string, title?: string, source?: string): WorkMemory {
  return {
    workId,
    title,
    source,
    characters: {},
    nameMappings: {},
    aliasIndex: {},
    createdAt: Date.now(),
    lastVisited: Date.now()
  };
}

/**
 * 合并角色身份（将多个名字识别为同一人）
 */
export function mergeCharacterIdentities(
  memory: WorkMemory,
  primaryName: string,
  aliasNames: string[]
): WorkMemory {
  // 确保aliasIndex存在
  if (!memory.aliasIndex) {
    memory.aliasIndex = {};
  }

  // 获取或创建主角色
  let primaryChar = memory.characters[primaryName];
  if (!primaryChar) {
    primaryChar = {
      primaryName,
      aliases: [],
      originalNames: [],
      nameVariants: []
    };
  }

  // 合并别名角色的信息到主角色
  for (const alias of aliasNames) {
    // 添加到别名列表
    if (!primaryChar.aliases.includes(alias)) {
      primaryChar.aliases.push(alias);
    }

    // 如果别名之前作为独立角色存在，合并其信息
    const aliasChar = memory.characters[alias];
    if (aliasChar) {
      // 合并性别（优先保留已有的）
      if (!primaryChar.gender && aliasChar.gender) {
        primaryChar.gender = aliasChar.gender;
      }
      // 合并特征
      if (aliasChar.traits) {
        primaryChar.traits = [...new Set([...(primaryChar.traits || []), ...aliasChar.traits])];
      }
      // 合并关系
      if (aliasChar.relations) {
        primaryChar.relations = { ...(primaryChar.relations || {}), ...aliasChar.relations };
      }
      // 合并原文名
      if (aliasChar.originalNames) {
        primaryChar.originalNames = [...new Set([...(primaryChar.originalNames || []), ...aliasChar.originalNames])];
      }
      // 合并名称变体
      if (aliasChar.nameVariants) {
        for (const variant of aliasChar.nameVariants) {
          if (!primaryChar.nameVariants.some(v => v.original === variant.original)) {
            primaryChar.nameVariants.push(variant);
          }
        }
      }
      // 删除独立的别名角色
      delete memory.characters[alias];
    }

    // 更新别名索引
    memory.aliasIndex[alias] = primaryName;
  }

  // 更新主角色
  memory.characters[primaryName] = primaryChar;
  
  return memory;
}

/**
 * 通过任意名称查找角色主名称
 */
export function findPrimaryName(memory: WorkMemory, anyName: string): string | null {
  // 直接就是主名称
  if (memory.characters[anyName]) {
    return anyName;
  }
  // 通过别名索引查找
  if (memory.aliasIndex && memory.aliasIndex[anyName]) {
    return memory.aliasIndex[anyName];
  }
  return null;
}

/**
 * 为角色添加名称变体
 */
export function addNameVariant(
  memory: WorkMemory,
  characterName: string,
  variant: NameVariant
): WorkMemory {
  // 找到角色的主名称
  const primaryName = findPrimaryName(memory, characterName) || characterName;
  
  // 确保角色存在
  if (!memory.characters[primaryName]) {
    memory.characters[primaryName] = {
      primaryName,
      aliases: [],
      originalNames: [],
      nameVariants: []
    };
  }
  
  const char = memory.characters[primaryName];
  
  // 检查是否已存在
  if (!char.nameVariants.some(v => v.original === variant.original)) {
    char.nameVariants.push(variant);
  }
  
  // 同时添加到简单映射（向后兼容）
  memory.nameMappings[variant.original] = variant.translation;
  
  return memory;
}

/**
 * 更新角色信息
 */
export async function updateCharacter(
  workId: string,
  characterName: string,
  info: Partial<{
    original?: string;
    gender?: string;
    traits?: string[];
    relations?: Record<string, string>;
  }>
): Promise<void> {
  const memory = await getWorkMemory(workId);
  if (!memory) return;
  
  const existing = memory.characters[characterName] || {};
  memory.characters[characterName] = {
    ...existing,
    ...info,
    traits: info.traits 
      ? [...new Set([...(existing.traits || []), ...info.traits])]
      : existing.traits
  };
  
  await saveWorkMemory(memory);
}

/**
 * 更新名称映射
 */
export async function updateNameMapping(
  workId: string,
  original: string,
  translated: string
): Promise<void> {
  const memory = await getWorkMemory(workId);
  if (!memory) return;
  
  memory.nameMappings[original] = translated;
  await saveWorkMemory(memory);
}

/**
 * 批量更新记忆
 */
// 合并记忆的输入数据结构
export interface MergeMemoryData {
  characters?: Record<string, { gender?: string; traits?: string[] }>;
  nameMappings?: Record<string, string>;
  style?: string;
  // 新增：身份合并信息
  identityMerges?: Array<{
    primaryName: string;
    aliases: string[];
  }>;
  // 新增：名称变体（带归属）
  nameVariants?: Array<{
    original: string;
    translation: string;
    belongsTo: string;  // 属于哪个角色
    type: NameVariantType;
  }>;
}

export async function mergeMemory(
  workId: string,
  newData: MergeMemoryData
): Promise<WorkMemory> {
  let memory = await getWorkMemory(workId);
  
  if (!memory) {
    memory = createWorkMemory(workId);
  }
  
  // 确保aliasIndex存在（兼容旧数据）
  if (!memory.aliasIndex) {
    memory.aliasIndex = {};
  }
  
  // 1. 先处理身份合并（这样后续的角色信息会合并到正确的角色）
  if (newData.identityMerges) {
    for (const merge of newData.identityMerges) {
      memory = mergeCharacterIdentities(memory, merge.primaryName, merge.aliases);
    }
  }
  
  // 2. 合并角色信息
  if (newData.characters) {
    for (const [name, info] of Object.entries(newData.characters)) {
      // 检查是否是已知角色的别名
      const primaryName = findPrimaryName(memory, name) || name;
      
      // 获取或创建角色
      let existing = memory.characters[primaryName];
      if (!existing) {
        existing = {
          primaryName,
          aliases: [],
          originalNames: [],
          nameVariants: []
        };
      }
      
      // 合并信息
      memory.characters[primaryName] = {
        ...existing,
        gender: info.gender || existing.gender,
        traits: info.traits
          ? [...new Set([...(existing.traits || []), ...info.traits])]
          : existing.traits
      };
    }
  }
  
  // 3. 处理名称变体（带归属）
  if (newData.nameVariants) {
    for (const variant of newData.nameVariants) {
      memory = addNameVariant(memory, variant.belongsTo, {
        original: variant.original,
        translation: variant.translation,
        type: variant.type
      });
    }
  }
  
  // 4. 合并简单名称映射
  if (newData.nameMappings) {
    memory.nameMappings = {
      ...memory.nameMappings,
      ...newData.nameMappings
    };
  }
  
  // 5. 更新风格
  if (newData.style) {
    memory.style = newData.style;
  }
  
  await saveWorkMemory(memory);
  return memory;
}

/**
 * 获取所有作品记忆（按最后访问时间排序）
 */
export async function getAllMemories(): Promise<WorkMemory[]> {
  const database = await initDB();
  const all = await database.getAllFromIndex('memories', 'by-lastVisited');
  return all.reverse(); // 最近的在前
}

/**
 * 删除作品记忆
 */
export async function deleteWorkMemory(workId: string): Promise<void> {
  const database = await initDB();
  await database.delete('memories', workId);
}

/**
 * 清理旧记忆（保留最近N个）
 */
export async function cleanupOldMemories(keepCount: number = 100): Promise<number> {
  const all = await getAllMemories();
  
  if (all.length <= keepCount) {
    return 0;
  }
  
  const toDelete = all.slice(keepCount);
  const database = await initDB();
  
  for (const memory of toDelete) {
    await database.delete('memories', memory.workId);
  }
  
  return toDelete.length;
}

/**
 * 获取存储统计
 */
export async function getStorageStats(): Promise<{
  totalWorks: number;
  totalCharacters: number;
  totalNameMappings: number;
}> {
  const all = await getAllMemories();
  
  let totalCharacters = 0;
  let totalNameMappings = 0;
  
  for (const memory of all) {
    totalCharacters += Object.keys(memory.characters).length;
    totalNameMappings += Object.keys(memory.nameMappings).length;
  }
  
  return {
    totalWorks: all.length,
    totalCharacters,
    totalNameMappings
  };
}

