import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fixture } from "./remote-helpers.mjs";

test("the installed Pi SDK runs and resumes an isolated worker with only a local fake model endpoint", async t => {
  const { config } = await fixture(t);
  const result = await promisify(execFile)(process.execPath, ["tests/fixtures/sdk-worker.mjs",
    resolve(process.env.PI_REMOTE_TEST_SDK ?? "node_modules/@earendil-works/pi-coding-agent/dist/index.js")], {
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: config.userHome, PI_CODING_AGENT_DIR: config.agentDir,
      PI_CODEX_ISH_REMOTE_HOME: config.home, PI_CODEX_ISH_WORKER: "1", NO_COLOR: "1" },
  });
  assert.match(result.stdout, /SDK worker:.*passed/);
});

test("the installed Pi extension API changes settings and sends selected inputs through the real bridge", async t => {
  const { config } = await fixture(t);
  const result = await promisify(execFile)(process.execPath, ["tests/fixtures/sdk-bridge.mjs",
    resolve(process.env.PI_REMOTE_TEST_SDK ?? "node_modules/@earendil-works/pi-coding-agent/dist/index.js")], {
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: config.userHome, PI_CODING_AGENT_DIR: config.agentDir,
      PI_CODEX_ISH_REMOTE_HOME: config.home, NO_COLOR: "1" },
  });
  assert.match(result.stdout, /SDK bridge:.*passed/);
});
