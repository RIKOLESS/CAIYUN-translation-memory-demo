/**
 * LLM 服务
 * 支持 DeepSeek / 豆包 / OpenAI兼容API
 */

export interface LLMConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  provider: 'deepseek' | 'doubao' | 'openai';
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// 预设配置
const PROVIDER_CONFIGS = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat'
  },
  doubao: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'ep-xxxxxxxx'  // 需要用户填入endpoint ID
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-3.5-turbo'
  }
};

// 默认使用DeepSeek
const DEFAULT_CONFIG: LLMConfig = {
  apiKey: 'sk-007c40d890014fe0b57b5ab95c96e8c2',
  model: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com/v1',
  provider: 'deepseek'
};

let config: LLMConfig = { ...DEFAULT_CONFIG };

export function setLLMConfig(newConfig: Partial<LLMConfig>) {
  // 如果切换了provider，自动更新baseUrl和model
  if (newConfig.provider && newConfig.provider !== config.provider) {
    const preset = PROVIDER_CONFIGS[newConfig.provider];
    config = {
      ...config,
      baseUrl: preset.baseUrl,
      model: preset.model,
      ...newConfig
    };
  } else {
    config = { ...config, ...newConfig };
  }
}

export function getLLMConfig(): LLMConfig {
  return { ...config };
}

export function getProviderConfigs() {
  return PROVIDER_CONFIGS;
}

/**
 * 调用LLM API进行对话
 */
