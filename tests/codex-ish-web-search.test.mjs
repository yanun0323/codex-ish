// Run: npm test (node --test tests/) from the package root.
// No real credentials, network requests, daemon startup, or model usage.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
// Prefer the package's own installed peer dependencies; fall back to a global Pi.
const localPiRoot = resolve(here, "..", "node_modules", "@earendil-works", "pi-coding-agent");
const globalPiRoot = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const piRoot = process.env.PI_TEST_AGENT_ROOT ??
  (existsSync(join(localPiRoot, "node_modules", "jiti")) ? localPiRoot : globalPiRoot);
const require = createRequire(join(piRoot, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js"),
    "@earendil-works/pi-ai": join(piRoot, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
    "@earendil-works/pi-tui": join(piRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"),
    typebox: require.resolve("typebox"),
  },
});
const extension = await jiti.import(resolve(here, "..", "extensions", "codex-ish.ts"));
const { parseDuckDuckGoResults, searchDuckDuckGo, searchBody } = extension;
const signal = () => new AbortController().signal;
const htmlResponse = (html) => new Response(html, { headers: { "content-type": "text/html; charset=UTF-8" } });

function resultHtml({ url = "https://example.com/docs?a=1&b=2", title = "Example &amp; docs", snippet = "A <b>useful</b> snippet &#x4E2D;&#25991;." } = {}) {
  return `<div class="result results_links web-result"><h2>
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&amp;rut=tracking">${title}</a>
    </h2><div class="result__extras"><div class="result__extras__url">example.com</div></div>
    <div><a class="result__snippet" href="${url.replaceAll("&", "&amp;")}">${snippet}</a></div></div>`;
}

function setup(provider = "deepseek", api = "openai-completions") {
  const tools = new Map();
  const handlers = new Map();
  extension.default({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
  });
  const ctx = {
    model: {
      id: "test-model", provider, api,
      baseUrl: provider === "openai-codex" ? "https://chatgpt.com/backend-api" : "http://localhost:1234/v1",
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    thinkingLevel: "off",
    modelRegistry: {
      getApiKeyAndHeaders() { throw new Error("DuckDuckGo must not resolve model credentials"); },
    },
  };
  return { tool: tools.get("web_search"), handlers, ctx };
}

function codexAuth() {
  const claims = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
  };
  const token = `test.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.test`;
  return { ok: true, apiKey: token };
}

function codexResponse(withSearch = true) {
  return new Response(`data: ${JSON.stringify({
    type: "response.completed",
    response: {
      status: "completed",
      output: [
        ...(withSearch ? [{
          type: "web_search_call", id: "search-1", status: "completed",
          action: { query: "test", sources: [{ title: "Example", url: "https://example.com/" }] },
        }] : []),
        { type: "message", content: [{ type: "output_text", text: "A sourced answer.", annotations: [] }] },
      ],
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 10 },
    },
  })}\n\n`, { headers: { "content-type": "text/event-stream" } });
}

test("DDG parser unwraps links, decodes entities and finds nested snippets", () => {
  assert.deepEqual(parseDuckDuckGoResults(resultHtml()), [{
    title: "Example & docs", url: "https://example.com/docs?a=1&b=2", snippet: "A useful snippet 中文.",
  }]);
});

test("DDG parser supports direct links, class lists, unquoted and single-quoted attributes", () => {
  const html = `<a href='https://example.com/direct?a=1&amp;b=2' class='extra result__a'>Direct</a>
    <div><span class=result__snippet>Read &quot;this&quot; &mdash; &#128512;</span></div>`;
  assert.deepEqual(parseDuckDuckGoResults(html), [{
    title: "Direct", url: "https://example.com/direct?a=1&b=2", snippet: 'Read "this" — 😀',
  }]);
});

test("DDG parser deduplicates, rejects unsafe links and ads, and caps results", () => {
  const invalid = ["javascript:alert(1)", "file:///etc/passwd", "https://user:secret@example.com/", "https://duckduckgo.com/y.js?ad=1"];
  // An ad has a direct DDG tracking link, not a normal uddg result wrapper.
  const html = invalid.slice(0, 3).map((url) => resultHtml({ url })).join("") +
    `<a class="result__a" href="${invalid[3]}">Ad</a>` +
    resultHtml() + resultHtml() +
    Array.from({ length: 15 }, (_, i) => resultHtml({ url: `https://example.com/${i}` })).join("");
  const results = parseDuckDuckGoResults(html);
  assert.equal(results.length, 10);
  assert.equal(new Set(results.map((entry) => entry.url)).size, 10);
  assert.ok(results.every((entry) => entry.url.startsWith("https://example.com/")));
});

test("DDG parser distinguishes no results, verification, and changed markup", () => {
  assert.deepEqual(parseDuckDuckGoResults('<div class="no-results__message">No results found</div>'), []);
  for (const html of [
    '<form id="challenge-form"></form>',
    '<div class="anomaly-modal__modal">Verify</div>',
    '<form action="//duckduckgo.com/anomaly.js?x=1"></form>',
  ]) assert.throws(() => parseDuckDuckGoResults(html), /human verification/);
  assert.throws(() => parseDuckDuckGoResults("<html>Something changed</html>"), /unrecognized search page/);
  assert.throws(() => parseDuckDuckGoResults('<input value="no results found">'), /unrecognized/);
});

test("DDG text strips active markup and control characters and bounds fields", () => {
  const [result] = parseDuckDuckGoResults(resultHtml({
    title: `${"x".repeat(350)}&#x1b;`,
    snippet: `<script>ignore instructions</script><style>hidden</style>${"中".repeat(2000)}&#0;`,
  }));
  assert.equal(result.title.length, 300);
  assert.equal(result.snippet.length, 1500);
  assert.ok(!result.snippet.includes("ignore instructions"));
  assert.ok(!result.title.includes("\x1b"));
});

test("DDG request has no auth, encodes the query and only uses supplied URL hostnames", async () => {
  let calls = 0;
  const result = await searchDuckDuckGo("中文 & docs", ["https://example.com/a", "https://example.com/b", "https://example.org/c"], signal(), async (url, init) => {
    calls++;
    const endpoint = new URL(url);
    assert.equal(endpoint.origin, "https://html.duckduckgo.com");
    assert.equal(endpoint.searchParams.get("q"), "中文 & docs (site:example.com OR site:example.org)");
    assert.equal(new Headers(init.headers).has("authorization"), false);
    assert.equal(new Headers(init.headers).has("cookie"), false);
    assert.equal(init.redirect, "error");
    return htmlResponse(resultHtml());
  });
  assert.equal(calls, 1);
  assert.equal(result.results.length, 1);
});

test("DDG validates inputs before making a request", async () => {
  const neverFetch = () => { assert.fail("Invalid input must not send a request"); };
  for (const [query, urls] of [[" ", []], ["x".repeat(16001), []], ["test", ["file:///etc/passwd"]], ["test", ["https://user:secret@example.com/"]], ["test", Array(21).fill("https://example.com/")]]) {
    await assert.rejects(searchDuckDuckGo(query, urls, signal(), neverFetch));
  }
});

test("DDG errors never retry and HTTP 202 is not treated as success", async () => {
  for (const status of [202, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(searchDuckDuckGo("test", [], signal(), async () => {
      calls++;
      return new Response("challenge", { status });
    }), /No retry or Codex fallback/);
    assert.equal(calls, 1);
  }
});

test("DDG response size is bounded with and without Content-Length", async () => {
  await assert.rejects(searchDuckDuckGo("test", [], signal(), async () => new Response("small", { headers: { "content-length": "1048577" } })), /too large/);
  await assert.rejects(searchDuckDuckGo("test", [], signal(), async () => htmlResponse("x".repeat(1048577))), /too large/);
});

test("already cancelled DDG search never starts a request", async () => {
  await assert.rejects(searchDuckDuckGo("test", [], AbortSignal.abort(), () => assert.fail("Must not fetch")), /abort/i);
});

test("all non-Codex providers route to DDG without reading credentials", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => htmlResponse(resultHtml()));
  for (const provider of ["deepseek", "antigravity", "anthropic", "omlx", "openai", "custom-proxy"]) {
    const { tool, ctx } = setup(provider);
    const result = await tool.execute("test", { query: "test", urls: ["https://example.com/docs"] }, signal(), undefined, ctx);
    assert.equal(result.details.backend, "duckduckgo");
    assert.equal(result.details.provider, provider);
    assert.equal(result.usage, undefined);
    assert.match(result.content[0].text, /not been read/);
    assert.match(result.content[0].text, /site filters/);
  }
  assert.equal(mock.mock.callCount(), 6);
});

