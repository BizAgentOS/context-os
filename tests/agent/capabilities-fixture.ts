import { createServer } from "node:http";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

export async function capabilityFixture() {
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((r) => (release = r)),
    invoked = new Promise<void>((r) => (started = r));
  const handler = createMcpHandler(() => {
    const m = new McpServer({ name: "capability-fixture", version: "1.0.0" });
    for (let i = 0; i < 45; i++)
      m.registerTool(
        `read_${i}`,
        { inputSchema: z.object({}).strict() },
        async () => ({ content: [{ type: "text", text: `row ${i}` }] }),
      );
    m.registerTool(
      "delayed",
      { inputSchema: z.object({}).strict() },
      async () => {
        started();
        await held;
        return { content: [{ type: "text", text: "late private record" }] };
      },
    );
    m.registerResource(
      "handbook",
      "memory://handbook",
      { mimeType: "text/plain" },
      async (uri) => ({
        contents: [{ uri: uri.href, text: "供热企业业务说明" }],
      }),
    );
    m.registerPrompt(
      "research",
      { argsSchema: z.object({ topic: z.string() }) },
      (args) => ({
        messages: [
          {
            role: "user",
            content: { type: "text", text: `核查 ${args.topic}` },
          },
        ],
      }),
    );
    return m;
  }, {});
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
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
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
    release,
    invoked,
    async close() {
      release();
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
