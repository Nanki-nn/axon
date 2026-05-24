#!/usr/bin/env node
import * as readline from "readline";
import { config } from "dotenv";
import { Command } from "commander";
import chalk from "chalk";
import { Session, DEFAULT_MODEL } from "./agent";

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
  .option("-m, --model <model>", "Claude model to use", DEFAULT_MODEL)
  .action(async (prompt: string | undefined, options: { model: string }) => {
    const session = new Session(getApiKey(), options.model);
    if (prompt) {
      await session.chat(prompt);
    } else {
      await repl(session);
    }
  });

program.parseAsync();
