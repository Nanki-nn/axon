import OpenAI from "openai";

type Message = OpenAI.Chat.ChatCompletionMessageParam;

export interface AxonPlugin {
  onBeforeToolCall?(ctx: { name: string; input: Record<string, string> }): Promise<void>;
  onAfterToolCall?(ctx: { name: string; input: Record<string, string>; output: string }): Promise<void>;
  onAfterLLMResponse?(ctx: { content: string; toolCalls: Array<{ id: string; name: string; arguments: string }> }): Promise<void>;
  onBeforeCompact?(ctx: { messages: Message[] }): Promise<void>;
  onTurnEnd?(ctx: { messages: Message[] }): Promise<void>;
  onSessionEnd?(ctx: { messages: Message[] }): Promise<void>;
}

export class HookSystem {
  private plugins: AxonPlugin[] = [];

  register(plugin: AxonPlugin): void {
    this.plugins.push(plugin);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async emit(event: keyof AxonPlugin, ctx: any): Promise<void> {
    for (const plugin of this.plugins) {
      const handler = plugin[event] as ((ctx: any) => Promise<void>) | undefined;
      if (handler) {
        await handler.call(plugin, ctx);
      }
    }
  }
}
