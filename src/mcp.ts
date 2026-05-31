import { spawn, ChildProcess } from "child_process";
import { registerMcpTool } from "./tools";

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

interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export class MCPClient {
  private proc: ChildProcess;
  private buffer = "";
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private ready = false;

  constructor(private name: string, config: McpServerConfig) {
    const resolvedEnv = resolveEnvVars(config.env ?? {});
    this.proc = spawn(config.command, config.args ?? [], {
      env: { ...process.env, ...resolvedEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });

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
          // Non-JSON lines (e.g. server startup messages) — ignore
        }
      }
    });

    this.proc.stderr!.on("data", () => {/* suppress MCP server stderr */});
    this.proc.on("error", (err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  private send(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      this.pending.set(id, { resolve, reject });
      this.proc.stdin!.write(JSON.stringify(req) + "\n");
      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  async initialize(): Promise<void> {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "axon", version: "0.1.0" },
    });
    await this.send("notifications/initialized");
    this.ready = true;
  }

  async listTools(): Promise<McpToolSchema[]> {
    const result = await this.send("tools/list") as { tools?: McpToolSchema[] };
    return result?.tools ?? [];
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (!this.ready) throw new Error(`MCP client '${this.name}' not initialized`);
    const result = await this.send("tools/call", { name: toolName, arguments: args }) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const content = result?.content ?? [];
    const text = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");
    if (result?.isError) return `Error from MCP tool: ${text}`;
    return text || "(no output)";
  }

  terminate(): void {
    this.proc.kill();
  }
}

/** Expand ${ENV_VAR} references in MCP env config */
function resolveEnvVars(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = v.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
  }
  return out;
}

/** Initialize all MCP servers from config and register their tools */
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
        // Prefix tool name with server name to avoid collisions
        const qualifiedName = `${serverName}__${tool.name}`;
        const definition = {
          type: "function" as const,
          function: {
            name: qualifiedName,
            description: tool.description ?? `MCP tool: ${tool.name}`,
            parameters: tool.inputSchema,
          },
        };
        const dispatcher = (input: Record<string, string>) =>
          client.callTool(tool.name, input as Record<string, unknown>);
        registerMcpTool(definition, dispatcher);
      }

      clients.push(client);
    } catch (err: any) {
      // MCP server init failure is non-fatal — log and continue
      process.stderr.write(`[MCP] Failed to init '${serverName}': ${err.message}\n`);
    }
  }

  return clients;
}
