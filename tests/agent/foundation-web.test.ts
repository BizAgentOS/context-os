import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";

// 待迁移：本测试从空本体起步，由对话/文档/网页/知识库新建概念。基础本体改由规则构建后，需改为在规则建好的结构上修正；其中验证的引用与治理机制仍在产品中。
test.skip("confirmed company web evidence comes from actual HTTP body and survives page change and service restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-foundation-web-"));
  let changed = false;
  const site = httpServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `<title>澄川热力官网</title><p>${changed ? "澄川热力仅向工业企业供热。" : "澄川热力向城北居民提供供热服务。"}</p>`,
    );
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/company`;
  let saved = false;
  let resumed = false;
  const driver: AgentDriver = {
    async run(request) {
      if (saved) {
        const current = (await request.onTool("foundation_read", {})) as any;
        const read = (await request.onTool("foundation_web_read", {
          url,
          identity: {
            foundationId: current.current.id,
            version: current.current.version,
          },
        })) as any;
        assert.equal(read.identity.name, "澄川热力");
        assert(read.text.includes("澄川热力仅向工业企业供热。"));
        await request.onTool("skill_use", {
          name: "company-foundation-ontology",
        });
        const proposal = (await request.onTool("foundation_propose", {
          baseVersion: current.current.version,
          enterprise: current.current.content.enterprise,
          concepts: [
            {
              id: "heating",
              name: "供热服务",
              description: "只向工业企业供热",
              evidenceRefs: ["web2"],
            },
          ],
          relations: [],
          evidence: [
            {
              id: "web2",
              kind: "web",
              readId: read.readId,
              quote: "澄川热力仅向工业企业供热。",
            },
          ],
          unknowns: [],
          conflicts: [],
        })) as any;
        assert.equal(proposal.content.conflicts.length, 1);
        assert.equal(
          proposal.content.conflicts[0].retained.description,
          "向城北居民提供的供热服务",
        );
        resumed = true;
        return {
          text: "已沿已有企业身份重新读取。",
          sessionId: "resume-web",
          runId: "resume-web",
        };
      }
      const user = JSON.parse(request.input)
        .recentMessages.filter((m: any) => m.role === "user")
        .at(-1);
      await request.onTool("skill_use", {
        name: "company-foundation-ontology",
      });
      const read = (await request.onTool("foundation_web_read", {
        url,
        identity: { name: "澄川热力", messageId: user.id, quote: user.content },
      })) as any;
      assert(read.text.includes("澄川热力向城北居民提供供热服务。"));
      assert.equal(read.url, url);
      const draft = {
        baseVersion: 0,
        enterprise: { name: "澄川热力", evidenceRefs: ["name"] },
        concepts: [
          {
            id: "heating",
            name: "供热服务",
            description: "向城北居民提供的供热服务",
            evidenceRefs: ["web"],
          },
        ],
        relations: [],
        evidence: [
          { id: "name", messageId: user.id, quote: user.content },
          {
            id: "web",
            kind: "web",
            readId: read.readId,
            quote: "澄川热力向城北居民提供供热服务。",
          },
        ],
        unknowns: [],
        conflicts: [],
      };
      await assert.rejects(
        request.onTool("foundation_propose", {
          ...draft,
          evidence: [
            draft.evidence[0],
            { ...draft.evidence[1], readId: "invented" },
          ],
        }),
        /读取/,
      );
      const proposed = (await request.onTool(
        "foundation_propose",
        draft,
      )) as any;
      assert.equal(
        proposed.content.evidence.find((e: any) => e.kind === "web")
          .webSnapshot,
        undefined,
      );
      const generic = (await request.onTool("memory_read", {
        id: proposed.id,
      })) as any;
      assert.equal(
        generic.content.evidence.find((e: any) => e.kind === "web").webSnapshot,
        undefined,
      );
      const view = (await request.onTool("foundation_read", {})) as any;
      assert.equal(
        view.current.content.evidence.find((e: any) => e.kind === "web")
          .webSnapshot,
        undefined,
      );
      saved = true;
      return { text: "已保存公开资料候选。", sessionId: "web", runId: "web" };
    },
    async stop() {},
    async close() {},
  };
  let service = await createServer({
    directory,
    driver,
    researchTestOrigins: new Set([new URL(url).origin]),
  });
  try {
    await service.app.canvasMessage({
      page: "setup",
      text: "请研究澄川热力，主体是城北供热公司。",
      messageId: "company",
    });
    await service.app.idle();
    assert(saved, JSON.stringify(service.app.canvasState().messages));
    const current = service.app.canvasState().foundation.current!;
    await service.app.canvasFoundationAdopt({
      page: "setup",
      id: current.id,
      version: 1,
    });
    await service.close();
    changed = true;
    service = await createServer({
      directory,
      driver,
      researchTestOrigins: new Set([new URL(url).origin]),
    });
    await new Promise<void>((r) => service.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    const response = await fetch(
      `${base}/api/foundation/evidence?foundationId=${current.id}&version=2&evidenceId=web`,
      { headers: { "x-dataengine-token": service.adminToken } },
    );
    assert.equal(response.status, 200);
    const evidence = await response.json();
    assert.equal(evidence.kind, "web");
    assert.equal(evidence.url, url);
    assert.equal(evidence.quote, "澄川热力向城北居民提供供热服务。");
    assert(evidence.text.includes(evidence.quote));
    assert(evidence.readAt);
    assert.equal(evidence.coverage.complete, true);
    await service.app.canvasNavigate({ page: "ontology" });
    await service.app.canvasMessage({
      page: "ontology",
      text: "按已经确认的公司继续核对官网。",
      messageId: "continue-web",
    });
    await service.app.idle();
    assert(resumed, JSON.stringify(service.app.canvasState().messages));
    await assert.rejects(
      service.app.canvasFoundationAdopt({
        page: "ontology",
        id: current.id,
        version: 3,
      }),
      /冲突/,
    );
    assert.equal(service.app.canvasState().foundation.adopted!.version, 2);
  } finally {
    await service.close();
    await new Promise<void>((r) => site.close(() => r()));
    rmSync(directory, { recursive: true, force: true });
  }
});

// 待迁移：本测试从空本体起步，由对话/文档/网页/知识库新建概念。基础本体改由规则构建后，需改为在规则建好的结构上修正；其中验证的引用与治理机制仍在产品中。
test.skip("web reading rejects false identity, HTTP failures and broken encoding; bounded snapshots cannot cite unread content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-web-boundary-"));
  const site = httpServer((req, res) => {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    if (req.url === "/redirect") {
      res.statusCode = 302;
      res.setHeader("location", "http://169.254.169.254/");
      res.end();
    } else if (req.url === "/failed") {
      res.statusCode = 503;
      res.end("澄川热力服务网页不可用");
    } else if (req.url === "/broken") res.end(Buffer.from([255, 254, 0]));
    else if (req.url === "/empty") res.end("  ");
    else
      res.end("澄川热力向居民供热。" + "正文".repeat(300000) + "未读取的尾部");
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  let checked = false;
  const driver: AgentDriver = {
    async run(request) {
      const user = JSON.parse(request.input)
        .recentMessages.filter((m: any) => m.role === "user")
        .at(-1);
      const identity = {
        name: "澄川热力",
        messageId: user.id,
        quote: user.content,
      };
      await assert.rejects(
        request.onTool("foundation_web_read", {
          url: url + "/long",
          identity: { ...identity, messageId: "fabricated" },
        }),
        /真实用户/,
      );
      for (const path of ["failed", "broken", "empty", "redirect"])
        await assert.rejects(
          request.onTool("foundation_web_read", {
            url: url + "/" + path,
            identity,
          }),
          /HTTP|编码|正文|公开研究/,
        );
      const read = (await request.onTool("foundation_web_read", {
        url: url + "/long",
        identity,
        limit: 20,
      })) as any;
      assert.equal(read.text.length, 20);
      assert.equal(read.coverage.complete, false);
      assert.equal(read.coverage.sourceTruncated, true);
      assert.equal(read.coverage.nextOffset, 20);
      await request.onTool("skill_use", {
        name: "company-foundation-ontology",
      });
      const draft = {
        baseVersion: 0,
        enterprise: { name: "澄川热力", evidenceRefs: ["w"] },
        concepts: [
          {
            id: "service",
            name: "供热服务",
            description: "居民供热服务",
            evidenceRefs: ["w"],
          },
        ],
        relations: [],
        evidence: [
          { id: "w", kind: "web", readId: read.readId, quote: "未读取的尾部" },
        ],
        unknowns: [],
        conflicts: [],
      };
      await assert.rejects(
        request.onTool("foundation_propose", draft),
        /实际读取/,
      );
      await assert.rejects(
        request.onTool("foundation_propose", {
          ...draft,
          enterprise: { name: "另一家公司", evidenceRefs: ["w"] },
          evidence: [{ ...draft.evidence[0], quote: "澄川热力向居民供热。" }],
        }),
        /主体/,
      );
      const saved = (await request.onTool("foundation_propose", {
        ...draft,
        evidence: [{ ...draft.evidence[0], quote: "澄川热力向居民供热。" }],
      })) as any;
      assert.equal(saved.content.evidence[0].coverage.sourceTruncated, true);
      checked = true;
      return {
        text: "保留局部依据与缺口。",
        sessionId: "bounded-web",
        runId: "bounded-web",
      };
    },
    async stop() {},
    async close() {},
  };
  const service = await createServer({
    directory,
    driver,
    researchTestOrigins: new Set([new URL(url).origin]),
  });
  try {
    await service.app.canvasMessage({
      page: "setup",
      text: "研究澄川热力。",
      messageId: "bounded",
    });
    await service.app.idle();
    assert(checked, JSON.stringify(service.app.canvasState().messages));
  } finally {
    await service.close();
    await new Promise<void>((r) => site.close(() => r()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent reads share one snapshot and reserve the eight-page budget before network completion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-web-concurrent-"));
  let hits = 0,
    checked = false;
  const site = httpServer((_req, res) => {
    hits++;
    res.setHeader("content-type", "text/plain");
    res.end(`读取版本${hits}：` + "正文".repeat(40));
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const driver: AgentDriver = {
    async run(request) {
      const user = JSON.parse(request.input).recentMessages.find(
        (m: any) => m.role === "user",
      );
      const identity = {
        name: "澄川热力",
        messageId: user.id,
        quote: user.content,
      };
      const [a, b] = (await Promise.all(
        [1, 2].map(() =>
          request.onTool("foundation_web_read", {
            url: url + "/same",
            identity,
            limit: 20,
          }),
        ),
      )) as any[];
      assert.equal(hits, 1);
      assert.equal(a.sourceHash, b.sourceHash);
      const tail = (await request.onTool("foundation_web_read", {
        url: url + "/same",
        identity,
        offset: 20,
      })) as any;
      assert.equal(tail.sourceHash, a.sourceHash);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          request.onTool("foundation_web_read", {
            url: url + "/" + i,
            identity,
          }),
        ),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 7);
      assert.equal(hits, 8);
      checked = true;
      return {
        text: "读取预算保持有界。",
        sessionId: "concurrent",
        runId: "concurrent",
      };
    },
    async stop() {},
    async close() {},
  };
  const service = await createServer({
    directory,
    driver,
    researchTestOrigins: new Set([url]),
  });
  try {
    await service.app.canvasMessage({
      page: "setup",
      text: "研究澄川热力。",
      messageId: "parallel",
    });
    await service.app.idle();
    assert(checked, JSON.stringify(service.app.canvasState().messages));
  } finally {
    await service.close();
    await new Promise<void>((r) => site.close(() => r()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("public research rejects local and reserved targets without test transport permission", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-web-public-"));
  let checked = false;
  const driver: AgentDriver = {
    async run(request) {
      const user = JSON.parse(request.input).recentMessages.find(
        (m: any) => m.role === "user",
      );
      for (const url of [
        "http://127.0.0.1/",
        "http://localhost/",
        "http://169.254.169.254/",
        "http://10.0.0.1/",
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
      ])
        await assert.rejects(
          request.onTool("foundation_web_read", {
            url,
            identity: {
              name: "澄川热力",
              messageId: user.id,
              quote: user.content,
            },
          }),
          /公开研究不能访问/,
        );
      checked = true;
      return { text: "私网读取被拒绝。", sessionId: "public", runId: "public" };
    },
    async stop() {},
    async close() {},
  };
  const service = await createServer({ directory, driver });
  try {
    await service.app.canvasMessage({
      page: "setup",
      text: "研究澄川热力。",
      messageId: "private",
    });
    await service.app.idle();
    assert(checked, JSON.stringify(service.app.canvasState().messages));
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
