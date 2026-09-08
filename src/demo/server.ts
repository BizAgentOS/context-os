import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createServer } from "../agent/server.ts";
import { seedHeatingDemo } from "./heating-seed.ts";
import { heatingDemoDriver } from "./driver.ts";

/** A separate local space: no external model calls and no writes to the user's workspace. */
export async function createHeatingDemo(directory = fileURLToPath(new URL("../../local-state/heating-demo", import.meta.url))) {
  const service = await createServer({
    directory,
    driver: heatingDemoDriver(),
    demo: { name: "澄川热力" },
  });
  try {
    await seedHeatingDemo(service.app);
    return service;
  } catch (error) {
    await service.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.DATAENGINE_DEMO_PORT ?? 8794);
  const service = await createHeatingDemo(process.env.DATAENGINE_DEMO_DIR);
  service.server.listen(port, "127.0.0.1", () => {
    console.log(`澄川热力演示：http://127.0.0.1:${port}/#access=${service.adminToken}`);
    console.log("虚构企业与数据，演示问答在本地执行，无需 API Key。重启保留演示中的修改。");
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => void service.close().then(() => process.exit(0)));
}
