import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

async function managedServer(t) {
  const child = spawn(process.execPath, ['server.mjs', '--port', '0', '--managed', 'true', '--proxy', 'http://127.0.0.1:9'], {
    cwd: new URL('.', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stderr.resume();
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Managed fixture did not start')), 3000);
    lines.on('line', text => {
      const event = JSON.parse(text);
      if (event.kind === 'ready') { clearTimeout(timer); resolve(event); }
    });
  });
  t.after(() => { child.stdin.end(); lines.close(); });
  return { child, exited, ready };
}

test('an owned idle bridge exits cleanly on its private control pipe', { timeout: 5000 }, async t => {
  const { child, exited, ready } = await managedServer(t);
  const health = await (await fetch(`http://127.0.0.1:${ready.port}/health`)).json();
  assert.equal(health.managed, true);
  child.stdin.write('close-idle-bridge\n');
  const [code] = await exited;
  assert.equal(code, 0);
});

test('an idle managed bridge exits when its parent control pipe closes', { timeout: 5000 }, async t => {
  const { child, exited } = await managedServer(t);
  child.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0);
});
