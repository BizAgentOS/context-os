import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createHeatingShareSnapshot } from "../src/demo/share-snapshot.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

/** A standalone, offline presentation of the fictional heating-company demo. */
export async function exportHeatingHtml(
  output = resolve(root, "output/share/DataEngine-热力公司-演示.html"),
) {
  const snapshot = await createHeatingShareSnapshot();
  const [template, styles, compiled] = await Promise.all([
    readFile(resolve(root, "web/agent/index.html"), "utf8"),
    Promise.all(
      ["app.css", "memory-graph.css", "ontology-space.css", "engine.css", "glass-theme.css", "glass-ontology.css", "share.css"].map((name) =>
        readFile(resolve(root, "web/agent", name), "utf8"),
      ),
    ),
    build({
      entryPoints: [resolve(root, "web/agent/app.js")],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "es2022",
      minify: true,
      sourcemap: false,
      legalComments: "inline",
      logLevel: "silent",
    }),
  ]);
  const data = JSON.stringify(snapshot).replace(/</g, "\\u003c");
  const script = compiled.outputFiles[0].text.replace(
    /<\/script/gi,
    "<\\/script",
  );
  const policy =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
  const html = template
    .replace(
      /<title>.*?<\/title>/s,
      "<title>DataEngine · 热力公司企业记忆演示</title>",
    )
    .replace(/<link\s+rel="stylesheet"[^>]*>/g, "")
    .replace(/<script\s+src="\.\/app\.js"\s+type="module"><\/script>/, "")
    .replace(
      /<body\b[^>]*>/,
      '$&<noscript><p style="padding:24px">请下载此 HTML 文件，并使用启用 JavaScript 的浏览器打开，以查看完整演示。</p></noscript>',
    )
    .replace(
      "</head>",
      () => `<meta http-equiv="Content-Security-Policy" content="${policy}" />\n<style>${styles.join("\n")}</style>\n</head>`,
    )
    .replace(
      "</body>",
      () => `<script type="application/json" id="dataengine-share-data">${data}</script>\n<script>${script}</script>\n</body>`,
    );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html, "utf8");
  return { path: output, bytes: Buffer.byteLength(html) };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const output = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const result = await exportHeatingHtml(output);
  console.log(`离线 HTML 已生成：${result.path}`);
  console.log(
    `${Math.round(result.bytes / 1024)} KB · 单文件 · 无需服务器或 API Key`,
  );
}
