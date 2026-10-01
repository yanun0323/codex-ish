import { randomUUID, timingSafeEqual } from "node:crypto";
import { connect, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import type { RemoteConfig } from "./config.js";
import { deferred, RpcError, type JsonObject, type RpcMessage } from "./types.js";

const MAX_RECORD = 24 * 1024 * 1024;
export interface Endpoint { version: 1; pid: number; instance: string; token: string; socket: string; startedAt: string }
export const sameSecret = (left: string, right: string) => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Private, LF-framed, bidirectional RPC. No terminal output or upstream credentials travel here. */
export class Peer {
  handler: (method: string, params: JsonObject) => unknown | Promise<unknown> = () => { throw new RpcError(-32601, "Unknown local request."); };
  onNotification: (method: string, params: JsonObject) => void = () => {};
  onClose: () => void = () => {};
  readonly closed = deferred<void>();
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private ended = false;
  readonly socket: Socket;
  constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => {
      this.buffer += data;
      if (Buffer.byteLength(this.buffer) > MAX_RECORD) return this.close();
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const record = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (!record.trim()) continue;
        let value: RpcMessage;
        try { value = JSON.parse(record); } catch { this.close(); return; }
        if (!value || typeof value !== "object" || Array.isArray(value)) { this.close(); return; }
        void this.receive(value).catch(() => this.close());
      }
    });
    socket.on("error", () => this.close());
    socket.on("close", () => {
      if (this.ended) return;
      this.ended = true;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Remote host disconnected.")); }
      this.pending.clear(); this.closed.resolve(); this.onClose();
    });
  }
  private write(value: RpcMessage) {
    const wire = JSON.stringify(value) + "\n";
    if (this.ended || this.socket.destroyed || Buffer.byteLength(wire) > MAX_RECORD || this.socket.writableLength > MAX_RECORD) {
      this.close(); throw new Error("Local Remote connection is unavailable or overloaded.");
    }
    this.socket.write(wire);
  }
  private async receive(value: RpcMessage) {
    if (typeof value.method === "string") {
      if (value.id === undefined) { this.onNotification(value.method, value.params ?? {}); return; }
      try { this.write({ id: value.id, result: await this.handler(value.method, value.params ?? {}) }); }
      catch (error) { this.write({ id: value.id, error: { code: error instanceof RpcError ? error.code : -32603,
        message: error instanceof RpcError ? error.message : "Remote host could not complete the local request." } }); }
    } else if (typeof value.id === "string") {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(value.id);
      if (value.error) pending.reject(new RpcError(value.error.code, value.error.message)); else pending.resolve(value.result);
    }
  }
  call<T = JsonObject>(method: string, params: JsonObject = {}, timeout = 30_000): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Remote request timed out: ${method}.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method: string, params: JsonObject = {}): void { this.write({ method, params }); }
  close(): void { this.socket.destroy(); }
}
export async function readEndpoint(config: RemoteConfig): Promise<Endpoint> {
  const raw = await readFile(config.endpoint, "utf8");
  if (raw.length > 4096) throw new Error("Invalid Remote endpoint.");
  const endpoint = JSON.parse(raw) as Endpoint;
  if (endpoint.version !== 1 || endpoint.socket !== config.socket || !Number.isInteger(endpoint.pid) || endpoint.pid <= 0 ||
      typeof endpoint.token !== "string" || !/^[a-f0-9]{64}$/.test(endpoint.token) || typeof endpoint.instance !== "string") throw new Error("Invalid Remote endpoint.");
  return endpoint;
}
export async function connectLocal(config: RemoteConfig, handler?: Peer["handler"]): Promise<Peer> {
  const endpoint = await readEndpoint(config);
  const socket = connect(config.socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Remote host did not answer.")); }, 2000);
    socket.once("connect", () => { clearTimeout(timer); resolve(); });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
  });
  const peer = new Peer(socket);
  if (handler) peer.handler = handler;
  try { await peer.call("hello", { token: endpoint.token, instance: endpoint.instance }, 3000); return peer; }
  catch (error) { peer.close(); throw error; }
}
export async function localCall<T = JsonObject>(config: RemoteConfig, method: string, params: JsonObject = {}, timeout = 30_000): Promise<T> {
  const peer = await connectLocal(config);
  try { return await peer.call<T>(method, params, timeout); } finally { peer.close(); }
}
