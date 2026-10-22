// Compatibility entry point for previously exported consumer configurations.
export { readBridgeConfig, createMemoryMcpServer } from "./context-os-mcp.ts";
import { runContextOsMcp } from "./context-os-mcp.ts";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runContextOsMcp();
