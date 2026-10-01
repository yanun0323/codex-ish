// Runs in a child with a temporary HOME and no inherited credentials.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PiRuntime } from "../../dist/remote/runtime.js";
import { HostFiles } from "../../dist/remote/filesystem.js";
import { config } from "../../dist/remote/config.js";
import { Sessions } from "../../dist/remote/sessions.js";
import { State } from "../../dist/remote/state.js";
import { AppServer } from "../../dist/remote/server.js";
import { client } from "../remote-helpers.mjs";
import { desktopResume } from "./desktop-requests.mjs";

const cfg = config(); await mkdir(cfg.home, { recursive: true });
let requests = 0;
const server = createServer(async (request, response) => {
  assert.equal(request.headers.authorization, "Bearer offline-test-key"); requests++;
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  assert.match(body, /Say hello without tools/);
  assert.match(body, /Offline local Pi instruction stays in control/);
  assert.doesNotMatch(body, /Desktop-only context/);
  const base = { id: "chatcmpl-offline", object: "chat.completion.chunk", created: 1, model: "fixture" };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Offline reply" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  assert.ok(String(url).startsWith(baseUrl + "/"), `Unexpected network request: ${new URL(String(url)).hostname}`);
  return nativeFetch(url, options);
};
await writeFile(join(cfg.agentDir, "models.json"), JSON.stringify({ providers: { "remote-test": {
  api: "openai-completions", baseUrl, apiKey: "offline-test-key", models: [{ id: "fixture", name: "Offline fixture", reasoning: false,
    input: ["text"], contextWindow: 8192, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
await writeFile(join(cfg.agentDir, "APPEND_SYSTEM.md"), "Offline local Pi instruction stays in control.\n");
const files = new HostFiles(cfg.userHome, cfg.agentDir, cfg.home);
const runtime = await PiRuntime.create(cfg, files, resolve(process.argv[2]));
assert.ok((await runtime.models()).some(model => model.id === "remote-test/fixture"));
await assert.rejects(runtime.credentials(), /sign in with OpenAI Codex/);
const state = new State(cfg.database);
let sessions = new Sessions(state, runtime.createBackend);
const connectDesktop = () => client(new AppServer({ config: cfg, state, files, sessions, models: () => runtime.models() }), "desktop");
try {
  let desktop = await connectDesktop();
  const start = await desktop.send("thread/start", { ...desktopResume, cwd: cfg.userHome, model: "remote-test/fixture" });
  assert.ok(start.result, JSON.stringify(start));
  const created = start.result; const id = created.thread.id;
  // Reproduce the real desktop's defaults and echoed path against the installed Pi SDK.
  await sessions.close(); sessions = new Sessions(state, runtime.createBackend); desktop = await connectDesktop();
  const resumed = await desktop.send("thread/resume", { ...desktopResume, threadId: id, path: created.thread.path });
  assert.equal(resumed.result.thread.id, id);
  assert.equal((await desktop.send("thread/list", { limit: 200 })).result.data.length, 1);
  assert.equal((await desktop.send("thread/list", { limit: 200, parentThreadId: id, sourceKinds: ["subAgentThreadSpawn"] })).result.data.length, 0);
  assert.ok((await desktop.send("turn/start", { threadId: id, input: [{ type: "text", text: "Say hello without tools." }],
    collaborationMode: { mode: "default", settings: { model: "remote-test/fixture", reasoning_effort: "none", developer_instructions: null } } })).result);
  const deadline = Date.now() + 10_000;
  while (sessions.read(id).turns[0]?.status === "inProgress" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const turn = sessions.read(id).turns[0];
  assert.equal(turn.status, "completed", JSON.stringify(turn));
  assert.equal(turn.items.find(item => item.type === "agentMessage").text, "Offline reply");
  assert.equal(requests, 1);
  assert.equal(desktop.events("turn/completed").length, 1);
  assert.equal(desktop.events("item/completed").at(-1).params.item.text, "Offline reply");
  await sessions.close(); sessions = new Sessions(state, runtime.createBackend);
  assert.equal((await sessions.resume(id)).thread.turns[0].items.at(-1).text, "Offline reply");
  assert.equal(requests, 1, "resuming never repeats inference");
  console.log("SDK worker: desktop defaults, empty-session resume, local instructions, prompt, stream, persistence, and resume passed.");
} finally {
  await sessions.close(); state.close(); await new Promise(resolve => server.close(resolve));
}
