import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { State } from "../dist/remote/state.js";
import { Sessions } from "../dist/remote/sessions.js";
import { fixture, client, input, mockRuntime } from "./remote-helpers.mjs";

// This is the desktop's actual access pattern. JSON Schema defaults do not insert missing arrays.
const hasContinuation = content => content.some(part => part.type === "text" && part.text_elements.some(element => element.placeholder === "aeon-continuation"));
function checkContent(content) {
  assert.doesNotThrow(() => hasContinuation(content));
  for (const part of content) if (part.type === "text") {
    assert.ok(Array.isArray(part.text_elements)); assert.ok(!Object.hasOwn(part, "textElements"));
  }
}
function checkThread(thread) {
  for (const turn of thread.turns) for (const item of turn.items) if (item.type === "userMessage") checkContent(item.content);
}

test("terminal snapshots and live updates supply the array the desktop reads without crashing", async t => {
  const { sessions, app, config } = await fixture(t); const c = await client(app, "desktop");
  const id = randomUUID();
  const backend = { info: { id, cwd: config.userHome, model: "fake/test", provider: "fake", effort: "medium" },
    send: async () => {}, close: async () => {}, abort: async () => {} };
  sessions.attach(backend, [{ role: "user", content: "history" }]);
  checkThread((await c.send("thread/resume", { threadId: id })).result.thread);
  sessions.event(id, { type: "message_start", message: { role: "user", content: "live" } });
  for (const event of c.events("item/completed")) if (event.params.item.type === "userMessage") checkContent(event.params.item.content);
  checkThread((await c.send("thread/read", { threadId: id, includeTurns: true })).result.thread);
  const turns = (await c.send("thread/turns/list", { threadId: id })).result.data;
  checkThread({ turns });
  for (const { item } of (await c.send("thread/items/list", { threadId: id })).result.data) if (item.type === "userMessage") checkContent(item.content);
});

test("remote inputs normalize missing and legacy array fields without changing request data or replay behavior", async t => {
  const { app, mock } = await fixture(t); const c = await client(app, "desktop");
  const id = (await c.send("thread/start")).result.thread.id;
  const marker = { byteRange: { start: 0, end: 1 }, placeholder: "aeon-continuation" };
  for (const part of [
    { type: "text", text: "missing" }, { type: "text", text: "legacy", textElements: [marker] },
    { type: "text", text: "canonical", text_elements: [marker] },
    { type: "text", text: "invalid-array", text_elements: null },
  ]) {
    const params = { threadId: id, input: [part], clientUserMessageId: part.text };
    const before = structuredClone(params);
    const result = await c.send("turn/start", params);
    assert.ok(result.result, JSON.stringify(result));
    for (const item of result.result.turn.items) if (item.type === "userMessage") checkContent(item.content);
    const last = result.result.turn.items.at(-1).content;
    assert.equal(hasContinuation(last), ["legacy", "canonical"].includes(part.text));
    assert.deepEqual(params, before);
    const sends = mock.backends[0].sends.length;
    await c.send("turn/start", params); assert.equal(mock.backends[0].sends.length, sends);
  }
});

test("saved legacy history is repaired on restart without changing turn IDs, content, or input receipts", async () => {
  const state = new State(":memory:"); const runtime = mockRuntime();
  const first = new Sessions(state, runtime.createBackend);
  let second;
  try {
    const id = (await first.start({ cwd: "/tmp" })).thread.id;
    const params = { input: input("preserve this message") };
    const original = await first.input(id, params, "original");
    await first.close();
    const record = state.get("threads", id);
    const content = record.thread.turns[0].items[0].content;
    content[0].textElements = [{ placeholder: "aeon-continuation", byteRange: { start: 0, end: 1 } }];
    delete content[0].text_elements;
    content.push({ type: "text", text: "missing field" });
    state.set("threads", id, record);
    second = new Sessions(state, runtime.createBackend);
    const restored = second.read(id);
    checkThread(restored);
    assert.equal(restored.turns[0].id, original.turn.id);
    assert.equal(restored.turns[0].items[0].content[0].text, "preserve this message");
    assert.equal(hasContinuation(restored.turns[0].items[0].content), true);
    assert.deepEqual(state.get("threads", id).thread.turns, restored.turns);
    assert.equal((await second.input(id, params, "original")).turn.id, original.turn.id);
    assert.equal(runtime.backends[0].sends.length, 1);
  } finally { if (second) await second.close(); await first.close(); state.close(); }
});

test("goal discovery returns no goal for a known thread without pretending to support goal mutations", async t => {
  const { app } = await fixture(t); const c = await client(app, "desktop");
  const threadId = (await c.send("thread/start")).result.thread.id;
  assert.deepEqual((await c.send("thread/goal/get", { threadId })).result, { goal: null });
  assert.equal((await c.send("thread/goal/get", { threadId: randomUUID() })).error.code, -32602);
  for (const method of ["thread/goal/set", "thread/goal/clear"]) assert.equal((await c.send(method, { threadId })).error.code, -32601);
});
