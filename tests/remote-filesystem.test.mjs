import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile, readFile, symlink, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixture, client } from "./remote-helpers.mjs";
import { piInput } from "../dist/remote/runtime.js";

test("both apps can browse the home directory, make a project folder, and start a shared conversation there", async t => {
  const { app, config, files, mock } = await fixture(t);
  await mkdir(join(config.userHome, "Projects"));
  await writeFile(join(config.userHome, "notes.txt"), "notes");
  const phone = await client(app, "phone"); const mac = await client(app, "mac");
  const listing = await phone.send("fs/readDirectory", { path: config.userHome });
  assert.ok(listing.result, JSON.stringify(listing));
  assert.deepEqual(listing.result.entries, [
    { fileName: "Projects", isDirectory: true, isFile: false },
    { fileName: "notes.txt", isDirectory: false, isFile: true },
  ]);
  const folder = join(config.userHome, "Projects", "new project 中文");
  assert.deepEqual((await phone.send("fs/createDirectory", { path: folder })).result, {});
  const create = { name: "New project", roots: [{ path: folder }], idempotencyKey: "new-project", metadata: { source: "phone" } };
  const created = await phone.send("project/create", create);
  assert.ok(created.result, JSON.stringify(created));
  const project = created.result.project;
  assert.equal(project.roots[0].path, await realpath(folder));
  assert.equal((await mac.send("project/list")).result.data[0].id, project.id);
  const thread = await mac.send("thread/start", { projectId: project.id });
  assert.equal(thread.result.thread.cwd, await realpath(folder));
  assert.equal(thread.result.thread.projectId, project.id);
  assert.equal(mock.backends.length, 1);
  assert.equal((await phone.send("thread/resume", { threadId: thread.result.thread.id })).result.thread.id, thread.result.thread.id);
  assert.equal((await files.metadata(folder)).isDirectory, true);
});

test("project creation is idempotent under concurrent clients and rejects conflicting keys", async t => {
  const { app, config, state } = await fixture(t);
  const phone = await client(app, "phone"); const mac = await client(app, "mac");
  const params = { name: "Existing", roots: [{ path: config.userHome }], idempotencyKey: "same-key" };
  const [a, b] = await Promise.all([phone.send("project/create", params), mac.send("project/create", params)]);
  assert.equal(a.result.project.id, b.result.project.id);
  assert.equal(state.list("projects").length, 1);
  assert.equal((await mac.send("project/create", { ...params, name: "different" })).error.code, -32602);
  const renamed = await mac.send("project/update", { projectId: a.result.project.id, name: "Renamed" });
  assert.equal(renamed.result.project.name, "Renamed");
  assert.equal((await phone.send("project/read", { projectId: a.result.project.id })).result.project.name, "Renamed");
  await phone.send("project/delete", { projectId: a.result.project.id });
  assert.equal((await mac.send("project/list")).result.data.length, 0);
  assert.ok((await stat(config.userHome)).isDirectory(), "deleting a project never deletes its directories");
});

test("directory browser blocks credentials, symlink escapes, and traversal but allows ordinary home files", async t => {
  const { files, root, config, app } = await fixture(t);
  const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "private.txt"), "outside-secret");
  await mkdir(join(config.userHome, ".ssh")); await writeFile(join(config.userHome, ".ssh", "id_ed25519"), "ssh-secret");
  await writeFile(join(config.agentDir, "auth.json"), "oauth-secret");
  await writeFile(join(config.userHome, ".env"), "env-secret");
  await writeFile(join(config.userHome, "safe.txt"), "safe");
  await symlink(outside, join(config.userHome, "escape"));
  await symlink(join(config.agentDir, "auth.json"), join(config.userHome, "innocent.txt"));
  const c = await client(app, "phone");
  for (const path of [outside, join(config.userHome, "..", "outside"), join(config.userHome, "escape", "private.txt"),
    join(config.agentDir, "auth.json"), join(config.userHome, ".env"), join(config.userHome, ".ssh", "id_ed25519"), join(config.userHome, "innocent.txt")]) {
    const result = await c.send("fs/readFile", { path });
    assert.ok(result.error, path);
    assert.doesNotMatch(JSON.stringify(result), /oauth-secret|ssh-secret|outside-secret|env-secret/);
  }
  const names = (await files.list(config.userHome)).entries.map(entry => entry.fileName);
  assert.deepEqual(names, ["safe.txt"]);
  assert.equal((await c.send("fs/readFile", { path: pathToFileURL(join(config.userHome, "safe.txt")).href })).result.dataBase64, Buffer.from("safe").toString("base64"));
  await assert.rejects(files.existing("relative.txt"), /absolute path/);
  await assert.rejects(files.existing("file://another-host/private"), /local file path/);
  await assert.rejects(files.create(join(config.userHome, "escape", "new")), /outside/);
  await assert.rejects(files.create(join(config.userHome, ".ssh", "new")), /not shared/);
});

