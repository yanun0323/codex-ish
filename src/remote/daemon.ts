import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { config as loadConfig, type RemoteConfig } from "./config.js";
import { ControlApi, type Credentials } from "./control-api.js";
import { HostFiles } from "./filesystem.js";
import { RemoteDiagnostics } from "./diagnostics.js";
import { Peer, sameSecret, type Endpoint } from "./ipc.js";
import { Relay } from "./relay.js";
import { PiRuntime, piInput } from "./runtime.js";
import { AppServer } from "./server.js";
import { Sessions, type Backend, type BackendFactory } from "./sessions.js";
import type { RemoteSkill } from "./skills.js";
import { State } from "./state.js";
import { object, RpcError, text, type JsonObject } from "./types.js";

export interface HostRuntime { credentials(): Promise<Credentials>; models(): Promise<JsonObject[]>; skills?(cwd: string): Promise<RemoteSkill[]>; createBackend: BackendFactory }
export function processIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function startHost(config: RemoteConfig, createRuntime: (files: HostFiles) => Promise<HostRuntime>) {
  if (process.platform === "win32") throw new Error("This Remote host currently requires macOS or Linux.");
  if (Buffer.byteLength(config.socket) > 100) throw new Error("Remote socket path is too long. Set PI_CODEX_ISH_REMOTE_HOME to a shorter private directory.");
  await mkdir(config.home, { recursive: true, mode: 0o700 }); await chmod(config.home, 0o700);
  const diagnostics = new RemoteDiagnostics(config);
  const state = new State(config.database);
  const instance = randomUUID();
  try {
    state.transaction(() => {
      const owner = state.get("host", "owner");
      if (owner && processIsRunning(owner.pid)) throw new Error("Remote is already starting or running.");
      state.set("host", "owner", { pid: process.pid, instance });
    });
  } catch (error) { state.close(); throw error; }
  const release = () => state.transaction(() => { if (state.get("host", "owner")?.instance === instance) state.delete("host", "owner"); });
  let runtime: HostRuntime;
  const files = new HostFiles(config.userHome, config.agentDir, config.home);
  try {
    for (const root of state.get<string[]>("host", "sharedRoots") ?? []) await files.addRoot(root).catch(() => {});
    runtime = await createRuntime(files);
  } catch (error) { release(); state.close(); throw error; }
  const endpoint: Endpoint = { version: 1, pid: process.pid, instance, token: randomBytes(32).toString("hex"),
    socket: config.socket, startedAt: new Date().toISOString() };
  const peers = new Set<Peer>();
  const sessions = new Sessions(state, runtime.createBackend, input => piInput(input, files));
  const api = new ControlApi(config, state, () => runtime.credentials());
  let relay: Relay;
  const status = () => ({ state: "running", pid: process.pid, startedAt: endpoint.startedAt,
    status: relay.status, serverName: config.hostName, installationId: state.installationId(),
    environmentId: api.enrollment?.environmentId ?? null, userHome: config.userHome,
    sharedRoots: [...files.roots], enabled: state.get<boolean>("host", "enabled") ?? false,
    liveSessions: sessions.loaded().filter(id => sessions.record(id).owner === "live").length,
    lastCompatibilityNotice: state.get("diagnostics", "compatibility") ?? null,
    lastUnsupportedMethod: state.get("diagnostics", "unsupported") ?? null,
    diagnosticLog: diagnostics.status() });
  const app = new AppServer({ config, files, state, sessions, models: () => runtime.models(), control: api,
    skills: cwd => runtime.skills?.(cwd) ?? Promise.resolve([]), remoteStatus: status, revoke: id => relay.revoke(id), diagnostics });
  relay = new Relay(api, async (stream, message) => {
    await api.identity();
    const client = app.connect(stream.key, stream.clientId, value => relay.wire.send(stream, value));
    await app.receive(client, message);
  }, stream => app.disconnect(stream.key), () => {
    diagnostics.event(`relay/${relay.status}`);
    for (const peer of peers) { try { peer.notify("host/status", status()); } catch { peer.close(); } }
    app.notify(undefined, "remoteControl/status/changed", status());
  }, error => diagnostics.failure("relay/error", error));
  let closing: Promise<void> | undefined;
  let requestShutdown: (() => void) | undefined;
  const stopped = new Promise<void>(resolve => { requestShutdown = resolve; });
  const server = createServer(socket => {
    const peer = new Peer(socket); peers.add(peer);
    let authenticated = false;
    let attached: Backend | undefined;
    const authTimeout = setTimeout(() => peer.close(), 3000);
    peer.onClose = () => {
      clearTimeout(authTimeout); peers.delete(peer);
      if (attached) sessions.detach(attached.info.id, attached);
    };
    peer.onNotification = (method, params) => {
      if (!authenticated || !attached || params.threadId !== attached.info.id) { peer.close(); return; }
      if (method === "bridge/event") sessions.event(attached.info.id, object(params.event));
    };
    peer.handler = async (method, raw) => {
      const params = object(raw);
      if (!authenticated) {
        if (method !== "hello" || typeof params.token !== "string" || !sameSecret(params.token, endpoint.token) || params.instance !== instance) {
          setImmediate(() => peer.close()); throw new RpcError(-32001, "Local Remote authentication failed.");
        }
        authenticated = true; clearTimeout(authTimeout); return { version: 1, instance };
      }
      switch (method) {
        case "status": return status();
        case "enable": await api.identity(); state.set("host", "enabled", true); relay.start(); return status();
        case "pair": {
          await api.identity(); state.set("host", "enabled", true); relay.start(); return api.pair();
        }
        case "pair/status": {
          const result = await api.pairingStatus(params);
          if (result.claimed) {
            let cursor: string | null = null;
            for (let page = 0; page < 10; page++) {
              const grants = await api.devices({ cursor, limit: 100 });
              relay.restoreGrantedClients(grants.data.map((client: JsonObject) => client.clientId));
              cursor = grants.nextCursor;
              if (!cursor) break;
            }
          }
          return result;
        }
        case "devices": return api.devices(params);
        case "revoke": {
          const id = text(params.clientId, "clientId"); await api.revoke(id); relay.revoke(id); return {};
        }
        case "shutdown": {
          state.set("host", "enabled", false);
          setTimeout(() => { void close().finally(() => requestShutdown?.()); }, 50);
          return {};
        }
        case "bridge/register": {
          if (attached) throw new RpcError(-32600, "This Pi process is already registered.");
          const info = object(params.info);
          text(info.id, "session identifier", 512); text(info.cwd, "working directory");
          text(info.model, "model"); text(info.provider, "provider"); text(info.effort, "reasoning effort", 64);
          if (!Array.isArray(params.messages)) throw new RpcError(-32602, "Invalid session snapshot.");
          // Only an authenticated LOCAL Pi process may add a root outside the home directory.
          await files.addRoot(info.cwd);
          state.set("host", "sharedRoots", [...files.roots]);
          const cwd = await files.directory(info.cwd);
          const skills = async (): Promise<RemoteSkill[]> => (await peer.call("bridge/skills", { threadId: info.id })).skills;
          const prepareInput = (input: JsonObject[]) => piInput(input, files, { cwd, skills });
          const backend: Backend = {
            info: { id: info.id, cwd, model: info.model, provider: info.provider, effort: info.effort,
              busy: info.busy === true, name: info.name, sessionFile: info.sessionFile, models: info.models },
            skills, prepareInput,
            configure: async options => {
              const result = await peer.call("bridge/settings", { threadId: info.id, ...options });
              sessions.settingsChanged(info.id, object(result.info) as any);
              if (Array.isArray(result.info.models)) backend.info.models = result.info.models;
            },
            send: async (input, options, prepared) => {
              const parsed = prepared ?? await prepareInput(input);
              const result = await peer.call("bridge/input", { threadId: info.id, text: parsed.text, images: parsed.images, ...options });
              if (result.info) {
                backend.info.model = text(result.info.model, "model");
                backend.info.provider = text(result.info.provider, "provider");
                backend.info.effort = text(result.info.effort, "effort");
              }
            },
            abort: async () => { await peer.call("bridge/abort", { threadId: info.id }); },
            close: async () => {}, // Stopping Remote must not kill the user's terminal session.
          };
          sessions.attach(backend, params.messages); attached = backend;
          return { threadId: info.id };
        }
      }
      throw new RpcError(-32601, "Unknown local Remote method.");
    };
  });
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      await relay.stop();
      for (const id of [...app.clients.keys()]) app.disconnect(id);
      for (const peer of peers) peer.close();
      await sessions.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      try {
        const saved = JSON.parse(await readFile(config.endpoint, "utf8"));
        if (saved.instance === instance) { await rm(config.endpoint, { force: true }); await rm(config.socket, { force: true }); }
      } catch { /* No endpoint was published, or it was already removed. */ }
      release(); state.close(); diagnostics.event("host/stopped"); requestShutdown?.();
    })();
    return closing;
  }
  try {
    await rm(config.socket, { force: true }); // Protected by the database's live-process ownership claim.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject); server.listen(config.socket, () => { server.off("error", reject); resolve(); });
    });
    server.on("error", error => { diagnostics.failure("host/socket_error", error); void close(); });
    await chmod(config.socket, 0o600);
    const temporary = `${config.endpoint}.${instance}.tmp`;
    await writeFile(temporary, JSON.stringify(endpoint), { mode: 0o600 }); await rename(temporary, config.endpoint);
    diagnostics.event("host/started");
    if (state.get<boolean>("host", "enabled")) relay.start();
  } catch (error) { await close(); throw error; }
  return { close, stopped, status, app, relay, sessions, files, state };
}

async function main() {
  process.env.PI_CODEX_ISH_WORKER = "1";
  const config = loadConfig();
  const sdk = process.env.PI_CODEX_ISH_SDK;
  if (!sdk) throw new Error("Start Remote from Pi with /remote start.");
  const host = await startHost(config, files => PiRuntime.create(config, files, sdk));
  const stop = () => { void host.close(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  await host.stopped;
  process.exit(0);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    try { new RemoteDiagnostics(loadConfig()).failure("host/startup_error", error); } catch { /* Invalid configuration. */ }
    console.error("Remote host could not start. Check the private Remote diagnostic log, Pi version, and build."); process.exit(1);
  });
}
