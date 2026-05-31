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
  dir: string;
}

export class SkillLoader {
  private skills: Map<string, Skill> = new Map();

  constructor(skillsDir: string) {
    if (!fs.existsSync(skillsDir)) return;

    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(skillsDir, entry.name);
      const skillFile = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;

      const text = fs.readFileSync(skillFile, "utf-8");
      const { meta, body } = parseFrontmatter(text);
      const name = meta.name || entry.name;
      this.skills.set(name, { meta: { name, description: "", ...meta }, body, dir: skillDir });
    }
  }

  get size(): number {
    return this.skills.size;
  }

  names(): string[] {
    return Array.from(this.skills.keys());
  }

  /** Returns a compact listing: name + truncated description (for skill_list tool) */
  listSkills(): string {
    if (this.skills.size === 0) return "No skills available.";
    const lines = Array.from(this.skills.values()).map((s) => {
      const desc = (s.meta.description ?? "").replace(/\n/g, " ").trim().slice(0, 120);
      return `- **${s.meta.name}**: ${desc}`;
    });
    return lines.join("\n");
  }

  /** Full body returned in tool_result, with references/ file listing */
  getContent(name: string): string {
    const skill = this.skills.get(name);
    if (!skill) {
      const available = this.names().join(", ") || "(none)";
      return `Error: Unknown skill '${name}'. Available: ${available}`;
    }

    let content = `<skill name="${name}">\n${skill.body}`;

    // Append references/ directory listing if it exists
    const refsDir = path.join(skill.dir, "references");
    if (fs.existsSync(refsDir)) {
      const refs = fs.readdirSync(refsDir).filter((f) => {
        const full = path.join(refsDir, f);
        return fs.statSync(full).isFile();
      });
      if (refs.length > 0) {
        content += `\n\n### references/\n${refs.map((f) => `- ${f}`).join("\n")}`;
      }
    }

    content += "\n</skill>";
    return content;
  }

  /** List files inside references/ sub-directory for a given skill */
  getFileList(name: string): string[] {
    const skill = this.skills.get(name);
    if (!skill) return [];
    const refsDir = path.join(skill.dir, "references");
    if (!fs.existsSync(refsDir)) return [];
    return fs.readdirSync(refsDir).filter((f) => {
      return fs.statSync(path.join(refsDir, f)).isFile();
    });
  }
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: text.trim() };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && val) meta[key] = val;
  }

  // Handle multi-line YAML description block
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
