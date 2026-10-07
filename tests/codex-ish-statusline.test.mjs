// Offline statusline regressions. No real keys, Claude processes, network, or model calls.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { existsSync } from "node:fs";
import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { setImmediate as tick } from "node:timers/promises";

const here = dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(join(tmpdir(), "codex-statusline-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
await mkdir(agentDir, { recursive: true });
await mkdir(join(cwd, ".pi"), { recursive: true });
const previousEnv = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_CODEX_ISH_WORKER: process.env.PI_CODEX_ISH_WORKER };
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CODEX_ISH_WORKER = "1";
after(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  delete globalThis[Symbol.for("codex-ish.test.claude-sdk")];
  await rm(root, { recursive: true, force: true });
});

// Make the optional installed-bridge resolution path use a fake SDK, not the user's installation.
const modules = join(agentDir, "npm", "node_modules");
await mkdir(join(modules, "pi-claude-bridge"), { recursive: true });
await writeFile(join(modules, "pi-claude-bridge", "package.json"), '{"name":"pi-claude-bridge"}');
const sdkDir = join(modules, "@anthropic-ai", "claude-agent-sdk");
await mkdir(sdkDir, { recursive: true });
await writeFile(join(sdkDir, "package.json"), '{"name":"@anthropic-ai/claude-agent-sdk","type":"module","main":"sdk.mjs"}');
await writeFile(join(sdkDir, "sdk.mjs"), `export function query(params) {
  const fixture = globalThis[Symbol.for("codex-ish.test.claude-sdk")];
  if (!fixture.query) { fixture.unexpected++; throw new Error("Unexpected SDK startup"); }
  return fixture.query(params);
}`);

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
const extension = await jiti.import(resolve(here, "..", "extensions", "codex-ish.ts"));
const { parseDeepSeekBalance, fetchDeepSeekBalance, parseClaudeBridgeQuotas, parseStatuslineSettings, parseStatuslineOrder } = extension;
const { ClaudeUsageReader, CLAUDE_USAGE_METHOD } = await jiti.import(resolve(here, "..", "extensions", "lib", "claude-usage.ts"));
const { visibleWidth, getKeybindings } = await import(join(piRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"));
const { initTheme } = await import(join(piRoot, "dist/modes/interactive/theme/theme.js"));
initTheme("dark", false);
const fieldIds = ["model-with-thinking", "provider", "git-branch", "remote", "context-used-percentage", "quota-reset", "context-used-tokens", "context-window-tokens", "output-speed", "output-speed-avg5"];
const fieldSettings = enabled => Object.fromEntries(fieldIds.map(id => [id, enabled]));
const fieldsFirst = (...ids) => [...ids, ...fieldIds.filter(id => !ids.includes(id))];
const menuFields = f => f.renderMenu(100).split("\n").flatMap(line => line.match(/([\w-]+)\s+\[[X ]\]/)?.[1] ?? []);
const selectedMenuField = f => f.renderMenu(100).match(/^→ ([\w-]+)/m)?.[1];
const reportedOrder = async f => {
  await f.command("status");
  return f.notifications.at(-1).message.split("\n").map(line => line.split(/\s+/)[0]);
};
const settingsPath = join(agentDir, "codex-ish.json");
const writeSettings = settings => writeFile(settingsPath, JSON.stringify(settings));
const readSettings = async () => JSON.parse(await readFile(settingsPath, "utf8"));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const signal = () => new AbortController().signal;
const balancePayload = total_balance => ({ is_available: true, balance_infos: [{ currency: "USD", total_balance }] });
const claudePayload = () => ({ rate_limits_available: true, rate_limits: {
  five_hour: { utilization: 25, resets_at: new Date(Date.now() + 2 * 3600_000).toISOString() },
  seven_day: { utilization: 60, resets_at: new Date(Date.now() + 3 * 86400_000).toISOString() },
} });
let unexpectedRequests;
let sdkFixture;
beforeEach(async t => {
  unexpectedRequests = [];
  sdkFixture = { unexpected: 0 };
  globalThis[Symbol.for("codex-ish.test.claude-sdk")] = sdkFixture;
  t.mock.method(globalThis, "fetch", async url => { unexpectedRequests.push(String(url)); throw new Error("Offline test"); });
  await writeSettings({});
  await rm(join(agentDir, "claude-bridge.json"), { force: true });
  await rm(join(cwd, ".pi", "claude-bridge.json"), { force: true });
});
afterEach(() => {
  assert.deepEqual(unexpectedRequests, [], "No unexpected network requests");
  assert.equal(sdkFixture.unexpected, 0, "No unexpected SDK startup");
});
async function eventually(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Statusline did not reach the expected state");
}
function model(provider) {
  return { id: `test-${provider}`, provider, api: provider === "openai-codex" ? "openai-codex-responses" : "openai-completions",
    baseUrl: provider === "deepseek" ? "https://api.deepseek.com/v1" : "https://example.com", contextWindow: 128000 };
}
function deepSeekContext(auth = { ok: true, apiKey: "fake-deepseek-key" }) {
  return { model: model("deepseek"), modelRegistry: { getApiKeyAndHeaders: async () => auth } };
}
async function fixture(t, provider = "deepseek", mode = "tui") {
  const handlers = new Map();
  const commands = new Map();
  extension.default({ registerTool() {}, registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {}; } });
  let footer;
  let menu;
  let redraws = 0;
  let gitBranch = "main";
  let branchReads = 0;
  const branchListeners = new Set();
  const footerData = {
    getGitBranch() { branchReads++; return gitBranch; },
    onBranchChange(callback) { branchListeners.add(callback); return () => branchListeners.delete(callback); },
  };
  const notifications = [];
  const authCalls = [];
  const terminal = { rows: 24 };
  const theme = { fg: (_color, text) => text, bold: text => text, getColorMode: () => "truecolor" };
  const ctx = {
    cwd, mode, hasUI: mode === "tui" || mode === "rpc", model: model(provider), thinkingLevel: "off",
    isIdle: () => true, getContextUsage: () => ({ tokens: 10000, contextWindow: 128000, percent: 8 }),
    sessionManager: { getBranch: () => [] },
    modelRegistry: {
      getAvailable: () => [ctx.model], getAll: () => [ctx.model],
      getApiKeyAndHeaders: async selected => { authCalls.push(selected.provider); return { ok: true, apiKey: `fake-${selected.provider}` }; },
      getApiKeyForProvider: async selected => { authCalls.push(selected); return JSON.stringify({ token: "fake-google", projectId: "fixture" }); },
    },
    ui: {
      notify: (message, level) => notifications.push({ message, level }), setWidget() {},
      getEditorComponent() {}, setEditorComponent() {}, addAutocompleteProvider() {}, getEditorText: () => "",
      setFooter(factory) {
        footer?.dispose?.();
        footer = factory?.({ requestRender() { redraws++; } }, theme, footerData);
      },
      select: async () => { throw new Error("Statusline should use a checkbox list, not a select dialog"); },
      custom: factory => new Promise(done => {
        menu = factory({ terminal, requestRender() { redraws++; } }, theme, getKeybindings(), () => {
          menu?.dispose?.(); menu = undefined; done();
        });
      }),
    },
  };
  const emit = async (name, event = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  t.after(() => emit("session_shutdown"));
  await emit("session_start");
  return { ctx, commands, notifications, authCalls, theme, terminal, emit,
    command: args => commands.get("statusline").handler(args, ctx),
    render: (width = 500) => stripVTControlCharacters(footer?.render(width).join("\n") ?? ""),
    raw: width => footer?.render(width) ?? [],
    get menu() { return menu; },
    renderMenu: (width = 80) => stripVTControlCharacters(menu?.render(width).join("\n") ?? ""),
    get redraws() { return redraws; },
    get branchReads() { return branchReads; },
    get branchListenerCount() { return branchListeners.size; },
    changeBranch(branch) { gitBranch = branch; for (const callback of branchListeners) callback(); },
    switch: async (provider, id) => {
      const previousModel = ctx.model;
      ctx.model = model(provider);
      if (id) ctx.model.id = id;
      await emit("model_select", { model: ctx.model, previousModel, source: "set" });
    },
  };
}

function speedClock(t, f) {
  let timestamp = 0;
  const clock = {
    now: 0,
    message(output, extra = {}) {
      return { role: "assistant", api: f.ctx.model.api, provider: f.ctx.model.provider, model: f.ctx.model.id,
        timestamp: ++timestamp, content: [{ type: "text", text: "reply" }], stopReason: "stop",
        usage: { input: 1000, output, cacheRead: 100, cacheWrite: 0, totalTokens: 1100 + output,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra };
    },
    async start(message) {
      await f.emit("turn_start");
      await f.emit("message_start", { message: { ...message, stopReason: "pending", usage: { ...message.usage, output: 0 } } });
    },
    async delta(message, type = "text_delta", delta = "chunk") {
      await f.emit("message_update", { message, assistantMessageEvent: { type, delta, contentIndex: 0, partial: message } });
    },
    async complete(output, milliseconds, extra = {}) {
      const message = clock.message(output, extra);
      await clock.start(message);
      await clock.delta(message);
      clock.now += milliseconds;
      await clock.delta(message);
      await f.emit("message_end", { message });
      await f.emit("turn_end");
      return message;
    },
  };
  t.mock.method(performance, "now", () => clock.now);
  return clock;
}
function assertSpeeds(f, last, average = last) {
  const value = speed => speed === undefined ? "—" : speed.toFixed(1);
  assert.deepEqual(f.render().split(" · ").slice(-2), [`last ${value(last)} tok/s`, `avg5 ${value(average)} tok/s`]);
}

// Payload and HTTP contracts.
test("DeepSeek picks USD total balance, including zero and debt, without converting CNY", () => {
  assert.equal(parseDeepSeekBalance({ balance_infos: [{ currency: "CNY", total_balance: "99.00" }, ...balancePayload("12.345").balance_infos] }), 12.345);
  assert.equal(parseDeepSeekBalance({ ...balancePayload("0.00"), is_available: false }), 0);
  assert.equal(parseDeepSeekBalance(balancePayload("-0.01")), -0.01);
  for (const value of [null, [], {}, { balance_infos: [] }, { balance_infos: [{ currency: "CNY", total_balance: "100" }] },
    ...[null, "", " ", "NaN", "Infinity", Infinity, {}, false].map(balancePayload)]) {
    assert.equal(parseDeepSeekBalance(value), undefined);
  }
});

test("DeepSeek uses the selected model's resolved credentials and refuses redirects", async t => {
  const ctx = deepSeekContext({ ok: true, apiKey: "fallback-key", headers: { authorization: "Bearer resolved-key", "X-Custom": "fixture", removed: null } });
  const request = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.deepseek.com/user/balance");
    assert.equal(options.headers.get("authorization"), "Bearer resolved-key");
    assert.equal(options.headers.get("X-Custom"), "fixture");
    assert.equal(options.headers.has("removed"), false);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(balancePayload("4.50"));
  });
  assert.equal(await fetchDeepSeekBalance(ctx, signal()), 4.5);
  assert.equal(request.mock.callCount(), 1);
});

test("DeepSeek API-key fallback, zero balance, and failed HTTP/JSON responses", async t => {
  const request = t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.headers.get("authorization"), "Bearer fake-deepseek-key");
    return Response.json(balancePayload("0"));
  });
  assert.equal(await fetchDeepSeekBalance(deepSeekContext(), signal()), 0);
  for (const status of [401, 403, 429, 500]) {
    request.mock.mockImplementation(async () => new Response("No credentials in UI", { status }));
    assert.equal(await fetchDeepSeekBalance(deepSeekContext(), signal()), undefined);
  }
  request.mock.mockImplementation(async () => new Response("not JSON"));
  assert.equal(await fetchDeepSeekBalance(deepSeekContext(), signal()), undefined);
  assert.equal(request.mock.callCount(), 6, "No automatic retries");
});

