import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { piInput } from "../dist/remote/runtime.js";
import { commandSkills } from "../dist/remote/skills.js";
import { fixture, client, input } from "./remote-helpers.mjs";

async function skillFixture(t) {
  const f = await fixture(t);
  const path = join(f.config.agentDir, "skills", "test-skill", "SKILL.md");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "---\nname: test-skill\ndescription: Local skill\n---\nUse the regression marker SKILL_BODY.\n");
  const skill = { name: "test-skill", path, description: "Local skill", scope: "user" };
  return { ...f, skill };
}

test("skills discovery uses the active Pi session and never turns the private skill folder into a shared root", async t => {
  const { app, sessions, files, config, skill } = await skillFixture(t);
  const canonicalHome = await files.directory(config.userHome);
  sessions.attach({ info: { id: "live-skills", cwd: canonicalHome, model: "fake/test", provider: "fake", effort: "medium" },
    skills: async () => [skill], send: async () => {}, abort: async () => {}, close: async () => {} });
  app.options.skills = async () => { throw new Error("Should use the active session's skills"); };
  const c = await client(app, "app");
  const list = await c.send("skills/list", { cwds: [config.userHome], forceReload: true });
  assert.equal(list.result.data[0].skills[0].name, skill.name);
  assert.equal(list.result.data[0].skills[0].enabled, true);
  assert.equal(list.result.data[0].skills[0].pluginId, null);
  sessions.attach({ info: { id: "other-skills", cwd: canonicalHome, model: "fake/test", provider: "fake", effort: "medium" },
    skills: async () => [], send: async () => {}, abort: async () => {}, close: async () => {} });
  await c.send("thread/resume", { threadId: "live-skills" });
  assert.equal((await c.send("skills/list", { cwds: ["~"] })).result.data[0].skills[0].name, skill.name,
    "the selected conversation takes precedence over a different session in the same directory");
  await assert.rejects(files.read(skill.path), /not shared/);
  assert.equal((await c.send("skills/list", { cwds: [config.agentDir] })).error.code, -32600);
  assert.equal((await c.send("skills/list", { cwds: ["relative"] })).error.code, -32602);
  assert.equal((await c.send("skills/list", { forceReload: "yes" })).error.code, -32602);
  assert.deepEqual(commandSkills([{ name: "skill:test-skill", source: "skill", description: skill.description,
    sourceInfo: { path: skill.path, scope: "user" } }, { name: "skill:not-a-skill", source: "extension" }]), [skill]);
});

test("selected skills are loaded once per input and file/folder mentions become guarded absolute references", async t => {
  const { files, config, skill } = await skillFixture(t);
  const folder = join(config.userHome, "project 中文"); await mkdir(folder);
  const file = join(folder, "notes & details.txt"); await writeFile(file, "not automatically injected");
  const parts = [{ type: "text", text: "$test-skill please inspect" }, { type: "skill", name: skill.name, path: skill.path },
    { type: "skill", name: skill.name, path: skill.path }, { type: "mention", name: "notes", path: "notes & details.txt" },
    { type: "mention", name: "folder", path: folder }];
  const original = structuredClone(parts); let reads = 0;
  const parsed = await piInput(parts, files, { cwd: folder, skills: async () => { reads++; return [skill]; } });
  assert.match(parsed.text, /^<skill name="test-skill"/);
  assert.equal(parsed.text.match(/SKILL_BODY/g).length, 1);
  assert.match(parsed.text, /notes &amp; details.txt/);
  assert.match(parsed.text, /References are relative to/);
  assert.doesNotMatch(parsed.text, /description: Local skill|not automatically injected/);
  assert.equal(reads, 1); assert.deepEqual(parts, original);
  assert.ok((await piInput([{ type: "skill", name: skill.name, path: skill.path }], files, { skills: async () => [skill] })).text);
});

test("skill and mention inputs cannot read arbitrary private files, links, URLs, or oversized instructions", async t => {
  const { files, config, root, skill } = await skillFixture(t);
  const options = { cwd: config.userHome, skills: async () => [skill] };
  const auth = join(config.agentDir, "auth.json"); await writeFile(auth, "secret");
  const outside = join(root, "outside.md"); await writeFile(outside, "outside");
  const link = join(config.userHome, "alias.md"); await symlink(auth, link);
  for (const path of [auth, outside, link, "../../outside.md", "https://example.com/file", "app://connector/tool", "file://other-host/private"]) {
    await assert.rejects(piInput([{ type: "mention", name: "file", path }], files, options));
    await assert.rejects(piInput([{ type: "skill", name: skill.name, path }], files, options));
  }
  await assert.rejects(piInput([{ type: "skill", name: "forged", path: skill.path }], files, options), /not available/);
  await assert.rejects(piInput([null], files, options), /object/);
  await writeFile(skill.path, "x".repeat(256 * 1024 + 1));
  await assert.rejects(piInput([{ type: "skill", name: skill.name, path: skill.path }], files, options), /256 KiB/);
});

test("expanded inputs reach Pi without duplicate user messages and keep only original selections in remote history", async t => {
  const { app, sessions, files, config, skill } = await skillFixture(t);
  const id = "live-input"; const received = [];
  sessions.attach({ info: { id, cwd: config.userHome, model: "fake/test", provider: "fake", effort: "medium" },
    skills: async () => [skill],
    prepareInput: parts => piInput(parts, files, { cwd: config.userHome, skills: async () => [skill] }),
    send: async (parts, _options, prepared) => {
      received.push(prepared.text);
      sessions.event(id, { type: "message_start", message: { role: "user", content: prepared.text } });
    }, abort: async () => {}, close: async () => {} });
  const c = await client(app, "app");
  const parts = [...input("use this"), { type: "skill", name: skill.name, path: skill.path }];
  assert.ok((await c.send("turn/start", { threadId: id, input: parts, clientUserMessageId: "one" })).result);
  assert.match(received[0], /SKILL_BODY/);
  assert.equal(sessions.read(id).turns[0].items.filter(i => i.type === "userMessage").length, 1);
  assert.deepEqual(sessions.read(id).turns[0].items[0].content, parts);
  assert.doesNotMatch(JSON.stringify(c.events("item/completed")), /SKILL_BODY/);
  await c.send("turn/start", { threadId: id, input: parts, clientUserMessageId: "one" });
  assert.equal(received.length, 1, "request replay does not reload or resend a skill");
});
