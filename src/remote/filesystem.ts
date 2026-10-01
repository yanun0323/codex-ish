import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcError, text } from "./types.js";

const deniedNames = /^(?:\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i;
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);

/** A directory browser, not an OS sandbox. Agent tools retain the Pi user's permissions. */
export class HostFiles {
  readonly roots = new Set<string>();
  private denied: string[] = [];
  private ready: Promise<void>;
  readonly home: string;
  constructor(home: string, agentDir: string, remoteHome: string) {
    this.home = home;
    this.denied = [agentDir, remoteHome, ...[".ssh", ".aws", ".gnupg", ".kube", ".pi", ".codex", ".config/gcloud", "Library/Keychains"]
      .map(path => join(home, path))].map(path => resolve(path));
    this.ready = (async () => {
      await this.addRoot(home);
      const canonicalHome = await realpath(home);
      const originals = [...this.denied];
      for (const path of originals) {
        if (inside(resolve(home), path)) this.denied.push(join(canonicalHome, relative(resolve(home), path)));
        try { this.denied.push(await realpath(path)); } catch { /* A protected directory may not exist yet. */ }
      }
    })();
  }
  async addRoot(path: string): Promise<void> {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new RpcError(-32602, "Choose a directory.");
    this.roots.add(resolve(path));
    this.roots.add(canonical);
  }
  private allowed(path: string): boolean {
    return [...this.roots].some(root => inside(root, path)) &&
      !this.denied.some(root => inside(root, path)) && !path.split(sep).some(part => deniedNames.test(part));
  }
  private input(value: unknown): string {
    let path = text(value, "path");
    if (path.startsWith("file:")) {
      try { path = fileURLToPath(path); } catch { throw new RpcError(-32602, "Use a local file path."); }
    }
    if (!isAbsolute(path)) throw new RpcError(-32602, "Use an absolute path.");
    return resolve(path);
  }
  async existing(value: unknown): Promise<string> {
    await this.ready;
    const path = this.input(value);
    if (!this.allowed(path)) throw new RpcError(-32600, "This path is not shared with Remote.");
    let canonical: string;
    try { canonical = await realpath(path); } catch { throw new RpcError(-32602, "Path not found."); }
    if (!this.allowed(canonical)) throw new RpcError(-32600, "This link points outside the shared directories.");
    return canonical;
  }
  async directory(value: unknown): Promise<string> {
    const path = await this.existing(value);
    if (!(await stat(path)).isDirectory()) throw new RpcError(-32602, "Choose a directory.");
    return path;
  }
  async list(value: unknown) {
    const path = await this.directory(value);
    const entries = [];
    const names = await readdir(path);
    if (names.length > 20_000) throw new RpcError(-32600, "This directory has too many entries. Choose a subdirectory.");
    for (const name of names.sort()) {
      try {
        const child = await this.existing(join(path, name));
        const info = await stat(child);
        entries.push({ fileName: name, isDirectory: info.isDirectory(), isFile: info.isFile() });
      } catch { /* Protected, dangling, or inaccessible children are not exposed. */ }
    }
    return { entries };
  }
  async metadata(value: unknown) {
    const input = this.input(value);
    const path = await this.existing(value);
    const info = await stat(path);
    return { isDirectory: info.isDirectory(), isFile: info.isFile(), isSymlink: (await lstat(input)).isSymbolicLink(),
      createdAtMs: Math.trunc(info.birthtimeMs), modifiedAtMs: Math.trunc(info.mtimeMs) };
  }
  async create(value: unknown, recursive = true): Promise<string> {
    await this.ready;
    const target = this.input(value);
    if (!this.allowed(target)) throw new RpcError(-32600, "This directory is not shared with Remote.");
    let ancestor = target;
    const missing: string[] = [];
    for (;;) {
      try { await lstat(ancestor); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing.unshift(basename(ancestor));
        const parent = dirname(ancestor);
        if (parent === ancestor) throw new RpcError(-32602, "Parent directory not found.");
        ancestor = parent;
      }
    }
    if (!recursive && missing.length > 1) throw new RpcError(-32602, "Parent directory not found.");
    let current = await this.directory(ancestor);
    for (const part of missing) {
      const next = join(current, part);
      if (!this.allowed(next) || relative(current, next).startsWith("..")) throw new RpcError(-32600, "This directory is not shared with Remote.");
      try { await mkdir(next, { mode: 0o755 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      current = await this.directory(next);
    }
    return current;
  }
  async read(value: unknown, max = 8 * 1024 * 1024): Promise<Buffer> {
    const path = await this.existing(value);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > max) throw new RpcError(-32600, "Only regular files up to 8 MiB can be read.");
      // Bound the read even if another process grows the file after stat().
      const buffer = Buffer.alloc(max + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used > max) throw new RpcError(-32600, "File is too large.");
      return buffer.subarray(0, used);
    } finally { await file.close(); }
  }
}
