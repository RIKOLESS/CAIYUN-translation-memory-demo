/**
 * 批量翻译服务
 * 支持全文自动裁切、循环翻译、记忆学习、日志记录
 */

import { splitTextIntoChunks, ChunkInfo, SplitOptions } from '../utils/textSplitter';
import { translate, TargetLanguage, TokenUsage, getTokenStats, resetTokenStats, TokenStats } from './llmService';
import { getMemoryContext, learnFromTranslation, LearnResult } from './memoryAgent';
import { getWorkMemory } from '../storage/indexedDB';

// 批量翻译状态
export type BatchStatus = 'idle' | 'running' | 'paused' | 'error' | 'completed';

// 单轮日志
export interface RoundLog {
  round: number;
  timestamp: Date;
  inputChars: number;
  outputChars: number;
  memoryBefore: { characters: number; nameMappings: number };
  memoryAfter: { characters: number; nameMappings: number };
  learnedItems: string[];  // AI学习日志
  duration: number;        // 耗时（毫秒）
  error?: string;
  retried?: boolean;       // 是否重试过
  skipped?: boolean;       // 是否跳过（失败后）
  tokenUsage?: {           // Token 使用
    translation?: TokenUsage;
    memory?: TokenUsage;
  };
}

// 批量翻译结果
export interface BatchResult {
  status: BatchStatus;
  totalChunks: number;
  completedChunks: number;
  translatedText: string;
  logs: RoundLog[];
  startTime?: Date;
  endTime?: Date;
  error?: {
    round: number;
    message: string;
  };
  tokenStats?: TokenStats;  // 总 Token 统计
}

// 批量翻译配置
export interface BatchConfig {
  workId: string;
  targetLanguage: TargetLanguage;
  terminology: Record<string, string>;
  enableLearning: boolean;
  splitOptions?: SplitOptions;
}

// 进度回调
export type ProgressCallback = (
  current: number,
  total: number,
  currentChunk: ChunkInfo,
  currentTranslation: string,
  log: RoundLog
) => void;

// 控制器（用于暂停/停止）
export interface BatchController {
  pause: () => void;
  resume: () => void;
  stop: () => void;
  isPaused: () => boolean;
  isStopped: () => boolean;
}

/**
 * 创建批量翻译控制器
 */
export function createBatchController(): BatchController {
  let paused = false;
  let stopped = false;
  
  return {
    pause: () => { paused = true; },
    resume: () => { paused = false; },
    stop: () => { stopped = true; },
    isPaused: () => paused,
    isStopped: () => stopped
  };
}

/**
 * 执行批量翻译
 */
