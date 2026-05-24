# 项目说明

这是 axon 项目本身的开发规范。

## 技术栈

- TypeScript + Node.js
- DeepSeek API（OpenAI 兼容格式）
- 构建工具：tsc，运行：tsx（开发）/ node dist/（生产）

## 代码规范

- 注释用中文
- 函数保持单一职责，超过 40 行考虑拆分
- 工具函数放 src/tools/，新增工具需同时在 index.ts 注册

## 项目结构

- src/cli.ts：入口
- src/agent.ts：核心 agent loop
- src/context.ts：AGENTS.md 上下文加载
- src/tools/：工具实现
