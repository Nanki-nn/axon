import OpenAI from "openai";

export interface ProviderConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseURL?: string;
}

const PROVIDER_DEFAULTS: Record<string, { baseURL: string; defaultModel: string }> = {
  deepseek: { baseURL: "https://api.deepseek.com", defaultModel: "deepseek-chat" },
  openai:   { baseURL: "https://api.openai.com/v1", defaultModel: "gpt-4o" },
  gemini:   { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", defaultModel: "gemini-1.5-pro" },
  minimax:  { baseURL: "https://api.minimax.chat/v1", defaultModel: "abab6.5s-chat" },
  qwen:     { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-max" },
};

/**
 * Resolve ${ENV_VAR} references in the apiKey field.
 * This lets axon.config.json reference environment variables safely.
 */
function resolveApiKey(raw: string): string {
  return raw.replace(/^\$\{(\w+)\}$/, (_, name) => process.env[name] ?? raw);
}

/**
 * Factory that creates an OpenAI-compatible client for the given provider.
 * For Anthropic, returns a special adapter (see ./anthropic.ts).
 * All others use the OpenAI SDK pointed at the provider's compatible endpoint.
 */
export function createClient(config: ProviderConfig): { client: OpenAI; model: string; baseURL: string } {
  const apiKey = resolveApiKey(config.apiKey);
  const defaults = PROVIDER_DEFAULTS[config.provider];
  const baseURL = config.baseURL ?? defaults?.baseURL ?? "https://api.deepseek.com";
  const model = config.model ?? defaults?.defaultModel ?? "deepseek-chat";

  const client = new OpenAI({ apiKey, baseURL });
  return { client, model, baseURL };
}

/** Parse a --model flag like "anthropic:claude-3-5-sonnet" or plain "deepseek-chat" */
export function parseModelFlag(flag: string): { provider: string | null; model: string } {
  const colonIdx = flag.indexOf(":");
  if (colonIdx === -1) return { provider: null, model: flag };
  return {
    provider: flag.slice(0, colonIdx),
    model: flag.slice(colonIdx + 1),
  };
}
