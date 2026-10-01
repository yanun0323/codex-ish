import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionOwners, sessionHeader, sessionTip } from "../dist/remote/ownership.js";
import { fixture } from "./remote-helpers.mjs";

async function saved(t) {
  const f = await fixture(t), id = randomUUID(), file = join(f.config.userHome, "session.jsonl");
  await writeFile(file, JSON.stringify({ type: "session", id, cwd: f.config.userHome }) + "\n" + JSON.stringify({ type: "custom", id: "leaf" }) + "\n");
  return { ...f, id, file, owners: new SessionOwners(f.config.database) };
}
test("a live process claim survives socket loss; only matching tokens can release it", async t => {
  const f = await saved(t);
  const live = f.owners.claim(f.id, f.file, "live");
  const other = new SessionOwners(f.config.database);
  assert.throws(() => other.claim(f.id, f.file, "worker"), /still open/);
  assert.throws(() => other.claim(f.id, f.file, "live"), /still open/);
  other.release({ ...live, token: "wrong" }); f.owners.assert(live);
  other.release({ ...live, kind: "worker" }); f.owners.assert(live);
  f.owners.release(live, "leaf");
  const worker = other.claim(f.id, f.file, "worker"); assert.equal(other.cursor(worker), "leaf");
  assert.throws(() => f.owners.assert(live), /no longer owns/);
  f.owners.release(live); other.assert(worker);
  other.release(worker);
  const afterFailure = other.claim(f.id, f.file, "worker");
  assert.equal(other.cursor(afterFailure), "leaf", "failed initialization without a new cursor preserves the saved branch");
  other.release(afterFailure);
});
test("the same file cannot be opened as another session and another file cannot replace a known session", async t => {
  const f = await saved(t), owner = f.owners.claim(f.id, f.file, "live");
  assert.throws(() => f.owners.claim("other", f.file, "worker"), /already in use/);
  assert.throws(() => f.owners.claim(f.id, join(f.config.userHome, "other.jsonl"), "worker"), /different session file/);
  f.owners.release(owner);
});
test("a dead process can be replaced, but an alive process with a disconnected bridge cannot", async t => {
  const f = await saved(t);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn"); t.after(() => { if (child.exitCode === null) child.kill(); });
  f.owners.claim(f.id, f.file, "live", "old-process", child.pid);
  assert.throws(() => f.owners.claim(f.id, f.file, "worker"), /still open/);
  const ended = once(child, "exit"); child.kill(); await ended;
  const worker = f.owners.claim(f.id, f.file, "worker"); f.owners.assert(worker); f.owners.release(worker);
});
test("legacy migration waits for untracked Pi processes rather than assuming they exited", async t => {
  const f = await saved(t); let pids = [process.pid, 424242];
  const owners = new SessionOwners(f.config.database, () => true, async () => pids);
  const live = owners.claim(f.id, f.file, "live");
  await assert.rejects(owners.checkLegacy(), /older Pi window/);
  pids = [process.pid]; await owners.checkLegacy();
  owners.release(live); await assert.rejects(owners.checkLegacy(), /older Pi window/);
  pids = []; await owners.checkLegacy();
});
test("branch cursors only apply to the exact saved file and header-only sessions remain resumable", async t => {
  const f = await saved(t); let owner = f.owners.claim(f.id, f.file, "live");
  f.owners.release(owner, "leaf");
  await writeFile(f.file, (await readFile(f.file, "utf8")) + JSON.stringify({ type: "custom", id: "new-leaf" }) + "\n");
  owner = f.owners.claim(f.id, f.file, "worker"); assert.equal(f.owners.cursor(owner), undefined);
  f.owners.release(owner, "new-leaf");
  assert.equal(sessionTip(f.file), "new-leaf"); assert.equal(sessionHeader(f.file).id, f.id);
  await writeFile(f.file, JSON.stringify({ type: "session", id: f.id, cwd: f.config.userHome }) + "\n");
  owner = f.owners.claim(f.id, f.file, "live"); f.owners.release(owner, "not-yet-persisted");
  owner = f.owners.claim(f.id, f.file, "worker"); assert.equal(f.owners.cursor(owner), undefined); f.owners.release(owner);
});
test("session validation never creates or rewrites missing, foreign, or malformed files", async t => {
  const f = await saved(t), missing = join(f.config.userHome, "missing.jsonl");
  assert.throws(() => sessionHeader(missing), { code: "ENOENT" });
  await writeFile(f.file, '{"private":"not a session"}\n'); const before = await readFile(f.file);
  assert.throws(() => sessionHeader(f.file), /Invalid session/); assert.deepEqual(await readFile(f.file), before);
  await writeFile(f.file, JSON.stringify({ type: "session", id: f.id, cwd: f.config.userHome }) + "\n" + JSON.stringify({ type: "custom", id: "big-leaf", data: "x".repeat(200000) }) + "\n");
  assert.equal(sessionTip(f.file), "big-leaf");
});
