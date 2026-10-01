import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fixture, client, eventually } from "./remote-helpers.mjs";

async function searchFixture(t) {
  const f = await fixture(t);
  for (const directory of ["src/remote", "docs", "node_modules/dependency", ".git"]) await mkdir(join(f.config.userHome, directory), { recursive: true });
  for (const path of ["README.md", "src/remote/server.ts", "docs/使用說明.md", "node_modules/dependency/README.md", ".git/README.md", ".env", "auth.json"]) {
    await writeFile(join(f.config.userHome, path), "not searched: private body");
  }
  const outside = join(f.root, "outside"); await mkdir(outside); await writeFile(join(outside, "README.md"), "outside");
  await symlink(outside, join(f.config.userHome, "escape"));
  await symlink(join(f.config.userHome, "auth.json"), join(f.config.userHome, "secret-README.md"));
  await symlink(f.config.userHome, join(f.config.userHome, "cycle"));
  return f;
}

test("filename search returns files and folders without protected files, ignored trees, or link escapes", async t => {
  const { app, config } = await searchFixture(t); const c = await client(app, "app");
  const roots = [config.userHome];
  const readme = await c.send("fuzzyFileSearch", { query: "readme", roots });
  assert.deepEqual(readme.result.files.map(f => f.path), ["README.md"]);
  assert.equal(readme.result.files[0].file_name, "README.md"); assert.equal(readme.result.files[0].match_type, "file");
  assert.equal((await c.send("fuzzyFileSearch", { query: "remote", roots })).result.files[0].match_type, "directory");
  assert.equal((await c.send("fuzzyFileSearch", { query: "svrts", roots })).result.files[0].path, "src/remote/server.ts");
  assert.equal((await c.send("fuzzyFileSearch", { query: "使用", roots })).result.files[0].file_name, "使用說明.md");
  assert.deepEqual((await c.send("fuzzyFileSearch", { query: "auth", roots })).result.files, []);
  assert.deepEqual((await c.send("fuzzyFileSearch", { query: "private body", roots })).result.files, []);
  assert.deepEqual((await c.send("fuzzyFileSearch", { query: "", roots })).result.files, []);
  for (const params of [{ query: "x", roots: [config.agentDir] }, { query: "x", roots: ["relative"] },
    { query: "x", roots: [] }, { query: "x".repeat(257), roots }, { query: {}, roots }]) {
    assert.ok((await c.send("fuzzyFileSearch", params)).error, JSON.stringify(params));
  }
});

test("search sessions stream to their owner only and stop or supersede stale queries", async t => {
  const { app, config } = await searchFixture(t); const a = await client(app, "phone"); const b = await client(app, "desktop");
  const params = { sessionId: "same-id", roots: [config.userHome] };
  await a.send("fuzzyFileSearch/sessionStart", params); await b.send("fuzzyFileSearch/sessionStart", params);
  await a.send("fuzzyFileSearch/sessionUpdate", { sessionId: "same-id", query: "README" });
  await b.send("fuzzyFileSearch/sessionUpdate", { sessionId: "same-id", query: "使用" });
  await eventually(() => a.events("fuzzyFileSearch/sessionCompleted").length && b.events("fuzzyFileSearch/sessionCompleted").length);
  assert.equal(a.events("fuzzyFileSearch/sessionUpdated")[0].params.files[0].path, "README.md");
  assert.equal(b.events("fuzzyFileSearch/sessionUpdated")[0].params.files[0].path, "docs/使用說明.md");
  const before = a.events("fuzzyFileSearch/sessionUpdated").length;
  await a.send("fuzzyFileSearch/sessionUpdate", { sessionId: "same-id", query: "README" });
  await a.send("fuzzyFileSearch/sessionUpdate", { sessionId: "same-id", query: "server" });
  await eventually(() => a.events("fuzzyFileSearch/sessionUpdated").length > before);
  assert.deepEqual(a.events("fuzzyFileSearch/sessionUpdated").slice(before).map(e => e.params.query), ["server"]);
  await a.send("fuzzyFileSearch/sessionUpdate", { sessionId: "same-id", query: "README" });
  await a.send("fuzzyFileSearch/sessionStop", { sessionId: "same-id" });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(a.events("fuzzyFileSearch/sessionUpdated").length, before + 1);
  assert.equal((await a.send("fuzzyFileSearch/sessionUpdate", { sessionId: "same-id", query: "README" })).error.code, -32602);
  assert.deepEqual((await a.send("fuzzyFileSearch/sessionStop", { sessionId: "same-id" })).result, {});
  await b.send("fuzzyFileSearch/sessionUpdate", { sessionId: "same-id", query: "server" });
  b.close();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(b.events("fuzzyFileSearch/sessionUpdated").length, 1, "disconnect cancels pending results");
});

test("legacy cancellation tokens and concurrent session limits are isolated per client", async t => {
  const { app, files, config } = await fixture(t); const a = await client(app, "a"); const b = await client(app, "b");
  const roots = [config.userHome];
  let calls = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  files.walk = async function* (_root, signal) {
    calls++;
    await gate;
    if (!signal.aborted) yield { path: "notes.txt", fileName: "notes.txt", isDirectory: false };
  };
  const old = a.send("fuzzyFileSearch", { roots, query: "notes", cancellationToken: "shared-token" });
  const independent = b.send("fuzzyFileSearch", { roots, query: "notes", cancellationToken: "shared-token" });
  await eventually(() => calls === 2);
  const replacement = a.send("fuzzyFileSearch", { roots, query: "notes", cancellationToken: "shared-token" });
  await eventually(() => calls === 3); release();
  assert.deepEqual((await old).result.files, []);
  assert.equal((await independent).result.files.length, 1); assert.equal((await replacement).result.files.length, 1);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => a.send("fuzzyFileSearch/sessionStart", { sessionId: `s${i}`, roots })));
  assert.equal(results.filter(r => r.result).length, 8);
  assert.ok(results.filter(r => r.error).every(r => r.error.code === -32600));
});

test("search session counts and result sizes are bounded; notification preferences are respected", async t => {
  const { app, config } = await fixture(t); const c = await client(app, "app");
  const roots = [config.userHome];
  for (let i = 0; i < 130; i++) await writeFile(join(config.userHome, `file-${i}.txt`), "x");
  assert.equal((await c.send("fuzzyFileSearch", { query: "file", roots })).result.files.length, 100);
  for (let i = 0; i < 8; i++) assert.ok((await c.send("fuzzyFileSearch/sessionStart", { sessionId: String(i), roots })).result);
  assert.equal((await c.send("fuzzyFileSearch/sessionStart", { sessionId: "extra", roots })).error.code, -32600);
  assert.ok((await c.send("fuzzyFileSearch/sessionStart", { sessionId: "0", roots })).result, "replacing a session does not consume another slot");
  c.connection.optOut.add("fuzzyFileSearch/sessionUpdated");
  await c.send("fuzzyFileSearch/sessionUpdate", { sessionId: "0", query: "file" });
  await eventually(() => c.events("fuzzyFileSearch/sessionCompleted").length);
  assert.equal(c.events("fuzzyFileSearch/sessionUpdated").length, 0);
});
