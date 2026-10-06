import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, client, input } from "./remote-helpers.mjs";
import { desktopOptions } from "../dist/remote/compatibility.js";

// iOS echoes this value from our own thread response when changing models/effort.
const mode = "explicitRequestOnly";

test("iOS can echo the advertised agent mode when creating, resuming and configuring a conversation", async t => {
  const { app, config, sessions, mock } = await fixture(t), c = await client(app, "phone");
  const start = await c.send("thread/start", { cwd: config.userHome, multiAgentMode: mode });
  assert.ok(start.result, JSON.stringify(start));
  const id = start.result.thread.id;
  assert.equal(start.result.multiAgentMode, mode);
  const params = { threadId: id, model: "fake/test", effort: "low", serviceTier: null, multiAgentMode: mode };
  const before = JSON.stringify(params);
  assert.deepEqual((await c.send("thread/settings/update", params)).result, {});
  assert.equal(JSON.stringify(params), before, "do not mutate request signatures or replay inputs");
  assert.equal(sessions.read(id).reasoningEffort, "low");
  assert.equal(c.events("thread/settings/updated").at(-1).params.threadSettings.multiAgentMode, mode);
  assert.ok((await c.send("thread/resume", { threadId: id, multiAgentMode: mode })).result);
  assert.ok((await c.send("turn/start", { threadId: id, multiAgentMode: mode, input: input("hello") })).result);
  assert.equal(mock.backends.length, 1);
  assert.equal(mock.backends[0].sends.length, 1);
  assert.equal(c.events("configWarning").length, 0, "echoing our actual default is not an unsupported feature");
});

test("the iOS default does not enable delegation, weaken sandbox checks or permit configuration overrides", async t => {
  const { app, mock } = await fixture(t), c = await client(app, "phone");
  for (const options of [
    { multiAgentMode: "automatic" }, { multiAgentMode: true }, { multiAgentMode: {} },
    { multiAgentMode: mode, sandbox: "read-only" },
    { multiAgentMode: mode, config: { "features.multi_agent": true } },
    { multiAgentMode: mode, dynamicTools: [{ name: "unexpected" }] },
  ]) assert.equal((await c.send("thread/start", options)).error?.code, -32602, JSON.stringify(options));
  assert.equal(mock.backends.length, 0);
  for (const value of [null, mode]) {
    const raw = Object.freeze({ multiAgentMode: value });
    assert.deepEqual(desktopOptions(raw), { params: {}, notice: false });
  }
});
