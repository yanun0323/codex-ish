// Runs in a child with a temporary HOME and no inherited credentials.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFile, mkdir, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
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
  assert.match(body, /SDK_SKILL_BODY/);
  assert.match(body, /file_reference/);
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
    input: ["text"], contextWindow: 8192, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { id: "reasoning", name: "Offline reasoning", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      input: ["text"], contextWindow: 8192, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
await writeFile(join(cfg.agentDir, "APPEND_SYSTEM.md"), "Offline local Pi instruction stays in control.\n");
const skillPath = join(cfg.agentDir, "skills", "sdk-skill", "SKILL.md");
await mkdir(join(skillPath, ".."), { recursive: true });
await writeFile(skillPath, "---\nname: sdk-skill\ndescription: Offline skill\n---\nSDK_SKILL_BODY\n");
const mentionPath = join(cfg.userHome, "notes.txt"); await writeFile(mentionPath, "notes");
const project = join(cfg.userHome, "workspace");
const projectSkill = join(project, ".pi", "skills", "project", "SKILL.md");
const sentinel = join(cfg.userHome, "must-not-execute");
await mkdir(join(projectSkill, ".."), { recursive: true });
await mkdir(join(project, ".pi", "extensions"), { recursive: true });
await writeFile(projectSkill, "---\nname: project-skill\ndescription: Project skill\n---\nPROJECT_SKILL_BODY\n");
await writeFile(join(project, ".pi", "extensions", "sentinel.ts"), `import {writeFileSync} from 'node:fs'; export default function () { writeFileSync(${JSON.stringify(sentinel)}, 'executed'); }`);
const files = new HostFiles(cfg.userHome, cfg.agentDir, cfg.home);
const runtime = await PiRuntime.create(cfg, files, resolve(process.argv[2]));
const catalog = await runtime.models();
assert.ok(catalog.some(model => model.id === "remote-test/fixture"));
assert.ok(catalog.find(model => model.id === "remote-test/reasoning").supportedReasoningEfforts.some(e => e.reasoningEffort === "xhigh"));
assert.deepEqual(catalog.find(model => model.id === "remote-test/fixture").supportedReasoningEfforts.map(e => e.reasoningEffort), ["none"]);
const sdk = await import(pathToFileURL(resolve(process.argv[2])).href);
const trust = new sdk.ProjectTrustStore(cfg.agentDir);
assert.ok((await runtime.skills(project)).some(skill => skill.name === "sdk-skill"));
assert.ok(!(await runtime.skills(project)).some(skill => skill.name === "project-skill"));
trust.set(project, true);
assert.ok((await runtime.skills(project)).some(skill => skill.name === "project-skill"));
await assert.rejects(stat(sentinel), { code: "ENOENT" }, "listing skills never executes extensions, even in a trusted project");
trust.set(project, false);
assert.ok(!(await runtime.skills(project)).some(skill => skill.name === "project-skill"));
await assert.rejects(runtime.credentials(), /sign in with OpenAI Codex/);
const state = new State(cfg.database);
let sessions = new Sessions(state, runtime.createBackend);
const connectDesktop = () => client(new AppServer({ config: cfg, state, files, sessions, models: () => runtime.models(), skills: cwd => runtime.skills(cwd) }), "desktop");
try {
  let desktop = await connectDesktop();
  const start = await desktop.send("thread/start", { ...desktopResume, cwd: cfg.userHome, model: "remote-test/fixture" });
  assert.ok(start.result, JSON.stringify(start));
  const created = start.result; const id = created.thread.id;
  assert.ok((await desktop.send("skills/list", { cwds: [cfg.userHome], forceReload: true })).result.data[0].skills.some(skill => skill.path === skillPath));
  assert.equal((await desktop.send("thread/settings/update", { threadId: id, effort: "xhigh" })).error.code, -32602);
  assert.ok((await desktop.send("thread/settings/update", { threadId: id, model: "remote-test/reasoning", effort: "xhigh" })).result);
  assert.equal((await sessions.resume(id)).reasoningEffort, "xhigh");
  assert.equal((await sessions.resume(id)).model, "remote-test/reasoning");
  assert.equal((await desktop.send("thread/settings/update", { threadId: id, model: "remote-test/fixture", effort: "xhigh" })).error.code, -32602);
  assert.equal((await sessions.resume(id)).model, "remote-test/reasoning", "invalid combined changes cannot partially switch the model");
  assert.equal((await sessions.resume(id)).reasoningEffort, "xhigh");
  assert.equal(requests, 0, "changing settings and discovering skills never run a model");
  // Reproduce the real desktop's defaults and echoed path against the installed Pi SDK.
  await sessions.close(); sessions = new Sessions(state, runtime.createBackend); desktop = await connectDesktop();
  const resumed = await desktop.send("thread/resume", { ...desktopResume, threadId: id, path: created.thread.path });
  assert.ok(resumed.result, JSON.stringify(resumed));
  assert.equal(resumed.result.thread.id, id);
  assert.equal(resumed.result.model, "remote-test/reasoning");
  assert.equal(resumed.result.reasoningEffort, "xhigh");
  assert.equal((await desktop.send("thread/list", { limit: 200 })).result.data.length, 1);
  assert.equal((await desktop.send("thread/list", { limit: 200, parentThreadId: id, sourceKinds: ["subAgentThreadSpawn"] })).result.data.length, 0);
  assert.ok((await desktop.send("turn/start", { threadId: id, input: [{ type: "text", text: "Say hello without tools." },
      { type: "skill", name: "sdk-skill", path: skillPath }, { type: "mention", name: "notes", path: mentionPath }],
    collaborationMode: { mode: "default", settings: { model: "remote-test/fixture", reasoning_effort: "none", developer_instructions: null } } })).result);
  const deadline = Date.now() + 10_000;
  while (sessions.read(id).turns[0]?.status === "inProgress" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const turn = sessions.read(id).turns[0];
  assert.equal(turn.status, "completed", JSON.stringify(turn));
  assert.equal(turn.items.filter(item => item.type === "userMessage").length, 1);
  assert.equal(sdk.SettingsManager.create(cfg.userHome, cfg.agentDir).getDefaultModel(), undefined, "remote selection does not overwrite Pi startup defaults");
  assert.equal(sdk.SettingsManager.create(cfg.userHome, cfg.agentDir).getDefaultThinkingLevel(), undefined);
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
