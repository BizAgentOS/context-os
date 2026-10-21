import { z } from "zod";
import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fetchSource, sourceUrl, redactSource } from "./source-http.ts";

const credential = z.string().min(1).max(8000).refine(value => !/[\r\n]/.test(value), "认证值不能包含换行");
export const oauthSchema = z.object({ tokenUrl: z.string().url(), clientId: credential, clientSecret: credential.optional(),
  refreshToken: credential.optional(), scope: z.string().max(2000).optional(), clientAuthentication: z.enum(["basic", "body"]).default("basic") }).strict();
export type OAuth = z.infer<typeof oauthSchema>;
type Credentials = { clientSecret?: string; refreshToken?: string; accessToken?: string; expiresAt?: number };
/** This private file is never projected into memory, Agent tools or connection receipts. */
export class SourceAuthorization {
  private file: string;
  private credentials: Record<string, Credentials> = {};
  private pending = new Map<string, Promise<string>>();
  private previews = new WeakMap<OAuth, Credentials>();
  constructor(directory: string) {
    this.file = join(directory, "source-oauth.json");
    try { this.credentials = JSON.parse(readFileSync(this.file, "utf8")); chmodSync(this.file, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private persist() { const temporary = this.file + "." + randomUUID(); writeFileSync(temporary, JSON.stringify(this.credentials), { mode: 0o600 }); renameSync(temporary, this.file); }
  register(id: string, config: OAuth) { this.credentials[id] = { clientSecret: config.clientSecret, refreshToken: config.refreshToken }; this.persist(); }
  forget(id: string) { delete this.credentials[id]; this.persist(); }
  static public(config: OAuth) { const { clientSecret: _secret, refreshToken: _refresh, ...safe } = config; return safe; }
  async token(config: OAuth, allowInsecureHttp = false, id?: string, refresh = false): Promise<string> {
    const current = id ? this.credentials[id] : this.previews.get(config) ?? { clientSecret: config.clientSecret, refreshToken: config.refreshToken };
    if (!current) throw new Error("OAuth 凭据不可用，请重新连接");
    if (!refresh && current.accessToken && (current.expiresAt ?? 0) > Date.now() + 1000) return current.accessToken;
    if (id && this.pending.has(id)) return this.pending.get(id)!;
    const get = async () => {
      try {
        const url = sourceUrl(config.tokenUrl, allowInsecureHttp);
        const body = new URLSearchParams({ grant_type: current.refreshToken ? "refresh_token" : "client_credentials" });
        if (current.refreshToken) body.set("refresh_token", current.refreshToken);
        if (config.scope) body.set("scope", config.scope);
        const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", Accept: "application/json" };
        if (config.clientAuthentication === "body") { body.set("client_id", config.clientId); if (current.clientSecret) body.set("client_secret", current.clientSecret); }
        else headers.Authorization = "Basic " + Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(current.clientSecret ?? "")}`).toString("base64");
        const response = await fetchSource(url, { method: "POST", headers, body });
        if (!response.ok) throw new Error("grant failed");
        const result = z.object({ access_token: credential, token_type: z.string().refine(value => value.toLowerCase() === "bearer"), expires_in: z.coerce.number().positive().max(31536000).default(300), refresh_token: credential.optional() }).passthrough().parse(await response.json());
        const updated = { ...current, accessToken: result.access_token, expiresAt: Date.now() + result.expires_in * 1000, ...(result.refresh_token ? { refreshToken: result.refresh_token } : {}) };
        // A revocation while the token endpoint was running must not recreate credentials.
        if (id) { if (this.credentials[id] !== current) throw new Error("authorization changed"); this.credentials[id] = updated; this.persist(); }
        else this.previews.set(config, updated);
        return updated.accessToken;
      } catch { throw new Error("OAuth 认证失败，请检查客户端凭据、令牌端点与授权范围"); }
    };
    const result = get(); if (id) this.pending.set(id, result);
    try { return await result; } finally { if (id && this.pending.get(id) === result) this.pending.delete(id); }
  }
  redact(value: unknown, config?: OAuth, id?: string) {
    for (const secret of [config?.clientSecret, config?.refreshToken, ...Object.values(id ? this.credentials[id] ?? {} : config ? this.previews.get(config) ?? {} : {})]) if (typeof secret === "string") value = redactSource(value, secret);
    return value;
  }
}
