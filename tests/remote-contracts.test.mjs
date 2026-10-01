import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Ajv from "ajv";
import { fixture, client, input, eventually } from "./remote-helpers.mjs";

const contracts = JSON.parse(await readFile(new URL("./fixtures/codex/contracts.json", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(contracts);
function valid(name, value) {
  const validate = ajv.getSchema(`codex-contracts#/definitions/${name}`);
  assert.ok(validate, name);
  assert.ok(validate(value), `${name}: ${JSON.stringify(validate.errors)}`);
}

test("initialize advertises the App Server compatibility version, not the Pi package version", async t => {
  const { app } = await fixture(t); const c = await client(app, "desktop");
  const { userAgent } = c.messages[0].result;
  // The desktop reads the first product/version token before accepting a remote host.
  const version = /^.+?\/(?<version>\S+)/.exec(userAgent)?.groups?.version;
  assert.equal(version, "0.141.0", "desktop requires App Server 0.141.0 or newer");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(userAgent.includes(`pi-codex-ish ${pkg.version}`), "keep the actual package identity visible separately");

  const start = await c.send("thread/start");
  assert.equal(start.result.thread.cliVersion, version);
  assert.equal(start.result.thread.originator, "pi-codex-ish");
  assert.ok((await c.send("model/list")).result);
  assert.ok((await c.send("config/read")).result);
  assert.ok((await c.send("thread/list")).result);
  // A compatible version must not silently acknowledge APIs the Pi host cannot implement.
  assert.equal((await c.send("unsupported/desktopMethod")).error.code, -32601);
});

test("implemented responses match the pinned upstream Codex schemas", async t => {
  const { app, config } = await fixture(t); const c = await client(app, "app");
  valid("InitializeResponse", c.messages[0].result);
  for (const [method, schema, params] of [
    ["config/read", "ConfigReadResponse", { includeLayers: true }], ["account/read", "GetAccountResponse"], ["model/list", "ModelListResponse"],
    ["fs/readDirectory", "FsReadDirectoryResponse", { path: config.userHome }], ["fs/getMetadata", "FsGetMetadataResponse", { path: config.userHome }],
    ["fs/createDirectory", "FsCreateDirectoryResponse", { path: join(config.userHome, "project") }],
    ["command/exec", "CommandExecResponse", { command: ["pwd"] }],
  ]) {
    const response = await c.send(method, params); assert.ok(response.result, JSON.stringify(response)); valid(schema, response.result);
  }
  const start = await c.send("thread/start", { cwd: config.userHome }); valid("ThreadStartResponse", start.result);
  const id = start.result.thread.id;
  const project = await c.send("project/create", { name: "Project", roots: [{ path: config.userHome }], idempotencyKey: "one" }); valid("Project", project.result.project);
  for (const [method, schema, params] of [
    ["thread/list", "ThreadListResponse", {}], ["thread/read", "ThreadReadResponse", { threadId: id, includeTurns: true }],
    ["thread/resume", "ThreadResumeResponse", { threadId: id }],
    ["thread/unsubscribe", "ThreadUnsubscribeResponse", { threadId: id }],
    ["thread/unsubscribe", "ThreadUnsubscribeResponse", { threadId: id }],
    ["turn/start", "TurnStartResponse", { threadId: id, input: input("hello") }],
    ["thread/turns/list", "ThreadTurnsListResponse", { threadId: id }],
    ["thread/items/list", "ThreadItemsListResponse", { threadId: id }],
  ]) {
    const response = await c.send(method, params); assert.ok(response.result, JSON.stringify(response)); valid(schema, response.result);
  }
});

test("model settings, skill discovery, and filename search match the pinned upstream contracts", async t => {
  const validators = new Map();
  for (const name of ["ThreadSettingsUpdatedNotification", "SkillsListResponse", "FuzzyFileSearchResponse",
    "FuzzyFileSearchSessionUpdatedNotification", "FuzzyFileSearchSessionCompletedNotification"]) {
    const schema = JSON.parse(await readFile(new URL(`./fixtures/codex/${name}.json`, import.meta.url), "utf8"));
    validators.set(name, ajv.compile(schema));
  }
  const check = (name, value) => {
    const validate = validators.get(name);
    assert.ok(validate(value), `${name}: ${JSON.stringify(validate.errors)}`);
  };
  const { app, config } = await fixture(t); const c = await client(app, "app");
  const path = join(config.userHome, "SKILL.md"); await writeFile(path, "fixture");
  await mkdir(join(config.userHome, "skill-folder"));
  app.options.skills = async () => [{ name: "test", path, description: "Test skill", scope: "user" }];
  check("SkillsListResponse", (await c.send("skills/list", { cwds: [config.userHome] })).result);
  check("FuzzyFileSearchResponse", (await c.send("fuzzyFileSearch", { query: "skill", roots: [config.userHome] })).result);
  await c.send("fuzzyFileSearch/sessionStart", { sessionId: "schema", roots: [config.userHome] });
  await c.send("fuzzyFileSearch/sessionUpdate", { sessionId: "schema", query: "skill" });
  await eventually(() => c.events("fuzzyFileSearch/sessionCompleted").length);
  check("FuzzyFileSearchSessionUpdatedNotification", c.events("fuzzyFileSearch/sessionUpdated")[0].params);
  check("FuzzyFileSearchSessionCompletedNotification", c.events("fuzzyFileSearch/sessionCompleted")[0].params);
  const { result: { thread } } = await c.send("thread/start", { cwd: config.userHome });
  await c.send("thread/settings/update", { threadId: thread.id, effort: "xhigh" });
  check("ThreadSettingsUpdatedNotification", c.events("thread/settings/updated")[0].params);
  valid("ThreadResumeResponse", (await c.send("thread/resume", { threadId: thread.id })).result);
  valid("ThreadItem", { type: "userMessage", id: "selected", clientId: null,
    content: [{ type: "skill", name: "test", path }, { type: "mention", name: "folder", path: join(config.userHome, "skill-folder") }] });
});

test("streamed text, reasoning, tools, and turn events match upstream notification schemas", async t => {
  const { app, config, mock } = await fixture(t); const c = await client(app, "app");
  const start = await c.send("thread/start", { cwd: config.userHome }); const id = start.result.thread.id;
  await c.send("turn/start", { threadId: id, input: input("work") });
  const { emit } = mock.backends[0];
  emit({ type: "message_start", message: { role: "assistant", content: [] } });
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "reason", contentIndex: 0 } });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "reason" }], stopReason: "stop" } });
  for (const toolName of ["bash", "read"]) {
    emit({ type: "tool_execution_start", toolName, toolCallId: toolName, args: { command: "pwd" } });
    emit({ type: "tool_execution_end", toolName, toolCallId: toolName, result: { content: [{ type: "text", text: "result" }] }, isError: false });
  }
  mock.backends[0].answer("finished");
  const types = {
    "thread/started": "ThreadStartedNotification", "thread/status/changed": "ThreadStatusChangedNotification",
    "turn/started": "TurnStartedNotification", "turn/completed": "TurnCompletedNotification",
    "item/started": "ItemStartedNotification", "item/completed": "ItemCompletedNotification",
    "item/agentMessage/delta": "AgentMessageDeltaNotification", "item/reasoning/textDelta": "ReasoningTextDeltaNotification",
    "item/commandExecution/outputDelta": "CommandExecutionOutputDeltaNotification",
  };
  for (const [method, schema] of Object.entries(types)) {
    assert.ok(c.events(method).length, method);
    for (const event of c.events(method)) valid(schema, event.params);
  }
});
