import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

async function run() {
const argument = process.argv.indexOf('--installation');
if (argument < 0 || !process.argv[argument + 1]) throw new Error('Provide --installation with a local receipt');
const installation = JSON.parse(await fs.readFile(process.argv[argument + 1], 'utf8').then(s => s.replace(/^\uFEFF/, '')));
const require = createRequire(path.join(installation.RuntimeRoot, 'package.json'));
const WebSocket = require('ws');
const auth = JSON.parse(await fs.readFile(path.join(installation.CodexHome, 'auth.json'), 'utf8').then(s => s.replace(/^\uFEFF/, '')));
const accessToken = auth.tokens?.access_token;
if (typeof accessToken !== 'string' || !accessToken) throw new Error('Sign in to ChatGPT through the official local Codex app first');
const health = async () => (await fetch(`http://127.0.0.1:${installation.Port}/health`, {
  signal: AbortSignal.timeout(3000),
})).json();
const before = await health();
if (before.version !== installation.Version || before.instanceId !== installation.InstanceId) throw new Error('Unexpected bridge instance');
const headers = { authorization: `Bearer ${accessToken}`, originator: 'codex_cli_rs', 'x-client-request-id': randomUUID() };
if (auth.tokens?.account_id) headers['ChatGPT-Account-Id'] = auth.tokens.account_id;
const socket = new WebSocket(`ws://127.0.0.1:${installation.Port}/backend-api/codex/responses`, {
  headers, handshakeTimeout: 20_000,
});
let refusalStatus;
let closeCode;
socket.on('error', () => {});
socket.on('close', code => { closeCode = code; });
try {
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', () => reject(new Error('Handshake failed')));
    socket.once('unexpected-response', (_request, response) => {
      refusalStatus = response.statusCode;
      response.resume();
      reject(new Error('Handshake refused'));
    });
  });
  console.log(JSON.stringify({ phase: 'authenticated_websocket_open', modelRequestsSent: 0 }));
  await delay(35_000);
  const after = await health();
  const confirmedProbes = after.websocket.upstreamProbeAcks - before.websocket.upstreamProbeAcks;
  const timeouts = after.websocket.upstreamLivenessTimeouts - before.websocket.upstreamLivenessTimeouts;
  console.log(JSON.stringify({ phase: 'liveness_result', socketOpen: socket.readyState === WebSocket.OPEN,
    confirmedProbes, timeouts, modelRequestsSent: 0,
    note: 'Bridge counters are aggregate; run while this installation has no other traffic for isolated evidence.' }));
  if (socket.readyState !== WebSocket.OPEN || confirmedProbes < 1 || timeouts !== 0) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ phase: 'failed', refusalStatus, closeCode, modelRequestsSent: 0 }));
  process.exitCode = 1;
} finally {
  if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'liveness check complete');
  else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
  const deadline = Date.now() + 1500;
  while (socket.readyState !== WebSocket.CLOSED && Date.now() < deadline) await delay(25);
  if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
}
}

run().catch(() => {
  console.log(JSON.stringify({ phase: 'setup_failed', modelRequestsSent: 0,
    note: 'Check the local receipt, matching runtime and official ChatGPT login. Raw setup errors are intentionally omitted.' }));
  process.exitCode = 1;
});
