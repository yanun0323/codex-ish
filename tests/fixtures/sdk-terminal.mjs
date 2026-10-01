// A real Pi session in its own process. Only the parent's loopback model is allowed.
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../../dist/remote/config.js";
import { registerRemoteControl } from "../../dist/remote/client.js";
const cfg = config(), sdk = await import(pathToFileURL(resolve(process.argv[2])).href);
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => { assert.ok(String(url).startsWith(process.env.TEST_MODEL_URL + "/")); return nativeFetch(url, options); };
const runtime = await sdk.ModelRuntime.create({ authPath: join(cfg.agentDir, "auth.json"), modelsPath: join(cfg.agentDir, "models.json"),
  modelsStorePath: join(cfg.home, "models-cache.json"), allowModelNetwork: false });
const loader = new sdk.DefaultResourceLoader({ cwd: cfg.userHome, agentDir: cfg.agentDir, noExtensions: true,
  extensionFactories: [pi => registerRemoteControl(pi, async () => { throw new Error("No pairing in tests"); })] });
await loader.reload({ resolveProjectTrust: async () => false });
const manager = process.argv[3] ? sdk.SessionManager.open(process.argv[3]) : sdk.SessionManager.create(cfg.userHome);
const { session } = await sdk.createAgentSession({ cwd: cfg.userHome, agentDir: cfg.agentDir, modelRuntime: runtime,
  model: runtime.getModel("handoff-test", "model"), thinkingLevel: "high", sessionManager: manager, resourceLoader: loader });
const errors = []; await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
assert.deepEqual(errors, []);
process.send({ event: "ready", id: session.sessionId, file: session.sessionFile });
process.on("message", async message => {
  try {
    if (message.action === "prompt") {
      await session.prompt(message.text);
      process.send({ request: message.request, result: { last: session.getLastAssistantText(), count: session.messages.length } });
    } else if (message.action === "quit") {
      await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose(); process.send({ request: message.request, result: {} }); process.disconnect();
    }
  } catch (error) { process.send({ request: message.request, error: error.message }); }
});
