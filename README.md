# axon-cli

基于 DeepSeek API 的终端 AI 编码助手。自举式开发——用 AI 开发 AI 工具。

## 快速开始

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env   # 填入 DEEPSEEK_API_KEY

# 启动
npm run dev -- "你的问题"
# 或直接传参
npx tsx src/cli.ts "用 Python 实现个斐波那契"
```

## 项目结构

```
src/
├── cli.ts          # 入口，解析命令行参数
├── agent.ts        # 核心 Agent Loop — 工具调用 → LLM 交互主循环
├── context.ts      # AGENTS.md 层级上下文加载器
└── tools/
    ├── index.ts    # 工具注册入口
    ├── bash.ts     # 执行 shell 命令
    ├── files.ts    # 文件读写搜索
    ├── compact.ts  # 对话历史压缩
    ├── todo.ts     # 任务管理（旧版）
    ├── task.ts     # 任务系统（DAG 依赖图）
    ├── background.ts # 后台任务执行
    └── teams.ts    # 多 Agent 协作系统
```

## 核心特性

### 🧠 Agent Loop

核心循环：接收用户输入 → 调用 LLM → 执行工具 → 继续调用或返回结果。支持并行工具调用。

### 📂 层级上下文（AGENTS.md）

从 git 根目录到当前目录逐层查找 AGENTS.md / AGENTS.override.md，按 根→叶 顺序拼接，总大小限制在 32KB。子目录可覆盖或补充父目录配置。

### 🔧 工具系统

| 工具 | 说明 |
|------|------|
| `bash` | 执行 shell 命令 |
| `read_file` / `write_file` / `edit_file` / `list_files` / `search_files` | 文件操作 |
| `task_create` / `task_update` / `task_list` / `task_delete` | DAG 任务管理（持久化到 `.tasks/`） |
| `background_run` / `check_background` | 后台异步任务执行 |
| `compact` | 手动触发对话历史压缩 |
| `task` | 分叉子 Agent，独立上下文执行子任务 |
| `skill_list` / `skill_read` | 技能系统 — 按需加载专业指令 |

### 🧩 技能系统

按需加载的专业指令集，覆盖股票分析、金融研究、代码审查等领域。

```bash
skill_list          # 查看所有可用技能
skill_read <name>   # 加载技能，注入到上下文
```

### 🔄 对话压缩

3 层压缩机制，防止 context window 溢出：

- **L1 microCompact** — 每轮静默执行，将早期工具结果替换为摘要
- **L2 compactHistory** — 体积超 80K 时自动触发，或手动调用 `compact` 工具
- 保留最近 3 条工具结果保证交互连贯

### 👥 多 Agent 协作（Teams）

创建和管理 AI 队友，通过文件收件箱异步通信：

```
partner_create   → 创建队友配置
partner_spawn    → 启动队友子进程
partner_send     → 发送消息
partner_read_inbox → 读取回复
partner_broadcast → 广播消息
partner_list     → 查看所有队友
partner_remove   → 移除队友
```

队友作为独立子进程运行，配置持久化在 `.agents/teams/team.json`。

### ⏳ 后台任务

长时间运行的命令不阻塞对话：

```
background_run "npm install"      # 后台跑，拿 taskId
check_background "bg_1"           # 查状态和输出
```

Agent Loop 每次调用 LLM 前自动注入已完成的后台任务摘要。

## Skills（技能列表）

执行 `skill_list` 查看所有可用技能。

## 项目规范

- TypeScript + Node.js，DeepSeek API（OpenAI 兼容格式）
- 构建：`tsc`，开发运行：`tsx`
- 注释用中文
- 函数保持单一职责，超过 40 行考虑拆分
- 新增工具需同时在 `src/tools/index.ts` 注册
