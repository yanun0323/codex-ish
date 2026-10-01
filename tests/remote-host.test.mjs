import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { startHost } from "../dist/remote/daemon.js";
import { Peer, connectLocal, localCall, readEndpoint } from "../dist/remote/ipc.js";
import { registerRemoteControl } from "../dist/remote/client.js";
import { fixture, client, input, eventually } from "./remote-helpers.mjs";

async function hostFixture(t) {
  const f = await fixture(t);
  const host = await startHost(f.config, async () => f.mock);
  f.cleanup.push(() => host.close());
  return { ...f, host };
}

test("the local socket and endpoint are private; callers must authenticate the current host instance", async t => {
  const { config, host } = await hostFixture(t);
  for (const [path, mode] of [[config.home, 0o700], [config.endpoint, 0o600], [config.database, 0o600], [config.socket, 0o600]]) {
    assert.equal((await stat(path)).mode & 0o777, mode, path);
  }
  const endpoint = await readEndpoint(config);
  assert.equal((await localCall(config, "status")).state, "running");
  for (const params of [{ token: "wrong", instance: endpoint.instance }, { token: endpoint.token, instance: "old-instance" }]) {
    const socket = connect(config.socket); await once(socket, "connect"); const peer = new Peer(socket);
    await assert.rejects(peer.call("hello", params), /authentication failed/); await peer.closed.promise;
  }
  await assert.rejects(startHost(config, async () => { throw new Error("must not reach a second runtime"); }), /already starting or running/);
  await host.close(); await assert.rejects(stat(config.endpoint), { code: "ENOENT" });
});

test("two simulated Apps use one authenticated live terminal bridge; losing it never starts a worker", async t => {
  const { config, host, mock, cleanup } = await hostFixture(t);
  const phone = await client(host.app, "phone"); const mac = await client(host.app, "mac");
  const id = randomUUID(); const inputs = [];
  const bridge = await connectLocal(config, async (method, params) => {
    assert.equal(params.threadId, id);
    if (method === "bridge/input") {
      inputs.push(params);
      bridge.notify("bridge/event", { threadId: id, event: { type: "message_start", message: { role: "user", content: params.text } } });
    }
    return { accepted: true };
  });
  cleanup.push(async () => { bridge.close(); await bridge.closed.promise; });
  await bridge.call("bridge/register", { info: { id, cwd: config.userHome, model: "fake/test", provider: "fake", effort: "medium", busy: false }, messages: [] });
  await phone.send("thread/resume", { threadId: id }); await mac.send("thread/resume", { threadId: id });
  const results = await Promise.all([
    phone.send("turn/start", { threadId: id, input: input("phone"), clientUserMessageId: "phone-message" }),
    mac.send("turn/start", { threadId: id, input: input("Mac"), clientUserMessageId: "Mac-message" }),
  ]);
  assert.ok(results.every(result => result.result), JSON.stringify(results)); assert.equal(inputs.length, 2);
  assert.equal(mock.backends.length, 0, "the terminal is the only execution owner");
  bridge.notify("bridge/event", { threadId: id, event: { type: "message_start", message: { role: "assistant", content: [] } } });
  bridge.notify("bridge/event", { threadId: id, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "shared", contentIndex: 0 } } });
  bridge.notify("bridge/event", { threadId: id, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "shared" }], stopReason: "stop" } } });
  bridge.notify("bridge/event", { threadId: id, event: { type: "agent_settled" } });
  await eventually(() => phone.events("turn/completed").length);
  assert.deepEqual(phone.events("item/completed"), mac.events("item/completed"));
  bridge.close(); await eventually(() => !host.sessions.read(id).canAcceptDirectInput);
  assert.ok((await phone.send("turn/start", { threadId: id, input: input("offline") })).error);
  assert.equal(mock.backends.length, 0);
});

test("local shutdown stops the host without running a model, enrolling, or leaving its endpoint behind", async t => {
  const { config, host, mock } = await hostFixture(t);
  assert.equal(host.status().enabled, false);
  assert.equal(host.status().environmentId, null);
  await localCall(config, "shutdown"); await host.stopped;
  assert.equal(mock.backends.length, 0);
  await assert.rejects(stat(config.endpoint), { code: "ENOENT" });
});

test("the actual extension bridge sends remote inputs through Pi and forwards terminal updates", async t => {
  const { config, host, cleanup } = await hostFixture(t);
  const env = { PI_CODEX_ISH_REMOTE_HOME: config.home, PI_CODING_AGENT_DIR: config.agentDir,
    PI_CODEX_APP_SERVER_AUTOSTART: "0", PI_CODEX_REMOTE_CONTROL: "1", PI_CODEX_ISH_WORKER: "0" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const handlers = new Map(); const calls = []; const id = randomUUID();
  const ctx = { cwd: config.userHome, model: { provider: "fake", id: "test" }, thinkingLevel: "medium", isIdle: () => true,
    ui: { notify() {}, requestRender() {} },
    sessionManager: { getSessionId: () => id, getBranch: () => [], getSessionFile: () => undefined, getSessionName: () => undefined } };
  const pi = { on: (name, handler) => handlers.set(name, handler), registerCommand() {},
    sendUserMessage: (...args) => { calls.push(args); }, setThinkingLevel() {} };
  registerRemoteControl(pi, async () => { throw new Error("No real pairing during tests"); });
  cleanup.push(async () => handlers.get("session_shutdown")());
  await handlers.get("session_start")({}, ctx);
  await eventually(() => host.sessions.loaded().includes(id));
  const phone = await client(host.app, "phone"); const mac = await client(host.app, "mac");
  await phone.send("thread/resume", { threadId: id }); await mac.send("thread/resume", { threadId: id });
  const result = await phone.send("turn/start", { threadId: id, input: input("from phone") });
  assert.ok(result.result, JSON.stringify(result));
  assert.equal(calls.length, 1); assert.equal(calls[0][0][0].text, "from phone");
  assert.deepEqual(calls[0][1], { deliverAs: "followUp", expandPromptTemplates: false });
  for (const event of [
    { type: "message_start", message: { role: "user", content: "from phone" } },
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "reply", contentIndex: 0 } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "reply" }], stopReason: "stop" } },
    { type: "agent_settled" },
  ]) handlers.get(event.type)(event, ctx);
  await eventually(() => mac.events("turn/completed").length);
  assert.deepEqual(phone.events("item/agentMessage/delta"), mac.events("item/agentMessage/delta"));
});
