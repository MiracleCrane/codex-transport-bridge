import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { connect as connectTcp, createServer as createTcpServer } from 'node:net';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { attachWebSocketBridge, sendFragmentedMessage } from './ws-transport.mjs';

const PATH = '/backend-api/codex/responses';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function shutdownServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function upstreamFixture(t, onConnection, options = {}) {
  const server = createServer((_request, response) => { response.writeHead(404).end(); });
  const wss = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024, ...options });
  wss.on('connection', (socket, request) => {
    socket.on('error', () => {});
    onConnection(socket, request);
  });
  const port = await listen(server);
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await shutdownServer(server);
  });
  return { server, wss, port, origin: `http://127.0.0.1:${port}`, url: `ws://127.0.0.1:${port}${PATH}` };
}

async function bridgeFixture(t, upstreamOrigin, options = {}) {
  const server = createServer((_request, response) => { response.writeHead(404).end(); });
  const bridge = attachWebSocketBridge(server, {
    upstreamOrigin,
    allowUnauthenticated: true,
    sessionHeaderNames: ['x-client-request-id'],
    closeTimeoutMs: 150,
    ...options,
  });
  const port = await listen(server);
  t.after(async () => { await bridge.close(); await shutdownServer(server); });
  return { server, bridge, url: `ws://127.0.0.1:${port}${PATH}` };
}

async function connect(url, options = {}, protocols = []) {
  const socket = new WebSocket(url, protocols, options);
  socket.on('error', () => {});
  await once(socket, 'open');
  return socket;
}

function nextMessage(socket) {
  return once(socket, 'message').then(([data, binary]) => ({ data: Buffer.from(data), binary }));
}

async function rejectedStatus(url, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.on('error', () => {});
    socket.once('open', () => { socket.terminate(); reject(new Error('Unexpected accepted upgrade')); });
    socket.once('unexpected-response', (request, response) => {
      const status = response.statusCode;
      response.resume();
      request.destroy();
      resolve(status);
    });
  });
}

for (const count of [20, 100, 1000]) {
  test(`ordinary downstream burst preserves all ${count} events in order`, { timeout: 8_000 }, async (t) => {
    const expected = Array.from({ length: count }, (_, sequence_number) => JSON.stringify({
      type: 'response.output_text.delta', sequence_number, delta: 'ordinary small event',
    }));
    const upstream = await upstreamFixture(t, socket => {
      socket.once('message', () => {
        socket._socket.cork();
        for (const body of expected) socket.send(body);
        socket._socket.uncork();
      });
    });
    const local = await bridgeFixture(t, upstream.origin);
    const client = await connect(local.url);
    t.after(() => client.terminate());
    const received = [];
    await new Promise((resolve, reject) => {
      client.on('message', data => {
        received.push(data.toString());
        if (received.length === count) resolve();
      });
      client.once('close', (code, reason) => reject(new Error(`Unexpected close: ${code} ${reason}`)));
      client.send('start-local-fixture');
    });
    assert.deepEqual(received, expected);
    assert.equal(local.bridge.stats().queueRejected, 0);
  });
}

test('bridge preserves UTF-8, binary, empty messages, path and handshake metadata', { timeout: 8_000 }, async (t) => {
  let observedRequest;
  let upstreamCompression;
  const upstream = await upstreamFixture(t, (socket, request) => {
    observedRequest = request;
    upstreamCompression = socket.extensions;
    socket.on('message', (data, binary) => socket.send(data, { binary }));
  }, { perMessageDeflate: true });
  upstream.wss.on('headers', (headers) => {
    headers.push('x-codex-turn-state: local-test-state');
    headers.push('openai-model: local-test-model');
  });
  const local = await bridgeFixture(t, upstream.origin);
  let handshake;
  const client = new WebSocket(`${local.url}?mode=test`, ['local-test-protocol'], {
    headers: { 'x-client-request-id': 'test-session-1', authorization: 'Bearer local-test-only' },
  });
  client.on('error', () => {});
  client.on('upgrade', (response) => { handshake = response.headers; });
  t.after(() => client.terminate());
  await once(client, 'open');
  assert.equal(client.protocol, 'local-test-protocol');
  assert.equal(upstreamCompression, 'permessage-deflate');
  assert.equal(handshake['x-codex-turn-state'], 'local-test-state');
  assert.equal(handshake['openai-model'], 'local-test-model');
  assert.equal(observedRequest.url, `${PATH}?mode=test`);
  assert.equal(observedRequest.headers.authorization, 'Bearer local-test-only');
  assert.equal(observedRequest.headers['x-client-request-id'], 'test-session-1');

  const unicode = Buffer.from(`${'a'.repeat(16383)}😀中𠮷${'💙文字'.repeat(20_000)}`);
  for (const [body, binary] of [[unicode, false], [randomBytes(90_000), true], [Buffer.alloc(0), false]]) {
    const received = nextMessage(client);
    client.send(body, { binary });
    const message = await received;
    assert.equal(message.binary, binary);
    assert.deepEqual(message.data, body);
  }
  assert.equal(local.bridge.stats().upstreamMessages, 3);
  assert.ok(local.bridge.stats().upstreamFragments > 10);
  assert.ok(local.bridge.stats().upstreamAcks >= 2, 'Pong credit must carry across message boundaries');
});

