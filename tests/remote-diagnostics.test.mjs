import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, stat, readdir, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RemoteDiagnostics, diagnosticError, diagnosticShape } from "../dist/remote/diagnostics.js";
import { RpcError } from "../dist/remote/types.js";
import { Relay } from "../dist/remote/relay.js";
import { startHost } from "../dist/remote/daemon.js";
import { fixture, client, input, eventually } from "./remote-helpers.mjs";

const records = async path => (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

test("request logs correlate failures, successes, replays, and wire shapes without saving content or credentials", async t => {
  const { app, config } = await fixture(t); const c = await client(app, "desktop");
  const id = randomUUID();
  const bad = { path: join(config.userHome, ".codex", "auth.json"), token: "PRIVATE_TOKEN", input: input("PRIVATE_PROMPT"),
    config: { PRIVATE_KEY_NAME: "PRIVATE_VALUE" } };
  const first = await c.send("fs/readFile", bad, id);
  assert.equal(first.error.code, -32600);
  assert.deepEqual(await c.send("fs/readFile", bad, id), first);
  const thread = (await c.send("thread/start")).result.thread;
  await c.send("turn/start", { threadId: thread.id, input: input("PRIVATE_PROMPT") });
  app.options.models = async () => { throw Object.assign(new Error("PRIVATE_BODY Bearer PRIVATE_TOKEN"), { code: "ECONNRESET", cause: new Error("PRIVATE_CAUSE") }); };
  assert.equal((await c.send("model/list")).error.code, -32603);
  const raw = await readFile(app.diagnostics.path, "utf8");
  for (const secret of ["PRIVATE_TOKEN", "PRIVATE_PROMPT", "PRIVATE_KEY_NAME", "PRIVATE_VALUE", "PRIVATE_BODY", "PRIVATE_CAUSE", bad.path]) assert.ok(!raw.includes(secret), secret);
  const entries = await records(app.diagnostics.path);
  const failure = entries.find(e => e.event === "request/error" && e.requestId === id);
  assert.equal(failure.method, "fs/readFile"); assert.equal(failure.error.code, -32600);
  assert.equal(failure.error.message, "This path is not shared with Remote.");
  assert.equal(failure.path.location, "codex"); assert.ok(failure.error.frames.length);
  assert.equal(entries.filter(e => e.event === "request/error" && e.requestId === id).length, 1);
  assert.ok(entries.some(e => e.event === "response" && e.requestId === id && e.replayed));
  assert.ok(entries.some(e => e.event === "response" && e.method === "turn/start" && e.outcome === "ok"));
  assert.ok(raw.includes('"text_elements"'), "successful response shape helps diagnose desktop rendering errors");
  assert.ok(entries.some(e => e.event === "request/error" && e.error.code === "ECONNRESET"));
  assert.equal((await stat(app.diagnostics.path)).mode & 0o777, 0o600);
  assert.equal((await stat(config.home)).mode & 0o777, 0o700);
});

test("attachment diagnostics classify file URLs and tilde paths without recording image bytes or names", async t => {
  const { app, config } = await fixture(t); const c = await client(app, "ios");
  const folder = join(c.messages[0].result.codexHome, "attachments", randomUUID());
  const path = pathToFileURL(join(folder, "PRIVATE_SCREENSHOT.png")).href;
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("PRIVATE_IMAGE_CONTENT")]).toString("base64");
  await c.send("fs/createDirectory", { path: pathToFileURL(folder).href, recursive: true });
  await c.send("fs/writeFile", { path, dataBase64: bytes });
  await c.send("fs/readFile", { path });
  await c.send("fs/readDirectory", { path: "~" });
  const raw = await readFile(app.diagnostics.path, "utf8");
  for (const secret of [bytes, folder, config.userHome, "PRIVATE_SCREENSHOT", "PRIVATE_IMAGE_CONTENT"]) assert.ok(!raw.includes(secret), secret);
  const entries = await records(app.diagnostics.path);
  const upload = entries.find(e => e.event === "request" && e.method === "fs/writeFile");
  assert.equal(upload.path.format, "fileUrl"); assert.equal(upload.path.location, "codex"); assert.equal(upload.path.attachment, true);
  assert.equal(entries.find(e => e.event === "request" && e.method === "fs/readDirectory").path.location, "home");
  assert.ok(entries.some(e => e.event === "response" && e.method === "fs/writeFile" && e.outcome === "ok"));
});

test("invalid requests, collisions, and response delivery failures are logged without changing protocol behavior", async t => {
  const { app } = await fixture(t); const c = await client(app, "desktop");
  await app.receive(c.connection, { id: 90, method: { token: "PRIVATE_METHOD" } });
  assert.equal(c.messages.at(-1).error.code, -32600);
  await c.send("thread/list", {}, 91);
  assert.equal((await c.send("model/list", {}, 91)).error.code, -32600);
  c.connection.send = () => { throw new Error("PRIVATE_SEND_FAILURE"); };
  await assert.rejects(app.receive(c.connection, { id: 92, method: "thread/list" }), /PRIVATE_SEND_FAILURE/);
  const entries = await records(app.diagnostics.path);
  assert.ok(entries.some(e => e.event === "response" && e.requestId === 90 && e.errorCode === -32600));
  assert.ok(entries.some(e => e.event === "response" && e.requestId === 91 && e.errorCode === -32600));
  assert.ok(entries.some(e => e.event === "response/send_error" && e.requestId === 92));
  assert.ok(!JSON.stringify(entries).includes("PRIVATE_"));
});

