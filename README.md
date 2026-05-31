# axon

个人用 AI 编程助手，跑在终端里。

## 安装

```bash
git clone https://github.com/yourusername/axon
cd axon
npm install && npm run build && npm install -g .
```

```bash
cp .env.example .env   # 填入 DEEPSEEK_API_KEY
```

## 用法

```bash
axon "解释这段代码"          # 单次执行
axon                         # 交互 REPL
axon --model openai:gpt-4o   # 切换模型
axon --yolo "批量重命名文件"  # 跳过所有确认
axon --plan "重构认证模块"    # 每轮执行前要求确认
npm run dev -- "prompt"      # 开发时不用 build
```

## 多模型

`--model provider:model` 或在 `axon.config.json` 里配默认值。

| provider | 模型示例 | 环境变量 |
|---|---|---|
| `deepseek`（默认） | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| `openai` | `gpt-4o` | `OPENAI_API_KEY` |
| `anthropic` | `claude-3-5-sonnet-20241022` | `ANTHROPIC_API_KEY` |
| `gemini` | `gemini-1.5-pro` | `GEMINI_API_KEY` |
| `qwen` | `qwen-max` | `DASHSCOPE_API_KEY` |

Anthropic 需要额外装 SDK：`npm install @anthropic-ai/sdk`

## axon.config.json

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "apiKey": "${DEEPSEEK_API_KEY}",
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

## 工具

| 工具 | 说明 |
|---|---|
| `bash` | 执行 shell，危险命令需确认 |
| `read_file` / `write_file` | 读写文件 |
| `edit_file` | 精确字符串替换（多处匹配时报错） |
| `list_files` | glob 列文件 |
| `search_files` | grep 搜索 |
| `skill_list` | 列出可用 skills |
| `skill_read` | 加载指定 skill 内容 |

## Skills

放在 `.agents/skills/<name>/SKILL.md`，启动时自动发现。模型按需调 `skill_list` / `skill_read` 获取，不占 context。

```
.agents/skills/
  company-valuation/
    SKILL.md       # frontmatter(name, description) + 正文
    references/    # 参考文档，skill_read 时会列出文件名
    scripts/
```

## MCP

配 `axon.config.json` 的 `mcpServers`，启动时自动 spawn 子进程、注册工具。工具名格式：`serverName__toolName`。不依赖 MCP SDK，内置轻量 JSON-RPC。

## 记忆

- 每轮结束追加摘要到 `~/.axon/memory/sessions/YYYY-MM-DD.md`
- 触发条件（会话数 ≥ 10 或 距上次 > 24h）：后台调 LLM 整合进 `~/.axon/memory/memory.md`
- 启动时自动注入 system prompt（最多 8KB）

## 插件

实现 `AxonPlugin` 接口，配在 `axon.config.json` 的 `plugins` 里：

```typescript
module.exports = {
  async onBeforeToolCall({ name, input }) { /* 审计 */ },
  async onAfterToolCall({ name, output }) { /* 统计 */ },
  async onTurnEnd({ messages })           { /* 每轮结束 */ },
};
```

## 压缩流水线

长对话按成本顺序依次触发：

```
L1 snip   — 消息数 > 50：丢弃中间，保留头 3 + 尾部
L2 micro  — 工具结果 > 3 条：旧结果替换为占位符（skill 内容豁免）
L3 budget — 工具结果总量 > 200KB：大结果持久化到磁盘
L4 LLM    — 总体积 > 80KB：调 LLM 生成摘要
```

## 项目上下文

项目根目录（或父目录）放 `AGENTS.md`，启动时自动加载注入 system prompt。

## 结构

```
src/
├── cli.ts                  # 入口
├── agent.ts                # Session + agent loop
├── compaction.ts           # 四层压缩
├── skills.ts               # SkillLoader
├── hooks.ts                # HookSystem + AxonPlugin
├── memory.ts               # 记忆读写 + Dream 整合
├── mcp.ts                  # MCP JSON-RPC 客户端
├── context.ts              # AGENTS.md 加载
├── mode.ts                 # yolo / default / plan
├── providers/
│   ├── index.ts            # createClient 工厂
│   └── anthropic.ts        # Anthropic stream 适配
├── plugins/
│   ├── session-counter.ts
│   └── auto-dream.ts
└── tools/
    ├── index.ts            # 注册 + dispatch
    ├── bash.ts
    └── files.ts
```
