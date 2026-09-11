import { createServer } from "node:http";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AddressInfo } from "node:net";

/** Independent fictional enterprise document service, exposed through real HTTP and MCP. */
export async function createKnowledgeSource() {
  const state = {
    revision: "r1",
    mode: "normal",
    schemaChanged: false,
    delay: undefined as Promise<void> | undefined,
    calls: 0,
  };
  const documents = [
    {
      id: "company-1",
      documentId: "company",
      title: "澄川热力企业介绍",
      text: "澄川热力为居民提供供热服务。供热站负责区域供热，客服部门受理居民投诉。",
    },
    {
      id: "guide-1",
      documentId: "guide",
      title: "投诉服务说明",
      text:
        "居民投诉由客服部门登记，并交由供热站处理。处理完成后安排回访。" +
        "服务说明。".repeat(1000),
    },
  ];
  const select = async (args: Record<string, unknown>) => {
    state.calls++;
    await state.delay;
    if (state.mode === "failure") throw new Error("upstream unavailable");
    const rows = documents
      .map((d) => ({ ...d, revision: state.revision }))
      .filter(
        (d) =>
          state.mode === "ignore-filter" ||
          Object.entries(args)
            .filter(([k]) => !["offset", "limit"].includes(k))
            .every(([k, v]) => d[k as keyof typeof d] === v),
      );
    const offset = Number(args.offset),
      limit = Number(args.limit);
    return {
      items: rows
        .slice(offset, offset + limit)
        .map((d) =>
          state.mode === "oversized" ? { ...d, text: "x".repeat(16001) } : d,
        ),
      ...(state.mode === "unknown-total"
        ? {}
        : { total: state.mode === "ambiguous" ? 2 : rows.length }),
    };
  };
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({
      name: "independent-knowledge",
      version: "1.0.0",
    });
    mcp.registerTool(
      "documents",
      {
        description: "查询企业资料片段，只读",
        inputSchema: z
          .object({
            id: z.string().optional(),
            documentId: z.string().optional(),
            offset: z.number().int().nonnegative(),
            limit: z.number().int().min(1).max(100),
            ...(state.schemaChanged ? { extra: z.string().optional() } : {}),
          })
          .strict(),
        annotations: { readOnlyHint: true },
      },
      async (args) => {
        try {
          const data = await select(args);
          return {
            content: [{ type: "text", text: JSON.stringify(data) }],
            structuredContent: data,
          };
        } catch {
          return {
            isError: true,
            content: [{ type: "text", text: "upstream unavailable" }],
          };
        }
      },
    );
    return mcp;
  }, {});
  const server = createServer(async (req, res) => {
    try {
      if (req.url?.startsWith("/documents")) {
        const url = new URL(req.url, "http://localhost");
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(await select(Object.fromEntries(url.searchParams))),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const response = await handler.fetch(
        new Request(`http://${req.headers.host}${req.url}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          ...(body.length ? { body } : {}),
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(503);
      res.end("{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    state,
    url,
    mcpUrl: url + "/mcp",
    async close() {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
export const knowledgeCapability = {
  name: "documents",
  path: "/documents",
  contentKind: "knowledge",
  fields: ["id", "documentId", "title", "revision", "text"],
  idField: "id",
  filters: { id: "id", documentId: "documentId" },
  itemsPath: "items",
  totalPath: "total",
};
