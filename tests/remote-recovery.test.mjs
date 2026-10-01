import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { fixture, client, input } from "./remote-helpers.mjs";

function liveBackend(id, cwd) {
  return { info: { id, cwd, model: "fake/test", provider: "fake", effort: "medium" }, send: async () => {}, abort: async () => {}, close: async () => {} };
}

test("terminal reconnect reconciles missed history and branch changes without a second writer", async t => {
  const { sessions, config, mock } = await fixture(t);
  const id = randomUUID(); const owner = liveBackend(id, config.userHome);
  const first = [{ role: "user", content: "first" }, { role: "assistant", content: [{ type: "text", text: "answer one" }] }];
  sessions.attach(owner, first);
  const before = sessions.read(id).turns[0].id;
  sessions.detach(id, owner);
  const same = liveBackend(id, config.userHome); sessions.attach(same, first);
  assert.equal(sessions.read(id).turns[0].id, before, "unchanged snapshots preserve item and turn identities");
  sessions.detach(id, same);
  const missed = liveBackend(id, config.userHome);
  const latest = [...first, { role: "user", content: "sent while offline" }, { role: "assistant", content: [{ type: "text", text: "offline answer" }] }];
  sessions.attach(missed, latest);
  assert.equal(sessions.read(id).turns.length, 2);
  assert.equal(sessions.read(id).turns.at(-1).items.at(-1).text, "offline answer");
  sessions.detach(id, missed);
  sessions.attach(liveBackend(id, config.userHome), [{ role: "user", content: "another branch" }]);
  assert.equal(sessions.read(id).turns.length, 1);
  assert.equal(sessions.read(id).turns[0].items[0].content[0].text, "another branch");
  assert.equal(mock.backends.length, 0);
});

test("rejecting a malformed follow-up never completes or duplicates a running Pi turn", async t => {
  const { app, config, sessions, mock } = await fixture(t); const c = await client(app, "phone");
  const created = await c.send("thread/start", { cwd: config.userHome }); const id = created.result.thread.id;
  const first = await c.send("turn/start", { threadId: id, input: input("working") });
  const bad = await c.send("turn/start", { threadId: id, input: [{ type: "skill", path: "untrusted" }] });
  assert.ok(bad.error);
  assert.equal(sessions.read(id).turns.length, 1);
  assert.equal(sessions.read(id).turns[0].status, "inProgress");
  assert.equal(mock.backends[0].sends.length, 1);
  assert.equal(c.events("turn/completed").length, 0);
  mock.backends[0].answer("completed normally");
  assert.equal(c.events("turn/completed")[0].params.turn.id, first.result.turn.id);
});

test("Codex config overrides cannot silently bypass unsupported sandbox requirements", async t => {
  const { app, config, mock } = await fixture(t); const c = await client(app, "phone");
  for (const extra of [{ config: { sandbox_mode: "read-only" } }, { permissionProfile: "read-only" }, { disabledPluginIds: ["unsafe"] }]) {
    const result = await c.send("thread/start", { cwd: config.userHome, ...extra }); assert.equal(result.error.code, -32602);
  }
  assert.equal(mock.backends.length, 0);
});
