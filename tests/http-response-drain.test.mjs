import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createHttpTransportServer } from './http-transport.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return server.address().port;
}
async function fixture(t, body, { blockedEnd = false, callerCancel = false } = {}) {
  const events = [];
  const sockets = new Set();
  const remote = http.createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      // Deliver a real HTTP chunk, then omit the required chunked terminator.
      response.write(body, () => response.socket.end());
    });
  });
  remote.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const remotePort = await listen(remote);
  let downstream;
  let request;
  const bridge = createHttpTransportServer({ upstreamOrigin: `http://127.0.0.1:${remotePort}`,
    allowUnauthenticated: true, responseDrainTimeoutMs: 150, closeTimeoutMs: 60,
    onEvent(event) {
      events.push(event);
      if (event.kind === 'http_response_error' || event.kind === 'http_failed') {
        if (callerCancel) request.socket.resetAndDestroy();
        else if (!blockedEnd) setTimeout(() => downstream?.uncork(), 20);
      }
    },
  });
  bridge.server.on('request', (_request, response) => {
    downstream = response.socket;
    // Real Writable buffering makes loss before the local flush deterministic.
    downstream.cork();
    if (blockedEnd) downstream.end = function() { return this; };
  });
  const port = await listen(bridge.server);
  t.after(async () => {
    request?.destroy(); downstream?.destroy();
    for (const socket of sockets) socket.destroy();
    await bridge.close();
    await new Promise(resolve => remote.close(resolve));
  });
  const result = new Promise(resolve => {
    const received = [];
    let settled = false;
    const finish = (complete, error) => {
      if (settled) return; settled = true;
      resolve({ body: Buffer.concat(received), complete, error });
    };
    request = http.request(`http://127.0.0.1:${port}/backend-api/codex/responses`, { method: 'POST' }, response => {
      response.on('data', chunk => received.push(chunk));
      response.on('end', () => finish(response.complete, null));
      response.on('error', error => finish(response.complete, error.code));
    });
    request.on('error', error => finish(false, error.code));
    request.end('{}');
  });
  return { bridge, events, result };
}

for (const [name, body] of [
  ['complete terminal event', Buffer.from('data: {"type":"response.output_text.delta","delta":"fixture"}\n\ndata: {"type":"response.completed"}\n\n')],
  ['partial terminal event', Buffer.from('data: {"type":"response.output_text.delta","delta":"fixture"}\n\ndata: {"type":"response.comp')],
]) {
  test(`upstream HTTP EOF drains ${name} without pretending HTTP completed`, { timeout: 3000 }, async t => {
    const f = await fixture(t, body);
    const result = await f.result;
    const upstreamFailure = f.events.find(e => e.kind === 'http_response_error' || e.kind === 'http_failed');
    assert.equal(upstreamFailure.downloadedBytes, body.length, 'The fixture must deliver the full expected bytes to the bridge');
    assert.deepEqual(result.body, body, 'Every byte already received by the bridge must reach the caller');
    assert.equal(result.complete, false, 'The bridge must not invent a normal chunked terminator');
    assert.ok(result.error);
    await delay(30);
    assert.equal(f.bridge.stats().httpErrors, 1);
    assert.equal(f.bridge.stats().httpCancelled, 0);
    assert.equal(f.bridge.stats().httpActive, 0);
    assert.equal(f.events.filter(e => e.kind === 'http_caller_cancelled').length, 0);
  });
}

test('an unflushable HTTP failure remains active until its bounded drain finishes', { timeout: 3000 }, async t => {
  const body = Buffer.from('data: {"type":"response.created"}\n\n');
  const f = await fixture(t, body, { blockedEnd: true });
  const started = performance.now();
  while (!f.events.some(e => e.kind === 'http_response_error')) {
    if (performance.now() - started > 1000) assert.fail('No upstream failure');
    await delay(5);
  }
  assert.equal(f.bridge.stats().httpActive, 1);
  const result = await f.result;
  assert.ok(result.error);
  assert.ok(performance.now() - started < 1000);
  await delay(10);
  assert.equal(f.bridge.stats().httpActive, 0);
  assert.ok(f.events.some(e => e.kind === 'http_response_drain' && e.reason === 'deadline'));
});

test('caller close interrupts a failed HTTP drain without double-counting cancellation', { timeout: 3000 }, async t => {
  const f = await fixture(t, Buffer.from('data: {"type":"response.completed"}\n\n'), { blockedEnd: true, callerCancel: true });
  await f.result;
  await delay(50);
  assert.equal(f.bridge.stats().httpActive, 0);
  assert.equal(f.bridge.stats().httpErrors, 1);
  assert.equal(f.bridge.stats().httpCancelled, 0);
});

test('cancelling a buffered downstream response cannot kill a reused upstream socket', { timeout: 5000 }, async t => {
  let connections = 0;
  let requests = 0;
  let releaseSecond;
  let secondArrived;
  const secondReady = new Promise(resolve => { secondArrived = resolve; });
  const remote = http.createServer((request, response) => {
    request.resume();
    if (++requests === 1) response.end('first');
    else { releaseSecond = () => response.end('second'); secondArrived(); }
  });
  remote.on('connection', () => { connections++; });
  const remotePort = await listen(remote);
  const bridge = createHttpTransportServer({ upstreamOrigin: `http://127.0.0.1:${remotePort}`, allowUnauthenticated: true });
  let downstreamRequests = 0;
  bridge.server.on('request', (_request, response) => {
    if (++downstreamRequests === 1) {
      response.socket.cork();
      // Hold local completion after the upstream has ended, just as a slow
      // downstream can leave the response pending after its source is pooled.
      response.end = function() { return this; };
    }
  });
  const port = await listen(bridge.server);
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.destroy();
    await bridge.close(); remote.closeAllConnections();
    await new Promise(resolve => remote.close(resolve));
  });
  const first = http.get(`http://127.0.0.1:${port}/backend-api/codex/responses`);
  first.on('error', () => {}); clients.push(first);
  await delay(40);
  assert.equal(bridge.stats().httpActive, 1, 'Upstream end must not mark a buffered downstream response finished');
  const second = new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/backend-api/codex/responses`, response => {
      let text = ''; response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve(text)); response.on('error', reject);
    });
    request.on('error', reject); clients.push(request);
  });
  await secondReady;
  assert.equal(connections, 1, 'The test must actually reuse the completed upstream connection');
  first.socket.resetAndDestroy();
  await delay(20);
  releaseSecond();
  assert.equal(await second, 'second');
});

test('owned shutdown closes a buffered response without waiting forever for server.close', { timeout: 3000 }, async t => {
  const remote = http.createServer((_request, response) => response.end('buffered'));
  const remotePort = await listen(remote);
  const bridge = createHttpTransportServer({ upstreamOrigin: `http://127.0.0.1:${remotePort}`, allowUnauthenticated: true });
  let downstream;
  bridge.server.on('request', (_request, response) => {
    downstream = response.socket; downstream.cork();
    response.end = function() { return this; };
  });
  const port = await listen(bridge.server);
  const client = http.get(`http://127.0.0.1:${port}/backend-api/codex/responses`);
  client.on('error', () => {});
  t.after(async () => {
    downstream?.destroy(); client.destroy();
    await bridge.close(); remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve));
  });
  await delay(40);
  let timer;
  try {
    await Promise.race([bridge.close(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Shutdown waited for an undrained response')), 500);
    })]);
  } finally { clearTimeout(timer); downstream?.destroy(); }
});
