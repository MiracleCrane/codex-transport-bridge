import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { createTransportBridge } from './bridge.mjs';

const path = '/backend-api/codex/responses';
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise, ms, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} did not settle within ${ms} ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function until(check, ms) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > ms) assert.fail('Condition did not settle');
    await delay(5);
  }
}
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function fixture(t, onConnection, options = {}) {
  const remote = http.createServer();
  const peers = new WebSocketServer({ server: remote, autoPong: false, perMessageDeflate: false });
  let connectionNumber = 0;
  peers.on('connection', ws => {
    ws.on('error', () => {});
    onConnection(ws, ++connectionNumber);
  });
  const remotePort = await listen(remote);
  const events = [];
  const bridge = createTransportBridge({
    upstreamOrigin: `http://127.0.0.1:${remotePort}`, allowUnauthenticated: true,
    upstreamHeartbeatIntervalMs: 60, upstreamAckTimeoutMs: 120,
    closeTimeoutMs: 60, closeDrainTimeoutMs: 1500, traceTimings: true,
    onEvent: event => events.push(event), ...options,
  });
  const port = await listen(bridge.server);
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    for (const peer of peers.clients) peer.terminate();
    await bridge.close();
    await new Promise(resolve => bridge.server.close(resolve));
    await new Promise(resolve => peers.close(resolve));
    await new Promise(resolve => remote.close(resolve));
  });
  async function connect() {
    const client = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    client.on('error', () => {});
    clients.push(client);
    await once(client, 'open');
    return client;
  }
  return { bridge, port, remotePort, events, connect };
}

for (const bytes of [19, 128 * 1024, 128 * 1024 + 17]) {
  test(`silent transport after a ${bytes}-byte request is detected without replay`, { timeout: 4000 }, async t => {
    let received = 0;
    const handed = deferred();
    const f = await fixture(t, peer => {
      let blackholed = false;
      peer.on('ping', data => { if (!blackholed) peer.pong(data); });
      peer.on('message', data => {
        received++;
        assert.equal(data.length, bytes);
        blackholed = true;
        handed.resolve();
      });
    });
    const client = await f.connect();
    const closed = new Promise(resolve => client.once('close', (code, reason) => resolve({ code, reason })));
    client.send(Buffer.alloc(bytes, 120));
    await bounded(handed.promise, 1000, 'Request upload');
    const result = await bounded(closed, 650, 'Unresponsive upstream detection');
    assert.equal(result.code, 1011);
    assert.equal(received, 1, 'The bridge must not replay the model request');
    assert.equal(f.bridge.stats().websocket.upstreamLivenessTimeouts, 1);
    assert.ok(f.events.some(e => e.event === 'upstream-liveness-timeout' && e.phase === 'awaiting_pong'));
  });
}

test('long model silence stays connected while matching Pongs continue', { timeout: 4000 }, async t => {
  let pings = 0;
  const f = await fixture(t, peer => {
    peer.on('ping', data => { pings++; peer.pong(data); });
    peer.once('message', () => {
      const timer = setTimeout(() => peer.send('{"type":"response.completed"}'), 650);
      peer.once('close', () => clearTimeout(timer));
    });
  });
  const client = await f.connect();
  const response = once(client, 'message');
  client.send('a short request');
  const [data] = await bounded(response, 1500, 'Slow but healthy model');
  assert.equal(data.toString(), '{"type":"response.completed"}');
  assert.equal(client.readyState, WebSocket.OPEN);
  assert.ok(pings >= 3, 'Several transport probes must pass during model silence');
  assert.equal(f.bridge.stats().websocket.upstreamLivenessTimeouts, 0);
});

test('a blocked Ping write is bounded even before its write callback runs', { timeout: 3000 }, async t => {
  const f = await fixture(t, () => {});
  const original = WebSocket.prototype.ping;
  WebSocket.prototype.ping = function(...args) {
    if (!this._isServer && this._socket?.remotePort === f.remotePort) return;
    return original.apply(this, args);
  };
  t.after(() => { WebSocket.prototype.ping = original; });
  const client = await f.connect();
  const closed = once(client, 'close'); client.send('short');
  const [code] = await bounded(closed, 650, 'Blocked Ping write');
  assert.equal(code, 1011);
  assert.ok(f.events.some(e => e.event === 'upstream-liveness-timeout' && e.phase === 'write_pending'));
  await until(() => f.bridge.stats().websocket.activeConnections === 0, 500);
});

