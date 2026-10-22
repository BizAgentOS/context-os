import { test } from "node:test";
import assert from "node:assert/strict";
import type { Artifact, Data } from "../../src/agent/contracts.ts";
import {
  createHeatingShareSnapshot,
  shareRouteKey,
} from "../../src/demo/share-snapshot.ts";

test("offline heating snapshot preserves relations, evidence and permitted scopes without credentials", async () => {
  const snapshot = await createHeatingShareSnapshot();
  assert.deepEqual(Object.keys(snapshot.pages), [
    "setup",
    "ontology",
    "consumption",
  ]);
  assert(snapshot.pages.setup.profile);
  const semantic=snapshot.routes['/api/ontology/workspace'] as Data;
  assert.equal((semantic?.entities as Data[]|undefined)?.length,6,'offline share carries the formal ontology read model');
  assert(snapshot.routes['/api/engine']);assert(snapshot.routes['/api/data']);assert(snapshot.routes['/api/sources/summary']);assert(snapshot.routes['/api/releases']);
  assert.equal(
    (snapshot.pages.setup.sources as unknown as Artifact[]).length,
    8,
  );
  const model = (
    snapshot.pages.ontology.ontologies as unknown as Artifact[]
  ).find((artifact) => artifact.status === "adopted")!;
  const params = new URLSearchParams({
    artifactId: model.id,
    version: String(model.version),
    type: "投诉",
    id: "TS002",
    relation: "居民回访",
    limit: "18",
    offset: "0",
  });
  const detail = snapshot.routes[
    shareRouteKey(`/api/objects?${params}`)
  ] as Data;
  const callbacks = (detail.related as Data).items as Data[];
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].id, "HF002");
  assert.equal((callbacks[0].fields as Data).反馈结果, "未改善");
  const evidence = (callbacks[0].evidence as Data[])[0];
  const source = snapshot.routes[
    shareRouteKey(
      `/api/artifacts/${evidence.sourceId}?version=${evidence.version}`,
    )
  ] as Data;
  assert.equal(source.title, "客服回访.csv");
  assert(JSON.stringify(source.content).includes("HF002"));
  assert(JSON.stringify(source.content).includes("过滤器清理后室内仍偏冷"));

  // Every saved evidence reference remains clickable without the running server.
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value)) {
      const record = value as Data;
      if (
        typeof record.sourceId === "string" &&
        typeof record.version === "number"
      )
        assert(
          snapshot.routes[
            shareRouteKey(
              `/api/artifacts/${encodeURIComponent(record.sourceId)}?version=${record.version}`,
            )
          ],
          `missing source ${record.sourceId} v${record.version}`,
        );
      for (const key of Object.keys(record))
        assert(
          !/^(?:apiKey|token|adminToken|authorization|password|secret|credentialVersion)$/i.test(
            key,
          ),
        );
    }
    for (const item of Object.values(value)) visit(item);
  };
  visit(snapshot);
  const exported = JSON.stringify(snapshot);
  assert(
    !/de_(?:admin|consumer)_[A-Za-z0-9_-]+|\/Users\/|\/private\/var\/|\/tmp\//.test(
      exported,
    ),
  );
  assert(snapshot.pages.consumption.consumers);
  const logs = snapshot.pages.consumption.accessLogs as Data[];
  assert.equal(logs.length, 0, "an offline demo does not invent external access grants or access history");
  assert.match(snapshot.answers.consumption.answer, /没有外部接入授权/);
  assert.match(snapshot.answers.ontology.answer, /2 条显示未改善/);
});
