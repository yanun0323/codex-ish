// Offline auto-compaction regressions: real Pi summarization, fake model responses, temporary settings only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate as tick } from "node:timers/promises";

const here = dirname(fileURLToPath(import.meta.url));
const local = resolve(here, "..", "node_modules", "@earendil-works", "pi-coding-agent");
const piRoot = process.env.PI_TEST_AGENT_ROOT ?? (existsSync(join(local, "node_modules", "jiti")) ? local : "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent");
const require = createRequire(join(piRoot, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js"),
  "@earendil-works/pi-ai": join(piRoot, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
  "@earendil-works/pi-tui": join(piRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"),
  typebox: require.resolve("typebox"),
} });
const { registerAutoCompaction } = await jiti.import(resolve(here, "..", "extensions/lib/auto-compaction.ts"));
const { AgentSession, SessionManager, SettingsManager } = await import(join(piRoot, "dist/index.js"));
const text = value => ({ type: "text", text: value });
const model = extra => ({ id: "fixture", provider: "fixture", api: "openai-completions", reasoning: true,
  baseUrl: "https://example.invalid", input: ["text"], contextWindow: 128000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...extra });
const reply = (selected, extra = {}) => ({ role: "assistant", content: [text("A complete summary.")], stopReason: "stop",
  provider: selected.provider, api: selected.api, model: selected.id, timestamp: Date.now(),
  usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra });
const preparation = extra => ({ firstKeptEntryId: "kept-entry", tokensBefore: 100000,
  messagesToSummarize: [{ role: "user", content: "Earlier conversation", timestamp: 1 }],
  turnPrefixMessages: [], isSplitTurn: false, previousSummary: undefined,
  fileOps: { read: new Set(["read.ts"]), edited: new Set(["edit.ts"]), written: new Set() },
  settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 }, ...extra });
