// Offline Side regressions: fake models and local files only; no credentials or paid requests.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
const extension = await jiti.import(resolve(here, "..", "extensions", "codex-ish.ts"));
const { createSideMessages, runSideTurn, SIDE_MAX_MODEL_CALLS, SIDE_MAX_TOOL_CALLS } = extension;
const { createReadOnlyTools } = await import(join(piRoot, "dist/index.js"));
const { normalizeContext, getCurrentTools } = await import(join(piRoot, "node_modules/@earendil-works/pi-ai/dist/utils/transcript.js"));
const { initTheme } = await import(join(piRoot, "dist/modes/interactive/theme/theme.js"));
const { visibleWidth, getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS, TuiAltScreen, TuiMainScreen, Container, Text } = await import(join(piRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"));
const { createChatViewport } = await import(join(piRoot, "dist/modes/interactive/chat-viewport.js"));
const { InteractiveMode } = await import(join(piRoot, "dist/modes/interactive/interactive-mode.js"));
initTheme("dark", false);
const model = { id: "fixture", provider: "openai-codex", api: "openai-codex-responses" };
const text = value => ({ type: "text", text: value });
const call = (name, id = name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const reply = (content, stopReason = "stop", extra = {}) => ({ role: "assistant", content, stopReason, ...model, model: model.id,
  timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra });
const fakeTool = (name, execute = async () => ({ content: [text(`${name} result`)] }), parameters = { type: "object", properties: {} }) => ({ name, label: name, description: `${name} fixture`, parameters, execute });
const base = extra => ({ messages: createSideMessages([]), question: "Explain this", cwd: "/tmp", tools: [], signal: new AbortController().signal, ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function eventually(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("Side did not reach the expected state");
}
async function directory(t) {
  const cwd = await mkdtemp(join(tmpdir(), "codex-side-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "example.txt"), "first line\nneedle in the file\nthird line\n");
  return cwd;
}
function assertPaired(messages) {
  const calls = messages.flatMap(message => message.role === "assistant" ? message.content.filter(part => part.type === "toolCall") : []);
  const results = messages.filter(message => message.role === "toolResult");
  assert.equal(results.length, calls.length);
  for (const call of calls) assert.equal(results.filter(result => result.toolCallId === call.id).length, 1, call.id);
}

test("Side inherits visible reference text and images, not system/tool definitions, signatures, or unfinished calls", () => {
  const original = [
    { role: "system", content: "ACTIVE_MAIN_INSTRUCTIONS", toolsAdded: [{ name: "write" }], sections: { extra: "MAIN_SECTIONS" }, timestamp: 1 },
    { role: "user", content: [text("main question"), { type: "image", data: "image-bytes", mimeType: "image/png" }], timestamp: 2 },
    reply([{ ...text("main answer"), textSignature: "OPAQUE_SIGNATURE" }, { type: "thinking", thinking: "HIDDEN_THINKING" }, call("bash", "dangling", { command: "SECRET_ARGUMENTS" })], "toolUse"),
    { role: "toolResult", toolCallId: "old-read", toolName: "read", content: [text("read output")], isError: false, timestamp: 3 },
  ];
  const before = structuredClone(original);
  const messages = createSideMessages(original);
  assert.ok(messages.every(message => message.role === "user"));
  assert.deepEqual(getCurrentTools(normalizeContext({ messages }).messages), []);
  const serialized = JSON.stringify(messages);
  for (const absent of ["ACTIVE_MAIN_INSTRUCTIONS", "MAIN_SECTIONS", "OPAQUE_SIGNATURE", "HIDDEN_THINKING", "SECRET_ARGUMENTS", '"toolCall"', "toolsAdded"]) assert.ok(!serialized.includes(absent), absent);
  for (const present of ["main question", "main answer", "read output", "image-bytes", "Side conversation boundary"]) assert.ok(serialized.includes(present), present);
  messages[0].content.find(part => part.type === "image").data = "changed";
  assert.deepEqual(original, before);
});

test("a tool-only reply runs read, returns its result, and continues to an answer instead of No text response", async t => {
  const cwd = await directory(t);
  const messages = createSideMessages([{ role: "user", content: "reference", timestamp: 1 }]);
  const original = structuredClone(messages); const requests = []; const status = [];
  const result = await runSideTurn(base({ cwd, messages, question: "Read the second line", tools: createReadOnlyTools(cwd), onStatus: value => status.push(value),
    complete: async (context, allowTools) => {
      requests.push(structuredClone(context)); assert.equal(allowTools, true);
      assert.deepEqual(getCurrentTools(normalizeContext(context).messages).map(tool => tool.name).sort(), ["find", "grep", "ls", "read"]);
      if (requests.length === 1) return reply([text("I will inspect the installed code."), call("read", "read-1", { path: "example.txt", offset: 2, limit: 1 })], "toolUse");
      assert.equal(context.messages.at(-1).role, "toolResult");
      assert.equal(context.messages.at(-1).toolCallId, "read-1");
      assert.match(context.messages.at(-1).content[0].text, /needle in the file/);
      return reply([text("The second line contains needle.")]);
    } }));
  assert.equal(requests.length, 2); assert.equal(result.text, "The second line contains needle.");
  assert.ok(status.includes("Reading a file…")); assert.deepEqual(messages, original); assertPaired(result.messages);
  assert.equal(await readFile(join(cwd, "example.txt"), "utf8"), "first line\nneedle in the file\nthird line\n");
  assert.deepEqual(await readdir(cwd), ["example.txt"]);
  const next = await runSideTurn(base({ cwd, messages: result.messages, question: "What about Go?", tools: createReadOnlyTools(cwd), complete: async context => {
    assertPaired(context.messages); assert.equal(context.messages.at(-1).content[0].text, "What about Go?");
    return reply([text("Yes, with different trade-offs.")]);
  } }));
  assert.equal(next.text, "Yes, with different trade-offs."); assertPaired(next.messages);
});

test("all four fixed read-only tools can complete a local lookup without changing the workspace", async t => {
  const cwd = await directory(t);
  // Never install/download a search binary as part of a test.
  const { getToolPath } = await import(join(piRoot, "dist/utils/tools-manager.js"));
  if (!getToolPath("rg") || !getToolPath("fd")) { t.skip("rg/fd not installed; do not download during tests"); return; }
  let round = 0;
  const result = await runSideTurn(base({ cwd, tools: createReadOnlyTools(cwd), complete: async context => {
    if (round++ === 0) return reply([
      call("read", "r", { path: "example.txt" }), call("grep", "g", { pattern: "needle", path: cwd, literal: true }),
      call("find", "f", { pattern: "*.txt", path: cwd }), call("ls", "l", { path: cwd }),
    ], "toolUse");
    const results = context.messages.filter(message => message.role === "toolResult");
    assert.equal(results.length, 4); assert.ok(results.every(result => !result.isError));
    for (const result of results) assert.match(result.content[0].text, /needle|example\.txt/);
    return reply([text("Read-only lookup finished.")]);
  } }));
  assert.equal(result.text, "Read-only lookup finished."); assertPaired(result.messages);
  assert.deepEqual(await readdir(cwd), ["example.txt"]);
  assert.equal(await readFile(join(cwd, "example.txt"), "utf8"), "first line\nneedle in the file\nthird line\n");
});

test("shell, mutation, custom tools, and foreign namespaces are denied even if the model requests them", async () => {
  let executed = 0; let round = 0;
  const deny = async () => { executed++; throw new Error("must not execute"); };
  const forbidden = ["bash", "edit", "write", "powershell", "codex_generate_image", "custom_tool"];
  const result = await runSideTurn(base({ tools: [fakeTool("read", deny), ...forbidden.map(name => fakeTool(name, deny))], complete: async context => {
    assert.deepEqual(context.tools.map(tool => tool.name), ["read"]);
    if (round++ === 0) return reply([...forbidden.map(name => call(name)), { ...call("read", "foreign"), namespace: "custom" }], "toolUse");
    const results = context.messages.filter(message => message.role === "toolResult");
    assert.equal(results.length, forbidden.length + 1); assert.ok(results.every(result => result.isError));
    assert.ok(results.every(result => /only supports read, grep, find, and ls/.test(result.content[0].text)));
    return reply([text("Side cannot change files or execute shell commands.")]);
  } }));
  assert.equal(executed, 0); assertPaired(result.messages);
});

test("invalid arguments and failed reads become tool results; sibling calls still finish", async () => {
  let executions = 0; let round = 0;
  const reader = fakeTool("read", async () => { executions++; throw new Error("File not found"); }, { type: "object", properties: { path: { type: "string" } }, required: ["path"] });
  const result = await runSideTurn(base({ tools: [reader, fakeTool("ls")], complete: async context => {
    if (round++ === 0) return reply([call("read", "invalid"), call("read", "missing", { path: "missing.txt" }), call("ls", "sibling")], "toolUse");
    const results = context.messages.filter(message => message.role === "toolResult");
    assert.deepEqual(results.map(result => result.isError), [true, true, false]);
    assert.match(results[0].content[0].text, /Validation failed/); assert.equal(results[1].content[0].text, "File not found");
    return reply([text("That file is missing, but the directory was listed.")]);
  } }));
  assert.equal(executions, 1); assertPaired(result.messages);
});

test("provider failures, incomplete calls, and empty answers do not execute tools or corrupt subsequent history", async () => {
  let executions = 0;
  const messages = createSideMessages([]); const before = structuredClone(messages);
  for (const response of [
    reply([call("read")], "error", { errorMessage: "Provider unavailable" }), reply([call("read")], "length"),
    reply([], "toolUse"), reply([], "aborted"), reply([], "deferred"), reply([], "stop"),
  ]) {
    await assert.rejects(runSideTurn(base({ messages, tools: [fakeTool("read", async () => { executions++; return { content: [] }; })], complete: async () => response })));
    assert.deepEqual(messages, before);
  }
  await assert.rejects(runSideTurn(base({ messages, complete: async () => { throw new Error("Connection failed"); } })), /Connection failed/);
  assert.equal(executions, 0); assert.deepEqual(messages, before);
  const length = await runSideTurn(base({ messages, complete: async () => reply([text("Partial answer")], "length") }));
  assert.match(length.text, /reply was cut off/);
  assert.equal((await runSideTurn(base({ messages, complete: async () => reply([text("Recovery")]) }))).text, "Recovery");
});

test("model and tool budgets stop loops, reserve an answer, and never execute excess tool requests", async () => {
  let modelCalls = 0; let toolCalls = 0;
  const tools = [fakeTool("read", async () => { toolCalls++; return { content: [text("result")] }; })];
  const result = await runSideTurn(base({ tools, complete: async (_context, allowTools) => {
    modelCalls++;
    if (!allowTools) return reply([text("Answer from the available results.")]);
    return reply([call("read", `loop-${modelCalls}`)], "toolUse");
  } }));
  assert.equal(modelCalls, SIDE_MAX_MODEL_CALLS); assert.equal(toolCalls, SIDE_MAX_MODEL_CALLS - 1); assertPaired(result.messages);
  modelCalls = 0; toolCalls = 0;
  await assert.rejects(runSideTurn(base({ tools, complete: async () => reply([call("read", `loop-${++modelCalls}`)], "toolUse") })), /lookup limit/);
  assert.equal(modelCalls, SIDE_MAX_MODEL_CALLS); assert.equal(toolCalls, SIDE_MAX_MODEL_CALLS - 1);
  toolCalls = 0;
  await assert.rejects(runSideTurn(base({ tools, complete: async () => reply(Array.from({ length: SIDE_MAX_TOOL_CALLS + 1 }, (_, i) => call("read", `batch-${i}`)), "toolUse") })), /lookup limit/);
  assert.equal(toolCalls, 0);
  await assert.rejects(runSideTurn(base({ tools, complete: async () => reply([call("read", "same"), call("read", "same")], "toolUse") })), /duplicate/);
  assert.equal(toolCalls, 0);
});

test("cancellation before or during a model/tool call prevents continuation and leaves history unchanged", async () => {
  const messages = createSideMessages([]); const original = structuredClone(messages);
  let models = 0; let tools = 0;
  const early = new AbortController(); early.abort();
  await assert.rejects(runSideTurn(base({ messages, signal: early.signal, complete: async () => { models++; } })), { name: "AbortError" });
  assert.equal(models, 0);
  for (const during of ["model", "tool"]) {
    const controller = new AbortController(); const gate = deferred(); const entered = deferred();
    const promise = runSideTurn(base({ messages, signal: controller.signal,
      tools: [fakeTool("read", async (_id, _args, signal) => { tools++; assert.equal(signal, controller.signal); entered.resolve(); return gate.promise; })],
      complete: async () => { models++; if (during === "model") { entered.resolve(); return gate.promise; } return reply([call("read")], "toolUse"); },
    }));
    await entered.promise; const before = models;
    controller.abort(); await assert.rejects(promise, { name: "AbortError" });
    gate.resolve(during === "model" ? reply([call("read")], "toolUse") : { content: [text("late result")] });
    await tick(); assert.equal(models, before); assert.deepEqual(messages, original);
  }
  assert.equal(tools, 1, "a late model response must never start its tool");
});

function uiFixture(t, cwd, respond, provider = "openai-codex", host) {
  const previousWorker = process.env.PI_CODEX_ISH_WORKER; process.env.PI_CODEX_ISH_WORKER = "1";
  const commands = new Map(); const handlers = new Map();
  try { extension.default({ registerTool() {}, registerCommand(name, command) { commands.set(name, command); }, on(name, handler) {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {};
  } }); } finally { if (previousWorker === undefined) delete process.env.PI_CODEX_ISH_WORKER; else process.env.PI_CODEX_ISH_WORKER = previousWorker; }
  const requests = []; const frames = []; let component; let finished = false;
  const entries = [{ type: "message", id: "main", parentId: null, timestamp: new Date().toISOString(), message: {
    role: "system", content: "Main instructions", toolsAdded: [{ name: "write", description: "not available in Side", parameters: {} }], timestamp: 1,
  } }];
  const ctx = { mode: "tui", cwd, model: { ...model, provider }, thinkingLevel: "low", getSystemPrompt: () => "Main instructions",
    sessionManager: { getEntries: () => entries, getBranch: () => entries, getLeafId: () => "main", getSessionId: () => "fixture" },
    executeTool: () => assert.fail("Side must not call the main tool runtime"),
    modelRegistry: {
      complete: async (selected, context, options) => {
        assert.equal(provider, "openai-codex"); assert.equal(options.reasoningEffort, "low"); assert.equal(options.serviceTier, "default");
        requests.push(structuredClone(context)); return respond(context, options, requests.length);
      },
      streamSimple: (selected, context, options) => {
        assert.notEqual(provider, "openai-codex"); assert.equal(options.reasoning, "low");
        requests.push(structuredClone(context)); return { result: () => respond(context, options, requests.length) };
      },
    },
    ui: { notify: message => assert.fail(message), setEditorComponent() {}, setFooter() {}, custom: async (factory, options) => {
      finished = false;
      if (host) return host.custom((tui, theme, keybindings, done) => {
        component = factory(tui, theme, keybindings, result => { finished = true; done(result); });
        return component;
      }, options);
      return new Promise(done => {
        component = factory({ mode: "fullscreen", terminal: { rows: 40 }, requestRender() { if (component) frames.push(component.render(90).join("\n")); } },
          { fg: (_color, value) => value, bold: value => value }, getKeybindings(), () => { finished = true; done(); });
      });
    } },
  };
  t.after(() => component?.handleInput("\x03"));
  return { ctx, requests, frames, entries, handlers, commands,
    open: question => commands.get("side").handler(question, ctx),
    get component() { return component; }, get finished() { return finished; },
    render: () => component.render(90).join("\n"),
  };
}

test("the actual Side UI answers after a tool-only response, supports follow-ups, and keeps main state unchanged", async t => {
  const cwd = await directory(t);
  const f = uiFixture(t, cwd, async (context, options, round) => {
    assert.equal(options.toolChoice, "auto");
    assert.ok(!context.systemPrompt.includes("Main instructions"));
    if (round === 1) return reply([call("read", "ui-read", { path: "example.txt" })], "toolUse");
    assertPaired(context.messages);
    return reply([text(round === 2 ? "Verified file contents." : "Go can do this differently.")]);
  });
  const original = structuredClone(f.entries);
  const pending = f.open("Inspect the file");
  await eventually(() => f.render().includes("Verified file contents."));
  assert.equal(f.requests.length, 2); assert.ok(f.frames.some(frame => frame.includes("Reading a file…")));
  assert.ok(f.render().includes("read-only")); assert.ok(!f.render().includes("No text response"));
  for (const width of [24, 40, 80]) assert.ok(f.component.render(width).every(line => visibleWidth(line) <= width));
  f.component.handleInput("Can Go do this?"); f.component.handleInput("\r");
  await eventually(() => f.render().includes("Go can do this differently."));
  assert.equal(f.requests.length, 3); assert.deepEqual(f.entries, original);
  f.component.handleInput("\x03"); await pending; assert.equal(f.finished, true);
});

test("failed Side turns can be followed by another question without replaying unfinished tools", async t => {
  const cwd = await directory(t);
  const f = uiFixture(t, cwd, async (context, _options, round) => {
    if (round === 1) return reply([call("read", "not-committed", { path: "example.txt" })], "toolUse");
    if (round === 2) throw new Error("Fixture provider disconnected");
    assert.equal(context.messages.filter(message => message.role === "toolResult").length, 0);
    assert.equal(context.messages.filter(message => message.role === "assistant").length, 0);
    return reply([text("The next question works.")]);
  });
  const pending = f.open("First question");
  await eventually(() => f.render().includes("Fixture provider disconnected"));
  f.component.handleInput("Next question"); f.component.handleInput("\r");
  await eventually(() => f.render().includes("The next question works."));
  assert.equal(f.requests.length, 3);
  f.component.handleInput("\x03"); await pending;
});

test("Side uses provider-neutral thinking options outside Codex and still supports the older streamSimple API", async t => {
  const f = uiFixture(t, "/tmp", async () => reply([text("Provider-neutral answer")]), "other-provider");
  const pending = f.open("Hello");
  await eventually(() => f.render().includes("Provider-neutral answer"));
  f.component.handleInput("\x03"); await pending;
});

test("Ctrl+C, Esc, branch changes, and shutdown close Side and prevent late results from updating or continuing it", async t => {
  for (const action of ["ctrl-c", "escape", "session_tree", "session_shutdown"]) {
    const gate = deferred(); let signal;
    const f = uiFixture(t, "/tmp", async (_context, options) => { signal = options.signal; return gate.promise; });
    const pending = f.open("Waiting"); await eventually(() => f.requests.length === 1);
    const frameCount = f.frames.length;
    if (action === "ctrl-c") f.component.handleInput("\x03");
    else if (action === "escape") f.component.handleInput("\x1b");
    else for (const handler of f.handlers.get(action) ?? []) await handler({}, f.ctx);
    await pending; assert.equal(f.finished, true); assert.equal(signal.aborted, true);
    gate.resolve(reply([call("read", "late", { path: "/never-read" })], "toolUse"));
    await tick(); assert.equal(f.requests.length, 1); assert.equal(f.frames.length, frameCount);
  }
});

// Use Pi's real custom-UI mounting and renderer input path, not component.handleInput alone.
// All terminal I/O stays in memory; models are still fake.
function terminalHost(t, mode = "fullscreen", keybindings = getKeybindings()) {
  let input; let resize; let overlay;
  const terminal = {
    rows: 40, columns: 90, kittyProtocolActive: false, writes: [],
    start(onInput, onResize) { input = onInput; resize = onResize; }, stop() {},
    write(data) { this.writes.push(data); }, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  };
  const tui = mode === "fullscreen" ? new TuiAltScreen(terminal, false, undefined, { wheelScrollLines: 1 }) : new TuiMainScreen(terminal);
  let draft = "MAIN DRAFT";
  const editor = { focused: false, getText: () => draft, setText: value => { draft = value; },
    handleInput: value => { draft += value; }, render: () => ["Main input", draft, ""], invalidate() {} };
  const editorContainer = new Container(); editorContainer.addChild(editor);
  const document = new Container(); document.addChild(new Text(Array.from({ length: 150 }, (_, i) => `Main response ${i}`).join("\n"), 0, 0));
  const viewport = createChatViewport({ document, editor: editorContainer, pendingMessages: new Container(),
    status: new Container(), footer: new Text("Main footer", 0, 0), scrollbar: "hidden" });
  if (mode === "fullscreen") tui.setLayoutRoot(viewport.root);
  else { tui.addChild(document); tui.addChild(editorContainer); }
  tui.setFocus(editor); tui.start(); tui.renderNow();
  if (mode === "fullscreen") { viewport.transcript.scrollTo(30); tui.renderNow(); }
  t.after(() => tui.stop());
  const state = { editor, editorContainer, ui: tui, keybindings, disposeActiveSelector() {} };
  return {
    tui, terminal, editor, document, viewport,
    get overlay() { return overlay; },
    custom(factory, options) {
      return InteractiveMode.prototype.showExtensionCustom.call(state, factory, { ...options,
        onHandle(handle) { overlay = handle; options?.onHandle?.(handle); } });
    },
    send(data) { input(data); tui.renderNow(); },
    resize(columns, rows) { terminal.columns = columns; terminal.rows = rows; resize(); tui.renderNow(); },
  };
}
const longSideAnswer = Array.from({ length: 100 }, (_, i) => `Side line ${i}: 中文 🐈`).join("\n\n");
function sidePosition(f, width = 90) {
  const match = f.component.render(width).join("\n").match(/(\d+)–(\d+)\/(\d+)/);
  assert.ok(match, "Long Side transcript must show its reading position");
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

test("fullscreen wheel and page keys scroll only Side, including both boundaries; closing restores main input and scrolling", async t => {
  const host = terminalHost(t);
  const f = uiFixture(t, "/tmp", async () => reply([text(longSideAnswer)]), "openai-codex", host);
  const mainTop = host.viewport.transcript.scrollTop;
  const pending = f.open("Long answer");
  await eventually(() => f.render().includes("Side line 99")); host.tui.renderNow();
  assert.equal(host.tui.hasOverlay(), true);
  assert.equal(f.component.focused, true); assert.equal(host.editor.focused, false);
  assert.deepEqual(host.overlay.getBounds(), { row: 0, col: 0, width: 90, height: 40 });
  const initial = sidePosition(f);
  for (const [event, lines] of [
    ["\x1b[<64;20;10M", -1], // Wheel/trackpad up.
    ["\x1b[<65;20;10M", 1],
    ["\x1b[<72;20;10M", -5], // Alt+wheel retains Pi's multiplier.
    ["\x1b[M" + String.fromCharCode(96, 53, 43), -1], // Legacy X10 wheel.
  ]) {
    const before = sidePosition(f).start; host.send(event);
    assert.equal(sidePosition(f).start, before + lines); assert.equal(host.viewport.transcript.scrollTop, mainTop);
  }
  let before = sidePosition(f); host.send("\x1b[5~");
  assert.equal(sidePosition(f).start, before.start - (before.end - before.start + 1));
  before = sidePosition(f); host.send("\x1b[6~");
  assert.equal(sidePosition(f).start, before.start + (before.end - before.start + 1));
  for (let i = 0; i < 10; i++) host.send("\x1b[5~");
  assert.equal(sidePosition(f).start, 1);
  host.send("\x1b[<64;1;1M"); host.send("\x1b[5~");
  assert.equal(sidePosition(f).start, 1); assert.equal(host.viewport.transcript.scrollTop, mainTop);
  for (let i = 0; i < 10; i++) host.send("\x1b[6~");
  assert.equal(sidePosition(f).end, initial.total);
  host.send("\x1b[<65;90;40M"); host.send("\x1b[6~");
  assert.equal(sidePosition(f).end, initial.total); assert.equal(host.viewport.transcript.scrollTop, mainTop);
  assert.equal(host.editor.getText(), "MAIN DRAFT");
  host.send("\x03"); await pending;
  assert.equal(host.tui.hasOverlay(), false); assert.equal(host.editor.focused, true);
  assert.equal(f.component.focused, false); assert.equal(host.viewport.transcript.scrollTop, mainTop);
  host.send("\x1b[<64;20;10M"); assert.equal(host.viewport.transcript.scrollTop, mainTop - 1);
  host.send("\x1b[5~"); assert.ok(host.viewport.transcript.scrollTop < mainTop - 1);
  host.send("!"); assert.equal(host.editor.getText(), "MAIN DRAFT!");
});

test("empty and short Side overlays cover main after resize; regular mode retains a keyboard path", async t => {
  for (const mode of ["fullscreen", "regular"]) {
    const host = terminalHost(t, mode);
    const f = uiFixture(t, "/tmp", async () => reply([text("A short answer.")]), "openai-codex", host);
    const pending = f.open(""); await eventually(() => host.overlay?.isFocused()); host.tui.renderNow();
    assert.equal(f.requests.length, 0);
    assert.equal(f.render().includes("Wheel /"), mode === "fullscreen");
    for (const [width, height] of [[90, 40], [24, 12], [40, 4], [80, 32]]) {
      host.resize(width, height);
      const lines = f.component.render(width);
      assert.equal(lines.length, height); assert.ok(lines.every(line => visibleWidth(line) <= width));
      assert.deepEqual(host.overlay.getBounds(), { row: 0, col: 0, width, height });
      assert.equal(f.component.focused, true);
    }
    // Mouse sequences received before a layout is ready must not become draft text.
    f.component.handleInput("\x1b[<64;2;2M"); f.component.handleInput("\x1b[M" + String.fromCharCode(96, 35, 35));
    host.send("Hello"); host.send("\r");
    await eventually(() => f.render().includes("A short answer.")); host.tui.renderNow();
    assert.equal(f.requests[0].messages.at(-1).content[0].text, "Hello");
    assert.deepEqual(host.overlay.getBounds(), { row: 0, col: 0, width: 80, height: 32 });
    host.send("\x1b"); await pending;
    assert.equal(host.tui.hasOverlay(), false); assert.equal(host.editor.focused, true);
    assert.equal(host.editor.getText(), "MAIN DRAFT");
  }
});

test("Side respects remapped page/line keys and keeps a typed question intact while scrolling", async t => {
  const previous = getKeybindings();
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.altScreen.pageUp": "alt+u", "tui.altScreen.pageDown": "alt+d",
    "tui.altScreen.halfPageUp": "alt+h", "tui.altScreen.lineDown": "alt+j" });
  setKeybindings(keybindings); t.after(() => setKeybindings(previous));
  const host = terminalHost(t, "fullscreen", keybindings);
  const f = uiFixture(t, "/tmp", async () => reply([text(longSideAnswer)]), "openai-codex", host);
  const pending = f.open("Long answer"); await eventually(() => f.render().includes("Side line 99")); host.tui.renderNow();
  host.send("My question");
  let before = sidePosition(f); host.send("\x1bu");
  assert.equal(sidePosition(f).start, before.start - (before.end - before.start + 1));
  before = sidePosition(f); host.send("\x1bd"); assert.ok(sidePosition(f).start > before.start);
  before = sidePosition(f); host.send("\x1bh");
  assert.equal(sidePosition(f).start, before.start - Math.floor((before.end - before.start + 1) / 2));
  before = sidePosition(f); host.send("\x1bj"); assert.equal(sidePosition(f).start, before.start + 1);
  host.send("\x1b[<64;20;10M");
  host.send("\r"); await eventually(() => f.requests.length === 2);
  assert.equal(f.requests[1].messages.at(-1).content[0].text, "My question");
  assert.equal(host.viewport.transcript.scrollTop, 30);
  host.send("\x1b"); await pending;
});

test("Side holds the reading position across a pending answer and resize without moving main", async t => {
  const host = terminalHost(t); const gate = deferred();
  const f = uiFixture(t, "/tmp", async (_context, _options, round) => round === 1 ? reply([text(longSideAnswer)]) : gate.promise, "openai-codex", host);
  const pending = f.open("Long answer"); await eventually(() => f.render().includes("Side line 99")); host.tui.renderNow();
  host.send("Another answer"); host.send("\r"); await eventually(() => f.requests.length === 2);
  host.send("\x1b[5~"); const position = sidePosition(f).start;
  assert.ok(position > 1);
  gate.resolve(reply([text(longSideAnswer)])); await eventually(() => !f.render().includes("Thinking…")); host.tui.renderNow();
  assert.equal(sidePosition(f).start, position);
  host.resize(90, 24); assert.equal(sidePosition(f).start, position);
  host.document.addChild(new Text("Main keeps running independently", 0, 0)); host.tui.renderNow();
  assert.equal(sidePosition(f).start, position); assert.equal(host.viewport.transcript.scrollTop, 30);
  for (const handler of f.handlers.get("session_tree") ?? []) await handler({}, f.ctx);
  await pending; host.tui.renderNow(); assert.equal(host.tui.hasOverlay(), false);
  assert.equal(host.editor.focused, true); assert.equal(host.viewport.transcript.scrollTop, 30);
});