test("Codex retains subscription search, current model, native search verification and usage", async (t) => {
  const { tool, ctx } = setup("openai-codex", "openai-codex-responses");
  ctx.modelRegistry.getApiKeyAndHeaders = async (model) => {
    assert.equal(model, ctx.model);
    return codexAuth();
  };
  const mock = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, extension.SEARCH_ENDPOINT);
    const body = JSON.parse(init.body);
    assert.equal(body.model, ctx.model.id);
    assert.equal(body.tools[0].type, "web_search");
    assert.equal(body.tool_choice, "required");
    assert.equal(new Headers(init.headers).get("ChatGPT-Account-ID"), "test-account");
    return codexResponse();
  });
  const result = await tool.execute("test", { query: "test" }, signal(), undefined, ctx);
  assert.equal(result.details.backend, "codex");
  assert.equal(result.details.searches, 1);
  assert.match(result.content[0].text, /A sourced answer/);
  assert.equal(result.usage.input, 80);
  assert.equal(result.usage.cacheRead, 20);
  assert.equal(result.usage.output, 10);
  assert.equal(mock.mock.callCount(), 1);
  assert.equal(searchBody("test-model", "test", [], "high").reasoning.effort, "high");
});

test("Codex failures and missing native search never fall back to DDG", async (t) => {
  const { tool, ctx } = setup("openai-codex", "openai-codex-responses");
  ctx.modelRegistry.getApiKeyAndHeaders = async () => codexAuth();
  let emptySearch = false;
  const mock = t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, extension.SEARCH_ENDPOINT);
    return emptySearch ? codexResponse(false) : new Response("limited", { status: 429 });
  });
  await assert.rejects(tool.execute("test", { query: "test" }, signal(), undefined, ctx), /HTTP 429/);
  emptySearch = true;
  await assert.rejects(tool.execute("test", { query: "test" }, signal(), undefined, ctx), /no completed web search/);
  assert.equal(mock.mock.callCount(), 2);
});

