import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, renameSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { RemoteConfig } from "./config.js";
import { RpcError, type JsonObject, type RpcMessage } from "./types.js";

// Temporary diagnostics: disable with PI_CODEX_ISH_REMOTE_DEBUG=0 before starting the host.
// Never serialize request/response bodies, credentials, arbitrary exception messages, or stacks verbatim.
const MAX_BYTES = 5 * 1024 * 1024;
const keys = new Set(("threadId turnId expectedTurnId clientUserMessageId clientInfo name version capabilities experimentalApi " +
  "optOutNotificationMethods cwd path input type text text_elements textElements content items turns thread turn data " +
  "id status error code message summary model modelProvider effort reasoningEffort approvalPolicy sandbox sandboxPolicy " +
  "permissions config features developerInstructions baseInstructions personality includeTurns excludeTurns initialTurnsPage " +
  "itemsView limit cursor nextCursor backwardsCursor sortKey sortDirection history modelProviders sourceKinds archived " +
  "parentThreadId projectId sectionId searchTerm ephemeral threadSource serviceTier serviceName collaborationMode mode settings " +
  "reasoning_effort developer_instructions dynamicTools runtimeWorkspaceRoots allowProviderModelFallback experimentalRawEvents " +
  "tool arguments contentItems success command commandActions aggregatedOutput exitCode durationMs activeFlags " +
  "goal includeLayers layers origins hooks errors warnings cwds enablement recursive dataBase64 entries isDirectory isFile " +
  "authToken accessToken token authorization headers url images image imageUrl fileId detail delta result params method " +
  "outputSchema metadata roots title disabledPluginIds additionalContext additionalPermissions permissionProfile " +
  "threadSettings supportedReasoningEfforts defaultReasoningEffort isDefault displayName model_provider model_reasoning_effort " +
  "query sessionId forceReload skills enabled scope match_type file_name files score indices cancellationToken").split(" "));
const types = new Set(["text", "image", "localImage", "audio", "localAudio", "skill", "mention", "userMessage", "agentMessage", "reasoning",
  "commandExecution", "dynamicToolCall", "fileChange", "mcpToolCall", "idle", "active", "notLoaded", "dangerFullAccess", "readOnly"]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const identifier = (value: unknown): unknown => typeof value === "number" ? value : typeof value !== "string" ? null :
  /^(?:thread\/resume:)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) ? value : `hash:${hash(value)}`;
const methodName = (value: unknown) => typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9]*(?:\/[a-zA-Z][a-zA-Z0-9]*){0,5}$/.test(value) && value.length <= 128 ? value : "[invalid method]";

/** A bounded structural sample, not a data dump. Unknown keys and all string values are omitted. */
export function diagnosticShape(value: unknown): unknown {
  let remaining = 180;
  const visit = (value: any, depth: number, key = ""): any => {
    if (--remaining < 0 || depth > 7) return "[omitted]";
    if (value == null) return null;
    if (typeof value === "string") return key === "type" && types.has(value) ? value : { type: "string", length: value.length };
    if (typeof value === "boolean") return value;
    if (typeof value !== "object") return typeof value;
    if (Array.isArray(value)) return { type: "array", length: value.length, sample: value.slice(0, 2).map(item => visit(item, depth + 1)) };
    const result: JsonObject = {};
    let omitted = 0;
    for (const name of Object.keys(value)) {
      if (!keys.has(name) || Object.keys(result).length >= 24 || remaining <= 0) { omitted++; continue; }
      result[name] = visit(value[name], depth + 1, name);
    }
    if (omitted) result.omittedFields = omitted;
    return result;
  };
  return visit(value, 0);
}

