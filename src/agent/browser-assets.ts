import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const sceneEntry = fileURLToPath(new URL("../../web/agent/ontology-scene.js", import.meta.url));
const sceneModel = fileURLToPath(new URL("../../web/agent/ontology-space-model.js", import.meta.url));
let cached: { modified: string; contents: Promise<Uint8Array> } | undefined;

// Serve the pinned local renderer, without a runtime CDN or exposing node_modules.
export async function ontologySceneAsset(): Promise<Uint8Array> {
  const modified = (await Promise.all([sceneEntry, sceneModel].map(path => stat(path)))).map(info => info.mtimeMs).join(":");
  if (!cached || cached.modified !== modified) {
    const contents = build({
      entryPoints: [sceneEntry], bundle: true, write: false, format: "esm",
      platform: "browser", target: "es2022", minify: true,
    }).then(result => result.outputFiles[0]!.contents);
    const entry = { modified, contents };
    cached = entry;
    contents.catch(() => { if (cached === entry) cached = undefined; });
  }
  return cached.contents;
}