test("DeepSeek never resolves or sends credentials for custom/proxy origins or other providers", async () => {
  for (const baseUrl of ["https://proxy.example/v1", "http://api.deepseek.com", "https://api.deepseek.com.evil.test", "https://user:secret@api.deepseek.com", "https://api.deepseek.com:8443", "invalid"]) {
    const ctx = deepSeekContext(); ctx.model.baseUrl = baseUrl;
    let authCalls = 0; ctx.modelRegistry.getApiKeyAndHeaders = async () => { authCalls++; return { ok: true, apiKey: "secret" }; };
    assert.equal(await fetchDeepSeekBalance(ctx, signal()), undefined);
    assert.equal(authCalls, 0);
  }
  for (const ctx of [deepSeekContext({ ok: false }), deepSeekContext({ ok: true }), { ...deepSeekContext(), model: model("openai") }]) {
    assert.equal(await fetchDeepSeekBalance(ctx, signal()), undefined);
  }
});

test("DeepSeek cancels before and during credential resolution", async () => {
  const ctx = deepSeekContext();
  let calls = 0;
  const key = deferred();
  ctx.modelRegistry.getApiKeyAndHeaders = () => { calls++; return key.promise; };
  assert.equal(await fetchDeepSeekBalance(ctx, AbortSignal.abort()), undefined);
  assert.equal(calls, 0);
  const controller = new AbortController();
  const pending = fetchDeepSeekBalance(ctx, controller.signal);
  controller.abort(); key.resolve({ ok: true, apiKey: "never-send" });
  assert.equal(await pending, undefined);
  assert.equal(calls, 1);
});

test("Claude usage converts documented percentages (not fractions) and ISO reset timestamps", () => {
  const payload = claudePayload();
  assert.deepEqual(parseClaudeBridgeQuotas(payload), {
    fiveHour: { remaining: 75, resetAt: Date.parse(payload.rate_limits.five_hour.resets_at) },
    weekly: { remaining: 40, resetAt: Date.parse(payload.rate_limits.seven_day.resets_at) },
  });
  for (const used of [0, 0.5, 1, 100]) {
    assert.deepEqual(parseClaudeBridgeQuotas({ rate_limits_available: true, rate_limits: { five_hour: { utilization: used, resets_at: "invalid" } } }),
      { fiveHour: { remaining: 100 - used, resetAt: undefined } });
  }
  for (const used of [null, "", NaN, Infinity, -1, 101, false]) {
    assert.equal(parseClaudeBridgeQuotas({ rate_limits_available: true, rate_limits: { five_hour: { utilization: used } } }), undefined);
  }
  for (const payload of [null, {}, { rate_limits_available: false, rate_limits: claudePayload().rate_limits }, { rate_limits_available: true, rate_limits: null }]) {
    assert.equal(parseClaudeBridgeQuotas(payload), undefined);
  }
  assert.deepEqual(parseClaudeBridgeQuotas({ rate_limits_available: true, rate_limits: { seven_day: { utilization: 100 } } }),
    { weekly: { remaining: 0, resetAt: undefined } });
});

test("ten field switches default to on, use explicit false, and ignore old provider switches", () => {
  const defaults = fieldSettings(true);
  for (const value of [undefined, null, [], { fast: true }, { provider: "false", remote: 0 },
    { codex: false, antigravity: false, deepseek: false, "claude-bridge": false }]) {
    assert.deepEqual(parseStatuslineSettings(value), defaults);
  }
  assert.deepEqual(parseStatuslineSettings({ provider: false, "quota-reset": false, unknown: false }),
    { ...defaults, provider: false, "quota-reset": false });
  assert.deepEqual(parseStatuslineSettings(fieldSettings(false)), fieldSettings(false));
});

test("field order defaults safely, removes duplicates and unknown IDs, and appends missing fields", () => {
  for (const value of [undefined, null, false, "provider", {}, [], [null, false, 1, {}, "unknown", "__proto__"]]) {
    assert.deepEqual(parseStatuslineOrder(value), fieldIds);
  }
  const partial = ["remote", "remote", null, "unknown", "provider", 0];
  assert.deepEqual(parseStatuslineOrder(partial), fieldsFirst("remote", "provider"));
  assert.deepEqual(partial, ["remote", "remote", null, "unknown", "provider", 0], "Parsing does not mutate the input");
  assert.deepEqual(parseStatuslineOrder(fieldIds.toReversed()), fieldIds.toReversed());
  assert.deepEqual(parseStatuslineSettings({ order: ["remote"], remote: false }), { ...fieldSettings(true), remote: false });
});

// The Claude reader never submits a prompt, spawns only once, and owns its cleanup.
test("Claude reader reuses one idle query, coalesces reads, and never yields a prompt", async () => {
  const controller = new AbortController();
  const result = deferred();
  let starts = 0, reads = 0, closes = 0, inputFinished = false, input, childAbort;
  const reader = new ClaudeUsageReader(async (prompt, abort) => {
    childAbort = abort;
    starts++; assert.equal(abort.signal.aborted, false);
    input = prompt[Symbol.asyncIterator]().next().then(value => { inputFinished = true; return value; });
    return { [CLAUDE_USAGE_METHOD]: async options => { reads++; assert.deepEqual(options, { skipBehaviors: true }); return result.promise; }, close: () => { closes++; } };
  }, controller.signal);
  try {
    const a = reader.read(); const b = reader.read();
    assert.equal(a, b);
    await tick(); assert.equal(inputFinished, false);
    result.resolve(claudePayload());
    assert.ok(await a);
    assert.ok(await reader.read());
    assert.equal(starts, 1); assert.equal(reads, 2);
    assert.equal(getEventListeners(childAbort.signal, "abort").length, 1, "Per-read cancellation listeners are removed");
    controller.abort();
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.deepEqual(await input, { value: undefined, done: true });
    reader.close(); assert.equal(closes, 1);
    assert.equal(await reader.read(), undefined);
  } finally { reader.close(); }
});

test("Claude reader closes once on errors or missing experimental API and does not respawn", async () => {
  for (const fail of [false, true]) {
    let starts = 0, closes = 0;
    const reader = new ClaudeUsageReader(async () => {
      starts++;
      return { ...(fail ? { [CLAUDE_USAGE_METHOD]: async () => { throw new Error("private auth error"); } } : {}), close: () => { closes++; } };
    }, signal());
    assert.equal(await reader.read(), undefined);
    assert.equal(await reader.read(), undefined);
    reader.close(); assert.equal(starts, 1); assert.equal(closes, 1);
  }
});

