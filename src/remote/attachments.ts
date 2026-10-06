import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { RpcError } from "./types.js";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const MAX_ENTRIES = 256;
const within = (root: string, path: string) => path === root || path.startsWith(root + sep);

export function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  return undefined;
}

/** A virtual App home. Never reads or writes the user's real ~/.codex directory. */
export class Attachments {
  readonly home: string;
  private remoteHome: string;
  private aliases: string[];
  private pending: Promise<unknown> = Promise.resolve();
  constructor(userHome: string, remoteHome: string) {
    this.home = join(userHome, ".codex");
    this.remoteHome = remoteHome;
    // Old clients may still have the previous initialize response cached.
    this.aliases = [join(this.home, "attachments"), join(remoteHome, "attachments")];
  }
  matches(path: string): boolean { return path === this.home || this.aliases.some(root => within(root, path)); }
  private parts(path: string): string[] {
    if (path === this.home) return [];
    const alias = this.aliases.find(root => within(root, path));
    if (!alias) throw new RpcError(-32600, "Only Remote image attachments can be uploaded or removed.");
    const tail = relative(alias, path);
    const parts = tail ? tail.split(sep) : [];
    if (parts.length > 2 || parts[0] && !uuid.test(parts[0]) || parts[1] &&
        (!/^[^/\\\x00-\x1f]{1,200}\.(?:png|jpe?g|webp|gif)$/i.test(parts[1]) || parts[1].startsWith("."))) {
      throw new RpcError(-32602, "Use a Remote attachment folder and a PNG, JPEG, WebP, or GIF filename.");
    }
    return ["attachments", ...parts];
  }
  private async directory(path: string, create: boolean): Promise<void> {
    if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new RpcError(-32600, "Remote attachment directories cannot be links.");
  }
  private async resolve(parts: string[], create = false): Promise<string> {
    // The backing store lives inside the private Remote directory, not a browser-shared root.
    const base = await realpath(this.remoteHome);
    const root = join(base, "client-files");
    await this.directory(root, true);
    await this.directory(join(root, "attachments"), true);
    let path = root;
    for (const [index, part] of parts.entries()) {
      path = join(path, part);
      if (index < 2) await this.directory(path, create);
      else {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new RpcError(-32600, "Remote attachments must be regular files without links.");
      }
    }
    return path;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => {});
    return next;
  }
  private async usage(): Promise<{ bytes: number; files: number; directories: number }> {
    const root = await this.resolve(["attachments"]);
    const dirs = await readdir(root);
    if (dirs.length > MAX_ENTRIES) throw new RpcError(-32600, "Remote attachment storage is full. Remove unused attachments first.");
    let bytes = 0, files = 0;
    for (const id of dirs) {
      if (!uuid.test(id)) throw new RpcError(-32600, "Remote attachment storage contains an unexpected entry.");
      const directory = await this.resolve(["attachments", id]);
      const names = await readdir(directory);
      if (files + names.length > MAX_ENTRIES) throw new RpcError(-32600, "Remote attachment storage is full. Remove unused attachments first.");
      for (const name of names) {
        const path = await this.resolve(["attachments", id, name]);
        bytes += (await lstat(path)).size; files++;
      }
    }
    return { bytes, files, directories: dirs.length };
  }
  async existing(path: string): Promise<string> {
    try { return await this.resolve(this.parts(path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RpcError(-32602, "Path not found.");
      throw error;
    }
  }
  create(path: string): Promise<string> {
    return this.serialize(async () => {
      const parts = this.parts(path);
      if (parts.length > 2) throw new RpcError(-32602, "Choose an attachment directory, not an image file.");
      const usage = await this.usage();
      if (parts.length === 2 && usage.directories >= MAX_ENTRIES) {
        try { return await this.resolve(parts); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          throw new RpcError(-32600, "Remote attachment storage is full. Remove unused attachments first.");
        }
      }
      // Both parents are virtual, so creating a UUID folder needs no recursive traversal.
      return this.resolve(parts, true);
    });
  }
  write(path: string, encoded: unknown): Promise<void> {
    return this.serialize(async () => {
      const parts = this.parts(path);
      if (parts.length !== 3) throw new RpcError(-32602, "Choose an image filename inside a Remote attachment folder.");
      if (typeof encoded !== "string" || !encoded.length || encoded.length > Math.ceil(MAX_IMAGE / 3) * 4 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
        throw new RpcError(-32602, "Send an image up to 8 MiB encoded as base64.");
      }
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length > MAX_IMAGE || bytes.toString("base64") !== encoded || !imageMime(bytes)) {
        throw new RpcError(-32602, "Send a PNG, JPEG, WebP, or GIF image up to 8 MiB.");
      }
      const directory = await this.resolve(parts.slice(0, 2));
      const target = join(directory, parts[2]!);
      let previous = 0, exists = false;
      try { const file = await this.resolve(parts); previous = (await lstat(file)).size; exists = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const usage = await this.usage();
      if (usage.bytes - previous + bytes.length > MAX_TOTAL || !exists && usage.files >= MAX_ENTRIES) {
        throw new RpcError(-32600, "Remote attachment storage is full. Remove unused attachments first.");
      }
      const temporary = join(directory, `.upload-${randomUUID()}`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(bytes); await file.close(); await rename(temporary, target); }
      finally { await file.close().catch(() => {}); await rm(temporary, { force: true }); }
    });
  }
  remove(path: string, recursive: boolean, force: boolean): Promise<void> {
    return this.serialize(async () => {
      const parts = this.parts(path);
      if (parts.length < 2) throw new RpcError(-32600, "Choose an attachment or its folder, not the attachment storage root.");
      let target: string;
      try { target = await this.resolve(parts); }
      catch (error) { if (force && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      // Validate directory children too; never follow a link during cleanup.
      if (parts.length === 2) for (const name of await readdir(target)) await this.resolve([...parts, name]);
      if (parts.length === 2 && !recursive) await rmdir(target);
      else await rm(target, { recursive, force });
    });
  }
}
