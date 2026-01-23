# 翻译记忆 Demo (Translation Memory Demo)

彩云小译 - 术语库 + 记忆Agent Demo

---

## 📌 版本说明

**当前版本：v0.5.0** - 内测版本

这是一个初步满足使用的版本，用于用户内测。

### ✅ 已实现功能
- AI翻译：基于 DeepSeek / 豆包 / OpenAI 等大语言模型
- 术语库：用户手动设置翻译对，优先级最高
- 记忆Agent：自动学习角色信息（性别、特征、别名）、名称映射
- 多语言支持：支持中文、英文、日文等目标语言切换
- 批量翻译：上传全文/txt文件，自动分段翻译
- 智能记忆过滤：只传入当前文本相关的记忆，减少token消耗
- 执行日志：记录每轮翻译的详细信息和记忆变化

### ⚠️ 待优化项
- **字符上限处理**：当段落本身超过设定的字符上限时，按句子拆分的逻辑仍需完善
- **输出格式**：换行符、标点符号在不同语言间可能不统一

---

## 功能特性

### 核心功能
- **AI翻译**：支持 DeepSeek / 豆包 / OpenAI 等LLM
- **术语库**：用户手动设置的翻译对，优先级最高
- **记忆Agent**：自动学习角色信息、名称映射
- **IndexedDB存储**：本地持久化，按作品ID存储

### 特色能力
- **多重身份识别**：自动识别同一角色的不同名字
- **名称归属**：识别名称属于哪个角色
- **别名索引**：快速查找角色的所有别名
- **风格保持**：忠实原文风格，不私自添加或省略内容

## 技术栈

- React 18 + TypeScript
- Vite
- IndexedDB (idb)
- DeepSeek API / 豆包 API

## 快速开始

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build
```

## 配置

在设置中配置你的API Key

## 数据结构

### 记忆存储
```typescript
interface WorkMemory {
  workId: string;           // 作品ID
  characters: {             // 角色信息
    [name: string]: {
      primaryName: string;  // 主名称/真名
      aliases: string[];    // 别名列表
      nameVariants: [];     // 名称变体
      gender?: string;
      traits?: string[];
    }
  };
  nameMappings: {};         // 名称翻译映射
  aliasIndex: {};           // 别名索引
  style?: string;           // 文章风格
}
```

### 翻译参考优先级
```
术语库（用户手动） > AI记忆（自动学习） > 实时翻译
```
