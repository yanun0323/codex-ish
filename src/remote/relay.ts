import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { BackendError, ControlApi, retryAfter } from "./control-api.js";
import { delay, RpcError, type JsonObject, type RpcMessage } from "./types.js";

export const MAX_WIRE = 150 * 1024;
export const MAX_MESSAGE = 100 * 1024 * 1024;
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_ASSEMBLY_TOTAL = 128 * 1024 * 1024;
export type Stream = { clientId: string; streamId: string; key: string };
type Frame = { seq: number; segment?: number; wire: string; bytes: number };
type Assembly = { seq: number; count: number; size: number; chunks: Buffer[]; bytes: number; at: number };

/** Transport state survives reconnects, but never crosses an account or host identity. */
export class WireState {
  cursor?: string;
  private streams = new Map<string, { stream: Stream; opened: boolean; next: number; last?: number; frames: Frame[]; bytes: number }>();
  private legacy = new Map<string, string>();
  private assemblies = new Map<string, Assembly>();
  private totalBytes = 0;
  private assemblyBytes = 0;
  private deliver: (stream: Stream, message: RpcMessage) => Promise<void>;
  private transmit: (wire: string) => void;
  private closed: (stream: Stream) => void;
  constructor(deliver: (stream: Stream, message: RpcMessage) => Promise<void>, transmit: (wire: string) => void, closed: (stream: Stream) => void) {
    this.deliver = deliver; this.transmit = transmit; this.closed = closed;
  }
  private identify(frame: JsonObject): Stream | undefined {
    if (typeof frame.client_id !== "string" || !frame.client_id.length || frame.client_id.length > 512) throw new Error("Invalid remote client.");
    let streamId = frame.stream_id;
    if (streamId == null) {
      streamId = this.legacy.get(frame.client_id);
      if (!streamId && frame.type === "client_message" && frame.message?.method === "initialize") {
        streamId = randomUUID(); this.legacy.set(frame.client_id, streamId);
      }
      if (!streamId && frame.type === "ping") streamId = randomUUID();
      if (!streamId) return undefined;
    }
    if (typeof streamId !== "string" || !streamId.length || streamId.length > 512) throw new Error("Invalid remote stream.");
    return { clientId: frame.client_id, streamId, key: JSON.stringify([frame.client_id, streamId]) };
  }
  private state(stream: Stream) {
    let entry = this.streams.get(stream.key);
    if (!entry) {
      if (this.streams.size >= 128) throw new Error("Too many remote connections.");
      entry = { stream, opened: false, next: 1, frames: [], bytes: 0 };
      this.streams.set(stream.key, entry);
    }
    return entry;
  }
  send(stream: Stream, message: RpcMessage): void { this.sendEvent(stream, { type: "server_message", message }); }
  private sendEvent(stream: Stream, event: JsonObject): void {
    const entry = this.state(stream);
    const seq = entry.next++;
    const base = { client_id: stream.clientId, stream_id: stream.streamId, seq_id: seq };
    const wire = JSON.stringify({ ...base, ...event });
    const frames: Frame[] = [];
    if (Buffer.byteLength(wire) <= 100 * 1024 || event.type !== "server_message") {
      frames.push({ seq, wire, bytes: Buffer.byteLength(wire) });
    } else {
      const raw = Buffer.from(JSON.stringify(event.message));
      if (raw.length > MAX_MESSAGE) throw new Error("Remote message is too large.");
      const chunkSize = 100 * 1024;
      const count = Math.ceil(raw.length / chunkSize);
      for (let segment = 0; segment < count; segment++) {
        const value = JSON.stringify({ ...base, type: "server_message_chunk", segment_id: segment, segment_count: count,
          message_size_bytes: raw.length, message_chunk_base64: raw.subarray(segment * chunkSize, (segment + 1) * chunkSize).toString("base64") });
        frames.push({ seq, segment, wire: value, bytes: Buffer.byteLength(value) });
      }
    }
    const bytes = frames.reduce((sum, frame) => sum + frame.bytes, 0);
    if (this.totalBytes + bytes > MAX_BUFFER || entry.frames.length + frames.length > 4096) {
      this.drop(stream);
      throw new Error("Remote client fell behind. Reconnect and resume the conversation.");
    }
    entry.frames.push(...frames); entry.bytes += bytes; this.totalBytes += bytes;
    for (const frame of frames) this.transmit(frame.wire);
  }
  replay(): void { for (const entry of this.streams.values()) for (const frame of entry.frames) this.transmit(frame.wire); }
  drop(stream: Stream): void {
    const entry = this.streams.get(stream.key);
    if (entry) this.totalBytes -= entry.bytes;
    this.streams.delete(stream.key);
    this.removeAssembly(stream.key);
    if (this.legacy.get(stream.clientId) === stream.streamId) this.legacy.delete(stream.clientId);
    this.closed(stream);
  }
  revoke(clientId: string): void {
    for (const entry of [...this.streams.values()]) if (entry.stream.clientId === clientId) this.drop(entry.stream);
  }
  clear(): void { for (const entry of [...this.streams.values()]) this.drop(entry.stream); this.cursor = undefined; }
  get bufferedBytes(): number { return this.totalBytes; }
  private removeAssembly(key: string) {
    const assembly = this.assemblies.get(key);
    if (assembly) this.assemblyBytes -= assembly.bytes;
    this.assemblies.delete(key);
  }
  async receive(raw: string): Promise<void> {
    if (Buffer.byteLength(raw) > MAX_WIRE) throw new Error("Oversized remote frame.");
    const frame: JsonObject = JSON.parse(raw);
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("Invalid remote envelope.");
    const stream = this.identify(frame);
    if (!stream) return;
    if (frame.seq_id != null && (!Number.isSafeInteger(frame.seq_id) || frame.seq_id < 0)) throw new Error("Invalid remote sequence.");
    if (frame.cursor != null && (typeof frame.cursor !== "string" || frame.cursor.length > 8192)) throw new Error("Invalid remote cursor.");
    const entry = this.streams.get(stream.key);
    if (frame.type === "ack") {
      if (entry && frame.seq_id !== undefined) {
        if (frame.segment_id != null && (!Number.isInteger(frame.segment_id) || frame.segment_id < 0)) throw new Error("Invalid acknowledgement.");
        entry.frames = entry.frames.filter(item => {
          const acked = item.seq < frame.seq_id || item.seq === frame.seq_id && (frame.segment_id == null || (item.segment ?? 0) <= frame.segment_id);
          if (acked) { this.totalBytes -= item.bytes; entry.bytes -= item.bytes; }
          return !acked;
        });
        if (!entry.opened && !entry.frames.length) this.streams.delete(stream.key);
      }
    } else if (frame.type === "ping") {
      this.sendEvent(stream, { type: "pong", status: entry?.opened ? "active" : "unknown" });
    } else if (frame.type === "client_closed") {
      this.drop(stream);
    } else if (frame.type === "client_message" || frame.type === "client_message_chunk") {
      if (frame.seq_id !== undefined && entry?.last !== undefined && frame.seq_id <= entry.last) {
        if (frame.cursor) this.cursor = frame.cursor;
        return;
      }
      let message = frame.message;
      if (frame.type === "client_message_chunk") {
        message = this.chunk(stream, frame);
        if (!message) return; // Cursor advances only after the whole message was delivered.
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid remote message.");
      if (!entry?.opened && message.method !== "initialize") return;
      const current = this.state(stream);
      await this.deliver(stream, message);
      current.opened = true;
      if (frame.seq_id !== undefined) current.last = frame.seq_id;
    } else throw new Error("Unknown remote envelope.");
    if (frame.cursor) this.cursor = frame.cursor;
  }
  private chunk(stream: Stream, frame: JsonObject): RpcMessage | undefined {
    const { segment_id: id, segment_count: count, message_size_bytes: size, message_chunk_base64: data, seq_id: seq } = frame;
    for (const [key, value] of this.assemblies) if (Date.now() - value.at > 60_000) this.removeAssembly(key);
    let assembly = this.assemblies.get(stream.key);
    if (assembly && (seq < assembly.seq || seq === assembly.seq && id < assembly.chunks.length)) return;
    if (!Number.isSafeInteger(seq) || !Number.isInteger(id) || !Number.isInteger(count) || count < 1 || count > 1024 ||
        id < 0 || id >= count || !Number.isInteger(size) || size < 1 || size > MAX_MESSAGE ||
        typeof data !== "string" || !data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      this.removeAssembly(stream.key); throw new Error("Invalid remote chunk.");
    }
    if (!assembly || seq !== assembly.seq) {
      this.removeAssembly(stream.key);
      if (id !== 0 || this.assemblies.size >= 32) throw new Error("Out-of-order remote chunk.");
      assembly = { seq, count, size, chunks: [], bytes: 0, at: Date.now() };
      this.assemblies.set(stream.key, assembly);
    }
    const decoded = Buffer.from(data, "base64");
    if (decoded.toString("base64") !== data || count !== assembly.count || size !== assembly.size || id !== assembly.chunks.length ||
        assembly.bytes + decoded.length > size || this.assemblyBytes + decoded.length > MAX_ASSEMBLY_TOTAL) {
      this.removeAssembly(stream.key); throw new Error("Invalid remote chunk sequence.");
    }
    assembly.chunks.push(decoded); assembly.bytes += decoded.length; this.assemblyBytes += decoded.length; assembly.at = Date.now();
    if (assembly.chunks.length !== count) return;
    this.removeAssembly(stream.key);
    if (assembly.bytes !== size) throw new Error("Remote message size does not match.");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(assembly.chunks)));
  }
}

