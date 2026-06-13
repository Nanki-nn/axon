import * as fs from "fs";
import * as path from "path";

/** SKILL.md frontmatter 中必须有 name 和 description，其余字段自由扩展 */
interface SkillMeta {
  name: string;
  description: string;
  [key: string]: unknown;
}

interface Skill {
  meta: SkillMeta;
  body: string;   // frontmatter 之后的正文内容
  dir: string;    // 技能所在目录（用于查找 references/ 子目录）
}

/**
 * SkillLoader：从 .axon/skills/ 目录加载所有技能（兼容旧 .agents/skills）。
 *
 * 目录结构：
 *   .axon/skills/
 *     <skill-name>/
 *       SKILL.md          ← frontmatter (name, description) + 指令正文
 *       references/       ← 可选，存放参考文档或示例文件
 *
 * 加载时解析每个子目录下的 SKILL.md，以 name 字段为键存入 Map。
 */
export class SkillLoader {
  private skills: Map<string, Skill> = new Map();

  constructor(skillsDirs: string | string[]) {
    const dirs = Array.isArray(skillsDirs) ? skillsDirs : [skillsDirs];

    for (const skillsDir of dirs) {
      if (!fs.existsSync(skillsDir)) continue;

      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillDir = path.join(skillsDir, entry.name);
        const skillFile = path.join(skillDir, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;

        const text = fs.readFileSync(skillFile, "utf-8");
        const { meta, body } = parseFrontmatter(text);
        // frontmatter 中没有 name 时，用目录名作为 fallback
        const name = meta.name || entry.name;
        if (!this.skills.has(name)) {
          this.skills.set(name, { meta: { name, description: "", ...meta }, body, dir: skillDir });
        }
      }
    }
  }

  /** 已加载的技能数量 */
  get size(): number {
    return this.skills.size;
  }

  /** 返回所有技能名称列表 */
  names(): string[] {
    return Array.from(this.skills.keys());
  }

  /**
   * 返回精简的技能列表，每行一条（name + 截断后的 description）。
   * 用于 skill_list 工具，帮助 LLM 快速浏览可用技能。
   */
  listSkills(): string {
    if (this.skills.size === 0) return "No skills available.";
    const lines = Array.from(this.skills.values()).map((s) => {
      const desc = (s.meta.description ?? "").replace(/\n/g, " ").trim().slice(0, 120);
      return `- **${s.meta.name}**: ${desc}`;
    });
    return lines.join("\n");
  }

  /**
   * 返回指定技能的完整内容（包装在 <skill> 标签内）。
   * 同时列出 references/ 目录下的文件名，供 LLM 按需读取。
   * 用于 skill_read 工具，LLM 获取完整指令后再执行任务。
   */
  getContent(name: string): string {
    const skill = this.skills.get(name);
    if (!skill) {
      const available = this.names().join(", ") || "(none)";
      return `Error: Unknown skill '${name}'. Available: ${available}`;
    }

    let content = `<skill name="${name}">\n${skill.body}`;

    // 如果有 references/ 子目录，追加文件列表（LLM 可用 read_file 工具按需读取）
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

  /** 返回指定技能 references/ 目录下的文件名列表 */
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

/**
 * 解析 SKILL.md 的 YAML frontmatter（--- 包裹的头部块）。
 * 支持普通的 key: value 格式和多行 description 块。
 * 如果没有 frontmatter，整个文件内容作为 body 返回。
 */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: text.trim() };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    // 去除值两端的引号
    const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && val) meta[key] = val;
  }

  // 处理 YAML 多行 description 块（> 或 | 风格）
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
