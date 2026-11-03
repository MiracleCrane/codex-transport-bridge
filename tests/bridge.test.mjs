import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createTransportBridge } from './bridge.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
function request(url, options = {}, chunks = []) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, res => {
      const data = []; res.on('data', chunk => data.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(data) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

test('HTTP forwards the exact body and required headers without logging credentials or body', async () => {
  const bytes = randomBytes(2 * 1024 * 1024 + 19);
  const expected = createHash('sha256').update(bytes).digest('hex');
  const events = [];
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-only');
    assert.equal(req.headers['x-codex-turn-state'], 'fixture-turn-state');
    assert.equal(req.headers['x-remove-me'], undefined);
    const hash = createHash('sha256');
    req.on('data', chunk => hash.update(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-codex-turn-state': 'next-state' });
      res.end(hash.digest('hex'));
    });
  });
  const upstreamOrigin = await listen(upstream);
  const bridge = createTransportBridge({ upstreamOrigin, allowUnauthenticated: true, onEvent: e => events.push(e) });
  const origin = await listen(bridge.server);
  try {
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 65536) chunks.push(bytes.subarray(i, i + 65536));
    const result = await request(`${origin}/backend-api/codex/responses`, { method: 'POST', headers: {
      authorization: 'Bearer fixture-only', 'x-codex-turn-state': 'fixture-turn-state',
      connection: 'keep-alive, x-remove-me', 'x-remove-me': 'hop-only',
    } }, chunks);
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), expected);
    assert.equal(result.headers['x-codex-turn-state'], 'next-state');
    assert.equal(bridge.stats().httpUploadedBytes, bytes.length);
    assert.ok(!JSON.stringify(events).includes('fixture-only'));
    assert.ok(!JSON.stringify(events).includes('fixture-turn-state'));
  } finally { await bridge.close(); await close(upstream); }
});

test('HTTP route is fixed and declared oversized bodies fail before upstream access', async () => {
  let requests = 0;
  const upstream = http.createServer((req, res) => { requests++; res.end('unexpected'); });
  const upstreamOrigin = await listen(upstream);
  const bridge = createTransportBridge({ upstreamOrigin, allowUnauthenticated: true, maxHttpBodyBytes: 32 });
  const origin = await listen(bridge.server);
  try {
    assert.equal((await request(`${origin}/outside`)).status, 404);
    assert.equal((await request(`${origin}/backend-api/codex/../outside`)).status, 404);
    assert.equal((await request(`${origin}/backend-api/codex/responses`, { method: 'POST', headers: { 'content-length': 33 } }, [Buffer.alloc(33)])).status, 413);
    assert.equal(requests, 0);
  } finally { await bridge.close(); await close(upstream); }
});

test('production mode rejects unauthenticated HTTP without accessing upstream', async () => {
  const bridge = createTransportBridge({ proxyUrl: 'http://127.0.0.1:9' });
  const origin = await listen(bridge.server);
  try {
    assert.equal((await request(`${origin}/backend-api/codex/models`)).status, 401);
    assert.equal(bridge.stats().httpRequests, 0);
  } finally { await bridge.close(); }
});

test('cancelling a streaming response cancels the upstream request', async () => {
  let sawCancel;
  const cancelled = new Promise(resolve => { sawCancel = resolve; });
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"response.created"}\n\n');
    res.on('close', sawCancel);
  });
  const upstreamOrigin = await listen(upstream);
  const bridge = createTransportBridge({ upstreamOrigin, allowUnauthenticated: true });
  const origin = await listen(bridge.server);
  try {
    await new Promise((resolve, reject) => {
      const req = http.get(`${origin}/backend-api/codex/responses`, res => {
        res.once('data', () => { res.destroy(); resolve(); });
      });
      req.on('error', reject);
    });
    await Promise.race([cancelled, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream was not cancelled')), 1000))]);
  } finally { await bridge.close(); await close(upstream); }
});

test('an unsent oversized request triggers 426 only for the same session', async () => {
  let messages = 0;
  const upstream = http.createServer();
  const upstreamWs = new WebSocketServer({ server: upstream });
  upstreamWs.on('connection', socket => socket.on('message', () => { messages++; }));
  const upstreamOrigin = await listen(upstream);
  const bridge = createTransportBridge({ upstreamOrigin, allowUnauthenticated: true, wsMessageBudgetBytes: 1024 });
  const origin = await listen(bridge.server);
  const url = origin.replace('http:', 'ws:') + '/backend-api/codex/responses';
  const sockets = [];
  try {
    const first = new WebSocket(url, { headers: { 'x-client-request-id': 'fixture-session-a' } }); sockets.push(first);
    await once(first, 'open');
    first.send(JSON.stringify({ type: 'response.create', input: 'x'.repeat(2048) }));
    const [code] = await once(first, 'close');
    assert.equal(code, 1009);
    assert.equal(messages, 0);
    const same = new WebSocket(url, { headers: { 'x-client-request-id': 'fixture-session-a' } }); sockets.push(same);
    const status = await new Promise((resolve, reject) => {
      same.on('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); same.terminate(); });
      same.on('error', () => {});
      same.on('open', () => reject(new Error('same session should select native HTTP fallback')));
    });
    assert.equal(status, 426);
    const other = new WebSocket(url, { headers: { 'x-client-request-id': 'fixture-session-b' } }); sockets.push(other);
    await once(other, 'open');
    assert.equal(bridge.stats().preflightFallbacks, 1);
  } finally {
    for (const socket of sockets) socket.terminate();
    await bridge.close(); upstreamWs.close(); await close(upstream);
  }
});
