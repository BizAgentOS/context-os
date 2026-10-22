import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type {Data} from "../agent/contracts.ts";
import type { OntologyDatasets } from "./ontology-datasets.ts";

/** Run the same local MCP bridge an external Agent uses; credentials never enter results. */
export async function testDatasetMcp(service: OntologyDatasets, input: unknown, origin: string) {
  const args = z.object({ id: z.string().min(1).max(200), key: z.string().regex(/^(?:cos|de)_dataset_[A-Za-z0-9_-]{20,100}$/) }).strict().parse(input);
  const dataset = service.authenticate(args.key);
  if (!dataset || dataset.id !== args.id) throw new Error("密钥不属于此启用的数据集");
  const client = new Client({ name: "context-os-connection-check", version: "1" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      (async () => {
        await client.connect(new StdioClientTransport({
          command: process.execPath,
          args: [fileURLToPath(new URL("../../scripts/context-os-mcp.ts", import.meta.url))],
          env: { CONTEXT_OS_URL: origin, CONTEXT_OS_CONSUMER_KEY: args.key }, stderr: "pipe",
        }));
        const tools = await client.listTools();
        const reading = await client.callTool({ name: "describe_dataset", arguments: {} });
        if (reading.isError || !reading.structuredContent) throw new Error("MCP 目录读取失败");
        const concepts = (reading.structuredContent as { concepts: { id: string }[] }).concepts;
        if (concepts.length) {
          const detail = await client.callTool({ name: "read_concept", arguments: { conceptId: concepts[0].id } });
          if (detail.isError) throw new Error("MCP 概念读取失败");
        }
        const businessTypes=(reading.structuredContent as {businessTypes?:{name:string}[]}).businessTypes??[];
        let query:Data|null=null;
        if(businessTypes.length){
          const result=await client.callTool({name:"query_objects",arguments:{type:businessTypes[0].name,fields:["$id"],limit:1}});
          if(result.isError||!result.structuredContent)throw new Error("MCP 业务查询失败");
          const value=result.structuredContent as {items?:unknown[];coverage?:Data};
          if(!Array.isArray(value.items))throw new Error("MCP 业务查询缺少实际读取回执");
          query={tool:"query_objects",type:businessTypes[0].name,rows:value.items.length,coverage:value.coverage??null};
        }
        if (service.authenticate(args.key)?.id !== args.id) throw new Error("数据集已停用");
        return { ok: true, checkedAt: new Date().toISOString(), tools: tools.tools.map(t => t.name), conceptCount: concepts.length, checkedConcepts: Math.min(concepts.length, 1), query, scope: query?"本机 MCP 握手、工具发现与一次真实授权业务查询；不代表其他 Agent 已配置或全部来源可用":"本机 MCP 握手、工具发现、目录与一个概念读取；此接入只开放本体知识，未执行业务查询" };
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MCP 测试超时")), 12_000); }),
    ]);
    return result;
  } catch { throw new Error("MCP 测试未通过，请检查密钥、数据集状态与本机服务"); }
  finally { clearTimeout(timer); await client.close(); }
}