test("Claude reader timeout or shutdown discards late startup and closes the late process", async () => {
  for (const timeout of [false, true]) {
    const gate = deferred(); const controller = new AbortController();
    let reads = 0, closes = 0, abort;
    const reader = new ClaudeUsageReader(async (_prompt, supplied) => { abort = supplied; return gate.promise; }, controller.signal, timeout ? 10 : 10000);
    const pending = reader.read();
    if (!timeout) controller.abort();
    assert.equal(await pending, undefined);
    assert.equal(abort.signal.aborted, true);
    gate.resolve({ [CLAUDE_USAGE_METHOD]: async () => { reads++; }, close: () => { closes++; } });
    await tick();
    assert.equal(reads, 0); assert.equal(closes, 1);
    assert.equal(await reader.read(), undefined);
  }
});

test("Claude reader cancels a pending usage read and never starts when already cancelled", async () => {
  let starts = 0, closes = 0;
  const stopped = new ClaudeUsageReader(async () => { starts++; }, AbortSignal.abort());
  assert.equal(await stopped.read(), undefined); assert.equal(starts, 0);
  const controller = new AbortController(); const gate = deferred();
  const reader = new ClaudeUsageReader(async () => ({ [CLAUDE_USAGE_METHOD]: () => gate.promise, close: () => { closes++; } }), controller.signal);
  const pending = reader.read(); await tick(); controller.abort();
  assert.equal(await pending, undefined); assert.equal(closes, 1);
  gate.resolve(claudePayload()); await tick();
  assert.equal(await reader.read(), undefined);
});

// Actual extension commands, persistence, lifecycle, and rendering.
test("only the selected provider is fetched and unsupported providers have no quota placeholders", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async url => { requests.push(String(url)); return Response.json(balancePayload("12.34")); });
  const f = await fixture(t);
  await eventually(() => f.render().includes("USD 12.34 left"));
  assert.deepEqual(f.authCalls, ["deepseek"]);
  assert.deepEqual(requests, ["https://api.deepseek.com/user/balance"]);
  assert.doesNotMatch(f.render(), /5h|weekly/);
  await f.switch("openai");
  assert.doesNotMatch(f.render(), /USD|5h|weekly/);
  assert.match(f.render(), /8% context used/);
  assert.equal(requests.length, 1);
});

test("Codex and Antigravity still show model-specific quotas and keep compact reset countdowns", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async url => {
    requests.push(String(url));
    if (String(url).includes("wham")) return Response.json({
      rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_after_seconds: 7200 }, secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_after_seconds: 259200 } },
      additional_rate_limits: [{ limit_name: "GPT-5.3-Codex-Spark", rate_limit: { primary_window: { used_percent: 90, limit_window_seconds: 18000, reset_after_seconds: 3600 } } }],
    });
    return Response.json({ groups: [{ displayName: "Gemini", buckets: [{ remainingFraction: 0.2, window: "5h", resetTime: new Date(Date.now() + 3600_000).toISOString() }] },
      { displayName: "Claude", buckets: [{ remainingFraction: 0.8, window: "weekly" }] }] });
  });
  const f = await fixture(t, "openai-codex");
  await eventually(() => f.render().includes("5h 70% left 2h"));
  assert.match(f.render(), /weekly 50% left 3d/);
  assert.match(f.render(110), /5h 70% 2h/);
  await f.switch("openai-codex", "gpt-5.3-codex-spark");
  await eventually(() => f.render().includes("5h 10% left 1h"));
  await f.switch("antigravity", "gemini-fixture");
  await eventually(() => f.render().includes("5h 20% left 1h"));
  assert.doesNotMatch(f.render(), /80%|USD/);
  assert.deepEqual(f.authCalls, ["openai-codex", "openai-codex", "antigravity"]);
  assert.equal(requests.length, 3);
});

test("git branch follows provider without a prefix, updates from Pi, and has an independent persistent display switch", async t => {
  const f = await fixture(t, "unsupported");
  const clock = speedClock(t, f);
  await clock.complete(10, 1000);
  assert.deepEqual(f.render().split(" · ").slice(0, 4), ["test-unsupported", "unsupported", "main", "remote worker"]);
  const redraws = f.redraws;
  f.changeBranch("feature/statusline");
  assert.ok(f.redraws > redraws, "Git branch changes request a redraw without waiting for the footer timer");
  assert.match(f.render(), /unsupported · feature\/statusline · remote worker/);
  assertSpeeds(f, 10); // A Git checkout is not a conversation-tree change.
  await f.command("provider off");
  assert.deepEqual(f.render().split(" · ").slice(0, 3), ["test-unsupported", "feature/statusline", "remote worker"]);
  await f.command("git-branch off");
  const hiddenRedraws = f.redraws, hiddenReads = f.branchReads;
  f.changeBranch("fix/updated-while-hidden");
  assert.equal(f.redraws, hiddenRedraws);
  assert.doesNotMatch(f.render(), /feature\/statusline|updated-while-hidden/);
  assert.equal(f.branchReads, hiddenReads, "Hidden branches are not queried during render");
  assert.deepEqual((await readSettings()).statusline, { provider: false, "git-branch": false });
  await f.emit("session_shutdown");
  await f.emit("session_start");
  assert.doesNotMatch(f.render(), /updated-while-hidden/);
  await f.command("git-branch on");
  assert.match(f.render(), /fix\/updated-while-hidden · remote worker/);
  assert.deepEqual((await readSettings()).statusline, { provider: false, "git-branch": true });
  await f.command("status");
  assert.match(f.notifications.at(-1).message, /git-branch\s+\[X\]/);
  assert.deepEqual(f.commands.get("statusline").getArgumentCompletions("git-branch ").map(item => item.value), ["git-branch on", "git-branch off"]);
  assert.deepEqual(f.authCalls, []);
});

test("git branch handles no repository, detached HEAD, and long Unicode names at narrow widths", async t => {
  await writeSettings({ statusline: { ...fieldSettings(false), "git-branch": true } });
  const f = await fixture(t, "unsupported");
  f.changeBranch(null);
  assert.equal(f.render(), "—");
  f.changeBranch("detached");
  assert.equal(f.render(), "detached");
  const branch = `feature/${"很長的分支名稱-".repeat(40)}`;
  f.changeBranch(branch);
  assert.equal(f.render(1000), branch);
  for (const mode of ["truecolor", "256color"]) {
    f.theme.getColorMode = () => mode;
    for (const width of [1, 10, 24, 40, 80]) {
      for (const line of f.raw(width)) assert.ok(visibleWidth(line) <= width);
      assert.doesNotMatch(f.render(width), /·/);
    }
  }
  await f.command("git-branch off");
  assert.deepEqual(f.raw(500), []);
});

test("git branch subscriptions are released when replacing the footer or closing the session", async t => {
  const f = await fixture(t, "unsupported");
  assert.equal(f.branchListenerCount, 1);
  await f.emit("session_start");
  assert.equal(f.branchListenerCount, 1, "Replacing the footer unsubscribes the old listener");
  f.ctx.ui.setFooter(undefined);
  assert.equal(f.branchListenerCount, 0);
  let redraws = f.redraws;
  f.changeBranch("after-dispose");
  assert.equal(f.redraws, redraws);
  await f.emit("session_start");
  assert.equal(f.branchListenerCount, 1);
  assert.equal(f.render().split(" · ")[2], "after-dispose");
  await f.emit("session_shutdown");
  await f.emit("session_shutdown");
  assert.equal(f.branchListenerCount, 0);
  redraws = f.redraws;
  f.changeBranch("after-shutdown");
  assert.equal(f.redraws, redraws);
});

test("effective response speeds include initial wait and thinking, but exclude tools and idle time", async t => {
  const f = await fixture(t, "unsupported");
  const clock = speedClock(t, f);
  assertSpeeds(f);
  assert.match(f.render(), /128K window · last — tok\/s · avg5 — tok\/s$/);
  clock.now += 60_000;
  await f.emit("turn_start");
  const user = { role: "user", content: "question", timestamp: 0 };
  await f.emit("message_start", { message: user });
  await f.emit("message_end", { message: user });
  // Both waiting before message_start and waiting for the first content count.
  clock.now += 9000;
  const message = clock.message(100, {
    stopReason: "toolUse",
    content: [
      { type: "thinking", thinking: "Inspect the file" },
      { type: "toolCall", id: "call", name: "read", arguments: { path: "large.log" } },
    ],
  });
  message.usage.reasoning = 60;
  await f.emit("message_start", { message });
  clock.now += 5000;
  await clock.delta(message, "thinking_delta", "Inspect the file");
  clock.now += 1000;
  await clock.delta(message, "toolcall_delta", '{"path":"large.log"}');
  clock.now += 1000;
  assertSpeeds(f);
  const redraws = f.redraws;
  await f.emit("message_end", { message });
  assertSpeeds(f, 100 / 16);
  assert.ok(f.redraws > redraws, "Completion redraws the footer immediately");
  clock.now += 90_000;
  const tool = { role: "toolResult", toolCallId: "call", toolName: "read", isError: false, timestamp: 0,
    content: [{ type: "text", text: "tool output ".repeat(10000) }], usage: { output: 999999 } };
  await f.emit("message_start", { message: tool });
  await f.emit("message_end", { message: tool });
  await f.emit("turn_end");
  assertSpeeds(f, 100 / 16);
  clock.now += 120_000;
  await clock.complete(100, 1000);
  assertSpeeds(f, 100, 200 / 17); // Total tokens / total response time, without the tool or idle gaps.
  await clock.delta(message); // A late chunk cannot reopen an already completed turn.
  await f.emit("message_end", { message });
  assertSpeeds(f, 100, 200 / 17);
  assert.deepEqual(f.authCalls, [], "Measuring speeds never queries the provider");
});

