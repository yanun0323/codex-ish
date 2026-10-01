import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { State } from "../dist/remote/state.js";
import { Sessions } from "../dist/remote/sessions.js";
import { fixture, client, input, mockRuntime } from "./remote-helpers.mjs";

async function conversation(t) {
  const f = await fixture(t);
  const phone = await client(f.app, "phone"); const mac = await client(f.app, "mac");
  const created = await phone.send("thread/start", { cwd: f.config.userHome });
  assert.ok(created.result, JSON.stringify(created));
  const id = created.result.thread.id;
  const resumed = await mac.send("thread/resume", { threadId: id });
  assert.equal(resumed.result.thread.id, id);
  return { ...f, phone, mac, id };
}

test("phone and Mac send to one execution owner and both receive identical user messages and output", async t => {
  const { phone, mac, mock, id, sessions } = await conversation(t);
  const [a, b] = await Promise.all([
    phone.send("turn/start", { threadId: id, input: input("from phone"), clientUserMessageId: "phone-1" }),
    mac.send("turn/start", { threadId: id, input: input("from Mac"), clientUserMessageId: "mac-1" }),
  ]);
  assert.ok(a.result, JSON.stringify(a)); assert.ok(b.result, JSON.stringify(b));
  assert.equal(a.result.turn.id, b.result.turn.id, "a busy conversation accepts follow-ups into the same Pi run");
  assert.equal(mock.backends.length, 1);
  const backend = mock.backends[0];
  assert.deepEqual(backend.sends.map(send => send.input[0].text), ["from phone", "from Mac"]);
  assert.ok(backend.sends.every(send => send.options.steer === false));
  backend.answer("phone answer", false);
  assert.equal(phone.events("turn/completed").length, 0, "agent_end does not end queued work");
  backend.answer("Mac answer");
  for (const method of ["turn/started", "item/started", "item/completed", "item/agentMessage/delta", "turn/completed"]) {
    assert.deepEqual(phone.events(method), mac.events(method), method);
  }
  const users = phone.events("item/completed").filter(event => event.params.item.type === "userMessage");
  assert.equal(users.length, 2, "accepted inputs are not duplicated by Pi user events");
  assert.deepEqual(users.map(event => event.params.item.clientId), ["phone-1", "mac-1"]);
  assert.equal(sessions.read(id).turns.length, 1);
  assert.equal(sessions.read(id).turns[0].status, "completed");
  assert.deepEqual(sessions.read(id).turns[0].items.filter(item => item.type === "agentMessage").map(item => item.text), ["phone answer", "Mac answer"]);
});

test("concurrent resumes load one backend and unsubscribing does not stop another client", async t => {
  const { phone, mac, sessions, id, mock } = await conversation(t);
  await Promise.all(Array.from({ length: 5 }, () => sessions.resume(id)));
  assert.equal(mock.backends.length, 1);
  await mac.send("thread/unsubscribe", { threadId: id });
  await phone.send("turn/start", { threadId: id, input: input("work") });
  mock.backends[0].answer("done");
  assert.equal(mac.events("item/agentMessage/delta").length, 0);
  assert.equal(phone.events("item/agentMessage/delta").length, 1);
  const resumed = await mac.send("thread/resume", { threadId: id });
  assert.equal(resumed.result.thread.turns[0].items.at(-1).text, "done");
});

test("RPC IDs are per connection and retries after reconnect do not execute accepted input twice", async t => {
  const { phone, mac, mock, id, app } = await conversation(t);
  const params = { threadId: id, input: input("exactly once within this accepted request"), clientUserMessageId: "stable-message" };
  await Promise.all([phone.send("turn/start", params, 40), phone.send("turn/start", params, 40)]);
  await mac.send("turn/start", { ...params, input: input("different device") }, 40);
  assert.equal(mock.backends[0].sends.length, 2, "the same numeric RPC id on different devices is not deduplicated across clients");
  phone.close();
  const reconnect = await client(app, "phone-stream-2", "phone");
  await reconnect.send("thread/resume", { threadId: id });
  await reconnect.send("turn/start", params);
  assert.equal(mock.backends[0].sends.length, 2);
  const collision = await reconnect.send("turn/start", { ...params, input: input("changed payload") });
  assert.equal(collision.error.code, -32602);
  const rpcCollision = await mac.send("turn/start", { threadId: id, input: input("changed") }, 40);
  assert.equal(rpcCollision.error.code, -32600);
});

test("either client can interrupt or explicitly steer; stale turn IDs cannot target a later turn", async t => {
  const { phone, mac, id, mock } = await conversation(t);
  const first = await phone.send("turn/start", { threadId: id, input: input("first") });
  const turnId = first.result.turn.id;
  const steer = await mac.send("turn/steer", { threadId: id, expectedTurnId: turnId, input: input("change direction") });
  assert.equal(steer.result.turnId, turnId);
  assert.equal(mock.backends[0].sends[1].options.steer, true);
  await mac.send("turn/interrupt", { threadId: id, turnId });
  assert.equal(mock.backends[0].aborts, 1);
  assert.equal(phone.events("turn/completed").at(-1).params.turn.status, "interrupted");
  const second = await phone.send("turn/start", { threadId: id, input: input("second") });
  assert.notEqual(second.result.turn.id, turnId);
  assert.equal((await mac.send("turn/interrupt", { threadId: id, turnId })).error.code, -32602);
  assert.equal((await mac.send("turn/steer", { threadId: id, expectedTurnId: turnId, input: input("stale") })).error.code, -32602);
});

