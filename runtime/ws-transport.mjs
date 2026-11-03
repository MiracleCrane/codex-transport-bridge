import { setImmediate as yieldToIo } from 'node:timers/promises';
import { isIP } from 'node:net';
import { STATUS_CODES } from 'node:http';
import { randomBytes } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { CancellableProxyAgent } from './cancellable-proxy-agent.mjs';

const MIB = 1024 * 1024;
const UPSTREAM_HANDSHAKE = Symbol('upstreamHandshake');
const HOP_HEADERS = new Set([
  'connection', 'upgrade', 'host', 'keep-alive', 'transfer-encoding',
  'content-length', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer',
]);

function abortError() {
  return Object.assign(new Error('WebSocket forwarding cancelled'), { name: 'AbortError' });
}

function asBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('WebSocket data must be bytes');
}

function sendFrame(ws, bytes, options, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || ws.readyState !== WebSocket.OPEN) return reject(abortError());
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      ws.off('close', onClose);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(abortError());
    const onClose = () => finish(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    ws.once('close', onClose);
    try {
      ws.send(bytes, options, finish);
    } catch (error) {
      finish(error);
    }
  });
}

function confirmRemoteProgress(ws, timeoutMs, signal, onWritten) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || ws.readyState !== WebSocket.OPEN) return reject(abortError());
    const nonce = randomBytes(16);
    const started = performance.now();
    let settled = false;
    let written = false;
    let acknowledged = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      ws.off('pong', onPong);
      ws.off('close', onClose);
      ws.off('error', onError);
      if (error) reject(error);
      else resolve(performance.now() - started);
    };
    const onAbort = () => finish(abortError());
    const onClose = () => finish(abortError());
    const onError = () => finish(new Error('WebSocket failed awaiting remote Pong'));
    const onPong = (payload) => {
      if (payload.length !== nonce.length || !payload.equals(nonce)) return;
      acknowledged = true;
      if (written) finish();
    };
    const timer = setTimeout(() => finish(Object.assign(
      new Error('Remote WebSocket Pong confirmation timed out'),
      { code: 'WS_ACK_TIMEOUT', phase: written ? 'awaiting_pong' : 'write_pending' },
    )), timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
    ws.on('pong', onPong);
    ws.once('close', onClose);
    ws.once('error', onError);
    try {
      // The nonce is unrelated to account, session, message, or image contents.
      // TCP order means its matching Pong confirms the preceding window reached
      // the remote WS reader, beyond a fast local proxy's outbound buffer.
      ws.ping(nonce, undefined, (error) => {
        if (error) return finish(error);
        written = true;
        onWritten?.();
        if (acknowledged) finish();
      });
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * Send one logical message. Byte slices may split a UTF-8 code point: continuation
 * frames are reassembled before UTF-8 validation. Never decode/re-encode its body.
 * Frame callbacks bound only the local sender queue. Optional matching-Pong
 * windows also bound progress ahead of a buffering proxy. No body is rewritten.
 */
export async function sendFragmentedMessage(ws, data, {
  binary = false,
  fragmentBytes = 16 * 1024,
  compress = true,
  signal,
  onFragment,
  ackWindowBytes = 0,
  ackTimeoutMs = 25_000,
  onAck,
  progressProbe,
  pacingState = { bytesSinceAck: 0 },
} = {}) {
  const bytes = asBuffer(data);
  if (!Number.isSafeInteger(fragmentBytes) || fragmentBytes < 1 || fragmentBytes > 16 * 1024) {
    throw new RangeError('fragmentBytes must be between 1 and 16384');
  }
  if (!Number.isSafeInteger(ackWindowBytes) || ackWindowBytes < 0 || ackWindowBytes > MIB
    || !Number.isSafeInteger(ackTimeoutMs) || ackTimeoutMs < 1 || ackTimeoutMs > 30_000) {
    throw new RangeError('Invalid remote Pong window settings');
  }
  const acknowledge = async () => {
    const elapsedMs = await (progressProbe
      ? progressProbe('upload')
      : confirmRemoteProgress(ws, ackTimeoutMs, signal));
    pacingState.bytesSinceAck = 0;
    onAck?.(elapsedMs);
  };
  // A sender queue shares this credit across logical messages. A final tail may
  // skip an extra Ping, but cannot let many small messages accumulate unchecked.
  if (ackWindowBytes && pacingState.bytesSinceAck >= ackWindowBytes) await acknowledge();
  let offset = 0;
  do {
    if (signal?.aborted) throw abortError();
    const end = Math.min(offset + fragmentBytes, bytes.length);
    await sendFrame(ws, bytes.subarray(offset, end), {
      binary,
      compress,
      fin: end === bytes.length,
    }, signal);
    onFragment?.(end - offset);
    if (ackWindowBytes) pacingState.bytesSinceAck += end - offset;
    offset = end;
    await yieldToIo();
    if (ackWindowBytes && pacingState.bytesSinceAck >= ackWindowBytes && offset < bytes.length) {
      await acknowledge();
    }
  } while (offset < bytes.length);
}

function isLoopback(value) {
  const host = String(value ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '::1') return true;
  const ipv4 = host.startsWith('::ffff:') ? host.slice(7) : host;
  return isIP(ipv4) === 4 && ipv4.startsWith('127.');
}

function boundedInteger(value, fallback, min, max, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new RangeError(`Invalid ${name}`);
  }
  return result;
}

function normalizeOptions(options) {
  const upstream = new URL(options.upstreamOrigin ?? 'https://chatgpt.com');
  const testMode = options.allowUnauthenticated === true && isLoopback(upstream.hostname);
  if (options.allowUnauthenticated === true && !testMode) {
    throw new TypeError('Unauthenticated upstreams must be literal loopback addresses');
  }
  if (upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname !== '/') {
    throw new TypeError('upstreamOrigin must be an origin without credentials');
  }
  if (testMode) {
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(upstream.protocol)) {
      throw new TypeError('Invalid loopback upstream protocol');
    }
  } else if (upstream.hostname !== 'chatgpt.com' || !['https:', 'wss:'].includes(upstream.protocol) || upstream.port) {
    throw new TypeError('Production upstream must be chatgpt.com over TLS');
  }
  if (!testMode && !options.proxyUrl) {
    throw new TypeError('Production upstream requires the configured explicit proxy');
  }
  const prefix = options.pathPrefix ?? '/backend-api/codex/';
  if (!/^\/[A-Za-z0-9_/-]+\/$/.test(prefix) || prefix.includes('//')) {
    throw new TypeError('Invalid pathPrefix');
  }
  const sessionHeaderNames = (options.sessionHeaderNames ?? []).map((name) => {
    const lower = String(name).toLowerCase();
    if (!/^[a-z0-9-]+$/.test(lower) || /authorization|cookie|token|secret|api-key/.test(lower)) {
      throw new TypeError('Session key headers must not be credential headers');
    }
    return lower;
  });
  upstream.protocol = ['http:', 'ws:'].includes(upstream.protocol) ? 'ws:' : 'wss:';
  return {
    ...options,
    upstream,
    testMode,
    pathPrefix: prefix,
    sessionHeaderNames,
    fragmentBytes: boundedInteger(options.fragmentBytes, 16 * 1024, 1, 16 * 1024, 'fragmentBytes'),
    upstreamAckWindowBytes: boundedInteger(options.upstreamAckWindowBytes, 128 * 1024, testMode ? 0 : 1, MIB, 'upstreamAckWindowBytes'),
    upstreamAckTimeoutMs: boundedInteger(options.upstreamAckTimeoutMs, 25_000, 50, 30_000, 'upstreamAckTimeoutMs'),
    upstreamHeartbeatIntervalMs: boundedInteger(options.upstreamHeartbeatIntervalMs, 15_000, testMode ? 0 : 1000, 60_000, 'upstreamHeartbeatIntervalMs'),
    wsMessageBudgetBytes: boundedInteger(options.wsMessageBudgetBytes, 16 * MIB, 1, 16 * MIB, 'wsMessageBudgetBytes'),
    maxMessageBytes: boundedInteger(options.maxMessageBytes, 32 * MIB, 1, 64 * MIB, 'maxMessageBytes'),
    maxQueuedBytes: boundedInteger(options.maxQueuedBytes, 48 * MIB, 1, 128 * MIB, 'maxQueuedBytes'),
    maxQueuedMessages: boundedInteger(options.maxQueuedMessages, 8, 1, 128, 'maxQueuedMessages'),
    maxQueuedDownstreamMessages: boundedInteger(options.maxQueuedDownstreamMessages, 4096, 1, 65536, 'maxQueuedDownstreamMessages'),
    maxConnections: boundedInteger(options.maxConnections, 8, 1, 64, 'maxConnections'),
    handshakeTimeoutMs: boundedInteger(options.handshakeTimeoutMs, 15_000, 50, 120_000, 'handshakeTimeoutMs'),
    closeTimeoutMs: boundedInteger(options.closeTimeoutMs, 1_000, 10, 10_000, 'closeTimeoutMs'),
    closeDrainTimeoutMs: boundedInteger(options.closeDrainTimeoutMs, 5_000, 50, 30_000, 'closeDrainTimeoutMs'),
  };
}

function opaqueKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value) ? value : null;
}

function handshakeKey(request, names) {
  for (const name of names) {
    const key = opaqueKey(request.headers[name]);
    if (key) return key;
  }
  return null;
}

function oversizedResponse(bytes, binary, key, budget) {
  if (binary || bytes.length < budget) return null;
  try {
    const body = JSON.parse(bytes.toString('utf8'));
    if (body?.type !== 'response.create') return null;
    const metadata = body.client_metadata;
    return {
      key: key ?? opaqueKey(metadata?.session_id) ?? opaqueKey(metadata?.thread_id),
      bytes: bytes.length,
      messageType: 'response.create',
      forwarded: false,
    };
  } catch {
    // Non-JSON messages remain opaque; the receiver's payload limit still applies.
    return null;
  }
}

function endToEndHeaders(headers) {
  const connectionTokens = String(headers.connection ?? '').toLowerCase().split(',').map((s) => s.trim());
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_HEADERS.has(name) || name.startsWith('sec-websocket-') || connectionTokens.includes(name)) continue;
    result[name] = value;
  }
  return result;
}

function endRawSocket(socket, data) {
  if (socket.destroyed || socket.writableEnded) return;
  socket.end(data);
  const timer = setTimeout(() => socket.destroy(), 1_000);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
}