test("stream metadata and text, thinking, or tool-call deltas do not change the turn-start clock", async t => {
  const f = await fixture(t, "unsupported");
  const clock = speedClock(t, f);
  for (const type of ["text_delta", "thinking_delta", "toolcall_delta"]) {
    await f.emit("session_tree");
    const message = clock.message(40, { stopReason: type === "toolcall_delta" ? "toolUse" : "stop" });
    if (type === "thinking_delta") message.usage.reasoning = 20;
    await clock.start(message);
    clock.now += 1000;
    for (const metadata of ["start", "text_start", "thinking_start", "toolcall_start", "text_end", "thinking_end", "toolcall_end"]) {
      await f.emit("message_update", { message, assistantMessageEvent: { type: metadata, contentIndex: 0, partial: message } });
    }
    for (const emptyType of ["text_delta", "thinking_delta", "toolcall_delta"]) await clock.delta(message, emptyType, "");
    for (const different of [{ role: "toolResult" }, { timestamp: message.timestamp - 1 }, { model: "other" }, { provider: "other" }]) {
      await clock.delta({ ...message, ...different }, type);
    }
    clock.now += 9000;
    await clock.delta(message, type, " "); // Whitespace is real content, not an empty update.
    clock.now += 500;
    await clock.delta(message, type, "next");
    clock.now += 500;
    await f.emit("message_end", { message });
    assertSpeeds(f, 40 / 11);
  }
});

test("non-streamed, single-chunk, and buffered replies use the whole response time without a stream-span threshold", async t => {
  const f = await fixture(t, "unsupported");
  const clock = speedClock(t, f);
  for (const offsets of [[], [0], [0, 0], [0, 0.01, 0.02], [0, 99]]) {
    const message = clock.message(1000);
    await f.emit("turn_start");
    const startedAt = clock.now;
    // Bridge/non-streaming providers can emit message_start only after most of the wait.
    clock.now += 5000;
    await f.emit("message_start", { message });
    for (const offset of offsets) {
      clock.now = startedAt + 5000 + offset;
      await clock.delta(message);
    }
    clock.now = startedAt + 10_000;
    await f.emit("message_end", { message });
    await f.emit("turn_end");
    assertSpeeds(f, 100);
  }
  await f.emit("session_tree");
  await clock.complete(10, 100);
  await clock.complete(10, 25); // No arbitrary minimum response time or speed cap.
  assertSpeeds(f, 400, 20 / 0.125);
});

test("thinking is included once even when reasoning counts or thinking chunks are absent", async t => {
  const f = await fixture(t, "unsupported");
  const clock = speedClock(t, f);
  for (const reasoning of [undefined, 0, 60]) {
    await f.emit("session_tree");
    const message = clock.message(100);
    if (reasoning !== undefined) message.usage.reasoning = reasoning;
    await clock.start(message);
    clock.now += 30_000;
    await clock.delta(message);
    clock.now += 1000;
    await clock.delta(message);
    await f.emit("message_end", { message });
    assertSpeeds(f, 100 / 31);
    await clock.complete(20, 1000);
    assertSpeeds(f, 20, 120 / 32);
  }
});

test("DeepSeek bursts, Claude summaries, and Codex summary separators cannot inflate effective speeds", async t => {
  await writeSettings({ statusline: { "quota-reset": false } });
  const f = await fixture(t, "unsupported");
  const clock = speedClock(t, f);
  for (const scenario of [
    { provider: "deepseek", output: 140, reasoning: 0, wait: 9800, tail: 200,
      type: "toolcall_delta", delta: "{", lastType: "toolcall_delta", stopReason: "toolUse", expected: 14 },
    { provider: "claude-bridge", output: 3200, reasoning: 3000, wait: 30_000, tail: 2000,
      type: "thinking_delta", delta: "short summary", lastType: "text_delta", stopReason: "stop", expected: 100 },
    { provider: "openai-codex", output: 1000, reasoning: 800, wait: 19_000, tail: 1000,
      type: "thinking_delta", delta: "\n\n", lastType: "text_delta", stopReason: "stop", expected: 50 },
  ]) {
    await f.switch(scenario.provider);
    const message = clock.message(scenario.output, { stopReason: scenario.stopReason });
    message.usage.reasoning = scenario.reasoning;
    await f.emit("turn_start");
    clock.now += scenario.wait;
    await f.emit("message_start", { message });
    await clock.delta(message, scenario.type, scenario.delta);
    clock.now += scenario.tail;
    await clock.delta(message, scenario.lastType);
    await f.emit("message_end", { message });
    await f.emit("turn_end");
    assertSpeeds(f, scenario.expected);
  }
  assert.deepEqual(f.authCalls, [], "Speed measurement never requests provider credentials or APIs");
});

test("avg5 uses total tokens / total time for only the five latest valid responses without rounding samples", async t => {
  const f = await fixture(t, "unsupported");
  const clock = speedClock(t, f);
  const samples = [[100, 10_000], [200, 1000], [300, 5000], [400, 20_000], [500, 2000], [600, 500]];
  for (let i = 0; i < samples.length; i++) {
    const [tokens, milliseconds] = samples[i];
    await clock.complete(tokens, milliseconds, { stopReason: i === 1 ? "toolUse" : i === 2 ? "length" : "stop" });
    const recent = samples.slice(Math.max(0, i - 4), i + 1);
    const totalTokens = recent.reduce((sum, [count]) => sum + count, 0);
    const totalMs = recent.reduce((sum, [, duration]) => sum + duration, 0);
    assertSpeeds(f, tokens / (milliseconds / 1000), totalTokens / (totalMs / 1000));
  }
  await clock.complete(900, 1000, { stopReason: "error" });
  assertSpeeds(f, undefined, 2000 / 28.5); // Invalid replies do not evict valid history.
  await clock.complete(700, 1000);
  assertSpeeds(f, 700, 2500 / 28.5);
  await f.emit("session_tree");
  await clock.complete(3000, 30_000);
  await clock.complete(200, 125);
  assertSpeeds(f, 1600, 3200 / 30.125); // A short burst does not have the same weight as a long reply.
  await f.emit("session_tree");
  await clock.complete(4, 100_000);
  await clock.complete(4, 100_000);
  await clock.complete(9, 100_000);
  assertSpeeds(f, 0.1, 17 / 300); // The displayed 0.0, 0.0, 0.1 rates are never reused as samples.
});

test("invalid latest replies clear last, preserve avg5, and cannot be confused with unrelated or duplicate completions", async t => {
  const f = await fixture(t, "unsupported");
  const clock = speedClock(t, f);
  await clock.complete(10, 1000);
  for (const stopReason of ["error", "aborted", "pending", "deferred"]) {
    await clock.complete(900, 1000, { stopReason });
    assertSpeeds(f, undefined, 10);
  }
  for (const output of [undefined, null, 0, -1, 1.5, "100", NaN, Infinity, Number.MAX_VALUE]) {
    await clock.complete(output, 1000);
    assertSpeeds(f, undefined, 10);
  }
  await clock.complete(900, 1000, { usage: undefined });
  assertSpeeds(f, undefined, 10);
  for (const duration of [0, -1000, NaN, Infinity]) {
    clock.now = 10_000;
    await clock.complete(900, duration);
    assertSpeeds(f, undefined, 10);
  }
  clock.now = 10_000;
  const next = clock.message(20);
  await clock.start(next);
  await clock.delta(next);
  for (const different of [{ timestamp: next.timestamp - 1 }, { model: "other" }, { provider: "other" }]) {
    await f.emit("message_end", { message: { ...next, ...different } });
    assertSpeeds(f, undefined, 10);
  }
  clock.now += 1000;
  await clock.delta(next);
  await f.emit("message_end", { message: next });
  assertSpeeds(f, 20, 15);
  await f.emit("message_end", { message: next });
  assertSpeeds(f, 20, 15);
});

test("model changes reset both speeds and discard late completions without losing the new request", async t => {
  const f = await fixture(t, "unsupported");
  const clock = speedClock(t, f);
  await clock.complete(10, 1000);
  const old = clock.message(900);
  await clock.start(old);
  await f.switch("another", old.model); // Same model ID, different provider.
  assertSpeeds(f);
  const current = clock.message(20);
  await clock.start(current);
  clock.now += 500;
  await clock.delta(old);
  clock.now += 500;
  await clock.delta(current);
  clock.now += 1000;
  await f.emit("message_end", { message: old });
  assertSpeeds(f);
  await clock.delta(current);
  await f.emit("message_end", { message: current });
  assertSpeeds(f, 10);
  await f.switch("another", current.model); // Reselecting the same model is not a change.
  assertSpeeds(f, 10);
  await f.switch("another", "different-model");
  assertSpeeds(f);
});