/** A real TCP connection with a slow, bounded writable side and an unblocked reader. */
class ThrottledDuplex extends Duplex {
  constructor(socket, { chunkBytes = 2048, delayMs = 3 } = {}) {
    super({ writableHighWaterMark: 16 * 1024, readableHighWaterMark: 16 * 1024 });
    this.socket = socket;
    this.chunkBytes = chunkBytes;
    this.delayMs = delayMs;
    socket.on('connect', () => this.emit('connect'));
    socket.on('data', (data) => { if (!this.push(data)) socket.pause(); });
    socket.on('end', () => this.push(null));
    socket.on('error', (error) => this.destroy(error));
    socket.on('close', () => { if (!this.destroyed) this.destroy(); });
  }
  get connecting() { return this.socket.connecting; }
  setTimeout(...args) { this.socket.setTimeout(...args); return this; }
  setNoDelay(...args) { this.socket.setNoDelay(...args); return this; }
  setKeepAlive(...args) { this.socket.setKeepAlive(...args); return this; }
  _read() { this.socket.resume(); }
  _write(chunk, _encoding, callback) {
    let offset = 0;
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      this.pendingWrite = null;
      callback(error);
    };
    this.pendingWrite = finish;
    const writeNext = () => {
      if (this.destroyed) return finish(new Error('Throttle closed'));
      const end = Math.min(offset + this.chunkBytes, chunk.length);
      this.socket.write(chunk.subarray(offset, end), (error) => {
        if (error) return finish(error);
        offset = end;
        if (offset === chunk.length) return finish();
        this.timer = setTimeout(writeNext, this.delayMs);
      });
    };
    // Do not impose a timer quantum on tiny WS headers and control frames. That
    // would make 25 ms Pings exceed the fixture's artificial control throughput.
    if (chunk.length < 128) writeNext();
    else this.timer = setTimeout(writeNext, this.delayMs);
  }
  _final(callback) { this.socket.end(callback); }
  _destroy(error, callback) {
    clearTimeout(this.timer);
    this.pendingWrite?.(error ?? new Error('Throttle closed'));
    this.socket.destroy();
    callback(error);
  }
}

test('slow fragmented upload answers server Pings throughout and preserves exact text bytes', { timeout: 10_000 }, async (t) => {
  const pingPeriodMs = 25;
  const pongDelays = [];
  let uploadComplete = false;
  let pongsDuringUpload = 0;
  const upstream = await upstreamFixture(t, (socket) => {
    let sequence = 0;
    const sent = new Map();
    const timer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const key = String(++sequence);
      sent.set(key, performance.now());
      socket.ping(key);
    }, pingPeriodMs);
    socket.on('pong', (data) => {
      const key = data.toString();
      if (!sent.has(key)) return;
      pongDelays.push(performance.now() - sent.get(key));
      sent.delete(key);
      if (!uploadComplete) pongsDuringUpload += 1;
    });
    socket.on('message', (data, binary) => {
      uploadComplete = true;
      socket.send(data, { binary });
    });
    socket.on('close', () => clearInterval(timer));
  });
  const client = await connect(upstream.url, {
    perMessageDeflate: false,
    createConnection: () => new ThrottledDuplex(connectTcp(upstream.port, '127.0.0.1')),
  });
  t.after(() => client.terminate());
  const payload = Buffer.from(`${'a'.repeat(16382)}😀中🌉`.repeat(24));
  const received = nextMessage(client);
  const started = performance.now();
  await sendFragmentedMessage(client, payload, { binary: false, compress: false });
  const elapsed = performance.now() - started;
  const message = await received;
  assert.deepEqual(message.data, payload);
  assert.equal(message.binary, false);
  assert.ok(elapsed > pingPeriodMs * 10, `Upload was not slow enough: ${elapsed}`);
  assert.ok(pongsDuringUpload >= 8, `Only ${pongsDuringUpload} Pongs during upload`);
  assert.ok(Math.max(...pongDelays) < 250, `Pong was delayed ${Math.max(...pongDelays)} ms`);
  t.diagnostic(`Upload ${payload.length} bytes in ${elapsed.toFixed(0)} ms; ${pongsDuringUpload} Pongs during upload; max Pong delay ${Math.max(...pongDelays).toFixed(0)} ms`);
});

