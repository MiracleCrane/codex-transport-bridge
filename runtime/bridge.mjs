import { createHttpTransportServer } from './http-transport.mjs';
import { attachWebSocketBridge } from './ws-transport.mjs';

export function createTransportBridge(options = {}) {
  const fallbackTtlMs = options.fallbackTtlMs ?? 60 * 60 * 1000;
  const fallback = new Map();
  let preflightFallbacks = 0;
  let websocket;
  const http = createHttpTransportServer({ ...options, webSocketStats: () => websocket?.stats() });
  websocket = attachWebSocketBridge(http.server, {
    upstreamOrigin: options.upstreamOrigin ?? 'https://chatgpt.com',
    pathPrefix: options.pathPrefix ?? '/backend-api/codex/',
    proxyUrl: options.proxyUrl, allowUnauthenticated: options.allowUnauthenticated === true,
    fragmentBytes: options.fragmentBytes ?? 16 * 1024,
    upstreamAckWindowBytes: options.upstreamAckWindowBytes,
    upstreamAckTimeoutMs: options.upstreamAckTimeoutMs,
    upstreamHeartbeatIntervalMs: options.upstreamHeartbeatIntervalMs,
    maxConnections: options.maxConnections ?? 32,
    wsMessageBudgetBytes: options.wsMessageBudgetBytes ?? 16 * 1024 * 1024,
    sessionHeaderNames: ['x-client-request-id'],
    onEvent(record) {
      const operational = ['websocket-error', 'connection-stop', 'connection-close', 'upstream-handshake-error',
        'upstream-pong-timeout', 'upstream-liveness-timeout', 'queue-rejected', 'oversize-unsent', 'upgrade-http-fallback'].includes(record.event);
      if (!options.traceTimings && !operational) return;
      const safe = { kind: options.traceTimings ? 'ws_timing' : 'ws_transport' };
      for (const key of ['event', 'direction', 'bytes', 'binary', 'side', 'connectionId', 'code', 'errorCode', 'elapsedMs', 'firstClose', 'purpose', 'phase', 'probeElapsedMs']) {
        if (['string', 'number', 'boolean'].includes(typeof record[key])) safe[key] = record[key];
      }
      options.onEvent?.(safe);
    },
    onOversize(info) {
      if (typeof info.key !== 'string' || !info.key || info.key.length > 256 || info.forwarded !== false) return;
      for (const [key, expires] of fallback) if (expires < Date.now()) fallback.delete(key);
      if (fallback.size >= 256) fallback.delete(fallback.keys().next().value);
      fallback.set(info.key, Date.now() + fallbackTtlMs);
      preflightFallbacks++;
      options.onEvent?.({ kind: 'ws_unsent_oversize', bytes: info.bytes });
    },
    shouldRejectUpgrade({ key }) {
      const expires = fallback.get(key);
      if (!expires) return false;
      if (expires < Date.now()) { fallback.delete(key); return false; }
      options.onEvent?.({ kind: 'ws_native_http_fallback' });
      return true;
    },
  });
  return {
    server: http.server,
    stats: () => ({ ...http.stats(), preflightFallbacks, websocket: websocket.stats() }),
    async close() { await websocket.close(); await http.close(); },
  };
}
