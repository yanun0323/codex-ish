import { createHash, randomUUID } from "node:crypto";
import { State } from "./state.js";
import { APP_SERVER_VERSION } from "./version.js";
import { now, RpcError, text, type JsonObject, type PreparedInput } from "./types.js";
import type { ModelOptions } from "./models.js";
import type { RemoteSkill } from "./skills.js";

export interface BackendInfo {
  id: string; cwd: string; model: string; provider: string; effort: string;
  sessionFile?: string; name?: string; busy?: boolean; models?: JsonObject[];
}
export interface Backend {
  info: BackendInfo;
  configure?(options: ModelOptions): Promise<void>;
  skills?(): Promise<RemoteSkill[]>;
  messages?(): JsonObject[];
  prepareInput?(input: JsonObject[]): Promise<PreparedInput>;
  send(input: JsonObject[], options: { steer: boolean; model?: string; effort?: string }, prepared?: PreparedInput): Promise<void>;
  abort(): Promise<void>;
  close(): Promise<void>;
}
export type BackendFactory = (record: ThreadRecord | undefined, params: JsonObject,
  event: (event: JsonObject) => void) => Promise<Backend>;
export interface ThreadRecord {
  thread: JsonObject; owner: "daemon" | "live"; sessionFile?: string; archived: boolean; liveMessages?: string[];
}
interface Active {
  turn: JsonObject; started: number; message: number;
  blocks: Map<string, JsonObject>; tools: Map<string, JsonObject>;
  pendingUsers: string[]; interrupted: boolean; failure?: string;
}
const copy = <T>(value: T): T => structuredClone(value);
const inputText = (input: JsonObject[]) => input.filter(part => part.type === "text").map(part => part.text).join("\n");
const messageText = (message: JsonObject) => typeof message.content === "string" ? message.content :
  (message.content ?? []).filter((part: JsonObject) => part.type === "text").map((part: JsonObject) => part.text).join("\n");
const messageKey = (message: JsonObject) => createHash("sha256").update(JSON.stringify({ role: message.role,
  content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? [])
    .filter((part: JsonObject) => part.type === "text" || part.type === "thinking")
    .map((part: JsonObject) => part.type === "text" ? { type: "text", text: part.text } : { type: "thinking", thinking: part.thinking ?? "" }) })).digest("hex");
const boundedText = (value: string, limit = 256 * 1024) => value.length > limit ? value.slice(0, limit) + "\n[Remote display truncated]" : value;

function displayInput(input: JsonObject[]): JsonObject[] {
  return input.map(value => {
    const part = copy(value);
    if (part.type !== "text") return part;
    // Desktop calls text_elements.some() without a guard. Older hosts used the wrong casing.
    part.text_elements = Array.isArray(part.text_elements) ? part.text_elements : Array.isArray(part.textElements) ? part.textElements : [];
    delete part.textElements;
    return part;
  });
}

