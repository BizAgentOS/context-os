import { z } from "zod";
import {randomUUID} from 'node:crypto';
import { CredentialVault } from "../security/credential-vault.ts";
import { fetchSource, sourceUrl, redactSource } from "./source-http.ts";

const credential = z.string().min(1).max(8000).refine(value => !/[\r\n]/.test(value), "认证值不能包含换行");
export const oauthSchema = z.object({ tokenUrl: z.string().url(), clientId: credential, clientSecret: credential.optional(),
  refreshToken: credential.optional(), scope: z.string().max(2000).optional(), clientAuthentication: z.enum(["basic", "body"]).default("basic") }).strict();
export type OAuth = z.infer<typeof oauthSchema>;
type Credentials = { generation?:string;clientSecret?: string; refreshToken?: string; accessToken?: string; expiresAt?: number };
/** Credentials are read from the vault on every use, including after asynchronous grants. */
export class SourceAuthorization {
  private vault: CredentialVault;
  private get credentials():Record<string,Credentials>{return this.vault.get('oauth') as Record<string,Credentials>;}
  private pending = new Map<string, Promise<string>>();
  private previews = new WeakMap<OAuth, Credentials>();
  constructor(directory: string) {
    this.vault=new CredentialVault(directory);this.vault.migrateJson('oauth','source-oauth.json');
  }
  register(id: string, config: OAuth) {this.pending.delete(id);this.vault.set('oauth',{...this.credentials,[id]:{generation:randomUUID(),clientSecret:config.clientSecret,refreshToken:config.refreshToken}});}
  forget(id: string) {this.pending.delete(id);const credentials=this.credentials;if(Object.hasOwn(credentials,id)){delete credentials[id];this.vault.set('oauth',credentials);}}
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
        if (id) { const credentials=this.credentials;if(JSON.stringify(credentials[id])!==JSON.stringify(current))throw new Error("authorization changed");this.vault.set('oauth',{...credentials,[id]:updated}); }
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