test('the same slow stream misses a bounded Pong deadline with one unfragmented message', { timeout: 5_000 }, async (t) => {
  let expired = false;
  let pongBeforeDeadline = false;
  const upstream = await upstreamFixture(t, (socket) => {
    let expiry;
    let forceClose;
    const ping = setTimeout(() => {
      socket.ping('bounded-probe');
      expiry = setTimeout(() => {
        expired = true;
        socket.close(1011, 'local-test keepalive timeout');
        forceClose = setTimeout(() => socket.terminate(), 50);
      }, 250);
    }, 25);
    socket.on('pong', () => { if (!expired) pongBeforeDeadline = true; });
    socket.on('close', () => { clearTimeout(ping); clearTimeout(expiry); clearTimeout(forceClose); });
  });
  const client = await connect(upstream.url, {
    perMessageDeflate: false,
    createConnection: () => new ThrottledDuplex(connectTcp(upstream.port, '127.0.0.1')),
  });
  t.after(() => client.terminate());
  const closed = new Promise((resolve) => client.once('close', (...event) => resolve(event)));
  client.send(Buffer.alloc(393_432, 97), { binary: false, compress: false }, () => {});
  await closed;
  assert.equal(expired, true);
  assert.equal(pongBeforeDeadline, false);
});

test('downstream disconnect cancels the upstream connection and pending forwarding', { timeout: 5_000 }, async (t) => {
  let resolveUpstream;
  const connected = new Promise((resolve) => { resolveUpstream = resolve; });
  const upstream = await upstreamFixture(t, (socket) => resolveUpstream(socket));
  const local = await bridgeFixture(t, upstream.origin);
  const client = await connect(local.url);
  const remote = await connected;
  const remoteClosed = once(remote, 'close');
  client.send(randomBytes(4 * 1024 * 1024), { binary: true });
  await delay(5);
  client.terminate();
  await remoteClosed;
  await delay(20);
  assert.equal(local.bridge.stats().activeConnections, 0);
  const bytes = local.bridge.stats().upstreamBytes;
  await delay(30);
  assert.equal(local.bridge.stats().upstreamBytes, bytes);
});

test('bounded message/byte queues reject overflow and tear down both sides', { timeout: 5_000 }, async (t) => {
  const upstream = await upstreamFixture(t, () => {});
  const local = await bridgeFixture(t, upstream.origin, { maxQueuedBytes: 40_000, maxQueuedMessages: 2, fragmentBytes: 1024 });
  const client = await connect(local.url);
  const closed = once(client, 'close');
  for (let index = 0; index < 12; index += 1) client.send(Buffer.alloc(20_000, index), { binary: true });
  const [code] = await closed;
  assert.equal(code, 1008);
  assert.equal(local.bridge.stats().queueRejected, 1);
  await delay(30);
  assert.equal(local.bridge.stats().activeConnections, 0);
});

test('oversized response.create is unsent and a stable header key gates the next upgrade before upstream connection', { timeout: 5_000 }, async (t) => {
  let connections = 0;
  let messages = 0;
  const upstream = await upstreamFixture(t, (socket) => {
    connections += 1;
    socket.on('message', () => { messages += 1; });
  });
  const cache = new Set();
  let oversize;
  const local = await bridgeFixture(t, upstream.origin, {
    wsMessageBudgetBytes: 1024,
    onOversize(info) { oversize = info; if (info.key) cache.add(info.key); },
    shouldRejectUpgrade: ({ key }) => cache.has(key),
  });
  const headers = { 'x-client-request-id': 'header-session' };
  const client = await connect(local.url, { headers });
  const body = JSON.stringify({ type: 'response.create', client_metadata: { thread_id: 'body-session' }, input: 'x'.repeat(1600) });
  const closed = once(client, 'close');
  client.send(body);
  const [code] = await closed;
  assert.equal(code, 1009);
  assert.deepEqual(oversize, { key: 'header-session', bytes: Buffer.byteLength(body), messageType: 'response.create', forwarded: false });
  assert.equal(messages, 0);
  assert.equal(connections, 1);
  assert.equal(await rejectedStatus(local.url, { headers }), 426);
  assert.equal(connections, 1);
  const other = await connect(local.url, { headers: { 'x-client-request-id': 'different-session' } });
  other.terminate();
  assert.equal(connections, 2);
});