export function makeThread(info: BackendInfo): JsonObject {
  return { id: info.id, sessionId: info.id, forkedFromId: null, parentThreadId: null, preview: "", ephemeral: false,
    section: null, sectionEnteredAt: null, projectId: null, historyMode: "legacy", modelProvider: info.provider,
    model: info.model, reasoningEffort: info.effort, createdAt: now(), updatedAt: now(), recencyAt: null,
    status: { type: "idle" }, path: info.sessionFile ?? null, cwd: info.cwd, cliVersion: APP_SERVER_VERSION,
    originator: "pi-codex-ish", source: { custom: "pi" }, canAcceptDirectInput: true, threadSource: "pi",
    agentNickname: null, agentRole: null, gitInfo: null, name: info.name ?? null, daybreakEnabled: null,
    environments: null, extra: null, turns: [] };
}
export function threadSettings(thread: JsonObject): JsonObject {
  return { disabledPluginIds: [], cwd: thread.cwd, model: thread.model, modelProvider: thread.modelProvider,
    effort: thread.reasoningEffort, serviceTier: null, summary: null, personality: null,
    approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" }, activePermissionProfile: null,
    collaborationMode: { mode: "default", settings: { model: thread.model, reasoning_effort: thread.reasoningEffort, developer_instructions: null } },
    multiAgentMode: "explicitRequestOnly" };
}
export function sessionResponse(thread: JsonObject): JsonObject {
  return { thread, model: thread.model, modelProvider: thread.modelProvider, serviceTier: null, cwd: thread.cwd,
    runtimeWorkspaceRoots: [thread.cwd], instructionSources: [], approvalPolicy: "never", approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" }, activePermissionProfile: null, reasoningEffort: thread.reasoningEffort,
    collaborationMode: threadSettings(thread).collaborationMode, multiAgentMode: "explicitRequestOnly", disabledPluginIds: [],
    initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
}
export function validateExecutionOptions(params: JsonObject): void {
  // Pi is not Codex's sandbox. Never acknowledge stronger restrictions without enforcing them.
  if (params.approvalPolicy != null && params.approvalPolicy !== "never" ||
      params.sandbox != null && params.sandbox !== "danger-full-access" ||
      params.sandboxPolicy != null && params.sandboxPolicy.type !== "dangerFullAccess" || params.permissions != null ||
      params.approvalsReviewer != null && params.approvalsReviewer !== "user") {
    throw new RpcError(-32602, "Pi runs with the host user's permissions. This host cannot enforce Codex sandbox or approval policies.");
  }
  if (params.config && Object.keys(params.config).length) throw new RpcError(-32602, "Codex configuration overrides are not supported by this Pi host.");
  if (params.disabledPluginIds?.length) throw new RpcError(-32602, "Pi extensions cannot be disabled through Codex plugin settings.");
  for (const key of ["outputSchema", "toolOutput", "collaborationMode", "environments", "additionalContext", "developerInstructions", "baseInstructions", "dynamicTools", "serviceTier", "serviceTierForTurn", "cyberAccessProgram", "permissionProfile", "additionalPermissions", "runtimeWorkspaceRoots"]) {
    if (params[key] != null) throw new RpcError(-32602, `${key} is not supported by this Pi host.`);
  }
  if (params.model != null) text(params.model, "model", 512);
  if (params.effort != null && !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(params.effort)) {
    throw new RpcError(-32602, "This reasoning effort is not supported by Pi.");
  }
}

/** One backend per thread. Every subscriber receives the same items, independent of sender. */
export class Sessions {
  private backends = new Map<string, Backend>();
  private loading = new Map<string, Promise<Backend>>();
  private active = new Map<string, Active>();
  private locks = new Map<string, Promise<unknown>>();
  private records = new Map<string, ThreadRecord>();
  private saveTimer?: NodeJS.Timeout;
  private closing = false;
  private starting = new Set<Promise<JsonObject>>();
  private dirty = new Set<string>();
  onNotify: (threadId: string | undefined, method: string, params: JsonObject) => void = () => {};
  readonly state: State;
  private createBackend: BackendFactory;
  private validateInput: (input: JsonObject[]) => Promise<unknown>;
  constructor(state: State, createBackend: BackendFactory, validateInput: (input: JsonObject[]) => Promise<unknown> = async () => {}) {
    this.state = state; this.createBackend = createBackend; this.validateInput = validateInput;
    for (const record of state.list<ThreadRecord>("threads")) {
      record.thread.status = { type: "notLoaded" };
      record.thread.canAcceptDirectInput = record.owner === "daemon" || !!record.sessionFile;
      for (const turn of record.thread.turns) {
        for (const item of turn.items) {
          if (item.type === "userMessage") item.content = displayInput(item.content);
        }
        if (turn.status === "inProgress") {
          turn.status = "interrupted"; turn.completedAt = now();
          turn.error = { message: "The host restarted. This request was not automatically repeated.", codexErrorInfo: null, additionalDetails: null };
        }
      }
      this.records.set(record.thread.id, record);
      this.persist(record.thread.id);
    }
  }
  private emit(id: string | undefined, method: string, params: JsonObject) {
    if (method === "item/started") params = { ...params, startedAtMs: Date.now() };
    if (method === "item/completed") params = { ...params, completedAtMs: Date.now() };
    this.onNotify(id, method, copy(params));
  }
  record(id: string): ThreadRecord {
    const record = this.records.get(id);
    if (!record) throw new RpcError(-32602, "Conversation not found.");
    return record;
  }
  read(id: string, includeTurns = true): JsonObject {
    const thread = copy(this.record(id).thread);
    if (!includeTurns) thread.turns = [];
    return thread;
  }
  list(params: JsonObject = {}): JsonObject[] {
    for (const key of ["modelProviders", "sourceKinds"]) {
      if (params[key] != null && (!Array.isArray(params[key]) || params[key].some((value: unknown) => typeof value !== "string"))) {
        throw new RpcError(-32602, `${key} must be a list of strings.`);
      }
    }
    const cwds = params.cwd == null ? [] : Array.isArray(params.cwd) ? params.cwd : [params.cwd];
    if (cwds.some((cwd: unknown) => typeof cwd !== "string")) throw new RpcError(-32602, "Use a directory path or list of paths.");
    const sort = params.sortKey ?? "created_at";
    if (!["created_at", "updated_at", "recency_at", "section_position"].includes(sort) ||
        params.sortDirection != null && !["asc", "desc"].includes(params.sortDirection)) throw new RpcError(-32602, "Invalid conversation sort order.");
    const value = (thread: JsonObject): number => sort === "created_at" ? thread.createdAt :
      sort === "recency_at" ? thread.recencyAt ?? thread.updatedAt : thread.updatedAt;
    return [...this.records.values()].filter(record => record.archived === (params.archived ?? false))
      .filter(record => !cwds.length || cwds.includes(record.thread.cwd))
      .filter(record => !params.projectId || record.thread.projectId === params.projectId)
      .filter(record => !params.parentThreadId || record.thread.parentThreadId === params.parentThreadId)
      .filter(record => !params.modelProviders?.length || params.modelProviders.includes(record.thread.modelProvider))
      .filter(record => !params.sourceKinds?.length || params.sourceKinds.includes(record.owner === "live" ? "cli" : "appServer"))
      .filter(record => !Object.hasOwn(params, "sectionId") || (record.thread.section?.id ?? null) === params.sectionId)
      .filter(record => !params.searchTerm || `${record.thread.name ?? ""} ${record.thread.preview}`.toLowerCase().includes(String(params.searchTerm).toLowerCase()))
      .map(record => this.read(record.thread.id, false))
      .sort((a, b) => ((value(b) - value(a)) || b.id.localeCompare(a.id)) * (params.sortDirection === "asc" ? -1 : 1));
  }
  loaded(): string[] { return [...this.backends.keys()]; }
  modelCatalog(preferred?: string): JsonObject[] {
    const catalog = [...this.backends.values()].flatMap(backend => backend.info.models ?? []);
    return [...catalog, ...(preferred ? this.backends.get(preferred)?.info.models ?? [] : [])];
  }
  async skills(cwd: string, preferred?: string): Promise<RemoteSkill[] | undefined> {
    const selected = preferred ? this.backends.get(preferred) : undefined;
    const backend = selected?.info.cwd === cwd && selected.skills ? selected
      : [...this.backends.values()].reverse().find(backend => backend.info.cwd === cwd && backend.skills);
    return backend?.skills?.();
  }
  settingsChanged(id: string, info: Pick<BackendInfo, "model" | "provider" | "effort">): void {
    text(info.model, "model", 512); text(info.provider, "provider", 256);
    validateExecutionOptions({ effort: info.effort });
    const thread = this.record(id).thread;
    const changed = thread.model !== info.model || thread.modelProvider !== info.provider || thread.reasoningEffort !== info.effort;
    const backend = this.backends.get(id);
    if (backend) Object.assign(backend.info, { model: info.model, provider: info.provider, effort: info.effort });
    if (!changed) return;
    thread.model = info.model; thread.modelProvider = info.provider; thread.reasoningEffort = info.effort;
    this.persist(id);
    this.emit(id, "thread/settings/updated", { threadId: id, threadSettings: threadSettings(thread) });
  }
  async updateSettings(id: string, params: JsonObject): Promise<JsonObject> {
    return this.serial(id, async () => {
      validateExecutionOptions(params);
      const allowed = new Set(["threadId", "model", "effort", "cwd", "approvalPolicy", "approvalsReviewer", "sandboxPolicy", "disabledPluginIds", "serviceTier"]);
      if (Object.keys(params).some(key => !allowed.has(key) && params[key] != null)) throw new RpcError(-32602, "Change only the model or thinking level here. Configure other settings in Pi.");
      const thread = this.record(id).thread;
      if (params.cwd != null && params.cwd !== thread.cwd) throw new RpcError(-32602, "Start a new conversation to change its project directory.");
      if (this.active.has(id)) throw new RpcError(-32602, "Wait for this turn to finish before changing the model or thinking level.");
      const backend = await this.backend(id);
      if (!backend.configure) throw new RpcError(-32600, "Reload codex-ish in Pi to change this conversation's model or thinking level.");
      await backend.configure({ model: params.model ?? undefined, effort: params.effort ?? undefined });
      this.settingsChanged(id, backend.info);
      return {};
    });
  }
  private serial<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(run);
    this.locks.set(id, current);
    void current.finally(() => { if (this.locks.get(id) === current) this.locks.delete(id); }).catch(() => {});
    return current;
  }
  async start(params: JsonObject): Promise<JsonObject> {
    if (this.closing) throw new RpcError(-32600, "Remote is stopping. Reconnect before starting a conversation.");
    const pending = this.startConversation(params); this.starting.add(pending);
    try { return await pending; } finally { this.starting.delete(pending); }
  }
  private async startConversation(params: JsonObject): Promise<JsonObject> {
    validateExecutionOptions(params);
    const events: JsonObject[] = [];
    let id: string | undefined;
    const backend = await this.createBackend(undefined, params, event => id ? this.event(id, event) : events.push(event));
    if (this.closing) { await backend.close(); throw new RpcError(-32600, "Remote stopped before the conversation could be opened."); }
    id = backend.info.id;
    if (this.records.has(id)) { await backend.close(); throw new Error("Duplicate Pi session identifier."); }
    const thread = makeThread(backend.info);
    thread.projectId = params.projectId ?? null;
    this.records.set(id, { thread, owner: "daemon", sessionFile: backend.info.sessionFile, archived: false });
    this.backends.set(id, backend); this.persist(id);
    for (const event of events) this.event(id, event);
    this.emit(undefined, "thread/started", { thread: this.read(id, false) });
    return sessionResponse(this.read(id, false));
  }
  async resume(id: string): Promise<JsonObject> {
    // Reading a terminal's history must not load extensions or start a background worker.
    // Its saved session is claimed lazily when the user actually sends a message.
    if (this.record(id).owner !== "live" || this.backends.has(id)) await this.backend(id);
    return sessionResponse(this.read(id));
  }
  private async backend(id: string): Promise<Backend> {
    if (this.closing) throw new RpcError(-32600, "Remote is stopping. Reconnect before sending another message.");
    const loaded = this.backends.get(id);
    if (loaded) return loaded;
    const record = this.record(id);
    if (record.owner === "live" && !record.sessionFile) throw new RpcError(-32600, "This conversation has no saved Pi session. Open it in Pi to reconnect it.");
    let pending = this.loading.get(id);
    if (!pending) {
      pending = this.createBackend(record, {}, event => this.event(id, event)).then(async backend => {
        if (this.closing) { await backend.close(); throw new RpcError(-32600, "Remote stopped before the conversation could be opened."); }
        this.backends.set(id, backend); record.owner = "daemon"; record.thread.canAcceptDirectInput = true;
        record.thread.status = { type: "idle" };
        if (backend.messages) this.snapshot(id, backend.messages());
        this.settingsChanged(id, backend.info); this.persist(id);
        this.emit(id, "thread/status/changed", { threadId: id, status: record.thread.status });
        return backend;
      }).finally(() => this.loading.delete(id));
      this.loading.set(id, pending);
    }
    return pending;
  }
  async claimLocal(id: string, claim: () => void): Promise<void> {
    return this.serial(id, async () => {
      await this.loading.get(id);
      if (this.closing) throw new RpcError(-32600, "Remote is stopping. Reopen the session after it restarts.");
      const backend = this.backends.get(id);
      if (this.active.has(id) || backend?.info.busy) throw new RpcError(-32600, "This conversation is still running. Wait for it to finish before reopening it in Pi.");
      if (backend && this.record(id).owner === "live") throw new RpcError(-32600, "This conversation is already open in another Pi window.");
      if (backend) { await backend.close(); this.backends.delete(id); }
      claim();
    });
  }
  attach(backend: Backend, messages: JsonObject[] = [], handoff = false): void {
    const id = backend.info.id;
    if (this.closing || this.backends.has(id) || this.loading.has(id)) throw new RpcError(-32600, "This conversation already has an execution owner.");
    const existing = this.records.get(id);
    if (existing?.owner === "daemon" && !handoff) throw new RpcError(-32600, "This conversation belongs to the Remote worker. Resume it from a Codex App.");
    const record = existing ?? { thread: makeThread(backend.info), owner: "live" as const, archived: false };
    this.records.set(id, record); this.backends.set(id, backend);
    record.thread.status = { type: backend.info.busy ? "active" : "idle", ...(backend.info.busy ? { activeFlags: [] } : {}) };
    record.thread.canAcceptDirectInput = true; record.sessionFile = backend.info.sessionFile;
    record.owner = "live";
    this.snapshot(id, messages);
    record.thread.model = backend.info.model; record.thread.modelProvider = backend.info.provider;
    record.thread.reasoningEffort = backend.info.effort; record.thread.name = backend.info.name ?? record.thread.name;
    if (backend.info.busy) this.ensureActive(id);
    this.persist(id);
    this.emit(undefined, "thread/started", { thread: this.read(id, false) });
    this.emit(id, "thread/status/changed", { threadId: id, status: record.thread.status });
  }
  detach(id: string, backend: Backend): void {
    if (this.backends.get(id) !== backend) return;
    this.backends.delete(id);
    this.finish(id, "interrupted", "The Pi terminal disconnected. No second writer was started.");
    const record = this.record(id);
    record.thread.status = { type: "notLoaded" }; record.thread.canAcceptDirectInput = !!record.sessionFile;
    this.persist(id); this.emit(id, "thread/status/changed", { threadId: id, status: record.thread.status });
  }
  private ensureActive(id: string): Active {
    let active = this.active.get(id);
    if (active) return active;
    const turn = { id: randomUUID(), items: [] as JsonObject[], itemsView: "full", status: "inProgress", error: null,
      startedAt: now(), completedAt: null, durationMs: null };
    active = { turn, started: Date.now(), message: 0, blocks: new Map(), tools: new Map(), pendingUsers: [], interrupted: false };
    this.active.set(id, active);
    const record = this.record(id);
    record.thread.turns.push(turn); record.thread.status = { type: "active", activeFlags: [] };
    this.persist(id);
    this.emit(id, "turn/started", { threadId: id, turn });
    this.emit(id, "thread/status/changed", { threadId: id, status: record.thread.status });
    return active;
  }
  async input(id: string, params: JsonObject, dedupeKey: string, steer = false): Promise<JsonObject> {
    return this.serial(id, async () => {
      validateExecutionOptions(params);
      if (!Array.isArray(params.input) || !params.input.length || params.input.length > 64) throw new RpcError(-32602, "Provide at least one input item.");
      if (Buffer.byteLength(JSON.stringify(params.input)) > 12 * 1024 * 1024) throw new RpcError(-32602, "Message is too large.");
      const signature = createHash("sha256").update(JSON.stringify({ input: params.input, model: params.model, effort: params.effort, steer })).digest("hex");
      const key = JSON.stringify([id, dedupeKey]);
      const prior = this.state.get("inputs", key);
      if (prior) {
        if (prior.signature !== signature) throw new RpcError(-32602, "This message identifier was already used for different content.");
        const turn = this.record(id).thread.turns.find((turn: JsonObject) => turn.id === prior.turnId);
        if (!turn) throw new RpcError(-32600, "The previous request is no longer available. Read the conversation before resending.");
        return steer ? { turnId: turn.id } : { turn: copy(turn) };
      }
      const backend = await this.backend(id);
      const prepared = backend.prepareInput ? await backend.prepareInput(params.input) : undefined;
      if (!prepared) await this.validateInput(params.input);
      const current = this.active.get(id);
      if (steer && (!current || params.expectedTurnId !== current.turn.id)) throw new RpcError(-32602, "The active turn changed. Resume the conversation and try again.");
      const thread = this.record(id).thread;
      if (params.cwd && params.cwd !== thread.cwd) throw new RpcError(-32602, "Start a new conversation to change its project directory.");
      if (current && (params.model != null && params.model !== thread.model || params.effort != null && params.effort !== thread.reasoningEffort)) {
        throw new RpcError(-32602, "Wait for this turn to finish before changing the model or reasoning effort.");
      }
      const active = this.ensureActive(id);
      const item = { type: "userMessage", id: randomUUID(), clientId: params.clientUserMessageId ?? null, content: displayInput(params.input) };
      active.pendingUsers.push(prepared?.text ?? inputText(params.input));
      this.item(id, item, true);
      this.state.transaction(() => {
        this.persist(id);
        this.state.set("inputs", key, { signature, turnId: active.turn.id });
      });
      try {
        // send() acknowledges acceptance, not completion. Pi owns the follow-up queue.
        await backend.send(params.input, { steer, model: params.model, effort: params.effort }, prepared);
        this.settingsChanged(id, backend.info);
        thread.path = backend.info.sessionFile ?? thread.path;
        this.record(id).sessionFile = backend.info.sessionFile;
      } catch (error) {
        // Rejected follow-ups must not falsely complete work that Pi is still running.
        if (!current) this.finish(id, "failed", error instanceof RpcError ? error.message : "Pi could not accept this message.");
        throw error;
      }
      this.persist(id);
      return steer ? { turnId: active.turn.id } : { turn: copy(active.turn) };
    });
  }
  async interrupt(id: string, turnId: string): Promise<void> {
    const active = this.active.get(id);
    if (!active || active.turn.id !== turnId) throw new RpcError(-32602, "Active turn not found.");
    active.interrupted = true;
    await (await this.backend(id)).abort();
  }
  rename(id: string, name: string): void {
    this.record(id).thread.name = text(name, "name", 512); this.persist(id);
    this.emit(undefined, "thread/name/updated", { threadId: id, threadName: name });
  }
  archive(id: string, archived: boolean): void {
    if (this.active.has(id)) throw new RpcError(-32600, "Stop the active turn before archiving this conversation.");
    this.record(id).archived = archived; this.persist(id);
    this.emit(undefined, archived ? "thread/archived" : "thread/unarchived", { threadId: id });
  }
  assignProject(id: string, projectId: string | null): void {
    this.record(id).thread.projectId = projectId; this.persist(id);
    this.emit(undefined, "thread/project/updated", { threadId: id, projectId });
  }
  private item(id: string, item: JsonObject, completed = false): void {
    const active = this.ensureActive(id);
    active.turn.items.push(item);
    if (item.type === "userMessage" && !this.record(id).thread.preview) this.record(id).thread.preview = inputText(item.content).slice(0, 200);
    this.emit(id, "item/started", { threadId: id, turnId: active.turn.id, item });
    if (completed) this.emit(id, "item/completed", { threadId: id, turnId: active.turn.id, item });
    this.scheduleSave(id);
  }
  private block(id: string, index: number, kind: "agentMessage" | "reasoning"): JsonObject {
    const active = this.ensureActive(id);
    const key = `${active.message}:${index}:${kind}`;
    let item = active.blocks.get(key);
    if (!item) {
      item = kind === "agentMessage" ? { type: kind, id: randomUUID(), text: "", phase: null, memoryCitation: null, delivery: null, questions: null }
        : { type: kind, id: randomUUID(), summary: [], content: [""] };
      active.blocks.set(key, item); this.item(id, item);
    }
    return item;
  }
  event(id: string, event: JsonObject): void {
    if (!this.records.has(id)) return;
    const record = this.record(id);
    if (event.type === "message_start" && event.message?.role === "user" ||
        event.type === "message_end" && event.message?.role === "assistant") {
      (record.liveMessages ??= []).push(messageKey(event.message));
    }
    if (event.type === "remote_settings_changed") {
      this.settingsChanged(id, event.info);
      const backend = this.backends.get(id);
      if (backend && Array.isArray(event.info.models)) backend.info.models = event.info.models;
      return;
    }
    if (event.type === "agent_start") { this.ensureActive(id); return; }
    if (event.type === "message_start") {
      if (event.message?.role === "assistant") {
        const active = this.ensureActive(id); active.message++; active.failure = undefined;
      } else if (event.message?.role === "user") {
        const active = this.ensureActive(id);
        const value = messageText(event.message);
        const pending = active.pendingUsers.indexOf(value);
        if (pending >= 0) active.pendingUsers.splice(pending, 1);
        else this.item(id, { type: "userMessage", id: randomUUID(), clientId: null,
          content: [{ type: "text", text: boundedText(value), text_elements: [] }] }, true);
      }
      return;
    }
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (!delta || !["text_delta", "thinking_delta"].includes(delta.type)) return;
      const reasoning = delta.type === "thinking_delta";
      const item = this.block(id, delta.contentIndex ?? 0, reasoning ? "reasoning" : "agentMessage");
      if (reasoning) item.content[0] += delta.delta; else item.text += delta.delta;
      const active = this.active.get(id)!;
      this.emit(id, reasoning ? "item/reasoning/textDelta" : "item/agentMessage/delta",
        { threadId: id, turnId: active.turn.id, itemId: item.id, delta: delta.delta, ...(reasoning ? { contentIndex: 0 } : {}) });
      this.scheduleSave(id); return;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      const active = this.ensureActive(id);
      for (const [index, part] of (message.content ?? []).entries()) {
        if (part.type !== "text" && part.type !== "thinking") continue;
        const item = this.block(id, index, part.type === "text" ? "agentMessage" : "reasoning");
        if (part.type === "text") item.text = part.text; else item.content = [part.thinking ?? ""];
        this.emit(id, "item/completed", { threadId: id, turnId: active.turn.id, item });
      }
      if (message.stopReason === "error") active.failure = "The model request failed. Check Pi for details.";
      if (message.stopReason === "aborted") active.interrupted = true;
      this.persist(id); return;
    }
    if (event.type === "tool_execution_start") {
      const active = this.ensureActive(id);
      const item = event.toolName === "bash" ? { type: "commandExecution", id: event.toolCallId,
        command: String(event.args?.command ?? ""), cwd: this.record(id).thread.cwd, processId: null,
        source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: "", exitCode: null, durationMs: null,
        pluginId: null, scriptPath: null }
        : { type: "dynamicToolCall", id: event.toolCallId, namespace: null, tool: event.toolName,
          arguments: event.args ?? {}, status: "inProgress", contentItems: null, success: null, durationMs: null };
      active.tools.set(event.toolCallId, item); this.item(id, item); return;
    }
    if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const active = this.active.get(id); const item = active?.tools.get(event.toolCallId);
      if (!active || !item) return;
      const result = event.result ?? event.partialResult ?? {};
      const output = boundedText((result.content ?? []).filter((part: JsonObject) => part.type === "text").map((part: JsonObject) => part.text).join("\n"));
      if (item.type === "commandExecution") {
        const previous = item.aggregatedOutput as string;
        if (output.startsWith(previous) && output.length > previous.length) this.emit(id, "item/commandExecution/outputDelta",
          { threadId: id, turnId: active.turn.id, itemId: item.id, delta: output.slice(previous.length) });
        item.aggregatedOutput = output;
      } else item.contentItems = [{ type: "inputText", text: output }];
      if (event.type === "tool_execution_end") {
        item.status = event.isError ? "failed" : "completed";
        if (item.type === "commandExecution") item.exitCode = typeof result.details?.exitCode === "number" ? result.details.exitCode : event.isError ? 1 : 0;
        else item.success = !event.isError;
        this.emit(id, "item/completed", { threadId: id, turnId: active.turn.id, item });
      }
      this.scheduleSave(id); return;
    }
    if (event.type === "agent_settled") {
      const active = this.active.get(id);
      if (active) this.finish(id, active.interrupted ? "interrupted" : active.failure ? "failed" : "completed", active.failure);
    } else if (event.type === "remote_input_error") {
      this.finish(id, "failed", "Pi could not process the message. Check the terminal for details.");
    } else if (event.type === "session_info_changed") this.rename(id, event.name || "Pi conversation");
  }
  private finish(id: string, status: string, error?: string): void {
    const active = this.active.get(id);
    if (!active) return;
    active.turn.status = status; active.turn.completedAt = now(); active.turn.durationMs = Date.now() - active.started;
    active.turn.error = error ? { message: error, codexErrorInfo: null, additionalDetails: null } : null;
    this.active.delete(id);
    const record = this.record(id); record.thread.status = { type: "idle" };
    this.persist(id);
    this.emit(id, "turn/completed", { threadId: id, turn: active.turn });
    this.emit(id, "thread/status/changed", { threadId: id, status: record.thread.status });
  }
  private snapshot(id: string, messages: JsonObject[]): void {
    const record = this.record(id);
    const visible = messages.filter(message => ["user", "assistant"].includes(message.role));
    const keys = visible.map(messageKey);
    if (JSON.stringify(record.liveMessages ?? []) === JSON.stringify(keys)) return;
    // The full saved Pi branch is authoritative, including work done while Remote was offline.
    // Keep stable Remote turn IDs whenever the branch is unchanged.
    this.active.delete(id); record.thread.turns = []; record.thread.preview = ""; record.liveMessages = [];
    this.importHistory(id, visible);
  }
  private importHistory(id: string, messages: JsonObject[]): void {
    // Only visible messages are projected; system prompts and provider signatures stay in Pi.
    const notify = this.onNotify; this.onNotify = () => {};
    try {
      for (const message of messages) {
        if (message.role === "user") {
          if (this.active.has(id)) this.finish(id, "completed");
          this.event(id, { type: "message_start", message });
        } else if (message.role === "assistant") {
          this.event(id, { type: "message_start", message }); this.event(id, { type: "message_end", message });
        }
      }
      this.finish(id, "completed");
    } finally { this.onNotify = notify; }
  }
  private scheduleSave(id: string): void {
    this.dirty.add(id);
    this.saveTimer ??= setTimeout(() => { this.saveTimer = undefined; this.flush(); }, 250);
  }
  private persist(id: string): void {
    const record = this.record(id); record.thread.updatedAt = now(); record.thread.recencyAt = now();
    this.state.set("threads", id, record); this.dirty.delete(id);
  }
  flush(): void { for (const id of [...this.dirty]) this.persist(id); }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.starting, ...this.loading.values(), ...this.locks.values()]);
    clearTimeout(this.saveTimer);
    for (const backend of this.backends.values()) await backend.close();
    for (const id of [...this.active.keys()]) this.finish(id, "interrupted", "Remote stopped.");
    this.flush(); this.backends.clear();
  }
}