test("thinking-level changes reset both speeds and discard in-flight measurements, but reselection preserves them", async t => {
  const f = await fixture(t, "unsupported");
  const clock = speedClock(t, f);
  await clock.complete(10, 1000);
  await f.emit("thinking_level_select", { level: "off", previousLevel: "off" });
  assertSpeeds(f, 10);
  const old = clock.message(900);
  await clock.start(old);
  const redraws = f.redraws;
  f.ctx.thinkingLevel = "high";
  await f.emit("thinking_level_select", { level: "high", previousLevel: "off" });
  assertSpeeds(f);
  assert.ok(f.redraws > redraws, "Thinking-level changes redraw the cleared speeds");
  const current = clock.message(20);
  await clock.start(current);
  clock.now += 1000;
  await f.emit("message_end", { message: old });
  assertSpeeds(f);
  await f.emit("message_end", { message: current });
  assertSpeeds(f, 20);
  await f.emit("thinking_level_select", { level: "high", previousLevel: "high" });
  assertSpeeds(f, 20);
});

test("branch and session changes clear speed history; ended turns cannot publish late results", async t => {
  const f = await fixture(t, "unsupported");
  const clock = speedClock(t, f);
  for (const event of ["session_tree", "session_start", "session_shutdown"]) {
    await clock.complete(10, 1000);
    const old = clock.message(900);
    await clock.start(old);
    await f.emit(event);
    if (event === "session_shutdown") await f.emit("session_start");
    assertSpeeds(f);
    const current = clock.message(20);
    await clock.start(current);
    await clock.delta(current);
    clock.now += 1000;
    await clock.delta(old);
    await f.emit("message_end", { message: old });
    assertSpeeds(f);
    await clock.delta(current);
    await f.emit("message_end", { message: current });
    assertSpeeds(f, 20);
  }
  for (const event of ["turn_end", "agent_end"]) {
    const unfinished = clock.message(900);
    await clock.start(unfinished);
    await clock.delta(unfinished);
    await f.emit(event);
    clock.now += 1000;
    await clock.delta(unfinished);
    await f.emit("message_end", { message: unfinished });
    assertSpeeds(f, 20);
  }
  await f.emit("session_shutdown");
  await clock.complete(900, 1000);
  await f.emit("session_start");
  assertSpeeds(f);
  assert.deepEqual(await readSettings(), {}, "Request timing and history stay in memory");
});

test("speed fields have independent persistent switches and keep measuring while hidden", async t => {
  await writeSettings({ statusline: fieldSettings(false) });
  const f = await fixture(t, "unsupported");
  const clock = speedClock(t, f);
  await clock.complete(10, 1000);
  await clock.complete(20, 1000);
  assert.deepEqual(f.raw(500), []);
  await f.command("output-speed on");
  assert.equal(f.render(), "last 20.0 tok/s");
  await f.command("output-speed-avg5 on");
  assertSpeeds(f, 20, 15);
  await f.command("output-speed off");
  await clock.complete(40, 1000);
  assert.equal(f.render(), "avg5 23.3 tok/s");
  await f.command("output-speed on");
  await f.command("output-speed-avg5 off");
  await clock.complete(50, 1000);
  assert.equal(f.render(), "last 50.0 tok/s");
  await f.command("output-speed-avg5 on");
  await f.command("context-window-tokens on");
  assert.equal(f.render(), "128K window · last 50.0 tok/s · avg5 30.0 tok/s");
  for (const mode of ["truecolor", "256color"]) {
    f.theme.getColorMode = () => mode;
    for (const width of [1, 10, 24, 40, 80]) {
      for (const line of f.raw(width)) assert.ok(visibleWidth(line) <= width);
    }
  }
  await f.command("output-speed off");
  await f.emit("session_shutdown");
  await f.emit("session_start");
  assert.equal(f.render(), "128K window · avg5 — tok/s");
  assert.deepEqual((await readSettings()).statusline,
    { ...fieldSettings(false), "context-window-tokens": true, "output-speed-avg5": true });
  for (const id of ["output-speed", "output-speed-avg5"]) {
    assert.deepEqual(f.commands.get("statusline").getArgumentCompletions(`${id} `).map(item => item.value), [`${id} on`, `${id} off`]);
  }
});

test("field switches persist across reload, preserve /fast, and replace obsolete provider switches", async t => {
  await writeSettings({ fast: true, future: { keep: true }, statusline: { future: "keep", deepseek: false, "claude-bridge": false } });
  t.mock.method(globalThis, "fetch", async () => Response.json(balancePayload("1")));
  const f = await fixture(t);
  await eventually(() => f.render().includes("USD 1.00"));
  await f.command("quota-reset off"); assert.doesNotMatch(f.render(), /USD|5h|weekly/);
  await f.command("remote off"); assert.doesNotMatch(f.render(), /remote/);
  assert.deepEqual(await readSettings(), { fast: true, future: { keep: true }, statusline: { future: "keep", "quota-reset": false, remote: false } });
  await f.command("model-with-thinking off");
  await f.switch("openai-codex");
  await f.commands.get("fast").handler("off", f.ctx);
  assert.equal((await readSettings()).fast, false);
  assert.equal((await readSettings()).statusline["quota-reset"], false);
  await f.emit("session_shutdown");
  const restored = await fixture(t);
  assert.doesNotMatch(restored.render(), /USD|5h|weekly|remote|test-deepseek/);
  assert.equal(restored.authCalls.length, 0);
  await restored.command("quota-reset");
  await eventually(() => restored.render().includes("USD 1.00"));
  assert.equal((await readSettings()).statusline["quota-reset"], true);
  assert.equal((await readdir(agentDir)).some(name => name.endsWith(".tmp")), false);
});

test("/statusline is a ten-field checkbox menu with aligned values and keyboard toggles", async t => {
  const f = await fixture(t, "unsupported");
  const opened = f.command("");
  const lines = f.renderMenu().split("\n").filter(line => line.includes("[X]"));
  assert.equal(lines.length, fieldIds.length);
  for (const [index, id] of fieldIds.entries()) assert.ok(lines[index].includes(id));
  assert.equal(new Set(lines.map(line => line.indexOf("[X]"))).size, 1, "Checkboxes align");
  assert.doesNotMatch(f.renderMenu(), /Codex quota|Antigravity|DeepSeek|Claude Bridge/);
  for (const [index, id] of fieldIds.entries()) {
    f.menu.handleInput(index % 2 ? "\r" : " ");
    await eventually(() => !f.renderMenu().includes("Saving…"));
    assert.match(f.renderMenu().split("\n").find(line => line.includes(id)), /\[ \]/);
    f.menu.handleInput("\x1b[B");
  }
  f.menu.handleInput("\x1b"); await opened;
  assert.equal(f.menu, undefined);
  assert.deepEqual((await readSettings()).statusline, fieldSettings(false));
  assert.deepEqual(f.raw(500), []);
  await f.command("status");
  assert.equal(f.notifications.at(-1).message.match(/\[ \]/g).length, fieldIds.length);
  const before = await readFile(settingsPath, "utf8");
  const cancelled = f.command(""); f.menu.handleInput("\x03"); await cancelled;
  assert.equal(await readFile(settingsPath, "utf8"), before);
  for (const args of ["deepseek off", "provider invalid", "provider on extra"]) {
    await f.command(args); assert.equal(f.notifications.at(-1).level, "warning");
  }
  assert.equal(await readFile(settingsPath, "utf8"), before);
  assert.deepEqual(f.commands.get("statusline").getArgumentCompletions("quota-reset ").map(item => item.value), ["quota-reset on", "quota-reset off"]);
});

test("checkbox menu saves rapid toggles in order and waits for them before closing", async t => {
  const f = await fixture(t, "unsupported");
  const opened = f.command("");
  f.menu.handleInput(" "); f.menu.handleInput(" ");
  f.menu.handleInput("\x1b[B"); f.menu.handleInput(" ");
  f.menu.handleInput("\x1b"); await opened;
  assert.deepEqual((await readSettings()).statusline, { "model-with-thinking": true, provider: false });
  assert.match(f.render(), /test-unsupported/);
  assert.ok(!f.render().split(" · ").includes("unsupported"));
});

test("checkbox menu rolls back failed saves and remains usable", async t => {
  const f = await fixture(t, "unsupported");
  await writeFile(settingsPath, "{broken");
  const opened = f.command("");
  f.menu.handleInput(" ");
  await eventually(() => f.notifications.some(item => item.level === "error"));
  assert.match(f.renderMenu().split("\n").find(line => line.includes("model-with-thinking")), /\[X\]/);
  assert.match(f.render(), /test-unsupported/);
  assert.equal(await readFile(settingsPath, "utf8"), "{broken");
  await writeSettings({});
  f.menu.handleInput(" "); f.menu.handleInput("\x1b"); await opened;
  assert.equal((await readSettings()).statusline["model-with-thinking"], false);
});

