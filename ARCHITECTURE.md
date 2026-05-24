# Axon 架构文档

## 概览

Axon 是一个运行在终端的 AI 编程助手，核心是一个 **agent loop**：接收用户输入，调用大模型，执行工具，把结果喂回模型，循环直到模型完成任务。

底层使用 DeepSeek API（OpenAI 兼容格式），通过 `openai` SDK 接入。

---

## 目录结构

```
src/
├── cli.ts          # 入口：CLI 参数解析 + 交互式 REPL
├── agent.ts        # 核心：Session 类 + agent loop + 流式输出
└── tools/
    ├── index.ts    # 工具注册表：定义列表 + dispatch 路由
    ├── bash.ts     # 工具：执行 shell 命令
    └── files.ts    # 工具：文件读写编辑搜索
```

---

## 核心概念

### Agent Loop

Axon 的运行模型是一个 while 循环，不是一次性的请求-响应：

```
用户输入
   │
   ▼
┌─────────────────────────────────┐
│  调用 DeepSeek API（流式）        │
│  ├─ 文本 token → 实时打印         │
│  └─ tool_call → 显示工具名        │
└────────────┬────────────────────┘
             │
     finish_reason?
             │
    ┌────────┴────────┐
    │                 │
 end_turn          tool_calls
    │                 │
   结束         执行所有工具
                      │
               把结果追加到 messages
                      │
               回到循环顶部
```

关键在于 `messages` 数组——它是整个对话的完整历史，每一轮都把新内容追加进去，模型始终能看到完整上下文。

### 流式输出的工具调用处理

DeepSeek 的 streaming 响应里，工具调用不是一次性返回的，而是分块到达：

```
chunk 0: { index: 0, id: "call_abc", function: { name: "bash", arguments: "" } }
chunk 1: { index: 0, function: { arguments: '{"com' } }
chunk 2: { index: 0, function: { arguments: 'mand": "ls"}' } }
```

`callApi()` 用一个 `toolCallMap` 按 `index` 累积这些碎片，流结束后再统一解析：

```typescript
const toolCallMap: Record<number, ToolCall> = {};

for await (const chunk of stream) {
  for (const tc of delta.tool_calls ?? []) {
    if (!toolCallMap[tc.index]) {
      toolCallMap[tc.index] = { id: tc.id, name: tc.function.name, arguments: "" };
    }
    toolCallMap[tc.index].arguments += tc.function.arguments;
  }
}
```

### 消息格式

OpenAI 格式的多轮工具调用，messages 数组结构如下：

```
[
  { role: "user",      content: "列出当前目录的文件" },
  { role: "assistant", content: null,
    tool_calls: [{ id: "call_1", type: "function",
                   function: { name: "bash", arguments: '{"command":"ls"}' } }] },
  { role: "tool",      tool_call_id: "call_1", content: "README.md\nsrc/\n..." },
  { role: "assistant", content: "当前目录包含..." }
]
```

注意：有 `tool_calls` 时，assistant 消息的 `content` 必须是 `null` 而不是空字符串，否则部分 API 会报错。

---

## 模块说明

### `cli.ts` — 入口

两种运行模式：

| 模式 | 触发方式 | 行为 |
|------|----------|------|
| 单次 | `axon "prompt"` | 创建 Session，执行一次 chat，退出 |
| REPL | `axon` | 创建 Session，循环读取输入，共享同一个对话历史 |

REPL 用 Node 内置的 `readline` 实现，不引入额外依赖。Session 在整个 REPL 生命周期内复用，所以多轮对话有记忆。

### `agent.ts` — Session 类

| 方法 | 职责 |
|------|------|
| `chat(message)` | 公开接口，追加用户消息，启动 loop |
| `runLoop()` | while 循环，驱动整个 agent 流程 |
| `callApi()` | 调 API、处理流式输出，返回 `{ content, toolCalls, finishReason }` |

`Session` 持有 `messages` 数组，这是状态的唯一来源。

### `tools/index.ts` — 工具注册表

两个职责：

1. **`DEFINITIONS`**：所有工具的 JSON Schema 描述，发给模型，告诉它有哪些工具可用
2. **`dispatch(name, input)`**：根据工具名路由到对应的实现函数

新增工具只需两步：在 `tools/` 下实现函数，然后在 `index.ts` 里注册定义和路由。

### `tools/bash.ts` — Shell 执行

- 用 `execSync` 同步执行命令，捕获 stdout + stderr
- 危险命令检测：匹配 `rm -rf`、`sudo rm`、`dd if=` 等模式，命中则暂停等待用户确认
- 超时 60 秒

### `tools/files.ts` — 文件操作

| 工具 | 实现 |
|------|------|
| `read_file` | `fs.readFileSync` |
| `write_file` | `fs.writeFileSync`，自动创建父目录 |
| `edit_file` | 读取 → `String.replace`（首次匹配）→ 写回 |
| `list_files` | `globSync` |
| `search_files` | `spawnSync("grep", [...])` — 用数组参数避免 shell 注入 |

---

## 数据流

```
用户输入 (stdin)
    │
    ▼
cli.ts: session.chat(input)
    │
    ▼
agent.ts: messages.push({ role: "user", content })
    │
    ▼
agent.ts: callApi()
    ├── DeepSeek API (streaming)
    ├── 文本 delta → process.stdout.write()
    └── tool_call delta → toolCallMap 累积
    │
    ▼
finish_reason === "tool_calls"?
    │
    ├── YES → tools/index.ts: dispatch(name, input)
    │              │
    │              ├── bash.ts: execSync(command)
    │              └── files.ts: readFileSync / writeFileSync / ...
    │              │
    │              └── 结果追加为 { role: "tool", ... }
    │                  回到 callApi()
    │
    └── NO (end_turn) → 结束，等待下一次用户输入
```

---

## 扩展点

**新增工具**

1. 在 `src/tools/` 创建新文件，导出 `DEFINITION`（OpenAI tool 格式）和实现函数
2. 在 `src/tools/index.ts` 的 `DEFINITIONS` 数组和 `dispatch` 的 switch 里注册

**切换模型**

```bash
axon --model deepseek-reasoner "帮我优化这段代码"
```

`deepseek-reasoner` 是 R1 推理模型，响应里会包含 `<think>` 内容，目前直接输出，后续可以单独渲染。

**已知局限**

- 没有 context 压缩：对话足够长后会触发 token 上限
- 没有持久化：重启后对话历史丢失
- `edit_file` 只替换首次匹配，重复字符串会有歧义
