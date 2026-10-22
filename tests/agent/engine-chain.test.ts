import {runNamingProtocol} from "./naming-protocol-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { AgentDriver } from "../../src/agent/runtime.ts";
import { createServer } from "../../src/agent/server.ts";

test("fixture CSV crosses public upload, program build, release, scoped external read, and revocation without structural model calls; one naming batch remains pending", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-engine-chain-fixture-"));
  let modelCalls = 0,namingCalls=0;
  const driver: AgentDriver = {
    async run(request) { if(request.tools.some(tool=>tool.name==="naming_context_read")){namingCalls++;return runNamingProtocol(request);}modelCalls++; throw new Error("Fixture program build must not call a model"); },
    async stop() {},
    async close() {},
  };
  const service = await createServer({ directory, driver });
  const ref = (artifact: { id: string; version: number }) => ({ id: artifact.id, version: artifact.version });
  try {
    await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    const manage = async (path: string, body?: unknown) => {
      const response = await fetch(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-contextos-token": service.adminToken, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json() as any;
      assert.equal(response.status, 200, `${path}: ${JSON.stringify(result)}`);
      return result;
    };

    await manage("/api/canvas/upload", {
      page: "setup", name: "fixture-companies.csv",
      content: "id,name,private\nCO1,青山,fixture-secret-one\nCO2,海川,fixture-secret-two\n",
    });
    await service.app.idle();
    const canvas = await manage("/api/canvas?page=ontology");
    assert.equal(canvas.automaticApiBuild.status, "completed");
    const foundation = canvas.foundation.adopted;
    const model = canvas.live.models.find((item: any) => item.status === "adopted");
    assert.ok(foundation, "the uploaded fixture must produce an adopted foundation");
    assert.ok(model, "the uploaded fixture must produce executable mappings");
    assert.equal(model.content.types.length, 1);
    const type = model.content.types[0];
    assert.ok(foundation.content.concepts.some((concept: any) => concept.id === type.conceptId));
    assert.equal(type.fields.name, "name");
    assert.equal(type.fields.private, "private", "an unshared field exists in the working mapping");
    assert.equal(modelCalls, 0);

    const overview = await manage("/api/releases");
    assert.equal(overview.releases.length, 0, "automatic construction does not publish data");
    assert.equal(namingCalls,1,"first program construction has one separate background naming run");
    assert.equal(overview.working.pending.length,1);
    assert.equal(overview.working.pending[0].kind,"ontology_change");
    assert.equal(service.app.memory.getArtifact(overview.working.pending[0].id).content.type,"naming");
    const checked = await manage("/api/releases/check", { inputHash: overview.working.inputHash });
    assert.equal(checked.status, "ready", JSON.stringify(checked.content.issues));
    const published = await manage("/api/releases/publish", {
      operationId: "fixture-publish", checkRef: ref(checked), name: "fixture-v1",
    });
    const connected = await manage("/api/releases/connect", {
      operationId: "fixture-connect", name: "Fixture external reader", releaseRef: ref(published.release),
      conceptIds: [type.conceptId], relationIds: [], agentEnabled: false,
      business: { grants: [{ type: type.name, fields: ["$id", "name"], relations: [], evidence: { fields: ["name"], relations: [] } }] },
    });
    assert.equal(connected.connection.status, "active");
    assert.match(connected.key, /^cos_dataset_/);

    // This independent caller has only the issued consumer credential, never the management token.
    const external = async (path: string) => {
      const response = await fetch(origin + path, { headers: { authorization: `Bearer ${connected.key}` } });
      return { status: response.status, body: await response.json() as any };
    };
    const objectsPath = "/v4/objects?" + new URLSearchParams({ type: type.name, fields: "$id,name", limit: "20" });
    const objects = await external(objectsPath);
    assert.equal(objects.status, 200, JSON.stringify(objects.body));
    assert.deepEqual(objects.body.items.map((item: any) => [item.objectRef.id, item.properties.name.value]), [["CO1", "青山"], ["CO2", "海川"]]);
    assert.ok(objects.body.items.every((item: any) => !Object.hasOwn(item.properties, "private")));
    const evidenceRef = objects.body.items[0].properties.name.evidenceRef;
    assert.equal(typeof evidenceRef, "string");
    const evidencePath = "/v4/evidence?" + new URLSearchParams({ ref: evidenceRef });
    const evidence = await external(evidencePath);
    assert.equal(evidence.status, 200, JSON.stringify(evidence.body));
    assert.equal(evidence.body.evidence.value, "青山");
    assert.ok(evidence.body.evidence.observations.length > 0, "external evidence must trace the actual fixture read");
    assert.doesNotMatch(JSON.stringify([objects.body, evidence.body]), /fixture-secret-/);

    await manage("/api/releases/revoke", { operationId: "fixture-revoke", connectionRef: ref(connected.connection) });
    assert.equal((await external(objectsPath)).status, 403);
    assert.equal((await external(evidencePath)).status, 403, "saved evidence must obey current connection revocation");
    assert.equal(modelCalls, 0);
    assert.equal(namingCalls,1,"external reads do not start another naming job");
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
