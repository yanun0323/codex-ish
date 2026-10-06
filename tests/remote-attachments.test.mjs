import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, realpath, stat, lstat, symlink, link, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixture, client } from "./remote-helpers.mjs";
import { HostFiles } from "../dist/remote/filesystem.js";
import { piInput } from "../dist/remote/runtime.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const ok = response => { assert.ok(response.result, JSON.stringify(response)); return response.result; };
const rejected = response => { assert.ok(response.error, JSON.stringify(response)); return response.error; };
const create = async (c, home) => {
  const folder = join(home, "attachments", randomUUID());
  ok(await c.send("fs/createDirectory", { path: folder, recursive: true }));
  return folder;
};

test("App home resolves the new-chat browser to the Pi home, not its private service directory", async t => {
  const { app, config } = await fixture(t); const c = await client(app, "ios");
  const home = c.messages[0].result.codexHome;
  assert.equal(home, join(config.userHome, ".codex"));
  assert.equal(dirname(home), config.userHome);
  const settings = ok(await c.send("config/read")).config;
  assert.equal(settings.cwd, config.userHome); assert.equal(settings.user_home, config.userHome);
  assert.equal(ok(await c.send("fs/getMetadata", { path: dirname(home) })).isDirectory, true);
  ok(await c.send("fs/readDirectory", { path: dirname(home) }));
  await mkdir(join(config.userHome, "Projects"));
  for (const cwd of [undefined, "~", pathToFileURL(config.userHome).href]) {
    assert.equal(ok(await c.send("thread/start", { cwd })).thread.cwd, await realpath(config.userHome));
  }
  assert.ok(ok(await c.send("fs/readDirectory", { path: "~" })).entries.some(e => e.fileName === "Projects"));
  assert.equal(ok(await c.send("fs/getMetadata", { path: "~/Projects" })).isDirectory, true);
  for (const path of ["~/.pi/agent", "~/../outside", "~other/Projects"]) rejected(await c.send("fs/readDirectory", { path }));
  assert.deepEqual(ok(await c.send("plugin/installed", { cwds: ["~"] })), { marketplaces: [], marketplaceLoadErrors: [] });
  assert.deepEqual(ok(await c.send("threadSection/list", { limit: 50 })), { data: [], nextCursor: null });
  rejected(await c.send("plugin/installed", { cwds: "~" }));
  rejected(await c.send("threadSection/create", { name: "not implemented" }));
});

test("iOS image upload, metadata, readback, and localImage input work without exposing real Codex files", async t => {
  const { app, config, files, mock } = await fixture(t); const c = await client(app, "ios");
  const home = c.messages[0].result.codexHome;
  await mkdir(join(home, "attachments"), { recursive: true });
  await writeFile(join(home, "auth.json"), "REAL_CODEX_CREDENTIALS");
  await writeFile(join(home, "attachments", "keep.png"), "REAL_CODEX_ATTACHMENT");
  const folder = await create(c, home), image = join(folder, "螢幕截圖.png");
  const url = pathToFileURL(image).href;
  ok(await c.send("fs/writeFile", { path: url, dataBase64: png.toString("base64") }));
  assert.equal(ok(await c.send("fs/getMetadata", { path: url })).isFile, true);
  assert.deepEqual(ok(await c.send("fs/readDirectory", { path: folder })).entries,
    [{ fileName: "螢幕截圖.png", isDirectory: false, isFile: true }]);
  assert.equal(ok(await c.send("fs/readFile", { path: image })).dataBase64, png.toString("base64"));
  assert.deepEqual(ok(await c.send("fs/readDirectory", { path: home })).entries,
    [{ fileName: "attachments", isDirectory: true, isFile: false }]);
  rejected(await c.send("fs/readFile", { path: join(home, "auth.json") }));
  rejected(await c.send("fs/readFile", { path: join(home, "attachments", "keep.png") }));
  const decoded = await piInput([{ type: "localImage", path: url }], files);
  assert.deepEqual(decoded.images, [{ type: "image", mimeType: "image/png", data: png.toString("base64") }]);
  const thread = ok(await c.send("thread/start"));
  let prepared;
  mock.backends.at(-1).prepareInput = input => piInput(input, files);
  mock.backends.at(-1).send = async (_input, _options, value) => { prepared = value; };
  ok(await c.send("turn/start", { threadId: thread.thread.id, input: [{ type: "localImage", path: url }] }));
  assert.deepEqual(prepared.images, decoded.images);
  const reopened = new HostFiles(config.userHome, config.agentDir, config.home);
  assert.deepEqual(await reopened.read(url), png, "saved attachments survive a host restart");
  const backing = await files.existing(image);
  assert.equal((await stat(backing)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(backing))).mode & 0o777, 0o700);
  rejected(await c.send("fs/readFile", { path: backing }));
  assert.equal(await readFile(join(home, "auth.json"), "utf8"), "REAL_CODEX_CREDENTIALS");
  assert.equal(await readFile(join(home, "attachments", "keep.png"), "utf8"), "REAL_CODEX_ATTACHMENT");
  await assert.rejects(lstat(folder), { code: "ENOENT" }, "the virtual path never touches the real Codex home");
});

