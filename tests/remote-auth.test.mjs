import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlApi, BackendError, enrollmentPlatform, retryAfter } from "../dist/remote/control-api.js";
import { State } from "../dist/remote/state.js";
import { normalizeBase } from "../dist/remote/config.js";

function setup(t, respond) {
  const state = new State(":memory:"); t.after(() => state.close());
  const requests = [];
  let credentials = { accessToken: "chatgpt-oauth", accountId: "account-1" };
  const config = { baseUrl: "http://127.0.0.1/backend-api/", hostName: "測試主機" };
  const createApi = () => new ControlApi(config, state, async () => credentials, async (url, options) => {
    const request = { path: url.pathname, query: url.search, ...options, body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request); return respond(request, requests.length);
  });
  return { api: createApi(), createApi, state, config, requests, setIdentity: value => { credentials = value; } };
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

const savedEnrollment = { accountId: "account-1", serverId: "server", environmentId: "environment", serverName: "測試主機" };
const currentMetadata = () => ({ appServerVersion: "0.141.0", ...enrollmentPlatform() });
function saveEnrollment(f, metadata = {}) {
  f.state.set("host", "accountId", savedEnrollment.accountId);
  f.state.set("host", "installationId", "existing-installation");
  f.state.set("host", "enrollment", { ...savedEnrollment, ...metadata });
}

test("legacy enrollment republishes metadata once with the existing installation and refreshes after restart", async t => {
  const f = setup(t, () => json(enrollment("updated-host-token")));
  saveEnrollment(f);
  const unrelated = { clients: ["phone", "desktop"] }; f.state.set("fixture", "unrelated", unrelated);
  await Promise.all([f.api.connection(), f.api.ensureEnrollment(), f.api.connection()]);
  assert.equal(f.requests.length, 1);
  assert.ok(f.requests[0].path.endsWith("/server/enroll"), "refresh alone does not send updated metadata");
  assert.deepEqual(f.requests[0].body, { name: savedEnrollment.serverName, ...enrollmentPlatform(),
    app_server_version: "0.141.0", installation_id: "existing-installation" });
  assert.equal(f.requests[0].headers["x-codex-installation-id"], "existing-installation");
  assert.equal(f.requests[0].headers.Authorization, "Bearer chatgpt-oauth");
  assert.deepEqual(f.api.enrollment, { ...savedEnrollment, ...currentMetadata() });
  assert.deepEqual(f.state.get("fixture", "unrelated"), unrelated);
  assert.equal(f.state.installationId(), "existing-installation");
  assert.doesNotMatch(JSON.stringify(f.state.list("host")), /updated-host-token|chatgpt-oauth/);
  const restarted = f.createApi();
  await restarted.connection();
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests[1].path.endsWith("/server/refresh"));
  assert.deepEqual(f.requests[1].body, { server_id: "server", installation_id: "existing-installation" });
});

test("changed version, platform, architecture, or name republishes metadata even with a cached token", async t => {
  for (const changed of [{ appServerVersion: "0.1.0" }, { os: "old-os" }, { arch: "old-arch" }, { serverName: "old-name" }]) {
    const f = setup(t, () => json(enrollment("token")));
    await f.api.connection();
    const previous = { ...f.api.enrollment, ...changed }; f.state.set("host", "enrollment", previous);
    const installation = f.state.installationId();
    await f.api.connection();
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests[1].path.endsWith("/server/enroll"));
    assert.equal(f.requests[1].body.installation_id, installation);
    assert.deepEqual(f.api.enrollment, { ...savedEnrollment, ...currentMetadata() });
    await f.api.connection(); assert.equal(f.requests.length, 2);
  }
});

