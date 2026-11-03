// Preserve accepted bytes on an abnormal upstream HTTP EOF. Closing the raw
// socket deliberately does not invent the normal chunked-response terminator.
export function drainAndCloseResponse(response, { timeoutMs, closeTimeoutMs, signal }) {
  return new Promise(resolve => {
    const socket = response.socket;
    let settled = false;
    let flushed = false;
    let drainTimer;
    let closeTimer;
    const finish = reason => {
      if (settled) return;
      settled = true;
      clearTimeout(drainTimer);
      clearTimeout(closeTimer);
      response.off('close', onClose);
      socket?.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (reason !== 'flushed') response.destroy();
      resolve({ drained: flushed, reason });
    };
    const onClose = () => finish(flushed ? 'flushed' : 'downstream_closed');
    const onError = () => finish('downstream_error');
    const onAbort = () => finish('cancelled');
    if (!socket || socket.destroyed || response.destroyed) return finish('downstream_closed');
    if (signal?.aborted) return finish('cancelled');
    response.once('close', onClose);
    socket.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    drainTimer = setTimeout(() => finish('deadline'), timeoutMs);
    drainTimer.unref();
    try {
      response.flushHeaders();
      socket.end(() => {
        if (settled) return;
        flushed = true;
        clearTimeout(drainTimer);
        // Do not keep an owned half-open connection after its accepted writes
        // have drained, even if the remote caller never completes its close.
        closeTimer = setTimeout(() => {
          socket.destroy();
          finish('flushed');
        }, closeTimeoutMs);
        closeTimer.unref();
      });
    } catch { finish('downstream_error'); }
  });
}
