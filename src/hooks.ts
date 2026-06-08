import OpenAI from "openai";

type Message = OpenAI.Chat.ChatCompletionMessageParam;

/**
 * 插件接口：定义 Agent 生命周期的各个钩子。
 * 实现此接口的类可以在工具调用、LLM 响应、压缩、会话结束等关键节点介入。
 */
export interface AxonPlugin {
  /** 工具调用前触发，可用于日志、审计、请求拦截 */
  onBeforeToolCall?(ctx: { name: string; input: Record<string, string> }): Promise<void>;
  /** 工具调用后触发，可用于结果监控或后处理 */
  onAfterToolCall?(ctx: { name: string; input: Record<string, string>; output: string }): Promise<void>;
  /** LLM 每次生成完整回复后触发（包含文字内容和工具调用列表） */
  onAfterLLMResponse?(ctx: { content: string; toolCalls: Array<{ id: string; name: string; arguments: string }> }): Promise<void>;
  /** 上下文压缩流水线启动前触发，可用于记录压缩前状态 */
  onBeforeCompact?(ctx: { messages: Message[] }): Promise<void>;
  /** 每轮用户-助手交互结束后触发（一次 chat() 调用完成） */
  onTurnEnd?(ctx: { messages: Message[] }): Promise<void>;
  /** 整个会话结束时触发（REPL 退出或单次执行完成） */
  onSessionEnd?(ctx: { messages: Message[] }): Promise<void>;
}

/**
 * Hook 系统：管理所有已注册插件，并在事件发生时依次调用对应钩子。
 * 插件按注册顺序串行执行，任一插件抛出异常会中断后续插件。
 */
export class HookSystem {
  private plugins: AxonPlugin[] = [];

  /** 注册一个插件，未实现的钩子方法会被自动跳过 */
  register(plugin: AxonPlugin): void {
    this.plugins.push(plugin);
  }

  /** 触发指定事件，将 ctx 传递给所有实现了该钩子的插件 */
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
