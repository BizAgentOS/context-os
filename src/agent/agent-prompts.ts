import { readFileSync } from "node:fs";
import type { AgentMode } from "./agent-modes.ts";
const read = (name: string) => readFileSync(new URL(`../../config/agent/${name}.md`, import.meta.url), "utf8");
const shared = `${read("identity")}\n${read("common")}`;
const modes = { build: read("build"), qa: read("qa") };
export const agentModePrompt = (mode: AgentMode) => `${shared}\n${modes[mode]}`;
