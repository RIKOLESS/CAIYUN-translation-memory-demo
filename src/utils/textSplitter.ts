/**
 * 文本裁切工具
 * 按段落/句子边界智能裁切，保证完整性
 */

export interface ChunkInfo {
  index: number;
  text: string;
  charCount: number;
  startOffset: number;  // 在原文中的起始位置
  endOffset: number;    // 在原文中的结束位置
}

export interface SplitOptions {
  targetSize?: number;   // 目标字符数（默认2000）
  minSize?: number;      // 最小字符数（默认1200）
  maxSize?: number;      // 最大字符数（默认2500）
}

const DEFAULT_OPTIONS: Required<SplitOptions> = {
  targetSize: 2000,
  minSize: 1200,
  maxSize: 2500
};

/**
 * 将长文本裁切成多个块
 * 优先按段落边界切割，段落过长时按句子边界切割
 */
export function splitTextIntoChunks(
  text: string,
  options: SplitOptions = {}
): ChunkInfo[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const chunks: ChunkInfo[] = [];
  
  if (!text || text.trim().length === 0) {
    return [];
  }
  
  // 按段落分割（支持多种换行格式）
  const paragraphs = text.split(/\n\s*\n+/);
  
  let currentChunk = '';
  let currentStartOffset = 0;
  let processedLength = 0;
  
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i].trim();
    if (!para) continue;
    
    const paraWithBreak = (currentChunk ? '\n\n' : '') + para;
    
    // 如果当前块加上这段不超过最大值，继续累积
    if (currentChunk.length + paraWithBreak.length <= opts.maxSize) {
      currentChunk += paraWithBreak;
    } else {
      // 当前块已够大，需要决定是否保存
      
      // 如果当前块已达到最小值，保存它
      if (currentChunk.length >= opts.minSize) {
        chunks.push({
          index: chunks.length,
          text: currentChunk,
          charCount: currentChunk.length,
          startOffset: currentStartOffset,
          endOffset: currentStartOffset + currentChunk.length
        });
        currentStartOffset += currentChunk.length + 2; // +2 for \n\n
        currentChunk = para;
      } else {
        // 当前块太小，但加上新段落会超过最大值
        // 必须先保存当前块，避免合并后超限
        
        // 先保存当前块（即使小于 minSize，也不能让合并后超限）
        if (currentChunk) {
          chunks.push({
            index: chunks.length,
            text: currentChunk,
            charCount: currentChunk.length,
            startOffset: currentStartOffset,
            endOffset: currentStartOffset + currentChunk.length
          });
          currentStartOffset += currentChunk.length + 2;
        }
        
        // 处理新段落
        if (para.length > opts.maxSize) {
          // 超长段落按句子切割
          const sentenceChunks = splitBySentences(para, opts);
          for (const sc of sentenceChunks) {
            chunks.push({
              index: chunks.length,
              text: sc,
              charCount: sc.length,
              startOffset: currentStartOffset,
              endOffset: currentStartOffset + sc.length
            });
            currentStartOffset += sc.length;
          }
          currentChunk = '';
        } else {
          // 新段落作为新块的开始
          currentChunk = para;
        }
      }
    }
  }
  
  // 保存最后一块
  if (currentChunk.trim()) {
    chunks.push({
      index: chunks.length,
      text: currentChunk,
      charCount: currentChunk.length,
      startOffset: currentStartOffset,
      endOffset: currentStartOffset + currentChunk.length
    });
  }
  
  return chunks;
}

/**
 * 按句子边界切割超长段落
 */
function splitBySentences(
  text: string,
  opts: Required<SplitOptions>
): string[] {
  const chunks: string[] = [];
  
  // 匹配句子结束符（中英日）
  const sentenceEndings = /([。！？.!?…]+["」』]?)\s*/g;
  const sentences: string[] = [];
  
  let lastIndex = 0;
  let match;
  
  while ((match = sentenceEndings.exec(text)) !== null) {
    sentences.push(text.slice(lastIndex, match.index + match[0].length));
    lastIndex = match.index + match[0].length;
  }
  
  // 剩余部分
  if (lastIndex < text.length) {
    sentences.push(text.slice(lastIndex));
  }
  
  // 如果没有找到句子分隔符，强制按字符数切割
  if (sentences.length === 0) {
    return forceChunkBySize(text, opts.targetSize);
  }
  
  // 按句子累积
  let currentChunk = '';
  
  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length <= opts.maxSize) {
      currentChunk += sentence;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk);
      }
      
      // 如果单句超过最大值，强制切割
      if (sentence.length > opts.maxSize) {
        chunks.push(...forceChunkBySize(sentence, opts.targetSize));
        currentChunk = '';
      } else {
        currentChunk = sentence;
      }
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

/**
 * 强制按字符数切割（最后手段）
 */
function forceChunkBySize(text: string, size: number): string[] {
  const chunks: string[] = [];
  
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  
  return chunks;
}

/**
 * 预览切割结果（不返回完整文本，节省内存）
 */
export function previewSplit(
  text: string,
  options: SplitOptions = {}
): {
  totalChars: number;
  chunkCount: number;
  avgChunkSize: number;
  chunks: Array<{ index: number; charCount: number; preview: string }>;
} {
  const chunks = splitTextIntoChunks(text, options);
  
  return {
    totalChars: text.length,
    chunkCount: chunks.length,
    avgChunkSize: chunks.length > 0 
      ? Math.round(chunks.reduce((sum, c) => sum + c.charCount, 0) / chunks.length)
      : 0,
    chunks: chunks.map(c => ({
      index: c.index,
      charCount: c.charCount,
      preview: c.text.slice(0, 50) + (c.text.length > 50 ? '...' : '')
    }))
  };
}

