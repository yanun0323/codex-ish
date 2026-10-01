export type JsonObject = Record<string, any>;
export type RpcId = string | number;
export type RpcMessage = { id?: RpcId; method?: string; params?: JsonObject; result?: unknown; error?: { code: number; message: string; data?: unknown } };
export type Notify = (method: string, params: JsonObject) => void;
export interface PreparedInput { text: string; images: { type: "image"; data: string; mimeType: string }[]; }

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RpcError(-32602, "Expected an object.");
  return value as JsonObject;
}
export function text(value: unknown, name: string, max = 4096): string {
  if (typeof value !== "string" || !value.length || value.length > max || value.includes("\0")) {
    throw new RpcError(-32602, `Invalid ${name}.`);
  }
  return value;
}
export function page<T>(values: T[], params: JsonObject = {}): { data: T[]; nextCursor: string | null } {
  if (params.cursor != null && (typeof params.cursor !== "string" || !/^(0|[1-9]\d*)$/.test(params.cursor))) {
    throw new RpcError(-32602, "Use the nextCursor returned by the previous page.");
  }
  const offset = params.cursor == null ? 0 : Number(params.cursor);
  const requested = params.limit ?? 50;
  if (!Number.isSafeInteger(offset) || !Number.isInteger(requested) || requested < 0 || requested > 0xffffffff) {
    throw new RpcError(-32602, "Use a non-negative integer page size and a valid cursor.");
  }
  // Desktop requests 200 entries. A server-side cap is valid; rejecting it breaks hydration.
  const limit = Math.max(1, Math.min(requested, 100));
  return { data: values.slice(offset, offset + limit), nextCursor: offset + limit < values.length ? String(offset + limit) : null };
}
export const now = () => Math.floor(Date.now() / 1000);
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Remote request failed.";
}
export function responseError(id: RpcId, error: unknown): RpcMessage {
  // Do not send filesystem errors, upstream response bodies, or credentials to peers.
  return { id, error: { code: error instanceof RpcError ? error.code : -32603,
    message: error instanceof RpcError ? error.message : "The host could not complete this request." } };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Stopped."));
    const onAbort = () => { clearTimeout(timer); reject(new Error("Stopped.")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
