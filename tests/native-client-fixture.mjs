import http from 'node:http';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const directory = process.argv[2];
const outputDirectory = process.argv[3];
const partial = process.argv[4] === 'partial';
const executable = process.env.BRIDGE_NATIVE_CODEX_EXE;
if (!directory || !outputDirectory || !executable) throw new Error('Provide a fixture module directory and explicit Codex executable');
const { createHttpTransportServer } = await import(pathToFileURL(path.join(directory, 'http-transport.mjs')));
const outputRoot = path.resolve(outputDirectory);
for (let parent = path.dirname(outputRoot); parent !== path.dirname(parent); parent = path.dirname(parent)) {
  try { await fs.access(path.join(parent, '.git')); throw new Error('Fixture output must be outside a repository'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await fs.mkdir(outputRoot);
const item = { id: 'msg_local_fixture', type: 'message', status: 'completed', role: 'assistant',
  phase: 'final_answer', content: [{ type: 'output_text', text: 'fixture-ok', annotations: [] }] };
const events = [
  { type: 'response.created', response: { id: 'resp_local_fixture', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
  { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'fixture-ok' },
  { type: 'response.output_item.done', output_index: 0, item },
  { type: 'response.completed', response: { id: 'resp_local_fixture', status: 'completed', output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } },
];
if (partial) events.pop();
const body = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
let posts = 0;
const observed = [];
const remote = http.createServer((request, response) => {
  request.resume();
  request.on('end', () => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return; }
    posts++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(body, () => response.socket.end());
  });
});
remote.listen(0, '127.0.0.1'); await once(remote, 'listening');
let downstream;
const bridge = createHttpTransportServer({ upstreamOrigin: `http://127.0.0.1:${remote.address().port}`,
  allowUnauthenticated: true, responseDrainTimeoutMs: 500, closeTimeoutMs: 100,
  onEvent(event) {
    observed.push(event);
    if (event.kind === 'http_response_error' || event.kind === 'http_failed') setTimeout(() => downstream?.uncork(), 20);
  } });
bridge.server.on('request', (_request, response) => { downstream = response.socket; downstream.cork(); });
bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening');
const base = `http://127.0.0.1:${bridge.server.address().port}/backend-api/codex`;
const args = ['exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only',
  '--color', 'never', '--json', '--cd', outputRoot, '--output-last-message', path.join(outputRoot, 'last-message.txt')];
for (const value of [
  'model_provider="lzc_fixture"', 'model="lzc-fixture-model"', 'model_reasoning_effort="low"',
  'model_providers.lzc_fixture.name="Local offline fixture"', `model_providers.lzc_fixture.base_url="${base}"`,
  'model_providers.lzc_fixture.env_key="LZC_FIXTURE_API_KEY"', 'model_providers.lzc_fixture.wire_api="responses"',
  'model_providers.lzc_fixture.supports_websockets=false', 'model_providers.lzc_fixture.requires_openai_auth=false',
  'model_providers.lzc_fixture.stream_max_retries=0', 'model_providers.lzc_fixture.request_max_retries=0',
  'features.shell_tool=false', 'features.apps=false', 'features.plugins=false', 'features.memories=false',
  'mcp_servers={}', 'skills.include_instructions=false',
]) args.push('-c', value);
args.push('Local protocol fixture. Reply only fixture-ok; do not use tools.');
const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, LZC_FIXTURE_API_KEY: 'local-fixture-only', RUST_LOG: 'error', OTEL_SDK_DISABLED: 'true' } });
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.resume();
const timer = setTimeout(() => child.kill(), 25000);
try {
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  const types = [];
  for (const line of output.split('\n')) {
    try { const event = JSON.parse(line); types.push(event.type); } catch { }
  }
  let final = '';
  try { final = (await fs.readFile(path.join(outputRoot, 'last-message.txt'), 'utf8')).trim(); } catch { }
  const passed = posts === 1 && (partial ? code !== 0 && types.includes('turn.failed') : code === 0 && final === 'fixture-ok');
  if (!passed) process.exitCode = 1;
  console.log(JSON.stringify({ passed, mode: path.basename(directory), exitCode: code, posts,
    finalMatchesFixture: final === 'fixture-ok', nativeEventTypes: types,
    inputBytesReachedBridge: observed.filter(e => e.kind === 'http_failed' || e.kind === 'http_completed').map(e => e.downloadedBytes),
    setupFailed: posts === 0, partial,
    realModelRequests: 0 }));
} finally {
  clearTimeout(timer); downstream?.destroy();
  await bridge.close(); remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve));
}
