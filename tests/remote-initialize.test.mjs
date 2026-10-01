import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlApi } from "../dist/remote/control-api.js";
import { fixture } from "./remote-helpers.mjs";

function connection(app, name = "desktop") {
  const messages = [];
  const peer = app.connect(name, name, message => messages.push(structuredClone(message)));
  let next = 0;
  return {
    peer, messages,
    async call(method, params = {}) {
      const id = ++next;
      await app.receive(peer, { id, method, params });
      return messages.find(message => message.id === id);
    },
    notify: method => app.receive(peer, { method }),
  };
}
const initialize = { clientInfo: { name: "Codex Desktop", version: "test" }, capabilities: { experimentalApi: true } };

function authenticated(f) {
  let credentials = { accessToken: "private-host-oauth", accountId: "host-account" };
  let checks = 0;
  f.app.options.control = new ControlApi(f.config, f.state, async () => { checks++; return credentials; },
    async () => { throw new Error("Authentication status must not enroll or contact the relay"); });
  return { get checks() { return checks; }, changeAccount() { credentials = { accessToken: "other-private-token", accountId: "other-account" }; } };
}

test("desktop can confirm authentication after initialize without an initialized notification", async t => {
  const f = await fixture(t); const auth = authenticated(f); const c = connection(f.app);
  assert.equal((await c.call("getAuthStatus")).error.code, -32600);
  assert.equal(auth.checks, 0, "uninitialized requests cannot access host credentials");
  assert.ok((await c.call("initialize", initialize)).result);
  // Matches the desktop's completeInitialization -> getPostInitializeConnectionState flow.
  assert.deepEqual((await c.call("getAuthStatus", { includeToken: false, refreshToken: false })).result,
    { authMethod: "chatgpt", authToken: null, requiresOpenaiAuth: true });
  for (const method of ["model/list", "config/read", "thread/list"]) assert.ok((await c.call(method)).result, method);
  f.app.notify(undefined, "test/ready", {});
  assert.ok(c.messages.some(message => message.method === "test/ready"), "notifications must work without initialized too");
  await c.notify("initialized"); await c.notify("initialized");
  assert.ok((await c.call("thread/list")).result, "legacy initialized notifications remain harmless");
  assert.equal((await c.call("initialize", initialize)).error.code, -32600, "a second initialize request is still invalid");
});

test("notifications cannot bypass initialization or arrive before its response", async t => {
  const { app } = await fixture(t); const c = connection(app);
  await c.notify("initialized");
  app.notify(undefined, "test/tooEarly", {});
  assert.equal(c.messages.length, 0);
  assert.equal((await c.call("initialize", { ...initialize, clientInfo: {} })).error.code, -32602);
  assert.equal((await c.call("thread/list")).error.code, -32600);
  assert.equal((await c.call("initialize", { ...initialize, capabilities: { optOutNotificationMethods: "bad" } })).error.code, -32602);
  assert.equal(c.peer.initialized, false);
  const send = c.peer.send;
  c.peer.send = response => {
    if (response.result?.userAgent) app.notify(undefined, "test/beforeResponse", {});
    send(response);
  };
  assert.ok((await c.call("initialize", { ...initialize, capabilities: { optOutNotificationMethods: ["test/muted"] } })).result);
  app.notify(undefined, "test/muted", {}); app.notify(undefined, "test/afterResponse", {});
  assert.deepEqual(c.messages.filter(message => message.method).map(message => message.method), ["test/afterResponse"]);
});

test("getAuthStatus verifies the host account but never exports tokens, even when requested", async t => {
  const f = await fixture(t); const auth = authenticated(f); const c = connection(f.app);
  await c.call("initialize", initialize);
  for (const params of [{}, { includeToken: true }, { includeToken: true, refreshToken: true }, { includeToken: null, refreshToken: null }]) {
    assert.deepEqual((await c.call("getAuthStatus", params)).result,
      { authMethod: "chatgpt", authToken: null, requiresOpenaiAuth: true });
  }
  assert.equal(auth.checks, 4);
  for (const params of [{ includeToken: "true" }, { refreshToken: 1 }]) {
    assert.equal((await c.call("getAuthStatus", params)).error.code, -32602);
  }
  assert.equal(auth.checks, 4);
  auth.changeAccount();
  assert.equal((await c.call("getAuthStatus")).error.code, -32001);
  assert.doesNotMatch(JSON.stringify(c.messages), /private-host-oauth|other-private-token|host-account|other-account/);
});

test("getAuthStatus does not invent a login when no authentication provider exists", async t => {
  const { app } = await fixture(t); const c = connection(app);
  await c.call("initialize", initialize);
  assert.deepEqual((await c.call("getAuthStatus")).result,
    { authMethod: null, authToken: null, requiresOpenaiAuth: true });
});
