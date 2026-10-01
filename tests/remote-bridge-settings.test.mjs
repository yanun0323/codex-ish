import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startHost } from "../dist/remote/daemon.js";
import { registerRemoteControl } from "../dist/remote/client.js";
import { fixture, client, input, eventually } from "./remote-helpers.mjs";

test("the real local bridge switches models, tracks local thinking changes, and submits selected skills and files", async t => {
  const f = await fixture(t); const { config } = f;
  const host = await startHost(config, async () => f.mock); f.cleanup.push(() => host.close());
  const env = { PI_CODEX_ISH_REMOTE_HOME: config.home, PI_CODING_AGENT_DIR: config.agentDir,
    PI_CODEX_APP_SERVER_AUTOSTART: "0", PI_CODEX_REMOTE_CONTROL: "1", PI_CODEX_ISH_WORKER: "0" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const skillPath = join(config.agentDir, "skills", "bridge", "SKILL.md");
  await mkdir(join(skillPath, ".."), { recursive: true }); await writeFile(skillPath, "---\nname: bridge\ndescription: fixture\n---\nBRIDGE_SKILL_BODY");
  const file = join(config.userHome, "notes.txt"); await writeFile(file, "notes");
  const first = { provider: "extension", id: "first", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
  const second = { ...first, id: "second" };
  const handlers = new Map(); const calls = []; let idle = true;
  const id = "actual-bridge-settings";
  const ctx = { cwd: config.userHome, model: first, thinkingLevel: "high", isIdle: () => idle,
    modelRegistry: { getAvailable: () => [first, second] }, ui: { notify() {}, requestRender() {} },
    sessionManager: { getSessionId: () => id, getBranch: () => [], getSessionFile: () => undefined, getSessionName: () => undefined } };
  const pi = { on: (name, handler) => handlers.set(name, handler), registerCommand() {},
    getCommands: () => [{ name: "skill:bridge", description: "fixture", source: "skill", sourceInfo: { path: skillPath, scope: "user" } }],
    getThinkingLevel: () => ctx.thinkingLevel,
    setModel: async model => { ctx.model = model; await handlers.get("model_select")({ type: "model_select", model }, ctx); return true; },
    setThinkingLevel: level => { ctx.thinkingLevel = level; void handlers.get("thinking_level_select")({ type: "thinking_level_select", level }, ctx); },
    sendUserMessage: content => {
      calls.push(content);
      handlers.get("message_start")({ type: "message_start", message: { role: "user", content } }, ctx);
    } };
  registerRemoteControl(pi, async () => { throw new Error("No real pairing"); });
  f.cleanup.push(async () => handlers.get("session_shutdown")());
  await handlers.get("session_start")({}, ctx); await eventually(() => host.sessions.loaded().includes(id));
  const phone = await client(host.app, "phone"); const mac = await client(host.app, "mac");
  await phone.send("thread/resume", { threadId: id }); await mac.send("thread/resume", { threadId: id });
  const models = (await mac.send("model/list")).result.data;
  assert.ok(models.some(m => m.id === "extension/second" && m.supportedReasoningEfforts.some(e => e.reasoningEffort === "xhigh")));
  const changed = await mac.send("thread/settings/update", { threadId: id, model: "extension/second", effort: "xhigh" });
  assert.deepEqual(changed.result, {}); assert.equal(ctx.model, second); assert.equal(ctx.thinkingLevel, "xhigh");
  await eventually(() => phone.events("thread/settings/updated").at(-1)?.params.threadSettings.effort === "xhigh");
  assert.equal(calls.length, 0); assert.equal(f.mock.backends.length, 0);
  assert.equal(host.sessions.read(id).model, "extension/second");
  idle = false;
  assert.equal((await phone.send("thread/settings/update", { threadId: id, effort: "low" })).error.code, -32602);
  assert.equal(ctx.thinkingLevel, "xhigh"); idle = true;
  ctx.thinkingLevel = "max";
  await handlers.get("thinking_level_select")({ type: "thinking_level_select", level: "max" }, ctx);
  await eventually(() => host.sessions.read(id).reasoningEffort === "max");
  assert.deepEqual(phone.events("thread/settings/updated"), mac.events("thread/settings/updated"));
  const listing = await mac.send("skills/list", { cwds: [config.userHome] });
  assert.equal(listing.result.data[0].skills[0].path, skillPath);
  const sent = await phone.send("turn/start", { threadId: id,
    input: [...input("$bridge inspect"), { type: "skill", name: "bridge", path: skillPath }, { type: "mention", name: "notes", path: file }] });
  assert.ok(sent.result, JSON.stringify(sent));
  assert.equal(calls.length, 1); assert.match(calls[0][0].text, /BRIDGE_SKILL_BODY/); assert.match(calls[0][0].text, /file_reference/);
  await eventually(() => phone.events("item/completed").length);
  assert.equal(host.sessions.read(id).turns[0].items.filter(i => i.type === "userMessage").length, 1);
  assert.equal(f.mock.backends.length, 0);
});
