import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { openSync, closeSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { State } from "./state.js";
import { RpcError } from "./types.js";

export interface SessionOwner {
  id: string; file?: string; pid: number; token: string; kind: "live" | "worker";
}
interface SavedOwner extends Omit<SessionOwner, "kind"> { kind: SessionOwner["kind"] | "released"; leafId?: string | null; stamp?: string }
const exec = promisify(execFile);
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export function sessionPath(file: string): string {
  try { return realpathSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolve(realpathSync(dirname(file)), file.slice(file.lastIndexOf("/") + 1));
  }
}
function stamp(file: string): string | undefined {
  try { const s = statSync(file, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
/** Validate before SessionManager.open(), which can create or migrate the file. */
export function sessionHeader(file: string): { id: string; cwd: string } {
  const fd = openSync(file, "r");
  try {
    if (!statSync(file).isFile()) throw new Error("Not a session file.");
    const bytes = Buffer.alloc(64 * 1024); const size = readSync(fd, bytes, 0, bytes.length, 0);
    const newline = bytes.indexOf(10, 0); if (newline < 0 || newline >= size) throw new Error("Invalid session header.");
    const header = JSON.parse(bytes.toString("utf8", 0, newline));
    if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") throw new Error("Invalid session header.");
    return header;
  } finally { closeSync(fd); }
}
/** Read the final entry without loading the whole transcript. */
export function sessionTip(file: string): string | undefined {
  let fd: number;
  try { fd = openSync(file, "r"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try {
    const size = statSync(file).size;
    for (let length = Math.min(size, 65536);; length = Math.min(size, length * 2)) {
      if (length > 64 * 1024 * 1024) throw new RpcError(-32600, "The last Pi session entry is too large to verify safely.");
      const bytes = Buffer.alloc(length); readSync(fd, bytes, 0, length, size - length);
      const raw = bytes.toString("utf8").trimEnd(); const newline = raw.lastIndexOf("\n");
      if (newline >= 0 || length === size) {
        if (!raw) return;
        const entry = JSON.parse(raw.slice(newline + 1));
        return entry.type === "session" ? undefined : entry.id;
      }
    }
  } finally { closeSync(fd); }
}
/** Old bridges did not record their process. Do not guess that a disconnected one exited. */
export async function piProcesses(): Promise<number[]> {
  const { stdout } = await exec("ps", ["-axo", "pid=,comm=,args="], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) return [];
    const [, pid, command, args] = match;
    return /(?:^|\/)pi$/.test(command!) || /^(?:\S*\/)?pi(?:\s|$)/.test(args!) ||
      /^(?:\S*\/)?(?:node|bun)(?:\s+--\S+)*\s+\S*(?:pi-coding-agent\/.*\/(?:cli|pi)\.[cm]?js|\/bin\/pi)(?:\s|$)/.test(args!) ? [Number(pid)] : [];
  });
}

/** Cooperative, process-backed ownership. A lost socket is NOT a released session. */
export class SessionOwners {
  readonly database: string;
  private alive: (pid: number) => boolean;
  private processes: () => Promise<number[]>;
  constructor(database: string, alive = processAlive, processes = piProcesses) {
    this.database = database; this.alive = alive; this.processes = processes;
  }
  private use<T>(run: (state: State) => T): T {
    const state = new State(this.database);
    try { return state.transaction(() => run(state)); } finally { state.close(); }
  }
  known(id: string): boolean { return this.use(state => state.get("sessionOwners", id) !== undefined); }
  async checkLegacy(): Promise<void> {
    const pids = await this.processes();
    const known = this.use(state => new Set(state.list<SavedOwner>("sessionOwners").filter(owner => owner.kind === "live" && this.alive(owner.pid)).map(owner => owner.pid)));
    if (pids.some(pid => !known.has(pid))) throw new RpcError(-32600,
      "An older Pi window may still own this conversation. Close old Pi windows or reload codex-ish in them, then send again.");
  }
  claim(id: string, file: string | undefined, kind: SessionOwner["kind"], token: string = randomUUID(), pid = process.pid): SessionOwner {
    const owner: SessionOwner = { id, ...(file ? { file: sessionPath(file) } : {}), kind, token, pid };
    if (!this.alive(pid)) throw new RpcError(-32600, "The Pi process is no longer running. Reopen the conversation.");
    this.use(state => {
      const saved = state.get<SavedOwner>("sessionOwners", id);
      if (saved?.file !== undefined && owner.file !== saved.file) throw new RpcError(-32600, "This conversation points to a different session file. Reopen the original conversation.");
      if (saved && saved.kind !== "released" && this.alive(saved.pid) && (saved.pid !== pid || saved.token !== token || saved.kind !== kind)) {
        throw new RpcError(-32600, "This conversation is still open in another Pi process. Wait for it to close before continuing here.");
      }
      // A canonical file may not be claimed under a second session ID either.
      if (owner.file && state.list<SavedOwner>("sessionOwners").some(other => other.id !== id && other.file === owner.file && other.kind !== "released" && this.alive(other.pid))) {
        throw new RpcError(-32600, "This session file is already in use by another conversation.");
      }
      state.set("sessionOwners", id, { ...saved, ...owner });
    });
    return owner;
  }
  assert(owner: SessionOwner): void {
    this.use(state => {
      const saved = state.get<SavedOwner>("sessionOwners", owner.id);
      if (!saved || saved.pid !== owner.pid || saved.token !== owner.token || saved.kind !== owner.kind || saved.file !== owner.file) {
        throw new RpcError(-32600, "This Pi window no longer owns the conversation. Reopen it before sending a message.");
      }
    });
  }
  release(owner: SessionOwner, leafId?: string | null): void {
    this.use(state => {
      const saved = state.get<SavedOwner>("sessionOwners", owner.id);
      if (saved?.pid !== owner.pid || saved.token !== owner.token || saved.kind !== owner.kind) return;
      const cursor = leafId === undefined ? {} : { leafId: owner.file && sessionTip(owner.file) === undefined ? undefined : leafId,
        stamp: owner.file ? stamp(owner.file) : undefined };
      state.set("sessionOwners", owner.id, { ...saved, kind: "released", ...cursor });
    });
  }
  cursor(owner: SessionOwner): string | null | undefined {
    return this.use(state => {
      const saved = state.get<SavedOwner>("sessionOwners", owner.id);
      return saved?.file && saved.stamp === stamp(saved.file) ? saved.leafId : undefined;
    });
  }
}
