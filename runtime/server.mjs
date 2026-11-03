import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const port = Number(args.get('--port') ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid loopback port');
const proxyUrl = args.get('--proxy');
if (!proxyUrl) throw new Error('Provide the verified local HTTP proxy with --proxy');
const proxy = new URL(proxyUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(proxy.hostname) || proxy.username || proxy.password) {
  throw new Error('Use the already-configured local proxy without inline credentials');
}
const httpOnly = args.get('--http-only') === 'true';
const eventOutput = args.has('--event-log') ? createWriteStream(args.get('--event-log'), { flags: 'a' }) : process.stdout;
if (eventOutput !== process.stdout) eventOutput.on('error', () => process.stderr.write('Diagnostic event log unavailable\n'));
const createTransportBridge = httpOnly
  ? (await import('./http-transport.mjs')).createHttpTransportServer
  : (await import('./bridge.mjs')).createTransportBridge;
const managed = args.get('--managed') === 'true';
const instanceId = args.get('--instance-id') ?? null;
if (instanceId !== null && !/^[a-f0-9-]{36}$/i.test(instanceId)) throw new Error('Invalid instance identifier');
const bridge = createTransportBridge({
  proxyUrl, managed, instanceId,
  upstreamAckWindowBytes: args.has('--ack-window') ? Number(args.get('--ack-window')) : undefined,
  upstreamAckTimeoutMs: args.has('--ack-timeout') ? Number(args.get('--ack-timeout')) : undefined,
  upstreamHeartbeatIntervalMs: args.has('--heartbeat-interval') ? Number(args.get('--heartbeat-interval')) : undefined,
  traceTimings: args.get('--trace-timings') === 'true',
  onEvent(value) {
    if (!eventOutput.destroyed) eventOutput.write(JSON.stringify({ time: new Date().toISOString(), ...value }) + '\n');
  },
});
if (httpOnly) bridge.server.on('upgrade', (_request, socket) => {
  socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
});
await new Promise((resolve, reject) => {
  bridge.server.once('error', reject);
  bridge.server.listen(port, '127.0.0.1', resolve);
});
const bound = bridge.server.address();
const ready = { pid: process.pid, port: bound.port, baseUrl: `http://127.0.0.1:${bound.port}/backend-api/codex` };
if (args.has('--state-file')) await fs.writeFile(args.get('--state-file'), JSON.stringify(ready));
process.stdout.write(JSON.stringify({ kind: 'ready', ...ready }) + '\n');
let stopping = false;
let parentExitTimer;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(parentExitTimer);
  await bridge.close();
  if (managed) process.stdin.destroy();
  if (eventOutput !== process.stdout) eventOutput.end();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function idle() {
  const state = bridge.stats();
  return state.httpActive === 0 && (state.websocket?.activeConnections ?? 0) === 0
    && (state.websocket?.pendingConnections ?? 0) === 0;
}
if (managed) {
  let command = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    command = (command + chunk).slice(-1024);
    let end;
    while ((end = command.indexOf('\n')) >= 0) {
      const line = command.slice(0, end).trim();
      command = command.slice(end + 1);
      if (line === 'close-idle-bridge' && idle()) void stop();
    }
  });
  process.stdin.on('end', () => {
    parentExitTimer = setInterval(() => { if (idle()) void stop(); }, 1000);
    parentExitTimer.unref();
  });
}
