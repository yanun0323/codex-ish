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
const { parseDeepSeekBalance, fetchDeepSeekBalance, parseClaudeBridgeQuotas, parseStatuslineSettings } = extension;
const { ClaudeUsageReader, CLAUDE_USAGE_METHOD } = await jiti.import(resolve(here, "..", "extensions", "lib", "claude-usage.ts"));
const { visibleWidth, getKeybindings } = await import(join(piRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"));
const { initTheme } = await import(join(piRoot, "dist/modes/interactive/theme/theme.js"));
initTheme("dark", false);
const fieldIds = ["model-with-thinking", "provider", "remote", "context-used-percentage", "quota-reset", "context-used-tokens", "context-window-tokens"];
const fieldSettings = enabled => Object.fromEntries(fieldIds.map(id => [id, enabled]));
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
  const notifications = [];
  const authCalls = [];
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
      setFooter(factory) { footer = factory?.({ requestRender() { redraws++; } }, theme); },
      select: async () => { throw new Error("Statusline should use a checkbox list, not a select dialog"); },
      custom: factory => new Promise(done => {
        menu = factory({ terminal: { rows: 24 }, requestRender() { redraws++; } }, theme, getKeybindings(), () => {
          menu?.dispose?.(); menu = undefined; done();
        });
      }),
    },
  };
  const emit = async (name, event = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  t.after(() => emit("session_shutdown"));
  await emit("session_start");
  return { ctx, commands, notifications, authCalls, theme, emit,
    command: args => commands.get("statusline").handler(args, ctx),
    render: (width = 500) => stripVTControlCharacters(footer?.render(width).join("\n") ?? ""),
    raw: width => footer?.render(width) ?? [],
    get menu() { return menu; },
    renderMenu: (width = 80) => stripVTControlCharacters(menu?.render(width).join("\n") ?? ""),
    get redraws() { return redraws; },
    switch: async (provider, id) => {
      const previousModel = ctx.model;
      ctx.model = model(provider);
      if (id) ctx.model.id = id;
      await emit("model_select", { model: ctx.model, previousModel, source: "set" });
    },
  };
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

test("seven field switches default to on, use explicit false, and ignore old provider switches", () => {
  const defaults = fieldSettings(true);
  for (const value of [undefined, null, [], { fast: true }, { provider: "false", remote: 0 },
    { codex: false, antigravity: false, deepseek: false, "claude-bridge": false }]) {
    assert.deepEqual(parseStatuslineSettings(value), defaults);
  }
  assert.deepEqual(parseStatuslineSettings({ provider: false, "quota-reset": false, unknown: false }),
    { ...defaults, provider: false, "quota-reset": false });
  assert.deepEqual(parseStatuslineSettings(fieldSettings(false)), fieldSettings(false));
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

test("/statusline is a seven-field checkbox menu with aligned values and keyboard toggles", async t => {
  const f = await fixture(t, "unsupported");
  const opened = f.command("");
  const lines = f.renderMenu().split("\n").filter(line => line.includes("[X]"));
  assert.equal(lines.length, 7);
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
  assert.equal(f.notifications.at(-1).message.match(/\[ \]/g).length, 7);
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

test("branch changes and shutdown close the menu and finish accepted saves", async t => {
  for (const event of ["session_tree", "session_shutdown"]) {
    await writeSettings({});
    const f = await fixture(t, "unsupported");
    const opened = f.command("");
    f.menu.handleInput(" ");
    await f.emit(event); await opened;
    assert.equal(f.menu, undefined);
    assert.equal((await readSettings()).statusline["model-with-thinking"], false);
    if (event === "session_shutdown") assert.deepEqual(f.raw(500), []);
  }
});

test("checkbox menu supports mouse input and narrow widths without hiding its checkbox column", async t => {
  const f = await fixture(t, "unsupported");
  const opened = f.command("");
  for (const width of [1, 10, 24, 40, 80]) {
    const lines = f.menu.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    if (width >= 10) assert.equal(stripVTControlCharacters(lines.join("\n")).match(/\[X\]/g)?.length, 7);
  }
  f.menu.handleMouse({ type: "press", button: "left", x: 3, y: 4 });
  f.menu.handleMouse({ type: "click", button: "left", x: 3, y: 4 });
  await eventually(() => !f.renderMenu().includes("Saving…"));
  assert.doesNotMatch(f.render(), /remote/);
  f.menu.handleInput("\x1b"); await opened;
  assert.deepEqual((await readSettings()).statusline, { remote: false });
});

test("each of the seven fields can be the only visible field, and all-off leaves no footer", async t => {
  await writeSettings({ statusline: fieldSettings(false) });
  const requests = t.mock.method(globalThis, "fetch", async () => Response.json(balancePayload("12.34")));
  const f = await fixture(t);
  f.ctx.model.id = "model-fixture"; f.ctx.thinkingLevel = "high";
  const expected = ["model-fixture high", "deepseek", "remote worker", "8% context used", "USD 12.34 left", "10K used", "128K window"];
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
  for (const [id, text] of [["model-with-thinking", full[0]], ["provider", full[1]], ["remote", full[2]],
    ["context-used-percentage", full[3]], ["context-used-tokens", full.at(-2)], ["context-window-tokens", full.at(-1)]]) {
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
    assert.equal((await readSettings()).statusline["quota-reset"], false);
    await f.command(""); assert.equal(f.notifications.at(-1).level, "warning");
    assert.equal(f.menu, undefined);
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
