import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { RemoteConfig } from "./config.js";
import type { ControlApi } from "./control-api.js";
import { HostFiles } from "./filesystem.js";
import { FileSearch } from "./search.js";
import { skillMetadata, type RemoteSkill } from "./skills.js";
import { RemoteDiagnostics } from "./diagnostics.js";
import { Sessions, validateExecutionOptions } from "./sessions.js";
import { State } from "./state.js";
import { APP_SERVER_USER_AGENT } from "./version.js";
import { declinedEnablement, DESKTOP_FEATURES, desktopOptions, disabledFeatures } from "./compatibility.js";
import { object, page, responseError, RpcError, text, now, type JsonObject, type RpcMessage } from "./types.js";

export interface Client {
  id: string; deviceId: string; initialized: boolean; ready: boolean; experimental: boolean;
  subscriptions: Set<string>; optOut: Set<string>; warnings: Set<string>; send: (message: RpcMessage) => void;
  requests: Map<string, { signature: string; promise: Promise<RpcMessage>; size: number }>;
  search: FileSearch;
  activeThread?: string;
}
interface ServerOptions {
  config: RemoteConfig; state: State; files: HostFiles; sessions: Sessions;
  models: () => Promise<JsonObject[]>;
  skills?: (cwd: string) => Promise<RemoteSkill[]>;
  remoteStatus?: () => JsonObject;
  control?: ControlApi;
  revoke?: (clientId: string) => void;
  diagnostics?: RemoteDiagnostics;
}

