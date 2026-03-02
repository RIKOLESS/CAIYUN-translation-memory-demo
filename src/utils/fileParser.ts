/**
 * 文件解析工具
 * 支持 TXT、PDF、EPUB 格式
 */

import * as pdfjsLib from 'pdfjs-dist';
import JSZip from 'jszip';

// 设置 PDF.js worker - 使用本地 worker 文件
// @ts-ignore - Vite 会处理这个导入
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/**
 * 解析文件并提取文本内容
 */
export async function parseFile(file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  
  switch (ext) {
    case 'txt':
      return await parseTXT(file);
    case 'pdf':
      return await parsePDF(file);
    case 'epub':
      return await parseEPUB(file);
    default:
      throw new Error(`不支持的文件格式: .${ext}`);
  }
}

/**
 * 解析 TXT 文件
 */
async function parseTXT(file: File): Promise<string> {
  return await file.text();
}

/**
 * 解析 PDF 文件 - 保留换行符
 */
async function parsePDF(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  
  const textParts: string[] = [];
  
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    
    // 处理每个 text item，保留换行信息
    const lines: string[] = [];
    let currentLine = '';
    
    for (const item of textContent.items) {
      const textItem = item as { str?: string; hasEOL?: boolean };
      const str = textItem.str || '';
      
      currentLine += str;
      
      // 如果该 item 标记了行尾，或者遇到显式换行符
      if (textItem.hasEOL || str.includes('\n')) {
        lines.push(currentLine.trimEnd());
        currentLine = '';
      }
    }
    
    // 添加最后一行（如果有）
    if (currentLine.trim()) {
      lines.push(currentLine.trimEnd());
    }
    
    // 将所有行用换行符连接
    const pageText = lines.join('\n');
    if (pageText.trim()) {
      textParts.push(pageText);
    }
  }
  
  // 页面之间用双换行分隔
  return textParts.join('\n\n');
}

/**
 * 从 HTML 元素中提取文本，保留块级元素的换行
 */
function extractTextWithLineBreaks(element: Element | Document): string {
  const blockTags = new Set([
    'P', 'DIV', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'LI', 'TR', 'BLOCKQUOTE', 'PRE', 'HR', 'SECTION', 'ARTICLE',
    'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'MAIN', 'FIGURE', 'FIGCAPTION',
    // XHTML 小写标签
    'p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li', 'tr', 'blockquote', 'pre', 'hr', 'section', 'article',
    'header', 'footer', 'nav', 'aside', 'main', 'figure', 'figcaption'
  ]);
  
  const lines: string[] = [];
  let currentLine = '';
  
  function processNode(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      currentLine += text;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      const tagName = el.tagName;
      
      // 块级元素开始前，保存当前行
      if (blockTags.has(tagName)) {
        if (currentLine.trim()) {
          lines.push(currentLine.trim());
          currentLine = '';
        }
      }
      
      // BR 标签特殊处理
      if (tagName === 'BR' || tagName === 'br') {
        if (currentLine.trim()) {
          lines.push(currentLine.trim());
          currentLine = '';
        }
        return;
      }
      
      // 递归处理子节点
      for (const child of el.childNodes) {
        processNode(child);
      }
      
      // 块级元素结束后，保存当前行
      if (blockTags.has(tagName)) {
        if (currentLine.trim()) {
          lines.push(currentLine.trim());
          currentLine = '';
        }
      }
    }
  }
  
  // 获取 body 或者直接处理
  const startNode = (element as Document).body || element;
  processNode(startNode);
  
  // 添加最后一行
  if (currentLine.trim()) {
    lines.push(currentLine.trim());
  }
  
  return lines.join('\n');
}

/**
 * 解析 EPUB 文件 - 使用 JSZip 直接读取
 */
async function parseEPUB(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);
  
  // 1. 读取 container.xml 找到 OPF 文件路径
  const containerXml = await zip.file('META-INF/container.xml')?.async('text');
  if (!containerXml) {
    throw new Error('无效的 EPUB 文件：缺少 container.xml');
  }
  
  // 解析 container.xml 获取 OPF 路径
  const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
  const rootfileEl = containerDoc.querySelector('rootfile');
  const opfPath = rootfileEl?.getAttribute('full-path');
  if (!opfPath) {
    throw new Error('无效的 EPUB 文件：找不到 OPF 路径');
  }
  
  // 获取 OPF 文件所在目录（用于解析相对路径）
  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';
  
  // 2. 读取 OPF 文件
  const opfXml = await zip.file(opfPath)?.async('text');
  if (!opfXml) {
    throw new Error('无效的 EPUB 文件：找不到 OPF 文件');
  }
  
  // 解析 OPF
  const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');
  
  // 构建 manifest id -> href 映射
  const manifest = new Map<string, string>();
  const manifestItems = opfDoc.querySelectorAll('manifest > item');
  manifestItems.forEach(item => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (id && href) {
      manifest.set(id, href);
    }
  });
  
  // 获取 spine 中的阅读顺序
  const spineItems = opfDoc.querySelectorAll('spine > itemref');
  const readingOrder: string[] = [];
  spineItems.forEach(itemref => {
    const idref = itemref.getAttribute('idref');
    if (idref) {
      const href = manifest.get(idref);
      if (href) {
        readingOrder.push(href);
      }
    }
  });
  
  // 3. 按顺序读取并解析 HTML 文件
  const textParts: string[] = [];
  
  for (const href of readingOrder) {
    // 构建完整路径
    const fullPath = opfDir + href;
    
    try {
      const html = await zip.file(fullPath)?.async('text');
      if (!html) continue;
      
      // 解析 HTML/XHTML
      const doc = new DOMParser().parseFromString(html, 'application/xhtml+xml');
      
      // 检查解析错误
      const parseError = doc.querySelector('parsererror');
      if (parseError) {
        // 尝试用 text/html 解析
        const doc2 = new DOMParser().parseFromString(html, 'text/html');
        const text = extractTextWithLineBreaks(doc2);
        if (text.trim()) {
          textParts.push(text.trim());
        }
        continue;
      }
      
      const text = extractTextWithLineBreaks(doc);
      if (text.trim()) {
        textParts.push(text.trim());
      }
    } catch (e) {
      console.warn('EPUB 章节解析失败:', fullPath, e);
    }
  }
  
  // 章节之间用双换行分隔
  return textParts.join('\n\n');
}

/**
 * 获取支持的文件类型
 */
export function getSupportedFileTypes(): string {
  return '.txt,.pdf,.epub';
}

/**
 * 获取文件类型显示名称
 */
export function getFileTypeLabel(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'txt': return 'TXT';
    case 'pdf': return 'PDF';
    case 'epub': return 'EPUB';
    default: return ext?.toUpperCase() || '未知';
  }
}
