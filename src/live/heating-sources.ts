import { createServer } from "node:http";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import type { SourceConnections } from "./sources.ts";

// Independent fictional upstream systems. No dependency on DataEngine's memory database.
export async function createHeatingSources(apiPort = 0, mcpPort = 0) {
  let outcome = "未改善";
  const complaints = [
    {
      id: "TS002",
      community: "锦绣园",
      status: "已办结",
      description: "暖气不热",
    },
  ];
  const callbacks = () => [{ id: "HF002", complaintId: "TS002", outcome }];
  const select = (
    rows: Record<string, string>[],
    query: Record<string, unknown>,
  ) => {
    const filtered = rows.filter((row) =>
      Object.entries(query)
        .filter(([k]) => !["limit", "offset"].includes(k))
        .every(([k, v]) => row[k] === v),
    );
    const offset = Number(query.offset ?? 0),
      limit = Number(query.limit ?? 20);
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
    };
  };
  const handler = createMcpHandler(() => {
    const server = new McpServer({
      name: "heating-callbacks",
      version: "1.0.0",
    });
    server.registerTool(
      "list_callbacks",
      {
        description: "只读客服回访",
        inputSchema: z
          .object({
            id: z.string().optional(),
            complaintId: z.string().optional(),
            limit: z.number().int().min(1).max(100),
            offset: z.number().int().min(0),
          })
          .strict(),
        annotations: { readOnlyHint: true },
      },
      async (args) => ({
        content: [
          { type: "text", text: JSON.stringify(select(callbacks(), args)) },
        ],
        structuredContent: select(callbacks(), args),
      }),
    );
    return server;
  }, {});
  const api = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && url.pathname === "/complaints")
      res.end(
        JSON.stringify(
          select(complaints, Object.fromEntries(url.searchParams)),
        ),
      );
    else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  const mcp = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 100000) throw new Error("large");
        chunks.push(c);
      }
      const body = Buffer.concat(chunks);
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        ...(body.length ? { body } : {}),
      });
      const response = await handler.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((r) => api.listen(apiPort, "127.0.0.1", r));
  await new Promise<void>((r) => mcp.listen(mcpPort, "127.0.0.1", r));
  const port = (s: typeof api) => (s.address() as { port: number }).port;
  return {
    apiUrl: `http://127.0.0.1:${port(api)}`,
    mcpUrl: `http://127.0.0.1:${port(mcp)}/mcp`,
    setOutcome: (value: string) => {
      outcome = value;
    },
    close: async () => {
      await handler.close();
      for (const server of [api, mcp]) {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
  };
}
export async function connectHeatingSources(
  sources: SourceConnections,
  upstream: { apiUrl: string; mcpUrl: string },
) {
  const api = await sources.connect({
    name: "澄川热力 · 投诉系统",
    protocol: "http",
    url: upstream.apiUrl,
    capabilities: [
      {
        name: "complaints",
        path: "/complaints",
        fields: ["id", "community", "status", "description"],
        idField: "id",
        filters: { id: "id" },
        totalPath: "total",
      },
    ],
  });
  const mcp = await sources.connect({
    name: "澄川热力 · 回访系统",
    protocol: "mcp",
    url: upstream.mcpUrl,
    capabilities: [
      {
        name: "list_callbacks",
        fields: ["id", "complaintId", "outcome"],
        idField: "id",
        filters: { id: "id", complaintId: "complaintId" },
        totalPath: "total",
      },
    ],
  });
  return { api, mcp };
}
export function heatingDefinition(apiId: string, mcpId: string) {
  return {
    purpose: "投诉办结后是否有客户改善反馈",
    rationale:
      "投诉办结只代表工单流程结束，客户实际反馈通过投诉编号关联回访。模拟业务口径，需企业确认。",
    types: [
      {
        name: "投诉",
        description: "客户投诉及处理状态",
        sourceId: apiId,
        capability: "complaints",
        fields: { 小区: "community", 状态: "status", 描述: "description" },
      },
      {
        name: "回访",
        description: "客户对处理后的反馈",
        sourceId: mcpId,
        capability: "list_callbacks",
        fields: { 投诉编号: "complaintId", 结果: "outcome" },
      },
    ],
    relations: [
      {
        name: "回访记录",
        from: "投诉",
        to: "回访",
        fromField: "$id",
        toField: "投诉编号",
      },
    ],
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const sources = await createHeatingSources(8801, 8802);
  console.log(
    `投诉 API: ${sources.apiUrl}\n回访 MCP: ${sources.mcpUrl}\n输入 improved 或 unchanged 修改模拟源系统的回访记录。`,
  );
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (text) => {
    if (String(text).trim() === "improved") sources.setOutcome("已改善");
    else if (String(text).trim() === "unchanged") sources.setOutcome("未改善");
    console.log("源系统回访结果已更新，下一次查询读取当前值。");
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(
      signal,
      () => void sources.close().then(() => process.exit(0)),
    );
}