const event = extra => ({ type: "session_before_compact", reason: "threshold", willRetry: false,
  signal: new AbortController().signal, branchEntries: [], preparation: preparation(), ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, settings = { retry: { enabled: false } }) {
  const root = await mkdtemp(join(tmpdir(), "codex-compaction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  await mkdir(agentDir); await mkdir(join(cwd, ".pi"), { recursive: true });
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify(settings));
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  t.after(() => assert.equal(network.mock.callCount(), 0));
  const handlers = new Map(), calls = [], notifications = [];
  registerAutoCompaction({ on: (name, handler) => handlers.set(name, handler) }, agentDir);
  let respond = selected => reply(selected);
  const ctx = { cwd, mode: "tui", hasUI: true, model: model(), thinkingLevel: "high", isProjectTrusted: () => true,
    ui: { notify: (message, level) => notifications.push({ message, level }) },
    modelRegistry: { streamSimple(selected, context, options) {
      calls.push({ model: selected, context, options });
      const result = Promise.resolve().then(() => respond(selected, context, options));
      return { result: () => result };
    } },
  };
  const handler = handlers.get("session_before_compact");
  return { ctx, calls, notifications, settingsPath, agentDir, cwd, handler,
    respond: callback => { respond = callback; }, run: (options = {}) => handler(event(options), ctx) };
}

test("the extension registers the auto-compaction hook", async () => {
  const extension = await jiti.import(resolve(here, "..", "extensions/codex-ish.ts"));
  const handlers = new Map();
  extension.default({ registerTool() {}, registerCommand() {}, on(name, handler) {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {};
  } });
  assert.equal(handlers.get("session_before_compact")?.length, 1);
});

test("automatic compaction picks each current model's lowest supported level without changing main thinking or settings", async t => {
  const f = await fixture(t);
  const saved = await readFile(f.settingsPath, "utf8");
  for (const [overrides, expected] of [
    [{ reasoning: false }, undefined],
    [{}, undefined],
    [{ thinkingLevelMap: { off: null } }, "minimal"],
    [{ thinkingLevelMap: { off: null, minimal: null } }, "low"],
    [{ thinkingLevelMap: { off: null, minimal: null, low: null, medium: null } }, "high"],
  ]) {
    f.ctx.model = Object.freeze(model(overrides));
    const before = structuredClone(f.ctx.model);
    const result = await f.run();
    assert.ok(result.compaction);
    assert.equal(f.calls.at(-1).model, f.ctx.model);
    assert.equal(f.calls.at(-1).options.reasoning, expected);
    assert.equal(f.ctx.thinkingLevel, "high");
    assert.deepEqual(f.ctx.model, before);
    assert.equal(result.compaction.firstKeptEntryId, "kept-entry");
    assert.equal(result.compaction.tokensBefore, 100000);
    assert.equal(result.compaction.usage.output, 10);
  }
  assert.equal(await readFile(f.settingsPath, "utf8"), saved);
  assert.deepEqual(await readdir(f.agentDir), ["settings.json"]);
  assert.deepEqual(await readdir(join(f.cwd, ".pi")), []);
  assert.deepEqual(f.notifications, []);
});

test("only threshold and overflow compaction are replaced, in every Pi mode", async t => {
  const f = await fixture(t);
  for (const reason of ["manual", undefined, "unknown"]) assert.equal(await f.run({ reason }), undefined);
  assert.equal(f.calls.length, 0);
  for (const mode of ["tui", "rpc", "json", "print"]) {
    f.ctx.mode = mode;
    for (const reason of ["threshold", "overflow"]) {
      assert.ok((await f.run({ reason, willRetry: reason === "overflow" })).compaction);
    }
  }
  assert.equal(f.calls.length, 8);
  f.ctx.model = undefined;
  assert.equal(await f.run(), undefined);
  assert.equal(f.calls.length, 8);
});

test("Pi's summary prompts, split turns, budgets, file lists, cancellation signal, and usage accounting are preserved", async t => {
  const f = await fixture(t);
  f.ctx.model = model({ thinkingLevelMap: { off: null, minimal: null } });
  const controller = new AbortController();
  const prep = preparation({ isSplitTurn: true, previousSummary: "PREVIOUS_SUMMARY",
    turnPrefixMessages: [{ role: "user", content: "SPLIT_TURN_PREFIX", timestamp: 2 }] });
  const result = await f.run({ preparation: prep, customInstructions: "KEEP_FOCUS", signal: controller.signal });
  assert.equal(f.calls.length, 2);
  assert.match(JSON.stringify(f.calls[0].context), /PREVIOUS_SUMMARY/);
  assert.match(JSON.stringify(f.calls[0].context), /KEEP_FOCUS/);
  assert.match(JSON.stringify(f.calls[1].context), /SPLIT_TURN_PREFIX/);
  assert.deepEqual(f.calls.map(call => call.options.maxTokens), [800, 500]);
  for (const { options } of f.calls) {
    assert.equal(options.reasoning, "low");
    assert.equal(options.signal, controller.signal);
    assert.equal(options.cacheRetention, "none");
    assert.equal(typeof options.sessionId, "string");
  }
  assert.match(result.compaction.summary, /Turn Context \(split turn\)/);
  assert.match(result.compaction.summary, /<read-files>\nread.ts\n<\/read-files>/);
  assert.match(result.compaction.summary, /<modified-files>\nedit.ts\n<\/modified-files>/);
  assert.equal(result.compaction.usage.input, 200);
  assert.equal(result.compaction.usage.output, 20);
  assert.equal(result.compaction.firstKeptEntryId, prep.firstKeptEntryId);
  assert.equal(result.compaction.tokensBefore, prep.tokensBefore);
});

test("a model switch during compaction cannot change its captured model or thinking, and the next compaction uses the new model", async t => {
  const f = await fixture(t);
  const gate = deferred();
  const first = f.ctx.model = model({ id: "first", thinkingLevelMap: { off: null } });
  f.respond(selected => gate.promise.then(() => reply(selected)));
  const pending = f.run();
  await tick();
  f.ctx.model = model({ id: "second", thinkingLevelMap: { off: null, minimal: null } });
  f.ctx.thinkingLevel = "medium";
  gate.resolve();
  assert.ok((await pending).compaction);
  assert.equal(f.calls[0].model, first);
  assert.equal(f.calls[0].options.reasoning, "minimal");
  f.respond(selected => reply(selected));
  assert.ok((await f.run()).compaction);
  assert.equal(f.calls[1].model, f.ctx.model);
  assert.equal(f.calls[1].options.reasoning, "low");
  assert.equal(f.ctx.thinkingLevel, "medium");
});

test("cancellation before or during compaction saves no summary and never falls back to higher thinking", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.run({ signal: AbortSignal.abort() }), { cancel: true });
  assert.equal(f.calls.length, 0);
  const gate = deferred(), controller = new AbortController();
  f.respond(selected => gate.promise.then(() => reply(selected)));
  const pending = f.run({ signal: controller.signal });
  await tick();
  assert.equal(f.calls.length, 1);
  controller.abort(); gate.resolve();
  assert.deepEqual(await pending, { cancel: true });
  assert.deepEqual(f.notifications, []);
  assert.equal(f.ctx.thinkingLevel, "high");
  f.respond(selected => reply(selected));
  assert.ok((await f.run()).compaction, "A cancelled operation leaves no temporary thinking state behind");
});