export async function chat(messages: ChatMessage[]): Promise<string> {
  if (!config.apiKey) {
    throw new Error('请先在设置中配置API Key');
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages: messages,
      temperature: 0.3,  // 翻译任务用较低温度
      max_tokens: 4096
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API调用失败: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

// 翻译用的角色信息（增强版）
export interface TranslateCharacterInfo {
  gender?: string;
  traits?: string[];
  aliases?: string[];           // 别名列表
  nameVariants?: Array<{        // 名称变体
    original: string;
    translation: string;
    type: string;
  }>;
}

// 支持的目标语言
export type TargetLanguage = 'zh' | 'en' | 'ja';

export const TARGET_LANGUAGE_LABELS: Record<TargetLanguage, string> = {
  zh: '中文',
  en: 'English',
  ja: '日本語'
};

// ============================================
// Prompt 路由：根据目标语言使用不同语言的 Prompt
// ============================================

/**
 * 构建中文翻译Prompt（目标语言为中文时使用）
 */
function buildChinesePrompt(
  terminology: Record<string, string>,
  memory: {
    characters: Record<string, TranslateCharacterInfo>;
    nameMappings: Record<string, string>;
    style?: string;
  }
): string {
  let prompt = `你是专业的小说翻译专家，擅长将各种语言的小说翻译成流畅自然的中文。

## 核心原则
- 忠实原文：不私自添加或省略任何内容
- 风格一致：严格遵循原文的写作风格和语气
- 受众适配：根据原文的领域和目标受众使用适当的翻译风格

## 翻译要求
1. 保持原文的叙事节奏、句式结构和修辞手法
2. 对话翻译要符合角色性格和说话习惯
3. 人名、地名等专有名词翻译保持前后一致
4. 注意角色性别，使用正确的人称代词
5. 注意：有些角色有多重身份/别名，虽然名字不同但是同一个人
6. 保留原文的情感色彩和文学性，不要过度意译或简化

## 目标语言特殊要求
- 中文翻译要符合中文读者的阅读习惯
- 对话使用中文标点符号（「」或""）
- 敬语和称谓要符合中文表达习惯`;

  // 添加术语库和记忆信息
  prompt += buildContextSection(terminology, memory, 'zh');

  prompt += `\n\n## 输出要求
- 直接输出翻译结果，不要添加任何解释、注释或说明
- 不要在译文中添加原文没有的内容
- 不要省略原文中的任何内容`;

  return prompt;
}

/**
 * 构建英文翻译Prompt（目标语言为英文时使用）
 * 整个prompt用英文写，让模型保持英文思维
 */
function buildEnglishPrompt(
  terminology: Record<string, string>,
  memory: {
    characters: Record<string, TranslateCharacterInfo>;
    nameMappings: Record<string, string>;
    style?: string;
  }
): string {
  let prompt = `You are a professional novel translator specializing in translating novels from any language into fluent, natural English.

## Core Principles
- Faithfulness: Do not add or omit any content
- Consistency: Strictly follow the original writing style and tone
- Audience adaptation: Use appropriate translation style based on the genre and target audience

## Translation Requirements
1. Maintain the narrative rhythm, sentence structure, and rhetorical devices of the original
2. Dialogue should match character personality and speech patterns
3. Keep translations of names and places consistent throughout
4. Pay attention to character gender, use correct pronouns
5. Note: Some characters have multiple identities/aliases - different names may refer to the same person
6. Preserve the emotional color and literary quality, avoid over-interpretation or simplification

## CRITICAL - Language Purity
- The translation MUST be entirely in English
- ALL names (personal, place, organization) MUST be translated or transliterated to English
- Do NOT keep any Chinese/Japanese/Korean characters in the output
- Even proper nouns must be romanized or translated`;

  // 添加术语库和记忆信息
  prompt += buildContextSection(terminology, memory, 'en');

  prompt += `\n\n## Output Requirements
- Output only the translation, no explanations or notes
- Do not add content not in the original
- Do not omit any content from the original`;

  return prompt;
}

/**
 * 构建日文翻译Prompt（目标语言为日文时使用）
 * 整个prompt用日文写，让模型保持日文思维
 */
function buildJapanesePrompt(
  terminology: Record<string, string>,
  memory: {
    characters: Record<string, TranslateCharacterInfo>;
    nameMappings: Record<string, string>;
    style?: string;
  }
): string {
  let prompt = `あなたはプロの小説翻訳者であり、あらゆる言語の小説を流暢で自然な日本語に翻訳することを専門としています。

## 基本原則
- 原文に忠実：内容を勝手に追加したり省略したりしない
- スタイル一貫性：原文の文体とトーンを厳密に守る
- 読者適応：ジャンルとターゲット読者に適した翻訳スタイルを使用

## 翻訳要件
1. 原文の語りのリズム、文構造、修辞技法を維持する
2. 会話はキャラクターの性格と話し方に合わせる
3. 人名・地名などの固有名詞は一貫して翻訳する
4. キャラクターの性別に注意し、正しい人称代名詞を使用する
5. 注意：一部のキャラクターは複数のアイデンティティ/別名を持つ - 異なる名前が同一人物を指す場合がある
6. 感情的な色彩と文学性を保持し、過度な意訳や簡略化を避ける

## 重要 - 言語の純粋性
- 翻訳は完全に日本語でなければならない
- すべての名前（人名、地名、組織名）は日本語に翻訳または音訳する必要がある
- 出力に中国語/韓国語の文字を残さないこと
- 固有名詞もカタカナ表記または翻訳すること`;

  // 添加术语库和记忆信息
  prompt += buildContextSection(terminology, memory, 'ja');

  prompt += `\n\n## 出力要件
- 翻訳のみを出力し、説明や注釈は不要
- 原文にない内容を追加しない
- 原文の内容を省略しない`;

  return prompt;
}

/**
 * 构建上下文信息部分（术语库、记忆等）
 * 这部分用目标语言写标题，内容保持原样（因为是数据）
 */
function buildContextSection(
  terminology: Record<string, string>,
  memory: {
    characters: Record<string, TranslateCharacterInfo>;
    nameMappings: Record<string, string>;
    style?: string;
  },
  lang: TargetLanguage
): string {
  let section = '';
  
  const labels = {
    zh: {
      terminology: '【术语库 - 必须严格遵守以下翻译】',
      nameMappings: '【已学习的名称翻译 - 保持一致】',
      characters: '【角色信息】',
      style: '【文章风格】',
      aliases: '别名/化名',
      samePersonNote: '均为同一人',
      variants: '名称变体',
      traits: '特征'
    },
    en: {
      terminology: '【Terminology - MUST follow these translations strictly】',
      nameMappings: '【Learned Name Translations - Keep Consistent】',
      characters: '【Character Information】',
      style: '【Writing Style】',
      aliases: 'Aliases',
      samePersonNote: 'all same person',
      variants: 'Name variants',
      traits: 'Traits'
    },
    ja: {
      terminology: '【用語集 - 以下の翻訳を厳守すること】',
      nameMappings: '【学習済み名前翻訳 - 一貫性を保つ】',
      characters: '【キャラクター情報】',
      style: '【文章スタイル】',
      aliases: '別名',
      samePersonNote: 'すべて同一人物',
      variants: '名前バリエーション',
      traits: '特徴'
    }
  };
  
  const l = labels[lang];

  if (Object.keys(terminology).length > 0) {
    section += `\n\n${l.terminology}\n`;
    for (const [original, translated] of Object.entries(terminology)) {
      section += `- "${original}" → "${translated}"\n`;
    }
  }

  if (Object.keys(memory.nameMappings).length > 0) {
    section += `\n\n${l.nameMappings}\n`;
    for (const [original, translated] of Object.entries(memory.nameMappings)) {
      section += `- "${original}" → "${translated}"\n`;
    }
  }

  if (Object.keys(memory.characters).length > 0) {
    section += `\n\n${l.characters}\n`;
    for (const [name, info] of Object.entries(memory.characters)) {
      let charInfo = `- ${name}`;
      if (info.gender) {
        const genderMap: Record<string, Record<string, string>> = {
          zh: { '男': '男', '女': '女', '未知': '未知' },
          en: { '男': 'Male', '女': 'Female', '未知': 'Unknown' },
          ja: { '男': '男性', '女': '女性', '未知': '不明' }
        };
        charInfo += ` (${genderMap[lang][info.gender] || info.gender})`;
      }
      
      if (info.aliases && info.aliases.length > 0) {
        charInfo += `\n  ${l.aliases}: ${info.aliases.join(', ')} (${l.samePersonNote})`;
      }
      
      if (info.nameVariants && info.nameVariants.length > 0) {
        charInfo += `\n  ${l.variants}: `;
        for (const v of info.nameVariants) {
          charInfo += `${v.original}→${v.translation}(${v.type}) `;
        }
      }
      
      if (info.traits && info.traits.length > 0) {
        charInfo += `\n  ${l.traits}: ${info.traits.join(', ')}`;
      }
      section += charInfo + '\n';
    }
  }

  if (memory.style) {
    section += `\n\n${l.style}\n${memory.style}`;
  }

  return section;
}

/**
 * 翻译文本
 * 使用 Prompt 路由：根据目标语言选择对应语言的 Prompt
 */
export async function translate(
  text: string,
  terminology: Record<string, string>,
  memory: {
    characters: Record<string, TranslateCharacterInfo>;
    nameMappings: Record<string, string>;
    style?: string;
  },
  targetLanguage: TargetLanguage = 'zh'
): Promise<{ translation: string; rawResponse: string }> {
  
  // Prompt 路由：根据目标语言选择对应的 Prompt
  let systemPrompt: string;
  let userPrompt: string;
  
  switch (targetLanguage) {
    case 'en':
      systemPrompt = buildEnglishPrompt(terminology, memory);
      userPrompt = `Please translate the following text into English:\n\n${text}`;
      break;
    case 'ja':
      systemPrompt = buildJapanesePrompt(terminology, memory);
      userPrompt = `以下のテキストを日本語に翻訳してください：\n\n${text}`;
      break;
    case 'zh':
    default:
      systemPrompt = buildChinesePrompt(terminology, memory);
      userPrompt = `请翻译以下内容：\n\n${text}`;
      break;
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  const response = await chat(messages);
  
  return {
    translation: response.trim(),
    rawResponse: response
  };
}

/**
 * 增强版记忆提取结果
 */
export interface ExtractedMemory {
  // 角色基本信息
  newCharacters: Record<string, { gender?: string; traits?: string[] }>;
  // 简单名称映射（向后兼容）
  newNameMappings: Record<string, string>;
  // 【新增】多重身份识别
  identityMerges: Array<{
    primaryName: string;      // 主名称/真名
    aliases: string[];        // 别名列表
    reason: string;           // 识别原因
  }>;
  // 【新增】名称变体（带归属）
  nameVariants: Array<{
    original: string;         // 原文（如：Rei）
    translation: string;      // 译文（如：零）
    belongsTo: string;        // 属于哪个角色
    type: 'fullName' | 'firstName' | 'lastName' | 'nickname' | 'codename' | 'title';
    reason: string;           // 识别原因
  }>;
  // 风格
  style?: string;
}

/**
 * 提取记忆信息（记忆Agent的学习功能）- 增强版
 * 自动识别多重身份和名称归属
 */
export async function extractMemory(
  originalText: string,
  translatedText: string,
  existingMemory: {
    characters: Record<string, unknown>;
    nameMappings: Record<string, string>;
    aliasIndex?: Record<string, string>;
  }
): Promise<ExtractedMemory> {
  
  const systemPrompt = `你是专业的小说信息提取专家，擅长分析角色身份和名称关系。

## 核心任务

### 1. 多重身份识别【重要】
识别同一个角色的不同名字/身份，例如：
- "安室透，本名降谷零" → 降谷零是真名，安室透是化名
- "他的代号是波本" → 波本是某人的代号
- 同一人在不同场景用不同名字
- AO3标签格式 "A | B" 表示同一人

### 2. 名称归属识别【重要】
识别名字属于哪个角色：
- "Rei" 是 "降谷零" 的名字（"零"的读音）
- "Shuichi" 是 "赤井秀一" 的名字（"秀一"的读音）
- 区分：姓(lastName)、名(firstName)、昵称(nickname)、代号(codename)、头衔(title)

### 3. 基本信息提取
- 角色性别（根据he/she、先生/小姐等判断）
- 角色性格特征
- 名称翻译对应

## 已知信息
${JSON.stringify(existingMemory, null, 2)}

## 输出格式（严格JSON）
{
  "newCharacters": {
    "角色译名": { "gender": "男/女/未知", "traits": ["特征"] }
  },
  "newNameMappings": {
    "原文": "译文"
  },
  "identityMerges": [
    {
      "primaryName": "真名/主名称",
      "aliases": ["别名1", "别名2"],
      "reason": "识别原因"
    }
  ],
  "nameVariants": [
    {
      "original": "原文名",
      "translation": "译文名",
      "belongsTo": "所属角色主名称",
      "type": "firstName/lastName/nickname/codename/title",
      "reason": "识别原因"
    }
  ],
  "style": "文章风格（可选）"
}

## 注意
1. 只输出JSON，不要其他内容
2. 没有新信息则对应字段返回空数组/对象
3. 多重身份判断要有明确依据
4. 名称归属要准确关联到角色`;

  const userPrompt = `请分析以下原文和译文：

【原文】
${originalText}

【译文】
${translatedText}`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  try {
    const response = await chat(messages);
    
    // 尝试解析JSON
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        newCharacters: parsed.newCharacters || {},
        newNameMappings: parsed.newNameMappings || {},
        identityMerges: parsed.identityMerges || [],
        nameVariants: parsed.nameVariants || [],
        style: parsed.style
      };
    }
  } catch (error) {
    console.error('记忆提取失败:', error);
  }

  return {
    newCharacters: {},
    newNameMappings: {},
    identityMerges: [],
    nameVariants: []
  };
}

