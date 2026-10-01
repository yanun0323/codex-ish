import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export interface RemoteConfig {
  home: string; agentDir: string; userHome: string; socket: string;
  endpoint: string; database: string; baseUrl: string; hostName: string;
}
export function config(env = process.env): RemoteConfig {
  const agentDir = resolve(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  // Deliberately separate from the previous package's database and enrollment.
  const home = resolve(env.PI_CODEX_ISH_REMOTE_HOME ?? join(agentDir, "codex-ish-remote"));
  return { home, agentDir, userHome: homedir(), socket: join(home, "host.sock"),
    endpoint: join(home, "endpoint.json"), database: join(home, "remote.sqlite"),
    baseUrl: normalizeBase(env.PI_CODEX_REMOTE_BASE_URL ?? "https://chatgpt.com/backend-api/"),
    hostName: env.PI_CODEX_APP_SERVER_HOST_NAME ?? hostname() };
}
export function normalizeBase(value: string): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const official = url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com");
  if (url.username || url.password || url.search || url.hash ||
      !(local && ["http:", "https:"].includes(url.protocol) || official && url.protocol === "https:")) {
    throw new Error("Remote backend must use HTTPS on chatgpt.com, or a loopback test server.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}