test("credential directories stay private through a symlinked home and realpath aliases", async t => {
  const { files, config } = await fixture(t);
  await writeFile(join(config.agentDir, "auth.json"), "secret");
  const canonical = await realpath(join(config.agentDir, "auth.json"));
  await assert.rejects(files.read(canonical), /not shared/);
  await mkdir(join(config.userHome, "project", "credentials"), { recursive: true });
  await writeFile(join(config.userHome, "project", "credentials", "token"), "secret");
  await assert.rejects(files.read(join(config.userHome, "project", "credentials", "token")), /not shared/);
});

test("recursive creation respects missing parents and protected ancestors", async t => {
  const { files, config } = await fixture(t);
  await assert.rejects(files.create(join(config.userHome, "one", "two"), false), /Parent directory/);
  const folder = await files.create(join(config.userHome, "one", "two"), true);
  assert.equal(await files.create(folder), folder, "creating an existing directory is idempotent");
  await writeFile(join(folder, "file"), "x");
  await assert.rejects(files.create(join(folder, "file")), /Choose a directory/);
});

test("only local registration may extend shared roots beyond the home directory", async t => {
  const { files, root, app } = await fixture(t);
  const project = join(root, "shared-project"); await mkdir(project);
  await assert.rejects(files.list(project), /not shared/);
  const c = await client(app, "remote");
  assert.equal((await c.send("bridge/register", { info: { cwd: project } })).error.code, -32601);
  await files.addRoot(project);
  assert.deepEqual(await files.list(project), { entries: [] });
});

test("input images are size bounded, local files are guarded, and arbitrary downloads are never fetched", async t => {
  const { files, config } = await fixture(t);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const local = join(config.userHome, "image.png"); await writeFile(local, png);
  const parsed = await piInput([{ type: "text", text: "look" }, { type: "localImage", path: local }], files);
  assert.equal(parsed.text, "look"); assert.equal(parsed.images[0].mimeType, "image/png");
  assert.equal((await piInput([{ type: "image", url: `data:image/png;base64,${png.toString("base64")}` }], files)).images.length, 1);
  await assert.rejects(piInput([{ type: "image", url: "http://127.0.0.1/private" }], files), /downloads are disabled/);
  await assert.rejects(piInput([{ type: "localImage", path: join(config.agentDir, "auth.json") }], files), /not shared/);
  await assert.rejects(piInput([{ type: "skill", path: "../../secret" }], files), /not supported/);
  await assert.rejects(piInput([{ type: "text", text: " " }], files), /Enter a message/);
});

test("directory discovery commands have exact matching and never evaluate shell text", async t => {
  const { app, config } = await fixture(t); const c = await client(app, "mac");
  const pwd = await c.send("command/exec", { command: ["pwd"] });
  assert.equal(pwd.result.stdout, (await realpath(config.userHome)) + "\n");
  assert.equal((await c.send("command/exec", { command: ["/bin/sh", "-lc", "echo $HOME"] })).result.stdout, config.userHome + "\n");
  const target = join(config.userHome, "should-not-exist");
  assert.ok((await c.send("command/exec", { command: ["/bin/sh", "-lc", `pwd; touch ${target}`] })).error);
  await assert.rejects(stat(target), { code: "ENOENT" });
  assert.ok((await c.send("command/exec", { command: ["pwd"], sandboxPolicy: { type: "readOnly" } })).error);
});
