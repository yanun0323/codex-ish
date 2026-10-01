import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RemoteConfig } from "./config.js";
import type { Credentials } from "./control-api.js";
import { HostFiles } from "./filesystem.js";
import { deferred, object, RpcError, text, type JsonObject, type PreparedInput } from "./types.js";
import type { Backend, BackendFactory } from "./sessions.js";
import { SessionOwners, sessionHeader, type SessionOwner } from "./ownership.js";
import { hostThinkingLevels, modelCatalog, reasoningEffort, resolveModel, thinkingLevel, validateModelOptions, type ModelOptions, type ThinkingLevels } from "./models.js";
import { escapeAttribute, resourceSkills, skillBlock, type RemoteSkill } from "./skills.js";

export async function piInput(input: JsonObject[], files: HostFiles,
  options: { cwd?: string; skills?: () => Promise<RemoteSkill[]> } = {}): Promise<PreparedInput> {
  const parts: string[] = [];
  const blocks: string[] = [];
  const selected = new Set<string>();
  let skills: RemoteSkill[] | undefined;
  const images: PreparedInput["images"] = [];
  for (const raw of input) {
    const item = object(raw);
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
    } else if (item.type === "skill" && options.skills) {
      skills ??= await options.skills();
      const key = JSON.stringify([item.name, item.path]);
      if (!selected.has(key)) { blocks.push(await skillBlock(item, skills)); selected.add(key); }
    } else if (item.type === "mention") {
      text(item.name, "mention name", 512);
      const requested = text(item.path, "mention path");
      if (!isAbsolute(requested) && !requested.startsWith("file:") && (!options.cwd || /^[a-z][a-z0-9+.-]*:/i.test(requested))) {
        throw new RpcError(-32602, "Select a local file or directory from the file search.");
      }
      const path = await files.existing(isAbsolute(requested) || requested.startsWith("file:") ? requested : resolve(options.cwd!, requested));
      const metadata = await files.metadata(path);
      if (!metadata.isDirectory && !metadata.isFile) throw new RpcError(-32602, "Select a regular file or directory.");
      parts.push(`<file_reference path="${escapeAttribute(path)}" />`);
    } else throw new RpcError(-32602, `Input type ${String(item.type)} is not supported. Use text, images, or an available skill or file.`);
  }
  if (!parts.some(part => part.trim()) && !images.length && !blocks.length) throw new RpcError(-32602, "Enter a message or attach an image.");
  const value = [...blocks, ...parts].join("\n\n");
  if (Buffer.byteLength(value) > 1024 * 1024) throw new RpcError(-32602, "This message and its selected skills exceed 1 MiB. Select fewer skills.");
  return { text: blocks.length ? value : parts.join("\n"), images };
}

