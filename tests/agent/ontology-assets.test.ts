import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";

test("ontology browser assets resolve locally at root and the legacy agent prefix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dataengine-space-assets-"));
  const service = await createServer({directory});
  try {
    await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    const html = await (await fetch(base)).text();
    assert.match(html, /href="\.\/ontology-space.css"/);
    const stylesheets = [...html.matchAll(/<link rel="stylesheet" href="\.\/([^"]+)"/g)].map(match => match[1]);
    for (const prefix of ["", "/agent"]) {
      for (const name of ["ontology-space.js", "ontology-space-model.js", "ontology-scene.js", ...stylesheets]) {
        const response = await fetch(`${base}${prefix}/${name}`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type")!, name.endsWith("css") ? /text\/css/ : /text\/javascript/);
        const text = await response.text();
        assert.ok(text.length > 0);
        if (name === "ontology-scene.js") {
          assert.doesNotMatch(text, /from\s*["']three/);
          assert.match(text, /WebGLRenderer/);
        }
      }
    }
  } finally {
    await service.close();
    await rm(directory, {recursive: true, force: true});
  }
});
