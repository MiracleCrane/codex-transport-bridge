import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { createHttpTransportServer } from './http-transport.mjs';

async function fixture(t, handler) {
  const remote = http.createServer(handler);
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening');
  const bridge = createHttpTransportServer({ upstreamOrigin: `http://127.0.0.1:${remote.address().port}`,
    allowUnauthenticated: true, responseHeadersTimeoutMs: 120, requestTimeoutMs: 1500 });
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
