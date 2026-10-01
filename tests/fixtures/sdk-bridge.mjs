// Real Pi extension API + local socket + fake model server. Runs with an isolated HOME.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../../dist/remote/config.js";
import { startHost } from "../../dist/remote/daemon.js";
import { registerRemoteControl } from "../../dist/remote/client.js";
import { client, eventually, mockRuntime } from "../remote-helpers.mjs";

const cfg = config(); await mkdir(cfg.home, { recursive: true });
const sdkPath = resolve(process.argv[2]);
process.env.PI_CODEX_ISH_WORKER = "0";
process.env.PI_CODEX_APP_SERVER_AUTOSTART = "0";
process.env.PI_CODEX_REMOTE_CONTROL = "1";
process.env.PI_CODEX_ISH_SDK = sdkPath;
const sdk = await import(pathToFileURL(sdkPath).href);
let requests = 0;
const http = createServer(async (request, response) => {
  requests++;
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  assert.match(body, /REAL_BRIDGE_SKILL/); assert.match(body, /file_reference/);
  response.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "chatcmpl-bridge", object: "chat.completion.chunk", created: 1, model: "second" };
  for (const item of [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Bridge reply" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]) response.write(`data: ${JSON.stringify(item)}\n\n`);
  response.end("data: [DONE]\n\n");
});
http.listen(0, "127.0.0.1"); await once(http, "listening");
const baseUrl = `http://127.0.0.1:${http.address().port}/v1`;
const fetch = globalThis.fetch;
globalThis.fetch = (url, options) => { assert.ok(String(url).startsWith(baseUrl + "/"), "Only the local fake model is allowed"); return fetch(url, options); };
await writeFile(join(cfg.agentDir, "models.json"), JSON.stringify({ providers: { "bridge-test": {
  api: "openai-completions", baseUrl, apiKey: "fake-key", models: ["first", "second"].map(id => ({ id, name: id, reasoning: true,
    thinkingLevelMap: { xhigh: "high", max: "high" }, input: ["text"], contextWindow: 8192, maxTokens: 128,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
} } }));
const skillPath = join(cfg.agentDir, "skills", "real", "SKILL.md");
await mkdir(join(skillPath, ".."), { recursive: true });
await writeFile(skillPath, "---\nname: real\ndescription: real bridge fixture\n---\nREAL_BRIDGE_SKILL\n");
const file = join(cfg.userHome, "notes.txt"); await writeFile(file, "notes");
const mock = mockRuntime(); const host = await startHost(cfg, async () => mock);
let session;
try {
  const runtime = await sdk.ModelRuntime.create({ authPath: join(cfg.agentDir, "auth.json"), modelsPath: join(cfg.agentDir, "models.json"),
    modelsStorePath: join(cfg.home, "models-cache.json"), allowModelNetwork: false });
  await runtime.getAvailable();
  const loader = new sdk.DefaultResourceLoader({ cwd: cfg.userHome, agentDir: cfg.agentDir, noExtensions: true,
    extensionFactories: [pi => registerRemoteControl(pi, async () => { throw new Error("No pairing in tests"); })] });
  await loader.reload({ resolveProjectTrust: async () => false });
  ({ session } = await sdk.createAgentSession({ cwd: cfg.userHome, agentDir: cfg.agentDir, modelRuntime: runtime,
    model: runtime.getModel("bridge-test", "first"), thinkingLevel: "high", resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(cfg.userHome) }));
  const errors = [];
  await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
  const id = session.sessionId; await eventually(() => host.sessions.loaded().includes(id));
  const a = await client(host.app, "phone"); const b = await client(host.app, "mac");
  await a.send("thread/resume", { threadId: id }); await b.send("thread/resume", { threadId: id });
  const changed = await a.send("thread/settings/update", { threadId: id, model: "bridge-test/second", effort: "xhigh" });
  assert.ok(changed.result, JSON.stringify(changed));
  assert.equal(session.model.id, "second"); assert.equal(session.thinkingLevel, "xhigh"); assert.equal(requests, 0);
  session.setThinkingLevel("max"); await eventually(() => host.sessions.read(id).reasoningEffort === "max");
  assert.equal(b.events("thread/settings/updated").at(-1).params.threadSettings.effort, "max");
  const skills = (await b.send("skills/list", { cwds: [cfg.userHome] })).result.data[0].skills;
  assert.ok(skills.some(skill => skill.name === "real" && skill.path === skillPath));
  const sent = await b.send("turn/start", { threadId: id, input: [{ type: "text", text: "Say hello without tools." },
    { type: "skill", name: "real", path: skillPath }, { type: "mention", name: "notes", path: file }] });
  assert.ok(sent.result, JSON.stringify(sent));
  await eventually(() => host.sessions.read(id).turns[0]?.status === "completed", 10_000);
  assert.equal(host.sessions.read(id).turns[0].items.filter(item => item.type === "userMessage").length, 1);
  assert.equal(host.sessions.read(id).turns[0].items.at(-1).text, "Bridge reply");
  assert.equal(requests, 1); assert.equal(mock.backends.length, 0); assert.deepEqual(errors, []);
  assert.equal(session.settingsManager.getDefaultModel(), undefined);
  assert.equal(session.settingsManager.getDefaultThinkingLevel(), undefined);
  console.log("SDK bridge: real extension model/thinking events, skill discovery, selected input, and one writer passed.");
} finally {
  if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  await host.close(); await new Promise(resolve => http.close(resolve));
}