test("metadata publication failures keep saved registration and allow a later retry without resetting identity", async t => {
  for (const status of [401, 403, 404, 409, 429, 500]) {
    const f = setup(t, (_request, count) => count === 1 ? new Response("private response", { status }) : json(enrollment("good-token")));
    saveEnrollment(f, { appServerVersion: "0.1.0" }); const before = f.api.enrollment;
    await assert.rejects(f.api.connection(), error => error instanceof BackendError && error.status === status && !error.message.includes("private"));
    assert.deepEqual(f.api.enrollment, before); assert.equal(f.requests.length, 1);
    assert.equal(f.state.installationId(), "existing-installation");
    await f.api.connection();
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests.every(request => request.path.endsWith("/server/enroll")));
    assert.ok(f.requests.every(request => request.body.installation_id === "existing-installation"));
    assert.deepEqual(f.api.enrollment, { ...savedEnrollment, ...currentMetadata() });
  }
});

test("metadata upgrades reject a replacement server or environment without saving it or repeating enrollment", async t => {
  for (const changed of [{ server_id: "replacement-server" }, { environment_id: "replacement-environment" }]) {
    const f = setup(t, () => json({ ...enrollment("replacement-secret"), ...changed }));
    saveEnrollment(f);
    await assert.rejects(f.api.connection(), /changed the host identity/);
    assert.deepEqual(f.api.enrollment, savedEnrollment);
    assert.equal(f.state.installationId(), "existing-installation");
    await assert.rejects(f.api.connection(), /changed the host identity/);
    f.api.invalidateToken();
    await assert.rejects(f.api.pair(), /changed the host identity/);
    assert.equal(f.requests.length, 1, "do not repeatedly register when the service returned another identity");
    assert.doesNotMatch(JSON.stringify(f.state.list("host")), /replacement/);
  }
});

test("invalid metadata responses do not mark an upgrade complete", async t => {
  for (const changed of [{ server_id: "" }, { environment_id: "" }, { remote_control_token: "" }, { expires_at: "invalid" }, { expires_at: "2000-01-01T00:00:00Z" }]) {
    const f = setup(t, (_request, count) => json(count === 1 ? { ...enrollment("secret"), ...changed } : enrollment("good")));
    saveEnrollment(f);
    await assert.rejects(f.api.connection(), /invalid enrollment/);
    assert.deepEqual(f.api.enrollment, savedEnrollment);
    await f.api.connection();
    assert.deepEqual(f.api.enrollment, { ...savedEnrollment, ...currentMetadata() });
  }
});

test("metadata updates cannot publish credentials if the login changes during the request", async t => {
  let finish; const waiting = new Promise(resolve => { finish = resolve; });
  const f = setup(t, async () => { await waiting; return json(enrollment("old-account-secret")); });
  saveEnrollment(f);
  const request = f.api.connection();
  while (f.requests.length === 0) await new Promise(resolve => setImmediate(resolve));
  f.setIdentity({ accessToken: "other-oauth", accountId: "account-2" }); finish();
  await assert.rejects(request, /another ChatGPT account/);
  assert.deepEqual(f.api.enrollment, savedEnrollment);
  await assert.rejects(f.api.connection(), /another ChatGPT account/);
  assert.equal(f.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(f.state.list("host")), /secret|other-oauth/);
});

test("saved registration from another account is rejected before publishing metadata", async t => {
  const f = setup(t, () => { throw new Error("must not request"); });
  saveEnrollment(f, { accountId: "account-other" });
  await assert.rejects(f.api.connection(), /another ChatGPT account/);
  assert.equal(f.requests.length, 0);
});

test("enrollment platform names match Codex's Rust platform names", () => {
  assert.deepEqual(enrollmentPlatform("darwin", "arm64"), { os: "macos", arch: "aarch64" });
  assert.deepEqual(enrollmentPlatform("darwin", "x64"), { os: "macos", arch: "x86_64" });
  assert.deepEqual(enrollmentPlatform("win32", "ia32"), { os: "windows", arch: "x86" });
  assert.deepEqual(enrollmentPlatform("linux", "x64"), { os: "linux", arch: "x86_64" });
  assert.deepEqual(enrollmentPlatform("linux", "arm"), { os: "linux", arch: "arm" });
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
