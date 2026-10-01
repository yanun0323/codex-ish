import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlApi, BackendError, retryAfter } from "../dist/remote/control-api.js";
import { State } from "../dist/remote/state.js";
import { normalizeBase } from "../dist/remote/config.js";

function setup(t, respond) {
  const state = new State(":memory:"); t.after(() => state.close());
  const requests = [];
  let credentials = { accessToken: "chatgpt-oauth", accountId: "account-1" };
  const config = { baseUrl: "http://127.0.0.1/backend-api/", hostName: "測試主機" };
  const api = new ControlApi(config, state, async () => credentials, async (url, options) => {
    const request = { path: url.pathname, query: url.search, ...options, body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request); return respond(request, requests.length);
  });
  return { api, state, requests, setIdentity: value => { credentials = value; } };
}
const enrollment = token => ({ server_id: "server", environment_id: "environment", remote_control_token: token,
  expires_at: new Date(Date.now() + 3600_000).toISOString() });
const pairing = { pairing_code: "fake-qr", manual_pairing_code: "fake-manual", server_id: "server", environment_id: "environment",
  expires_at: new Date(Date.now() + 120_000).toISOString() };
const json = data => Response.json(data);

test("concurrent enrollment uses one request, separates OAuth from host tokens, and never persists tokens", async t => {
  const { api, state, requests } = setup(t, () => json(enrollment("host-secret")));
  await Promise.all([api.ensureEnrollment(), api.ensureEnrollment(), api.ensureEnrollment()]);
  assert.equal(requests.length, 1);
  const first = requests[0];
  assert.equal(first.headers.Authorization, "Bearer chatgpt-oauth");
  assert.equal(first.headers["chatgpt-account-id"], "account-1");
  assert.equal(first.body.installation_id, first.headers["x-codex-installation-id"]);
  assert.equal(first.body.app_server_version, "0.141.0", "enrollment needs the plain App Server compatibility version");
  const connection = await api.connection();
  assert.equal(connection.headers.Authorization, "Bearer host-secret");
  assert.equal(connection.headers["x-codex-protocol-version"], "3");
  assert.equal(Buffer.from(connection.headers["x-codex-name"], "base64").toString(), "測試主機");
  assert.doesNotMatch(JSON.stringify(state.list("host")), /host-secret|chatgpt-oauth/);
});

test("pairing retries authorization once with a refreshed host token; device management uses OAuth", async t => {
  let pairs = 0;
  const { api, requests } = setup(t, request => {
    if (request.path.endsWith("/enroll")) return json(enrollment("old-host"));
    if (request.path.endsWith("/refresh")) return json(enrollment("new-host"));
    if (request.path.endsWith("/pair")) return ++pairs === 1 ? new Response("secret body", { status: 401 }) : json(pairing);
    if (request.path.endsWith("/pair/status")) return json({ claimed: true });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    return json({ items: [{ client_id: "phone", display_name: "Phone", last_seen_at: "2026-10-01T00:00:00Z" }], cursor: "next" });
  });
  assert.deepEqual(await api.pair(), { pairingCode: "fake-qr", manualPairingCode: "fake-manual", environmentId: "environment", expiresAt: pairing.expires_at });
  assert.equal(requests[1].headers.Authorization, "Bearer old-host");
  assert.equal(requests[2].headers.Authorization, "Bearer chatgpt-oauth");
  assert.equal(requests[3].headers.Authorization, "Bearer new-host");
  assert.deepEqual(await api.pairingStatus({ manualPairingCode: "fake-manual" }), { claimed: true });
  assert.deepEqual(requests.at(-1).body, { manual_pairing_code: "fake-manual" });
  const devices = await api.devices({ cursor: "opaque + cursor" });
  assert.equal(devices.data[0].clientId, "phone"); assert.equal(devices.nextCursor, "next");
  assert.equal(requests.at(-1).headers.Authorization, "Bearer chatgpt-oauth");
  await api.revoke("phone/id");
  assert.ok(requests.at(-1).path.endsWith("phone%2Fid")); assert.equal(requests.at(-1).method, "DELETE");
  await assert.rejects(api.pairingStatus({ pairingCode: "one", manualPairingCode: "two" }), /exactly one/);
});

