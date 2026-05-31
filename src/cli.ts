#!/usr/bin/env node
import * as readline from "readline";
import * as path from "path";
import * as fs from "fs";
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
import { createAnthropicAdapter } from "./providers/anthropic";

config();

// ── axon.config.json ──────────────────────────────────────────────────────────

interface AxonConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  mcpServers?: Record<string, McpServerConfig>;
  plugins?: string[];
}

function loadAxonConfig(): AxonConfig {
  const configPath = path.join(process.cwd(), "axon.config.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as AxonConfig;
  } catch {
    return {};
  }
}

// ── API key resolution ────────────────────────────────────────────────────────

function getApiKey(provider: string, configKey?: string): string {
  // Config file key takes precedence (supports ${ENV_VAR} syntax — resolved by createClient)
  if (configKey) return configKey;

  // Fall back to provider-specific env vars
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

// ── REPL ─────────────────────────────────────────────────────────────────────

async function repl(session: Session): Promise<void> {
  console.log(`${chalk.cyan("axon")}  Ctrl+C or type ${chalk.dim("exit")} to quit\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise<string>((resolve) => rl.question(chalk.green("> "), resolve));

  while (true) {
    let input: string;
    try {
      input = await ask();
    } catch {
      break;
    }

    input = input.trim();
    if (!input) continue;
    if (["exit", "quit", "q"].includes(input)) break;

    await session.chat(input);
    console.log();
  }

  rl.close();
  await session.end();
  console.log("Bye!");
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("axon")
  .description("AI coding assistant")
  .argument("[prompt]", "Prompt to send (omit for interactive REPL)")
  .option("-m, --model <model>", "Model to use (e.g. deepseek-chat or anthropic:claude-3-5-sonnet)", DEFAULT_MODEL)
  .option("--yolo", "Skip all confirmations, execute directly")
  .option("--plan", "Show tool plan before each execution round, wait for user confirmation")
  .action(async (prompt: string | undefined, options: { model: string; yolo?: boolean; plan?: boolean }) => {
    // Mode flags
    if (options.yolo) {
      setMode("yolo");
      console.log(chalk.red("⚡ YOLO 模式：跳过所有确认"));
    } else if (options.plan) {
      setMode("plan");
      console.log(chalk.yellow("📋 Plan 模式：执行前需确认"));
    }

    // Load config file
    const axonConfig = loadAxonConfig();

    // Parse model flag (supports "provider:model" syntax)
    const { provider: flagProvider, model: flagModel } = parseModelFlag(options.model);

    // Determine provider + model
    const provider = flagProvider ?? axonConfig.provider ?? "deepseek";
    const model = (flagProvider ? flagModel : null) ?? axonConfig.model ?? flagModel ?? DEFAULT_MODEL;

    // Build the LLM client
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

    // Skills
    const skillsDir = path.join(process.cwd(), ".agents", "skills");
    const loader = new SkillLoader(skillsDir);
    setSkillLoader(loader);
    if (loader.size > 0) {
      console.log(chalk.dim(`✓ 已加载 ${loader.size} 个 skills (${loader.names().join(", ")})`));
    }

    // Project context (AGENTS.md)
    const agentsContext = loadAgentsContext();
    if (agentsContext) {
      console.log(chalk.dim("✓ 已加载项目上下文 (AGENTS.md)"));
    }

    // Long-term memory
    const memoryContext = loadMemoryContext();
    if (memoryContext) {
      console.log(chalk.dim("✓ 已加载长期记忆"));
    }

    // Hook system
    const hooks = new HookSystem();
    hooks.register(new SessionCounterPlugin());
    hooks.register(new AutoDreamPlugin(client, model));

    // Load user plugins from config
    if (axonConfig.plugins) {
      for (const pluginPath of axonConfig.plugins) {
        try {
          const resolved = path.resolve(process.cwd(), pluginPath);
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const plugin = require(resolved) as AxonPlugin;
          hooks.register(plugin);
        } catch (err: any) {
          console.error(chalk.yellow(`⚠ Failed to load plugin '${pluginPath}': ${err.message}`));
        }
      }
    }

    // MCP servers
    if (axonConfig.mcpServers && Object.keys(axonConfig.mcpServers).length > 0) {
      console.log(chalk.dim("✓ 初始化 MCP servers..."));
      await initMcpServers(axonConfig.mcpServers);
    }

    const session = new Session(
      /* apiKey only used for legacy path; client is set via overrideClient */ "",
      model,
      agentsContext,
      memoryContext,
      hooks,
      undefined,
      client,
    );

    if (prompt) {
      await session.chat(prompt);
      await session.end();
    } else {
      await repl(session);
    }
  });

program.parseAsync();
