import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { State } from "../dist/remote/state.js";
import { HostFiles } from "../dist/remote/filesystem.js";
import { Sessions } from "../dist/remote/sessions.js";
import { AppServer } from "../dist/remote/server.js";
import { piInput } from "../dist/remote/runtime.js";
import { RpcError } from "../dist/remote/types.js";

export async function fixture(t) {
  const root = await mkdtemp("/tmp/cish-");
  const userHome = join(root, "home");
  const agentDir = join(userHome, ".pi", "agent");
  const home = join(agentDir, "remote");
  await mkdir(home, { recursive: true });
  const config = { userHome, agentDir, home, socket: join(home, "host.sock"), endpoint: join(home, "endpoint.json"),
    database: join(home, "remote.sqlite"), hostName: "test-host", baseUrl: "http://127.0.0.1:1/backend-api/" };
  const state = new State(config.database);
  const files = new HostFiles(userHome, agentDir, home);
  const mock = mockRuntime();
  const sessions = new Sessions(state, mock.createBackend, input => piInput(input, files));
  const app = new AppServer({ config, state, files, sessions, models: mock.models });
  const cleanup = [];
  t.after(async () => { for (const close of cleanup.toReversed()) await close(); await sessions.close(); state.close(); await rm(root, { recursive: true, force: true }); });
  return { root, config, state, files, sessions, app, mock, cleanup };
}
export const model = { id: "fake/test", model: "fake/test", upgrade: null, upgradeInfo: null, availabilityNux: null,
  displayName: "Test", description: "Offline fixture", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "medium" }],
  defaultReasoningEffort: "medium", inputModalities: ["text"], supportsPersonality: false, multiAgentVersion: null,
  additionalSpeedTiers: [], isDefault: true };
export function mockRuntime() {
  const backends = [];
  return {
    backends,
    credentials: async () => ({ accessToken: "fake-oauth", accountId: "test-account" }),
    models: async () => [model],
    createBackend: async (record, params, emit) => {
      const info = { id: record?.thread.id ?? randomUUID(), cwd: record?.thread.cwd ?? params.cwd,
        model: "fake/test", provider: "fake", effort: "medium" };
      const backend = {
        info, sends: [], closed: false, aborts: 0,
        configure: async options => {
          if (options.model != null && !["fake/test", "fake/other"].includes(options.model)) throw new RpcError(-32602, "Model not found.");
          if (options.model != null) info.model = options.model;
          if (options.effort != null) info.effort = options.effort;
        },
        send: async (input, options) => {
          backend.sends.push({ input, options });
          emit({ type: "agent_start" });
          emit({ type: "message_start", message: { role: "user", content: input.filter(part => part.type === "text").map(part => part.text).join("\n") } });
        },
        emit,
        answer: (text, settle = true) => {
          emit({ type: "message_start", message: { role: "assistant", content: [] } });
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
          emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
          emit({ type: "agent_end", willRetry: false });
          if (settle) emit({ type: "agent_settled" });
        },
        abort: async () => { backend.aborts++; emit({ type: "agent_settled" }); },
        close: async () => { backend.closed = true; },
      };
      backends.push(backend); return backend;
    },
  };
}
export async function client(app, name, deviceId = name) {
  const messages = [];
  const connection = app.connect(name, deviceId, message => messages.push(structuredClone(message)));
  let next = 0;
  const send = async (method, params = {}, id = ++next) => {
    const before = messages.length;
    await app.receive(connection, { id, method, params });
    return messages.slice(before).find(message => message.id === id);
  };
  await send("initialize", { clientInfo: { name, version: "1" }, capabilities: { experimentalApi: true } });
  await app.receive(connection, { method: "initialized" });
  return { messages, connection, send, events: method => messages.filter(message => message.method === method),
    close: () => app.disconnect(name) };
}
export const input = text => [{ type: "text", text, text_elements: [] }];
export async function eventually(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("Condition did not become true before timeout.");
}