test("app cannot silently request a sandbox, change project mid-turn, or switch a busy model", async t => {
  const { phone, id, mock, config } = await conversation(t);
  for (const extra of [{ sandboxPolicy: { type: "readOnly" } }, { approvalPolicy: "on-request" }, { permissions: "workspace" }, { outputSchema: {} }]) {
    assert.equal((await phone.send("turn/start", { threadId: id, input: input("unsafe assumption"), ...extra })).error.code, -32602);
  }
  assert.equal(mock.backends[0].sends.length, 0);
  await phone.send("turn/start", { threadId: id, input: input("first") });
  assert.equal((await phone.send("turn/start", { threadId: id, input: input("second"), model: "other/model" })).error.code, -32602);
  assert.equal((await phone.send("turn/start", { threadId: id, input: input("second"), cwd: config.home })).error.code, -32602);
  assert.equal(mock.backends[0].sends.length, 1);
});

test("local Pi messages are broadcast to both apps without opening another execution owner", async t => {
  const { sessions, phone, mac, mock } = await conversation(t);
  const id = randomUUID(); const sent = [];
  const backend = { info: { id, cwd: "/local", model: "fake/test", provider: "fake", effort: "medium" },
    send: async value => { sent.push(value); }, abort: async () => {}, close: async () => {} };
  sessions.attach(backend, [{ role: "user", content: "earlier" }, { role: "assistant", content: [{ type: "text", text: "history" }] }]);
  await phone.send("thread/resume", { threadId: id }); await mac.send("thread/resume", { threadId: id });
  sessions.event(id, { type: "agent_start" });
  sessions.event(id, { type: "message_start", message: { role: "user", content: "from terminal" } });
  await phone.send("turn/start", { threadId: id, input: input("phone follow-up") });
  assert.equal(mock.backends.length, 1, "only the unrelated initial conversation used the factory");
  assert.equal(sent.length, 1);
  assert.ok(phone.events("item/completed").some(event => event.params.item.content?.[0]?.text === "from terminal"));
  assert.deepEqual(phone.events("item/completed"), mac.events("item/completed"));
  sessions.detach(id, backend);
  assert.equal((await mac.send("turn/start", { threadId: id, input: input("do not spawn another writer") })).error.code, -32600);
  assert.equal(mock.backends.length, 1);
});

test("a second live owner and takeover of a daemon-owned session are rejected", async t => {
  const { sessions, id } = await conversation(t);
  const backend = { info: { id, cwd: "/local", model: "fake/test", provider: "fake", effort: "medium" },
    send: async () => {}, abort: async () => {}, close: async () => {} };
  assert.throws(() => sessions.attach(backend), /execution owner/);
  backend.info.id = randomUUID(); sessions.attach(backend);
  assert.throws(() => sessions.attach({ ...backend }), /execution owner/);
});

test("host restart marks uncertain work interrupted and never automatically repeats it", async () => {
  const state = new State(":memory:");
  const runtime = mockRuntime();
  const first = new Sessions(state, runtime.createBackend);
  const result = await first.start({ cwd: "/tmp" }); const id = result.thread.id;
  const params = { input: input("important operation"), clientUserMessageId: "message" };
  const original = await first.input(id, params, "device:message");
  const second = new Sessions(state, runtime.createBackend); // Simulate reconstruction without asking the first owner to replay work.
  assert.equal(second.read(id).turns[0].status, "interrupted");
  const replay = await second.input(id, params, "device:message");
  assert.equal(replay.turn.id, original.turn.id);
  assert.equal(replay.turn.status, "interrupted");
  assert.equal(runtime.backends[0].sends.length, 1);
  await first.close(); await second.close(); state.close();
});

test("tool output and final text keep stable item IDs and use authoritative completed content", async t => {
  const { phone, mac, mock, id } = await conversation(t);
  await phone.send("turn/start", { threadId: id, input: input("tool") });
  const { emit } = mock.backends[0];
  emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "echo test" } });
  emit({ type: "tool_execution_update", toolCallId: "tool-1", partialResult: { content: [{ type: "text", text: "te" }] } });
  emit({ type: "tool_execution_end", toolCallId: "tool-1", isError: false, result: { content: [{ type: "text", text: "test" }], details: { exitCode: 0 } } });
  emit({ type: "message_start", message: { role: "assistant", content: [] } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" } });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }], stopReason: "stop" } });
  emit({ type: "agent_settled" });
  assert.deepEqual(phone.events("item/commandExecution/outputDelta").map(event => event.params.delta), ["te", "st"]);
  assert.equal(phone.events("item/completed").at(-1).params.item.text, "final");
  assert.deepEqual(phone.events("item/completed"), mac.events("item/completed"));
});

test("requests before initialization fail and unsupported methods never fake success", async t => {
  const { app, state } = await fixture(t); const messages = [];
  const bare = app.connect("bare", "bare", message => messages.push(message));
  await app.receive(bare, { id: 1, method: "thread/list" });
  assert.equal(messages[0].error.code, -32600);
  const user = await client(app, "known");
  const response = await user.send("account/logout");
  assert.equal(response.error.code, -32601);
  assert.deepEqual(Object.keys(state.get("diagnostics", "unsupported")).sort(), ["at", "method"]);
});