/** Keep useful local failure information without retaining provider bodies or user text. */
export function diagnosticError(error: unknown, depth = 0): JsonObject {
  if (!(error instanceof Error)) return { name: "NonError", message: "Non-Error exception; value omitted." };
  const raw = error as Error & { code?: unknown; status?: unknown; cause?: unknown };
  const name = ["Error", "RpcError", "TypeError", "RangeError", "SyntaxError", "AbortError"].includes(error.constructor.name) ? error.constructor.name : "Error";
  const code = typeof raw.code === "number" ? raw.code : typeof raw.code === "string" && /^(?:E[A-Z0-9_]{1,32}|ERR_[A-Z0-9_]{1,60})$/.test(raw.code) ? raw.code : undefined;
  let message = "Exception message omitted; use its type, code, and source location.";
  if (error instanceof RpcError) {
    // RPC messages are host-authored. The unsupported-method error is the one that echoes arbitrary peer text.
    message = error.message.startsWith("This Pi host does not support ") ? "This Pi host does not support the requested method." :
      error.message.startsWith("Input type ") ? "Input type is not supported. Use text, images, skills, or file mentions." :
      error.message.replace(/Bearer\s+\S+|\b(?:sk-|eyJ)[A-Za-z0-9_.-]+/gi, "[redacted]")
        .replace(/(?:access[_-]?token|refresh[_-]?token|authorization|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "[credential]")
        .replace(/(?:https?|file):\/\/\S+/gi, "[url]")
        .replace(/(["'`]).*?\1/g, "[quoted value]").slice(0, 512);
  } else if (/^Cannot read properties of (?:undefined|null) \(reading '[\w$]+'\)$/.test(error.message) ||
      /^Remote service returned HTTP \d{3}\.$/.test(error.message) ||
      /^(?:Invalid remote (?:client|stream|envelope|sequence|cursor|message|chunk|chunk sequence)|Oversized remote frame|Unknown remote envelope|Out-of-order remote chunk|Remote message size does not match|Expected a text frame|Remote heartbeat timed out|Remote incoming buffer exceeded|Remote authentication check failed)\.$/.test(error.message)) {
    message = error.message;
  }
  // Only retain source filenames and line/column numbers, not the message, paths, or function arguments.
  const frames = (error.stack ?? "").split("\n").slice(1).flatMap(line => {
    const match = /(?:^|[/\\])([\w.-]+\.(?:[cm]?js|ts)):(\d+):(\d+)\)?$/.exec(line);
    return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
  }).slice(0, 8);
  return { name, code, message, messageHash: hash(error.message), frames,
    ...(typeof raw.status === "number" ? { httpStatus: raw.status } : {}),
    ...(raw.cause != null && depth < 2 ? { cause: diagnosticError(raw.cause, depth + 1) } : {}) };
}

export class RemoteDiagnostics {
  readonly path: string;
  readonly enabled: boolean;
  private writeError: string | null = null;
  private config: Pick<RemoteConfig, "home" | "userHome" | "agentDir">;
  private maxBytes: number;
  constructor(config: Pick<RemoteConfig, "home" | "userHome" | "agentDir">,
    enabled = process.env.PI_CODEX_ISH_REMOTE_DEBUG !== "0", maxBytes = MAX_BYTES) {
    this.config = config; this.maxBytes = maxBytes;
    this.path = join(config.home, "debug-remote.jsonl"); this.enabled = enabled;
  }
  status() { return { enabled: this.enabled, path: this.enabled ? this.path : null, writeError: this.writeError }; }
  private context(message: RpcMessage, clientId: string) {
    const params = message.params;
    const path = typeof params?.path === "string" ? params.path : undefined;
    let pathInfo: JsonObject | undefined;
    if (path) {
      const roots: [string, string][] = [["remote", this.config.home], ["agent", this.config.agentDir], ["codex", join(this.config.userHome, ".codex")],
        ["ssh", join(this.config.userHome, ".ssh")], ["home", this.config.userHome]];
      const location = roots.find(([, root]) => { const child = relative(root, path); return !child || child !== ".." && !child.startsWith(".." + sep) && !child.startsWith(sep); })?.[0] ?? "other";
      pathInfo = { location, hash: hash(path) };
    }
    return { method: methodName(message.method), requestId: identifier(message.id), client: `hash:${hash(clientId)}`,
      ...(params?.threadId != null ? { threadId: identifier(params.threadId) } : {}), ...(pathInfo ? { path: pathInfo } : {}) };
  }
  request(message: RpcMessage, clientId: string): void {
    if (this.enabled) this.write("request", { ...this.context(message, clientId), params: diagnosticShape(message.params) });
  }
  response(message: RpcMessage, clientId: string, response: RpcMessage, started: number, replayed: boolean): void {
    if (this.enabled) this.write("response", { ...this.context(message, clientId), durationMs: Math.max(0, Date.now() - started), replayed,
      outcome: response.error ? "error" : "ok", ...(response.error ? { errorCode: response.error.code,
        errorMessage: diagnosticError(new RpcError(response.error.code, response.error.message)).message } : { result: diagnosticShape(response.result) }) });
  }
  failure(stage: string, error: unknown, message?: RpcMessage, clientId = "host"): void {
    if (this.enabled) this.write(stage, { ...(message ? this.context(message, clientId) : {}), error: diagnosticError(error) });
  }
  event(event: "host/started" | "host/stopped" | "relay/disabled" | "relay/connecting" | "relay/connected" | "relay/errored"): void {
    if (this.enabled) this.write(event, {});
  }
  private write(event: string, data: JsonObject): void {
    let fd: number | undefined;
    try {
      mkdirSync(this.config.home, { recursive: true, mode: 0o700 }); chmodSync(this.config.home, 0o700);
      const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...data }) + "\n";
      const open = () => {
        const file = openSync(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        try {
          const info = fstatSync(file);
          if (!info.isFile() || info.nlink !== 1) throw new Error("Unsafe diagnostic file.");
          fchmodSync(file, 0o600); return file;
        } catch (error) { closeSync(file); throw error; }
      };
      fd = open();
      if (fstatSync(fd).size + Buffer.byteLength(line) > this.maxBytes) {
        closeSync(fd); fd = undefined;
        renameSync(this.path, this.path + ".1"); fd = open();
      }
      // Each record is bounded too. A logging failure must never change the RPC result.
      if (Buffer.byteLength(line) <= this.maxBytes) appendFileSync(fd, line, "utf8");
      this.writeError = null;
    } catch (error) {
      this.writeError = typeof (error as NodeJS.ErrnoException).code === "string" ? (error as NodeJS.ErrnoException).code! : "WRITE_FAILED";
    } finally { if (fd !== undefined) { try { closeSync(fd); } catch { this.writeError = "CLOSE_FAILED"; } } }
  }
}