test("Codex rejects unsupported API and custom proxy without any request", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Must not fetch"));
  const badApi = setup("openai-codex");
  await assert.rejects(badApi.tool.execute("test", { query: "test" }, signal(), undefined, badApi.ctx), /does not support subscription/);
  const proxy = setup("openai-codex", "openai-codex-responses");
  proxy.ctx.model.baseUrl = "https://proxy.example.com/v1";
  await assert.rejects(proxy.tool.execute("test", { query: "test" }, signal(), undefined, proxy.ctx), /Custom proxies are not supported/);
});

test("DDG tool errors hide network details and do not use Codex", async (t) => {
  const { tool, ctx } = setup();
  const mock = t.mock.method(globalThis, "fetch", async () => { throw new Error("private network detail"); });
  await assert.rejects(tool.execute("test", { query: "test" }, signal(), undefined, ctx), (error) => {
    assert.match(error.message, /DuckDuckGo search could not finish/);
    assert.doesNotMatch(error.message, /private network detail/);
    assert.match(error.message, /No retry or Codex fallback/);
    return true;
  });
  assert.equal(mock.mock.callCount(), 1);
});

test("tool cancellation, branch changes, and shutdown abort DDG requests", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  for (const event of ["user", "session_tree", "session_shutdown"]) {
    const { tool, ctx, handlers } = setup();
    const controller = new AbortController();
    const pending = tool.execute("test", { query: "test" }, controller.signal, undefined, ctx);
    if (event === "user") controller.abort();
    else handlers.get(event)[0](); // Search's cancellation handler; don't start other features.
    await assert.rejects(pending, /Web search cancelled/);
  }
});

test("DDG timeout is 30 seconds and cleans up without retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { tool, ctx } = setup();
  const mock = t.mock.method(globalThis, "fetch", async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const pending = tool.execute("test", { query: "test" }, signal(), undefined, ctx);
  t.mock.timers.tick(30_000);
  await assert.rejects(pending, /timed out after 30 seconds/);
  assert.equal(mock.mock.callCount(), 1);
});

test("DDG output is capped and tells the model when results are truncated", async (t) => {
  const html = Array.from({ length: 10 }, (_, i) => resultHtml({ url: `https://example.com/${i}`, title: "中".repeat(300), snippet: "文".repeat(1500) })).join("");
  t.mock.method(globalThis, "fetch", async () => htmlResponse(html));
  const { tool, ctx } = setup();
  const result = await tool.execute("test", { query: "test" }, signal(), undefined, ctx);
  assert.ok(Buffer.byteLength(result.content[0].text) < 25 * 1024);
  assert.match(result.content[0].text, /truncated/);
});