test("diagnostic shapes and errors are bounded and do not retain arbitrary string fields or stack messages", () => {
  const cyclic = { text: "PRIVATE_PROMPT", token: "PRIVATE_TOKEN", type: "PRIVATE_TYPE", PRIVATE_KEY: "value" };
  cyclic.input = [cyclic];
  const shape = JSON.stringify(diagnosticShape(cyclic));
  assert.ok(!shape.includes("PRIVATE_")); assert.ok(shape.length < 10_000);
  const search = diagnosticShape({ query: "PRIVATE_QUERY", sessionId: "PRIVATE_SESSION", skills: [{ name: "PRIVATE_SKILL" }],
    files: [{ path: "/PRIVATE_FILE", file_name: "PRIVATE_NAME", match_type: "file" }] });
  assert.equal(search.query.type, "string"); assert.equal(search.files.length, 1); assert.equal(search.skills.length, 1);
  assert.ok(!JSON.stringify(search).includes("PRIVATE_"));
  const raw = new Error("PRIVATE_ERROR"); raw.stack = "Error: PRIVATE_ERROR\n    at file:///private/source/server.js:10:20\n    at PRIVATE_STACK";
  const result = diagnosticError(raw);
  assert.deepEqual(result.frames, ["server.js:10:20"]);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
  assert.equal(diagnosticError(new TypeError("Cannot read properties of undefined (reading 'some')")).message, "Cannot read properties of undefined (reading 'some')");
  for (const message of ["This Pi host does not support PRIVATE_METHOD.", "Input type PRIVATE_INPUT is not supported. Use text or images.", "Failure Bearer PRIVATE_TOKEN", "Failure access_token=PRIVATE_TOKEN"]) {
    assert.ok(!JSON.stringify(diagnosticError(new RpcError(-32602, message))).includes("PRIVATE_"));
  }
});

test("diagnostic logs rotate into one bounded private backup and can be disabled", async t => {
  const { config } = await fixture(t);
  const logger = new RemoteDiagnostics(config, true, 1024);
  for (let i = 0; i < 80; i++) logger.event("host/started");
  for (const file of [logger.path, logger.path + ".1"]) {
    assert.ok((await stat(file)).size <= 1024); assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok((await records(file)).length);
  }
  assert.deepEqual((await readdir(config.home)).filter(name => name.startsWith("debug-remote")).sort(), ["debug-remote.jsonl", "debug-remote.jsonl.1"]);
  const off = new RemoteDiagnostics({ ...config, home: join(config.home, "disabled") }, false);
  off.request({ method: "test", params: { text: "private" } }, "test"); off.failure("request/error", new Error("private")); off.event("host/started");
  await assert.rejects(stat(off.path), { code: "ENOENT" }); assert.deepEqual(off.status(), { enabled: false, path: null, writeError: null });
});

test("logging failures and symlinks cannot break requests or overwrite other files", async t => {
  const { app, config, root } = await fixture(t);
  const victim = join(root, "untouched"); await writeFile(victim, "unchanged", { mode: 0o644 });
  await symlink(victim, app.diagnostics.path);
  const c = await client(app, "desktop"); assert.ok((await c.send("thread/list")).result);
  assert.equal(await readFile(victim, "utf8"), "unchanged"); assert.equal((await stat(victim)).mode & 0o777, 0o644);
  assert.ok(app.diagnostics.status().writeError);
  const directoryLogger = new RemoteDiagnostics({ ...config, home: join(config.home, "bad") });
  await mkdir(directoryLogger.path, { recursive: true });
  assert.doesNotThrow(() => directoryLogger.event("host/started")); assert.ok(directoryLogger.status().writeError);
});

test("host exposes log status and relay connection failures reach the diagnostic callback", async t => {
  const f = await fixture(t);
  const host = await startHost(f.config, async () => f.mock); f.cleanup.push(() => host.close());
  const status = host.status().diagnosticLog;
  assert.equal(status.enabled, true); assert.equal(status.writeError, null);
  assert.ok((await records(status.path)).some(e => e.event === "host/started"));
  const failure = Object.assign(new Error("PRIVATE_UPSTREAM_BODY"), { code: "ECONNREFUSED" });
  const relay = new Relay({ connection: async () => { throw failure; }, retryAt: 0 }, async () => {}, () => {}, () => {},
    error => host.app.diagnostics.failure("relay/error", error));
  f.cleanup.push(() => relay.stop());
  relay.start(); await eventually(() => relay.status === "errored"); await relay.stop();
  assert.ok((await records(status.path)).some(e => e.event === "relay/error" && e.error.code === "ECONNREFUSED"));
  assert.ok(!(await readFile(status.path, "utf8")).includes("PRIVATE_UPSTREAM_BODY"));
  await host.close(); assert.ok((await records(status.path)).some(e => e.event === "host/stopped"));
});