test('unknown oversize session does not invent a global fallback key; opaque/binary payloads are unchanged', { timeout: 5_000 }, async (t) => {
  const upstream = await upstreamFixture(t, (socket) => socket.on('message', (data, binary) => socket.send(data, { binary })));
  const observed = [];
  const local = await bridgeFixture(t, upstream.origin, { wsMessageBudgetBytes: 128, onOversize: (info) => observed.push(info) });
  const client = await connect(local.url);
  t.after(() => client.terminate());
  for (const [body, binary] of [[Buffer.from('opaque'.repeat(100)), false], [randomBytes(512), true]]) {
    const received = nextMessage(client);
    client.send(body, { binary });
    assert.deepEqual((await received).data, body);
  }
  assert.equal(observed.length, 0);
  const closed = once(client, 'close');
  client.send(JSON.stringify({ type: 'response.create', input: 'x'.repeat(200) }));
  assert.equal((await closed)[0], 1009);
  assert.equal(observed[0].key, null);
});

test('Receiver hard limit marks only the unsent message and gates its verified session on reconnect', { timeout: 5_000 }, async (t) => {
  let connections = 0;
  const receivedMessages = [];
  const upstream = await upstreamFixture(t, (socket) => {
    connections += 1;
    socket.on('message', (data, binary) => {
      receivedMessages.push(Buffer.from(data));
      socket.send(data, { binary });
    });
  });
  const cache = new Set();
  const notices = [];
  const local = await bridgeFixture(t, upstream.origin, {
    maxMessageBytes: 1024,
    onOversize(info) { notices.push(info); cache.add(info.key); },
    shouldRejectUpgrade: ({ key }) => cache.has(key),
  });
  const headers = { 'x-client-request-id': 'receive-limit-session' };
  const client = await connect(local.url, { headers });
  const warmup = Buffer.from('{"type":"response.create","input":[],"generate":false}');
  const echoedWarmup = nextMessage(client);
  client.send(warmup, { binary: false });
  assert.ok((await echoedWarmup).data.equals(warmup));
  const oversized = JSON.stringify({ type: 'response.create', input: 'x'.repeat(4096) });
  const closed = once(client, 'close');
  client.send(oversized);
  assert.equal((await closed)[0], 1009);
  assert.deepEqual(notices, [{
    key: 'receive-limit-session', bytes: null, messageType: 'unknown', forwarded: false,
    reason: 'local-receive-limit', limitBytes: 1024,
  }]);
  assert.equal(receivedMessages.length, 1, 'The oversized current message must remain unsent');
  assert.ok(receivedMessages[0].equals(warmup));
  assert.equal(await rejectedStatus(local.url, { headers }), 426);
  assert.equal(connections, 1);
  const other = await connect(local.url, { headers: { 'x-client-request-id': 'other-receive-session' } });
  t.after(() => other.terminate());
  const echoed = nextMessage(other);
  other.send('normal');
  assert.equal((await echoed).data.toString(), 'normal');
  assert.equal(connections, 2);
  assert.equal(receivedMessages.length, 2);
});

test('Receiver hard limit without a handshake key does not inspect partial metadata or set fallback', { timeout: 5_000 }, async (t) => {
  const upstream = await upstreamFixture(t, (socket) => socket.on('message', (data, binary) => socket.send(data, { binary })));
  const notices = [];
  const local = await bridgeFixture(t, upstream.origin, { maxMessageBytes: 1024, onOversize: (info) => notices.push(info) });
  const client = await connect(local.url);
  const closed = once(client, 'close');
  client.send(JSON.stringify({ type: 'response.create', client_metadata: { thread_id: 'unread-id' }, input: 'x'.repeat(4096) }));
  assert.equal((await closed)[0], 1009);
  assert.deepEqual(notices, []);
  const retry = await connect(local.url);
  t.after(() => retry.terminate());
  const echoed = nextMessage(retry);
  retry.send('small');
  assert.equal((await echoed).data.toString(), 'small');
});

