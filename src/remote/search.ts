import { randomUUID } from "node:crypto";
import { HostFiles } from "./filesystem.js";
import { RpcError, text, type JsonObject, type Notify } from "./types.js";

function query(value: unknown): string {
  if (typeof value !== "string" || value.length > 256 || value.includes("\0")) throw new RpcError(-32602, "Use a search query up to 256 characters.");
  return value;
}
function score(path: string, name: string, value: string): number {
  const needle = value.toLowerCase().replaceAll("\\", "/");
  const haystack = path.toLowerCase().replaceAll("\\", "/");
  const lower = name.toLowerCase();
  if (lower === needle) return 100_000;
  if (lower.startsWith(needle)) return 90_000 - name.length;
  if (lower.includes(needle)) return 80_000 - name.length;
  if (haystack.includes(needle)) return 70_000 - path.length;
  let cursor = 0;
  for (const char of needle) {
    const index = haystack.indexOf(char, cursor);
    if (index < 0) return 0;
    cursor = index + 1;
  }
  return Math.max(1, 10_000 - cursor - path.length);
}

/** Searches belong to one authenticated connection; no cross-client IDs or notifications. */
export class FileSearch {
  private sessions = new Map<string, { roots: string[]; running?: AbortController }>();
  private legacy = new Map<string, AbortController>();
  private closed = false;
  private files: HostFiles;
  private notify: Notify;
  constructor(files: HostFiles, notify: Notify) { this.files = files; this.notify = notify; }
  private async roots(value: unknown): Promise<string[]> {
    if (!Array.isArray(value) || !value.length || value.length > 16) throw new RpcError(-32602, "Select between 1 and 16 search directories.");
    return [...new Set(await Promise.all(value.map(root => this.files.directory(root))))];
  }
  private async run(roots: string[], value: string, signal: AbortSignal): Promise<JsonObject[]> {
    if (!value.trim() || signal.aborted) return [];
    const matches: JsonObject[] = [];
    const deadline = Date.now() + 5000;
    for (const root of roots) {
      for await (const entry of this.files.walk(root, signal)) {
        if (signal.aborted || Date.now() >= deadline) break;
        const rank = score(entry.path, entry.fileName, value.trim());
        if (!rank) continue;
        matches.push({ root, path: entry.path, match_type: entry.isDirectory ? "directory" : "file",
          file_name: entry.fileName, score: rank, indices: null });
        if (matches.length > 200) { matches.sort(compare); matches.length = 100; }
      }
      if (signal.aborted || Date.now() >= deadline) break;
    }
    return matches.sort(compare).slice(0, 100);
  }
  async start(params: JsonObject): Promise<JsonObject> {
    const id = text(params.sessionId, "search session", 256);
    if (!this.sessions.has(id) && this.sessions.size >= 8) throw new RpcError(-32600, "Close another file search before starting a new one.");
    const roots = await this.roots(params.roots);
    if (this.closed) throw new RpcError(-32600, "This file search connection has closed.");
    if (!this.sessions.has(id) && this.sessions.size >= 8) throw new RpcError(-32600, "Close another file search before starting a new one.");
    this.sessions.get(id)?.running?.abort();
    this.sessions.set(id, { roots });
    return {};
  }
  update(params: JsonObject): JsonObject {
    const id = text(params.sessionId, "search session", 256);
    const session = this.sessions.get(id);
    if (!session) throw new RpcError(-32602, "Fuzzy file search session not found. Start a new search.");
    const value = query(params.query);
    session.running?.abort();
    const running = session.running = new AbortController();
    setImmediate(() => {
      if (running.signal.aborted) return;
      void this.run(session.roots, value, running.signal).then(files => {
        if (running.signal.aborted || this.sessions.get(id) !== session || session.running !== running) return;
        this.notify("fuzzyFileSearch/sessionUpdated", { sessionId: id, query: value, files });
        this.notify("fuzzyFileSearch/sessionCompleted", { sessionId: id });
      }).catch(() => { /* A disconnected client cannot receive results. */ });
    });
    return {};
  }
  stop(params: JsonObject): JsonObject {
    const id = text(params.sessionId, "search session", 256);
    this.sessions.get(id)?.running?.abort(); this.sessions.delete(id);
    return {};
  }
  async search(params: JsonObject): Promise<JsonObject> {
    if (this.closed) throw new RpcError(-32600, "This file search connection has closed.");
    const value = query(params.query);
    const key = params.cancellationToken == null ? randomUUID() : text(params.cancellationToken, "search token", 256);
    if (!this.legacy.has(key) && this.legacy.size >= 8) throw new RpcError(-32600, "Wait for another file search to finish.");
    const running = new AbortController();
    this.legacy.get(key)?.abort(); this.legacy.set(key, running);
    try {
      const roots = await this.roots(params.roots);
      const files = await this.run(roots, value, running.signal);
      return { files: running.signal.aborted ? [] : files };
    } finally { if (this.legacy.get(key) === running) this.legacy.delete(key); }
  }
  close(): void {
    this.closed = true;
    for (const session of this.sessions.values()) session.running?.abort();
    for (const running of this.legacy.values()) running.abort();
    this.sessions.clear(); this.legacy.clear();
  }
}
const compare = (a: JsonObject, b: JsonObject) => b.score - a.score || a.path.localeCompare(b.path) || a.root.localeCompare(b.root);
