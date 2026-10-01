import { stripTypeScriptTypes } from "node:module";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

// Pi installs Git packages without development dependencies. Build using Node itself;
// the separate `check` command still uses TypeScript for full static checking.
const source = new URL("../src/remote/", import.meta.url);
const output = new URL("../dist/remote/", import.meta.url);
await mkdir(output, { recursive: true });
for (const name of (await readdir(source)).filter(name => name.endsWith(".ts") && !name.endsWith(".d.ts")).sort()) {
  const code = await readFile(new URL(name, source), "utf8");
  const javascript = stripTypeScriptTypes(code, { mode: "strip" });
  await writeFile(new URL(name.replace(/\.ts$/, ".js"), output), javascript);
}
