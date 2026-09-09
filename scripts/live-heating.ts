import { createServer } from "../src/agent/server.ts";
import {
  createHeatingSources,
  connectHeatingSources,
  heatingDefinition,
} from "../src/live/heating-sources.ts";
import { Workspace } from "../src/agent/workspace.ts";
import { resolve } from "node:path";
const upstream = await createHeatingSources(8801, 8802);
const service = await createServer({
  directory: resolve("local-state/live-heating"),
});
const live = service.app.live;
if (!live.sources.list().length) {
  const { api, mcp } = await connectHeatingSources(live.sources, upstream);
  const workspace = new Workspace(service.app.memory);
  workspace.editProfile("company.name", "澄川热力（虚构实验企业）");
  workspace.editProfile("company.business", "居民集中供热、投诉处理与客服回访");
  workspace.editProfile("company.goal", "检查已办结投诉是否有客户改善反馈");
  await live.propose(heatingDefinition(api.id, mcp.id));
}
service.server.listen(8796, "127.0.0.1", () =>
  console.log(
    `真实连接体验：http://127.0.0.1:8796/#access=${service.adminToken}\n数据来自两个独立模拟源系统；本体与访问范围保留上次保存的状态。\n终端输入 improved / unchanged 改变源系统回访结果，前端再次查询即可看到。`,
  ),
);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (text) => {
  const value = String(text).trim();
  if (!["improved", "unchanged"].includes(value)) return;
  upstream.setOutcome(value === "improved" ? "已改善" : "未改善");
  console.log("模拟源系统已更新。");
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(
    signal,
    () =>
      void service
        .close()
        .then(() => upstream.close())
        .then(() => process.exit(0)),
  );