test("errors, incomplete/empty summaries, tool calls, and invalid model levels cancel rather than retry at main thinking", async t => {
  const f = await fixture(t);
  for (const extra of [
    { stopReason: "error", errorMessage: "401 PRIVATE_PROVIDER_ERROR" },
    ...["length", "aborted", "pending", "deferred", "toolUse"].map(stopReason => ({ stopReason })),
    { content: [] }, { content: [text("  ")] }, { content: [{ type: "thinking", thinking: "Not a summary" }] },
    { content: [text("Invalid summary"), { type: "toolCall", id: "call", name: "bash", arguments: {} }] },
  ]) {
    const count = f.calls.length;
    f.respond(selected => reply(selected, extra));
    assert.deepEqual(await f.run(), { cancel: true });
    assert.equal(f.calls.length, count + 1);
    assert.equal(f.notifications.at(-1).level, "error");
    assert.doesNotMatch(f.notifications.at(-1).message, /PRIVATE_PROVIDER_ERROR/);
    assert.match(f.notifications.at(-1).message, /\/compact/);
  }
  f.respond(() => { throw new Error("PRIVATE_TRANSPORT_ERROR"); });
  assert.deepEqual(await f.run(), { cancel: true });
  assert.doesNotMatch(f.notifications.at(-1).message, /PRIVATE_TRANSPORT_ERROR/);
  const count = f.calls.length;
  f.ctx.model = model({ thinkingLevelMap: Object.fromEntries(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(level => [level, null])) });
  assert.deepEqual(await f.run(), { cancel: true });
  assert.equal(f.calls.length, count);
  assert.equal(f.ctx.thinkingLevel, "high");
});

test("transient retries stay at minimum thinking and honor saved retry settings and project trust", async t => {
  const f = await fixture(t, { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0,
    provider: { maxRetries: 0, timeoutMs: 1234, maxRetryDelayMs: 5678 } } });
  f.ctx.model = model({ thinkingLevelMap: { off: null } });
  await writeFile(join(f.cwd, ".pi/settings.json"), JSON.stringify({ retry: { enabled: false } }));
  for (const trusted of [true, false]) {
    f.ctx.isProjectTrusted = () => trusted;
    let attempt = 0;
    f.respond(selected => ++attempt === 1 ? reply(selected, { stopReason: "error", errorMessage: "terminated" }) : reply(selected));
    const result = await f.run();
    if (trusted) { assert.deepEqual(result, { cancel: true }); assert.equal(attempt, 1); }
    else { assert.ok(result.compaction); assert.equal(attempt, 2); }
  }
  for (const { options } of f.calls) {
    assert.equal(options.reasoning, "minimal");
    assert.equal(options.maxRetries, 0);
    assert.equal(options.timeoutMs, 1234);
    assert.equal(options.maxRetryDelayMs, 5678);
  }
});

