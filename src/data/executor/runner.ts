// Adapted from Helix Foundry services/executor/src/runner.ts (Apache-2.0, commit 00d7927).
import { execute } from "./engine.ts";

let body = "";
for await (const chunk of process.stdin) body += chunk;
try {
  const { job, root } = JSON.parse(body);
  process.stdout.write(JSON.stringify(await execute(job, root, process.env.EXECUTOR_SCRATCH)));
} catch (e) {
  process.stderr.write(e instanceof Error ? e.message : "Execution failed");
  process.exitCode = 1;
}
