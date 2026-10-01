import type { RemoteConfig } from "./config.js";
import { State } from "./state.js";
import { APP_SERVER_VERSION } from "./version.js";
import { RpcError, type JsonObject } from "./types.js";

export interface Credentials { accessToken: string; accountId: string }
export interface Enrollment {
  accountId: string; serverId: string; environmentId: string; serverName: string;
  appServerVersion?: string; os?: string; arch?: string;
}
/** Use Codex's platform names rather than Node's darwin/win32/arm64/x64 aliases. */
export function enrollmentPlatform(platform: string = process.platform, arch: string = process.arch) {
  return { os: platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform,
    arch: arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch === "ia32" ? "x86" : arch };
}
export class BackendError extends Error {
  readonly status: number;
  readonly retryAt: number;
  constructor(status: number, retryAt = 0) { super(`Remote service returned HTTP ${status}.`); this.status = status; this.retryAt = retryAt; }
}
export function retryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = /^\d+$/.test(value) ? Number(value) : NaN;
  const at = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value);
  return Number.isFinite(at) && at >= now ? at : 0;
}

export class ControlApi {
  private token?: { value: string; expires: number };
  private pending?: Promise<Enrollment>;
  private enrollmentError?: Error;
  retryAt = 0;
  readonly config: RemoteConfig;
  readonly state: State;
  private credentials: () => Promise<Credentials>;
  private fetcher: typeof fetch;
  constructor(config: RemoteConfig, state: State, credentials: () => Promise<Credentials>, fetcher: typeof fetch = fetch) {
    this.config = config; this.state = state; this.credentials = credentials; this.fetcher = fetcher;
  }
  get enrollment(): Enrollment | undefined { return this.state.get<Enrollment>("host", "enrollment"); }
  async identity(): Promise<Credentials> {
    const credentials = await this.credentials();
    const account = this.state.get<string>("host", "accountId");
    if (account && account !== credentials.accountId) {
      this.token = undefined;
      throw new RpcError(-32001, "Remote is bound to another ChatGPT account. Sign back into that account before starting Remote.");
    }
    if (!account) this.state.set("host", "accountId", credentials.accountId);
    return credentials;
  }
  private async request(path: string, method: string, authorization: string, body?: unknown, headers: Record<string, string> = {}): Promise<JsonObject> {
    if (this.retryAt > Date.now()) throw new BackendError(429, this.retryAt);
    const response = await this.fetcher(new URL(`wham/remote/control/${path}`, this.config.baseUrl), {
      method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${authorization}`, "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const deadline = retryAfter(response.headers.get("retry-after"));
      if ((response.status === 429 || response.status >= 500) && deadline) this.retryAt = Math.max(this.retryAt, deadline + Math.floor(Math.random() * 1000));
      await response.body?.cancel();
      throw new BackendError(response.status, this.retryAt);
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.length;
          if (size > 1024 * 1024) throw new Error("Remote response is too large.");
          chunks.push(result.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
  }
  async ensureEnrollment(): Promise<Enrollment> {
    if (!this.pending) {
      this.pending = this.loadEnrollment().finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }
  private async loadEnrollment(): Promise<Enrollment> {
    const credentials = await this.identity();
    if (this.enrollmentError) throw this.enrollmentError;
    let enrollment = this.enrollment;
    if (enrollment && enrollment.accountId !== credentials.accountId) throw new RpcError(-32001, "Remote is registered to another ChatGPT account.");
    const metadata = { name: this.config.hostName, ...enrollmentPlatform(), app_server_version: APP_SERVER_VERSION };
    const metadataMatches = enrollment?.serverName === metadata.name && enrollment.appServerVersion === metadata.app_server_version
      && enrollment.os === metadata.os && enrollment.arch === metadata.arch;
    if (enrollment && metadataMatches && this.token && this.token.expires > Date.now() + 5 * 60_000) return enrollment;
    const installation = this.state.installationId();
    const headers = { "chatgpt-account-id": credentials.accountId, "x-codex-installation-id": installation };
    let response: JsonObject | undefined;
    if (enrollment && metadataMatches) {
      try {
        response = await this.request("server/refresh", "POST", credentials.accessToken,
          { server_id: enrollment.serverId, installation_id: installation }, headers);
      } catch (error) {
        // A missing enrollment can be recreated. Other failures must not silently revoke devices.
        if (!(error instanceof BackendError) || error.status !== 404) throw error;
        enrollment = undefined;
      }
    }
    // Refresh renews credentials only. Re-publish changed (or legacy, unversioned) metadata
    // with the SAME installation ID. Never adopt a replacement identity during an upgrade.
    if (!response) response = await this.request("server/enroll", "POST", credentials.accessToken,
      { ...metadata, installation_id: installation }, headers);
    const expiry = Date.parse(response.expires_at);
    if (typeof response.server_id !== "string" || !response.server_id || typeof response.environment_id !== "string" || !response.environment_id ||
        typeof response.remote_control_token !== "string" || !response.remote_control_token || !Number.isFinite(expiry) || expiry <= Date.now()) {
      throw new Error("Remote service returned an invalid enrollment.");
    }
    if (enrollment && (response.server_id !== enrollment.serverId || response.environment_id !== enrollment.environmentId)) {
      this.token = undefined;
      // Stop automatic retries as well: a repeated enroll must not create more registrations.
      this.enrollmentError = new RpcError(-32600, "Remote service changed the host identity. Saved host details were left unchanged. Check the host registration before restarting Remote.");
      throw this.enrollmentError;
    }
    // Recheck identity after network waits; never publish credentials belonging to a former login.
    const latest = await this.identity();
    if (latest.accountId !== credentials.accountId) throw new Error("ChatGPT account changed.");
    enrollment = { accountId: credentials.accountId, serverId: response.server_id,
      environmentId: response.environment_id, serverName: metadata.name,
      appServerVersion: metadata.app_server_version, os: metadata.os, arch: metadata.arch };
    this.state.set("host", "enrollment", enrollment);
    this.token = { value: response.remote_control_token, expires: expiry };
    return enrollment;
  }
  invalidateToken(): void { this.token = undefined; }
  async connection(): Promise<{ url: string; headers: Record<string, string> }> {
    const enrollment = await this.ensureEnrollment();
    const url = new URL("wham/remote/control/server", this.config.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return { url: url.href, headers: { Authorization: `Bearer ${this.token!.value}`,
      "x-codex-server-id": enrollment.serverId,
      "x-codex-name": Buffer.from(enrollment.serverName).toString("base64"),
      "x-codex-protocol-version": "3", "x-codex-installation-id": this.state.installationId() } };
  }
  private async serverRequest(path: string, body: unknown): Promise<JsonObject> {
    const enrollment = await this.ensureEnrollment();
    let result: JsonObject;
    try { result = await this.request(path, "POST", this.token!.value, body); }
    catch (error) {
      if (!(error instanceof BackendError) || ![401, 403].includes(error.status)) throw error;
      this.invalidateToken();
      await this.ensureEnrollment();
      result = await this.request(path, "POST", this.token!.value, body);
    }
    if ((result.server_id !== undefined && result.server_id !== enrollment.serverId) ||
        (result.environment_id !== undefined && result.environment_id !== enrollment.environmentId)) {
      throw new Error("Pairing response does not match this host.");
    }
    return result;
  }
  async pair() {
    const result = await this.serverRequest("server/pair", { manual_code: true });
    if (typeof result.pairing_code !== "string" || !Number.isFinite(Date.parse(result.expires_at))) throw new Error("Invalid pairing response.");
    return { pairingCode: result.pairing_code as string, manualPairingCode: result.manual_pairing_code as string | null ?? null,
      environmentId: this.enrollment!.environmentId, expiresAt: result.expires_at as string };
  }
  async pairingStatus(params: JsonObject) {
    if (Boolean(params.pairingCode) === Boolean(params.manualPairingCode)) throw new RpcError(-32602, "Provide exactly one pairing code.");
    const result = await this.serverRequest("server/pair/status", params.pairingCode ? { pairing_code: params.pairingCode } : { manual_pairing_code: params.manualPairingCode });
    return { claimed: result.claimed === true };
  }
  async devices(params: JsonObject = {}) {
    const auth = await this.identity();
    const enrollment = this.enrollment;
    if (!enrollment) return { data: [], nextCursor: null };
    if (params.environmentId && params.environmentId !== enrollment.environmentId) throw new RpcError(-32602, "Unknown environment.");
    const query = new URLSearchParams({ limit: String(params.limit ?? 100), order: params.order ?? "desc" });
    if (params.cursor) query.set("cursor", params.cursor);
    const result = await this.request(`environments/${encodeURIComponent(enrollment.environmentId)}/clients?${query}`, "GET", auth.accessToken, undefined, { "chatgpt-account-id": auth.accountId });
    return { data: (result.items ?? []).map((item: JsonObject) => ({ clientId: item.client_id, displayName: item.display_name ?? null,
      deviceType: item.device_type ?? null, platform: item.platform ?? null, osVersion: item.os_version ?? null,
      deviceModel: item.device_model ?? null, appVersion: item.app_version ?? null,
      lastSeenAt: item.last_seen_at ? Math.floor(Date.parse(item.last_seen_at) / 1000) : null })), nextCursor: result.cursor ?? null };
  }
  async revoke(clientId: string) {
    const auth = await this.identity();
    if (!this.enrollment) throw new RpcError(-32600, "Pair this host first.");
    await this.request(`environments/${encodeURIComponent(this.enrollment.environmentId)}/clients/${encodeURIComponent(clientId)}`, "DELETE", auth.accessToken, undefined, { "chatgpt-account-id": auth.accountId });
  }
}
