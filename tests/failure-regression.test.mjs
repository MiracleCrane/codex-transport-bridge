import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { createHttpTransportServer } from './http-transport.mjs';
import { createTransportBridge } from './bridge.mjs';
import { CancellableProxyAgent } from './cancellable-proxy-agent.mjs';

// Trust this fixture certificate only through NODE_EXTRA_CA_CERTS on the test
// child process. Neither production TLS verification nor Windows trust changes.
const fixtureRoot = process.env.CODEX_TRANSPORT_FIXTURE_DIR
  ? new URL(`file:///${process.env.CODEX_TRANSPORT_FIXTURE_DIR.replaceAll('\\', '/').replace(/\/$/, '')}/`)
  : new URL('../transport-audit-http/', import.meta.url);
const key = await fs.readFile(new URL('offline-key.pem', fixtureRoot));
const cert = await fs.readFile(new URL('offline-ca.pem', fixtureRoot));
const endpoint = '/backend-api/codex/responses';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise, ms, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} did not finish within ${ms} ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function until(predicate, ms, description) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started >= ms) assert.fail(`${description} did not settle within ${ms} ms`);
    await delay(5);
  }
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  const closed = new Promise(resolve => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
}

async function httpFixture(t, { proxyMode = () => 'forward', onRequest, connectTimeoutMs = 150, requestTimeoutMs = 5000 } = {}) {
  const owned = new Set();
  const proxySockets = new Set();
  const targetSockets = new Set();
  const clients = new Set();
  const connects = [];
  const counts = { proxyTcp: 0, connect: 0, tls: 0, post: 0 };
  const firstConnect = deferred();
  const firstTlsClientHello = deferred();
  const events = [];
  let bridge;
  const own = socket => {
    owned.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => owned.delete(socket));
    return socket;
  };
  const target = https.createServer({ key, cert }, (request, response) => {
    if (request.method === 'POST') counts.post++;
    request.resume();
    request.once('end', () => {
      if (onRequest) onRequest(request, response);
      else response.end('fixture-ok');
    });
  });
  target.keepAliveTimeout = 5000;
  target.on('connection', own);
  target.on('secureConnection', socket => {
    counts.tls++;
    targetSockets.add(socket);
    socket.once('close', () => targetSockets.delete(socket));
  });
  const targetPort = await listen(target);
  const proxy = net.createServer(socket => {
    own(socket);
    proxySockets.add(socket);
    socket.once('close', () => proxySockets.delete(socket));
    const index = ++counts.proxyTcp;
    let buffered = Buffer.alloc(0);
    const readConnect = data => {
      buffered = Buffer.concat([buffered, data]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', readConnect);
      const firstLine = buffered.toString('ascii', 0, buffered.indexOf('\r\n'));
      assert.equal(firstLine, `CONNECT 127.0.0.1:${targetPort} HTTP/1.1`, 'Fixture may only tunnel to its local target');
      counts.connect++;
      connects.push(socket);
      firstConnect.resolve();
      const mode = proxyMode(index);
      if (mode === 'connect-stall') return;
      if (mode === 'tls-stall') {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.on('data', data => { if (data[0] === 22) firstTlsClientHello.resolve(); });
        return;
      }
      const outgoing = own(net.connect(targetPort, '127.0.0.1'));
      outgoing.on('error', () => socket.destroy());
      outgoing.once('close', () => socket.destroySoon());
      socket.once('close', () => outgoing.destroy());
      outgoing.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const remainder = buffered.subarray(end + 4);
        if (remainder.length) outgoing.write(remainder);
        socket.pipe(outgoing).pipe(socket);
      });
    };
    socket.on('data', readConnect);
  });
  t.after(async () => {
    for (const client of clients) client.destroy();
    for (const socket of owned) socket.destroy();
    await bridge?.close();
    await closeServer(proxy);
    await closeServer(target);
  });
  const proxyPort = await listen(proxy);
  bridge = createHttpTransportServer({
    upstreamOrigin: `https://127.0.0.1:${targetPort}`, allowUnauthenticated: true,
    proxyUrl: `http://127.0.0.1:${proxyPort}`, connectTimeoutMs,
    requestTimeoutMs, onEvent: event => events.push(event),
  });
  const localPort = await listen(bridge.server);
  function post() {
    let request;
    const result = new Promise(resolve => {
      request = http.request(`http://127.0.0.1:${localPort}${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 2 },
      }, response => {
        let body = '';
        response.on('data', data => { body += data.toString(); });
        response.once('end', () => resolve({ status: response.statusCode, body }));
        response.once('error', error => resolve({ errorCode: error.code ?? error.name }));
      });
      clients.add(request);
      request.once('close', () => clients.delete(request));
      request.once('error', error => resolve({ errorCode: error.code ?? error.name }));
      request.end('{}');
    });
    return { request, result };
  }
  return { bridge, post, proxySockets, targetSockets, connects, counts, firstConnect, firstTlsClientHello, events,
    proxyUrl: `http://127.0.0.1:${proxyPort}`, targetOrigin: `https://127.0.0.1:${targetPort}` };
}

for (const mode of ['connect-stall', 'tls-stall']) {
  test(`${mode} ends with 504 within connect deadline and releases raw socket`, { timeout: 5000 }, async t => {
    const fixture = await httpFixture(t, { proxyMode: () => mode });
    const started = performance.now();
    const response = await bounded(fixture.post().result, 1500, mode);
    assert.equal(response.status, 504);
    assert.ok(performance.now() - started < 1500);
    await until(() => fixture.proxySockets.size === 0 && fixture.bridge.stats().httpActive === 0, 500, 'timed-out CONNECT cleanup');
    assert.equal(fixture.counts.post, 0, 'Failed connection must not submit a model request');
  });
}

test('caller cancellation during CONNECT closes raw socket and counts one cancellation', { timeout: 5000 }, async t => {
  const fixture = await httpFixture(t, { proxyMode: () => 'connect-stall', connectTimeoutMs: 5000 });
  const caller = fixture.post();
  await bounded(fixture.firstConnect.promise, 1000, 'CONNECT start');
  caller.request.destroy();
  await until(() => fixture.proxySockets.size === 0 && fixture.bridge.stats().httpActive === 0, 800, 'cancelled CONNECT cleanup');
  assert.equal(fixture.bridge.stats().httpCancelled, 1);
  assert.equal(fixture.counts.post, 0);
});

test('caller cancellation during TLS handshake absorbs closing AbortError and releases socket', { timeout: 5000 }, async t => {
  const fixture = await httpFixture(t, { proxyMode: () => 'tls-stall', connectTimeoutMs: 5000 });
  const caller = fixture.post();
  await bounded(fixture.firstTlsClientHello.promise, 1000, 'TLS ClientHello');
  caller.request.destroy();
  await until(() => fixture.proxySockets.size === 0 && fixture.bridge.stats().httpActive === 0, 800, 'cancelled TLS cleanup');
  assert.equal(fixture.bridge.stats().httpCancelled, 1);
  assert.equal(fixture.counts.post, 0);
  await delay(30); // Allow any delayed TLS AbortError to surface in the test runner.
});

test('cancelling one in-flight CONNECT does not abort another request on the shared agent', { timeout: 5000 }, async t => {
  const accepted = deferred();
  let waitingResponse;
  const fixture = await httpFixture(t, {
    proxyMode: index => index === 1 ? 'connect-stall' : 'forward',
    connectTimeoutMs: 3000,
    onRequest(_request, response) { waitingResponse = response; accepted.resolve(); },
  });
  const cancelled = fixture.post();
  await bounded(fixture.firstConnect.promise, 1000, 'first CONNECT start');
  const surviving = fixture.post();
  await bounded(accepted.promise, 1500, 'second request TLS and POST');
  cancelled.request.destroy();
  await until(() => fixture.connects[0].destroyed && fixture.bridge.stats().httpCancelled === 1, 800, 'first request cancellation');
  assert.equal(fixture.bridge.stats().httpActive, 1);
  waitingResponse.end('surviving-request');
  assert.deepEqual(await bounded(surviving.result, 1000, 'surviving response'), { status: 200, body: 'surviving-request' });
  assert.equal(fixture.counts.post, 1, 'Exactly one POST should reach the TLS target');
});

test('five HTTP requests reuse one CONNECT and one verified TLS connection', { timeout: 5000 }, async t => {
  const fixture = await httpFixture(t, { connectTimeoutMs: 1500 });
  for (let index = 0; index < 5; index++) {
    assert.deepEqual(await bounded(fixture.post().result, 1000, `response ${index}`), { status: 200, body: 'fixture-ok' });
    await delay(15);
  }
  assert.deepEqual(fixture.counts, { proxyTcp: 1, connect: 1, tls: 1, post: 5 });
});

test('a server-closed idle connection is replaced without repeating a POST', { timeout: 5000 }, async t => {
  const fixture = await httpFixture(t, { connectTimeoutMs: 1500 });
  assert.deepEqual(await bounded(fixture.post().result, 1000, 'first response'), { status: 200, body: 'fixture-ok' });
  // End an idle server connection decisively; tls.end() alone can wait for
  // the peer's reciprocal close_notify and does not model a closed socket.
  for (const socket of fixture.targetSockets) socket.destroy();
  try {
    await until(() => fixture.proxySockets.size === 0 && fixture.targetSockets.size === 0, 1000, 'server idle close');
  } catch (error) {
    t.diagnostic(JSON.stringify({
      proxy: [...fixture.proxySockets].map(socket => ({ destroyed: socket.destroyed, readableEnded: socket.readableEnded, writableEnded: socket.writableEnded })),
      target: [...fixture.targetSockets].map(socket => ({ destroyed: socket.destroyed, readableEnded: socket.readableEnded, writableEnded: socket.writableEnded })),
      counts: fixture.counts,
    }));
    throw error;
  }
  assert.deepEqual(await bounded(fixture.post().result, 1000, 'second response'), { status: 200, body: 'fixture-ok' });
  assert.deepEqual(fixture.counts, { proxyTcp: 2, connect: 2, tls: 2, post: 2 });
});

test('cancelling a completed request signal cannot kill its socket after another request reuses it', { timeout: 5000 }, async t => {
  const secondAccepted = deferred();
  let secondResponse;
  let requestCount = 0;
  const fixture = await httpFixture(t, { onRequest(_request, response) {
    if (++requestCount === 1) response.end('first-complete');
    else { secondResponse = response; secondAccepted.resolve(); }
  } });
  const agent = new CancellableProxyAgent(fixture.proxyUrl, { connectTimeoutMs: 1500 });
  t.after(() => agent.destroy());
  function directPost(controller) {
    return new Promise((resolve, reject) => {
      const request = https.request(`${fixture.targetOrigin}${endpoint}`, {
        method: 'POST', agent, signal: controller.signal, rejectUnauthorized: true,
        headers: { 'content-length': 2 },
      }, response => {
        let body = '';
        response.on('data', data => { body += data.toString(); });
        response.once('end', () => resolve({ status: response.statusCode, body }));
        response.once('error', reject);
      });
      agent.bindRequest(request, controller.signal);
      request.once('error', reject);
      request.end('{}');
    });
  }
  const previous = new AbortController();
  assert.deepEqual(await bounded(directPost(previous), 1000, 'first pooled request'), { status: 200, body: 'first-complete' });
  const next = directPost(new AbortController());
  await bounded(secondAccepted.promise, 1000, 'reused request accepted');
  previous.abort(new Error('late cancellation of completed request'));
  await delay(20);
  secondResponse.end('second-survives');
  assert.deepEqual(await bounded(next, 1000, 'reused request after old signal abort'), { status: 200, body: 'second-survives' });
  assert.deepEqual(fixture.counts, { proxyTcp: 1, connect: 1, tls: 1, post: 2 });
});

async function wsFixture(t, bodies, closeMode = 'normal') {
  const server = http.createServer();
  const upstream = new WebSocketServer({ server, perMessageDeflate: false });
  const upstreamClosed = deferred();
  upstream.on('connection', socket => {
    socket.on('error', () => {});
    socket.once('close', upstreamClosed.resolve);
    socket.once('message', () => {
      for (const [index, body] of bodies.entries()) {
        socket.send(body, error => {
          if (error || index !== bodies.length - 1) return;
          if (closeMode === 'tcp-eof') socket._socket.end();
          else socket.close(1000, 'fixture completed');
        });
      }
    });
  });
  const upstreamPort = await listen(server);
  const bridge = createTransportBridge({ upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, allowUnauthenticated: true });
  const port = await listen(bridge.server);
  const client = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
  client.on('error', () => {});
  t.after(async () => {
    client.terminate();
    for (const socket of upstream.clients) socket.terminate();
    await bridge.close();
    await new Promise(resolve => upstream.close(resolve));
    await closeServer(server);
  });
  await once(client, 'open');
  return { bridge, client, upstreamClosed };
}

test('complete events before a TCP EOF drain before an abnormal close is propagated', { timeout: 5000 }, async t => {
  const bodies = Array.from({ length: 100 }, (_, index) => JSON.stringify({
    type: index === 99 ? 'response.completed' : 'response.output_text.delta', sequence_number: index,
  }));
  const { bridge, client } = await wsFixture(t, bodies, 'tcp-eof');
  const received = [];
  client.on('message', body => received.push(body.toString()));
  const closed = once(client, 'close');
  client.send('start-fixture');
  const [code] = await bounded(closed, 2000, 'abnormal close after complete frames');
  assert.equal(received.length, bodies.length);
  for (let index = 0; index < bodies.length; index++) assert.equal(received[index], bodies[index]);
  assert.equal(code, 1011, 'The reserved 1006 close must not be transmitted on the wire');
  assert.equal(bridge.stats().websocket.queueRejected, 0);
});

for (const count of [20, 100]) {
  test(`upstream final ${count}-event burst drains in order before close 1000`, { timeout: 5000 }, async t => {
    const bodies = Array.from({ length: count }, (_, index) => JSON.stringify({
      type: index === count - 1 ? 'response.completed' : 'response.output_text.delta',
      sequence_number: index, delta: 'small final event',
    }));
    const { bridge, client } = await wsFixture(t, bodies);
    const received = [];
    client.on('message', body => received.push(body.toString()));
    const closed = once(client, 'close');
    client.send('start-fixture');
    const [code, reason] = await bounded(closed, 2000, 'normal close after final events');
    assert.equal(received.length, bodies.length, 'Every complete event, including response.completed, must precede the close');
    for (let index = 0; index < bodies.length; index++) assert.equal(received[index], bodies[index]);
    assert.equal(code, 1000);
    assert.equal(reason.toString(), 'fixture completed');
    assert.equal(bridge.stats().websocket.queueRejected, 0);
  });
}

test('client cancellation interrupts a pending downstream drain promptly', { timeout: 5000 }, async t => {
  const bodies = Array.from({ length: 100 }, (_, index) => JSON.stringify({ sequence_number: index, delta: 'x'.repeat(128 * 1024) }));
  const { bridge, client, upstreamClosed } = await wsFixture(t, bodies);
  client.once('message', () => client.pause());
  const first = once(client, 'message');
  client.send('start-fixture');
  await bounded(first, 1000, 'first downstream event');
  await bounded(upstreamClosed.promise, 1500, 'upstream normal close while downstream is paused');
  assert.ok(bridge.stats().websocket.downstreamMessages < bodies.length, 'Cancellation must happen while events are still pending');
  const started = performance.now();
  client.terminate();
  await until(() => bridge.stats().websocket.activeConnections === 0, 1200, 'cancelled downstream release');
  assert.ok(performance.now() - started < 1200);
  assert.equal(bridge.stats().websocket.queueRejected, 0);
});
for (const reused of [false, true]) {
  test(`continuous TLS response survives longer than the idle deadline, reused=${reused}`, { timeout: 3000 }, async t => {
    let requests = 0;
    const fixture = await httpFixture(t, { requestTimeoutMs: 120, onRequest(_request, response) {
      if (reused && ++requests === 1) { response.end('warm'); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
      const pulse = setInterval(() => response.write(': fixture-progress\n\n'), 20);
      const complete = setTimeout(() => { clearInterval(pulse); response.end('data: {"type":"response.completed"}\n\n'); }, 600);
      response.once('close', () => { clearInterval(pulse); clearTimeout(complete); });
    } });
    if (reused) { assert.equal((await fixture.post().result).status, 200); await delay(10); }
    const result = await fixture.post().result;
    assert.equal(result.status, 200, JSON.stringify(fixture.events));
    assert.match(result.body, /response.completed/);
    assert.equal(fixture.bridge.stats().httpErrors, 0);
    assert.equal(fixture.counts.connect, 1);
    if (reused) assert.ok(fixture.events.some(e => e.kind === 'http_socket_assigned' && e.reusedSocket));
  });
}
