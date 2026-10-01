import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { page } from "../dist/remote/types.js";
import { fixture, client, input } from "./remote-helpers.mjs";
import { desktopConfig, desktopResume, desktopEnablement } from "./fixtures/desktop-requests.mjs";

function terminal(id, cwd) {
  return { info: { id, cwd, model: "fake/test", provider: "fake", effort: "medium", sessionFile: join(cwd, ".pi", `${id}.jsonl`) },
    sends: [], async send(input, options) { this.sends.push({ input, options }); }, abort: async () => {}, close: async () => {} };
}

test("large desktop page sizes stay bounded and cursors follow the actual returned page", () => {
  const values = Array.from({ length: 205 }, (_, i) => i);
  const first = page(values, { limit: 200 });
  assert.equal(first.data.length, 100); assert.equal(first.nextCursor, "100");
  const second = page(values, { limit: 200, cursor: first.nextCursor });
  const last = page(values, { limit: 200, cursor: second.nextCursor });
  assert.deepEqual([...first.data, ...second.data, ...last.data], values); assert.equal(last.nextCursor, null);
  assert.ok(page(values, { limit: 0 }).data.length > 0);
  for (const params of [{ limit: -1 }, { limit: 1.5 }, { limit: "200" }, { limit: Infinity }, { cursor: {} }, { cursor: "NaN" }, { cursor: "1e2" }]) assert.throws(() => page(values, params));
});

test("desktop child-thread queries do not return the parent as its own child", async t => {
  const { app, sessions, config } = await fixture(t); const c = await client(app, "desktop");
  const owner = terminal(randomUUID(), config.userHome); sessions.attach(owner);
  const created = await c.send("thread/start", { cwd: config.userHome }); const worker = created.result.thread;
  assert.deepEqual((await c.send("thread/list", { limit: 200, parentThreadId: owner.info.id, sourceKinds: ["subAgentThreadSpawn"] })).result.data, []);
  assert.deepEqual((await c.send("thread/list", { cwd: [config.userHome], sourceKinds: ["cli"] })).result.data.map(t => t.id), [owner.info.id]);
  assert.deepEqual((await c.send("thread/list", { sourceKinds: ["appServer"] })).result.data.map(t => t.id), [worker.id]);
  assert.deepEqual((await c.send("thread/list", { modelProviders: ["different"] })).result.data, []);
  assert.equal((await c.send("thread/list", { modelProviders: [], cwd: [owner.info.cwd, worker.cwd] })).result.data.length, 2);
  sessions.record(owner.info.id).thread.createdAt = 1; sessions.record(worker.id).thread.createdAt = 2;
  assert.deepEqual((await c.send("thread/list", { sortKey: "created_at", sortDirection: "asc" })).result.data.map(t => t.id), [owner.info.id, worker.id]);
});

