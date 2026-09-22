import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { modelKeyEnvironment, type ModelSettings } from "./runtime.ts";

/** Private local credentials, kept outside model metadata and domain artifacts. */
export class ModelCredentials {
  private file: string;
  constructor(directory: string) {
    const parent = join(directory, "credentials");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
    this.file = join(parent, "models.json");
    if (existsSync(this.file)) chmodSync(this.file, 0o600);
  }
  private read(): Record<string, string | null> {
    if (!existsSync(this.file)) return {};
    const data = JSON.parse(readFileSync(this.file, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        Object.values(data).some(value => value !== null && typeof value !== "string"))
      throw new Error("模型凭据文件无效，请恢复本地凭据文件");
    return data;
  }
  saved(settings: ModelSettings) { return !!this.read()[modelKeyEnvironment(settings)]; }
  restore(settings: ModelSettings) {
    const entries = this.read(), key = modelKeyEnvironment(settings);
    if (Object.hasOwn(entries, key)) {
      if (entries[key]) process.env[key] = entries[key];
      else delete process.env[key];
    }
  }
  save(settings: ModelSettings, value: string | null) {
    const entries = this.read();
    entries[modelKeyEnvironment(settings)] = value;
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.file);
    this.restore(settings);
  }
}