/** Resolve the host's SDK, not a second Pi installation hidden in a dependency. */
export class PiRuntime {
  private sdk: JsonObject;
  private modelsRuntime: JsonObject;
  private config: RemoteConfig;
  private files: HostFiles;
  private levels: ThinkingLevels;
  private owners: SessionOwners;
  private constructor(sdk: JsonObject, modelsRuntime: JsonObject, config: RemoteConfig, files: HostFiles, levels: ThinkingLevels, owners: SessionOwners) {
    this.sdk = sdk; this.modelsRuntime = modelsRuntime; this.config = config; this.files = files; this.levels = levels; this.owners = owners;
  }
  static async create(config: RemoteConfig, files: HostFiles, sdkPath: string, owners = new SessionOwners(config.database)): Promise<PiRuntime> {
    const sdk = await import(pathToFileURL(sdkPath).href);
    if (!sdk.ModelRuntime || !sdk.createAgentSession) throw new Error("The installed Pi SDK is not supported. Update Pi and rebuild codex-ish.");
    const models = await sdk.ModelRuntime.create({ authPath: join(config.agentDir, "auth.json"),
      modelsPath: join(config.agentDir, "models.json"), modelsStorePath: join(config.home, "models-cache.json"), allowModelNetwork: false });
    return new PiRuntime(sdk, models, config, files, await hostThinkingLevels(sdkPath), owners);
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
    return modelCatalog(await this.modelsRuntime.getAvailable(), this.levels);
  }
  private resolveModel(name: string | undefined): JsonObject | undefined {
    if (!name) return undefined;
    return resolveModel(this.modelsRuntime.getModels(), name);
  }
  private async resources(cwd: string, discovery = false) {
    const settings = this.sdk.SettingsManager.create(cwd, this.config.agentDir, { projectTrusted: false });
    const loader = new this.sdk.DefaultResourceLoader({ cwd, agentDir: this.config.agentDir, settingsManager: settings,
      ...(discovery ? { noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } : {}) });
    // Honor saved local trust decisions. Remote cannot grant trust or answer a trust prompt.
    await loader.reload({ resolveProjectTrust: async () => new this.sdk.ProjectTrustStore(this.config.agentDir).get(cwd)
      ?? settings.getDefaultProjectTrust() === "always" });
    return { settings, loader };
  }
  async skills(cwd: string): Promise<RemoteSkill[]> {
    const { loader } = await this.resources(await this.files.directory(cwd), true);
    return resourceSkills(loader.getSkills().skills);
  }
  readonly createBackend: BackendFactory = async (record, params, event) => {
    let owner: SessionOwner | undefined;
    let dispose: (() => Promise<void>) | undefined;
    try {
    const cwd = await this.files.directory(record?.thread.cwd ?? params.cwd ?? this.config.userHome);
    const model = this.resolveModel(params.model ?? record?.thread.model);
    const sessionDir = join(this.config.home, "sessions");
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    if (record) {
      if (!record.sessionFile) throw new RpcError(-32600, "This conversation has no saved Pi session. Reopen it in Pi to continue.");
      if (record.owner === "live") await this.owners.checkLegacy();
      // Only an already registered local session can be reopened, never a caller-supplied path.
      const header = sessionHeader(record.sessionFile);
      if (header.id !== record.thread.id || await this.files.directory(header.cwd) !== cwd) throw new RpcError(-32600, "The saved Pi session does not match this conversation.");
      owner = this.owners.claim(record.thread.id, record.sessionFile, "worker");
    }
    const manager = record ? this.sdk.SessionManager.open(record.sessionFile, sessionDir)
      : this.sdk.SessionManager.create(cwd, sessionDir);
    owner ??= this.owners.claim(manager.getSessionId(), manager.getSessionFile(), "worker");
    if (record && manager.getSessionId() !== record.thread.id) throw new Error("Pi session identity changed.");
    const cursor = this.owners.cursor(owner);
    if (cursor === null) manager.resetLeaf();
    else if (cursor !== undefined) {
      if (!manager.getEntry(cursor)) throw new RpcError(-32600, "The saved Pi branch is unavailable. Reopen this conversation in Pi.");
      manager.branch(cursor);
    }
    if (!record && manager.getSessionFile()) {
      // Pi normally creates this file only after an assistant reply. Persist the new worker's
      // public session header now so an empty Remote conversation can survive a host restart.
      await writeFile(manager.getSessionFile(), JSON.stringify(manager.getHeader()) + "\n", { flag: "wx", mode: 0o600 });
    }
    const { settings, loader } = await this.resources(cwd);
    const effort = params.effort ?? record?.thread.reasoningEffort;
    if (model && params.effort != null) validateModelOptions({ effort: params.effort }, model, this.levels);
    const { session } = await this.sdk.createAgentSession({ cwd, agentDir: this.config.agentDir, sessionManager: manager,
      modelRuntime: this.modelsRuntime, model, settingsManager: settings, resourceLoader: loader,
      ...(effort ? { thinkingLevel: thinkingLevel(effort) } : {}) });
    dispose = async () => { session.clearQueue(); await session.abort(); session.dispose(); };
    if (!session.model) throw new RpcError(-32600, "Configure a model and login in Pi before starting a Remote conversation.");
    if (params.effort != null) validateModelOptions({ effort: params.effort }, session.model, this.levels);
    const info = { id: session.sessionId, cwd, sessionFile: session.sessionFile as string | undefined,
      model: `${session.model.provider}/${session.model.id}`, provider: session.model.provider, effort: session.thinkingLevel === "off" ? "none" : session.thinkingLevel };
    const sync = () => {
      info.model = `${session.model.provider}/${session.model.id}`; info.provider = session.model.provider;
      info.effort = reasoningEffort(session.thinkingLevel);
      event({ type: "remote_settings_changed", info: { ...info } });
    };
    let shutdown = false;
    const unsubscribe = session.subscribe((value: JsonObject) => {
      if (value.type === "thinking_level_changed" || value.type === "agent_settled") sync();
      event(value);
    });
    dispose = async () => {
      session.clearQueue(); await session.abort();
      if (!shutdown) { shutdown = true; await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
      unsubscribe(); session.dispose();
    };
    await session.bindExtensions({ mode: "rpc", onError: () => {} });
    let closed = false;
    const skills = async () => resourceSkills(session.resourceLoader.getSkills().skills);
    const prepareInput = (input: JsonObject[]) => piInput(input, this.files, { cwd, skills });
    const configure = async (options: ModelOptions) => {
      if (closed) throw new RpcError(-32600, "This Pi worker has stopped.");
      this.owners.assert(owner!);
      const nextModel = this.resolveModel(options.model) ?? session.model;
      validateModelOptions(options, nextModel, this.levels);
      if (!session.isIdle && (`${nextModel.provider}/${nextModel.id}` !== info.model || options.effort != null && options.effort !== info.effort)) {
        throw new RpcError(-32602, "Wait for Pi to finish before changing its model or thinking level.");
      }
      if (`${nextModel.provider}/${nextModel.id}` !== info.model) await session.setModel(nextModel, { persist: false });
      if (options.effort != null) session.setThinkingLevel(thinkingLevel(options.effort), { persist: false });
      sync();
    };
    return {
      info, skills, prepareInput, configure,
      messages: () => manager.getBranch().filter((entry: JsonObject) => entry.type === "message" && ["user", "assistant"].includes(entry.message?.role)).map((entry: JsonObject) => entry.message),
      send: async (input, options, prepared) => {
        if (closed) throw new RpcError(-32600, "This Pi worker has stopped.");
        const parsed = prepared ?? await prepareInput(input);
        await configure(options);
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
      close: async () => {
        if (closed) return; closed = true;
        // Do not release ownership until tools, queued work, and extensions have stopped.
        await dispose!(); this.owners.release(owner!, manager.getLeafId());
      },
    } satisfies Backend;
    } catch (error) {
      if (dispose) await dispose();
      if (owner) this.owners.release(owner);
      throw error;
    }
  };
}
