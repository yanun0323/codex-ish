import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { Sessions } from "../dist/remote/sessions.js";
import { hostThinkingLevels, modelCatalog, resolveModel, validateModelOptions } from "../dist/remote/models.js";
import { fixture, client, input, model } from "./remote-helpers.mjs";

const levels = await hostThinkingLevels(resolve(process.env.PI_REMOTE_TEST_SDK ?? "node_modules/@earendil-works/pi-coding-agent/dist/index.js"));

test("model catalog uses Pi capabilities rather than a hardcoded thinking menu", () => {
  const plain = { provider: "fixture", id: "plain", reasoning: false };
  const reasoning = { provider: "fixture", id: "reasoning", reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" } };
  const catalog = modelCatalog([plain, reasoning], levels, "fixture/reasoning");
  assert.deepEqual(catalog[0].supportedReasoningEfforts.map(e => e.reasoningEffort), ["none"]);
  assert.deepEqual(catalog[1].supportedReasoningEfforts.map(e => e.reasoningEffort), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(catalog[0].isDefault, false); assert.equal(catalog[1].isDefault, true);
  assert.throws(() => validateModelOptions({ effort: "xhigh" }, plain, levels), /supported/);
  assert.throws(() => validateModelOptions({ effort: "none" }, reasoning, levels), /supported/);
  assert.doesNotThrow(() => validateModelOptions({ effort: "xhigh" }, reasoning, levels));
  assert.equal(resolveModel([plain, reasoning], "fixture/reasoning"), reasoning);
  assert.throws(() => resolveModel([plain, { ...plain, provider: "other" }], "plain"), /available model/);
});

test("idle model changes reach both clients, persist, and never send a prompt", async t => {
  const { app, config, state, sessions, mock } = await fixture(t);
  const a = await client(app, "phone"); const b = await client(app, "desktop");
  const start = await a.send("thread/start", { cwd: config.userHome }); const id = start.result.thread.id;
  await b.send("thread/resume", { threadId: id });
  const changed = await a.send("thread/settings/update", { threadId: id, model: "fake/other", effort: "xhigh", serviceTier: null });
  assert.deepEqual(changed.result, {});
  assert.equal(mock.backends[0].info.model, "fake/other"); assert.equal(mock.backends[0].info.effort, "xhigh");
  assert.equal(mock.backends[0].sends.length, 0); assert.equal(sessions.read(id).turns.length, 0);
  assert.deepEqual(a.events("thread/settings/updated"), b.events("thread/settings/updated"));
  const settings = b.events("thread/settings/updated").at(-1).params.threadSettings;
  assert.equal(settings.model, "fake/other"); assert.equal(settings.effort, "xhigh");
  assert.equal(settings.collaborationMode.settings.model, "fake/other");
  const response = (await b.send("thread/resume", { threadId: id })).result;
  assert.equal(response.model, "fake/other"); assert.equal(response.reasoningEffort, "xhigh");
  assert.equal(response.collaborationMode.settings.reasoning_effort, "xhigh");
  const configRead = (await b.send("config/read", { cwd: config.userHome })).result.config;
  assert.equal(configRead.model, "fake/other"); assert.equal(configRead.model_provider, "fake"); assert.equal(configRead.model_reasoning_effort, "xhigh");
  const restored = new Sessions(state, mock.createBackend);
  assert.equal(restored.read(id).model, "fake/other"); assert.equal(restored.read(id).reasoningEffort, "xhigh");
  await restored.close();
});

test("settings reject unsupported options and busy or detached sessions without lying about changes", async t => {
  const { app, config, sessions, mock } = await fixture(t); const c = await client(app, "app");
  const { result: { thread } } = await c.send("thread/start", { cwd: config.userHome }); const id = thread.id;
  for (const extra of [{ model: "missing" }, { effort: "ultra" }, { effort: {} }, { model: 42 }, { cwd: "/elsewhere" },
    { summary: "detailed" }, { serviceTier: "fast" }, { permissions: "read-only" }, { sandboxPolicy: { type: "readOnly" } },
    { config: { "features.unknown": true } }, { disabledPluginIds: ["plugin"] }]) {
    const result = await c.send("thread/settings/update", { threadId: id, ...extra });
    assert.equal(result.error?.code, -32602, JSON.stringify(extra));
    assert.equal(sessions.read(id).model, "fake/test"); assert.equal(sessions.read(id).reasoningEffort, "medium");
  }
  await c.send("turn/start", { threadId: id, input: input("busy") });
  assert.equal((await c.send("thread/settings/update", { threadId: id, effort: "high" })).error.code, -32602);
  mock.backends[0].answer("done");
  const owner = { ...mock.backends[0], info: { ...mock.backends[0].info, id: "live-settings" } };
  sessions.attach(owner); sessions.detach(owner.info.id, owner);
  const failed = await c.send("thread/settings/update", { threadId: owner.info.id, effort: "high" });
  assert.match(failed.error.message, /Pi/); assert.equal(mock.backends.length, 1);
});

test("local settings events refresh the thread and add extension models to the remote catalog", async t => {
  const { app, sessions, config } = await fixture(t); const c = await client(app, "app");
  const extra = { ...model, id: "extension/current", model: "extension/current", isDefault: true };
  const info = { id: "live-model", cwd: config.userHome, model: "fake/test", provider: "fake", effort: "medium", models: [extra] };
  sessions.attach({ info, send: async () => {}, abort: async () => {}, close: async () => {} });
  await c.send("thread/resume", { threadId: info.id });
  sessions.event(info.id, { type: "remote_settings_changed", info: { model: extra.id, provider: "extension", effort: "max", models: [extra] } });
  const catalog = (await c.send("model/list")).result.data;
  assert.equal(catalog.filter(m => m.isDefault).length, 1);
  assert.equal(catalog.find(m => m.isDefault).id, extra.id);
  assert.equal((await c.send("thread/resume", { threadId: info.id })).result.reasoningEffort, "max");
  assert.equal(c.events("thread/settings/updated").length, 1);
  sessions.event(info.id, { type: "remote_settings_changed", info: { model: extra.id, provider: "extension", effort: "max" } });
  assert.equal(c.events("thread/settings/updated").length, 1, "unchanged state is not repeatedly broadcast");
});
