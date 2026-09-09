import { SkillRegistry, parseSkillMarkdown } from "@kodax-ai/kodax/skills";
import { mkdirSync, writeFileSync, realpathSync, readFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const bundled = fileURLToPath(new URL("../../config/skills/", import.meta.url));
export class AgentSkills {
  private registry: SkillRegistry;
  private ready?: Promise<void>;
  private directory: string;
  constructor(directory: string) {
    this.directory = join(directory, "capabilities", "skills");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.registry = new SkillRegistry(directory, {
      projectPaths: [this.directory, bundled],
      userPaths: [],
      pluginPaths: [],
      builtinPath: join(directory, "capabilities", "no-builtin-skills"),
    });
  }
  private initialize() {
    return (this.ready ??= this.registry.discover());
  }
  async list() {
    await this.initialize();
    return this.registry
      .list()
      .filter((s) => !s.disableModelInvocation)
      .map((s) => ({ name: s.name, description: s.description }));
  }
  async use(name: string, args: string) {
    await this.initialize();
    const skill = this.registry.get(name);
    if (!skill || skill.disableModelInvocation)
      throw new Error("未找到可调用的 Skill");
    const full = await this.registry.loadFull(name);
    this.validate(full.rawContent);
    const result = await this.registry.invoke(name, args, {
      workingDirectory: this.directory,
      disableDynamicContext: true,
    });
    if (!result.success) throw new Error("Skill 加载失败");
    return {
      name,
      content: result.content,
      instruction: "按此方法使用已授权工具；加载 Skill 不代表工作已经完成。",
    };
  }
  async read(name: string, path: string) {
    await this.initialize();
    const skill = this.registry.get(name);
    if (!skill || skill.disableModelInvocation)
      throw new Error("未找到可调用的 Skill");
    const root = realpathSync(skill.path);
    const file = realpathSync(resolve(root, path));
    const rel = relative(root, file);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("只能读取本 Skill 内的参考文件");
    const content = readFileSync(file);
    if (content.length > 100_000) throw new Error("参考文件过大");
    return { name, path: rel, content: content.toString("utf8") };
  }
  private validate(content: string) {
    if (content.length > 100_000) throw new Error("Skill 过大");
    if (/!`|^\s*hooks\s*:|^\s*context\s*:\s*fork/m.test(content))
      throw new Error("当前 Skill 加载不支持动态命令、hooks 或 fork");
  }
  async install(name: string, content: string) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(name))
      throw new Error("Skill 名称须为小写英文和短横线");
    this.validate(content);
    const normalized = content.replace(/\r\n/g, "\n");
    const parsed = parseSkillMarkdown(normalized);
    if (
      !/^---\n[\s\S]*?\n---(?:\n|$)/.test(normalized) ||
      parsed.frontmatter.name !== name ||
      !parsed.frontmatter.description ||
      !parsed.body.trim()
    )
      throw new Error("SKILL.md 需要完整的元数据、匹配的名称和方法正文");
    if (parsed.frontmatter.disableModelInvocation)
      throw new Error("此 Skill 禁止由模型调用");
    await this.initialize();
    if (this.registry.get(name))
      throw new Error("此 Skill 已存在，请使用不同名称");
    const folder = join(this.directory, name);
    mkdirSync(folder, { mode: 0o700 });
    writeFileSync(join(folder, "SKILL.md"), normalized, {
      mode: 0o600,
      flag: "wx",
    });
    await this.registry.reload();
    return this.list();
  }
}
