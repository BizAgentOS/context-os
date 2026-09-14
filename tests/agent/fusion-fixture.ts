import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

/** Independent fictional service desk and work-order systems, never DataEngine memory. */
export async function createFusionSources() {
  const state = {
    mode: "normal",
    visits: 0,
    outcome: "未改善",
    calls: 0,
    delay: undefined as Promise<void> | undefined,
  };
  const primary = [
    { id: "TS002", ticket: "T-02", status: "已办结", phone: "private-138" },
    { id: "TS003", ticket: "T-03", status: "处理中", phone: "private-139" },
  ];
  const execute = async (args: any) => {
    state.calls++;
    await state.delay;
    if (state.mode === "failure") throw new Error("upstream down");
    let rows = [
      {
        id: "WO02",
        ticket: "T-02",
        status: state.mode === "conflict" ? "未办结" : "已办结",
        outcome: state.outcome,
        visits: state.visits,
        private: "private-detail",
      },
    ];
    if (state.mode === "duplicate") rows.push({ ...rows[0], id: "WO02-B" });
    const matches = rows.filter(
      (r) => args.ticket === undefined || r.ticket === args.ticket,
    );
    const total = matches.length;
    let items = matches.slice(args.offset, args.offset + args.limit);
    if (state.mode === "wrong-filter")
      items = rows.map((r) => ({ ...r, ticket: "OTHER" }));
    if (state.mode === "short") items = items.slice(0, 1);
    return {
      items,
      ...(state.mode === "unknown"
        ? {}
        : { total: state.mode === "short" ? 2 : total }),
    };
  };
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: "independent-workorders", version: "1" });
    mcp.registerTool(
      "workorders",
      {
        description: "按投诉业务编号查询当前工单属性",
        inputSchema: z
          .object({
            ticket: z.string().optional(),
            offset: z.number(),
            limit: z.number(),
          })
          .strict(),
        annotations: { readOnlyHint: true },
      },
      async (args) => {
        try {
          const result = await execute(args);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch {
          return {
            isError: true,
            content: [{ type: "text", text: "source unavailable" }],
          };
        }
      },
    );
    return mcp;
  }, {});
  const server = createServer(async (req, res) => {
    if (req.url!.startsWith("/primary")) {
      const q = new URL(req.url!, "http://localhost").searchParams;
      const selected = primary.filter(
        (r) =>
          (!q.has("id") || r.id === q.get("id")) &&
          (!q.has("ticket") || r.ticket === q.get("ticket")),
      );
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          items: selected.slice(
            Number(q.get("offset") ?? 0),
            Number(q.get("offset") ?? 0) + Number(q.get("limit") ?? 20),
          ),
          total: selected.length,
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const response = await handler.fetch(
      new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        ...(body.length ? { body } : {}),
        duplex: "half",
      } as RequestInit),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    state,
    primary,
    url,
    async close() {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
export const primaryCapability = {
  name: "complaints",
  path: "/primary",
  fields: ["id", "ticket", "status", "phone"],
  idField: "id",
  filters: { id: "id" },
  totalPath: "total",
};
export const supplementCapability = {
  name: "workorders",
  fields: ["id", "ticket", "status", "outcome", "visits", "private"],
  idField: "id",
  filters: { ticket: "ticket" },
  totalPath: "total",
};
export const fusionDefinition = (primaryId: string, extraId: string) => ({
  purpose: "投诉与工单的同实体融合",
  types: [
    {
      name: "投诉",
      description: "居民投诉",
      sourceId: primaryId,
      capability: "complaints",
      fields: { 业务编号: "ticket", 状态: "status" },
      supplements: [
        {
          name: "工单",
          sourceId: extraId,
          capability: "workorders",
          match: { primaryField: "业务编号", sourceField: "ticket" },
          fields: { 状态: "status", 实际反馈: "outcome", 上门次数: "visits" },
          rationale:
            "两个系统的ticket是同一投诉业务编号；状态具有相同口径，反馈不等同办结。",
        },
      ],
    },
  ],
  relations: [],
  rationale: "保留来源分歧；零与缺失不同。",
});
