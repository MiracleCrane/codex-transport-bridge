import http from 'node:http';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { Transform } from 'node:stream';
import { CancellableProxyAgent } from './cancellable-proxy-agent.mjs';
import { drainAndCloseResponse } from './http-stream-drain.mjs';

const SERVICE_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'http2-settings']);

function relayHeaders(headers) {
  const blocked = new Set(HOP_HEADERS);
  for (const name of String(headers.connection ?? '').split(',')) blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) =>
    value !== undefined && name !== 'host' && !blocked.has(name.toLowerCase()) && !name.startsWith('sec-websocket-')));
}

function allowedTarget(origin, pathPrefix, rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) return null;
  try {
    const target = new URL(rawUrl, origin);
    return target.origin === origin.origin && target.pathname.startsWith(pathPrefix) ? target : null;
  } catch { return null; }
}

function isLoopback(hostname) { return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname); }

export function createHttpTransportServer(options = {}) {
  const origin = new URL(options.upstreamOrigin ?? 'https://chatgpt.com');
  const testMode = options.allowUnauthenticated === true;
  if (testMode ? !isLoopback(origin.hostname) : origin.origin !== 'https://chatgpt.com') {
    throw new Error('Upstream must be the official HTTPS origin, or an explicit loopback test origin.');
  }
  if (!testMode && !options.proxyUrl) throw new Error('Production upstream requires the configured explicit proxy');
  const pathPrefix = options.pathPrefix ?? '/backend-api/codex/';
  const maxBodyBytes = options.maxHttpBodyBytes ?? 256 * 1024 * 1024;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15 * 60 * 1000;
  const responseHeadersTimeoutMs = options.responseHeadersTimeoutMs ?? 180_000;
  const responseDrainTimeoutMs = options.responseDrainTimeoutMs ?? 5_000;
  const closeTimeoutMs = options.closeTimeoutMs ?? 1_000;
  if (!Number.isSafeInteger(responseDrainTimeoutMs) || responseDrainTimeoutMs < 1 || responseDrainTimeoutMs > 30_000
    || !Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 1 || closeTimeoutMs > 10_000) {
    throw new RangeError('Invalid HTTP response drain or close deadline');
  }
  if (!Number.isSafeInteger(responseHeadersTimeoutMs) || responseHeadersTimeoutMs < 1 || responseHeadersTimeoutMs > 900_000) {
    throw new RangeError('responseHeadersTimeoutMs must be between 1 and 900000');
  }
  const proxyAgent = options.proxyUrl ? new CancellableProxyAgent(options.proxyUrl, {
    connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
  }) : undefined;
  const active = new Map();
  const metrics = { httpRequests: 0, httpCompleted: 0, httpErrors: 0, httpCancelled: 0, httpActive: 0,
    httpUploadedBytes: 0, httpDownloadedBytes: 0 };
  const event = (kind, fields = {}) => options.onEvent?.({ kind, ...fields });

  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ready: true, service: "codex-transport-bridge", version: SERVICE_VERSION, instanceId: options.instanceId ?? null, managed: options.managed === true, pid: process.pid, ...metrics, websocket: options.webSocketStats?.() }));
      return;
    }
    const target = allowedTarget(origin, pathPrefix, request.url);
    if (!target || !['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'HEAD'].includes(request.method)) {
      response.writeHead(404); response.end(); return;
    }
    if (!testMode && !/^Bearer\s+\S+/i.test(String(request.headers.authorization ?? ''))) {
      response.writeHead(401); response.end(); return;
    }
    const declaredLength = Number(request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      response.writeHead(413); response.end(); return;
    }
    metrics.httpRequests++; metrics.httpActive++;
    const requestId = metrics.httpRequests;
    const emit = (kind, fields = {}) => event(kind, { requestId, ...fields });
    const started = Date.now();
    let uploaded = 0;
    let downloaded = 0;
    let ended = false;
    let headersReceived = false;
    let headersTimer;
    let callerCancelled = false;
    let responseDraining = false;
    let incomingEnded = false;
    let incomingResponse;
    let upstreamStatus;
    let lastDataAt;
    let upstreamLocalPort;
    const controller = new AbortController();
    const operation = { controller, upstreamEnded: false };
    const headers = relayHeaders(request.headers);
    headers.host = origin.host;
    const upstream = (origin.protocol === 'https:' ? https : http).request(target, {
      method: request.method, headers, agent: proxyAgent, rejectUnauthorized: true, signal: controller.signal,
    });
    proxyAgent?.bindRequest(upstream, controller.signal);
    active.set(upstream, operation);
    const finish = (ok, status) => {
      if (ended) return;
      ended = true;
      clearTimeout(headersTimer);
      active.delete(upstream);
      metrics.httpActive--;
      metrics.httpUploadedBytes += uploaded;
      metrics.httpDownloadedBytes += downloaded;
      if (callerCancelled) metrics.httpCancelled++;
      else if (ok) metrics.httpCompleted++;
      else metrics.httpErrors++;
      emit(callerCancelled ? 'http_cancelled' : ok ? 'http_completed' : 'http_failed', { status, uploadedBytes: uploaded,
        downloadedBytes: downloaded, elapsedMs: Date.now() - started });
    };
    const failResponse = error => {
      if (ended || callerCancelled || responseDraining) return;
      responseDraining = true;
      incomingResponse?.unpipe(response);
      incomingResponse?.pause();
      const errorCode = /^[A-Z0-9_]+$/.test(String(error?.code ?? '')) ? String(error.code) : 'UNCLASSIFIED';
      emit('http_response_error', { errorCode, status: upstreamStatus,
        upstreamComplete: incomingResponse?.complete === true,
        upstreamAborted: incomingResponse?.aborted === true,
        upstreamLocalPort, protocol: incomingResponse?.httpVersion,
        downloadedBytes: downloaded, downstreamBufferedBytes: response.writableLength,
        lastDataAgoMs: lastDataAt === undefined ? null : Math.round(performance.now() - lastDataAt),
        elapsedMs: Date.now() - started });
      void drainAndCloseResponse(response, { timeoutMs: responseDrainTimeoutMs, closeTimeoutMs,
        signal: controller.signal }).then(result => {
        emit('http_response_drain', { ...result, downloadedBytes: downloaded, elapsedMs: Date.now() - started });
        finish(false, upstreamStatus);
      });
    };
    const uploadMeter = new Transform({
      transform(chunk, encoding, callback) {
        uploaded += chunk.length;
        if (uploaded > maxBodyBytes) callback(new Error('Local request-size budget exceeded'));
        else callback(null, chunk);
      },
    });
    uploadMeter.on('error', error => upstream.destroy(error));
    const cancel = () => {
      if (ended || callerCancelled) return;
      const error = Object.assign(new Error('Local caller cancelled'), { code: 'CLIENT_CANCELLED' });
      if (responseDraining) { controller.abort(error); return; }
      callerCancelled = true;
      if (!incomingEnded) {
        controller.abort(error);
        upstream.destroy(error);
      }
      finish(false);
    };
    request.on('aborted', cancel);
    request.on('error', cancel);
    response.on('close', () => { if (!response.writableFinished && !ended && !responseDraining) {
      emit('http_caller_cancelled', { elapsedMs: Date.now() - started, uploadedBytes: uploaded });
      cancel();
    } });
    response.on('finish', () => { if (incomingEnded) finish(true, upstreamStatus); });
    upstream.on('socket', socket => {
      upstreamLocalPort = socket.localPort;
      emit('http_socket_assigned', { elapsedMs: Date.now() - started,
        reusedSocket: upstream.reusedSocket, upstreamLocalPort });
    });
    upstream.on('finish', () => {
      emit('http_request_handed_to_socket', { elapsedMs: Date.now() - started, uploadedBytes: uploaded });
      if (!headersReceived && !ended) {
        headersTimer = setTimeout(() => {
          const error = Object.assign(new Error('Upstream response headers deadline exceeded'), { code: 'UPSTREAM_HEADERS_TIMEOUT' });
          upstream.destroy(error);
          controller.abort(error);
        }, responseHeadersTimeoutMs);
        headersTimer.unref();
      }
    });
    upstream.setTimeout(requestTimeoutMs, () => upstream.destroy(new Error('Upstream idle timeout')));
    upstream.on('response', incoming => {
      incomingResponse = incoming;
      headersReceived = true;
      clearTimeout(headersTimer);
      const status = incoming.statusCode ?? 502;
      upstreamStatus = status;
      emit('http_headers', { status, elapsedMs: Date.now() - started, uploadedBytes: uploaded });
      response.writeHead(status, relayHeaders(incoming.headers));
      incoming.on('data', chunk => { downloaded += chunk.length; lastDataAt = performance.now(); });
      incoming.on('end', () => {
        incomingEnded = true;
        operation.upstreamEnded = true;
        if (response.writableFinished) finish(true, status);
      });
      incoming.on('error', failResponse);
      incoming.pipe(response);
    });
    upstream.on('error', (error) => {
      if (callerCancelled || ended || responseDraining) return;
      const errorCode = /^[A-Z0-9_]+$/.test(String(error?.code ?? '')) ? String(error.code) : 'UNCLASSIFIED';
      emit('http_upstream_error', { errorCode, elapsedMs: Date.now() - started });
      if (headersReceived) { failResponse(error); return; }
      finish(false);
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(['UPSTREAM_CONNECT_TIMEOUT', 'UPSTREAM_HEADERS_TIMEOUT'].includes(errorCode) ? 504 : 502, { 'content-type': 'application/json' });
        response.end('{"error":{"message":"Local transport could not complete the upstream request","type":"transport_error"}}');
      } else response.destroy();
    });
    emit('http_started', { declaredBytes: Number.isFinite(declaredLength) ? declaredLength : null });
    request.pipe(uploadMeter).pipe(upstream);
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  return {
    server,
    stats: () => ({ ...metrics }),
    async close() {
      for (const [request, operation] of active) {
        if (!operation.upstreamEnded) {
          operation.controller.abort(Object.assign(new Error('Bridge stopping'), { code: 'BRIDGE_STOPPING' }));
          request.destroy(new Error('Bridge stopping'));
        }
      }
      proxyAgent?.destroy();
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    },
  };
}
