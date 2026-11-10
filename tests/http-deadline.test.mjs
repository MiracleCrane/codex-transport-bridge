import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { createHttpTransportServer } from './http-transport.mjs';

async function fixture(t, handler, options = {}) {
  const remote = http.createServer(handler);
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening');
  const bridge = createHttpTransportServer({ upstreamOrigin: `http://127.0.0.1:${remote.address().port}`,
    allowUnauthenticated: true, responseHeadersTimeoutMs: 120, requestTimeoutMs: 1500, ...options });
  bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening');
  t.after(async () => { await bridge.close(); remote.closeAllConnections(); await new Promise(r => remote.close(r)); });
  return `http://127.0.0.1:${bridge.server.address().port}/backend-api/codex/responses`;
}

function post(url) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST' }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject); request.end('{}');
  });
}

test('a peer that never sends headers ends with 504 after upload, without replay', { timeout: 3000 }, async t => {
  let requests = 0;
  const url = await fixture(t, request => { requests++; request.resume(); });
  const start = performance.now(); const response = await post(url);
  assert.equal(response.status, 504);
  assert.ok(performance.now() - start < 1200);
  assert.equal(requests, 1);
});

test('the headers deadline does not cancel a response that has started streaming', { timeout: 3000 }, async t => {
  const url = await fixture(t, (request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    setTimeout(() => response.end('data: {"type":"response.completed"}\n\n'), 350);
  });
  const response = await post(url);
  assert.equal(response.status, 200);
  assert.match(response.body, /response.completed/);
});

test('the default deadline accepts response headers delayed beyond one minute', { timeout: 80000 }, async t => {
  let requests = 0;
  const url = await fixture(t, (request, response) => {
    requests++; request.resume();
    request.once('end', () => {
      const timer = setTimeout(() => response.end('slow headers accepted'), 65000);
      t.after(() => clearTimeout(timer));
    });
  }, { responseHeadersTimeoutMs: undefined, requestTimeoutMs: 75000 });
  const response = await post(url);
  assert.equal(response.status, 200);
  assert.equal(response.body, 'slow headers accepted');
  assert.equal(requests, 1);
});

test('caller cancellation closes the upstream while waiting for response headers', { timeout: 3000 }, async t => {
  let acceptRequest;
  let closeUpstream;
  const received = new Promise(resolve => { acceptRequest = resolve; });
  const closed = new Promise(resolve => { closeUpstream = resolve; });
  const url = await fixture(t, request => {
    request.socket.once('close', closeUpstream);
    request.resume(); request.once('end', acceptRequest);
  }, { responseHeadersTimeoutMs: undefined });
  const request = http.request(url, { method: 'POST' });
  request.on('error', () => {});
  request.end('{}');
  await received;
  request.destroy();
  let timer;
  t.after(() => clearTimeout(timer));
  await Promise.race([closed, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Cancelled upstream remained open')), 750);
  })]);
});
