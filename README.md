# axon

面向本地开发与自动化任务的 CLI Agent 框架，类 ClaudeCode 设计，支持多模型接入、工具调用、MCP 扩展、长期记忆和项目级指令注入。

---

## 核心模块

| 模块 | 实现要点 | 相关文件 |
|---|---|---|
| **多模型 Agent Loop** | 统一接入 OpenAI / Anthropic / Gemini / DeepSeek / Qwen / MiniMax；流式事件返回、工具执行、错误恢复、多轮推理 | `agent.ts` `providers/` |
| **Tool-use 工具系统** | 文件读写编辑、glob 检索、grep 搜索、Bash 执行；工具 Schema 注册、权限校验、危险命令检测 | `tools/` |
| **MCP 扩展** | 读取本地配置自动 spawn MCP Server 子进程；JSON-RPC 握手、工具发现与注册，扩展网络搜索、GitHub 检索等外部能力 | `mcp.ts` |
| **Skill 技能系统** | `SKILL.md + scripts/references/assets` 目录结构；元数据发现与格式校验、系统提示词注入、`skill_list`/`skill_read` 渐进式披露 | `skills.ts` `tools/index.ts` |
| **Hook 生命周期** | 工具调用前后、LLM 采样后、压缩前后、单轮结束、会话结束等事件钩子；预留工具审计、参数改写、会话持久化扩展点 | `hooks.ts` `plugins/` |
| **长期记忆 & Auto-Dream** | 会话摘要写入本地文件；满足时间间隔或会话次数条件后，后台加文件锁触发 LLM 整合，注入下次会话的 system prompt | `memory.ts` `plugins/auto-dream.ts` |
| **4 层上下文压缩** | L1 消息裁剪 → L2 工具结果占位符 → L3 大结果持久化 → L4 LLM 摘要；处理长对话、超大工具返回和 prompt_too_long 兜底 | `compaction.ts` |

---

## 安装

```bash
npm install -g axon-cli
```

或从源码安装：

```bash
git clone https://github.com/yourusername/axon
cd axon
npm install && npm run build && npm install -g .
```

配置 API key（任选其一）：

```bash
# 方式一：全局配置文件（推荐）
mkdir -p ~/.axon
echo '{ "provider": "deepseek", "apiKey": "your-key-here" }' > ~/.axon/config.json

# 方式二：环境变量
export DEEPSEEK_API_KEY=your-key-here
```

---

## 日常用法

```bash
axon                          # 交互 REPL
axon "解释这段代码"            # 单次执行
axon --yolo "批量重命名文件"   # 跳过所有确认
axon --plan  "重构认证模块"    # 执行前展示计划，逐步确认
axon --model anthropic:claude-3-5-sonnet "review 代码"
npm run dev -- "prompt"       # 开发时免 build
```

---

## 切换模型

格式：`--model provider:model`，或在 `axon.config.json` 里配默认值。

| provider | 模型示例 | 环境变量 |
|---|---|---|
| `deepseek`（默认）| `deepseek-chat` | `DEEPSEEK_API_KEY` |
| `openai` | `gpt-4o` | `OPENAI_API_KEY` |
| `anthropic` | `claude-3-5-sonnet-20241022` | `ANTHROPIC_API_KEY` |
| `gemini` | `gemini-1.5-pro` | `GEMINI_API_KEY` |
| `qwen` | `qwen-max` | `DASHSCOPE_API_KEY` |

> Anthropic 需额外安装：`npm install @anthropic-ai/sdk`

---

## 配置文件

配置分两层，本地覆盖全局，`mcpServers` 和 `plugins` 合并：

**全局配置** `~/.axon/config.json`（对所有项目生效）：

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "apiKey": "${DEEPSEEK_API_KEY}"
}
```

**项目配置** `axon.config.json`（放在项目根目录，覆盖全局）：

```json
{
  "model": "deepseek-reasoner",
  "mcpServers": {
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": { "BRAVE_API_KEY": "${BRAVE_API_KEY}" }
    }
  },
  "plugins": ["./hooks/audit.js"]
}
```

`apiKey` 支持 `${ENV_VAR}` 语法引用环境变量，避免明文写入配置文件。

---

## 扩展

### Skills

`.agents/skills/<name>/SKILL.md`，启动时自动发现，模型通过 `skill_list` / `skill_read` 按需加载。

```
.agents/skills/
  company-valuation/
    SKILL.md        # frontmatter(name, description) + 正文
    references/     # skill_read 时列出文件名供模型按需读取
    scripts/
```

### MCP

`axon.config.json` 里配 `mcpServers`，启动时自动 spawn 子进程，工具名格式 `serverName__toolName`。内置轻量 JSON-RPC，不依赖 MCP SDK。

### 记忆

- 每轮结束追加摘要到 `~/.axon/memory/sessions/YYYY-MM-DD.md`
- 触发条件（≥ 10 次会话 或 距上次 > 24h）：后台加文件锁，LLM 整合进 `~/.axon/memory/memory.md`
- 启动时自动注入 system prompt（最多 8KB）

### 插件

```typescript
module.exports = {
  async onBeforeToolCall({ name, input }) {},
  async onAfterToolCall({ name, output }) {},
  async onTurnEnd({ messages }) {},
  async onSessionEnd({ messages }) {},
};
```

配在 `axon.config.json` 的 `plugins` 数组里。

### 项目上下文

项目根目录（或任意父目录）放 `AGENTS.md`，启动时自动加载注入 system prompt。

---

## 模型可调用的工具

| 工具 | 说明 |
|---|---|
| `bash` | 执行 shell，危险命令需确认 |
| `read_file` / `write_file` | 读写文件 |
| `edit_file` | 精确字符串替换（多处匹配时报错） |
| `list_files` | glob 列文件 |
| `search_files` | grep 搜索 |
| `skill_list` / `skill_read` | 浏览和加载 skills |

---

## 内部机制

### 压缩流水线

```
L1 snip   — 消息数 > 50：丢弃中间，保留头 3 + 尾部
L2 micro  — 工具结果 > 3 条：旧结果替换占位符（skill 内容豁免）
L3 budget — 工具结果总量 > 200KB：大结果持久化到磁盘
L4 LLM    — 总体积 > 80KB：调 LLM 生成摘要替换历史
```

### 代码结构

```
src/
├── cli.ts          # 入口：参数解析、子系统初始化
├── agent.ts        # Session + agent loop + 流式输出
├── compaction.ts   # 四层压缩流水线
├── context.ts      # AGENTS.md 层级加载
├── mode.ts         # yolo / default / plan
├── skills.ts       # SkillLoader
├── hooks.ts        # HookSystem + AxonPlugin 接口
├── memory.ts       # 记忆读写 + Dream 整合
├── mcp.ts          # MCP JSON-RPC 客户端
├── providers/
│   ├── index.ts    # createClient 工厂
│   └── anthropic.ts
├── plugins/
│   ├── session-counter.ts
│   └── auto-dream.ts
└── tools/
    ├── index.ts    # 注册 + dispatch
    ├── bash.ts
    └── files.ts
```