export async function batchTranslate(
  text: string,
  config: BatchConfig,
  controller: BatchController,
  onProgress?: ProgressCallback
): Promise<BatchResult> {
  // 重置 token 统计
  resetTokenStats();
  
  const result: BatchResult = {
    status: 'running',
    totalChunks: 0,
    completedChunks: 0,
    translatedText: '',
    logs: [],
    startTime: new Date()
  };
  
  try {
    // 1. 裁切文本
    const chunks = splitTextIntoChunks(text, config.splitOptions);
    result.totalChunks = chunks.length;
    
    if (chunks.length === 0) {
      result.status = 'completed';
      result.endTime = new Date();
      return result;
    }
    
    // 2. 循环翻译每个块
    const translatedParts: string[] = [];
    
    for (let i = 0; i < chunks.length; i++) {
      // 检查是否停止
      if (controller.isStopped()) {
        result.status = 'error';
        result.error = { round: i + 1, message: '用户手动停止' };
        break;
      }
      
      // 检查是否暂停
      while (controller.isPaused() && !controller.isStopped()) {
        await sleep(500);
      }
      
      const chunk = chunks[i];
      const roundStartTime = Date.now();
      const MAX_RETRIES = 1;  // 最多重试1次（共2次尝试）
      
      // 获取翻译前的记忆状态
      const memoryBefore = await getMemoryStats(config.workId);
      
      // 记录本轮开始时的 token 统计
      const tokenStatsBefore = getTokenStats();
      
      let translateSuccess = false;
      let translatedText = '';
      let lastError: string | undefined;
      let retried = false;
      
      // 重试逻辑
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          // 获取相关记忆（智能过滤）
          const memoryContext = await getMemoryContext(config.workId, chunk.text);
          
          // 执行翻译
          const translateResult = await translate(
            chunk.text,
            config.terminology,
            memoryContext,
            config.targetLanguage,
            config.workId  // 火山引擎缓存用
          );
          
          translatedText = translateResult.translation;
          
          // 检测重复循环（>30个连续相同字符）
          if (hasRepetitionLoop(translatedText)) {
            if (attempt < MAX_RETRIES) {
              // 检测到重复，重试一次
              retried = true;
              lastError = '检测到重复输出循环，重试中...';
              await sleep(1000);
              continue;  // 继续下一次尝试
            }
            // 已重试但仍有重复，接受结果（可能原文就重复）
          }
          
          translateSuccess = true;
          
          if (attempt > 0) {
            retried = true;  // 标记为重试成功
          }
          break;  // 成功则跳出重试循环
          
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          
          if (attempt < MAX_RETRIES) {
            // 等待1秒后重试
            retried = true;
            await sleep(1000);
          }
        }
      }
      
      // 处理结果
      let learnedItems: string[] = [];
      let memoryAfter = memoryBefore;
      
      if (translateSuccess) {
        // 翻译成功
        translatedParts.push(translatedText);
        
        // 学习新内容
        if (config.enableLearning) {
          try {
            const learnResult = await learnFromTranslation(
              config.workId,
              chunk.text,
              translatedText,
              { useAI: true }
            );
            learnedItems = learnResult.logs;
            memoryAfter = await getMemoryStats(config.workId);
          } catch (learnError) {
            // 学习失败不影响翻译结果
            learnedItems = [`⚠️ 学习失败: ${learnError instanceof Error ? learnError.message : String(learnError)}`];
          }
        }
        
        // 计算本轮的 token 使用
        const tokenStatsAfter = getTokenStats();
        const roundTokenUsage = {
          translation: {
            prompt_tokens: tokenStatsAfter.translation.prompt_tokens - tokenStatsBefore.translation.prompt_tokens,
            completion_tokens: tokenStatsAfter.translation.completion_tokens - tokenStatsBefore.translation.completion_tokens,
            total_tokens: tokenStatsAfter.translation.total_tokens - tokenStatsBefore.translation.total_tokens,
            cached_tokens: tokenStatsAfter.translation.cached_tokens - tokenStatsBefore.translation.cached_tokens
          },
          memory: {
            prompt_tokens: tokenStatsAfter.memory.prompt_tokens - tokenStatsBefore.memory.prompt_tokens,
            completion_tokens: tokenStatsAfter.memory.completion_tokens - tokenStatsBefore.memory.completion_tokens,
            total_tokens: tokenStatsAfter.memory.total_tokens - tokenStatsBefore.memory.total_tokens,
            cached_tokens: tokenStatsAfter.memory.cached_tokens - tokenStatsBefore.memory.cached_tokens
          }
        };
        
        // 记录日志
        const roundLog: RoundLog = {
          round: i + 1,
          timestamp: new Date(),
          inputChars: chunk.charCount,
          outputChars: translatedText.length,
          memoryBefore,
          memoryAfter,
          learnedItems: retried ? [`⚠️ 重试后成功${lastError?.includes('重复') ? '（检测到重复循环）' : ''}`, ...learnedItems] : learnedItems,
          duration: Date.now() - roundStartTime,
          retried,
          tokenUsage: roundTokenUsage
        };
        
        result.logs.push(roundLog);
        result.completedChunks = i + 1;
        result.translatedText = translatedParts.join('\n\n');
        
        if (onProgress) {
          onProgress(i + 1, chunks.length, chunk, translatedText, roundLog);
        }
        
      } else {
        // 翻译失败，跳过该轮次
        const skippedText = `[第${i + 1}轮翻译失败已跳过]`;
        translatedParts.push(skippedText);
        
        const roundLog: RoundLog = {
          round: i + 1,
          timestamp: new Date(),
          inputChars: chunk.charCount,
          outputChars: 0,
          memoryBefore,
          memoryAfter: memoryBefore,
          learnedItems: [`❌ 重试后仍失败，已跳过`],
          duration: Date.now() - roundStartTime,
          error: lastError,
          retried: true,
          skipped: true
        };
        
        result.logs.push(roundLog);
        result.completedChunks = i + 1;
        result.translatedText = translatedParts.join('\n\n');
        
        if (onProgress) {
          onProgress(i + 1, chunks.length, chunk, skippedText, roundLog);
        }
        
        // 不再 break，继续下一轮
      }
    }
    
    // 完成
    if (result.status === 'running') {
      result.status = 'completed';
    }
    
  } catch (error) {
    result.status = 'error';
    result.error = {
      round: 0,
      message: error instanceof Error ? error.message : String(error)
    };
  }
  
  result.endTime = new Date();
  result.tokenStats = getTokenStats();
  return result;
}

/**
 * 获取记忆统计
 */
async function getMemoryStats(workId: string): Promise<{ characters: number; nameMappings: number }> {
  const memory = await getWorkMemory(workId);
  if (!memory) {
    return { characters: 0, nameMappings: 0 };
  }
  return {
    characters: Object.keys(memory.characters).length,
    nameMappings: Object.keys(memory.nameMappings).length
  };
}

/**
 * 格式化日志为文本
 */
