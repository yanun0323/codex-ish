import assert from "node:assert/strict";
import { test } from "node:test";
import { Relay, WireState, MAX_WIRE, MAX_MESSAGE } from "../dist/remote/relay.js";

function setup() {
  const received = [], sent = [], closed = [];
  const wire = new WireState(async (stream, message) => received.push({ stream, message }), value => sent.push(JSON.parse(value)), stream => closed.push(stream));
  const frame = (type, params = {}) => ({ client_id: "phone", stream_id: "stream", type, ...params });
  const receive = (type, params = {}) => wire.receive(JSON.stringify(frame(type, params)));
  const initialize = () => receive("client_message", { seq_id: 1, message: { id: 1, method: "initialize" }, cursor: "start" });
  return { wire, received, sent, closed, frame, receive, initialize };
}

test("v3 envelopes isolate clients, deduplicate delivered input, and commit cursors after delivery", async () => {
  const f = setup(); await f.initialize();
  await f.receive("client_message", { seq_id: 2, message: { id: 2, method: "turn/start" }, cursor: "after-turn" });
  await f.receive("client_message", { seq_id: 2, message: { id: 2, method: "turn/start" }, cursor: "replay" });
  assert.equal(f.received.length, 2);
  assert.equal(f.wire.cursor, "replay");
  await f.wire.receive(JSON.stringify({ client_id: "Mac", stream_id: "same-name", type: "client_message", seq_id: 1, message: { id: 1, method: "initialize" } }));
  assert.equal(f.received.length, 3);
  assert.notEqual(f.received[0].stream.key, f.received[2].stream.key);
});

test("failed delivery never commits the sequence or subscription cursor", async () => {
  let fail = true, count = 0;
  const wire = new WireState(async () => { count++; if (fail) throw new Error("backpressure"); }, () => {}, () => {});
  const value = JSON.stringify({ client_id: "c", stream_id: "s", type: "client_message", seq_id: 1, cursor: "cursor", message: { method: "initialize", id: 1 } });
  await assert.rejects(wire.receive(value), /backpressure/);
  assert.equal(wire.cursor, undefined);
  fail = false; await wire.receive(value);
  assert.equal(count, 2); assert.equal(wire.cursor, "cursor");
});

test("outbound replay retains only envelopes not acknowledged for their own stream", async () => {
  const f = setup(); await f.initialize();
  const stream = f.received[0].stream;
  f.wire.send(stream, { id: 1, result: "one" }); f.wire.send(stream, { id: 2, result: "two" });
  const original = [...f.sent]; f.sent.length = 0;
  f.wire.replay(); assert.deepEqual(f.sent, original);
  await f.receive("ack", { seq_id: original[0].seq_id, cursor: "acked-first" });
  f.sent.length = 0; f.wire.replay(); assert.deepEqual(f.sent, [original[1]]);
  await f.receive("ack", { seq_id: original[1].seq_id });
  assert.equal(f.wire.bufferedBytes, 0);
});

test("large Unicode messages are chunked within the wire limit and partially acknowledged chunks resume", async () => {
  const f = setup(); await f.initialize();
  const message = { id: 2, result: "中文😀".repeat(80_000) };
  f.wire.send(f.received[0].stream, message);
  assert.ok(f.sent.length > 2);
  assert.ok(f.sent.every(frame => Buffer.byteLength(JSON.stringify(frame)) <= MAX_WIRE));
  assert.ok(f.sent.every(frame => frame.type === "server_message_chunk"));
  const decoded = Buffer.concat(f.sent.map(frame => Buffer.from(frame.message_chunk_base64, "base64")));
  assert.equal(decoded.length, f.sent[0].message_size_bytes);
  assert.deepEqual(JSON.parse(decoded), message);
  const original = [...f.sent];
  await f.receive("ack", { seq_id: original[0].seq_id, segment_id: 1 });
  f.sent.length = 0; f.wire.replay(); assert.deepEqual(f.sent, original.slice(2));
  await f.receive("ack", { seq_id: original[0].seq_id }); assert.equal(f.wire.bufferedBytes, 0);
});