test('slow upload and heartbeat share one pending confirmation without interrupting data', { timeout: 4000 }, async t => {
  let pending = 0;
  let peakPending = 0;
  let messages = 0;
  const f = await fixture(t, peer => {
    const timers = new Set();
    peer.on('ping', data => {
      pending++; peakPending = Math.max(peakPending, pending);
      const timer = setTimeout(() => {
        timers.delete(timer); pending--;
        if (peer.readyState === WebSocket.OPEN) peer.pong(data);
      }, 80);
      timers.add(timer);
    });
    peer.once('close', () => { for (const timer of timers) clearTimeout(timer); });
    peer.on('message', (data, binary) => { messages++; peer.send(data, { binary }); });
  }, { fragmentBytes: 1024, upstreamAckWindowBytes: 4096,
    upstreamHeartbeatIntervalMs: 50, upstreamAckTimeoutMs: 300 });
  const client = await f.connect();
  const body = Buffer.alloc(32 * 1024 + 17, 120);
  const response = once(client, 'message'); client.send(body);
  assert.deepEqual((await bounded(response, 2000, 'Paced upload'))[0], body);
  assert.equal(messages, 1);
  assert.equal(peakPending, 1, 'Upload and heartbeat must not start competing nonce probes');
  const stats = f.bridge.stats().websocket;
  assert.ok(stats.upstreamLivenessChecks >= 1);
  assert.equal(stats.upstreamLivenessTimeouts, 0);
  assert.equal(stats.upstreamAckTimeouts, 0);
});

test('an older heartbeat Pong cannot acknowledge bytes uploaded after its Ping', { timeout: 4000 }, async t => {
  const firstPing = deferred();
  const pingPositions = [];
  const f = await fixture(t, peer => {
    const timers = new Set();
    peer.on('ping', data => {
      // With compression disabled, this is the byte position of the unfinished
      // logical message preceding this control frame at the remote WS reader.
      pingPositions.push(peer._receiver._messageLength);
      if (pingPositions.length === 1) firstPing.resolve();
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (peer.readyState === WebSocket.OPEN) peer.pong(data);
      }, pingPositions.length === 1 ? 130 : 10);
      timers.add(timer);
    });
    peer.once('close', () => { for (const timer of timers) clearTimeout(timer); });
    peer.once('message', data => peer.send(data));
  }, { fragmentBytes: 1024, upstreamAckWindowBytes: 4096,
    upstreamHeartbeatIntervalMs: 50, upstreamAckTimeoutMs: 350 });
  const client = await f.connect();
  await bounded(firstPing.promise, 500, 'Initial idle heartbeat');
  const body = Buffer.alloc(8193, 120);
  const response = once(client, 'message'); client.send(body);
  assert.deepEqual((await bounded(response, 1800, 'Upload after heartbeat'))[0], body);
  assert.deepEqual(pingPositions.slice(0, 3), [0, 4096, 8192],
    'Each upload window must be confirmed by a Ping sent after those bytes');
});

test('a reused connection is checked after its next short request', { timeout: 4000 }, async t => {
  let requests = 0;
  const f = await fixture(t, peer => {
    peer.on('ping', data => { if (requests < 2) peer.pong(data); });
    peer.on('message', () => { if (++requests === 1) peer.send('first-completed'); });
  });
  const client = await f.connect();
  const first = once(client, 'message');
  client.send('first'); await first;
  await delay(150);
  const closed = once(client, 'close');
  client.send('second');
  const [code] = await bounded(closed, 650, 'Reused connection detection');
  assert.equal(code, 1011);
  assert.equal(requests, 2);
});

test('caller cancellation clears the probe and cannot close another connection', { timeout: 4000 }, async t => {
  const f = await fixture(t, (peer, index) => {
    peer.on('ping', data => { if (index > 1) peer.pong(data); });
    peer.on('message', () => { if (index > 1) peer.send('healthy'); });
  }, { upstreamAckTimeoutMs: 250 });
  const first = await f.connect();
  first.send('short');
  await until(() => f.events.some(e => e.event === 'upstream-probe-written'), 500);
  const firstClosed = once(first, 'close'); first.close(); await firstClosed;
  const second = await f.connect();
  await delay(400);
  const response = once(second, 'message'); second.send('next');
  assert.equal((await response)[0].toString(), 'healthy');
  assert.equal(f.bridge.stats().websocket.upstreamLivenessTimeouts, 0);
});

test('liveness failure drains already received terminal events before closing', { timeout: 5000 }, async t => {
  const expected = Array.from({ length: 90 }, (_, n) => JSON.stringify({ type: 'response.output_text.delta', n }));
  expected.push('{"type":"response.completed"}');
  const f = await fixture(t, peer => {
    peer.once('message', () => {
      peer._socket.cork();
      for (const message of expected) peer.send(message);
      peer._socket.uncork();
    });
  });
  const original = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data, options, callback) {
    if (this._isServer && this._socket?.localPort === f.port && typeof callback === 'function') {
      return original.call(this, data, options, error => setTimeout(() => callback(error), 5));
    }
    return original.call(this, data, options, callback);
  };
  t.after(() => { WebSocket.prototype.send = original; });
  const client = await f.connect();
  const received = [];
  client.on('message', data => received.push(data.toString()));
  const closed = once(client, 'close'); client.send('start');
  const [code] = await bounded(closed, 2500, 'Queued response drain');
  assert.equal(code, 1011);
  assert.deepEqual(received, expected);
  assert.equal(f.bridge.stats().websocket.closeDrainTimeouts, 0);
});