test("branch changes, reload, and shutdown close the menu and finish accepted toggles and moves", async t => {
  for (const event of ["session_tree", "session_start", "session_shutdown"]) {
    await writeSettings({});
    const f = await fixture(t, "unsupported");
    const opened = f.command("");
    f.menu.handleInput(" ");
    f.menu.handleInput("d"); f.menu.handleInput("d");
    await f.emit(event); await opened;
    assert.equal(f.menu, undefined);
    const expected = fieldsFirst("provider", "git-branch", "model-with-thinking");
    assert.deepEqual((await readSettings()).statusline, { "model-with-thinking": false, order: expected });
    if (event === "session_shutdown") assert.deepEqual(f.raw(500), []);
    else {
      assert.deepEqual(await reportedOrder(f), expected);
      assert.doesNotMatch(f.render(), /test-unsupported/);
      assert.deepEqual(f.render().split(" · ").slice(0, 2), ["unsupported", "main"]);
    }
  }
});

test("checkbox menu supports mouse input and narrow widths without hiding its checkbox column", async t => {
  const f = await fixture(t, "unsupported");
  const opened = f.command("");
  for (const width of [1, 10, 24, 40, 80]) {
    const lines = f.menu.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    if (width >= 10) assert.equal(stripVTControlCharacters(lines.join("\n")).match(/\[X\]/g)?.length, fieldIds.length);
  }
  const remoteRow = 2 + fieldIds.indexOf("remote");
  f.menu.handleMouse({ type: "press", button: "left", x: 3, y: remoteRow });
  f.menu.handleMouse({ type: "click", button: "left", x: 3, y: remoteRow });
  await eventually(() => !f.renderMenu().includes("Saving…"));
  assert.doesNotMatch(f.render(), /remote/);
  f.menu.handleInput("\x1b"); await opened;
  assert.deepEqual((await readSettings()).statusline, { remote: false });
});

test("saved order is shared by the menu, status, and footer, and hidden fields keep their position across reload", async t => {
  const saved = { fast: true, future: { keep: true }, statusline: { order: ["remote", "provider", "git-branch"], provider: false, future: "keep" } };
  await writeSettings(saved);
  const f = await fixture(t, "unsupported");
  const expected = fieldsFirst("remote", "provider", "git-branch");
  assert.deepEqual(await reportedOrder(f), expected);
  assert.deepEqual(f.render().split(" · ").slice(0, 3), ["remote worker", "main", "test-unsupported"]);
  const opened = f.command("");
  assert.deepEqual(menuFields(f), expected);
  assert.match(f.renderMenu(), /provider\s+\[ \]/);
  f.menu.handleInput("\x1b"); await opened;
  assert.deepEqual(await readSettings(), saved, "Reading a partial order does not rewrite it");
  await f.command("provider on");
  assert.deepEqual(f.render().split(" · ").slice(0, 4), ["remote worker", "unsupported", "main", "test-unsupported"]);
  await f.command("provider off");
  await f.emit("session_start");
  assert.deepEqual(await reportedOrder(f), expected);
  assert.deepEqual(f.render().split(" · ").slice(0, 3), ["remote worker", "main", "test-unsupported"]);
  await f.command("provider on");
  assert.deepEqual(f.render().split(" · ").slice(0, 3), ["remote worker", "unsupported", "main"]);
  assert.deepEqual(await readSettings(), { ...saved, statusline: { ...saved.statusline, provider: true } });
});

test("u/d move the selected field immediately and rapid moves and toggles save in order before closing", async t => {
  const f = await fixture(t, "unsupported");
  const opened = f.command("");
  assert.match(f.renderMenu(), /u up · d down/);
  f.menu.handleInput("\x1b[B"); // Select provider.
  f.menu.handleInput("u");
  assert.deepEqual(menuFields(f), fieldsFirst("provider"));
  assert.equal(selectedMenuField(f), "provider");
  f.menu.handleInput("d"); f.menu.handleInput("d");
  assert.deepEqual(menuFields(f), fieldsFirst("model-with-thinking", "git-branch", "provider"));
  assert.equal(selectedMenuField(f), "provider");
  f.menu.handleInput(" "); // Hide provider at its new position.
  f.menu.handleInput("\x1b[B"); // Select remote.
  f.menu.handleInput("d"); f.menu.handleInput("\r");
  assert.equal(selectedMenuField(f), "remote");
  const expected = fieldsFirst("model-with-thinking", "git-branch", "provider", "context-used-percentage", "remote");
  assert.deepEqual(menuFields(f), expected);
  f.menu.handleInput("\x1b"); await opened;
  assert.deepEqual((await readSettings()).statusline, { order: expected, provider: false, remote: false });
  assert.deepEqual(await reportedOrder(f), expected);
  assert.deepEqual(f.render().split(" · ").slice(0, 3), ["test-unsupported", "main", "8% context used"]);
  await f.emit("session_start");
  assert.deepEqual(await reportedOrder(f), expected);
});

test("moving beyond either end does nothing and navigation alone never saves an order", async t => {
  const f = await fixture(t, "unsupported");
  const opened = f.command("");
  f.menu.handleInput("u");
  f.menu.handleInput("\x1b[A"); // Selection wraps; reordering must not wrap.
  assert.equal(selectedMenuField(f), "output-speed-avg5");
  f.menu.handleInput("d");
  f.menu.handleInput("\x15"); f.menu.handleInput("\x04"); // Ctrl+u / Ctrl+d are not plain u/d.
  assert.deepEqual(menuFields(f), fieldIds);
  assert.doesNotMatch(f.renderMenu(), /Saving/);
  f.menu.handleInput("\x1b"); await opened;
  await f.command("move model-with-thinking up");
  await f.command("move output-speed-avg5 down");
  assert.deepEqual(await readSettings(), {});
});

test("failed move saves roll back to the last saved order without losing selection or checkbox state", async t => {
  const f = await fixture(t, "unsupported");
  await f.command("move git-branch up");
  const saved = await readSettings();
  const original = fieldsFirst("model-with-thinking", "git-branch", "provider");
  await writeFile(settingsPath, "{broken");
  const opened = f.command("");
  f.menu.handleInput("d"); f.menu.handleInput("d"); f.menu.handleInput(" ");
  await eventually(() => f.notifications.filter(item => item.level === "error").length === 3 && !f.renderMenu().includes("Saving…"));
  assert.deepEqual(menuFields(f), original);
  assert.equal(selectedMenuField(f), "model-with-thinking");
  assert.match(f.renderMenu(), /model-with-thinking\s+\[X\]/);
  assert.match(f.render(), /^test-unsupported · main · unsupported/);
  assert.equal(await readFile(settingsPath, "utf8"), "{broken");
  await writeSettings(saved);
  f.menu.handleInput("d"); f.menu.handleInput("\r");
  f.menu.handleInput("\x1b"); await opened;
  assert.deepEqual((await readSettings()).statusline, { order: fieldsFirst("git-branch", "model-with-thinking", "provider"), "model-with-thinking": false });
  assert.deepEqual(f.render().split(" · ").slice(0, 2), ["main", "unsupported"]);
});

test("reordering follows mouse selection in a scrolled list and survives resizing and narrow widths", async t => {
  const f = await fixture(t, "unsupported");
  f.terminal.rows = 8;
  const opened = f.command("");
  for (let i = 0; i < 6; i++) f.menu.handleInput("\x1b[B");
  assert.equal(selectedMenuField(f), "context-used-tokens");
  assert.ok(f.menu.render(80).length <= f.terminal.rows);
  // Press selects the first visible row. It stays selected even if the viewport recenters before click.
  f.menu.handleMouse({ type: "press", button: "left", x: 3, y: 2 });
  assert.equal(selectedMenuField(f), "quota-reset");
  f.menu.handleMouse({ type: "click", button: "left", x: 3, y: 2 });
  f.menu.handleInput("d");
  assert.equal(selectedMenuField(f), "quota-reset");
  f.terminal.rows = 24;
  const expected = [...fieldIds];
  [expected[5], expected[6]] = [expected[6], expected[5]];
  assert.deepEqual(menuFields(f), expected);
  assert.equal(selectedMenuField(f), "quota-reset");
  for (const width of [1, 10, 24, 40, 80]) {
    for (const line of f.menu.render(width)) assert.ok(visibleWidth(line) <= width);
    if (width >= 10) assert.equal(f.renderMenu(width).match(/\[[X ]\]/g)?.length, fieldIds.length);
  }
  f.menu.handleInput("\x1b"); await opened;
  assert.deepEqual((await readSettings()).statusline, { "quota-reset": false, order: expected });
});

test("finishing a move save between mouse press and click preserves the pressed field", async t => {
  const f = await fixture(t, "unsupported");
  f.terminal.rows = 8;
  const opened = f.command("");
  for (let i = 0; i < 6; i++) f.menu.handleInput("\x1b[B");
  f.menu.handleInput("d"); // Move context-used-tokens below context-window-tokens.
  f.menu.handleMouse({ type: "press", button: "left", x: 3, y: 2 });
  assert.equal(selectedMenuField(f), "context-window-tokens");
  await eventually(() => !f.renderMenu().includes("Saving…"));
  f.menu.handleMouse({ type: "click", button: "left", x: 3, y: 2 });
  assert.equal(selectedMenuField(f), "context-window-tokens");
  f.menu.handleInput("\x1b"); await opened;
  assert.equal((await readSettings()).statusline["context-window-tokens"], false);
  assert.equal((await readSettings()).statusline["quota-reset"], undefined);
});