test("cached attachment paths use the isolated store without opening the old Remote home", async t => {
  const { app, config } = await fixture(t); const c = await client(app, "ios");
  const folder = await create(c, config.home), image = join(folder, "image.png");
  ok(await c.send("fs/writeFile", { path: image, dataBase64: png.toString("base64") }));
  const newPath = join(c.messages[0].result.codexHome, "attachments", folder.split("/").at(-1), "image.png");
  assert.equal(ok(await c.send("fs/readFile", { path: newPath })).dataBase64, png.toString("base64"));
  for (const name of ["remote.sqlite", "endpoint.json", "debug-remote.jsonl"]) rejected(await c.send("fs/readFile", { path: join(config.home, name) }));
  rejected(await c.send("fs/readDirectory", { path: config.home }));
});

test("image writes and cleanup cannot modify project files, credentials, or attachment roots", async t => {
  const { app, config } = await fixture(t); const c = await client(app, "ios");
  const home = c.messages[0].result.codexHome, folder = await create(c, home);
  const project = join(config.userHome, "project.png"); await writeFile(project, "KEEP_PROJECT");
  for (const path of [project, join(config.agentDir, "auth.json"), join(home, "auth.json"),
    join(folder, "..", "..", "auth.json"), join(folder, "script.sh"), join(folder, ".hidden.png"),
    join(folder, "sub", "image.png"), join(home, "attachments", "not-a-uuid", "image.png")]) {
    rejected(await c.send("fs/writeFile", { path, dataBase64: png.toString("base64") }));
    rejected(await c.send("fs/remove", { path }));
  }
  for (const path of [home, join(home, "attachments"), config.home]) rejected(await c.send("fs/remove", { path }));
  assert.equal(await readFile(project, "utf8"), "KEEP_PROJECT");
  const image = join(folder, "image.png");
  for (const dataBase64 of [null, "%%%", "YQ", "YQ==\n", "c2hlbGw=", Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64")]) {
    rejected(await c.send("fs/writeFile", { path: image, dataBase64 }));
  }
  ok(await c.send("fs/writeFile", { path: image, dataBase64: png.toString("base64") }));
  ok(await c.send("fs/writeFile", { path: image, dataBase64: png.toString("base64") }));
  rejected(await c.send("fs/remove", { path: folder, recursive: "true" }));
  rejected(await c.send("fs/remove", { path: folder, force: "true" }));
  ok(await c.send("fs/remove", { path: image, recursive: false }));
  ok(await c.send("fs/remove", { path: image, force: true }));
  rejected(await c.send("fs/remove", { path: image, force: false }));
  ok(await c.send("fs/remove", { path: folder, recursive: false }));
});

test("attachment operations reject symbolic links, hard links, and a replaced storage directory", async t => {
  const { app, config, files } = await fixture(t); const c = await client(app, "ios");
  const home = c.messages[0].result.codexHome, folder = await create(c, home);
  const physical = await files.existing(folder);
  const victim = join(config.userHome, "victim.png"); await writeFile(victim, png);
  await symlink(victim, join(physical, "symlink.png"));
  await link(victim, join(physical, "hardlink.png"));
  for (const name of ["symlink.png", "hardlink.png"]) {
    const path = join(folder, name);
    rejected(await c.send("fs/readFile", { path }));
    rejected(await c.send("fs/writeFile", { path, dataBase64: png.toString("base64") }));
    rejected(await c.send("fs/remove", { path }));
  }
  rejected(await c.send("fs/remove", { path: folder, recursive: true }));
  const id = randomUUID();
  await symlink(config.userHome, join(config.home, "client-files", "attachments", id));
  rejected(await c.send("fs/createDirectory", { path: join(home, "attachments", id) }));
  rejected(await c.send("fs/writeFile", { path: join(home, "attachments", id, "victim.png"), dataBase64: png.toString("base64") }));
  assert.deepEqual(await readFile(victim), png);
  const other = join(config.home, "other-store"); await mkdir(other);
  await symlink(config.userHome, join(other, "client-files"));
  const unsafe = new HostFiles(config.userHome, config.agentDir, other);
  await assert.rejects(unsafe.create(join(home, "attachments", randomUUID())), /cannot be links/);
});

test("attachment disk quotas apply to concurrent requests and release capacity on removal", async t => {
  const { app, config, files } = await fixture(t); const c = await client(app, "ios");
  const home = c.messages[0].result.codexHome, folder = await create(c, home);
  const physical = await files.existing(folder);
  const large = await open(join(physical, "large.png"), "w", 0o600);
  await large.truncate(128 * 1024 * 1024 - png.length); await large.close();
  const responses = await Promise.all(["one.png", "two.png"].map(name =>
    c.send("fs/writeFile", { path: join(folder, name), dataBase64: png.toString("base64") })));
  assert.equal(responses.filter(r => r.result).length, 1);
  assert.equal(responses.filter(r => r.error).length, 1);
  ok(await c.send("fs/remove", { path: join(folder, "large.png") }));
  ok(await c.send("fs/writeFile", { path: join(folder, "after.png"), dataBase64: png.toString("base64") }));
  for (let i = 0; i < 255; i++) await mkdir(join(config.home, "client-files", "attachments", randomUUID()));
  rejected(await c.send("fs/createDirectory", { path: join(home, "attachments", randomUUID()) }));
  ok(await c.send("fs/createDirectory", { path: folder }));
  ok(await c.send("fs/remove", { path: folder, recursive: true }));
  await create(c, home);
});
