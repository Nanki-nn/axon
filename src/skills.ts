import * as fs from "fs";
import * as path from "path";

interface SkillMeta {
  name: string;
  description: string;
  [key: string]: unknown;
}

interface Skill {
  meta: SkillMeta;
  body: string;
}

export class SkillLoader {
  private skills: Map<string, Skill> = new Map();

  constructor(skillsDir: string) {
    if (!fs.existsSync(skillsDir)) return;

    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;

      const text = fs.readFileSync(skillFile, "utf-8");
      const { meta, body } = parseFrontmatter(text);
      const name = meta.name || entry.name;
      this.skills.set(name, { meta: { name, description: "", ...meta }, body });
    }
  }

  get size(): number {
    return this.skills.size;
  }

  names(): string[] {
    return Array.from(this.skills.keys());
  }

  // Layer 1: short listing for system prompt (~100 tokens/skill)
  getDescriptions(): string {
    if (this.skills.size === 0) return "";
    const lines = Array.from(this.skills.values()).map((s) => {
      const desc = s.meta.description?.replace(/\n/g, " ").trim() ?? "";
      return `  - ${s.meta.name}: ${desc}`;
    });
    return lines.join("\n");
  }

  // Layer 2: full body returned in tool_result
  getContent(name: string): string {
    const skill = this.skills.get(name);
    if (!skill) {
      const available = this.names().join(", ") || "(none)";
      return `Error: Unknown skill '${name}'. Available: ${available}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: text.trim() };

  const meta: Record<string, string> = {};
  // Minimal YAML key: value parsing (no deps)
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && val) meta[key] = val;
  }

  // Multi-line YAML values (e.g. `description: >\n  some text`)
  // Handle the common pattern where description spans multiple lines
  const descMatch = match[1].match(/^description:\s*[>|]?\s*\n((?:[ \t]+.+\n?)*)/m);
  if (descMatch) {
    meta["description"] = descMatch[1]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" ");
  }

  return { meta, body: match[2].trim() };
}
