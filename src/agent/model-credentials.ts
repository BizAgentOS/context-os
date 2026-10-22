import { CredentialVault } from "../security/credential-vault.ts";
import { modelKeyEnvironment, modelKeyEnvironments, type ModelSettings } from "./runtime.ts";

/** Private local credentials, kept outside model metadata and domain artifacts. */
export class ModelCredentials {
  private vault: CredentialVault;
  constructor(directory: string) {
    this.vault = new CredentialVault(directory);
    this.vault.migrateJson('models','credentials/models.json');
  }
  private read(): Record<string, string | null> {
    const data = this.vault.get('models');
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        Object.values(data).some(value => value !== null && typeof value !== "string"))
      throw new Error("模型凭据文件无效，请恢复本地凭据文件");
    return data as Record<string,string|null>;
  }
  private entry(settings: ModelSettings, entries = this.read()) {
    return modelKeyEnvironments(settings).find(key => Object.hasOwn(entries, key));
  }
  saved(settings: ModelSettings) { const entries=this.read(),key=this.entry(settings,entries);return !!(key&&entries[key]); }
  restore(settings: ModelSettings) {
    const entries = this.read(), key = modelKeyEnvironment(settings), saved = this.entry(settings, entries);
    if (saved !== undefined) {
      if (entries[saved]) process.env[key] = entries[saved];
      else for (const name of modelKeyEnvironments(settings)) delete process.env[name];
    } else if (process.env[key] === undefined) {
      const previous = modelKeyEnvironments(settings).map(name => process.env[name]).find(value => value !== undefined);
      if (previous !== undefined) process.env[key] = previous;
    }
  }
  save(settings: ModelSettings, value: string | null) {
    const entries = this.read();
    for (const key of modelKeyEnvironments(settings)) delete entries[key];
    entries[modelKeyEnvironment(settings)] = value;
    this.vault.set('models',entries);
    this.restore(settings);
  }
}
