# axon

A minimal AI coding assistant powered by Claude, built to learn harness engineering.

## Install

```bash
git clone https://github.com/yourusername/axon
cd axon
npm install
npm run build
npm install -g .
```

Set your API key:

```bash
cp .env.example .env
# edit .env and add your ANTHROPIC_API_KEY
```

## Usage

Single prompt:

```bash
axon "explain this codebase"
axon "add error handling to main.ts"
```

Interactive REPL:

```bash
axon
```

Dev mode (no build step):

```bash
npm run dev -- "your prompt here"
```

## Architecture

```
src/
├── cli.ts       # CLI entry point (commander + readline REPL)
├── agent.ts     # Session class + agent loop + streaming
└── tools/
    ├── index.ts   # dispatch() — routes tool calls to handlers
    ├── bash.ts    # Execute shell commands (with dangerous-command guard)
    └── files.ts   # read / write / edit / list / search files
```

The agent loop (`agent.ts`):

1. User sends a message
2. Call Claude API with streaming + tools defined
3. Print text tokens as they arrive
4. If `stop_reason === "tool_use"` — execute the requested tools
5. Feed results back as a `tool_result` message
6. Repeat until `stop_reason === "end_turn"`
