import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { Relay } from "../dist/remote/relay.js";
import { fixture, input, eventually } from "./remote-helpers.mjs";

test("two clients share a session over a real v3 WebSocket; reconnect replays updates without rerunning input", async t => {
  const f = await fixture(t);
  const backend = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(backend, "listening");
  const messages = []; const connections = []; let socket; let ack = true;
  backend.on("connection", (current, request) => {
    socket = current; connections.push(request.headers);
    current.on("message", data => {
      const frame = JSON.parse(data.toString()); messages.push(frame);
      if (ack) current.send(JSON.stringify({ client_id: frame.client_id, stream_id: frame.stream_id,
        type: "ack", seq_id: frame.seq_id, ...(frame.segment_id == null ? {} : { segment_id: frame.segment_id }) }));
    });
  });
  const api = { enrollment: { serverId: "test-host" }, retryAt: 0,
    connection: async () => ({ url: `ws://127.0.0.1:${backend.address().port}`, headers: { "x-codex-protocol-version": "3" } }),
    identity: async () => ({ accountId: "fake" }), invalidateToken() {} };
  let relay;
  relay = new Relay(api, async (stream, message) => {
    const client = f.app.connect(stream.key, stream.clientId, value => relay.wire.send(stream, value));
    await f.app.receive(client, message);
  }, stream => f.app.disconnect(stream.key));
  f.cleanup.push(async () => { await relay.stop(); for (const client of backend.clients) client.terminate(); await new Promise(resolve => backend.close(resolve)); });
  relay.start(); await eventually(() => relay.status === "connected");
  const seq = { phone: 0, mac: 0 };
  let cursor = 0;
  const send = (client, message) => socket.send(JSON.stringify({ client_id: client, stream_id: `${client}-stream`,
    type: "client_message", seq_id: ++seq[client], cursor: `cursor-${++cursor}`, message }));
  const call = async (client, id, method, params = {}) => {
    const before = messages.length; send(client, { id, method, params });
    return eventually(() => messages.slice(before).find(frame => frame.client_id === client && frame.message?.id === id)?.message);
  };
  for (const client of ["phone", "mac"]) {
    const result = await call(client, 1, "initialize", { clientInfo: { name: client, version: "1" } }); assert.ok(result.result);
    send(client, { method: "initialized" });
  }
  const created = await call("phone", 2, "thread/start", { cwd: f.config.userHome }); const id = created.result.thread.id;
  await call("mac", 2, "thread/resume", { threadId: id });
  const params = { threadId: id, input: input("from phone"), clientUserMessageId: "stable-phone-message" };
  const [a, b] = await Promise.all([call("phone", 3, "turn/start", params), call("mac", 3, "turn/start", { threadId: id, input: input("from Mac") })]);
  assert.equal(a.result.turn.id, b.result.turn.id); assert.equal(f.mock.backends.length, 1);
  f.mock.backends[0].answer("shared output");
  for (const client of ["phone", "mac"]) await eventually(() => messages.some(frame => frame.client_id === client && frame.message?.method === "turn/completed"));
  await eventually(() => relay.wire.bufferedBytes === 0);

  ack = false;
  const prior = messages.length;
  relay.wire.send({ clientId: "phone", streamId: "phone-stream", key: JSON.stringify(["phone", "phone-stream"]) }, { method: "test/unacknowledged", params: {} });
  await eventually(() => messages.length > prior);
  const replayed = messages.at(-1);
  socket.terminate();
  await eventually(() => connections.length === 2, 5000);
  await eventually(() => messages.filter(frame => JSON.stringify(frame) === JSON.stringify(replayed)).length === 2);
  assert.ok(connections[1]["x-codex-subscribe-cursor"].startsWith("cursor-"));
  ack = true;
  await call("phone", 4, "turn/start", params);
  assert.equal(f.mock.backends[0].sends.length, 2, "the original phone message and Mac follow-up ran once each");
  const history = await call("mac", 4, "thread/read", { threadId: id, includeTurns: true });
  assert.equal(history.result.thread.turns[0].items.at(-1).text, "shared output");
});
