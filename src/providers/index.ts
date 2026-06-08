import OpenAI from "openai";

export interface ProviderConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseURL?: string;
}

/**
 * 各提供商的默认端点和模型。
 * 所有非 Anthropic 提供商都兼容 OpenAI SDK（使用 compatible-mode 或原生支持）。
 */
const PROVIDER_DEFAULTS: Record<string, { baseURL: string; defaultModel: string }> = {
  deepseek: { baseURL: "https://api.deepseek.com", defaultModel: "deepseek-chat" },
  openai:   { baseURL: "https://api.openai.com/v1", defaultModel: "gpt-4o" },
  gemini:   { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", defaultModel: "gemini-1.5-pro" },
  minimax:  { baseURL: "https://api.minimax.chat/v1", defaultModel: "abab6.5s-chat" },
  qwen:     { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-max" },
};

/**
 * 解析 apiKey 字段中的环境变量引用（如 ${DEEPSEEK_API_KEY}）。
 * 只支持整个字段是单个变量引用的写法，不做嵌套替换。
 */
function resolveApiKey(raw: string): string {
  return raw.replace(/^\$\{(\w+)\}$/, (_, name) => process.env[name] ?? raw);
}

/**
 * 根据 ProviderConfig 创建 OpenAI 兼容的 LLM 客户端。
 * Anthropic 的适配器由 ./anthropic.ts 单独处理，不走此函数。
 */
export function createClient(config: ProviderConfig): { client: OpenAI; model: string; baseURL: string } {
  const apiKey = resolveApiKey(config.apiKey);
  const defaults = PROVIDER_DEFAULTS[config.provider];
  const baseURL = config.baseURL ?? defaults?.baseURL ?? "https://api.deepseek.com";
  const model = config.model ?? defaults?.defaultModel ?? "deepseek-chat";

  const client = new OpenAI({ apiKey, baseURL });
  return { client, model, baseURL };
}

/**
 * 解析 --model 参数，支持两种格式：
 *   - "anthropic:claude-3-5-sonnet" → { provider: "anthropic", model: "claude-3-5-sonnet" }
 *   - "deepseek-chat"               → { provider: null, model: "deepseek-chat" }
 *
 * provider 为 null 时，使用配置文件或默认值中的 provider。
 */
export function parseModelFlag(flag: string): { provider: string | null; model: string } {
  const colonIdx = flag.indexOf(":");
  if (colonIdx === -1) return { provider: null, model: flag };
  return {
    provider: flag.slice(0, colonIdx),
    model: flag.slice(colonIdx + 1),
  };
}
