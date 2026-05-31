#!/usr/bin/env node
import * as readline from "readline";
import * as path from "path";
import { config } from "dotenv";
import { Command } from "commander";
import chalk from "chalk";
import { Session, DEFAULT_MODEL } from "./agent";
import { loadAgentsContext } from "./context";
import { setMode } from "./mode";
import { SkillLoader } from "./skills";
import { setSkillLoader } from "./tools";

config();

function getApiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) {
    console.error(chalk.red("DEEPSEEK_API_KEY not set."));
    console.error("Add it to a .env file or export it in your shell.");
    process.exit(1);
  }
  return key;
}

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
  console.log("Bye!");
}

const program = new Command();

program
  .name("axon")
  .description("AI coding assistant powered by Claude")
  .argument("[prompt]", "Prompt to send (omit for interactive REPL)")
  .option("-m, --model <model>", "使用的模型", DEFAULT_MODEL)
  .option("--yolo", "跳过所有确认，直接执行（包括危险命令）")
  .option("--plan", "每轮工具调用前展示计划，等待用户确认后再执行")
  .action(async (prompt: string | undefined, options: { model: string; yolo?: boolean; plan?: boolean }) => {
    // 根据 flag 设置执行模式，yolo 和 plan 互斥，yolo 优先
    if (options.yolo) {
      setMode("yolo");
      console.log(chalk.red("⚡ YOLO 模式：跳过所有确认"));
    } else if (options.plan) {
      setMode("plan");
      console.log(chalk.yellow("📋 Plan 模式：执行前需确认"));
    }
    // 启动时扫描 .agents/skills/，把 SkillLoader 注入工具分发层
    const skillsDir = path.join(process.cwd(), ".agents", "skills");
    const loader = new SkillLoader(skillsDir);
    setSkillLoader(loader);
    if (loader.size > 0) {
      console.log(chalk.dim(`✓ 已加载 ${loader.size} 个 skills (${loader.names().join(", ")})`));
    }

    // 启动时扫描 AGENTS.md，有内容则提示用户
    const agentsContext = loadAgentsContext();
    if (agentsContext) {
      console.log(chalk.dim("✓ 已加载项目上下文 (AGENTS.md)"));
    }

    const session = new Session(getApiKey(), options.model, agentsContext, loader.getDescriptions());
    if (prompt) {
      await session.chat(prompt);
    } else {
      await repl(session);
    }
  });

program.parseAsync();
