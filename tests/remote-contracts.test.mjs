import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Ajv from "ajv";
import { fixture, client, input } from "./remote-helpers.mjs";

const contracts = JSON.parse(await readFile(new URL("./fixtures/codex/contracts.json", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(contracts);
function valid(name, value) {
  const validate = ajv.getSchema(`codex-contracts#/definitions/${name}`);
  assert.ok(validate, name);
  assert.ok(validate(value), `${name}: ${JSON.stringify(validate.errors)}`);
}

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
