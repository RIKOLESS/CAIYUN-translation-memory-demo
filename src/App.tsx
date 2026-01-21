import { useState, useEffect } from 'react';
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
  const [activeTab, setActiveTab] = useState<'translate' | 'terminology' | 'memory'>('translate');

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
      // 获取记忆上下文
      const memoryContext = await getMemoryContext(workId);
      
      // 执行翻译
      const result = await translate(
        inputText,
        toMapping(terminology),
        memoryContext,
        targetLanguage
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
                  const provider = e.target.value as 'deepseek' | 'doubao' | 'openai';
                  const presets: Record<string, { baseUrl: string; model: string }> = {
                    deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
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
                <option value="deepseek">DeepSeek (推荐，便宜)</option>
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
                placeholder={llmConfig.provider === 'deepseek' ? '输入DeepSeek API Key' : '输入API Key'}
              />
              {llmConfig.provider === 'deepseek' && (
                <small style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                  获取API Key: <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>platform.deepseek.com</a>
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

