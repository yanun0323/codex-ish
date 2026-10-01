// Real SDK, separate terminal processes, original JSONL, real IPC, and a local fake model.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HostFiles } from "../../dist/remote/filesystem.js";
import { config } from "../../dist/remote/config.js";
import { PiRuntime } from "../../dist/remote/runtime.js";
import { SessionOwners, processAlive } from "../../dist/remote/ownership.js";
import { startHost } from "../../dist/remote/daemon.js";
import { client, eventually, input } from "../remote-helpers.mjs";
const cfg = config(); await mkdir(cfg.home, { recursive: true });
const sdkPath = resolve(process.argv[2]);
const requests = [], children = []; let hangNext = false;
const http = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
  if (hangNext) { hangNext = false; return; }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: `chatcmpl-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "model" };
  for (const item of [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: `Reply ${requests.length}` }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]) response.write(`data: ${JSON.stringify(item)}\n\n`);
  response.end("data: [DONE]\n\n");
});
http.listen(0, "127.0.0.1"); await once(http, "listening");
const baseUrl = `http://127.0.0.1:${http.address().port}/v1`;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => { assert.ok(String(url).startsWith(baseUrl + "/")); return nativeFetch(url, options); };
await writeFile(join(cfg.agentDir, "models.json"), JSON.stringify({ providers: { "handoff-test": { api: "openai-completions", baseUrl,
  apiKey: "fake-key", models: [{ id: "model", name: "model", reasoning: true, input: ["text"], contextWindow: 32768, maxTokens: 128,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
const owners = new SessionOwners(cfg.database, processAlive, async () => children.filter(child => child.exitCode === null && child.signalCode === null).map(child => child.pid));
const createRuntime = async files => {
  const runtime = await PiRuntime.create(cfg, files, sdkPath, owners);
  return { credentials: async () => { throw new Error("No cloud login in tests"); }, models: () => runtime.models(), skills: cwd => runtime.skills(cwd), createBackend: runtime.createBackend };
};
let host = await startHost(cfg, createRuntime);
async function terminal(file) {
  const child = fork("tests/fixtures/sdk-terminal.mjs", [sdkPath, ...(file ? [file] : [])], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { PATH: process.env.PATH, HOME: cfg.userHome, PI_CODING_AGENT_DIR: cfg.agentDir, PI_CODEX_ISH_REMOTE_HOME: cfg.home,
      PI_CODEX_ISH_SDK: sdkPath, PI_CODEX_ISH_WORKER: "0", PI_CODEX_APP_SERVER_AUTOSTART: "0", TEST_MODEL_URL: baseUrl } });
  children.push(child); let stderr = ""; child.stderr.on("data", value => { stderr += value; });
  const ready = await new Promise((resolve, reject) => { child.once("message", resolve); child.once("exit", () => reject(new Error(stderr || "Terminal exited before ready"))); });
  let sequence = 0;
  const call = (action, extra = {}) => new Promise((resolve, reject) => {
    const request = ++sequence;
    const timer = setTimeout(() => { child.off("message", receive); reject(new Error("Terminal request timed out: " + action + " " + stderr)); }, 15000);
    const receive = message => { if (message.request !== request) return; clearTimeout(timer); child.off("message", receive); message.error ? reject(new Error(message.error)) : resolve(message.result); };
    child.on("message", receive); child.send({ action, request, ...extra });
  });
  return { child, ...ready, call };
}
try {
  let local = await terminal(); const { id, file } = local;
  await eventually(() => host.sessions.loaded().includes(id));
  await local.call("prompt", { text: "Remember LOCAL_HISTORY_SENTINEL. Say hello without using tools." });
  await eventually(() => host.sessions.read(id).turns.at(-1).status === "completed");
  const originalTurn = host.sessions.read(id).turns[0].id;
  const exited = once(local.child, "exit"); await local.call("quit"); await exited;
  await eventually(() => !host.sessions.loaded().includes(id));
  let phone = await client(host.app, "ios");
  const before = await readFile(file);
  const resume = await phone.send("thread/resume", { threadId: id, config: { model_reasoning_effort: "high" } });
  assert.ok(resume.result, JSON.stringify(resume)); assert.equal(resume.result.thread.canAcceptDirectInput, true);
  assert.equal(host.sessions.loaded().length, 0); assert.equal(requests.length, 1); assert.deepEqual(await readFile(file), before);
  const mobile = { threadId: id, input: input("Continue on the phone. Say hello without tools."), clientUserMessageId: "phone-once" };
  const [sent, retry] = await Promise.all([phone.send("turn/start", mobile), phone.send("turn/start", mobile)]);
  assert.ok(sent.result, JSON.stringify(sent)); assert.ok(retry.result);
  await eventually(() => host.sessions.read(id).turns.at(-1).status === "completed", 10000);
  assert.equal(requests.length, 2); assert.match(JSON.stringify(requests[1]), /LOCAL_HISTORY_SENTINEL/);
  assert.equal(host.sessions.read(id).turns[0].id, originalTurn);
  assert.equal(host.sessions.record(id).sessionFile, file); assert.match(await readFile(file, "utf8"), /Reply 2/);
  // Reopening the same file in a real Pi process retires the idle worker and keeps fresh context.
  local = await terminal(file); assert.equal(local.id, id);
  await eventually(() => host.sessions.record(id).owner === "live");
  await local.call("prompt", { text: "Back in Pi. Say hello without tools." });
  assert.equal(requests.length, 3); assert.match(JSON.stringify(requests[2]), /Continue on the phone/); assert.match(JSON.stringify(requests[2]), /Reply 2/);
  await eventually(() => host.sessions.read(id).turns.at(-1).status === "completed");
  // Exit during a real SDK request. Its interrupted input is not automatically retried.
  hangNext = true;
  local.child.send({ action: "prompt", request: 999, text: "Interrupted request must not repeat" });
  await eventually(() => requests.length === 4);
  await eventually(() => host.sessions.read(id).turns.at(-1).status === "inProgress");
  const killed = once(local.child, "exit"); local.child.kill("SIGKILL"); await killed;
  await eventually(() => !host.sessions.loaded().includes(id));
  assert.equal(host.sessions.read(id).turns.at(-1).status, "interrupted");
  assert.ok((await phone.send("thread/resume", { threadId: id })).result); assert.equal(requests.length, 4);
  const continued = await phone.send("turn/start", { threadId: id, input: input("After terminal exit. Say hello without tools."), clientUserMessageId: "after-exit" });
  assert.ok(continued.result, JSON.stringify(continued));
  await eventually(() => host.sessions.read(id).turns.at(-1).status === "completed", 10000);
  assert.equal(requests.length, 5); assert.match(JSON.stringify(requests[4]), /Back in Pi/);
  await host.close(); host = await startHost(cfg, createRuntime); phone = await client(host.app, "ios-restored", "ios");
  const restored = await phone.send("thread/resume", { threadId: id }); assert.ok(restored.result, JSON.stringify(restored));
  assert.equal(restored.result.thread.id, id); assert.equal(restored.result.thread.turns.at(-1).items.at(-1).text, "Reply 5");
  assert.equal(requests.length, 5); assert.ok((await phone.send("turn/start", mobile)).result); assert.equal(requests.length, 5);
  assert.equal(JSON.parse((await readFile(file, "utf8")).split("\n")[0]).id, id);
  // Missing sessions fail without creating an empty replacement.
  await host.close();
  const { rename } = await import("node:fs/promises"); await rename(file, file + ".saved");
  host = await startHost(cfg, createRuntime); phone = await client(host.app, "missing");
  const missing = await phone.send("turn/start", { threadId: id, input: input("must not create a new session") });
  assert.ok(missing.error); await assert.rejects(stat(file), { code: "ENOENT" }); assert.equal(requests.length, 5);
  // The worker must restore the selected branch and Pi's compaction context, not rebuild a text transcript.
  const sdk = await import(pathToFileURL(sdkPath).href), manager = sdk.SessionManager.create(cfg.userHome);
  const assistant = (await readFile(file + ".saved", "utf8")).trim().split("\n").map(line => JSON.parse(line)).find(entry => entry.message?.role === "assistant").message;
  manager.appendModelChange("handoff-test", "model"); manager.appendThinkingLevelChange("high");
  manager.appendMessage({ role: "user", content: "COMPACTED_OLD_MUST_NOT_RETURN", timestamp: Date.now() });
  manager.appendMessage({ ...assistant, content: [{ type: "text", text: "Earlier response" }] });
  manager.appendCompaction("COMPACTION_SENTINEL", null, 100);
  const parent = manager.appendMessage({ role: "user", content: "Choose the saved branch", timestamp: Date.now() });
  const selected = manager.appendMessage({ ...assistant, content: [{ type: "text", text: "SELECTED_BRANCH_SENTINEL" }] });
  manager.branch(parent); manager.appendMessage({ ...assistant, content: [{ type: "text", text: "ABANDONED_BRANCH_MUST_NOT_RETURN" }] });
  manager.branch(selected);
  const branchId = manager.getSessionId(), branchFile = manager.getSessionFile();
  const lease = owners.claim(branchId, branchFile, "live"); owners.release(lease, selected);
  const shutdownMarker = join(cfg.home, "extension-stopped");
  await mkdir(join(cfg.agentDir, "extensions"), { recursive: true });
  await writeFile(join(cfg.agentDir, "extensions", "shutdown.ts"), `import {writeFileSync} from 'node:fs'; export default pi => pi.on('session_shutdown', () => writeFileSync(${JSON.stringify(shutdownMarker)}, 'stopped'));`);
  const branchRuntime = await PiRuntime.create(cfg, new HostFiles(cfg.userHome, cfg.agentDir, cfg.home), sdkPath, owners);
  let settled = false;
  const worker = await branchRuntime.createBackend({ owner: "live", sessionFile: branchFile, archived: false,
    thread: { id: branchId, cwd: cfg.userHome, model: "handoff-test/model", reasoningEffort: "high" } }, {}, event => { if (event.type === "agent_settled") settled = true; });
  try {
    await worker.send(input("Continue this branch without tools"), { steer: false });
    await eventually(() => settled, 10000);
    assert.equal(requests.length, 6);
    const context = JSON.stringify(requests[5]); assert.match(context, /COMPACTION_SENTINEL/); assert.match(context, /SELECTED_BRANCH_SENTINEL/);
    assert.doesNotMatch(context, /COMPACTED_OLD_MUST_NOT_RETURN|ABANDONED_BRANCH_MUST_NOT_RETURN/);
  } finally { await worker.close(); }
  assert.equal(await readFile(shutdownMarker, "utf8"), "stopped");
  const returned = owners.claim(branchId, branchFile, "live"); owners.release(returned);
  console.log("SDK handoff: original history, terminal exit, mobile continuation, return to Pi, crash recovery, restart, compaction, branches, cleanup, and no duplicate requests passed.");
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await host.close(); await new Promise(resolve => http.close(resolve));
}
