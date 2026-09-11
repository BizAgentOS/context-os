import type { CanvasPage, SetupSection } from "./contracts.ts";

export const canvasPages: CanvasPage[] = ["setup", "ontology", "consumption"];

export function normalizeCanvasPage(value: unknown): CanvasPage {
  if (value === "company" || value === "sources") return "setup";
  if (canvasPages.includes(value as CanvasPage)) return value as CanvasPage;
  throw new Error("无效页面");
}

export function setupSection(value: unknown): SetupSection | undefined {
  return value === "company" || value === "sources" ? value : undefined;
}
