import { existsSync, mkdirSync, readFileSync, appendFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { getMode, Mode } from "./mode";
import { getProjectAxonDir } from "./project-paths";

type PermissionAction = "allow" | "deny" | "confirm";
type RuleDecision = "allow" | "deny" | null;

export interface PermissionDecision {
  action: PermissionAction;
  message?: string;
}

interface ParsedRule {
  tool: string;
  pattern: string | null;
}

interface PermissionRules {
  allow: ParsedRule[];
  deny: ParsedRule[];
}

const READ_TOOLS = new Set([
  "read_file",
  "list_files",
  "search_files",
  "skill_list",
  "skill_read",
  "memory_list",
  "memory_read",
  "task_list",
  "check_background",
  "partner_list",
  "partner_read_inbox",
]);

const EDIT_TOOLS = new Set([
  "write_file",
  "edit_file",
  "memory_save",
  "memory_delete",
  "task_create",
  "task_update",
  "task_delete",
  "partner_create",
  "partner_remove",
  "partner_send",
  "partner_broadcast",
]);

const SHELL_TOOLS = new Set(["bash", "background_run"]);

const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+(-[^\s]*[rf][^\s]*|.*\*)/,
  /\bsudo\b/,
  /\bgit\s+(push|reset|clean|checkout\s+\.|branch\s+-D|push\s+.*--force)\b/,
  /\bchmod\s+(-R\s+)?777\b/,
  /\bchown\s+-R\b/,
  /\bmkfs\b/,
  /\bdd\s+/,
  />\s*\/dev\//,
  /\bkill(all)?\b/,
  /\bpkill\b/,
  /\breboot\b/,
  /\bshutdown\b/,
  /\bcurl\b.*\|\s*(bash|sh)\b/,
  /\bwget\b.*\|\s*(bash|sh)\b/,
  /\bnpm\s+install\b/,
  /\bpnpm\s+install\b/,
  /\byarn\s+add\b/,
  /\bdel\s/i,
  /\brmdir\s/i,
  /\bformat\s/i,
  /\btaskkill\s/i,
  /\bRemove-Item\s/i,
  /\bStop-Process\s/i,
];

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(api[_-]?key["'\s:=]+)([^"'\s,}]+)/gi,
  /(token["'\s:=]+)([^"'\s,}]+)/gi,
  /(authorization:\s*bearer\s+)([A-Za-z0-9._-]+)/gi,
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g,
];

let cachedRules: PermissionRules | null = null;

function parseRule(rule: string): ParsedRule {
  const match = rule.match(/^([a-zA-Z0-9_:-]+)(?:\((.*)\))?$/);
  if (!match) return { tool: rule, pattern: null };
  return { tool: match[1], pattern: match[2] ?? null };
}

function readSettings(filePath: string): any {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export function resetPermissionCache(): void {
  cachedRules = null;
}

function loadPermissionRules(): PermissionRules {
  if (cachedRules) return cachedRules;

  const allow: ParsedRule[] = [];
  const deny: ParsedRule[] = [];
  const envSettingsFiles = process.env.AXON_PERMISSION_SETTINGS_PATHS
    ? process.env.AXON_PERMISSION_SETTINGS_PATHS.split(":").filter(Boolean)
    : [];
  const settingsFiles = envSettingsFiles.length > 0 ? envSettingsFiles : [
    join(homedir(), ".axon", "settings.json"),
    join(process.cwd(), ".axon", "settings.json"),
    join(process.cwd(), ".axon", "config.json"),
  ];

  for (const filePath of settingsFiles) {
    const settings = readSettings(filePath);
    const permissions = settings?.permissions;
    if (!permissions) continue;
    if (Array.isArray(permissions.allow)) {
      for (const rule of permissions.allow) allow.push(parseRule(String(rule)));
    }
    if (Array.isArray(permissions.deny)) {
      for (const rule of permissions.deny) deny.push(parseRule(String(rule)));
    }
  }

  cachedRules = { allow, deny };
  return cachedRules;
}

function permissionValue(toolName: string, input: Record<string, any>): string {
  if (SHELL_TOOLS.has(toolName)) return String(input.command ?? "");
  return String(input.path ?? input.filename ?? input.name ?? input.taskId ?? "");
}

function matchesRule(rule: ParsedRule, toolName: string, input: Record<string, any>): boolean {
  if (rule.tool !== toolName && rule.tool !== "*") return false;
  if (!rule.pattern) return true;

  const value = permissionValue(toolName, input);
  if (rule.pattern.endsWith("*")) return value.startsWith(rule.pattern.slice(0, -1));
  if (rule.pattern.includes("*")) {
    const regex = new RegExp(`^${rule.pattern.split("*").map(escapeRegex).join(".*")}$`);
    return regex.test(value);
  }
  return value === rule.pattern;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function checkPermissionRules(toolName: string, input: Record<string, any>): RuleDecision {
  const rules = loadPermissionRules();
  for (const rule of rules.deny) {
    if (matchesRule(rule, toolName, input)) return "deny";
  }
  for (const rule of rules.allow) {
    if (matchesRule(rule, toolName, input)) return "allow";
  }
  return null;
}

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function needsFileCreationConfirmation(toolName: string, input: Record<string, any>): string | null {
  if (toolName !== "write_file" && toolName !== "edit_file") return null;
  const filePath = String(input.path ?? "");
  if (!filePath) return null;
  if (toolName === "write_file" && !existsSync(filePath)) return `write new file: ${filePath}`;
  if (toolName === "edit_file" && !existsSync(filePath)) return `edit non-existent file: ${filePath}`;
  return null;
}

export function checkPermission(
  toolName: string,
  input: Record<string, any>,
  mode: Mode = getMode(),
): PermissionDecision {
  const ruleResult = checkPermissionRules(toolName, input);
  if (ruleResult === "deny") return { action: "deny", message: `Denied by permission rule for ${toolName}` };
  if (ruleResult === "allow") return { action: "allow" };

  if (mode === "yolo") return { action: "allow" };
  if (READ_TOOLS.has(toolName)) return { action: "allow" };

  if (mode === "plan") {
    if (EDIT_TOOLS.has(toolName)) return { action: "deny", message: `Blocked in plan mode: ${toolName}` };
    if (SHELL_TOOLS.has(toolName)) return { action: "deny", message: `Shell command blocked in plan mode: ${toolName}` };
  }

  if (mode === "accept-edits" && EDIT_TOOLS.has(toolName)) return { action: "allow" };

  const command = String(input.command ?? "");
  let confirmMessage = "";
  if (SHELL_TOOLS.has(toolName) && isDangerousCommand(command)) {
    confirmMessage = `${toolName}: ${command}`;
  } else if (toolName.includes("__")) {
    confirmMessage = `external MCP tool: ${toolName}`;
  } else {
    confirmMessage = needsFileCreationConfirmation(toolName, input) ?? "";
  }

  if (confirmMessage) {
    if (mode === "dont-ask") return { action: "deny", message: `Auto-denied: ${confirmMessage}` };
    return { action: "confirm", message: confirmMessage };
  }

  return { action: "allow" };
}

export function maskSecrets(text: string): string {
  let masked = text;
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, (...parts: string[]) => {
      if (parts.length >= 4 && parts[1]) return `${parts[1]}[REDACTED]`;
      return "[REDACTED_SECRET]";
    });
  }
  return masked;
}

export function auditToolCall(entry: {
  toolName: string;
  input: Record<string, any>;
  decision: PermissionDecision;
  output?: string;
}): void {
  const auditPath = join(getProjectAxonDir(), "security", "audit.log");
  mkdirSync(dirname(auditPath), { recursive: true });
  const line = {
    ts: new Date().toISOString(),
    toolName: entry.toolName,
    input: maskSecrets(JSON.stringify(entry.input)),
    decision: entry.decision.action,
    message: entry.decision.message,
    outputPreview: entry.output ? maskSecrets(entry.output).slice(0, 500) : undefined,
  };
  appendFileSync(auditPath, JSON.stringify(line) + "\n", "utf-8");
}