test("incoming chunks reconstruct UTF-8 only after all bytes arrive and ignore replayed chunks", async () => {
  const f = setup(); await f.initialize();
  const message = { id: 2, method: "turn/start", params: { text: "中文😀" } };
  const bytes = Buffer.from(JSON.stringify(message));
  const cut = bytes.length - 7; // Deliberately splits a multibyte character or JSON suffix.
  const chunks = [bytes.subarray(0, cut), bytes.subarray(cut)];
  const chunk = index => ({ seq_id: 2, segment_id: index, segment_count: 2, message_size_bytes: bytes.length,
    message_chunk_base64: chunks[index].toString("base64"), cursor: `chunk-${index}` });
  await f.receive("client_message_chunk", chunk(0));
  assert.equal(f.wire.cursor, "start"); assert.equal(f.received.length, 1);
  await f.receive("client_message_chunk", chunk(0));
  await f.receive("client_message_chunk", chunk(1));
  assert.deepEqual(f.received[1].message, message); assert.equal(f.wire.cursor, "chunk-1");
  await f.receive("client_message_chunk", chunk(0)); await f.receive("client_message_chunk", chunk(1));
  assert.equal(f.received.length, 2);
});

test("invalid, out-of-order, and oversized chunks fail without committing an unprocessed cursor", async () => {
  const f = setup(); await f.initialize();
  const base = { seq_id: 2, segment_id: 0, segment_count: 2, message_size_bytes: 10, message_chunk_base64: "e30=", cursor: "bad" };
  for (const invalid of [{ segment_count: 1025 }, { segment_id: 2 }, { segment_id: 1 }, { message_size_bytes: MAX_MESSAGE + 1 },
    { message_chunk_base64: "not base64" }, { seq_id: -1 }, { seq_id: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(f.receive("client_message_chunk", { ...base, ...invalid }));
    assert.equal(f.wire.cursor, "start");
  }
  await assert.rejects(f.wire.receive(" ".repeat(MAX_WIRE + 1)), /Oversized/);
});

test("client close and revoke remove replay data without affecting another device", async () => {
  const f = setup(); await f.initialize();
  const phone = f.received[0].stream; f.wire.send(phone, { result: "phone" });
  await f.wire.receive(JSON.stringify({ client_id: "mac", stream_id: "mac", type: "client_message", message: { id: 1, method: "initialize" } }));
  const mac = f.received[1].stream; f.wire.send(mac, { result: "mac" });
  f.wire.revoke("phone");
  f.sent.length = 0; f.wire.replay(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].client_id, "mac");
  assert.equal(f.closed[0].clientId, "phone");
  await f.wire.receive(JSON.stringify({ client_id: "mac", stream_id: "mac", type: "client_closed" }));
  assert.equal(f.wire.bufferedBytes, 0);
});

test("legacy streams are assigned only at initialize; unknown clients are not allowed to issue work", async () => {
  const f = setup();
  await f.wire.receive(JSON.stringify({ client_id: "legacy", type: "client_message", message: { id: 1, method: "turn/start" } }));
  assert.equal(f.received.length, 0);
  await f.wire.receive(JSON.stringify({ client_id: "legacy", type: "client_message", message: { id: 1, method: "initialize" } }));
  await f.wire.receive(JSON.stringify({ client_id: "legacy", type: "client_message", message: { id: 2, method: "thread/list" } }));
  assert.equal(f.received.length, 2);
  assert.equal(f.received[0].stream.key, f.received[1].stream.key);
});

test("pings do not initialize unknown clients or allow work without an initialize request", async () => {
  const f = setup();
  await f.receive("ping"); await f.receive("ping");
  assert.deepEqual(f.sent.map(frame => frame.status), ["unknown", "unknown"]);
  await f.receive("client_message", { seq_id: 1, message: { id: 1, method: "turn/start" } });
  assert.equal(f.received.length, 0);
  await f.initialize(); await f.receive("ping");
  assert.equal(f.sent.at(-1).status, "active");
});

test("revoked devices remain blocked until a trusted grant refresh authorizes them again", async () => {
  const delivered = [];
  const relay = new Relay({}, async (stream, message) => delivered.push({ stream, message }), () => {});
  const initialize = (client, stream) => relay.wire.receive(JSON.stringify({ client_id: client, stream_id: stream,
    type: "client_message", seq_id: 1, message: { id: 1, method: "initialize" } }));
  await initialize("phone", "one"); relay.revoke("phone"); relay.revoke("other");
  await initialize("phone", "two"); assert.equal(delivered.length, 1);
  relay.restoreGrantedClients(["phone"]);
  await initialize("phone", "three"); await initialize("other", "one");
  assert.equal(delivered.length, 2); assert.equal(delivered.at(-1).stream.clientId, "phone");
});

test("a stalled client cannot grow unbounded replay buffers", async () => {
  const f = setup(); await f.initialize(); const stream = f.received[0].stream;
  let overflow = false;
  for (let count = 0; count < 5000; count++) {
    try { f.wire.send(stream, { method: "delta", params: { delta: "x".repeat(10_000) } }); }
    catch { overflow = true; break; }
  }
  assert.equal(overflow, true); assert.equal(f.wire.bufferedBytes, 0); assert.equal(f.closed.length, 1);
});