test("file history survives successive automatic summaries and a later manual compaction", async t => {
  const f = await fixture(t);
  const first = (await f.run()).compaction;
  const previous = { type: "compaction", id: "previous", summary: first.summary, fromHook: true, details: first.details };
  const next = preparation({ previousSummary: first.summary,
    fileOps: { read: new Set(["new.ts"]), written: new Set(["read.ts"]), edited: new Set() } });
  const second = (await f.run({ branchEntries: [previous], preparation: next })).compaction;
  assert.deepEqual(second.details.readFiles, ["new.ts"]);
  assert.deepEqual(second.details.modifiedFiles, ["edit.ts", "read.ts"]);
  const manual = event({ reason: "manual", branchEntries: [{ ...previous, summary: second.summary, details: second.details }],
    preparation: preparation({ previousSummary: second.summary, fileOps: { read: new Set(), written: new Set(), edited: new Set() } }) });
  assert.equal(await f.handler(manual, f.ctx), undefined);
  assert.deepEqual([...manual.preparation.fileOps.read], ["new.ts"]);
  assert.deepEqual([...manual.preparation.fileOps.edited], ["edit.ts", "read.ts"]);
  assert.equal(f.calls.length, 2, "Manual compaction is still generated by Pi itself");
  const foreign = event({ reason: "manual", branchEntries: [{ ...previous, details: { readFiles: ["foreign.ts"] } }],
    preparation: preparation({ previousSummary: previous.summary }) });
  await f.handler(foreign, f.ctx);
  assert.equal(foreign.preparation.fileOps.read.has("foreign.ts"), false);
});

test("Pi's actual automatic path persists successful minimum-thinking summaries and cannot fall back after failure", async t => {
  const f = await fixture(t);
  for (const success of [true, false]) {
    const sessions = SessionManager.inMemory(f.cwd);
    sessions.appendMessage({ role: "user", content: "Old question ".repeat(100), timestamp: 1 });
    sessions.appendMessage(reply(f.ctx.model));
    const kept = sessions.appendMessage({ role: "user", content: "Keep this recent question", timestamp: Date.now() + 1 });
    const events = [];
    f.respond(selected => reply(selected, success ? {} : { stopReason: "error", errorMessage: "401 denied" }));
    const runtime = {
      model: f.ctx.model, sessionManager: sessions,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } }),
      agent: { hasQueuedMessages: () => false, streamFunction: () => assert.fail("Unexpected default compaction request") },
      _getSummarizationRequestAuth: async () => ({ model: f.ctx.model, apiKey: "fake-key" }),
      _extensionRunner: { hasHandlers: () => true, emit: event => event.type === "session_before_compact" ? f.handler(event, f.ctx) : undefined },
      _emit: event => events.push(event), _refreshFinalizedContext() {}, _resolveIdleWaitIfIdle() {},
      _emitSessionCompactFailed: async () => {},
      _runDefaultCompaction: async () => assert.fail("Must not silently retry with the main conversation's thinking"),
    };
    await AgentSession.prototype._runAutoCompaction.call(runtime, "threshold", false);
    const compacted = sessions.getEntries().filter(entry => entry.type === "compaction");
    assert.equal(compacted.length, success ? 1 : 0, JSON.stringify({ events, notifications: f.notifications }));
    const completed = events.find(event => event.type === "compaction_end");
    assert.equal(completed.aborted, !success);
    if (success) {
      assert.equal(compacted[0].firstKeptEntryId, kept);
      assert.equal(compacted[0].usage.output, 10);
      assert.ok(sessions.buildSessionContext().messages.some(message => message.role === "user" && message.content === "Keep this recent question"));
    }
    assert.equal(f.ctx.thinkingLevel, "high");
    assert.ok(!sessions.getEntries().some(entry => entry.type === "thinking_level_change"));
  }
});
