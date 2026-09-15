import { AgentSkills } from "./skills.ts";
import { AgentMcp } from "./mcp.ts";
import { BusinessSdkRegistry } from "./sdk.ts";
import { FeishuConnector } from "../connectors/feishu.ts";
import { z } from "zod";
import type { DomainTool, Json } from "../agent/contracts.ts";

export class AgentCapabilities {
  readonly skills: AgentSkills;
  readonly mcp: AgentMcp;
  readonly feishu: FeishuConnector;
  readonly sdk = new BusinessSdkRegistry();
  constructor(directory: string) {
    this.skills = new AgentSkills(directory);
    this.mcp = new AgentMcp(directory);
    this.feishu = new FeishuConnector(directory);
    this.sdk.register({
      id: "feishu.document.read",
      description: "通过已登录的飞书账号按指定 docx 文档链接只读获取内容与版本；需先在资料与数据连接飞书。不创建或修改远端文档。",
      schema: z.object({ url: z.string().url().max(2048) }).strict(),
      execute: async (args) => this.feishu.readDocument((args as { url: string }).url),
    });
  }
  async search(query = "") {
    const skills = (await this.skills.list()).map((s) => ({
      kind: "skill",
      ...s,
    }));
    const sdks = this.sdk.list().map((s) => ({ kind: "sdk", ...s }));
    return [...skills, ...sdks, ...this.mcp.search(query)].filter((s) =>
      JSON.stringify(s).toLowerCase().includes(query.toLowerCase()),
    );
  }
  useSkill(name: string, args: string) {
    return this.skills.use(name, args);
  }
  installSkill(name: string, content: string) {
    return this.skills.install(name, content);
  }
  async overview() {
    return {
      search: ["web_search", "web_fetch"],
      skills: await this.skills.list(),
      sdks: this.sdk.list(),
      servers: this.mcp.list(),
    };
  }
  async close() {
    await this.feishu.close();
    await this.mcp.close();
  }
}

export const nativeCapabilityTools = [
  "web_search",
  "web_fetch",
  "mcp_search",
  "mcp_describe",
  "mcp_call",
  "mcp_read_resource",
  "mcp_get_prompt",
];
const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): DomainTool => ({
  name,
  description,
  mutates: false,
  inputSchema: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
});
export const capabilityTools: DomainTool[] = [
  tool(
    "capability_search",
    "按需求发现可用 Skill、业务 SDK 与 MCP 能力。空查询查看目录；MCP 的 allowed 表示用户是否已授权。",
    { query: { type: "string" } },
    [],
  ),
  tool(
    "skill_use",
    "用 KodaX SDK 加载指定 Skill 的方法与参数，再按方法完成工作。不会自动执行其中的脚本。",
    { name: { type: "string" }, args: { type: "string" } },
    ["name"],
  ),
  tool(
    "skill_read",
    "读取已加载 Skill 包内的参考文本文件。",
    { name: { type: "string" }, path: { type: "string" } },
    ["name", "path"],
  ),
  tool(
    "sdk_call",
    "调用已注册业务 SDK 方法。先 capability_search 查看 id 和参数契约。",
    { id: { type: "string" }, args: { type: "object" } },
    ["id", "args"],
  ),
];
export async function executeCapability(
  hub: AgentCapabilities,
  name: string,
  args: Record<string, unknown>,
): Promise<Json> {
  let result: unknown;
  switch (name) {
    case "capability_search":
      result = await hub.search(String(args.query ?? ""));
      break;
    case "skill_use":
      result = await hub.useSkill(String(args.name), String(args.args ?? ""));
      break;
    case "skill_read":
      result = await hub.skills.read(String(args.name), String(args.path));
      break;
    case "sdk_call":
      try {
        result = await hub.sdk.call(String(args.id), args.args);
      } catch {
        throw new Error("SDK 调用失败，请核对方法名称、参数和外部服务状态");
      }
      break;
    default:
      throw new Error("未知能力");
  }
  return JSON.parse(JSON.stringify(result)) as Json;
}