test('upstream Receiver hard limit does not downgrade an already forwarded request', { timeout: 5_000 }, async (t) => {
  let received = 0;
  const upstream = await upstreamFixture(t, (socket) => socket.on('message', () => {
    received += 1;
    socket.send('x'.repeat(4096));
  }));
  const cache = new Set();
  const notices = [];
  const local = await bridgeFixture(t, upstream.origin, {
    maxMessageBytes: 1024,
    onOversize(info) { notices.push(info); cache.add(info.key); },
    shouldRejectUpgrade: ({ key }) => cache.has(key),
  });
  const headers = { 'x-client-request-id': 'upstream-large-response-session' };
  const client = await connect(local.url, { headers });
  const closed = once(client, 'close');
  client.send('small forwarded request');
  assert.equal((await closed)[0], 1011);
  assert.equal(received, 1);
  assert.deepEqual(notices, []);
  const retry = await connect(local.url, { headers });
  retry.terminate();
});

test('upstream refusal and clean close are propagated without invented Responses events', { timeout: 5_000 }, async (t) => {
  const upstream = await upstreamFixture(t, (socket) => socket.on('message', () => socket.close(1013, 'local-test-retry')));
  const local = await bridgeFixture(t, upstream.origin);
  const client = await connect(local.url);
  let messageCount = 0;
  client.on('message', () => { messageCount += 1; });
  const closed = once(client, 'close');
  client.send('trigger');
  const [code, reason] = await closed;
  assert.equal(code, 1013);
  assert.equal(reason.toString(), 'local-test-retry');
  assert.equal(messageCount, 0);
});

test('production denies missing Authorization and test mode cannot target a non-loopback host', { timeout: 5_000 }, async (t) => {
  assert.throws(() => attachWebSocketBridge(createServer(), { allowUnauthenticated: true, upstreamOrigin: 'https://chatgpt.com' }), /loopback/);
  assert.throws(() => attachWebSocketBridge(createServer(), { proxyUrl: 'http://127.0.0.1:1', upstreamOrigin: 'https://example.com' }), /chatgpt/);
  const server = createServer();
  const bridge = attachWebSocketBridge(server, { proxyUrl: 'http://127.0.0.1:1' });
  const port = await listen(server);
  t.after(async () => { await bridge.close(); await shutdownServer(server); });
  assert.equal(await rejectedStatus(`ws://127.0.0.1:${port}${PATH}`), 401);
  assert.equal(await rejectedStatus(`ws://127.0.0.1:${port}/outside`), 404);
  assert.equal(bridge.stats().pendingConnections, 0);
});

