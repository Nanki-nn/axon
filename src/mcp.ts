import { spawn, ChildProcess } from "child_process";
import { registerMcpTool } from "./tools";
import { logger } from "./logger";

// ── JSON-RPC 2.0 基础类型 ──────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** MCP 服务端暴露的工具描述（tools/list 返回的元素） */
interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** .axon/config.json 中 mcpServers 字段的单条配置 */
export interface McpServerConfig {
  command: string;       // 启动命令，例如 "node" 或 "python"
  args?: string[];       // 命令行参数
  env?: Record<string, string>; // 额外环境变量，支持 ${ENV_VAR} 语法
}

/**
 * MCPClient：通过 stdio JSON-RPC 与单个 MCP 服务端进程通信。
 *
 * 协议流程：
 *   1. spawn 子进程
 *   2. 发送 initialize 握手
 *   3. 调用 tools/list 获取工具列表
 *   4. 按需调用 tools/call 执行工具
 */
export class MCPClient {
  private proc: ChildProcess;
  private buffer = "";  // 行缓冲，处理 stdout 分片
  /** 等待响应的 pending 请求：id → { resolve, reject } */
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;   // 单调递增的请求 ID
  private ready = false; // initialize 握手完成后置为 true

  constructor(private name: string, config: McpServerConfig) {
    const resolvedEnv = resolveEnvVars(config.env ?? {});
    // 启动 MCP 服务端子进程，使用 pipe 通信
    this.proc = spawn(config.command, config.args ?? [], {
      env: { ...process.env, ...resolvedEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // 逐行解析 stdout，找到完整 JSON 行后分发给对应 pending 请求
    this.proc.stdout!.setEncoding("utf-8");
    this.proc.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        } catch {
          // 非 JSON 行（如服务端启动日志）忽略即可
        }
      }
    });

    // 静默丢弃 stderr（MCP 服务端可能输出调试信息）
    this.proc.stderr!.on("data", () => {/* suppress MCP server stderr */});
    // 子进程异常退出时，拒绝所有等待中的请求
    this.proc.on("error", (err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  /**
   * 发送一条 JSON-RPC 请求，返回 Promise<result>。
   * 超过 30 秒未收到响应视为超时。
   */
  private send(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      this.pending.set(id, { resolve, reject });
      // 将请求写入子进程的 stdin（每行一条 JSON）
      this.proc.stdin!.write(JSON.stringify(req) + "\n");
      // 30 秒超时保护
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  /** 执行 MCP 握手，之后才能调用 listTools / callTool */
  async initialize(): Promise<void> {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "axon", version: "0.1.0" },
    });
    await this.send("notifications/initialized");
    this.ready = true;
  }

  /** 获取服务端暴露的所有工具定义 */
  async listTools(): Promise<McpToolSchema[]> {
    const result = await this.send("tools/list") as { tools?: McpToolSchema[] };
    return result?.tools ?? [];
  }

  /** 调用指定工具，返回文本输出 */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (!this.ready) throw new Error(`MCP client '${this.name}' not initialized`);
    const result = await this.send("tools/call", { name: toolName, arguments: args }) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    // 只取 type=text 的内容块，拼成字符串
    const content = result?.content ?? [];
    const text = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");
    if (result?.isError) return `Error from MCP tool: ${text}`;
    return text || "(no output)";
  }

  /** 终止子进程 */
  terminate(): void {
    this.proc.kill();
  }
}

/**
 * 展开环境变量引用，将 ${ENV_VAR} 替换为对应的 process.env 值。
 * 找不到对应变量时保留原始字符串（不静默失败）。
 */
function resolveEnvVars(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = v.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
  }
  return out;
}

/**
 * 批量初始化配置中的所有 MCP 服务端，并将其工具注册到全局工具分发器。
 *
 * 工具命名规则：serverName__toolName（双下划线分隔，避免与内置工具冲突）
 * 某个服务端初始化失败时，打印警告后继续处理其他服务端（非致命错误）。
 */
export async function initMcpServers(
  mcpServers: Record<string, McpServerConfig>,
): Promise<MCPClient[]> {
  const clients: MCPClient[] = [];

  for (const [serverName, config] of Object.entries(mcpServers)) {
    try {
      const client = new MCPClient(serverName, config);
      await client.initialize();
      const tools = await client.listTools();

      for (const tool of tools) {
        // 加上服务名前缀，防止不同服务端有同名工具
        const qualifiedName = `${serverName}__${tool.name}`;
        const definition = {
          type: "function" as const,
          function: {
            name: qualifiedName,
            description: tool.description ?? `MCP tool: ${tool.name}`,
            parameters: tool.inputSchema,
          },
        };
        // dispatcher 闭包捕获 client 和 tool.name，调用时转发到对应服务端
        const dispatcher = (input: Record<string, string>) =>
          client.callTool(tool.name, input as Record<string, unknown>);
        registerMcpTool(definition, dispatcher);
      }

      clients.push(client);
    } catch (err: any) {
      logger.error("mcp", `Failed to init '${serverName}': ${err.message}`);
    }
  }

  return clients;
}
