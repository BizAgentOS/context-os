export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Data = { [key: string]: Json };
export type CanvasPage = "company" | "sources" | "ontology";
export interface CanvasProgress {
  currentPage: CanvasPage;
  reached: CanvasPage[];
  completed: CanvasPage[];
  taskIds: Partial<Record<CanvasPage, string>>;
}
export interface Artifact {
  id: string;
  kind: string;
  title: string;
  version: number;
  status: string;
  content: Data;
  createdAt: string;
}
export interface ArtifactInput {
  id?: string;
  expectedVersion?: number;
  kind: string;
  title: string;
  status: string;
  content: Data;
}
export interface WriteContext {
  taskId: string;
  taskRevision: number;
  executionId: string;
}
export interface Investigation {
  modelId: string;
  modelVersion: number;
  sourceVersions: Record<string, number>;
}
export interface Repository {
  getInvestigation?(taskId: string): Investigation | null;
  bindInvestigation?(context: WriteContext, scope: Investigation): void;
  getMessage?(id: string): {
    id: string;
    taskId: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
  } | null;
  listArtifacts(kind?: string): Artifact[];
  getArtifact(id: string, version?: number): Artifact;
  putArtifact(
    input: ArtifactInput,
    context?: WriteContext,
    operationId?: string,
  ): Artifact;
}
export interface DomainTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mutates: boolean;
}
export interface Task {
  id: string;
  revision: number;
  goal: string;
  status: "running" | "waiting" | "paused" | "completed";
  nextStep: string;
  pending: Data | null;
  investigation?: Investigation | null;
  artifactRefs: { id: string; version: number }[];
  sessionId: string | null;
  executionId: string | null;
  createdAt: string;
  updatedAt: string;
}