/** The public surface is an explicit allowlist. Internal IPC is never routed here. */
export class AppServer {
  readonly clients = new Map<string, Client>();
  readonly options: ServerOptions;
  readonly diagnostics: RemoteDiagnostics;
  constructor(options: ServerOptions) {
    this.options = options;
    this.diagnostics = options.diagnostics ?? new RemoteDiagnostics(options.config);
    options.sessions.onNotify = (threadId, method, params) => this.notify(threadId, method, params);
  }
  connect(id: string, deviceId: string, send: Client["send"]): Client {
    let client = this.clients.get(id);
    if (client) { client.send = send; return client; }
    if (this.clients.size >= 128) throw new Error("Too many clients.");
    client = { id, deviceId, send, initialized: false, ready: false, experimental: false, subscriptions: new Set(), optOut: new Set(), warnings: new Set(), requests: new Map(),
      search: new FileSearch(this.options.files, (method, params) => {
        if (this.clients.get(id) === client && client!.ready && !client!.optOut.has(method)) {
          try { client!.send({ method, params }); } catch { this.disconnect(id); }
        }
      }) };
    this.clients.set(id, client); return client;
  }
  disconnect(id: string): void { this.clients.get(id)?.search.close(); this.clients.delete(id); }
  notify(threadId: string | undefined, method: string, params: JsonObject): void {
    for (const client of [...this.clients.values()]) {
      if (!client.ready || client.optOut.has(method) || threadId && !client.subscriptions.has(threadId)) continue;
      try { client.send({ method, params }); } catch { this.disconnect(client.id); }
    }
  }
  async receive(client: Client, message: RpcMessage): Promise<void> {
    const started = Date.now();
    this.diagnostics.request(message, client.id);
    const send = (response: RpcMessage, replayed = false) => {
      this.diagnostics.response(message, client.id, response, started, replayed);
      try { client.send(response); }
      catch (error) { this.diagnostics.failure("response/send_error", error, message, client.id); throw error; }
    };
    if (typeof message.method !== "string" || message.method.length > 256) {
      if (message.id != null) send(responseError(message.id, new RpcError(-32600, "Invalid request.")));
      return;
    }
    // Older clients may send initialized; desktop proceeds after the initialize response.
    // Client notifications do not grant readiness or access to requests.
    if (message.id === undefined) return;
    if (typeof message.id !== "string" && typeof message.id !== "number" || typeof message.id === "number" && !Number.isSafeInteger(message.id)) return;
    const key = `${typeof message.id}:${String(message.id)}`;
    const signature = createHash("sha256").update(JSON.stringify([message.method, message.params])).digest("hex");
    let request = client.requests.get(key);
    if (request && request.signature !== signature) { send(responseError(message.id, new RpcError(-32600, "Request identifier was reused with different parameters."))); return; }
    const replayed = !!request;
    if (!request) {
      const id = message.id;
      const promise = Promise.resolve().then(async (): Promise<RpcMessage> => {
        try { return { id, result: await this.dispatch(client, message.method!, object(message.params ?? {}), key) }; }
        catch (error) { this.diagnostics.failure("request/error", error, message, client.id); return responseError(id, error); }
      });
      request = { signature, promise, size: 0 };
      client.requests.set(key, request);
      void promise.then(value => { request!.size = Buffer.byteLength(JSON.stringify(value)); });
    }
    const response = await request.promise;
    send(response, replayed);
    // Enable notifications only after the successful initialize response has been sent.
    if (message.method === "initialize" && !response.error) client.ready = true;
    // Bound replay caches by bytes as well as request count. Turn idempotency lives in durable storage.
    let size = [...client.requests.values()].reduce((total, item) => total + item.size, 0);
    for (const [oldKey, old] of client.requests) {
      if (client.requests.size <= 128 && size <= 8 * 1024 * 1024) break;
      if (oldKey === key || !old.size) continue;
      client.requests.delete(oldKey); size -= old.size;
    }
  }
  private async dispatch(client: Client, method: string, params: JsonObject, requestId: string): Promise<unknown> {
    const { config, files, sessions, state, control } = this.options;
    if (method === "initialize") {
      if (client.initialized) throw new RpcError(-32600, "Already initialized.");
      const info = object(params.clientInfo);
      text(info.name, "client name", 256); text(info.version, "client version", 128);
      const capabilities = object(params.capabilities ?? {});
      const optOut = capabilities.optOutNotificationMethods ?? [];
      if (!Array.isArray(optOut) || optOut.length > 256 || optOut.some(value => typeof value !== "string")) throw new RpcError(-32602, "Invalid notification preferences.");
      client.optOut = new Set(optOut); client.experimental = capabilities.experimentalApi === true; client.initialized = true;
      return { userAgent: APP_SERVER_USER_AGENT, codexHome: config.home,
        platformFamily: process.platform === "win32" ? "windows" : "unix", platformOs: process.platform === "darwin" ? "macos" : process.platform };
    }
    if (!client.initialized) throw new RpcError(-32600, "Send initialize before making requests.");
    if (["thread/start", "thread/resume", "thread/settings/update", "turn/start", "turn/steer"].includes(method)) {
      const normalized = desktopOptions(params);
      params = normalized.params;
      validateExecutionOptions(params);
      if (normalized.notice) this.desktopNotice(client);
    }
    switch (method) {
      case "getAuthStatus": {
        for (const key of ["includeToken", "refreshToken"]) {
          if (params[key] != null && typeof params[key] !== "boolean") throw new RpcError(-32602, `${key} must be a boolean.`);
        }
        // Desktop uses this legacy RPC to confirm the connection. Pi owns credential
        // refresh; remote clients may inspect login state but never export its tokens.
        const auth = control ? await control.identity() : undefined;
        return { authMethod: auth ? "chatgpt" : null, authToken: null, requiresOpenaiAuth: true };
      }
      case "model/list": return page(await this.models(client.activeThread), params);
      case "skills/list": {
        if (params.forceReload != null && typeof params.forceReload !== "boolean") throw new RpcError(-32602, "forceReload must be a boolean.");
        const cwds = params.cwds ?? [];
        if (!Array.isArray(cwds) || cwds.length > 16) throw new RpcError(-32602, "Select up to 16 skill directories.");
        // Active sessions are authoritative (including temporary and extension-provided skills).
        // Unopened projects are discovered without starting a Pi worker or granting project trust.
        const roots = [...new Set(await Promise.all((cwds.length ? cwds : [config.userHome])
          .map(cwd => files.directory(cwd === "~" ? config.userHome : cwd))))];
        return { data: await Promise.all(roots.map(async cwd => ({ cwd, errors: [],
          skills: skillMetadata(await sessions.skills(cwd, client.activeThread) ?? await this.options.skills?.(cwd) ?? []) }))) };
      }
      case "fuzzyFileSearch": return client.search.search(params);
      case "fuzzyFileSearch/sessionStart": return client.search.start(params);
      case "fuzzyFileSearch/sessionUpdate": return client.search.update(params);
      case "fuzzyFileSearch/sessionStop": return client.search.stop(params);
      case "account/read": return { account: control?.enrollment ? { type: "chatgpt", email: null, planType: "unknown" } : null,
        requiresOpenaiAuth: true, workspaceRouting: null };
      case "config/read": {
        const models = await this.models(client.activeThread);
        const cwd = params.cwd == null ? undefined : await files.directory(params.cwd === "~" ? config.userHome : params.cwd);
        const selected = client.activeThread ? sessions.read(client.activeThread, false) : undefined;
        const current = selected && (!cwd || selected.cwd === cwd) ? selected : sessions.list({ ...(cwd ? { cwd } : {}), sortKey: "updated_at" })[0];
        const preferred = models.find(model => model.isDefault) ?? models[0];
        return { config: { model: current?.model ?? preferred?.id ?? null, model_provider: current?.modelProvider ?? "pi", approval_policy: "never",
          sandbox_mode: "danger-full-access", cwd: cwd ?? config.userHome, user_home: config.userHome,
          model_reasoning_effort: current?.reasoningEffort ?? preferred?.defaultReasoningEffort ?? "none", service_tier: null, features: disabledFeatures() },
          origins: {}, ...(params.includeLayers ? { layers: [] } : {}) };
      }
      case "configRequirements/read": return { requirements: {
        allowedApprovalPolicies: ["never"], allowedSandboxModes: ["danger-full-access"], featureRequirements: disabledFeatures(),
      } };
      case "experimentalFeature/list": return page(DESKTOP_FEATURES.map(name => ({ name, enabled: false, defaultEnabled: false,
        stage: "removed", displayName: null, description: null, announcement: null })), params);
      case "experimentalFeature/enablement/set": {
        const enablement = declinedEnablement(params.enablement);
        if (Object.values(params.enablement).some(Boolean)) this.desktopNotice(client);
        return { enablement };
      }
      case "permissionProfile/list": return { data: [], nextCursor: null };
      case "collaborationMode/list": return { data: [{ name: "Default", mode: "default", model: null, reasoning_effort: null }] };
      case "hooks/list": {
        const cwds = params.cwds ?? [];
        if (!Array.isArray(cwds) || cwds.length > 100) throw new RpcError(-32602, "Choose up to 100 directories.");
        const roots = cwds.length ? [...new Set(cwds)] : [config.userHome];
        await Promise.all(roots.map(cwd => files.directory(cwd)));
        return { data: roots.map(cwd => ({ cwd, hooks: [], errors: [], warnings: ["Pi extensions are managed in Pi, not as Codex hooks."] })) };
      }
      case "fs/readDirectory": return files.list(params.path);
      case "fs/getMetadata": return files.metadata(params.path);
      case "fs/createDirectory": {
        if (params.recursive != null && typeof params.recursive !== "boolean") throw new RpcError(-32602, "Invalid recursive option.");
        await files.create(params.path, params.recursive ?? true); return {};
      }
      case "fs/readFile": return { dataBase64: (await files.read(params.path)).toString("base64") };
      case "command/exec": {
        // Directory discovery only. Do not silently execute arbitrary desktop shell scripts.
        validateExecutionOptions(params);
        if (params.tty || params.streamStdin || params.streamStdoutStderr || params.env || params.permissionProfile) throw new RpcError(-32602, "Use the filesystem APIs for directory discovery.");
        const argv = params.command;
        const cwd = await files.directory(params.cwd ?? config.userHome);
        if (Array.isArray(argv) && argv.length === 1 && ["pwd", "/bin/pwd"].includes(argv[0])) return { exitCode: 0, stdout: cwd + "\n", stderr: "" };
        if (Array.isArray(argv) && argv.length === 3 && ["sh", "bash", "zsh", "/bin/sh", "/bin/bash", "/bin/zsh"].includes(argv[0]) &&
            ["-c", "-lc"].includes(argv[1]) && ["pwd", "echo $HOME", "echo \"$HOME\"", "printf '%s\\n' \"$HOME\""].includes(argv[2])) {
          return { exitCode: 0, stdout: (argv[2] === "pwd" ? cwd : config.userHome) + "\n", stderr: "" };
        }
        throw new RpcError(-32602, "Standalone shell execution is not exposed. Use a Pi conversation or the filesystem APIs.");
      }
      case "environment/info": {
        if (params.environmentId && params.environmentId !== control?.enrollment?.environmentId) throw new RpcError(-32602, "Unknown environment.");
        return { cwd: pathToFileURL(config.userHome).href, shell: process.env.SHELL ?? "/bin/sh" };
      }
      case "project/list": {
        const projects = state.list("projects").sort((a, b) => (params.sortKey === "recencyAt" ? (a.recencyAt ?? 0) - (b.recencyAt ?? 0) : a.position - b.position) *
          ((params.sortDirection ?? (params.sortKey === "recencyAt" ? "desc" : "asc")) === "desc" ? -1 : 1));
        return page(projects, params);
      }
      case "project/read": return { project: this.project(params.projectId) };
      case "project/create":
      case "project/import": return this.createProject(params);
      case "project/update": {
        const existing = this.project(params.projectId);
        const updates: JsonObject = {};
        if (params.name != null) updates.name = text(params.name, "project name", 256);
        if (params.roots != null) updates.roots = await this.projectRoots(params.roots);
        if (params.metadata != null) updates.metadata = this.metadata(params.metadata);
        const project: JsonObject = { ...existing, ...updates, updatedAt: now() };
        state.set("projects", project.id, project); this.notify(undefined, "project/changed", { projectId: project.id, changeType: "updated" });
        return { project };
      }
      case "project/delete": {
        const project = this.project(params.projectId); state.delete("projects", project.id);
        for (const record of state.list("threads")) if (record.thread.projectId === project.id) sessions.assignProject(record.thread.id, null);
        this.notify(undefined, "project/changed", { projectId: project.id, changeType: "deleted" }); return {};
      }
      case "project/move": {
        const moving = this.project(params.projectId);
        const all = state.list("projects").sort((a, b) => a.position - b.position).filter(project => project.id !== moving.id);
        const index = params.beforeProjectId ? all.findIndex(project => project.id === params.beforeProjectId) : all.length;
        if (index < 0) throw new RpcError(-32602, "Project not found.");
        all.splice(index, 0, moving);
        state.transaction(() => all.forEach((project, position) => state.set("projects", project.id, { ...project, position })));
        this.notify(undefined, "project/changed", { projectId: moving.id, changeType: "updated" }); return {};
      }
      case "thread/list": return page(sessions.list(params), params);
      case "thread/loaded/list": return page(sessions.loaded(), params);
      case "thread/start": {
        if (params.ephemeral) throw new RpcError(-32602, "Remote conversations must be persistent.");
        const project = params.projectId ? this.project(params.projectId) : undefined;
        const cwd = await files.directory(params.cwd ?? project?.roots[0]?.path ?? config.userHome);
        const response = await sessions.start({ ...params, cwd });
        client.subscriptions.add(response.thread.id); client.activeThread = response.thread.id;
        // The creator must receive the start event even before it has a subscription.
        return response;
      }
      case "thread/resume": {
        validateExecutionOptions(params);
        if (params.history != null) throw new RpcError(-32602, "Resume a registered conversation by threadId.");
        const id = text(params.threadId, "threadId");
        const thread = sessions.read(id, false);
        // Desktop echoes the path we supplied. Never open an arbitrary path from a remote request.
        if (params.path != null && params.path !== thread.path) throw new RpcError(-32602, "Use the registered conversation path.");
        if (params.cwd && params.cwd !== thread.cwd || params.model && params.model !== thread.model) throw new RpcError(-32602, "Resume the existing conversation without changing its directory or model.");
        client.subscriptions.add(id);
        try {
          const response = await sessions.resume(id);
          client.activeThread = id;
          if (!response.thread.canAcceptDirectInput) this.warning(client, "terminal-offline", "Reconnect this conversation in Pi to send messages.",
            "The saved history is available. Open this conversation in Pi and run /remote start; no second Pi process was started.");
          return response;
        }
        catch (error) { client.subscriptions.delete(id); throw error; }
      }
      case "thread/settings/update": {
        const id = text(params.threadId, "threadId"); sessions.record(id); client.subscriptions.add(id); client.activeThread = id;
        return sessions.updateSettings(id, params);
      }
      case "thread/goal/get": {
        sessions.record(text(params.threadId, "threadId"));
        return { goal: null }; // Pi has no Codex goal; mutation APIs remain unsupported.
      }
      case "thread/read": return { thread: sessions.read(text(params.threadId, "threadId"), params.includeTurns === true) };
      case "thread/turns/list": {
        let turns = sessions.read(text(params.threadId, "threadId")).turns as JsonObject[];
        if (params.sortDirection !== "asc") turns = turns.toReversed();
        if (params.itemsView === "notLoaded") turns = turns.map(turn => ({ ...turn, items: [], itemsView: "notLoaded" }));
        const result = page(turns, params); return { ...result, backwardsCursor: result.data.length ? String(params.cursor ?? 0) : null };
      }
      case "thread/items/list": {
        let items = (sessions.read(text(params.threadId, "threadId")).turns as JsonObject[])
          .filter(turn => !params.turnId || turn.id === params.turnId)
          .flatMap(turn => turn.items.map((item: JsonObject) => ({ turnId: turn.id, item, startedAtMs: turn.startedAt == null ? null : turn.startedAt * 1000, completedAtMs: turn.completedAt == null ? null : turn.completedAt * 1000 })));
        if (params.sortDirection === "desc") items.reverse();
        if (params.cursor && typeof params.cursor === "object") {
          if (!params.turnId || params.cursor.type !== "item") throw new RpcError(-32602, "Invalid item anchor.");
          const index = items.findIndex(item => item.item.id === params.cursor.itemId);
          if (index < 0) throw new RpcError(-32602, "Item not found.");
          params = { ...params, cursor: String(index + 1) };
        }
        const result = page(items, params); return { ...result, backwardsCursor: result.data.length ? String(params.cursor ?? 0) : null };
      }
      case "thread/unsubscribe": {
        const id = text(params.threadId, "threadId"); sessions.record(id);
        const subscribed = client.subscriptions.delete(id);
        if (client.activeThread === id) client.activeThread = undefined;
        return { status: subscribed ? "unsubscribed" : "notSubscribed" };
      }
      case "thread/name/set": sessions.rename(text(params.threadId, "threadId"), params.name); return {};
      case "thread/archive": sessions.archive(text(params.threadId, "threadId"), true); return {};
      case "thread/unarchive": {
        const id = text(params.threadId, "threadId"); sessions.archive(id, false); return { thread: sessions.read(id, false) };
      }
      case "turn/start":
      case "turn/steer": {
        const id = text(params.threadId, "threadId"); sessions.record(id); client.subscriptions.add(id); client.activeThread = id;
        const userId = params.clientUserMessageId == null ? `${client.id}:${requestId}` : text(params.clientUserMessageId, "clientUserMessageId", 512);
        return sessions.input(id, params, `${client.deviceId}:${userId}`, method === "turn/steer");
      }
      case "turn/interrupt": await sessions.interrupt(text(params.threadId, "threadId"), text(params.turnId, "turnId")); return {};
      case "remoteControl/status/read": return this.options.remoteStatus?.() ?? { status: "disabled", serverName: config.hostName, installationId: state.installationId(), environmentId: null };
      // Enrollment and adding a device require the local /remote command, not an already-paired remote peer.
      case "remoteControl/client/list": if (control) return control.devices(params); break;
      case "remoteControl/client/revoke": {
        if (!control) break;
        const id = text(params.clientId, "clientId");
        if (params.environmentId !== control.enrollment?.environmentId) throw new RpcError(-32602, "Unknown environment.");
        await control.revoke(id); this.options.revoke?.(id); return {};
      }
    }
    state.set("diagnostics", "unsupported", { method, at: now() });
    throw new RpcError(-32601, `This Pi host does not support ${method}.`);
  }
  private async models(threadId?: string): Promise<JsonObject[]> {
    const live = this.options.sessions.modelCatalog(threadId);
    let base: JsonObject[];
    try { base = await this.options.models(); }
    catch (error) { if (!live.length) throw error; base = []; }
    const catalog = [...new Map([...base, ...live].map(model => [model.id, model])).values()];
    const current = threadId ? this.options.sessions.read(threadId, false).model : this.options.sessions.list({ sortKey: "updated_at" })[0]?.model;
    const preferred = catalog.find(model => model.id === current) ?? catalog.find(model => model.isDefault) ?? catalog[0];
    return catalog.map(model => ({ ...model, isDefault: model === preferred }));
  }
  private warning(client: Client, key: string, summary: string, details: string): void {
    if (client.warnings.has(key)) return;
    client.warnings.add(key);
    this.options.state.set("diagnostics", "compatibility", { at: now(), summary });
    if (!client.optOut.has("configWarning")) client.send({ method: "configWarning", params: { summary, details, path: null, range: null } });
  }
  private desktopNotice(client: Client): void {
    this.warning(client, "desktop-defaults", "Pi keeps its local instructions, tools, and permissions.",
      "Codex-only feature flags, desktop instructions, and personality settings were not applied. Configure them in Pi. This host does not provide Codex sandboxing or approval checks.");
  }
  private project(id: unknown): JsonObject {
    const project = this.options.state.get("projects", text(id, "projectId"));
    if (!project) throw new RpcError(-32602, "Project not found.");
    return project;
  }
  private async projectRoots(value: unknown): Promise<{ path: string }[]> {
    if (!Array.isArray(value) || !value.length || value.length > 16) throw new RpcError(-32602, "Select between 1 and 16 project directories.");
    return Promise.all(value.map(async root => ({ path: await this.options.files.directory(object(root).path) })));
  }
  private metadata(value: unknown): JsonObject {
    const result = object(value ?? {});
    if (Object.keys(result).length > 100 || Object.entries(result).some(([key, value]) => key.length > 256 || typeof value !== "string" || value.length > 4096)) {
      throw new RpcError(-32602, "Invalid project metadata.");
    }
    return result;
  }
  private async createProject(params: JsonObject): Promise<JsonObject> {
    const key = text(params.idempotencyKey, "idempotencyKey", 512);
    const name = text(params.name, "project name", 256);
    const roots = await this.projectRoots(params.roots);
    const metadata = this.metadata(params.metadata);
    const threads = params.threads ?? [];
    if (!Array.isArray(threads) || threads.length > 1000) throw new RpcError(-32602, "Invalid conversation list.");
    for (const id of threads) this.options.sessions.record(text(id, "threadId"));
    const signature = createHash("sha256").update(JSON.stringify({ name, roots, metadata, threads })).digest("hex");
    const { state } = this.options;
    const project = state.transaction(() => {
      const old = state.get("projectInputs", key);
      if (old) {
        if (old.signature !== signature) throw new RpcError(-32602, "This project key was already used for different content.");
        return this.project(old.id);
      }
      const project = { id: randomUUID(), name, roots, metadata, position: state.list("projects").length,
        createdAt: now(), updatedAt: now(), recencyAt: null };
      state.set("projects", project.id, project); state.set("projectInputs", key, { id: project.id, signature });
      return project;
    });
    for (const id of threads) this.options.sessions.assignProject(id, project.id);
    this.notify(undefined, "project/changed", { projectId: project.id, changeType: "created" });
    return { project };
  }
}
