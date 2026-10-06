import assert from "node:assert/strict";
import { test } from "node:test";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { fixture, client, eventually } from "./remote-helpers.mjs";

// The exact iOS request shape observed on 2026-10-02. No device IDs or user paths.
const probe = (overrides = {}) => ({
  command: ["/bin/sh", "-c", "printf '\\0'; exec \"$@\"", "codex-read-only", "/bin/sh", "-lc", 'cd "$HOME" && pwd -P'],
  cwd: "/", sandboxPolicy: { type: "readOnly", networkAccess: false },
  env: { BASH_ENV: null, ENV: null }, timeoutMs: 20000, outputBytesCap: 4097, processId: "home-probe", streamStdoutStderr: true, ...overrides,
});
const output = c => Buffer.concat(c.events("command/exec/outputDelta").map(e => Buffer.from(e.params.deltaBase64, "base64")));

test("the actual iOS HOME probe streams its NUL marker and physical home before the response, only to its caller", async t => {
  const { app, files, config, mock } = await fixture(t), phone = await client(app, "phone"), mac = await client(app, "mac");
  await files.directory(config.userHome);
  const roots = [...files.roots];
  const response = await phone.send("command/exec", probe());
  assert.deepEqual(response.result, { exitCode: 0, stdout: "", stderr: "" });
  assert.equal(output(phone).toString(), "\0" + await realpath(config.userHome) + "\n");
  assert.deepEqual(phone.events("command/exec/outputDelta")[0].params, {
    processId: "home-probe", stream: "stdout", deltaBase64: output(phone).toString("base64"), capReached: false,
  });
  assert.equal(phone.messages.at(-1).id, response.id);
  assert.equal(mac.events("command/exec/outputDelta").length, 0);
  assert.equal(mock.backends.length, 0, "directory queries do not start Pi or call a model");
  assert.deepEqual([...files.roots], roots);
  await assert.rejects(files.list("/"), /not shared/);
});

test("directory discovery supports buffered results and byte-accurate stream caps", async t => {
  const { app, config } = await fixture(t), c = await client(app, "phone");
  const buffered = await c.send("command/exec", probe({ streamStdoutStderr: false, processId: null, cwd: config.userHome }));
  assert.equal(buffered.result.stdout, "\0" + await realpath(config.userHome) + "\n");
  assert.equal(c.events("command/exec/outputDelta").length, 0);
  assert.ok((await c.send("command/exec", probe({ outputBytesCap: 3 }))).result);
  assert.equal(output(c).length, 3);
  assert.equal(c.events("command/exec/outputDelta").at(-1).params.capReached, true);
  assert.ok((await c.send("command/exec", probe({ outputBytesCap: 0 }))).result);
  assert.equal(c.events("command/exec/outputDelta").at(-1).params.deltaBase64, "");
  assert.equal(c.events("command/exec/outputDelta").at(-1).params.capReached, true);
});

test("the iOS wrapper cannot enable shell execution, inject paths, override HOME, or relax conversation restrictions", async t => {
  const { app, config, root } = await fixture(t), c = await client(app, "phone");
  const target = join(config.userHome, "must-not-exist");
  for (const options of [
    { command: [...probe().command.slice(0, -1), `cd "$HOME" && pwd -P; touch '${target}'`] },
    { command: [...probe().command, "extra"] },
    { command: ["/bin/sh", "-c", "printf '\\0'; eval \"$@\"", ...probe().command.slice(3)] },
    { cwd: root }, { env: { HOME: root } }, { env: { HOME: null } }, { env: { BASH_ENV: target } },
    { env: { BASH_ENV: null, ENV: target } }, { env: { ENV: null, BASH_ENV: "" } },
    { sandboxPolicy: { type: "readOnly", networkAccess: true } },
    { sandboxPolicy: { type: "readOnly", networkAccess: false, writableRoots: [root] } },
    { sandboxPolicy: { type: "dangerFullAccess" } }, { approvalPolicy: "on-request" },
    { tty: true }, { streamStdin: true }, { streamStdoutStderr: "yes" }, { processId: "" },
    { disableTimeout: true }, { disableOutputCap: true }, { timeoutMs: 0 }, { timeoutMs: 60001 },
    { outputBytesCap: -1 }, { outputBytesCap: 1024 * 1024 + 1 }, { outputBytesCap: 1.5 },
  ]) assert.ok((await c.send("command/exec", probe(options))).error, JSON.stringify(options));
  assert.equal(c.events("command/exec/outputDelta").length, 0);
  await assert.rejects(stat(target), { code: "ENOENT" });
  assert.ok((await c.send("thread/start", { sandbox: "read-only" })).error);
});

test("directory streams require initialization and stop on disconnect", async t => {
  const { app, files } = await fixture(t), messages = [];
  const raw = app.connect("uninitialized", "uninitialized", m => messages.push(m));
  await app.receive(raw, { id: 1, method: "command/exec", params: probe() });
  assert.equal(messages[0].error.code, -32600); assert.equal(messages.length, 1);
  const c = await client(app, "phone"), original = files.directory.bind(files);
  let release, entered = false;
  const gate = new Promise(resolve => release = resolve);
  files.directory = async value => { entered = true; await gate; return original(value); };
  const pending = c.send("command/exec", probe()); await eventually(() => entered);
  const duplicate = await c.send("command/exec", probe());
  assert.match(duplicate.error.message, /already in use/);
  c.close(); assert.ok((await pending).error); release();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(c.events("command/exec/outputDelta").length, 0);
});
