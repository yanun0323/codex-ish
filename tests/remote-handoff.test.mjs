import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Sessions } from "../dist/remote/sessions.js";
import { desktopOptions } from "../dist/remote/compatibility.js";
import { fixture, client, input, mockRuntime, eventually } from "./remote-helpers.mjs";

function terminal(config) {
  return { info: { id: randomUUID(), cwd: config.userHome, sessionFile: join(config.userHome, "saved.jsonl"), model: "fake/test", provider: "fake", effort: "medium" },
    sends: [], send: async function (value) { this.sends.push(value); }, close: async () => {}, abort: async () => {} };
}
test("saved terminal conversations remain readable without loading; the first new input starts one background owner", async t => {
  const f = await fixture(t), live = terminal(f.config), id = live.info.id;
  f.sessions.attach(live, [{ role: "user", content: "earlier" }, { role: "assistant", content: [{ type: "text", text: "old answer" }] }]);
  const oldTurn = f.sessions.read(id).turns[0].id;
  f.sessions.detach(id, live);
  const phone = await client(f.app, "phone"), mac = await client(f.app, "mac");
  await Promise.all([phone.send("thread/resume", { threadId: id }), mac.send("thread/resume", { threadId: id })]);
  assert.equal(f.mock.backends.length, 0); assert.equal(f.sessions.read(id).canAcceptDirectInput, true);
  const params = { threadId: id, input: input("continue"), clientUserMessageId: "once" };
  const [first, retry] = await Promise.all([phone.send("turn/start", params), phone.send("turn/start", params)]);
  assert.ok(first.result, JSON.stringify(first)); assert.ok(retry.result);
  assert.equal(f.mock.backends.length, 1); assert.equal(f.mock.backends[0].sends.length, 1);
  assert.equal(f.sessions.record(id).owner, "daemon"); assert.equal(f.sessions.read(id).turns[0].id, oldTurn);
  assert.equal(live.sends.length, 0);
  f.mock.backends[0].answer("background answer");
  assert.equal(f.sessions.read(id).turns.at(-1).status, "completed");
  assert.deepEqual(phone.events("item/completed"), mac.events("item/completed"));
});
test("idle background ownership can return to Pi, but active work is never interrupted by reopening", async t => {
  const f = await fixture(t), result = await f.sessions.start({ cwd: f.config.userHome }), id = result.thread.id;
  let claims = 0;
  await f.sessions.input(id, { input: input("running") }, "first");
  await assert.rejects(f.sessions.claimLocal(id, () => { claims++; }), /still running/);
  assert.equal(f.mock.backends[0].closed, false); assert.equal(claims, 0);
  f.mock.backends[0].answer("done");
  await f.sessions.claimLocal(id, () => { claims++; });
  assert.equal(f.mock.backends[0].closed, true); assert.equal(claims, 1);
  const live = terminal(f.config); live.info.id = id;
  f.sessions.attach(live, [{ role: "user", content: "running" }, { role: "assistant", content: [{ type: "text", text: "done" }] }], true);
  await f.sessions.input(id, { input: input("back in Pi") }, "second");
  assert.equal(live.sends.length, 1); assert.equal(f.mock.backends.length, 1);
});
test("failed ownership claims do not create a turn or input receipt, and retry can succeed later", async t => {
  const f = await fixture(t), live = terminal(f.config), id = live.info.id;
  let available = false, attempts = 0;
  const runtime = mockRuntime();
  const sessions = new Sessions(f.state, async (...args) => { attempts++; if (!available) throw new Error("owner remains alive"); return runtime.createBackend(...args); });
  f.cleanup.push(() => sessions.close()); sessions.attach(live); sessions.detach(id, live);
  const params = { input: input("once") };
  await assert.rejects(sessions.input(id, params, "stable"), /owner remains alive/);
  assert.equal(sessions.read(id).turns.length, 0); assert.equal(f.state.list("inputs").length, 0);
  available = true; await sessions.input(id, params, "stable");
  assert.equal(attempts, 2); assert.equal(runtime.backends.length, 1); assert.equal(runtime.backends[0].sends.length, 1);
});
test("return to Pi waits for a loading worker; closing Remote disposes a late worker without running a prompt", async t => {
  const f = await fixture(t), live = terminal(f.config), id = live.info.id;
  let finish; const loaded = new Promise(resolve => { finish = resolve; });
  let started = false, closed = 0, sent = 0;
  const sessions = new Sessions(f.state, async () => { started = true; await loaded; return { info: live.info, close: async () => { closed++; }, abort: async () => {}, send: async () => { sent++; } }; });
  sessions.attach(live); sessions.detach(id, live);
  const inputPromise = sessions.input(id, { input: input("not accepted yet") }, "key");
  const rejected = assert.rejects(inputPromise, /Remote stopped/);
  await eventually(() => started);
  assert.throws(() => sessions.attach(live), /execution owner/);
  const closing = sessions.close(); finish(); await rejected; await closing;
  assert.equal(closed, 1); assert.equal(sent, 0); assert.equal(f.state.list("inputs").length, 0);
});
test("shutdown waits for a new conversation still starting and never registers its late backend", async t => {
  const f = await fixture(t), live = terminal(f.config);
  let finish, stopped = false; const gate = new Promise(resolve => { finish = resolve; });
  const sessions = new Sessions(f.state, async () => { await gate; return { info: live.info, send: async () => {}, abort: async () => {},
    close: async () => { await new Promise(resolve => setTimeout(resolve, 20)); stopped = true; } }; });
  const starting = sessions.start({ cwd: f.config.userHome }); const rejected = assert.rejects(starting, /Remote stopped/);
  const closing = sessions.close(); finish(); await closing; await rejected;
  assert.equal(stopped, true); assert.equal(f.state.list("threads").length, 0);
  await assert.rejects(sessions.start({}), /Remote is stopping/);
});
test("restored SDK history replaces only a changed branch and never replays old requests", async t => {
  const f = await fixture(t), live = terminal(f.config), id = live.info.id, runtime = mockRuntime();
  const saved = [{ role: "user", content: "while disconnected" }, { role: "assistant", content: [{ type: "text", text: "saved reply" }] }];
  const sessions = new Sessions(f.state, async (...args) => ({ ...await runtime.createBackend(...args), messages: () => saved }));
  f.cleanup.push(() => sessions.close());
  sessions.attach(live, [{ role: "user", content: "outdated" }]); sessions.detach(id, live);
  await sessions.input(id, { input: input("new message") }, "new");
  const turns = sessions.read(id).turns;
  assert.equal(turns[0].items[0].content[0].text, "while disconnected");
  assert.equal(turns[0].items.at(-1).text, "saved reply");
  assert.equal(runtime.backends[0].sends.length, 1); assert.equal(turns.length, 2);
});
test("iOS thinking overrides are translated, validated, and applied without broadening configuration permissions", async t => {
  const f = await fixture(t), phone = await client(f.app, "ios");
  const { result } = await phone.send("thread/start", { cwd: f.config.userHome }); const id = result.thread.id;
  const params = { threadId: id, config: { model_reasoning_effort: "high" } }, before = JSON.stringify(params);
  const resumed = await phone.send("thread/resume", params);
  assert.ok(resumed.result, JSON.stringify(resumed)); assert.equal(resumed.result.reasoningEffort, "high");
  assert.equal(f.mock.backends[0].sends.length, 0); assert.equal(JSON.stringify(params), before);
  for (const config of [{ model_reasoning_effort: "invalid" }, { model_reasoning_effort: 7 }, { model_reasoning_effort: "high", sandbox_mode: "read-only" }]) {
    assert.equal((await phone.send("thread/resume", { threadId: id, config })).error.code, -32602);
  }
  assert.throws(() => desktopOptions({ effort: "low", config: { model_reasoning_effort: "high" } }), /same thinking level/);
  await f.sessions.input(id, { input: input("busy") }, "busy");
  assert.equal((await phone.send("thread/resume", { threadId: id, config: { model_reasoning_effort: "low" } })).error.code, -32602);
  assert.equal(f.sessions.read(id).reasoningEffort, "high");
});
