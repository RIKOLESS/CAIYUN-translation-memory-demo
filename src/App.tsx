import { useState, useEffect, useRef } from 'react';
import { translate, setLLMConfig, getLLMConfig, LLMConfig, TargetLanguage, TARGET_LANGUAGE_LABELS } from './services/llmService';
import {
  Terminology,
  createTerminology,
  addTerm,
  removeTerm,
  toMapping
} from './services/terminologyService';
import {
  getMemoryContext,
  initializeMemory,
  learnFromTranslation,
  resetMemory,
  LearnResult
} from './services/memoryAgent';
import { WorkMemory, CharacterInfo, getAllMemories, deleteWorkMemory, getStorageStats } from './storage/indexedDB';
import {
  batchTranslate,
  createBatchController,
  formatLogsToText,
  downloadTextFile,
  BatchResult,
  BatchStatus,
  RoundLog,
  BatchController
} from './services/batchTranslator';
import { previewSplit } from './utils/textSplitter';
import { parseFile, getSupportedFileTypes } from './utils/fileParser';
import './App.css';

function App() {
  // 状态
  const [workId, setWorkId] = useState('demo-work-001');
  const [inputText, setInputText] = useState('');
  const [translatedText, setTranslatedText] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);
  const [isLearning, setIsLearning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [learnLogs, setLearnLogs] = useState<string[]>([]);
  
  // 术语库
  const [terminology, setTerminology] = useState<Terminology>(createTerminology());
  const [newTermOriginal, setNewTermOriginal] = useState('');
  const [newTermTranslated, setNewTermTranslated] = useState('');
  
  // 记忆
  const [currentMemory, setCurrentMemory] = useState<WorkMemory | null>(null);
  const [allMemories, setAllMemories] = useState<WorkMemory[]>([]);
  const [stats, setStats] = useState({ totalWorks: 0, totalCharacters: 0, totalNameMappings: 0 });
  
  // 设置
  const [showSettings, setShowSettings] = useState(false);
  const [llmConfig, setLlmConfigState] = useState<LLMConfig>(getLLMConfig());
  
  // AI学习开关
  const [enableAILearning, setEnableAILearning] = useState(true);
  
  // 目标语言
  const [targetLanguage, setTargetLanguage] = useState<TargetLanguage>('zh');
  
  // 活动标签页
  const [activeTab, setActiveTab] = useState<'translate' | 'terminology' | 'memory' | 'batch'>('translate');
  
  // 批量翻译状态
  const [batchInputText, setBatchInputText] = useState('');
  const [batchStatus, setBatchStatus] = useState<BatchStatus>('idle');
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [batchCurrentChunk, setBatchCurrentChunk] = useState('');
  const [batchLogs, setBatchLogs] = useState<RoundLog[]>([]);
  const batchControllerRef = useRef<BatchController | null>(null);
  const [chunkSizeLimit, setChunkSizeLimit] = useState(2000); // 每轮字符上限

  // 初始化
  useEffect(() => {
    loadMemory();
    loadAllMemories();
  }, [workId]);

  // 加载当前作品记忆
  async function loadMemory() {
    try {
      const memory = await initializeMemory(workId, { title: `作品 ${workId}` });
      setCurrentMemory(memory);
    } catch (err) {
      console.error('加载记忆失败:', err);
    }
  }

  // 加载所有记忆列表
  async function loadAllMemories() {
    try {
      const memories = await getAllMemories();
      setAllMemories(memories);
      const s = await getStorageStats();
      setStats(s);
    } catch (err) {
      console.error('加载记忆列表失败:', err);
    }
  }

  // 翻译
  async function handleTranslate() {
    if (!inputText.trim()) {
      setError('请输入要翻译的文本');
      return;
    }

    setIsTranslating(true);
    setError(null);

    try {
      // 获取记忆上下文（传入当前文本，智能过滤只返回相关记忆）
      const memoryContext = await getMemoryContext(workId, inputText);
      
      // 执行翻译
      const result = await translate(
        inputText,
        toMapping(terminology),
        memoryContext,
        targetLanguage,
        workId  // 火山引擎缓存用
      );
      
      setTranslatedText(result.translation);

      // 学习新内容
      if (enableAILearning) {
        setIsLearning(true);
        try {
          const learnResult = await learnFromTranslation(
            workId,
            inputText,
            result.translation,
            { useAI: true }
          );
          setCurrentMemory(learnResult.memory);
          setLearnLogs(learnResult.logs);
          await loadAllMemories();
        } catch (learnErr) {
          console.error('学习失败:', learnErr);
        } finally {
          setIsLearning(false);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '翻译失败');
    } finally {
      setIsTranslating(false);
    }
  }

  // 添加术语
  function handleAddTerm() {
    if (!newTermOriginal.trim() || !newTermTranslated.trim()) {
      return;
    }
    setTerminology(addTerm(terminology, newTermOriginal.trim(), newTermTranslated.trim()));
    setNewTermOriginal('');
    setNewTermTranslated('');
  }

  // 删除术语
  function handleRemoveTerm(original: string) {
    setTerminology(removeTerm(terminology, original));
  }

  // 重置记忆
  async function handleResetMemory() {
    if (confirm('确定要重置当前作品的记忆吗？')) {
      const memory = await resetMemory(workId);
      setCurrentMemory(memory);
      await loadAllMemories();
    }
  }

  // 删除记忆
  async function handleDeleteMemory(id: string) {
    if (confirm(`确定要删除作品 ${id} 的记忆吗？`)) {
      await deleteWorkMemory(id);
      await loadAllMemories();
      if (id === workId) {
        await loadMemory();
      }
    }
  }

  // 保存设置
  function handleSaveSettings() {
    setLLMConfig(llmConfig);
    setShowSettings(false);
  }

  // 开始批量翻译
  async function handleStartBatch() {
    if (!batchInputText.trim()) {
      return;
    }

    // 创建控制器
    const controller = createBatchController();
    batchControllerRef.current = controller;

    // 重置状态
    setBatchStatus('running');
    setBatchResult(null);
    setBatchProgress({ current: 0, total: 0 });
    setBatchLogs([]);
    setBatchCurrentChunk('');

    try {
      const result = await batchTranslate(
        batchInputText,
        {
          workId,
          targetLanguage,
          terminology: toMapping(terminology),
          enableLearning: enableAILearning,
          splitOptions: {
            targetSize: chunkSizeLimit,
            minSize: Math.floor(chunkSizeLimit * 0.6),
            maxSize: Math.floor(chunkSizeLimit * 1.25)
          }
        },
        controller,
        // 进度回调
        (current, total, chunk, translation, log) => {
          setBatchProgress({ current, total });
          setBatchCurrentChunk(chunk.text);
          setBatchLogs(prev => [...prev, log]);
          setBatchResult(prev => prev ? {
            ...prev,
            completedChunks: current,
            translatedText: prev.translatedText + (prev.translatedText ? '\n\n' : '') + translation
          } : {
            status: 'running',
            totalChunks: total,
            completedChunks: current,
            translatedText: translation,
            logs: [log],
            startTime: new Date()
          });
          
          // 刷新记忆显示
          loadMemory();
          loadAllMemories();
        }
      );

      setBatchResult(result);
      setBatchStatus(result.status);
      
      // 最终刷新记忆
      await loadMemory();
      await loadAllMemories();
      
    } catch (err) {
      setBatchStatus('error');
      console.error('批量翻译失败:', err);
    }
  }

  // 更新设置
  function updateConfig(updates: Partial<LLMConfig>) {
    setLlmConfigState(prev => ({ ...prev, ...updates }));
  }

  // 切换作品
  function handleSwitchWork(id: string) {
    setWorkId(id);
    setTranslatedText('');
  }

  return (
    <div className="app">
      {/* 头部 */}
      <header className="header">
        <div className="header-left">
          <h1>🌐 翻译记忆 Demo</h1>
          <span className="subtitle">彩云小译 - 术语库 + 记忆Agent</span>
        </div>
        <div className="header-right">
          <div className="work-selector">
            <label>作品ID:</label>
            <input
              type="text"
              value={workId}
              onChange={(e) => setWorkId(e.target.value)}
              placeholder="输入作品ID"
            />
          </div>
          <button className="settings-btn" onClick={() => setShowSettings(true)}>
            ⚙️ 设置
          </button>
        </div>
      </header>

      {/* 主内容区 */}
      <main className="main">
        {/* 标签页切换 */}
        <div className="tabs">
          <button
            className={`tab ${activeTab === 'translate' ? 'active' : ''}`}
            onClick={() => setActiveTab('translate')}
          >
            📝 翻译
          </button>
          <button
            className={`tab ${activeTab === 'batch' ? 'active' : ''}`}
            onClick={() => setActiveTab('batch')}
          >
            📄 批量翻译
          </button>
          <button
            className={`tab ${activeTab === 'terminology' ? 'active' : ''}`}
            onClick={() => setActiveTab('terminology')}
          >
            📚 术语库 ({terminology.entries.length})
          </button>
          <button
            className={`tab ${activeTab === 'memory' ? 'active' : ''}`}
            onClick={() => setActiveTab('memory')}
          >
            🧠 记忆 ({Object.keys(currentMemory?.nameMappings || {}).length})
          </button>
        </div>

        {/* 翻译面板 */}
        {activeTab === 'translate' && (
          <div className="translate-panel">
            <div className="translate-options">
              <div className="language-selector">
                <label>译文语言：</label>
                <div className="language-buttons">
                  {(Object.keys(TARGET_LANGUAGE_LABELS) as TargetLanguage[]).map((lang) => (
                    <button
                      key={lang}
                      className={`lang-btn ${targetLanguage === lang ? 'active' : ''}`}
                      onClick={() => setTargetLanguage(lang)}
                    >
                      {TARGET_LANGUAGE_LABELS[lang]}
                    </button>
                  ))}
                </div>
              </div>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={enableAILearning}
                  onChange={(e) => setEnableAILearning(e.target.checked)}
                />
                <span>翻译后自动学习记忆</span>
              </label>
            </div>
            
            <div className="translate-area">
              <div className="input-section">
                <label>原文（任意语言）</label>
                <textarea
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="输入要翻译的文本（支持任意语言）..."
                  rows={12}
                />
              </div>
              
              <div className="translate-actions">
                <button
                  className="translate-btn"
                  onClick={handleTranslate}
                  disabled={isTranslating}
                >
                  {isTranslating ? '翻译中...' : `翻译 → ${TARGET_LANGUAGE_LABELS[targetLanguage]}`}
                </button>
                {isLearning && (
                  <span className="learning-indicator">🧠 学习中...</span>
                )}
              </div>
              
              <div className="output-section">
                <label>译文（{TARGET_LANGUAGE_LABELS[targetLanguage]}）</label>
                <textarea
                  value={translatedText}
                  readOnly
                  placeholder="翻译结果将显示在这里..."
                  rows={12}
                />
              </div>
            </div>

            {error && <div className="error-message">{error}</div>}

            {/* 当前使用的上下文 */}
            <div className="context-info">
              <h4>当前翻译上下文</h4>
              <div className="context-details">
                <span>术语库: {terminology.entries.length} 条</span>
                <span>角色: {Object.keys(currentMemory?.characters || {}).length} 个</span>
                <span>名称映射: {Object.keys(currentMemory?.nameMappings || {}).length} 条</span>
                {currentMemory?.style && <span>风格: {currentMemory.style}</span>}
              </div>
            </div>

            {/* 学习日志 */}
            {learnLogs.length > 0 && (
              <div className="learn-logs">
                <h4>🧠 AI学习日志</h4>
                <div className="log-list">
                  {learnLogs.map((log, index) => (
                    <div key={index} className="log-item">{log}</div>
                  ))}
                </div>
                <button 
                  className="clear-logs-btn" 
                  onClick={() => setLearnLogs([])}
                >
                  清除日志
                </button>
              </div>
            )}
          </div>
        )}

        {/* 批量翻译面板 */}
        {activeTab === 'batch' && (
          <div className="batch-panel">
            <div className="batch-header">
              <h3>📄 批量翻译</h3>
              <p className="batch-desc">上传全文或粘贴文本，自动分段翻译并持续学习记忆</p>
            </div>

            {/* 输入区域 */}
            <div className="batch-input-section">
              <div className="batch-input-header">
                <label>原文（粘贴全文或上传文件）</label>
                <input
                  type="file"
                  accept={getSupportedFileTypes()}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      try {
                        const text = await parseFile(file);
                        setBatchInputText(text);
                      } catch (err) {
                        alert(`文件解析失败: ${err instanceof Error ? err.message : '未知错误'}`);
                      }
                    }
                  }}
                  style={{ display: 'none' }}
                  id="batch-file-input"
                />
                <button 
                  className="upload-btn"
                  onClick={() => document.getElementById('batch-file-input')?.click()}
                >
                  📁 上传文件 (TXT/PDF/EPUB)
                </button>
              </div>
              <textarea
                value={batchInputText}
                onChange={(e) => setBatchInputText(e.target.value)}
                placeholder="粘贴要翻译的全文..."
                rows={10}
                disabled={batchStatus === 'running'}
              />
              
              {/* 字符上限设置 */}
              <div className="chunk-size-setting">
                <div className="chunk-size-input">
                  <label>每轮字符上限：</label>
                  <input
                    type="number"
                    value={chunkSizeLimit}
                    onChange={(e) => setChunkSizeLimit(Math.max(500, Math.min(10000, parseInt(e.target.value) || 2000)))}
                    min={500}
                    max={10000}
                    step={100}
                    disabled={batchStatus === 'running'}
                  />
                  <span className="unit">字符</span>
                </div>
                <div className="chunk-size-hints">
                  <span className="hint-title">推荐值：</span>
                  <button 
                    className="hint-btn" 
                    onClick={() => setChunkSizeLimit(1500)}
                    disabled={batchStatus === 'running'}
                  >
                    中文 1500
                  </button>
                  <button 
                    className="hint-btn" 
                    onClick={() => setChunkSizeLimit(2000)}
                    disabled={batchStatus === 'running'}
                  >
                    日/韩文 2000
                  </button>
                  <button 
                    className="hint-btn" 
                    onClick={() => setChunkSizeLimit(4500)}
                    disabled={batchStatus === 'running'}
                  >
                    英文 4500
                  </button>
                </div>
                <div className="chunk-size-note">
                  💡 不同语言的 token 效率不同：中文约 1.5字符/token，英文约 4字符/token
                </div>
              </div>
              
              {/* 预览信息 */}
              {batchInputText && batchStatus === 'idle' && (
                <div className="batch-preview">
                  {(() => {
                    const preview = previewSplit(batchInputText, { 
                      targetSize: chunkSizeLimit,
                      minSize: Math.floor(chunkSizeLimit * 0.6),
                      maxSize: Math.floor(chunkSizeLimit * 1.25)
                    });
                    return (
                      <>
                        <span>📊 共 {preview.totalChars.toLocaleString()} 字符</span>
                        <span>📦 将分为 {preview.chunkCount} 轮翻译</span>
                        <span>📏 平均每轮 {preview.avgChunkSize} 字符</span>
                      </>
                    );
                  })()}
                </div>
              )}
            </div>

            {/* 选项和控制 */}
            <div className="batch-options">
              <div className="language-selector">
                <label>译文语言：</label>
                <div className="language-buttons">
                  {(Object.keys(TARGET_LANGUAGE_LABELS) as TargetLanguage[]).map((lang) => (
                    <button
                      key={lang}
                      className={`lang-btn ${targetLanguage === lang ? 'active' : ''}`}
                      onClick={() => setTargetLanguage(lang)}
                      disabled={batchStatus === 'running'}
                    >
                      {TARGET_LANGUAGE_LABELS[lang]}
                    </button>
                  ))}
                </div>
              </div>
              
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={enableAILearning}
                  onChange={(e) => setEnableAILearning(e.target.checked)}
                  disabled={batchStatus === 'running'}
                />
                <span>翻译时持续学习记忆</span>
              </label>
            </div>

            {/* 控制按钮 */}
            <div className="batch-controls">
              {batchStatus === 'idle' && (
                <button
                  className="batch-start-btn"
                  onClick={handleStartBatch}
                  disabled={!batchInputText.trim()}
                >
                  ▶️ 开始批量翻译
                </button>
              )}
              
              {batchStatus === 'running' && (
                <>
                  <button
                    className="batch-pause-btn"
                    onClick={() => batchControllerRef.current?.pause()}
                  >
                    ⏸️ 暂停
                  </button>
                  <button
                    className="batch-stop-btn"
                    onClick={() => batchControllerRef.current?.stop()}
                  >
                    ⏹️ 停止
                  </button>
                </>
              )}
              
              {batchStatus === 'paused' && (
                <>
                  <button
                    className="batch-resume-btn"
                    onClick={() => batchControllerRef.current?.resume()}
                  >
                    ▶️ 继续
                  </button>
                  <button
                    className="batch-stop-btn"
                    onClick={() => batchControllerRef.current?.stop()}
                  >
                    ⏹️ 停止
                  </button>
                </>
              )}
              
              {(batchStatus === 'completed' || batchStatus === 'error') && (
                <button
                  className="batch-reset-btn"
                  onClick={() => {
                    setBatchStatus('idle');
                    setBatchResult(null);
                    setBatchProgress({ current: 0, total: 0 });
                    setBatchLogs([]);
                    setBatchCurrentChunk('');
                  }}
                >
                  🔄 重新开始
                </button>
              )}
            </div>

            {/* 进度条 */}
            {batchStatus !== 'idle' && batchProgress.total > 0 && (
              <div className="batch-progress">
                <div className="progress-bar">
                  <div 
                    className="progress-fill"
                    style={{ width: `${(batchProgress.current / batchProgress.total) * 100}%` }}
                  />
                </div>
                <div className="progress-text">
                  进度：{batchProgress.current} / {batchProgress.total} 
                  ({Math.round((batchProgress.current / batchProgress.total) * 100)}%)
                  {batchStatus === 'running' && ' 翻译中...'}
                  {batchStatus === 'paused' && ' 已暂停'}
                  {batchStatus === 'completed' && ' ✅ 完成'}
                  {batchStatus === 'error' && ' ❌ 出错'}
                </div>
              </div>
            )}

            {/* Token 统计 */}
            {batchResult?.tokenStats && (
              <div className="token-stats">
                <div className="token-stats-row">
                  <span className="token-label">翻译Agent:</span>
                  <span>输入 {batchResult.tokenStats.translation.prompt_tokens.toLocaleString()}</span>
                  <span>输出 {batchResult.tokenStats.translation.completion_tokens.toLocaleString()}</span>
                  <span className="cached">缓存 {batchResult.tokenStats.translation.cached_tokens.toLocaleString()}</span>
                </div>
                <div className="token-stats-row">
                  <span className="token-label">记忆Agent:</span>
                  <span>输入 {batchResult.tokenStats.memory.prompt_tokens.toLocaleString()}</span>
                  <span>输出 {batchResult.tokenStats.memory.completion_tokens.toLocaleString()}</span>
                  <span className="cached">缓存 {batchResult.tokenStats.memory.cached_tokens.toLocaleString()}</span>
                </div>
                <div className="token-stats-total">
                  总计: {(batchResult.tokenStats.translation.total_tokens + batchResult.tokenStats.memory.total_tokens).toLocaleString()} tokens
                  {' '}(缓存命中 {(batchResult.tokenStats.translation.cached_tokens + batchResult.tokenStats.memory.cached_tokens).toLocaleString()})
                </div>
              </div>
            )}

            {/* 当前翻译内容 */}
            {batchCurrentChunk && batchStatus === 'running' && (
              <div className="batch-current">
                <h4>当前翻译片段</h4>
                <div className="current-chunk">{batchCurrentChunk.slice(0, 200)}...</div>
              </div>
            )}

            {/* 译文输出 */}
            {batchResult && batchResult.translatedText && (
              <div className="batch-output-section">
                <div className="batch-output-header">
                  <h4>译文输出</h4>
                  <button
                    className="download-btn"
                    onClick={() => downloadTextFile(
                      batchResult.translatedText,
                      `${workId}-translation-${targetLanguage}.txt`
                    )}
                  >
                    📥 下载译文.txt
                  </button>
                </div>
                <textarea
                  value={batchResult.translatedText}
                  readOnly
                  rows={10}
                />
              </div>
            )}

            {/* 执行日志 */}
            {batchLogs.length > 0 && (
              <div className="batch-logs">
                <div className="batch-logs-header">
                  <h4>📋 执行日志</h4>
                  {batchResult && (
                    <button
                      className="download-btn"
                      onClick={() => downloadTextFile(
                        formatLogsToText(batchResult, {
                          workId,
                          targetLanguage,
                          terminology: toMapping(terminology),
                          enableLearning: enableAILearning
                        }),
                        `${workId}-translation-log.txt`
                      )}
                    >
                      📥 下载日志.txt
                    </button>
                  )}
                </div>
                <div className="log-container">
                  {batchLogs.map((log, index) => (
                    <div key={index} className={`batch-log-item ${log.error ? 'error' : ''}`}>
                      <div className="log-header">
                        <span className="log-round">第 {log.round} 轮</span>
                        <span className="log-time">{log.timestamp.toLocaleTimeString()}</span>
                        <span className="log-duration">{(log.duration / 1000).toFixed(1)}s</span>
                      </div>
                      <div className="log-stats">
                        <span>输入: {log.inputChars}字符</span>
                        <span>输出: {log.outputChars}字符</span>
                        <span>
                          记忆: {log.memoryBefore.characters}→{log.memoryAfter.characters}角色, 
                          {log.memoryBefore.nameMappings}→{log.memoryAfter.nameMappings}映射
                        </span>
                      </div>
                      {log.learnedItems.length > 0 && (
                        <div className="log-learned">
                          {log.learnedItems.map((item, i) => (
                            <div key={i} className="learned-item">{item}</div>
                          ))}
                        </div>
                      )}
                      {log.error && (
                        <div className="log-error">❌ {log.error}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 错误提示 */}
            {batchResult?.error && (
              <div className="batch-error">
                ❌ 翻译在第 {batchResult.error.round} 轮出错: {batchResult.error.message}
                <br />
                已完成的译文已保存，可以下载。
              </div>
            )}
          </div>
        )}

        {/* 术语库面板 */}
        {activeTab === 'terminology' && (
          <div className="terminology-panel">
            <div className="panel-header">
              <h3>术语库（用户手动设置，优先级最高）</h3>
            </div>
            
            <div className="add-term-form">
              <input
                type="text"
                value={newTermOriginal}
                onChange={(e) => setNewTermOriginal(e.target.value)}
                placeholder="原文 (如: Nana)"
              />
              <span className="arrow">→</span>
              <input
                type="text"
                value={newTermTranslated}
                onChange={(e) => setNewTermTranslated(e.target.value)}
                placeholder="译文 (如: 娜娜)"
                onKeyDown={(e) => e.key === 'Enter' && handleAddTerm()}
              />
              <button onClick={handleAddTerm}>添加</button>
            </div>

            <div className="term-list">
              {terminology.entries.length === 0 ? (
                <div className="empty-state">
                  暂无术语，添加术语后翻译时会强制使用
                </div>
              ) : (
                terminology.entries.map((entry) => (
                  <div key={entry.original} className="term-item">
                    <span className="term-original">{entry.original}</span>
                    <span className="term-arrow">→</span>
                    <span className="term-translated">{entry.translated}</span>
                    <button
                      className="remove-btn"
                      onClick={() => handleRemoveTerm(entry.original)}
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="panel-tip">
              💡 提示：术语库中的翻译会强制使用，优先级高于AI记忆
            </div>
          </div>
        )}

        {/* 记忆面板 */}
        {activeTab === 'memory' && (
          <div className="memory-panel">
            <div className="panel-header">
              <h3>AI记忆（自动学习，可被术语库覆盖）</h3>
              <button className="reset-btn" onClick={handleResetMemory}>
                重置当前记忆
              </button>
            </div>

            {currentMemory && (
              <div className="current-memory">
                <h4>当前作品: {currentMemory.workId}</h4>
                
                {/* 名称映射 */}
                <div className="memory-section">
                  <h5>📝 名称翻译 ({Object.keys(currentMemory.nameMappings).length})</h5>
                  <div className="mapping-list">
                    {Object.entries(currentMemory.nameMappings).length === 0 ? (
                      <div className="empty-state">翻译文本后会自动学习</div>
                    ) : (
                      Object.entries(currentMemory.nameMappings).map(([orig, trans]) => {
                        // 处理可能是对象或字符串的情况
                        const transText = typeof trans === 'string' ? trans : (trans as { translation?: string })?.translation || JSON.stringify(trans);
                        return (
                          <div key={orig} className="mapping-item">
                            <span>{orig}</span>
                            <span className="arrow">→</span>
                            <span>{transText}</span>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* 角色信息（增强显示别名和名称变体） */}
                <div className="memory-section">
                  <h5>👤 角色信息 ({Object.keys(currentMemory.characters).length})</h5>
                  <div className="character-list-enhanced">
                    {Object.entries(currentMemory.characters).length === 0 ? (
                      <div className="empty-state">翻译文本后会自动识别角色</div>
                    ) : (
                      Object.entries(currentMemory.characters).map(([name, info]) => {
                        const charInfo = info as CharacterInfo;
                        return (
                          <div key={name} className="character-card">
                            <div className="char-header">
                              <span className="char-name">{name}</span>
                              {charInfo.gender && <span className="char-gender">({charInfo.gender})</span>}
                            </div>
                            
                            {/* 显示别名 */}
                            {charInfo.aliases && charInfo.aliases.length > 0 && (
                              <div className="char-aliases">
                                <span className="label">🎭 别名：</span>
                                {charInfo.aliases.join('、')}
                                <span className="alias-note">（同一人）</span>
                              </div>
                            )}
                            
                            {/* 显示名称变体 */}
                            {charInfo.nameVariants && charInfo.nameVariants.length > 0 && (
                              <div className="char-variants">
                                <span className="label">📝 名称变体：</span>
                                {charInfo.nameVariants.map((v, i) => (
                                  <span key={i} className="variant-tag">
                                    {v.original}→{v.translation}
                                    <span className="variant-type">({v.type})</span>
                                    {i < charInfo.nameVariants.length - 1 && '、'}
                                  </span>
                                ))}
                              </div>
                            )}
                            
                            {/* 显示特征 */}
                            {charInfo.traits && charInfo.traits.length > 0 && (
                              <div className="char-traits-line">
                                <span className="label">特征：</span>
                                {charInfo.traits.join('、')}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* 别名索引 */}
                {currentMemory.aliasIndex && Object.keys(currentMemory.aliasIndex).length > 0 && (
                  <div className="memory-section">
                    <h5>🔗 别名索引（快速查找）</h5>
                    <div className="alias-index">
                      {Object.entries(currentMemory.aliasIndex).map(([alias, primary]) => (
                        <div key={alias} className="alias-index-item">
                          <span className="alias">{alias}</span>
                          <span className="arrow">→</span>
                          <span className="primary">{primary}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 风格 */}
                {currentMemory.style && (
                  <div className="memory-section">
                    <h5>🎨 文章风格</h5>
                    <div className="style-info">{currentMemory.style}</div>
                  </div>
                )}
              </div>
            )}

            {/* 所有作品记忆 */}
            <div className="all-memories">
              <h4>所有作品记忆 ({stats.totalWorks})</h4>
              <div className="stats">
                共 {stats.totalCharacters} 个角色，{stats.totalNameMappings} 条名称映射
              </div>
              <div className="memory-list">
                {allMemories.map((memory) => (
                  <div
                    key={memory.workId}
                    className={`memory-item ${memory.workId === workId ? 'active' : ''}`}
                  >
                    <div className="memory-info" onClick={() => handleSwitchWork(memory.workId)}>
                      <span className="memory-title">{memory.title || memory.workId}</span>
                      <span className="memory-stats">
                        {Object.keys(memory.characters).length}角色 / 
                        {Object.keys(memory.nameMappings).length}映射
                      </span>
                    </div>
                    <button
                      className="delete-btn"
                      onClick={() => handleDeleteMemory(memory.workId)}
                    >
                      🗑️
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* 设置弹窗 */}
      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>⚙️ API 设置</h2>
            
            <div className="form-group">
              <label>API提供商</label>
              <select 
                value={llmConfig.provider} 
                onChange={(e) => {
                  const provider = e.target.value as 'deepseek' | 'volcengine-deepseek' | 'doubao' | 'openai';
                  const presets: Record<string, { baseUrl: string; model: string }> = {
                    deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
                    'volcengine-deepseek': { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '' },
                    doubao: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '' },
                    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-3.5-turbo' }
                  };
                  updateConfig({ 
                    provider,
                    baseUrl: presets[provider].baseUrl,
                    model: presets[provider].model
                  });
                }}
              >
                <option value="deepseek">DeepSeek 官方 (推荐，便宜)</option>
                <option value="volcengine-deepseek">火山引擎 DeepSeek</option>
                <option value="doubao">豆包 (火山引擎)</option>
                <option value="openai">OpenAI</option>
              </select>
            </div>

            <div className="form-group">
              <label>API Key</label>
              <input
                type="password"
                value={llmConfig.apiKey}
                onChange={(e) => updateConfig({ apiKey: e.target.value })}
                placeholder={
                  llmConfig.provider === 'deepseek' ? '输入DeepSeek API Key' :
                  llmConfig.provider === 'volcengine-deepseek' ? '输入火山引擎 API Key' :
                  llmConfig.provider === 'doubao' ? '输入火山引擎 API Key' :
                  '输入API Key'
                }
              />
              {llmConfig.provider === 'deepseek' && (
                <small style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                  获取API Key: <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>platform.deepseek.com</a>
                </small>
              )}
              {(llmConfig.provider === 'volcengine-deepseek' || llmConfig.provider === 'doubao') && (
                <small style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                  获取API Key: <a href="https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey" target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>console.volcengine.com</a>
                </small>
              )}
            </div>
            
            <div className="form-group">
              <label>模型 / Endpoint</label>
              {llmConfig.provider === 'deepseek' ? (
                <select value={llmConfig.model} onChange={(e) => updateConfig({ model: e.target.value })}>
                  <option value="deepseek-chat">deepseek-chat (对话，便宜)</option>
                  <option value="deepseek-reasoner">deepseek-reasoner (推理，贵)</option>
                </select>
              ) : llmConfig.provider === 'volcengine-deepseek' ? (
                <input
                  type="text"
                  value={llmConfig.model}
                  onChange={(e) => updateConfig({ model: e.target.value })}
                  placeholder="输入Endpoint ID (如: ep-xxxxx)"
                />
              ) : llmConfig.provider === 'doubao' ? (
                <input
                  type="text"
                  value={llmConfig.model}
                  onChange={(e) => updateConfig({ model: e.target.value })}
                  placeholder="输入Endpoint ID (如: ep-xxxxx)"
                />
              ) : (
                <select value={llmConfig.model} onChange={(e) => updateConfig({ model: e.target.value })}>
                  <option value="gpt-3.5-turbo">gpt-3.5-turbo</option>
                  <option value="gpt-4">gpt-4</option>
                  <option value="gpt-4-turbo">gpt-4-turbo</option>
                </select>
              )}
            </div>

            <div className="form-group">
              <label>API Base URL</label>
              <input
                type="text"
                value={llmConfig.baseUrl}
                onChange={(e) => updateConfig({ baseUrl: e.target.value })}
                placeholder="API地址"
              />
            </div>

            <div className="modal-actions">
              <button className="cancel-btn" onClick={() => setShowSettings(false)}>
                取消
              </button>
              <button className="save-btn" onClick={handleSaveSettings}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

