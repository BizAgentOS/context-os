import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { exportHeatingHtml } from "../../scripts/export-heating-html.ts";

test("the final offline HTML contains an executable bundle, not replacement-expanded markup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "de-share-export-"));
  try {
    const result = await exportHeatingHtml(join(directory, "demo.html"));
    const html = await readFile(result.path, "utf8");
    assert.match(html, /<body\b[^>]*><noscript>/, "offline guidance survives body attributes");
    assert.doesNotMatch(html, /<link\s+rel="stylesheet"/, "all styles are inlined for offline use");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(
      () => new Script(scripts[0][1]),
      "the emitted browser script must parse",
    );
    const data = html.match(
      /<script type="application\/json" id="dataengine-share-data">([\s\S]*?)<\/script>/,
    );
    assert(data);
    assert.equal(JSON.parse(data[1]).formatVersion, 2);
    assert.match(html, /connect-src 'none'/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
