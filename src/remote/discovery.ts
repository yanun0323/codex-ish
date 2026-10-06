import { HostFiles } from "./filesystem.js";
import { object, RpcError, text, type JsonObject } from "./types.js";

// Observed iOS transport wrapper. These strings are compared, NEVER evaluated.
const wrapper = ["/bin/sh", "-c", "printf '\\0'; exec \"$@\"", "codex-read-only", "/bin/sh", "-lc"];
const fields = new Set(["command", "cwd", "processId", "timeoutMs", "outputBytesCap", "env", "streamStdoutStderr",
  "sandboxPolicy", "tty", "streamStdin", "disableTimeout", "disableOutputCap", "size"]);
const inertEnv = new Set(["LANG", "LC_ALL", "LC_CTYPE", "TERM", "NO_COLOR", "CLICOLOR", "CLICOLOR_FORCE", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT"]);
const MAX_OUTPUT = 1024 * 1024;

/** Read-only browser queries, implemented with HostFiles rather than a shell or agent. */
export class DirectoryDiscovery {
  private active = new Map<string | symbol, AbortController>();
  private closed = false;
  private files: HostFiles;
  private notify: (params: JsonObject) => void;
  constructor(files: HostFiles, notify: (params: JsonObject) => void) { this.files = files; this.notify = notify; }
  async run(params: JsonObject): Promise<JsonObject | undefined> {
    const argv = params.command;
    if (!Array.isArray(argv) || argv.length !== 7 || !wrapper.every((part, i) => argv[i] === part) ||
        argv[6] !== 'cd "$HOME" && pwd -P') return undefined;
    // This exception is limited to a query we implement ourselves. Pi conversations
    // and unrecognized commands still use their original execution-policy checks.
    if (Object.keys(params).some(key => !fields.has(key))) throw new RpcError(-32602, "Unsupported directory query options.");
    const policy = object(params.sandboxPolicy);
    if (policy.type !== "readOnly" || policy.networkAccess !== false || Object.keys(policy).some(key => !["type", "networkAccess"].includes(key))) {
      throw new RpcError(-32602, "Use the read-only, offline directory query.");
    }
    for (const key of ["tty", "streamStdin", "disableTimeout", "disableOutputCap"]) {
      if (params[key] != null && params[key] !== false) throw new RpcError(-32602, "Directory queries do not support terminal input or unlimited output.");
    }
    if (params.size != null || params.streamStdoutStderr != null && typeof params.streamStdoutStderr !== "boolean") {
      throw new RpcError(-32602, "Invalid directory query stream options.");
    }
    for (const [key, value] of Object.entries(object(params.env ?? {}))) {
      // iOS explicitly clears shell startup hooks. Clearing them is safe;
      // supplying a startup file is still rejected. No shell is started here.
      if (value === null && (key === "BASH_ENV" || key === "ENV")) continue;
      // These variables do not affect this native query. In particular, HOME,
      // PATH and shell startup hooks cannot redirect it or execute anything.
      if (!inertEnv.has(key) || value !== null && (typeof value !== "string" || value.length > 128 || /[\x00-\x1f]/.test(value))) {
        throw new RpcError(-32602, "Directory queries cannot override the host environment.");
      }
    }
    const cap = params.outputBytesCap ?? MAX_OUTPUT, timeout = params.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(cap) || cap < 0 || cap > MAX_OUTPUT || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 60_000) {
      throw new RpcError(-32602, "Use an output limit up to 1 MiB and a timeout up to 60 seconds.");
    }
    const processId = params.processId == null && !params.streamStdoutStderr ? undefined : text(params.processId, "processId", 512);
    if (this.closed || this.active.size >= 8) throw new RpcError(-32600, "Wait for the current directory queries to finish.");
    const key = processId ?? Symbol();
    if (this.active.has(key)) throw new RpcError(-32602, "This directory query identifier is already in use.");
    const controller = new AbortController(); this.active.set(key, controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    const cancelled = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () =>
      reject(new RpcError(-32600, "Directory query stopped. Try browsing again.")), { once: true }));
    try {
      const query = async () => {
        // '/' is only the transport's starting cwd. We never list it or add it
        // to the shared roots when answering this exact HOME probe.
        if (params.cwd != null && params.cwd !== "/") await this.files.directory(params.cwd);
        return Buffer.from("\0" + await this.files.directory(this.files.home) + "\n");
      };
      const bytes = await Promise.race([query(), cancelled]);
      const output = bytes.subarray(0, cap);
      if (params.streamStdoutStderr) {
        if (output.length || bytes.length > cap) this.notify({ processId, stream: "stdout", deltaBase64: output.toString("base64"), capReached: bytes.length > cap });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: output.toString("utf8"), stderr: "" };
    } finally { clearTimeout(timer); this.active.delete(key); }
  }
  close(): void { this.closed = true; for (const controller of this.active.values()) controller.abort(); }
}
