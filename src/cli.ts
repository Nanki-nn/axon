#!/usr/bin/env node
import * as readline from "readline";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { config } from "dotenv";
import { Command } from "commander";
import chalk from "chalk";
import OpenAI from "openai";
import { Session, DEFAULT_MODEL } from "./agent";
import { loadAgentsContext } from "./context";
import { setMode } from "./mode";
import { SkillLoader } from "./skills";
import { setSkillLoader } from "./tools";
import { HookSystem, AxonPlugin } from "./hooks";
import { SessionCounterPlugin } from "./plugins/session-counter";
import { AutoDreamPlugin } from "./plugins/auto-dream";
import { loadMemoryContext } from "./memory";
import { initMcpServers, McpServerConfig } from "./mcp";
import { createClient, parseModelFlag, ProviderConfig } from "./providers";
import { printLogo } from "./logo";
import { createAnthropicAdapter } from "./providers/anthropic";
import { logger, configureLogger, LogLevel } from "./logger";

// 加载 .env 文件中的环境变量（如 DEEPSEEK_API_KEY）
config();

// ── axon.config.json 配置文件结构 ─────────────────────────────────────────────

interface AxonConfig {
  provider?: string;                         // 提供商名称（deepseek/openai/anthropic 等）
  model?: string;                            // 模型名称
  apiKey?: string;                           // API Key，支持 ${ENV_VAR} 语法
  baseURL?: string;                          // 自定义端点（覆盖默认值）
  mcpServers?: Record<string, McpServerConfig>; // MCP 服务端配置
  plugins?: string[];                        // 自定义插件路径列表
}

/** 读取单个 JSON 配置文件，失败时返回空对象 */
function readConfig(filePath: string): AxonConfig {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as AxonConfig;
  } catch {
    return {};
  }
}

/**
 * 合并全局配置（~/.axon/config.json）和项目配置（./axon.config.json）。
 * 项目配置优先级更高，mcpServers 和 plugins 做深度合并（不覆盖，而是追加）。
 */
function loadAxonConfig(): AxonConfig {
  const globalConfig = readConfig(path.join(os.homedir(), ".axon", "config.json"));
  const localConfig = readConfig(path.join(process.cwd(), "axon.config.json"));
  return {
    ...globalConfig,
    ...localConfig, // 局部配置覆盖全局配置
    mcpServers: { ...globalConfig.mcpServers, ...localConfig.mcpServers },
    plugins: [...(globalConfig.plugins ?? []), ...(localConfig.plugins ?? [])],
  };
}

// ── API Key 解析 ───────────────────────────────────────────────────────────────

/**
 * 获取指定提供商的 API Key，查找优先级：
 *   1. 配置文件中的 apiKey 字段（支持 ${ENV_VAR} 引用）
 *   2. 对应的环境变量（如 DEEPSEEK_API_KEY）
 *   找不到时打印错误并退出
 */
function getApiKey(provider: string, configKey?: string): string {
  // 配置文件中指定的 key 优先（${ENV_VAR} 语法由 createClient 解析）
  if (configKey) return configKey;

  // 各提供商对应的环境变量名
  const envMap: Record<string, string> = {
    deepseek: "DEEPSEEK_API_KEY",
    openai:   "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    gemini:   "GEMINI_API_KEY",
    minimax:  "MINIMAX_API_KEY",
    qwen:     "DASHSCOPE_API_KEY",
  };
  const envVar = envMap[provider] ?? "DEEPSEEK_API_KEY";
  const key = process.env[envVar]?.trim();
  if (!key) {
    console.error(chalk.red(`API key not set for provider '${provider}'.`));
    console.error(`Set ${envVar} or add apiKey to axon.config.json.`);
    process.exit(1);
  }
  return key;
}

// ── REPL（交互式循环）─────────────────────────────────────────────────────────

/**
 * 启动交互式 REPL：循环读取用户输入，调用 session.chat()，直到用户退出。
 * 支持 Ctrl+C、exit、quit、q 等方式退出。
 */