test("concurrent move commands accumulate, reset changes only order, and invalid commands never write", async t => {
  await writeSettings({ fast: true, future: { keep: true }, statusline: { "quota-reset": false, future: "keep" } });
  const f = await fixture(t, "openai-codex");
  await Promise.all([f.command("move provider down"), f.command("move provider down"), f.command("remote off"),
    f.commands.get("fast").handler("off", f.ctx)]);
  const expected = fieldsFirst("model-with-thinking", "git-branch", "remote", "provider");
  const saved = { fast: false, future: { keep: true }, statusline: { "quota-reset": false, future: "keep", remote: false, order: expected } };
  assert.deepEqual(await readSettings(), saved);
  assert.deepEqual(await reportedOrder(f), expected);
  await f.command("reset-order");
  assert.deepEqual(await readSettings(), { ...saved, statusline: { ...saved.statusline, order: fieldIds } });
  assert.deepEqual(await reportedOrder(f), fieldIds);
  const before = await readFile(settingsPath, "utf8");
  for (const args of ["move", "move provider", "move provider sideways", "move unknown up", "move provider up extra", "reset-order extra"]) {
    await f.command(args);
    assert.equal(f.notifications.at(-1).level, "warning", args);
    assert.equal(await readFile(settingsPath, "utf8"), before);
  }
  const command = f.commands.get("statusline");
  assert.deepEqual(command.getArgumentCompletions("move provider ").map(item => item.value), ["move provider up", "move provider down"]);
  assert.deepEqual(command.getArgumentCompletions("reset-").map(item => item.value), ["reset-order"]);
  for (const contents of ["{broken", "null", "[]"]) {
    await writeFile(settingsPath, contents);
    for (const args of ["move provider up", "reset-order"]) {
      await f.command(args);
      assert.equal(f.notifications.at(-1).level, "error");
      assert.equal(await readFile(settingsPath, "utf8"), contents);
      assert.deepEqual(await reportedOrder(f), fieldIds);
    }
  }
  assert.deepEqual(f.authCalls, []);
});

test("custom order keeps quotas together in full and compact layouts and omits unsupported fields cleanly", async t => {
  await writeSettings({ statusline: { ...fieldSettings(false), "context-used-percentage": true, "quota-reset": true,
    order: ["context-used-percentage", "quota-reset"] } });
  t.mock.method(globalThis, "fetch", async () => Response.json({ rate_limit: {
    primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_after_seconds: 7200 },
    secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_after_seconds: 259200 },
  } }));
  const f = await fixture(t, "openai-codex");
  await eventually(() => f.render().includes("5h 70%"));
  assert.equal(f.render(), "8% context used · 5h 70% left 2h · weekly 50% left 3d");
  for (const label of ["week", "wk"]) {
    const text = `ctx 8% · 5h 70% 2h · ${label} 50% 3d`;
    assert.equal(f.render(visibleWidth(text)), text);
  }
  await f.command("move quota-reset up");
  assert.equal(f.render(), "5h 70% left 2h · weekly 50% left 3d · 8% context used");
  for (const mode of ["truecolor", "256color"]) {
    f.theme.getColorMode = () => mode;
    for (const width of [1, 10, 24, 40, 80]) for (const line of f.raw(width)) assert.ok(visibleWidth(line) <= width);
  }
  await f.switch("unsupported");
  assert.equal(f.render(), "8% context used");
  await f.command("context-used-percentage off");
  assert.deepEqual(f.raw(500), []);
});

test("moving fields never restarts quota polling, changes fast mode, or resets response speeds", async t => {
  await writeSettings({ fast: true });
  const requests = t.mock.method(globalThis, "fetch", async () => Response.json({ rate_limit: {
    primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_after_seconds: 7200 },
  } }));
  const f = await fixture(t, "openai-codex");
  await eventually(() => f.render().includes("5h 70%"));
  const clock = speedClock(t, f);
  await clock.complete(20, 1000);
  await f.command("move quota-reset up");
  await f.command("move output-speed up");
  assert.match(f.render(), /last 20\.0 tok\/s · 128K window · avg5 20\.0 tok\/s$/);
  await f.command("reset-order");
  assertSpeeds(f, 20);
  assert.match(f.render(), /test-openai-codex fast/);
  assert.equal((await readSettings()).fast, true);
  assert.equal(requests.mock.callCount(), 1);
});

test("each of the ten fields can be the only visible field, and all-off leaves no footer", async t => {
  await writeSettings({ statusline: fieldSettings(false) });
  const requests = t.mock.method(globalThis, "fetch", async () => Response.json(balancePayload("12.34")));
  const f = await fixture(t);
  f.ctx.model.id = "model-fixture"; f.ctx.thinkingLevel = "high";
  const expected = ["model-fixture high", "deepseek", "main", "remote worker", "8% context used", "USD 12.34 left", "10K used", "128K window", "last — tok/s", "avg5 — tok/s"];
  assert.deepEqual(f.raw(500), []); assert.equal(requests.mock.callCount(), 0);
  for (const [index, id] of fieldIds.entries()) {
    await f.command(`${id} on`);
    if (id === "quota-reset") await eventually(() => f.render().includes("USD 12.34"));
    assert.equal(f.render(), expected[index], id);
    for (const width of [1, 10, 24, 80]) {
      for (const line of f.raw(width)) assert.ok(visibleWidth(line) <= width);
      assert.doesNotMatch(f.render(width), /·/);
    }
    await f.command(`${id} off`); assert.deepEqual(f.raw(500), []);
  }
  assert.equal(requests.mock.callCount(), 1, "Only the quota field triggers a query");
  f.ctx.isIdle = () => false; f.ctx.ui.getEditorText = () => "queued message";
  assert.match(f.render(), /tab\/enter to queue/, "Queue help is independent of the statusline fields");
});

test("hiding individual fields neither changes fast mode nor restarts quota polling", async t => {
  await writeSettings({ fast: true });
  const requests = t.mock.method(globalThis, "fetch", async () => Response.json({ rate_limit: {
    primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_after_seconds: 7200 },
    secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_after_seconds: 259200 },
  } }));
  const f = await fixture(t, "openai-codex");
  f.ctx.thinkingLevel = "high";
  await eventually(() => f.render().includes("5h 70%"));
  assert.match(f.render(), /test-openai-codex high fast/);
  const full = f.render().split(" · ");
  for (const [id, text] of [["model-with-thinking", full[0]], ["provider", full[1]], ["git-branch", full[2]], ["remote", full[3]],
    ["context-used-percentage", full[4]], ["context-used-tokens", full.at(-4)], ["context-window-tokens", full.at(-3)],
    ["output-speed", full.at(-2)], ["output-speed-avg5", full.at(-1)]]) {
    await f.command(`${id} off`);
    assert.deepEqual(f.render().split(" · "), full.filter(part => part !== text));
    await f.command(`${id} on`);
  }
  assert.equal((await readSettings()).fast, true);
  assert.equal(requests.mock.callCount(), 1);
  await f.command("model-with-thinking off"); await f.command("remote off");
  await f.command("context-used-percentage off");
  assert.doesNotMatch(f.render(80), /test-openai-codex|high|fast|remote|ctx|context/);
  assert.match(f.render(80), /5h 70%/);
  assert.doesNotMatch(f.render(80), /^ · | · $|·\s*·/);
});

test("settings saves serialize field patches and refuse to overwrite corrupt or unwritable settings", async t => {
  const f = await fixture(t, "unsupported");
  await Promise.all([f.command("provider off"), f.command("remote off")]);
  assert.deepEqual((await readSettings()).statusline, { provider: false, remote: false });
  for (const contents of ["{broken", "null", "[]"]) {
    await writeFile(settingsPath, contents);
    await f.command("provider on");
    assert.equal(await readFile(settingsPath, "utf8"), contents);
    assert.equal(f.notifications.at(-1).level, "error");
    await f.command("status"); assert.match(f.notifications.at(-1).message, /provider\s+\[ \]/);
  }
  await rm(settingsPath); await mkdir(settingsPath);
  try { await f.command("provider on"); assert.equal(f.notifications.at(-1).level, "error"); }
  finally { await rm(settingsPath, { recursive: true }); }
});

test("switch/off/shutdown cancel in-flight fetches, ignore late results, and never leak old data", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", (url, options) => { const gate = deferred(); requests.push({ url, options, gate }); return gate.promise; });
  const f = await fixture(t);
  await eventually(() => requests.length === 1);
  assert.match(f.render(), /USD …/);
  await f.switch("unsupported"); assert.equal(requests[0].options.signal.aborted, true);
  requests[0].gate.resolve(Response.json(balancePayload("999"))); await tick();
  assert.doesNotMatch(f.render(), /999|USD/);
  await f.switch("deepseek"); await eventually(() => requests.length === 2);
  await f.command("quota-reset off"); assert.equal(requests[1].options.signal.aborted, true);
  requests[1].gate.resolve(Response.json(balancePayload("888"))); await tick();
  assert.doesNotMatch(f.render(), /888|USD/);
  await f.command("quota-reset on"); await eventually(() => requests.length === 3);
  await f.emit("session_shutdown"); assert.equal(requests[2].options.signal.aborted, true);
  const redraws = f.redraws;
  requests[2].gate.resolve(Response.json(balancePayload("777"))); await tick();
  assert.equal(f.redraws, redraws); assert.equal(f.render(), "");
});