export class Relay {
  readonly wire: WireState;
  status: "disabled" | "connecting" | "connected" | "errored" = "disabled";
  private socket?: WebSocket;
  private controller?: AbortController;
  private running?: Promise<void>;
  private revoked = new Set<string>();
  private identity?: string;
  private api: ControlApi;
  private changed: () => void;
  private failed: (error: unknown) => void;
  constructor(api: ControlApi, deliver: (stream: Stream, message: RpcMessage) => Promise<void>, closed: (stream: Stream) => void,
    changed: () => void = () => {}, failed: (error: unknown) => void = () => {}) {
    this.api = api; this.changed = changed; this.failed = failed;
    this.wire = new WireState(async (stream, message) => {
      if (!this.revoked.has(stream.clientId)) await deliver(stream, message);
    }, wire => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        if (this.socket.bufferedAmount > MAX_BUFFER) this.socket.terminate();
        else this.socket.send(wire);
      }
    }, closed);
  }
  private setStatus(status: Relay["status"]) { this.status = status; this.changed(); }
  start(): void {
    if (this.running) return;
    const controller = this.controller = new AbortController();
    this.running = this.loop(controller.signal).finally(() => { this.running = undefined; });
  }
  async stop(): Promise<void> {
    this.controller?.abort(); this.socket?.terminate();
    await this.running; this.wire.clear(); this.setStatus("disabled");
  }
  revoke(clientId: string): void { this.revoked.add(clientId); this.wire.revoke(clientId); }
  restoreGrantedClients(clientIds: string[]): void { for (const id of clientIds) this.revoked.delete(id); }
  private async loop(signal: AbortSignal) {
    let attempt = 0;
    while (!signal.aborted) {
      this.setStatus("connecting");
      try {
        const connection = await this.api.connection();
        if (signal.aborted) break;
        const identity = this.api.enrollment!.serverId;
        if (this.identity && this.identity !== identity) this.wire.clear();
        this.identity = identity;
        if (this.wire.cursor) connection.headers["x-codex-subscribe-cursor"] = this.wire.cursor;
        await this.connect(connection, signal, () => { attempt = 0; this.setStatus("connected"); });
      } catch (error) {
        if (signal.aborted) break;
        this.failed(error);
        if (error instanceof RpcError && error.code === -32001) { this.wire.clear(); this.identity = undefined; }
        this.setStatus("errored");
        if (error instanceof BackendError && [401, 403].includes(error.status)) this.api.invalidateToken();
      }
      if (signal.aborted) break;
      const backoff = Math.min(1000 * 2 ** Math.min(attempt++, 5), 30_000);
      try { await delay(Math.max(backoff + Math.random() * 250, this.api.retryAt - Date.now()), signal); } catch { break; }
    }
  }
  private connect(connection: { url: string; headers: Record<string, string> }, signal: AbortSignal, opened: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.socket = new WebSocket(connection.url, { headers: connection.headers,
        handshakeTimeout: 30_000, maxPayload: MAX_WIRE, perMessageDeflate: false, followRedirects: false });
      let failure: unknown;
      let lastPong = Date.now();
      let incoming = Promise.resolve();
      let pendingBytes = 0;
      const abort = () => socket.terminate();
      signal.addEventListener("abort", abort, { once: true });
      const heartbeat = setInterval(() => {
        if (Date.now() - lastPong > 60_000) { failure = new Error("Remote heartbeat timed out."); socket.terminate(); return; }
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, 10_000);
      let checking = false;
      const authWatch = setInterval(() => {
        if (checking) return;
        checking = true;
        void this.api.identity().catch(error => { failure = error; this.wire.clear(); socket.terminate(); }).finally(() => { checking = false; });
      }, 30_000);
      socket.on("pong", () => { lastPong = Date.now(); });
      socket.on("open", () => { opened(); this.wire.replay(); });
      socket.on("message", (data, binary) => {
        if (binary) { failure = new Error("Expected a text frame."); socket.terminate(); return; }
        const value = data.toString();
        pendingBytes += Buffer.byteLength(value);
        if (pendingBytes > MAX_BUFFER) { failure = new Error("Remote incoming buffer exceeded."); socket.terminate(); return; }
        incoming = incoming.then(() => this.wire.receive(value)).catch(error => { failure = error; socket.terminate(); })
          .finally(() => { pendingBytes -= Buffer.byteLength(value); });
      });
      socket.on("unexpected-response", (_request, response) => {
        const status = response.statusCode ?? 500;
        const retry = response.headers["retry-after"];
        if (status === 429 || status >= 500) this.api.retryAt = Math.max(this.api.retryAt, retryAfter(typeof retry === "string" ? retry : null));
        failure = new BackendError(status, this.api.retryAt);
        response.resume(); socket.terminate();
      });
      socket.on("error", error => { failure ??= error; });
      socket.on("close", () => {
        clearInterval(heartbeat); clearInterval(authWatch); signal.removeEventListener("abort", abort);
        if (this.socket === socket) this.socket = undefined;
        void incoming.finally(() => failure && !signal.aborted ? reject(failure) : resolve());
      });
    });
  }
}
