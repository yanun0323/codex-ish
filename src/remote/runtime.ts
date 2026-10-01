import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RemoteConfig } from "./config.js";
import type { Credentials } from "./control-api.js";
import { HostFiles } from "./filesystem.js";
import { deferred, RpcError, text, type JsonObject } from "./types.js";
import type { Backend, BackendFactory } from "./sessions.js";

export async function piInput(input: JsonObject[], files: HostFiles) {
  const parts: string[] = [];
  const images: { data: string; mimeType: string; type: "image" }[] = [];
  for (const item of input) {
    if (item.type === "text") {
      if (typeof item.text !== "string" || item.text.length > 1024 * 1024) throw new RpcError(-32602, "Invalid text input.");
      parts.push(item.text);
    } else if (item.type === "image") {
      const value = text(item.url, "image", 12 * 1024 * 1024);
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
      if (!match || !match[2] || match[2].length > 12 * 1024 * 1024) throw new RpcError(-32602, "Send images as PNG, JPEG, WebP, or GIF data URLs. Remote URL downloads are disabled.");
      const bytes = Buffer.from(match[2], "base64");
      if (bytes.length > 8 * 1024 * 1024 || bytes.toString("base64") !== match[2]) throw new RpcError(-32602, "Invalid or oversized image.");
      images.push({ type: "image", data: match[2], mimeType: match[1]! });
    } else if (item.type === "localImage") {
      const bytes = await files.read(item.path);
      const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
        : bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg"
        : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp"
        : bytes.toString("ascii", 0, 3) === "GIF" ? "image/gif" : undefined;
      if (!mime) throw new RpcError(-32602, "Unsupported image format.");
      images.push({ type: "image", data: bytes.toString("base64"), mimeType: mime });
    } else throw new RpcError(-32602, `Input type ${String(item.type)} is not supported. Use text or images.`);
  }
  if (!parts.some(part => part.trim()) && !images.length) throw new RpcError(-32602, "Enter a message or attach an image.");
  return { text: parts.join("\n"), images };
}