test("polling refreshes only the visible provider every minute and disabling removes its timer", async t => {
  const timers = new Set();
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, delay, ...args) => {
    if (delay !== 60_000 && delay !== 30_000) return set(fn, delay, ...args);
    const timer = { fn, delay, unref() {} }; timers.add(timer); return timer;
  });
  t.mock.method(globalThis, "clearTimeout", timer => { if (!timers.delete(timer)) clear(timer); });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => Response.json(balancePayload(String(++calls))));
  const f = await fixture(t);
  await eventually(() => f.render().includes("USD 1.00"));
  const poll = [...timers].find(timer => timer.delay === 60_000);
  assert.ok(poll); timers.delete(poll); poll.fn();
  await eventually(() => f.render().includes("USD 2.00"));
  assert.equal(calls, 2);
  assert.equal([...timers].filter(timer => timer.delay === 60_000).length, 1);
  await f.command("quota-reset off");
  assert.equal([...timers].filter(timer => timer.delay === 60_000).length, 0);
  await f.switch("unsupported"); assert.equal(calls, 2);
  await f.emit("session_shutdown"); assert.equal(timers.size, 0);
});

test("the quota field switch applies to every provider rather than following old provider toggles", async t => {
  await writeSettings({ statusline: { "quota-reset": false } });
  const f = await fixture(t);
  for (const provider of ["openai-codex", "antigravity", "claude-bridge", "deepseek"]) {
    await f.switch(provider);
    assert.doesNotMatch(f.render(), /USD|5h|weekly/);
  }
  assert.deepEqual(f.authCalls, []);
  assert.equal(sdkFixture.unexpected, 0);
  const requests = t.mock.method(globalThis, "fetch", async () => Response.json(balancePayload("3")));
  await f.command("provider off");
  assert.equal(requests.mock.callCount(), 0);
  await f.command("quota-reset on");
  await eventually(() => f.render().includes("USD 3.00"));
  assert.equal(requests.mock.callCount(), 1);
  assert.ok(!f.render().split(" · ").includes("deepseek"));
});

test("a replaced session ignores a late response even after the new session is running", async t => {
  const gate = deferred(); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1 ? gate.promise : Response.json(balancePayload("2")));
  const f = await fixture(t); await eventually(() => calls === 1);
  await f.emit("session_shutdown"); await f.emit("session_start");
  await eventually(() => f.render().includes("USD 2.00"));
  gate.resolve(Response.json(balancePayload("100"))); await tick();
  assert.match(f.render(), /USD 2.00/); assert.doesNotMatch(f.render(), /100.00/);
});

test("non-TUI sessions never fetch usage, but direct statusline commands still save settings", async t => {
  for (const mode of ["rpc", "json", "print"]) {
    const f = await fixture(t, "claude-bridge", mode);
    await f.command("quota-reset off");
    await f.switch("deepseek");
    assert.equal(f.authCalls.length, 0); assert.equal(f.render(), "");
    assert.equal(f.branchListenerCount, 0); assert.equal(f.branchReads, 0);
    assert.equal((await readSettings()).statusline["quota-reset"], false);
    await f.command(""); assert.equal(f.notifications.at(-1).level, "warning");
    assert.equal(f.menu, undefined);
    await f.command("move provider up");
    assert.deepEqual((await readSettings()).statusline.order, fieldsFirst("provider"));
    assert.deepEqual(await reportedOrder(f), fieldsFirst("provider"));
    await f.command("reset-order");
    assert.deepEqual((await readSettings()).statusline.order, fieldIds);
    assert.deepEqual(f.authCalls, []);
  }
});

test("Claude Bridge uses the installed SDK and configured executable without prompts, hooks, or tools", async t => {
  await writeFile(join(agentDir, "claude-bridge.json"), JSON.stringify({ provider: { pathToClaudeCodeExecutable: "/global/claude" } }));
  await writeFile(join(cwd, ".pi", "claude-bridge.json"), JSON.stringify({ provider: { pathToClaudeCodeExecutable: "/project/claude" } }));
  let calls = 0, closes = 0, input;
  sdkFixture.query = ({ prompt, options }) => {
    calls++;
    assert.equal(typeof prompt, "object"); input = prompt[Symbol.asyncIterator]().next();
    assert.equal(options.cwd, cwd); assert.equal(options.pathToClaudeCodeExecutable, "/project/claude");
    assert.deepEqual(options.tools, []); assert.deepEqual(options.mcpServers, {});
    assert.equal(options.strictMcpConfig, true); assert.deepEqual(options.settingSources, []);
    assert.equal(options.persistSession, false); assert.equal(options.permissionMode, "dontAsk");
    assert.equal(options.settings.disableAllHooks, true); assert.equal(options.env.ENABLE_CLAUDEAI_MCP_SERVERS, "0");
    assert.ok(options.abortController instanceof AbortController);
    return { [CLAUDE_USAGE_METHOD]: async options => { assert.equal(options.skipBehaviors, true); return claudePayload(); }, close: () => { closes++; } };
  };
  const f = await fixture(t, "claude-bridge");
  await eventually(() => f.render().includes("5h 75% left 2h"));
  assert.match(f.render(), /weekly 40% left 3d/); assert.doesNotMatch(f.render(), /USD/);
  assert.equal(calls, 1); assert.equal(f.authCalls.length, 0);
  await f.command("quota-reset off");
  assert.doesNotMatch(f.render(), /5h|weekly/); assert.equal(closes, 1);
  assert.deepEqual(await input, { done: true, value: undefined });
  await f.command("quota-reset on");
  await eventually(() => f.render().includes("5h 75% left"));
  await f.switch("unsupported"); assert.equal(closes, 2);
});

for (const trafficBlock of ["1", undefined]) {
  test(`Claude quota helper allows usage with traffic block ${trafficBlock ?? "unset"} without changing the host environment`, async t => {
    const inherited = {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: trafficBlock,
      DISABLE_TELEMETRY: "",
      DISABLE_ERROR_REPORTING: "",
      DISABLE_AUTOUPDATER: "0",
      DISABLE_FEEDBACK_COMMAND: "0",
      ENABLE_CLAUDEAI_MCP_SERVERS: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "fake-claude-token",
    };
    const previous = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]));
    const restore = values => {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    };
    t.after(() => restore(previous));
    restore(inherited);
    let options;
    sdkFixture.query = params => {
      options = params.options;
      return {
        [CLAUDE_USAGE_METHOD]: async () => options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
          ? { rate_limits_available: true, rate_limits: null }
          : claudePayload(),
        close() {},
      };
    };
    const f = await fixture(t, "claude-bridge");
    await eventually(() => options !== undefined);
    assert.notEqual(options.env, process.env);
    // "0" and "false" still block usage: Claude Code checks for a non-empty value.
    assert.ok(!options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC);
    for (const key of ["DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "DISABLE_AUTOUPDATER", "DISABLE_FEEDBACK_COMMAND"]) {
      assert.equal(options.env[key], "1", `${key} must remain disabled in the helper`);
    }
    assert.equal(options.env.ENABLE_CLAUDEAI_MCP_SERVERS, "0");
    for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "PATH", "HOME"]) assert.equal(options.env[key], process.env[key]);
    await eventually(() => f.render().includes("5h 75% left 2h"));
    assert.match(f.render(), /weekly 40% left 3d/);
    await f.emit("session_shutdown");
    assert.deepEqual(Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]])), inherited);
  });
}

test("Claude Bridge API-key sessions or changed response shapes show unavailable and close the process", async t => {
  let closes = 0;
  sdkFixture.query = () => ({ [CLAUDE_USAGE_METHOD]: async () => ({ rate_limits_available: false, rate_limits: null }), close: () => { closes++; } });
  const f = await fixture(t, "claude-bridge");
  await eventually(() => f.render().includes("5h -"));
  assert.doesNotMatch(f.render(), /100%|0%|USD/); assert.equal(closes, 1);
});

test("missing USD balance shows n/a, zero is real data, and footer fits narrow/ANSI-256 terminals", async t => {
  const response = t.mock.method(globalThis, "fetch", async () => Response.json({ balance_infos: [{ currency: "CNY", total_balance: "99" }] }));
  const f = await fixture(t);
  await eventually(() => f.render().includes("USD n/a"));
  assert.doesNotMatch(f.render(), /99|0.00/);
  response.mock.mockImplementation(async () => Response.json(balancePayload("0")));
  await f.switch("deepseek"); await eventually(() => f.render().includes("USD 0.00 left"));
  for (const mode of ["truecolor", "256color"]) {
    f.theme.getColorMode = () => mode;
    for (const width of [1, 10, 40, 80, 120, 180, 500]) {
      for (const line of f.raw(width)) assert.ok(visibleWidth(line) <= width, `Footer overflows ${width}`);
    }
  }
  await f.command("quota-reset off");
  for (const width of [80, 120, 500]) {
    assert.doesNotMatch(f.render(width), /USD|5h|weekly|·\s*·/);
  }
});
