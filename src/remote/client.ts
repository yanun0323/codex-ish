import { spawn, execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { config, type RemoteConfig } from "./config.js";
import { connectLocal, localCall, type Peer } from "./ipc.js";
import { delay, errorMessage, RpcError, type JsonObject } from "./types.js";

const exec = promisify(execFile);
function hostSdk(): string {
  if (process.env.PI_CODEX_ISH_SDK) return process.env.PI_CODEX_ISH_SDK;
  // The host CLI takes priority over any development-time peer installation in this package.
  if (process.argv[1]) {
    try {
      const directory = dirname(realpathSync(process.argv[1]));
      const candidate = join(directory, "index.js");
      if (existsSync(candidate) && directory.includes("pi-coding-agent")) return candidate;
    } catch { /* Fall through to normal package resolution. */ }
  }
  return createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent");
}
async function legacyPid(cfg: RemoteConfig): Promise<number | undefined> {
  try {
    const home = process.env.PI_CODEX_APP_SERVER_HOME ?? join(cfg.agentDir, "codex-app-server");
    const endpoint = JSON.parse(await readFile(join(home, "endpoint.json"), "utf8"));
    if (!Number.isInteger(endpoint.pid) || endpoint.pid <= 0) return;
    const { stdout } = await exec("ps", ["-p", String(endpoint.pid), "-o", "command="], { timeout: 2000 });
    return /[/\\]pi-codex-app-server[/\\]dist[/\\]cli\.js\b.*\bdaemon\b/.test(stdout) ? endpoint.pid : undefined;
  } catch { return undefined; }
}
export async function ensureDaemon(cfg: RemoteConfig): Promise<void> {
  try { await localCall(cfg, "status"); return; } catch { /* Start one host, not one host per Pi session. */ }
  const oldPid = await legacyPid(cfg);
  if (oldPid) throw new RpcError(-32600, `The previous Remote server is still running (PID ${oldPid}). Run /remote stop, then /remote pair to switch hosts.`);
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "daemon.js")], {
    detached: true, stdio: "ignore", cwd: cfg.userHome,
    env: { ...process.env, PI_CODEX_ISH_SDK: hostSdk(), PI_CODEX_ISH_WORKER: "1" },
  });
  let failure: Error | undefined;
  child.once("error", error => { failure = error; }); child.unref();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (failure) throw new Error("Remote could not start. Run npm run build and check your Pi installation.");
    try { await localCall(cfg, "status"); return; } catch { /* A concurrent starter may hold the startup lease. */ }
    await delay(100);
  }
  throw new Error("Remote did not start within 60 seconds. Run npm run build and check your Pi installation.");
}
async function stopDaemon(cfg: RemoteConfig): Promise<void> {
  let previousPid: number | undefined;
  try { await localCall(cfg, "shutdown"); }
  catch (error) {
    if (!["ENOENT", "ECONNREFUSED", "ENOTSOCK"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    previousPid = await legacyPid(cfg);
    if (!previousPid) return;
    // Only the explicit stop command terminates the verified, previous package's process.
    process.kill(previousPid, "SIGTERM");
  }
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    if (previousPid) { if (await legacyPid(cfg) !== previousPid) return; }
    else { try { await localCall(cfg, "status"); } catch { return; } }
    await delay(100);
  }
  throw new Error("Remote is still stopping. Wait and check /remote status before restarting it.");
}
function visibleSnapshot(ctx: any): JsonObject[] {
  return ctx.sessionManager.getBranch().filter((entry: JsonObject) => entry.type === "message" && ["user", "assistant"].includes(entry.message?.role))
    .map((entry: JsonObject) => {
      const message = entry.message;
      return { role: message.role, timestamp: message.timestamp, stopReason: message.stopReason,
        content: typeof message.content === "string" ? message.content : message.content.filter((part: JsonObject) => ["text", "thinking"].includes(part.type))
          .map((part: JsonObject) => part.type === "text" ? { type: "text", text: part.text } : { type: "thinking", thinking: part.thinking ?? "" }) };
    });
}

// This boundary uses the host's injected extension API; the standalone daemon does not import Pi peers.
export interface RemotePairing { pairingCode: string; manualPairingCode: string | null; environmentId: string; expiresAt: string }
export function registerRemoteControl(pi: any, showPairing: (ctx: any, pairing: RemotePairing) => Promise<void>) {
  if (process.env.PI_CODEX_ISH_WORKER === "1") return { footerText: () => "remote worker" };
  const cfg = config();
  let state = "disabled";
  let peer: Peer | undefined;
  let ctx: any;
  let generation = 0;
  let reconnect: AbortController | undefined;
  let registered = false;
  let lastBridgeError: string | undefined;
  let capturing = false;
  let pendingEvents: JsonObject[] = [];
  let pendingBytes = 0;
  const currentId = () => ctx?.sessionManager.getSessionId();
  const update = (status: JsonObject) => { state = status.status ?? "disabled"; ctx?.ui.requestRender?.(); };
  const stopBridge = () => { generation++; registered = false; capturing = false; pendingEvents = []; pendingBytes = 0; reconnect?.abort(); peer?.close(); peer = undefined; };

  const startBridge = async (context: any, autoStart: boolean) => {
    stopBridge(); ctx = context;
    const epoch = generation;
    const controller = reconnect = new AbortController();
    if (process.env.PI_CODEX_REMOTE_CONTROL === "0") { state = "disabled"; return; }
    if (autoStart) {
      try { await ensureDaemon(cfg); }
      catch (error) { if (epoch === generation) { state = "errored"; context.ui.notify(errorMessage(error), "warning"); } return; }
    }
    void (async () => {
      while (!controller.signal.aborted && epoch === generation) {
        let connection: Peer | undefined;
        try {
          const threadId = currentId();
          connection = await connectLocal(cfg, async (method, params) => {
            if (epoch !== generation || params.threadId !== currentId() || params.threadId !== threadId) throw new RpcError(-32600, "Pi switched conversations. Resume the new conversation before sending a message.");
            if (method === "bridge/abort") { ctx.abort(); return {}; }
            if (method !== "bridge/input") throw new RpcError(-32601, "Unknown Pi bridge request.");
            if (params.model && params.model !== `${ctx.model?.provider}/${ctx.model?.id}`) {
              if (!ctx.isIdle()) throw new RpcError(-32600, "Wait for Pi to finish before changing its model.");
              const model = ctx.modelRegistry.getAvailable().find((value: JsonObject) => `${value.provider}/${value.id}` === params.model || value.id === params.model);
              if (!model) throw new RpcError(-32602, "Model not found in this Pi session.");
              if (!await pi.setModel(model)) throw new RpcError(-32602, "Pi could not select this model. Check its login in Pi.");
            }
            if (params.effort && ctx.isIdle()) pi.setThinkingLevel(params.effort === "none" ? "off" : params.effort);
            const content = [{ type: "text", text: params.text }, ...(params.images ?? [])];
            // Acknowledgement is not task completion; agent_settled is forwarded separately.
            const sent = pi.sendUserMessage(content, { deliverAs: params.steer ? "steer" : "followUp", expandPromptTemplates: false });
            void Promise.resolve(sent).catch(() => {
              try { connection?.notify("bridge/event", { threadId, event: { type: "remote_input_error" } }); } catch { /* Already disconnected. */ }
            });
            return { accepted: true, info: { model: `${ctx.model?.provider ?? "pi"}/${ctx.model?.id ?? "unconfigured"}`,
              provider: ctx.model?.provider ?? "pi", effort: ctx.thinkingLevel === "off" ? "none" : ctx.thinkingLevel ?? "medium" } };
          });
          if (controller.signal.aborted || epoch !== generation) { connection.close(); return; }
          peer = connection;
          connection.onNotification = (method, params) => { if (method === "host/status") update(params); };
          capturing = true; pendingEvents = []; pendingBytes = 0;
          const snapshot = visibleSnapshot(context);
          if (Buffer.byteLength(JSON.stringify(snapshot)) > 20 * 1024 * 1024) throw new Error("This conversation is too large to attach to Remote. Start a new Pi conversation.");
          await connection.call("bridge/register", { info: { id: threadId, cwd: context.cwd,
            model: `${context.model?.provider ?? "pi"}/${context.model?.id ?? "unconfigured"}`,
            provider: context.model?.provider ?? "pi", effort: context.thinkingLevel === "off" ? "none" : context.thinkingLevel ?? "medium",
            sessionFile: context.sessionManager.getSessionFile(), name: context.sessionManager.getSessionName(), busy: !context.isIdle() }, messages: snapshot });
          if (controller.signal.aborted || epoch !== generation) { connection.close(); return; }
          registered = true; lastBridgeError = undefined; capturing = false;
          for (const event of pendingEvents) connection.notify("bridge/event", { threadId, event });
          pendingEvents = []; pendingBytes = 0;
          update(await connection.call("status"));
          await connection.closed.promise;
        } catch (error) { if (epoch === generation) { state = "disabled"; lastBridgeError = errorMessage(error); } }
        finally {
          connection?.close(); if (peer === connection) peer = undefined;
          if (epoch === generation) { registered = false; capturing = false; pendingEvents = []; pendingBytes = 0; }
        }
        try { await delay(2000, controller.signal); } catch { return; }
      }
    })();
  };
  pi.on("session_start", async (_event: unknown, context: any) => {
    await startBridge(context, process.env.PI_CODEX_APP_SERVER_AUTOSTART !== "0");
  });
  pi.on("session_shutdown", () => stopBridge());
  pi.on("session_tree", async (_event: unknown, context: any) => { await startBridge(context, false); });
  for (const name of ["agent_start", "agent_settled", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "session_info_changed"]) {
    pi.on(name, (event: JsonObject, context: any) => {
      if (!peer || (!registered && !capturing) || context.sessionManager.getSessionId() !== currentId()) return;
      ctx = context;
      // Stream only the protocol-facing event, not SDK cumulative snapshots or provider signatures.
      let payload = event;
      if (name === "message_update") {
        const update = event.assistantMessageEvent;
        if (!["text_delta", "thinking_delta"].includes(update?.type)) return;
        payload = { type: name, assistantMessageEvent: { type: update.type, contentIndex: update.contentIndex, delta: update.delta } };
      } else if (name === "message_start" || name === "message_end") {
        if (!["user", "assistant"].includes(event.message?.role)) return;
        const message = event.message;
        payload = { type: name, message: { role: message.role, stopReason: message.stopReason,
          content: typeof message.content === "string" ? message.content : message.content.filter((part: JsonObject) => ["text", "thinking"].includes(part.type))
            .map((part: JsonObject) => part.type === "text" ? { type: "text", text: part.text } : { type: "thinking", thinking: part.thinking ?? "" }) } };
      } else if (name === "tool_execution_end" || name === "tool_execution_update") {
        const result = event.result ?? event.partialResult ?? {};
        const clean = { content: (result.content ?? []).filter((part: JsonObject) => part.type === "text").map((part: JsonObject) => ({ type: "text", text: String(part.text).slice(0, 256 * 1024) })),
          details: { exitCode: result.details?.exitCode } };
        payload = { type: name, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError,
          ...(name === "tool_execution_end" ? { result: clean } : { partialResult: clean }) };
      }
      try {
        if (registered) peer.notify("bridge/event", { threadId: currentId(), event: payload });
        else {
          pendingBytes += Buffer.byteLength(JSON.stringify(payload));
          if (pendingBytes > 4 * 1024 * 1024) { peer.close(); return; }
          pendingEvents.push(payload);
        }
      } catch { peer.close(); }
    });
  }
  const command = {
    description: "Connect Codex Apps to Pi conversations",
    getArgumentCompletions: (prefix: string) => ["status", "start", "stop", "pair", "devices", "revoke"]
      .filter(value => value.startsWith(prefix.trim())).map(value => ({ value, label: value })),
    handler: async (raw: string, context: any) => {
      const [action = "status", clientId, ...extra] = raw.trim().split(/\s+/).filter(Boolean);
      if (extra.length || !["status", "start", "stop", "pair", "devices", "revoke"].includes(action) || action !== "revoke" && clientId) {
        context.ui.notify("Usage: /remote <status|start|stop|pair|devices|revoke CLIENT_ID>", "warning"); return;
      }
      try {
        if (action === "stop") {
          stopBridge(); await stopDaemon(cfg); state = "disabled";
          context.ui.notify("Remote stopped. Paired devices remain authorized; terminal Pi sessions continue.", "info"); return;
        }
        if (action === "start" || action === "pair") {
          if (process.env.PI_CODEX_REMOTE_CONTROL === "0") throw new Error("Remote is disabled by PI_CODEX_REMOTE_CONTROL=0.");
          if (action === "pair" && context.hasUI && !await context.ui.confirm("Pair Codex Remote?", "Paired devices can browse your home directory, create projects, and run Pi tools with your account's local permissions. Pair only devices you trust.")) return;
          await ensureDaemon(cfg);
          await startBridge(context, false);
          if (action === "start") {
            update(await localCall(cfg, "enable")); context.ui.notify("Remote is connecting. Run /remote status to check the connection.", "info"); return;
          }
          const pairing = await localCall<RemotePairing>(cfg, "pair");
          await showPairing(context, pairing);
          const deadline = Math.min(Date.now() + 120_000, Date.parse(pairing.expiresAt));
          while (Date.now() < deadline) {
            const claimed = await localCall(cfg, "pair/status", { pairingCode: pairing.pairingCode });
            if (claimed.claimed) { context.ui.notify("Device paired. Connect both Codex Apps to this host and open the same conversation to share it.", "info"); return; }
            if (pairing.manualPairingCode && (await localCall(cfg, "pair/status", { manualPairingCode: pairing.manualPairingCode })).claimed) {
              context.ui.notify("Device paired. Both Codex Apps can send messages to the same conversation.", "info"); return;
            }
            await delay(1000);
          }
          context.ui.notify("Pairing was not confirmed. Run /remote pair to create another code.", "warning"); return;
        }
        if (action === "devices") {
          const devices = []; let cursor: string | null = null;
          do { const result: JsonObject = await localCall(cfg, "devices", { cursor }); devices.push(...result.data); cursor = result.nextCursor; } while (cursor && devices.length < 1000);
          context.ui.notify(devices.length ? devices.map(device => `${device.displayName ?? device.deviceType ?? "Device"}\n  ${device.clientId}`).join("\n\n") : "No paired devices. Run /remote pair to add one.", "info"); return;
        }
        if (action === "revoke") {
          if (!clientId) throw new Error("Usage: /remote revoke CLIENT_ID");
          await localCall(cfg, "revoke", { clientId }); context.ui.notify(`Revoked device ${clientId}.`, "info"); return;
        }
        let status: JsonObject;
        try { status = await localCall(cfg, "status"); } catch { state = "disabled"; context.ui.notify("Remote is stopped. Run /remote start or /remote pair.", "info"); return; }
        update(status);
        context.ui.notify([`Remote: ${status.status}`, `Host: ${status.serverName}`, `Home: ${status.userHome}`,
          `Environment: ${status.environmentId ?? "not paired"}`, `This Pi session: ${registered ? "shared" : "not attached; run /remote start here"}`,
          ...(!registered && lastBridgeError ? [`Pi connection: ${lastBridgeError}`] : []),
          ...(status.lastCompatibilityNotice ? [`App compatibility: ${status.lastCompatibilityNotice.summary}`] : []),
          ...(status.lastUnsupportedMethod ? [`Unsupported App request: ${status.lastUnsupportedMethod.method}`] : [])].join("\n"), "info");
      } catch (error) { context.ui.notify(errorMessage(error), "warning"); }
    },
  };
  pi.registerCommand("remote", command); pi.registerCommand("codex-server", command);
  return { footerText: () => state === "connected" ? "remote on" : state === "connecting" ? "remote …" : state === "errored" ? "remote error" : "remote off" };
}
