import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fixture } from "./remote-helpers.mjs";

test("real Pi processes hand the original saved conversation to the background host and back", async t => {
  const { config } = await fixture(t);
  const result = await promisify(execFile)(process.execPath, ["tests/fixtures/sdk-handoff.mjs",
    resolve(process.env.PI_REMOTE_TEST_SDK ?? "node_modules/@earendil-works/pi-coding-agent/dist/index.js")], {
    timeout: 60000,
    env: { PATH: process.env.PATH, HOME: config.userHome, PI_CODING_AGENT_DIR: config.agentDir,
      PI_CODEX_ISH_REMOTE_HOME: config.home, PI_CODEX_ISH_WORKER: "1", NO_COLOR: "1" },
  });
  assert.match(result.stdout, /SDK handoff:.*passed/);
});
