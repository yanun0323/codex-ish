import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, cp, writeFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("Git-package preparation builds Remote without TypeScript, dev dependencies, or Pi peers", async t => {
  const root = await mkdtemp("/tmp/cish-build-"); t.after(() => rm(root, { recursive: true, force: true }));
  await cp("src/remote", join(root, "src", "remote"), { recursive: true });
  await mkdir(join(root, "scripts"));
  await cp("scripts/build-remote.mjs", join(root, "scripts", "build-remote.mjs"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  const run = promisify(execFile);
  await run(process.execPath, [join(root, "scripts", "build-remote.mjs")], { cwd: root, env: { PATH: "/usr/bin:/bin" } });
  const files = await readdir(join(root, "dist", "remote"));
  const expected = (await readdir(resolve("src/remote"))).filter(name => name.endsWith(".ts")).map(name => name.replace(/\.ts$/, ".js"));
  assert.deepEqual(files.sort(), expected.sort());
  for (const name of files) await run(process.execPath, ["--check", join(root, "dist", "remote", name)]);
  const smoke = await run(process.execPath, ["--input-type=module", "-e",
    'import {RpcError} from "./dist/remote/types.js"; import {normalizeBase} from "./dist/remote/config.js"; if(new RpcError(-1,"test").code!==-1 || normalizeBase("https://chatgpt.com/backend-api")!=="https://chatgpt.com/backend-api/") process.exit(1);'], { cwd: root });
  assert.equal(smoke.stderr, "");
});
