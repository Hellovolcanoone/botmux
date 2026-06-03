import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodePiRunnerOutput, encodePiRunnerInput, type PiRunnerOutputMessage } from '../src/pi-runner-protocol.js';

const runnerTs = fileURLToPath(new URL('../src/pi-runner.ts', import.meta.url));

function makeFakePi(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-pi-rpc-'));
  const file = join(dir, 'fake-pi.mjs');
  writeFileSync(file, script, { mode: 0o755 });
  return file;
}

function collectEvents(child: ReturnType<typeof spawn>): PiRunnerOutputMessage[] {
  const events: PiRunnerOutputMessage[] = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const msg = decodePiRunnerOutput(line);
      if (msg) events.push(msg);
      idx = buffer.indexOf('\n');
    }
  });
  return events;
}

function waitForOutput(events: PiRunnerOutputMessage[], type: PiRunnerOutputMessage['type'], timeoutMs = 5000): Promise<PiRunnerOutputMessage> {
  const existing = events.find(e => e.type === type);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = events.find(e => e.type === type);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${type}`));
      }
    }, 25);
  });
}

function waitForCount(events: PiRunnerOutputMessage[], type: PiRunnerOutputMessage['type'], count: number, timeoutMs = 5000): Promise<PiRunnerOutputMessage[]> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = events.filter(e => e.type === type);
      if (found.length >= count) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${count} ${type}`));
      }
    }, 25);
  });
}

describe('pi-runner RPC integration', () => {
  it('acks RPC prompt and emits final_output from agent_end', async () => {
    const fakePi = makeFakePi(`#!/usr/bin/env node
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  const cmd = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: cmd.id, type: 'response', command: cmd.type, success: true }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done:' + cmd.message }] }], willRetry: false }) + '\\n');
});
`);
    const child = spawn(process.execPath, ['--import', 'tsx', runnerTs, '--pi-bin', fakePi, '--', '--session-id', 'sess'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const events = collectEvents(child);

    await waitForOutput(events, 'ready');
    child.stdin.write(encodePiRunnerInput({ id: 'turn-1', type: 'prompt', content: 'hello' }) + '\n');

    await waitForOutput(events, 'ack');
    const final = await waitForOutput(events, 'final_output');
    expect(final).toEqual({ type: 'final_output', turnId: 'turn-1', content: 'done:hello' });

    child.kill('SIGTERM');
  });

  it('serializes prompt then follow_up and keeps both final_output turn ids', async () => {
    const fakePi = makeFakePi(`#!/usr/bin/env node
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  const cmd = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: cmd.id, type: 'response', command: cmd.type, success: true }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: cmd.type + ':' + cmd.message }] }], willRetry: false }) + '\\n');
});
`);
    const child = spawn(process.execPath, ['--import', 'tsx', runnerTs, '--pi-bin', fakePi, '--', '--session-id', 'sess'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const events = collectEvents(child);

    await waitForOutput(events, 'ready');
    child.stdin.write(encodePiRunnerInput({ id: 'turn-1', type: 'prompt', content: 'one' }) + '\n');
    child.stdin.write(encodePiRunnerInput({ id: 'turn-2', type: 'prompt', content: 'two' }) + '\n');

    const finals = await waitForCount(events, 'final_output', 2);
    expect(finals).toEqual([
      { type: 'final_output', turnId: 'turn-1', content: 'prompt:one' },
      { type: 'final_output', turnId: 'turn-2', content: 'follow_up:two' },
    ]);

    child.kill('SIGTERM');
  });

  it('rejects raw slash commands while an agent turn is active', async () => {
    const fakePi = makeFakePi(`#!/usr/bin/env node
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  const cmd = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: cmd.id, type: 'response', command: cmd.type, success: true }) + '\\n');
  if (cmd.type !== 'prompt') {
    process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'unexpected' }] }], willRetry: false }) + '\\n');
  }
});
`);
    const child = spawn(process.execPath, ['--import', 'tsx', runnerTs, '--pi-bin', fakePi, '--', '--session-id', 'sess'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const events = collectEvents(child);

    await waitForOutput(events, 'ready');
    child.stdin.write(encodePiRunnerInput({ id: 'turn-active', type: 'prompt', content: 'work' }) + '\n');
    await waitForOutput(events, 'ack');
    child.stdin.write(encodePiRunnerInput({ id: 'cmd-clear', type: 'raw_command', content: '/clear' }) + '\n');
    const err = await waitForOutput(events, 'error');
    expect(err).toEqual({
      type: 'error',
      id: 'cmd-clear',
      message: 'Pi is still running; wait for the current turn to finish before sending /clear',
    });

    child.kill('SIGTERM');
  });

  it('maps supported raw slash commands and rejects unsupported ones', async () => {
    const fakePi = makeFakePi(`#!/usr/bin/env node
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  const cmd = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: cmd.id, type: 'response', command: cmd.type, success: true, data: cmd.type === 'compact' ? { ok: true } : { cancelled: false } }) + '\\n');
});
`);
    const child = spawn(process.execPath, ['--import', 'tsx', runnerTs, '--pi-bin', fakePi, '--', '--session-id', 'sess'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const events = collectEvents(child);

    await waitForOutput(events, 'ready');
    child.stdin.write(encodePiRunnerInput({ id: 'cmd-1', type: 'raw_command', content: '/compact shrink' }) + '\n');
    await waitForOutput(events, 'ack');
    child.stdin.write(encodePiRunnerInput({ id: 'cmd-2', type: 'raw_command', content: '/model' }) + '\n');
    const err = await waitForOutput(events, 'error');
    expect(err).toEqual({ type: 'error', id: 'cmd-2', message: 'Pi adapter does not support passthrough slash command: /model' });

    child.kill('SIGTERM');
  });

  it('emits structured error when Pi RPC exits before ack', async () => {
    const fakePi = makeFakePi(`#!/usr/bin/env node
process.exit(42);
`);
    const child = spawn(process.execPath, ['--import', 'tsx', runnerTs, '--pi-bin', fakePi, '--', '--session-id', 'sess'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const events = collectEvents(child);

    const err = await waitForOutput(events, 'error');
    expect(err.type).toBe('error');
    expect((err as Extract<PiRunnerOutputMessage, { type: 'error' }>).message).toContain('Pi RPC exited');
  });
});
