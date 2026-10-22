import { CredentialVault } from "../security/credential-vault.ts";
import { modelKeyEnvironment, type ModelSettings } from "./runtime.ts";

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
    this.vault.set('models',entries);
    this.restore(settings);
  }
}
