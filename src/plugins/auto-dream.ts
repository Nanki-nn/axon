import OpenAI from "openai";
import { AxonPlugin } from "../hooks";
import { appendSessionLog, runDream, shouldDream } from "../memory";
import { logger } from "../logger";
import {
  getSessionCount,
  getLastDreamAt,
  incrementSessionCount,
  resetDreamTimestamp,
} from "./session-counter";

/**
 * AutoDreamPlugin：自动触发长期记忆整合的插件。
 *
 * 两个职责：
 *   1. onTurnEnd：每轮对话结束后，将最后一组问答摘要写入今日会话日志
 *   2. onSessionEnd：会话结束时检查是否达到 Dream 触发条件，
 *      满足则异步（setImmediate）执行 Dream 整合，不阻塞 CLI 退出
 */
export class AutoDreamPlugin implements AxonPlugin {
  private client: OpenAI;
  private model: string;

  constructor(client: OpenAI, model: string) {
    this.client = client;
    this.model = model;
  }

  /**
   * 每轮结束后记录简短摘要到会话日志。
   * 只取最后一条 user 和 assistant 消息，避免日志过长。
   */
  async onTurnEnd(ctx: { messages: OpenAI.Chat.ChatCompletionMessageParam[] }): Promise<void> {
    const msgs = ctx.messages;
    // 从尾部找最近的 user/assistant 消息（reverse 不修改原数组）
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
    if (!lastUser && !lastAssistant) return;

    const userText = typeof lastUser?.content === "string" ? lastUser.content : "";
    const assistantText = typeof lastAssistant?.content === "string"
      ? lastAssistant.content.slice(0, 400)  // 截断，避免日志过大
      : "";

    const summary = `**User:** ${userText.slice(0, 200)}\n**Assistant:** ${assistantText}`;
    appendSessionLog(summary);
  }

  /**
   * 会话结束时递增计数，检查是否需要触发 Dream。
   * Dream 用 setImmediate 异步执行，不阻塞进程退出。
   * Dream 失败时只打印警告，不影响主流程。
   */
  async onSessionEnd(): Promise<void> {
    incrementSessionCount();

    const count = getSessionCount();
    const lastDream = getLastDreamAt();

    if (shouldDream(count, lastDream)) {
      logger.info("dream", "开始后台整合记忆...");
      // 异步执行，避免阻塞会话结束
      setImmediate(async () => {
        try {
          await runDream(this.client, this.model);
          resetDreamTimestamp(); // Dream 完成后重置计时器
        } catch (err: any) {
          logger.error("dream", `整合记忆失败: ${err.message}`);
        }
      });
    }
  }
}
