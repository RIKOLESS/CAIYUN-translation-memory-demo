/**
 * 批量翻译服务
 * 支持全文自动裁切、循环翻译、记忆学习、日志记录
 */

import { splitTextIntoChunks, ChunkInfo, SplitOptions } from '../utils/textSplitter';
import { translate, TargetLanguage } from './llmService';
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
      
      try {
        // 获取翻译前的记忆状态
        const memoryBefore = await getMemoryStats(config.workId);
        
        // 获取相关记忆（智能过滤）
        const memoryContext = await getMemoryContext(config.workId, chunk.text);
        
        // 执行翻译
        const translateResult = await translate(
          chunk.text,
          config.terminology,
          memoryContext,
          config.targetLanguage
        );
        
        translatedParts.push(translateResult.translation);
        
        // 学习新内容
        let learnedItems: string[] = [];
        let memoryAfter = memoryBefore;
        
        if (config.enableLearning) {
          const learnResult = await learnFromTranslation(
            config.workId,
            chunk.text,
            translateResult.translation,
            { useAI: true }
          );
          learnedItems = learnResult.logs;
          memoryAfter = await getMemoryStats(config.workId);
        }
        
        // 记录日志
        const roundLog: RoundLog = {
          round: i + 1,
          timestamp: new Date(),
          inputChars: chunk.charCount,
          outputChars: translateResult.translation.length,
          memoryBefore,
          memoryAfter,
          learnedItems,
          duration: Date.now() - roundStartTime
        };
        
        result.logs.push(roundLog);
        result.completedChunks = i + 1;
        result.translatedText = translatedParts.join('\n\n');
        
        // 回调进度
        if (onProgress) {
          onProgress(i + 1, chunks.length, chunk, translateResult.translation, roundLog);
        }
        
      } catch (error) {
        // 翻译出错
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        const roundLog: RoundLog = {
          round: i + 1,
          timestamp: new Date(),
          inputChars: chunk.charCount,
          outputChars: 0,
          memoryBefore: await getMemoryStats(config.workId),
          memoryAfter: await getMemoryStats(config.workId),
          learnedItems: [],
          duration: Date.now() - roundStartTime,
          error: errorMessage
        };
        
        result.logs.push(roundLog);
        result.status = 'error';
        result.error = { round: i + 1, message: errorMessage };
        result.translatedText = translatedParts.join('\n\n');
        
        if (onProgress) {
          onProgress(i + 1, chunks.length, chunk, '', roundLog);
        }
        
        break;
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
  
  lines.push('========================================');
  lines.push('批量翻译日志');
  lines.push(`作品ID: ${config.workId}`);
  lines.push(`目标语言: ${config.targetLanguage === 'zh' ? '中文' : config.targetLanguage === 'en' ? 'English' : '日本語'}`);
  lines.push(`开始时间: ${result.startTime?.toLocaleString()}`);
  lines.push(`结束时间: ${result.endTime?.toLocaleString()}`);
  lines.push(`总轮次: ${result.totalChunks} | 完成: ${result.completedChunks}`);
  lines.push(`状态: ${result.status === 'completed' ? '✅ 完成' : result.status === 'error' ? '❌ 出错' : result.status}`);
  lines.push('========================================');
  lines.push('');
  
  for (const log of result.logs) {
    lines.push(`=== 第 ${log.round} 轮 (${log.round}/${result.totalChunks}) ===`);
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