/** Resolve the host's SDK, not a second Pi installation hidden in a dependency. */
export class PiRuntime {
  private sdk: JsonObject;
  private modelsRuntime: JsonObject;
  private config: RemoteConfig;
  private files: HostFiles;
  private constructor(sdk: JsonObject, modelsRuntime: JsonObject, config: RemoteConfig, files: HostFiles) {
    this.sdk = sdk; this.modelsRuntime = modelsRuntime; this.config = config; this.files = files;
  }
  static async create(config: RemoteConfig, files: HostFiles, sdkPath: string): Promise<PiRuntime> {
    const sdk = await import(pathToFileURL(sdkPath).href);
    if (!sdk.ModelRuntime || !sdk.createAgentSession) throw new Error("The installed Pi SDK is not supported. Update Pi and rebuild codex-ish.");
    const models = await sdk.ModelRuntime.create({ authPath: join(config.agentDir, "auth.json"),
      modelsPath: join(config.agentDir, "models.json"), modelsStorePath: join(config.home, "models-cache.json"), allowModelNetwork: false });
    return new PiRuntime(sdk, models, config, files);
  }
  async credentials(): Promise<Credentials> {
    const stored = await this.modelsRuntime.listCredentials();
    if (!stored.some((value: JsonObject) => value.providerId === "openai-codex" && value.type === "oauth")) {
      throw new RpcError(-32001, "Run /login in Pi and sign in with OpenAI Codex before pairing Remote.");
    }
    const result = await this.modelsRuntime.getAuth("openai-codex");
    if (!result?.auth?.apiKey) {
      throw new RpcError(-32001, "Run /login in Pi and sign in with OpenAI Codex before pairing Remote.");
    }
    const accessToken = result.auth.apiKey as string;
    let accountId: unknown;
    try {
      const claims = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString());
      accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    } catch { /* A missing account is an authentication failure, not a decoding detail to expose. */ }
    if (typeof accountId !== "string" || !accountId) throw new RpcError(-32001, "ChatGPT account identity is unavailable. Sign in again in Pi.");
    return { accessToken, accountId };
  }
  async models(): Promise<JsonObject[]> {
    const available = await this.modelsRuntime.getAvailable();
    return available.map((model: JsonObject, index: number) => ({ id: `${model.provider}/${model.id}`, model: `${model.provider}/${model.id}`,
      displayName: model.name ?? model.id, description: `${model.provider} · Pi`, hidden: false,
      upgrade: null, upgradeInfo: null, availabilityNux: null, modelSpecialty: null,
      supportedReasoningEfforts: (model.reasoning ? ["minimal", "low", "medium", "high"] : ["none"])
        .map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
      defaultReasoningEffort: model.reasoning ? "medium" : "none", inputModalities: model.input ?? ["text"],
      supportsPersonality: false, multiAgentVersion: null, additionalSpeedTiers: [], serviceTiers: [],
      defaultServiceTier: null, availableAccessPrograms: null, isDefault: index === 0 }));
  }
  private resolveModel(name: string | undefined): JsonObject | undefined {
    if (!name) return undefined;
    const model = this.modelsRuntime.getModels().find((value: JsonObject) => `${value.provider}/${value.id}` === name || value.id === name);
    if (!model) throw new RpcError(-32602, "Model not found. Refresh the model list.");
    return model;
  }
  readonly createBackend: BackendFactory = async (record, params, event) => {
    const cwd = await this.files.directory(record?.thread.cwd ?? params.cwd ?? this.config.userHome);
    const model = this.resolveModel(params.model ?? record?.thread.model);
    const sessionDir = join(this.config.home, "sessions");
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const manager = record?.sessionFile ? this.sdk.SessionManager.open(record.sessionFile, sessionDir)
      : this.sdk.SessionManager.create(cwd, sessionDir);
    if (record && manager.getSessionId() !== record.thread.id) throw new Error("Pi session identity changed.");
    if (!record && manager.getSessionFile()) {
      // Pi normally creates this file only after an assistant reply. Persist the new worker's
      // public session header now so an empty Remote conversation can survive a host restart.
      await writeFile(manager.getSessionFile(), JSON.stringify(manager.getHeader()) + "\n", { flag: "wx", mode: 0o600 });
    }
    const settings = this.sdk.SettingsManager.create(cwd, this.config.agentDir);
    const loader = new this.sdk.DefaultResourceLoader({ cwd, agentDir: this.config.agentDir, settingsManager: settings });
    // Existing Pi trust decisions remain authoritative. Remote must not silently trust downloaded project code.
    await loader.reload({ resolveProjectTrust: async () => false });
    const { session } = await this.sdk.createAgentSession({ cwd, agentDir: this.config.agentDir, sessionManager: manager,
      modelRuntime: this.modelsRuntime, model, settingsManager: settings, resourceLoader: loader,
      ...((params.effort ?? record?.thread.reasoningEffort) ? { thinkingLevel: (params.effort ?? record?.thread.reasoningEffort) === "none" ? "off" : params.effort ?? record?.thread.reasoningEffort } : {}) });
    if (!session.model) { session.dispose(); throw new RpcError(-32600, "Configure a model and login in Pi before starting a Remote conversation."); }
    const info = { id: session.sessionId, cwd, sessionFile: session.sessionFile as string | undefined,
      model: `${session.model.provider}/${session.model.id}`, provider: session.model.provider, effort: session.thinkingLevel === "off" ? "none" : session.thinkingLevel };
    const unsubscribe = session.subscribe((value: JsonObject) => event(value));
    try { await session.bindExtensions({ mode: "rpc", onError: () => {} }); }
    catch (error) { unsubscribe(); session.dispose(); throw error; }
    let closed = false;
    return {
      info,
      send: async (input, options) => {
        if (closed) throw new RpcError(-32600, "This Pi worker has stopped.");
        const parsed = await piInput(input, this.files);
        const nextModel = this.resolveModel(options.model);
        if (nextModel) await session.setModel(nextModel, { persist: false });
        if (options.effort) session.setThinkingLevel(options.effort === "none" ? "off" : options.effort);
        info.model = `${session.model.provider}/${session.model.id}`; info.provider = session.model.provider;
        info.effort = session.thinkingLevel === "off" ? "none" : session.thinkingLevel;
        if (options.steer) {
          if (await session.steer(parsed.text, parsed.images) === "handled") throw new RpcError(-32600, "A Pi extension handled this input outside the shared conversation.");
          return;
        }
        const accepted = deferred<void>();
        void session.prompt(parsed.text, { images: parsed.images, expandPromptTemplates: false, source: "rpc", streamingBehavior: "followUp",
          preflightResult: (disposition: unknown) => {
            if (disposition === "handled") accepted.reject(new RpcError(-32600, "A Pi extension handled this input outside the shared conversation."));
            else accepted.resolve();
          } }).then(() => { accepted.resolve(); }, (error: unknown) => {
          accepted.reject(error); event({ type: "remote_input_error" });
        });
        await accepted.promise;
        info.sessionFile = session.sessionFile;
      },
      abort: async () => { session.clearQueue(); await session.abort(); },
      close: async () => { if (closed) return; closed = true; session.clearQueue(); await session.abort(); unsubscribe(); session.dispose(); },
    } satisfies Backend;
  };
}
