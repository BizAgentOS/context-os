import { createServer } from "node:http";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AddressInfo } from "node:net";

export async function createMetricSource() {
  const state = {
    mode: "normal",
    revision: "r1",
    calls: 0,
    delay: undefined as Promise<void> | undefined,
  };
  const definition = () => ({
    id: "resolution_rate",
    name: "投诉办结率",
    description: "当月已办结投诉数除以当月受理投诉数；办结不表示供暖恢复。",
    revision: state.revision,
    unit: "%",
    grain: "month",
    timeZone: "Asia/Shanghai",
    dimensions: [
      {
        name: state.mode === "reserved-dimension" ? "__proto__" : "station",
        label: "供热站",
      },
    ],
    aggregation: { kind: "ratio", additiveDimensions: [], timeAdditive: false },
  });
  const execute = async (args: any) => {
    state.calls++;
    await state.delay;
    if (state.mode === "failure") throw new Error("source unavailable");
    const d = definition();
    if (args.operation === "describe") return { definition: d };
    const { operation, ...query } = args;
    const rows: Array<{
      dimensions: { station: string };
      periodStart: string;
      periodEnd: string;
      value: number | null;
      status: string;
      missingReason?: string;
    }> = [
      {
        dimensions: { station: "清河站" },
        periodStart: "2026-01-01",
        periodEnd: "2026-02-01",
        value: 80,
        status: "observed",
      },
      {
        dimensions: { station: "育新站" },
        periodStart: "2026-01-01",
        periodEnd: "2026-02-01",
        value: null,
        status: "missing",
        missingReason: "源系统尚未完成对账",
      },
    ];
    let items = rows
      .filter((r) =>
        Object.entries(args.where).every(
          ([k, v]) => r.dimensions[k as "station"] === v,
        ),
      )
      .slice(args.offset, args.offset + args.limit);
    if (state.mode === "short-unknown") items = items.slice(0, 1);
    if (state.mode === "wrong-unit") d.unit = "ratio";
    if (state.mode === "wrong-period")
      items = items.map((r) => ({ ...r, periodEnd: "2026-03-01" }));
    if (state.mode === "wrong-dimension")
      items = items.map((r) => ({ ...r, dimensions: { station: "外部站" } }));
    if (state.mode === "duplicate") items = [rows[0], rows[0]];
    if (state.mode === "false-additive") d.aggregation.timeAdditive = true;
    if (state.mode === "null-observed") items = [{ ...rows[0], value: null }];
    return {
      definition: d,
      query,
      items,
      coverage: {
        total: ["unknown-total", "short-unknown"].includes(state.mode)
          ? null
          : rows.filter((r) =>
              Object.entries(args.where).every(
                ([k, v]) => r.dimensions[k as "station"] === v,
              ),
            ).length,
        dataComplete: false,
      },
    };
  };
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: "independent-bi", version: "1" });
    mcp.registerTool(
      "metrics",
      {
        description: "只读查询投诉办结率定义与观测",
        inputSchema: z
          .object({
            operation: z.enum(["describe", "query"]),
            metricId: z.string(),
            start: z.string().optional(),
            end: z.string().optional(),
            where: z.record(z.string(), z.string()).optional(),
            offset: z.number().optional(),
            limit: z.number().optional(),
          })
          .strict(),
        annotations: { readOnlyHint: true },
      },
      async (args) => {
        try {
          const data = await execute(args);
          return {
            content: [{ type: "text", text: JSON.stringify(data) }],
            structuredContent: data,
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
    try {
      if (req.url?.startsWith("/metrics")) {
        const q = Object.fromEntries(
          new URL(req.url, "http://localhost").searchParams,
        );
        const args = {
          ...q,
          ...(q.operation === "query"
            ? {
                where: JSON.parse(q.where),
                offset: Number(q.offset),
                limit: Number(q.limit),
              }
            : {}),
        };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(await execute(args)));
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
    url,
    mcpUrl: url + "/mcp",
    state,
    async close() {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
export const metricCapability = {
  name: "metrics",
  path: "/metrics",
  contentKind: "metrics",
  metricId: "resolution_rate",
};