async function repl(session: Session): Promise<void> {
  console.log(`${chalk.dim("Ctrl+C or type exit to quit")}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise<string>((resolve) => rl.question(chalk.green("> "), resolve));

  while (true) {
    let input: string;
    try {
      input = await ask();
    } catch {
      break; // Ctrl+C 或 stdin 关闭时退出
    }

    input = input.trim();
    if (!input) continue;
    if (["exit", "quit", "q"].includes(input)) break;

    await session.chat(input);
    console.log();
  }

  rl.close();
  await session.end(); // 触发 onSessionEnd 钩子
  console.log("Bye!");
}

// ── CLI 命令定义（commander）─────────────────────────────────────────────────

const program = new Command();

program
  .name("axon")
  .description("AI coding assistant")
  .argument("[prompt]", "Prompt to send (omit for interactive REPL)")
  .option("-m, --model <model>", "Model to use (e.g. deepseek-chat or anthropic:claude-3-5-sonnet)", DEFAULT_MODEL)
  .option("--yolo", "Skip all confirmations, execute directly")
  .option("--plan", "Show tool plan before each execution round, wait for user confirmation")
  .option("--log-level <level>", "Log level: debug|info|warn|error|silent", "info")
  .option("--log-file <file>", "Log output file path")
  .option("--teammate <name>", "Run as a teammate agent (used by spawnTeammate)")
  .action(async (prompt: string | undefined, options: { model: string; yolo?: boolean; plan?: boolean; logLevel?: string; logFile?: string; teammate?: string }) => {
    // 配置日志系统
    const levelMap: Record<string, LogLevel> = {
      debug: LogLevel.DEBUG, info: LogLevel.INFO, warn: LogLevel.WARN,
      error: LogLevel.ERROR, silent: LogLevel.SILENT,
    };
    configureLogger({
      level: levelMap[options.logLevel || "info"] ?? LogLevel.INFO,
      file: options.logFile || undefined,
    });

    // 根据 flag 设置执行模式
    if (options.yolo) {
      setMode("yolo");
      console.log(chalk.red("⚡ YOLO 模式：跳过所有确认"));
    } else if (options.plan) {
      setMode("plan");
      console.log(chalk.yellow("📋 Plan 模式：执行前需确认"));
    }

    // 加载配置文件（全局 + 项目级合并）
    const axonConfig = loadAxonConfig();

    // 解析 --model 参数，支持 "provider:model" 格式
    const { provider: flagProvider, model: flagModel } = parseModelFlag(options.model);

    // 确定最终使用的 provider 和 model（flag > config > 默认值）
    const provider = flagProvider ?? axonConfig.provider ?? "deepseek";
    const model = (flagProvider ? flagModel : null) ?? axonConfig.model ?? flagModel ?? DEFAULT_MODEL;

    // 创建 LLM 客户端（Anthropic 走专属适配器，其余走 OpenAI 兼容接口）
    let client: OpenAI;

    if (provider === "anthropic") {
      const apiKey = getApiKey("anthropic", axonConfig.apiKey);
      client = createAnthropicAdapter(apiKey, model);
    } else {
      const providerConfig: ProviderConfig = {
        provider,
        model,
        apiKey: getApiKey(provider, axonConfig.apiKey),
        baseURL: axonConfig.baseURL,
      };
      const created = createClient(providerConfig);
      client = created.client;
    }

    // 加载技能（.agents/skills/ 目录下的所有子目录）
    const skillsDir = path.join(process.cwd(), ".agents", "skills");
    const loader = new SkillLoader(skillsDir);
    setSkillLoader(loader);

    // 加载项目上下文（从 git 根目录向 cwd 逐层查找 AGENTS.md）
    const agentsContext = loadAgentsContext();

    // 加载长期记忆（~/.axon/memory/memory.md，由 Dream 整合生成）
    const memoryContext = loadMemoryContext();

    // 初始化 Hook 系统，注册内置插件
    const hooks = new HookSystem();
    hooks.register(new SessionCounterPlugin()); // 会话计数
    hooks.register(new AutoDreamPlugin(client, model)); // 自动 Dream 整合

    // 加载用户自定义插件（来自 axon.config.json 的 plugins 字段）
    if (axonConfig.plugins) {
      for (const pluginPath of axonConfig.plugins) {
        try {
          const resolved = path.resolve(process.cwd(), pluginPath);
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const plugin = require(resolved) as AxonPlugin;
          hooks.register(plugin);
        } catch (err: any) {
          logger.error("cli", `加载插件失败 '${pluginPath}': ${err.message}`);
          console.error(chalk.yellow(`⚠ Failed to load plugin '${pluginPath}': ${err.message}`));
        }
      }
    }

    // 初始化 MCP 服务端（如果配置了的话）
    if (axonConfig.mcpServers && Object.keys(axonConfig.mcpServers).length > 0) {
      logger.info("cli", "初始化 MCP servers...");
      await initMcpServers(axonConfig.mcpServers);
    }

    // ── 队友模式：读取收件箱、执行任务、回复 leader ──
    if (options.teammate) {
      const name = options.teammate;
      const instruction = process.env.AXON_TEAMMATE_INSTRUCTION || `你是团队成员 "${name}"，协助 leader 完成任务。`;
      logger.info("teams", `队友 "${name}" 已启动`);
      console.log(chalk.cyan(`🤝 队友 "${name}" 已启动，等待任务...`));

      // 加载收件箱工具
      const sessionForTeammate = new Session(
        "", model, agentsContext, memoryContext, hooks, undefined, client, loader,
      );

      const { readInbox, sendMessage } = await import("./tools/teams");

      // 持续监听收件箱，处理任务
      const pollInterval = 2000; // 2 秒轮询一次
      let consecutiveEmpty = 0;
      const maxEmptyPolls = 5; // 连续 5 次空则退出

      while (true) {
        // 读取并清空收件箱
        const inboxContent = readInbox(name);

        if (inboxContent === "" || inboxContent.includes("收件箱为空")) {
          consecutiveEmpty++;
          if (consecutiveEmpty >= maxEmptyPolls) {
            console.log(chalk.dim(`队友 "${name}" 收件箱连续 ${maxEmptyPolls} 次为空，退出。`));
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
          continue;
        }
        consecutiveEmpty = 0;

        console.log(chalk.dim(`📬 ${name} 收到新消息，开始处理...`));
        const fullPrompt = `${instruction}\n\n收到的消息：\n${inboxContent}\n\n请根据消息内容完成任务。完成后，使用 partner_send 工具将结果发送给 "leader"。`;
        await sessionForTeammate.chat(fullPrompt);
      }

      await sessionForTeammate.end();
      return;
    }

    // 仅在交互模式下打印 logo（非 --prompt 模式且非队友模式）
    if (!prompt && !options.teammate) {
      printLogo();
    }

    // 创建 Agent 会话
    const session = new Session(
      /* apiKey only used for legacy path; client is set via overrideClient */ "",
      model,
      agentsContext,
      memoryContext,
      hooks,
      undefined,
      client,
      loader,
    );

    if (prompt) {
      // 非交互模式：执行单次对话后退出
      await session.chat(prompt);
      await session.end();
    } else {
      // 交互模式：启动 REPL
      await repl(session);
    }
  });

program.parseAsync();