function rejectUpgrade(socket, status, responseHeaders = {}) {
  if (socket.destroyed || socket.writableEnded) return;
  const reason = STATUS_CODES[status] ?? 'Bad Gateway';
  const body = `${reason}\n`;
  const extra = [];
  for (const [name, value] of Object.entries(endToEndHeaders(responseHeaders))) {
    if (name === 'content-type' || name === 'content-encoding') continue;
    for (const entry of Array.isArray(value) ? value : [value]) extra.push(`${name}: ${entry}`);
  }
  endRawSocket(socket, [
    `HTTP/1.1 ${status} ${reason}`, 'Connection: close', 'Content-Type: text/plain',
    `Content-Length: ${Buffer.byteLength(body)}`, ...extra, '', body,
  ].join('\r\n'));
}

function closeSocket(ws, code, reason) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.CONNECTING || code === 1005 || code === 1006 || code === 1015) {
    ws.terminate();
    return;
  }
  try { ws.close(code, reason); } catch { ws.terminate(); }
}

function forwardUpgradeRefusal(response, socket, complete) {
  const status = response.statusCode;
  if (!Number.isInteger(status) || status < 300 || status > 599) {
    response.destroy();
    rejectUpgrade(socket, 502);
    complete();
    return;
  }
  const lines = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Upstream Refusal'}`, 'Connection: close'];
  for (const [name, value] of Object.entries(endToEndHeaders(response.headers))) {
    for (const entry of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${entry}`);
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  let bytes = 0;
  let finished = false;
  const finish = (failed = false) => {
    if (finished) return;
    finished = true;
    socket.off('drain', resume);
    socket.off('close', cancelled);
    if (failed) { response.destroy(); socket.destroy(); }
    else endRawSocket(socket);
    complete();
  };
  const resume = () => response.resume();
  const cancelled = () => finish(true);
  socket.on('drain', resume);
  socket.once('close', cancelled);
  response.on('data', (data) => {
    bytes += data.length;
    if (bytes > 256 * 1024) return finish(true);
    if (!socket.write(data)) response.pause();
  });
  response.once('end', () => finish());
  response.once('aborted', () => finish(true));
  response.once('error', () => finish(true));
}

function createQueue(pair, target, direction, options, counters, emit) {
  const queue = [];
  const drainWaiters = new Set();
  let accepting = true;
  let cancelled = false;
  // Responses can arrive as a burst of many small events in one socket read.
  // Keep upload admission strict without rejecting ordinary streamed output.
  const maxMessages = direction === 'downstream'
    ? options.maxQueuedDownstreamMessages : options.maxQueuedMessages;
  const pacingState = { bytesSinceAck: 0 };
  let active = false;
  let bytes = 0;
  let messages = 0;
  const notifyDrained = (ok) => {
    for (const finish of drainWaiters) finish(ok);
    drainWaiters.clear();
  };
  const cancel = () => {
    accepting = false;
    cancelled = true;
    queue.length = 0; bytes = 0; messages = 0;
    notifyDrained(false);
  };
  const drain = async () => {
    active = true;
    try {
      while (queue.length && !pair.stopping && !cancelled) {
        const message = queue.shift();
        await sendFragmentedMessage(target, message.data, {
          binary: message.binary,
          fragmentBytes: options.fragmentBytes,
          compress: direction === 'upstream',
          signal: pair.controller.signal,
          ackWindowBytes: direction === 'upstream' ? options.upstreamAckWindowBytes : 0,
          ackTimeoutMs: options.upstreamAckTimeoutMs,
          pacingState,
          progressProbe: direction === 'upstream' ? pair.probeRemoteProgress : undefined,
          onAck(elapsedMs) {
            counters.upstreamAcks += 1;
            counters.upstreamAckMaxMs = Math.max(counters.upstreamAckMaxMs, Math.round(elapsedMs));
          },
          onFragment(length) {
            counters[direction === 'upstream' ? 'upstreamFragments' : 'downstreamFragments'] += 1;
            counters[direction === 'upstream' ? 'upstreamBytes' : 'downstreamBytes'] += length;
          },
        });
        if (pair.stopping || cancelled) break;
        bytes -= message.data.length;
        messages -= 1;
        counters[direction === 'upstream' ? 'upstreamMessages' : 'downstreamMessages'] += 1;
        emit('message-forwarded', { direction, bytes: message.data.length, binary: message.binary });
      }
    } catch (error) {
      if (error?.code === 'WS_ACK_TIMEOUT') {
        counters.upstreamAckTimeouts += 1;
        emit('upstream-pong-timeout', { phase: error.phase });
      }
      if (!pair.stopping && !(direction === 'upstream' && pair.upstreamEnded)) {
        if (direction === 'upstream') void pair.failUpstream('bridge upstream forwarding failed');
        else pair.stop(1011, 'bridge forwarding failed');
      }
    } finally {
      active = false;
      if (queue.length === 0) notifyDrained(!cancelled);
    }
  };
  return {
    cancel,
    finish(timeoutMs) {
      accepting = false;
      if (cancelled) return Promise.resolve(false);
      if (!active && !queue.length) return Promise.resolve(true);
      return new Promise(resolve => {
        const done = ok => { clearTimeout(timer); drainWaiters.delete(done); resolve(ok); };
        const timer = setTimeout(() => done(false), timeoutMs);
        timer.unref();
        drainWaiters.add(done);
      });
    },
    enqueue(data, binary) {
      if (pair.stopping || !accepting) return;
      if (bytes + data.length > options.maxQueuedBytes || messages + 1 > maxMessages) {
        counters.queueRejected += 1;
        emit('queue-rejected', { direction });
        pair.stop(1008, 'bridge queue limit');
        return;
      }
      bytes += data.length;
      messages += 1;
      queue.push({ data, binary });
      if (!active) void drain();
    },
  };
}

/**
 * Attach only the WebSocket upgrade lane. The caller owns the HTTP server.
 * No request/response body, credential, cookie, URL query, or raw error is logged.
 * onOversize is advisory and never replays data. A subsequent upgrade can be
 * refused with 426 by shouldRejectUpgrade, letting Codex choose its own HTTP path.
 */
export function attachWebSocketBridge(server, suppliedOptions = {}) {
  const options = normalizeOptions(suppliedOptions);
  const agent = options.proxyUrl ? new CancellableProxyAgent(options.proxyUrl, {
    connectTimeoutMs: options.handshakeTimeoutMs, keepAlive: false,
  }) : undefined;
  const pairs = new Set();
  const pending = new Set();
  const counters = {
    accepted: 0, closed: 0, upstreamMessages: 0, downstreamMessages: 0,
    upstreamFragments: 0, downstreamFragments: 0, upstreamBytes: 0, downstreamBytes: 0,
    upstreamPings: 0, downstreamPings: 0, oversizeRejected: 0, queueRejected: 0,
    upstreamAcks: 0, upstreamAckMaxMs: 0, upstreamAckTimeouts: 0,
    upstreamProbes: 0, upstreamProbeAcks: 0,
    upstreamLivenessChecks: 0, upstreamLivenessTimeouts: 0,
    upgradeFallbacks: 0, handshakeErrors: 0, closeDrainTimeouts: 0,
  };
  let shuttingDown = false;
  let closePromise;
  const emit = (event, fields = {}) => {
    try { options.onEvent?.({ event, ...fields }); } catch { /* Telemetry cannot alter transport. */ }
  };
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    autoPong: true,
    perMessageDeflate: false,
    maxPayload: options.maxMessageBytes,
    closeTimeout: options.closeTimeoutMs,
    handleProtocols: (_protocols, request) => request[UPSTREAM_HANDSHAKE]?.protocol || false,
  });
  wss.on('headers', (headers, request) => {
    for (const [name, value] of Object.entries(request[UPSTREAM_HANDSHAKE]?.headers ?? {})) {
      for (const entry of Array.isArray(value) ? value : [value]) headers.push(`${name}: ${entry}`);
    }
  });
  wss.on('error', () => emit('local-websocket-error'));

  function connectPair(downstream, upstream, key) {
    counters.accepted += 1;
    const connectionId = counters.accepted;
    const connectionStarted = Date.now();
    let resolveDone;
    let terminationTimer;
    let upstreamFailureTimer;
    let heartbeatTimer;
    let pendingProbe;
    let lastConfirmedAt = performance.now();
    let closeDrainStarted = false;
    const emitPair = (event, fields = {}) => emit(event, {
      connectionId, elapsedMs: Date.now() - connectionStarted, ...fields,
    });
    const pair = {
      downstream, upstream,
      controller: new AbortController(),
      stopping: false,
      upstreamEnded: false,
      done: new Promise((resolve) => { resolveDone = resolve; }),
      stop(code, reason, source) {
        if (pair.stopping) return;
        emit('connection-stop', { connectionId, code, elapsedMs: Date.now() - connectionStarted,
          side: source === upstream ? 'upstream' : source === downstream ? 'downstream' : 'bridge' });
        pair.stopping = true;
        clearTimeout(upstreamFailureTimer);
        clearTimeout(heartbeatTimer);
        pair.controller.abort();
        upQueue.cancel();
        downQueue.cancel();
        if (source !== downstream) closeSocket(downstream, code, reason);
        if (source !== upstream) closeSocket(upstream, code, reason);
        terminationTimer = setTimeout(() => {
          if (downstream.readyState !== WebSocket.CLOSED) downstream.terminate();
          if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
        }, options.closeTimeoutMs);
        terminationTimer.unref();
        releaseIfClosed();
      },
      failUpstream(reason) { return finishUpstream(1011, reason, true); },
      probeRemoteProgress(purpose) {
        // Serialize probes, but an earlier heartbeat cannot acknowledge upload
        // bytes sent after its Ping. That window needs a fresh ordered probe.
        if (pendingProbe) return purpose === 'upload'
          ? pendingProbe.then(() => pair.probeRemoteProgress(purpose))
          : pendingProbe;
        pendingProbe = (async () => {
          counters.upstreamProbes += 1;
          emitPair('upstream-probe-started', { purpose });
          try {
            const elapsedMs = await confirmRemoteProgress(upstream, options.upstreamAckTimeoutMs,
              pair.controller.signal, () => emitPair('upstream-probe-written', { purpose }));
            lastConfirmedAt = performance.now();
            counters.upstreamProbeAcks += 1;
            emitPair('upstream-probe-confirmed', { purpose, probeElapsedMs: Math.round(elapsedMs) });
            return elapsedMs;
          } finally { pendingProbe = null; }
        })();
        return pendingProbe;
      },
    };
    const upQueue = createQueue(pair, upstream, 'upstream', options, counters, emitPair);
    const downQueue = createQueue(pair, downstream, 'downstream', options, counters, emitPair);
    function scheduleHeartbeat() {
      if (!options.upstreamHeartbeatIntervalMs || pair.stopping || pair.upstreamEnded) return;
      clearTimeout(heartbeatTimer);
      const waitMs = Math.max(1, options.upstreamHeartbeatIntervalMs - (performance.now() - lastConfirmedAt));
      heartbeatTimer = setTimeout(checkLiveness, waitMs);
      heartbeatTimer.unref();
    }
    async function checkLiveness() {
      if (pair.stopping || pair.upstreamEnded || upstream.readyState !== WebSocket.OPEN) return;
      if (performance.now() - lastConfirmedAt < options.upstreamHeartbeatIntervalMs) {
        scheduleHeartbeat();
        return;
      }
      counters.upstreamLivenessChecks += 1;
      try { await pair.probeRemoteProgress('liveness'); }
      catch (error) {
        if (pair.stopping || pair.upstreamEnded) return;
        if (error?.code === 'WS_ACK_TIMEOUT') {
          counters.upstreamLivenessTimeouts += 1;
          emitPair('upstream-liveness-timeout', { phase: error.phase });
        }
        // Silence from the model is allowed indefinitely while transport Pongs
        // arrive. Only failed transport confirmation enters the close path.
        await pair.failUpstream('upstream liveness confirmation failed');
      }
      scheduleHeartbeat();
    }
    async function finishUpstream(code, reason, closeLiveUpstream = false) {
      if (pair.stopping || closeDrainStarted) return;
      closeDrainStarted = true;
      clearTimeout(upstreamFailureTimer);
      clearTimeout(heartbeatTimer);
      pair.upstreamEnded = true;
      upQueue.cancel();
      if (closeLiveUpstream) closeSocket(upstream, code, reason);
      // A received close frame must not overtake complete messages already in
      // the local queue (in particular response.completed).
      const drained = await downQueue.finish(options.closeDrainTimeoutMs);
      if (pair.stopping) return;
      if (!drained) {
        counters.closeDrainTimeouts += 1;
        pair.stop(1011, 'downstream close drain timed out', upstream);
      } else if ([1005, 1006, 1015].includes(code)) {
        // Reserved close codes cannot be sent on the wire. Use an error close
        // handshake, which also flushes the sender, instead of destroying it.
        pair.stop(1011, 'upstream connection ended unexpectedly', upstream);
      } else {
        pair.stop(code, reason, upstream);
      }
    }
    function releaseIfClosed() {
      if (downstream.readyState !== WebSocket.CLOSED || upstream.readyState !== WebSocket.CLOSED || !pairs.has(pair)) return;
      clearTimeout(terminationTimer);
      clearTimeout(heartbeatTimer);
      pairs.delete(pair);
      counters.closed += 1;
      resolveDone();
    }
    function rejectUnsentOversize(info, reason) {
      counters.oversizeRejected += 1;
      emit('oversize-unsent', info.bytes === null ? { limitBytes: info.limitBytes } : { bytes: info.bytes });
      // Update the caller's cache synchronously before the client can reconnect.
      // Only complete message events enter upQueue, so a Receiver length error
      // also guarantees the rejected current message has never been forwarded.
      try {
        const result = options.onOversize?.(info);
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(() => {});
          pair.stop(1011, 'onOversize must update synchronously');
          return;
        }
      } catch {
        pair.stop(1011, 'local fallback notification failed');
        return;
      }
      pair.stop(1009, reason);
    }
    pairs.add(pair);
    downstream.on('ping', () => { counters.downstreamPings += 1; });
    upstream.on('ping', () => { counters.upstreamPings += 1; });
    for (const [ws, side] of [[downstream, 'downstream'], [upstream, 'upstream']]) {
      ws.on('error', (error) => {
        const errorCode = /^[A-Z0-9_]+$/.test(String(error?.code ?? '')) ? String(error.code) : 'UNCLASSIFIED';
        emit('websocket-error', { side, connectionId, errorCode, elapsedMs: Date.now() - connectionStarted });
        if (!pair.stopping && ws === upstream) {
          pair.upstreamEnded = true;
          upQueue.cancel();
          if (!upstreamFailureTimer) {
            upstreamFailureTimer = setTimeout(() => { void finishUpstream(1011, 'upstream transport error'); }, options.closeTimeoutMs);
            upstreamFailureTimer.unref();
          }
          return;
        }
        if (!pair.stopping && ws === downstream && key && error?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
          rejectUnsentOversize({
            key,
            bytes: null,
            messageType: 'unknown',
            forwarded: false,
            reason: 'local-receive-limit',
            limitBytes: options.maxMessageBytes,
          }, 'local unsent message exceeds receive limit');
          return;
        }
        pair.stop(1011, 'bridge transport error');
      });
      ws.on('close', (code, reason) => {
        emit('connection-close', { side, code, connectionId, elapsedMs: Date.now() - connectionStarted,
          firstClose: !pair.stopping });
        if (ws === upstream && !pair.stopping) void finishUpstream(code, reason);
        else pair.stop(code, reason, ws);
        releaseIfClosed();
      });
    }
    downstream.on('message', (raw, binary) => {
      if (pair.stopping) return;
      const data = asBuffer(raw);
      const oversize = oversizedResponse(data, binary, key, options.wsMessageBudgetBytes);
      if (oversize) {
        rejectUnsentOversize(oversize, 'local unsent response.create exceeds websocket budget');
        return;
      }
      upQueue.enqueue(data, binary);
    });
    upstream.on('message', (raw, binary) => downQueue.enqueue(asBuffer(raw), binary));
    emit('websocket-connected', { connectionId });
    scheduleHeartbeat();
  }

  async function upgrade(request, socket, head) {
    const operation = { socket, upstream: null };
    if (shuttingDown || pairs.size + pending.size >= options.maxConnections) return rejectUpgrade(socket, 503);
    if (!isLoopback(socket.remoteAddress)) return rejectUpgrade(socket, 403);
    if (request.method !== 'GET' || !request.url?.startsWith('/')) return rejectUpgrade(socket, 400);
    let path;
    try { path = new URL(request.url, 'http://localhost'); } catch { return rejectUpgrade(socket, 400); }
    if (!path.pathname.startsWith(options.pathPrefix) || path.hash) return rejectUpgrade(socket, 404);
    if (!options.testMode && (typeof request.headers.authorization !== 'string' || !request.headers.authorization.trim())) {
      return rejectUpgrade(socket, 401);
    }
    const key = handshakeKey(request, options.sessionHeaderNames);
    pending.add(operation);
    const cancelPending = () => operation.upstream?.terminate();
    const pendingEnded = () => { cancelPending(); socket.destroy(); };
    const prematureData = () => {
      rejectUpgrade(socket, 400);
      cancelPending();
    };
    socket.once('close', cancelPending);
    socket.once('end', pendingEnded);
    socket.once('data', prematureData);
    // An upgraded raw HTTP socket is otherwise paused until ws owns it. Keep
    // reading EOF while the remote handshake is pending, so cancellation does
    // not wait for the upstream handshake timeout. RFC clients send frames only
    // after receiving 101; premature application bytes are explicitly refused.
    socket.resume();
    try {
      if (await options.shouldRejectUpgrade?.({ key, pathname: path.pathname })) {
        counters.upgradeFallbacks += 1;
        emit('upgrade-http-fallback');
        rejectUpgrade(socket, 426);
        return;
      }
      if (shuttingDown || socket.destroyed) return;
      const protocols = typeof request.headers['sec-websocket-protocol'] === 'string'
        ? request.headers['sec-websocket-protocol'].split(',').map((entry) => entry.trim()) : [];
      const upstream = new WebSocket(`${options.upstream.origin}${path.pathname}${path.search}`, protocols, {
        headers: endToEndHeaders(request.headers),
        agent,
        rejectUnauthorized: true,
        followRedirects: false,
        handshakeTimeout: options.handshakeTimeoutMs,
        closeTimeout: options.closeTimeoutMs,
        maxPayload: options.maxMessageBytes,
        autoPong: true,
        perMessageDeflate: true,
      });
      operation.upstream = upstream;
      await new Promise((resolve) => {
        let settled = false;
        let responseHeaders = {};
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        upstream.on('upgrade', (response) => { responseHeaders = endToEndHeaders(response.headers); });
        upstream.on('error', () => {
          if (settled) return;
          counters.handshakeErrors += 1;
          emit('upstream-handshake-error');
          rejectUpgrade(socket, 502);
          finish();
        });
        upstream.once('close', () => {
          if (!settled) rejectUpgrade(socket, 502);
          finish();
        });
        upstream.once('unexpected-response', (clientRequest, response) => {
          counters.handshakeErrors += 1;
          // Preserve the actual refusal status (notably 426); never synthesize a
          // Responses event or replay the rejected request through HTTP here.
          forwardUpgradeRefusal(response, socket, () => {
            finish();
            clientRequest.destroy();
            upstream.terminate();
          });
        });
        upstream.once('open', () => {
          if (shuttingDown || socket.destroyed) {
            upstream.terminate();
            finish();
            return;
          }
          request[UPSTREAM_HANDSHAKE] = { headers: responseHeaders, protocol: upstream.protocol };
          try {
            socket.pause();
            socket.off('data', prematureData);
            socket.off('end', pendingEnded);
            wss.handleUpgrade(request, socket, head, (downstream) => {
              socket.off('close', cancelPending);
              connectPair(downstream, upstream, key);
              socket.resume();
              finish();
            });
          } catch {
            upstream.terminate();
            rejectUpgrade(socket, 400);
            finish();
          }
        });
      });
    } catch {
      operation.upstream?.terminate();
      rejectUpgrade(socket, 502);
    } finally {
      pending.delete(operation);
      socket.off('close', cancelPending);
      socket.off('end', pendingEnded);
      socket.off('data', prematureData);
    }
  }

  const onUpgrade = (request, socket, head) => {
    socket.on('error', () => emit('local-socket-error'));
    void upgrade(request, socket, head);
  };
  const onServerClose = () => { void close(); };
  server.on('upgrade', onUpgrade);
  server.once('close', onServerClose);
  function close() {
    if (closePromise) return closePromise;
    shuttingDown = true;
    server.off('upgrade', onUpgrade);
    server.off('close', onServerClose);
    for (const operation of pending) {
      operation.upstream?.terminate();
      operation.socket.destroy();
    }
    const waiting = [...pairs].map((pair) => {
      pair.stop(1001, 'bridge shutting down');
      return pair.done;
    });
    closePromise = Promise.all(waiting).then(() => new Promise((resolve) => {
      wss.close(() => { agent?.destroy(); resolve(); });
    }));
    return closePromise;
  }
  return {
    close,
    stats: () => ({
      ...counters,
      activeConnections: pairs.size,
      pendingConnections: pending.size,
      upstreamAckWindowBytes: options.upstreamAckWindowBytes,
      upstreamAckTimeoutMs: options.upstreamAckTimeoutMs,
      upstreamHeartbeatIntervalMs: options.upstreamHeartbeatIntervalMs,
    }),
  };
}
