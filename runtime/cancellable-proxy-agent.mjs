import { HttpsProxyAgent } from 'https-proxy-agent';

function transportError(message, code) { return Object.assign(new Error(message), { code }); }

function waitForSecureSocket(socket, signal) {
  if (!socket.encrypted || socket.authorized === true) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('secureConnect', onReady);
      socket.off('error', onError);
      socket.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = error => {
      if (error) {
        // Abort destroys the raw tunnel first; the wrapping TLS socket can emit
        // its error on the following tick, after this promise has rejected.
        const consumeClosingError = () => {};
        socket.on('error', consumeClosingError);
        socket.once('close', () => socket.off('error', consumeClosingError));
      }
      cleanup();
      error ? reject(error) : resolve();
    };
    const onReady = () => finish();
    const onError = error => finish(error);
    const onClose = () => finish(transportError('TLS socket closed before handshake completed', 'UPSTREAM_TLS_CLOSED'));
    const onAbort = () => finish(signal.reason);
    socket.once('secureConnect', onReady);
    socket.once('error', onError);
    socket.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

// Pool ownership is separate from connection setup. A request can cancel its
// pending CONNECT/TLS socket, but cannot retain an abort hook on a pooled socket.
export class CancellableProxyAgent extends HttpsProxyAgent {
  constructor(proxyUrl, { connectTimeoutMs = 15_000, keepAlive = true } = {}) {
    super(proxyUrl, { keepAlive, maxSockets: 32, maxFreeSockets: 8, timeout: 30_000 });
    if (!Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > 120_000) {
      throw new RangeError('connectTimeoutMs must be between 1 and 120000');
    }
    this.proxyUrl = proxyUrl;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestSignals = new WeakMap();
    this.connecting = new Set();
  }

  bindRequest(request, signal) { this.requestSignals.set(request, signal); }

  async connect(request, options) {
    // https.request returns before its caller binds the request-specific signal.
    await Promise.resolve();
    const callerSignal = this.requestSignals.get(request);
    const controller = new AbortController();
    const abort = reason => {
      if (!controller.signal.aborted) controller.abort(reason || transportError('Connection cancelled', 'UPSTREAM_CONNECT_CANCELLED'));
    };
    const onCallerAbort = () => abort(callerSignal.reason);
    const onRequestAbort = () => abort(transportError('Request cancelled during connection', 'UPSTREAM_CONNECT_CANCELLED'));
    const timer = setTimeout(() => abort(transportError('Proxy connection deadline exceeded', 'UPSTREAM_CONNECT_TIMEOUT')), this.connectTimeoutMs);
    timer.unref();
    this.connecting.add(controller);
    request.once('abort', onRequestAbort);
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    if (callerSignal?.aborted || request.destroyed) abort(callerSignal?.reason);
    let socket;
    try {
      // A separate connector supplies a per-connection AbortSignal to the raw
      // net/tls socket before CONNECT. The outer agent owns the returned pool.
      const connector = new HttpsProxyAgent(this.proxyUrl, { signal: controller.signal });
      socket = await connector.connect(request, options);
      await waitForSecureSocket(socket, controller.signal);
      if (controller.signal.aborted || request.destroyed) {
        throw controller.signal.reason || transportError('Request cancelled during connection', 'UPSTREAM_CONNECT_CANCELLED');
      }
      return socket;
    } catch (error) {
      socket?.destroy();
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      this.connecting.delete(controller);
      callerSignal?.removeEventListener('abort', onCallerAbort);
      request.off('abort', onRequestAbort);
      this.requestSignals.delete(request);
    }
  }

  destroy() {
    for (const controller of this.connecting) {
      controller.abort(transportError('Proxy agent stopping', 'UPSTREAM_CONNECT_CANCELLED'));
    }
    super.destroy();
  }
}