export function formatLogsToText(
  result: BatchResult,
  config: BatchConfig
): string {
  const lines: string[] = [];
  
  const skippedCount = result.logs.filter(l => l.skipped).length;
  const retriedCount = result.logs.filter(l => l.retried && !l.skipped).length;
  
  lines.push('========================================');
  lines.push('批量翻译日志');
  lines.push(`作品ID: ${config.workId}`);
  lines.push(`目标语言: ${config.targetLanguage === 'zh' ? '中文' : config.targetLanguage === 'en' ? 'English' : '日本語'}`);
  lines.push(`开始时间: ${result.startTime?.toLocaleString()}`);
  lines.push(`结束时间: ${result.endTime?.toLocaleString()}`);
  lines.push(`总轮次: ${result.totalChunks} | 完成: ${result.completedChunks}${skippedCount > 0 ? ` | 跳过: ${skippedCount}` : ''}${retriedCount > 0 ? ` | 重试成功: ${retriedCount}` : ''}`);
  lines.push(`状态: ${result.status === 'completed' ? '✅ 完成' : result.status === 'error' ? '❌ 出错' : result.status}`);
  lines.push('========================================');
  lines.push('');
  
  for (const log of result.logs) {
    let statusIcon = '✅';
    if (log.skipped) {
      statusIcon = '❌ [已跳过]';
    } else if (log.retried) {
      statusIcon = '⚠️ [重试成功]';
    }
    
    lines.push(`=== 第 ${log.round} 轮 (${log.round}/${result.totalChunks}) ${statusIcon} ===`);
    lines.push(`[${log.timestamp.toLocaleTimeString()}] 输入: ${log.inputChars} 字符`);
    lines.push(`[${log.timestamp.toLocaleTimeString()}] 输出: ${log.outputChars} 字符`);
    lines.push(`[${log.timestamp.toLocaleTimeString()}] 耗时: ${(log.duration / 1000).toFixed(1)}s`);
    
    if (log.learnedItems.length > 0) {
      lines.push(`[${log.timestamp.toLocaleTimeString()}] 学习记忆:`);
      for (const item of log.learnedItems) {
        lines.push(`  ${item}`);
      }
    }
    
    const charDiff = log.memoryAfter.characters - log.memoryBefore.characters;
    const mapDiff = log.memoryAfter.nameMappings - log.memoryBefore.nameMappings;
    lines.push(`[${log.timestamp.toLocaleTimeString()}] 记忆变化: 角色 ${log.memoryBefore.characters}→${log.memoryAfter.characters} (+${charDiff}), 映射 ${log.memoryBefore.nameMappings}→${log.memoryAfter.nameMappings} (+${mapDiff})`);
    
    if (log.error) {
      lines.push(`[${log.timestamp.toLocaleTimeString()}] ❌ 错误: ${log.error}`);
    }
    
    lines.push('');
  }
  
  if (result.error) {
    lines.push('========================================');
    lines.push(`❌ 翻译在第 ${result.error.round} 轮出错: ${result.error.message}`);
    lines.push('========================================');
  }
  
  // 最终统计
  const totalDuration = result.logs.reduce((sum, l) => sum + l.duration, 0);
  const finalMemory = result.logs.length > 0 
    ? result.logs[result.logs.length - 1].memoryAfter 
    : { characters: 0, nameMappings: 0 };
  
  lines.push('========================================');
  lines.push('翻译完成');
  lines.push(`总耗时: ${(totalDuration / 1000 / 60).toFixed(1)} 分钟`);
  lines.push(`最终记忆: 角色 ${finalMemory.characters} 个, 映射 ${finalMemory.nameMappings} 条`);
  
  // Token 统计
  if (result.tokenStats) {
    const ts = result.tokenStats;
    lines.push('');
    lines.push('--- Token 统计 ---');
    lines.push(`翻译Agent: 输入 ${ts.translation.prompt_tokens.toLocaleString()} | 输出 ${ts.translation.completion_tokens.toLocaleString()} | 缓存 ${ts.translation.cached_tokens.toLocaleString()} | 调用 ${ts.translation.calls} 次`);
    lines.push(`记忆Agent: 输入 ${ts.memory.prompt_tokens.toLocaleString()} | 输出 ${ts.memory.completion_tokens.toLocaleString()} | 缓存 ${ts.memory.cached_tokens.toLocaleString()} | 调用 ${ts.memory.calls} 次`);
    const totalTokens = ts.translation.total_tokens + ts.memory.total_tokens;
    const totalCached = ts.translation.cached_tokens + ts.memory.cached_tokens;
    lines.push(`总计: ${totalTokens.toLocaleString()} tokens (缓存命中 ${totalCached.toLocaleString()})`);
  }
  
  lines.push('========================================');
  
  return lines.join('\n');
}

/**
 * 下载文本文件
 */
export function downloadTextFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * 睡眠函数
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 检测是否存在重复循环
 * 覆盖以下情况：
 * 1. 连续相同字符 >30 次：我我我我我...
 * 2. 空格/换行分隔的重复 >15 次：我 我 我 我... 或 我\n我\n我\n我...
 */
function hasRepetitionLoop(text: string): boolean {
  // 1. 原有检测：连续相同字符 >30 次
  if (/(.)\1{30,}/.test(text)) return true;
  
  // 2. 去除空白字符后，连续相同字符 >30 次
  const textNoWhitespace = text.replace(/\s/g, '');
  if (/(.)\1{30,}/.test(textNoWhitespace)) return true;
  
  // 3. 相同字符+空白的模式重复 >15 次（如 "我 我 我 我" 或 "我\n我\n我"）
  if (/(.)[\s]+\1(?:[\s]+\1){14,}/.test(text)) return true;
  
  return false;
}

