import { Octokit } from "@octokit/rest";
import { z } from "zod";
import type { WriteContext } from "../agent/contracts.ts";
export interface SdkMethod {
  id: string;
  description: string;
  schema: z.ZodType;
  execute: (args: unknown, context?: WriteContext) => Promise<unknown>;
}
export class BusinessSdkRegistry {
  private methods = new Map<string, SdkMethod>();
  constructor(octokit = new Octokit({ request: { timeout: 15_000 } })) {
    const schema = z
      .object({
        owner: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
        repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
      })
      .strict();
    this.register({
      id: "github.repository",
      description:
        "通过官方 Octokit SDK 读取一个 GitHub 公开仓库的基本资料。参数 owner 和 repo。",
      schema,
      execute: async (args) => {
        const { owner, repo } = schema.parse(args);
        const { data } = await octokit.repos.get({ owner, repo });
        return {
          name: data.full_name,
          description: data.description,
          url: data.html_url,
          language: data.language,
          stars: data.stargazers_count,
          updatedAt: data.updated_at,
          defaultBranch: data.default_branch,
        };
      },
    });
  }
  register(method: SdkMethod) {
    if (this.methods.has(method.id)) throw new Error("SDK 方法已注册");
    this.methods.set(method.id, method);
  }
  list() {
    return [...this.methods.values()].map((m) => ({
      id: m.id,
      description: m.description,
      inputSchema: z.toJSONSchema(m.schema),
    }));
  }
  async call(id: string, args: unknown, context?: WriteContext) {
    const method = this.methods.get(id);
    if (!method) throw new Error("未注册的 SDK 方法");
    return method.execute(method.schema.parse(args), context);
  }
}