test("desktop defaults can open and use a Pi conversation without enabling Codex features or replacing local instructions", async t => {
  const { app, sessions, config, mock } = await fixture(t); const c = await client(app, "desktop");
  const owner = terminal(randomUUID(), config.userHome);
  sessions.attach(owner, [{ role: "user", content: "old question" }, { role: "assistant", content: [{ type: "text", text: "old answer" }] }]);
  const params = { ...desktopResume, threadId: owner.info.id, path: owner.info.sessionFile, cwd: config.userHome };
  const before = JSON.stringify(params);
  const resumed = await c.send("thread/resume", params);
  assert.ok(resumed.result, JSON.stringify(resumed));
  assert.equal(resumed.result.thread.id, owner.info.id);
  assert.equal(resumed.result.approvalPolicy, "never"); assert.equal(resumed.result.sandbox.type, "dangerFullAccess");
  assert.equal((await c.send("thread/read", { threadId: owner.info.id, includeTurns: true })).result.thread.turns[0].items.at(-1).text, "old answer");
  assert.ok(c.events("configWarning").some(e => /Pi/.test(e.params.summary)));
  await c.send("thread/resume", params);
  assert.equal(c.events("configWarning").length, 1, "do not flood the desktop on every resume");
  assert.equal(JSON.stringify(params), before, "never mutate an incoming request or its replay signature");
  const reply = await c.send("turn/start", { threadId: owner.info.id, input: input("hello"),
    collaborationMode: { mode: "default", settings: { model: "fake/test", reasoning_effort: "medium", developer_instructions: "Desktop-only instructions" } } });
  assert.ok(reply.result, JSON.stringify(reply));
  assert.equal(owner.sends.length, 1); assert.deepEqual(owner.sends[0].input, input("hello"));
  assert.equal(owner.sends[0].options.model, "fake/test"); assert.equal(owner.sends[0].options.effort, "medium");
  assert.equal(mock.backends.length, 0);
  sessions.event(owner.info.id, { type: "message_start", message: { role: "user", content: "hello" } });
  sessions.event(owner.info.id, { type: "message_start", message: { role: "assistant", content: [] } });
  sessions.event(owner.info.id, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Pi reply" }], stopReason: "stop" } });
  sessions.event(owner.info.id, { type: "agent_settled" });
  assert.equal(c.events("item/completed").at(-1).params.item.text, "Pi reply");
  assert.equal(c.events("turn/completed").length, 1);
});

test("a detached terminal remains readable and subscribed but cannot start a second writer", async t => {
  const { app, sessions, config, mock } = await fixture(t); const c = await client(app, "desktop");
  const owner = terminal(randomUUID(), config.userHome); sessions.attach(owner);
  sessions.detach(owner.info.id, owner);
  const response = await c.send("thread/resume", { ...desktopResume, threadId: owner.info.id, path: owner.info.sessionFile });
  assert.ok(response.result, JSON.stringify(response));
  assert.equal(response.result.thread.canAcceptDirectInput, false); assert.equal(response.result.thread.status.type, "notLoaded");
  const rejected = await c.send("turn/start", { threadId: owner.info.id, input: input("do not run offline") });
  assert.equal(rejected.error.code, -32600); assert.match(rejected.error.message, /Pi/); assert.equal(mock.backends.length, 0);
  sessions.attach(owner);
  assert.ok(c.events("thread/status/changed").some(e => e.params.status.type === "idle"));
  assert.ok((await c.send("turn/start", { threadId: owner.info.id, input: input("after reconnect") })).result);
  assert.equal(owner.sends.length, 1); assert.equal(mock.backends.length, 0);
});

test("desktop normalization never ignores unknown settings, sandbox restrictions, foreign paths, or extra tools", async t => {
  const { app, sessions, config, mock } = await fixture(t); const c = await client(app, "desktop");
  const owner = terminal(randomUUID(), config.userHome); sessions.attach(owner);
  for (const extra of [
    { config: { sandbox_mode: "read-only" } }, { config: { "features.new_security_policy": true } },
    { config: { "features.guardian_approval": "true" } }, { config: { "features.collaboration_modes": { nested: true } } },
    { config: { "apps.connector_openai_pages.tools": { "chatgpt_space.execute_artifact_code": { enabled: true } } } },
    { approvalPolicy: "on-request" }, { sandbox: "read-only" }, { permissionProfile: "read-only" },
    { developerInstructions: { hidden: true } }, { baseInstructions: "replace Pi" }, { developerInstructions: "x".repeat(70_000) },
    { dynamicTools: [{ name: "secretTool" }] }, { collaborationMode: { mode: "plan", settings: {} } },
    { collaborationMode: { mode: "default", settings: { model: "fake/test" } }, model: "other/test" },
  ]) {
    const response = await c.send("thread/start", { cwd: config.userHome, ...extra });
    assert.equal(response.error?.code, -32602, JSON.stringify(extra).slice(0, 200));
  }
  for (const extra of [{ path: "/tmp/other-session.jsonl" }, { history: [] }]) {
    assert.equal((await c.send("thread/resume", { threadId: owner.info.id, ...extra })).error.code, -32602);
  }
  assert.equal(mock.backends.length, 0);
  assert.equal((await c.send("process/spawn", { command: ["sh", "-c", "echo forbidden"] })).error.code, -32601);
});

test("desktop capability discovery reports actual disabled features and no Codex hooks or permission profiles", async t => {
  const { app, config } = await fixture(t); const c = await client(app, "desktop");
  const features = await c.send("experimentalFeature/list", { limit: 200 });
  assert.ok(features.result.data.length > 0);
  assert.ok(features.result.data.every(f => f.enabled === false && f.defaultEnabled === false));
  const enabled = await c.send("experimentalFeature/enablement/set", { enablement: desktopEnablement });
  assert.deepEqual(enabled.result.enablement, Object.fromEntries(Object.keys(desktopEnablement).map(k => [k, false])));
  assert.ok((await c.send("experimentalFeature/list")).result.data.every(f => !f.enabled));
  assert.equal((await c.send("experimentalFeature/enablement/set", { enablement: { arbitrary: true } })).error.code, -32602);
  assert.deepEqual((await c.send("permissionProfile/list")).result, { data: [], nextCursor: null });
  assert.deepEqual((await c.send("collaborationMode/list")).result.data.map(m => m.mode), ["default"]);
  const hooks = await c.send("hooks/list", { cwds: [config.userHome] });
  assert.equal(hooks.result.data[0].cwd, config.userHome); assert.deepEqual(hooks.result.data[0].hooks, []);
  const settings = (await c.send("config/read")).result.config;
  assert.ok(Object.keys(desktopConfig).filter(k => k.startsWith("features.")).every(k => settings.features[k.slice(9)] === false));
  const requirements = (await c.send("configRequirements/read")).result.requirements;
  assert.deepEqual(requirements.allowedApprovalPolicies, ["never"]);
  assert.deepEqual(requirements.allowedSandboxModes, ["danger-full-access"]);
});