test('HTTP upgrade refusals preserve status, Retry-After and exact error body', { timeout: 5_000 }, async (t) => {
  const body = Buffer.from('{"error":{"message":"local fixture refused","code":"rate_limit"}}');
  const server = createServer();
  server.on('upgrade', (_request, socket) => {
    socket.end(Buffer.concat([
      Buffer.from(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: 7\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`),
      body,
    ]));
  });
  const port = await listen(server);
  t.after(() => shutdownServer(server));
  const local = await bridgeFixture(t, `http://127.0.0.1:${port}`);
  const response = await new Promise((resolve, reject) => {
    const client = new WebSocket(local.url);
    client.on('error', () => {});
    client.once('open', () => { client.terminate(); reject(new Error('Unexpected upgrade')); });
    client.once('unexpected-response', (request, refused) => {
      const chunks = [];
      refused.on('data', (chunk) => chunks.push(chunk));
      refused.once('end', () => {
        resolve({ status: refused.statusCode, headers: refused.headers, body: Buffer.concat(chunks) });
        request.destroy();
      });
      refused.once('error', reject);
    });
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers['retry-after'], '7');
  assert.equal(response.headers['content-type'], 'application/json');
  assert.deepEqual(response.body, body);
});

test('disconnect during upstream handshake releases pending connection', { timeout: 5_000 }, async (t) => {
  const server = createServer();
  const sockets = new Set();
  let upgraded;
  const receivedUpgrade = new Promise((resolve) => { upgraded = resolve; });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (_request, socket) => {
    socket.on('end', () => socket.end());
    socket.resume();
    upgraded(socket);
  });
  const port = await listen(server);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await shutdownServer(server); });
  const local = await bridgeFixture(t, `http://127.0.0.1:${port}`);
  const client = new WebSocket(local.url);
  client.on('error', () => {});
  const remoteSocket = await receivedUpgrade;
  const closed = once(remoteSocket, 'close');
  client.terminate();
  await closed;
  await delay(20);
  assert.equal(local.bridge.stats().pendingConnections, 0);
  assert.equal(local.bridge.stats().activeConnections, 0);
});

/**
 * A fast local TCP peer that intentionally gives no upload backpressure. It
 * buffers client bytes in memory, then forwards them to a real WS server slowly.
 * This models a local CONNECT proxy whose WAN queue is invisible to ws.send().
 */
async function bufferedProxyFixture(t, targetPort) {
  const sockets = new Set();
  const samples = [];
  const server = createTcpServer((client) => {
    const remote = connectTcp(targetPort, '127.0.0.1');
    sockets.add(client);
    sockets.add(remote);
    const sample = { maxQueuedBytes: 0, receivedBytes: 0, forwardedBytes: 0 };
    samples.push(sample);
    const queue = [];
    let offset = 0;
    let queuedBytes = 0;
    let pumping = false;
    let stopped = false;
    let timer;
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      queue.length = 0;
      client.destroy();
      remote.destroy();
      sockets.delete(client);
      sockets.delete(remote);
    };
    const pump = () => {
      if (stopped) return;
      if (!queue.length) { pumping = false; return; }
      pumping = true;
      const chunk = queue[0];
      const end = Math.min(offset + 8192, chunk.length);
      const part = chunk.subarray(offset, end);
      offset = end;
      queuedBytes -= part.length;
      if (offset === chunk.length) { queue.shift(); offset = 0; }
      remote.write(part, (error) => {
        if (error) return cleanup();
        sample.forwardedBytes += part.length;
        timer = setTimeout(pump, 10);
      });
    };
    client.on('data', (data) => {
      sample.receivedBytes += data.length;
      queuedBytes += data.length;
      sample.maxQueuedBytes = Math.max(sample.maxQueuedBytes, queuedBytes);
      // Bound even the intentionally eager test proxy.
      if (queuedBytes > 4 * 1024 * 1024) return cleanup();
      queue.push(data);
      if (!pumping) pump();
    });
    remote.pipe(client);
    for (const socket of [client, remote]) {
      socket.on('error', cleanup);
      socket.on('close', cleanup);
    }
  });
  const port = await listen(server);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await shutdownServer(server);
  });
  return { origin: `http://127.0.0.1:${port}`, samples };
}

test('remote Pong windows bound a fast local proxy queue where fragmentation alone times out', { timeout: 15_000 }, async (t) => {
  const deadlineMs = 650;
  const payload = Buffer.from(`${randomBytes(786_432).toString('base64')}中😀`);
  async function run(ackWindowBytes) {
    let expired = false;
    let complete = false;
    let pongsDuringUpload = 0;
    let maxPongMs = 0;
    const upstream = await upstreamFixture(t, (socket) => {
      let sequence = 0;
      let forceClose;
      const pendingPings = new Map();
      const timer = setInterval(() => {
        const now = performance.now();
        if ([...pendingPings.values()].some((started) => now - started > deadlineMs)) {
          expired = true;
          clearInterval(timer);
          socket.close(1011, 'local-test proxy queue keepalive timeout');
          forceClose = setTimeout(() => socket.terminate(), 50);
          return;
        }
        if (socket.readyState !== WebSocket.OPEN) return;
        const key = `server-${++sequence}`;
        pendingPings.set(key, now);
        socket.ping(key);
      }, 50);
      socket.on('pong', (data) => {
        const started = pendingPings.get(data.toString());
        if (started === undefined) return;
        pendingPings.delete(data.toString());
        maxPongMs = Math.max(maxPongMs, performance.now() - started);
        if (!complete) pongsDuringUpload += 1;
      });
      socket.on('message', (data, binary) => {
        complete = true;
        socket.send(data, { binary });
      });
      socket.on('close', () => { clearInterval(timer); clearTimeout(forceClose); });
    });
    const proxy = await bufferedProxyFixture(t, upstream.port);
    const local = await bridgeFixture(t, proxy.origin, {
      upstreamAckWindowBytes: ackWindowBytes,
      upstreamAckTimeoutMs: 2_000,
    });
    const client = await connect(local.url);
    t.after(() => client.terminate());
    const outcome = new Promise((resolve) => {
      client.once('message', (data, binary) => resolve({ type: 'message', data, binary }));
      client.once('close', (code) => resolve({ type: 'close', code }));
    });
    const started = performance.now();
    client.send(payload, { binary: false });
    const result = await outcome;
    const elapsedMs = performance.now() - started;
    const stats = local.bridge.stats();
    client.terminate();
    await local.bridge.close();
    return {
      result, elapsedMs, expired, complete, pongsDuringUpload, maxPongMs, stats,
      maxProxyQueuedBytes: Math.max(...proxy.samples.map((sample) => sample.maxQueuedBytes)),
    };
  }
  const baseline = await run(0);
  assert.equal(baseline.result.type, 'close');
  assert.equal(baseline.expired, true);
  assert.equal(baseline.complete, false);
  assert.ok(baseline.maxProxyQueuedBytes > 512 * 1024, 'Baseline proxy did not buffer ahead');
  const paced = await run(128 * 1024);
  assert.equal(paced.result.type, 'message');
  assert.equal(paced.result.binary, false);
  assert.ok(paced.result.data.equals(payload), 'Pacing changed the logical message bytes');
  assert.equal(paced.expired, false);
  assert.ok(paced.pongsDuringUpload >= 10);
  assert.ok(paced.maxPongMs < deadlineMs);
  assert.ok(paced.maxProxyQueuedBytes < 256 * 1024, `Proxy queue grew to ${paced.maxProxyQueuedBytes}`);
  assert.ok(paced.stats.upstreamAcks >= 7);
  assert.equal(paced.stats.upstreamAckTimeouts, 0);
  t.diagnostic(`Fast-proxy baseline queued ${baseline.maxProxyQueuedBytes} bytes and timed out; paced queue ${paced.maxProxyQueuedBytes} bytes, ${paced.stats.upstreamAcks} remote confirmations, ${paced.pongsDuringUpload} server Pongs, max Pong ${paced.maxPongMs.toFixed(0)} ms, ${payload.length} identical bytes in ${paced.elapsedMs.toFixed(0)} ms`);
});

test('missing matching Pong times out after one window and closes forwarding', { timeout: 5_000 }, async (t) => {
  let completeMessages = 0;
  const upstream = await upstreamFixture(t, (socket) => {
    socket.on('message', () => { completeMessages += 1; });
    socket.on('ping', (nonce) => {
      const wrong = Buffer.from(nonce);
      wrong[0] ^= 1;
      socket.pong(wrong);
    });
  }, { autoPong: false });
  const local = await bridgeFixture(t, upstream.origin, { upstreamAckWindowBytes: 16 * 1024, upstreamAckTimeoutMs: 80 });
  const client = await connect(local.url);
  const closed = once(client, 'close');
  client.send(Buffer.alloc(64 * 1024), { binary: true });
  assert.equal((await closed)[0], 1011);
  assert.equal(local.bridge.stats().upstreamAcks, 0);
  assert.equal(local.bridge.stats().upstreamAckTimeouts, 1);
  assert.equal(local.bridge.stats().upstreamBytes, 16 * 1024);
  assert.equal(completeMessages, 0);
});

test('abort and socket close remove a pending remote Pong listener immediately', { timeout: 5_000 }, async (t) => {
  for (const action of ['abort', 'close']) {
    let sawPing;
    const ping = new Promise((resolve) => { sawPing = resolve; });
    const upstream = await upstreamFixture(t, (socket) => socket.once('ping', () => sawPing()), { autoPong: false });
    const client = await connect(upstream.url);
    t.after(() => client.terminate());
    const controller = new AbortController();
    const originalPongListeners = client.listenerCount('pong');
    const sending = sendFragmentedMessage(client, Buffer.alloc(64 * 1024), {
      binary: true, signal: controller.signal, ackWindowBytes: 16 * 1024, ackTimeoutMs: 2_000,
    });
    const rejected = assert.rejects(sending, { name: 'AbortError' });
    await ping;
    assert.equal(client.listenerCount('pong'), originalPongListeners + 1);
    if (action === 'abort') controller.abort();
    else client.terminate();
    await rejected;
    assert.equal(client.listenerCount('pong'), originalPongListeners);
    client.terminate();
  }
});