test("account changes invalidate Remote authorization before enrollment, pairing, listing, or revoke", async t => {
  const f = setup(t, () => json(enrollment("secret"))); await f.api.ensureEnrollment();
  f.setIdentity({ accessToken: "different-oauth", accountId: "account-2" });
  for (const action of [() => f.api.connection(), () => f.api.pair(), () => f.api.devices(), () => f.api.revoke("phone")]) {
    await assert.rejects(action(), /another ChatGPT account/);
  }
  assert.equal(f.requests.length, 1); assert.equal(f.state.get("host", "accountId"), "account-1");
});

test("refresh never silently changes the host identity, except after an explicit missing-enrollment response", async t => {
  const f = setup(t, request => request.path.endsWith("/refresh") ? json({ ...enrollment("bad"), server_id: "other-server" }) : json(enrollment("token")));
  await f.api.ensureEnrollment(); f.api.invalidateToken();
  await assert.rejects(f.api.connection(), /changed the host identity/);
  assert.equal(f.api.enrollment.serverId, "server");
  const missing = setup(t, request => request.path.endsWith("/refresh") ? new Response(null, { status: 404 }) : json(enrollment("token")));
  await missing.api.ensureEnrollment(); missing.api.invalidateToken(); await missing.api.ensureEnrollment();
  assert.deepEqual(missing.requests.map(request => request.path.split("/").at(-1)), ["enroll", "refresh", "enroll"]);
});

test("upgrading the advertised compatibility version refreshes the existing host without replacing its pairing identity", async t => {
  const { api, state, requests } = setup(t, () => json(enrollment("refreshed-host-token")));
  // Enrollment persisted by the old 0.1.0 host has no version field.
  const existing = { accountId: "account-1", serverId: "server", environmentId: "environment", serverName: "測試主機" };
  state.set("host", "accountId", existing.accountId);
  state.set("host", "enrollment", existing);
  state.set("host", "installationId", "existing-installation");
  await api.connection();
  assert.equal(requests.length, 1);
  assert.ok(requests[0].path.endsWith("/server/refresh"));
  assert.deepEqual(requests[0].body, { server_id: "server", installation_id: "existing-installation" });
  assert.deepEqual(api.enrollment, existing);
});

test("Retry-After postpones further requests and service errors never expose response bodies", async t => {
  const { api, requests } = setup(t, () => new Response("private upstream detail", { status: 429, headers: { "Retry-After": "60" } }));
  await assert.rejects(api.pair(), error => error instanceof BackendError && !error.message.includes("private"));
  assert.ok(api.retryAt > Date.now() + 59_000);
  await assert.rejects(api.pair(), BackendError); assert.equal(requests.length, 1);
  const now = Date.parse("2026-10-01T00:00:00Z");
  assert.equal(retryAfter("2", now), now + 2000);
  assert.equal(retryAfter("Thu, 01 Oct 2026 00:01:00 GMT", now), now + 60_000);
  assert.equal(retryAfter("bad", now), 0);
});

test("backend URL restrictions prevent credential forwarding to arbitrary hosts or redirect URLs", () => {
  assert.equal(normalizeBase("https://chatgpt.com/backend-api"), "https://chatgpt.com/backend-api/");
  assert.equal(normalizeBase("http://127.0.0.1:9876/test"), "http://127.0.0.1:9876/test/");
  for (const url of ["http://chatgpt.com/", "https://chatgpt.com.evil.example/", "https://example.com/", "https://user:pass@chatgpt.com/", "https://chatgpt.com/?redirect=evil", "file:///tmp/"]) {
    assert.throws(() => normalizeBase(url));
  }
});
