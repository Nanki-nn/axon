import OpenAI from "openai";
import chalk from "chalk";
import { AxonPlugin } from "../hooks";
import { appendSessionLog, runDream, shouldDream } from "../memory";
import {
  getSessionCount,
  getLastDreamAt,
  incrementSessionCount,
  resetDreamTimestamp,
} from "./session-counter";

export class AutoDreamPlugin implements AxonPlugin {
  private client: OpenAI;
  private model: string;

  constructor(client: OpenAI, model: string) {
    this.client = client;
    this.model = model;
  }

  async onTurnEnd(ctx: { messages: OpenAI.Chat.ChatCompletionMessageParam[] }): Promise<void> {
    // Build a simple summary from the last user+assistant exchange
    const msgs = ctx.messages;
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
    if (!lastUser && !lastAssistant) return;

    const userText = typeof lastUser?.content === "string" ? lastUser.content : "";
    const assistantText = typeof lastAssistant?.content === "string"
      ? lastAssistant.content.slice(0, 400)
      : "";

    const summary = `**User:** ${userText.slice(0, 200)}\n**Assistant:** ${assistantText}`;
    appendSessionLog(summary);
  }

  async onSessionEnd(): Promise<void> {
    incrementSessionCount();

    const count = getSessionCount();
    const lastDream = getLastDreamAt();

    if (shouldDream(count, lastDream)) {
      console.log(chalk.dim("[Auto-Dream: 后台整合记忆...]"));
      // Run asynchronously — don't block session end
      setImmediate(async () => {
        try {
          await runDream(this.client, this.model);
          resetDreamTimestamp();
        } catch (err: any) {
          console.error(chalk.dim(`[Auto-Dream 失败: ${err.message}]`));
        }
      });
    }
  }
}
