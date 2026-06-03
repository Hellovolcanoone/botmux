#!/usr/bin/env node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodePiRunnerInput,
  encodePiRunnerOutput,
  type PiRunnerInputMessage,
  type PiRunnerOutputMessage,
} from './pi-runner-protocol.js';

type RpcResponse = {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

type RpcEvent = Record<string, unknown>;

type PendingRpc = {
  command: string;
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type QueuedInput = {
  message: PiRunnerInputMessage;
  resolve: () => void;
  reject: (error: Error) => void;
};

export function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const role = (message as { role?: unknown }).role;
  if (role !== 'assistant') return '';
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return '';
      const p = part as { type?: unknown; text?: unknown };
      return p.type === 'text' && typeof p.text === 'string' ? p.text : '';
    })
    .filter(Boolean)
    .join('');
}

export function finalTextFromAgentEnd(event: RpcEvent): string | undefined {
  if (event.type !== 'agent_end') return undefined;
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = extractAssistantText(messages[i]);
    if (text.trim()) return text;
  }
  return undefined;
}

function parseArgs(argv: string[]): { piBin: string; piArgs: string[] } {
  const sep = argv.indexOf('--');
  const own = sep >= 0 ? argv.slice(0, sep) : argv;
  const piArgs = sep >= 0 ? argv.slice(sep + 1) : [];
  let piBin = 'pi';
  for (let i = 0; i < own.length; i++) {
    if (own[i] === '--pi-bin' && own[i + 1]) {
      piBin = own[++i];
    }
  }
  return { piBin, piArgs };
}

function jsonLine(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

function parseRawCommand(content: string): Record<string, unknown> | undefined {
  const trimmed = content.trim();
  const [command, ...rest] = trimmed.split(/\s+/);
  const argText = rest.join(' ').trim();
  switch (command) {
    case '/compact':
      return { type: 'compact', ...(argText ? { customInstructions: argText } : {}) };
    case '/clear':
    case '/new':
      return { type: 'new_session' };
    default:
      return undefined;
  }
}

export class PiRpcBridge {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly queue: QueuedInput[] = [];
  private requestId = 0;
  private started = false;
  private processing = false;
  private runningTurns: string[] = [];
  private initialPromptSent = false;

  constructor(private readonly piBin: string, private readonly piArgs: string[]) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.child = spawn(this.piBin, ['--mode', 'rpc', ...this.piArgs], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    const stdout = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    stdout.on('line', line => this.handleRpcLine(line));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', data => process.stderr.write(data));

    this.child.once('exit', (code, signal) => {
      const msg = `Pi RPC exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      this.rejectAll(new Error(msg));
      this.rejectQueued(new Error(msg));
      this.emit({ type: 'error', message: msg });
      process.exitCode = code ?? (signal ? 1 : 0);
      process.exit(process.exitCode || 0);
    });
    this.child.once('error', error => {
      this.rejectAll(error);
      this.rejectQueued(error);
      this.emit({ type: 'error', message: `Pi RPC spawn failed: ${error.message}` });
      process.exitCode = 1;
      process.exit(1);
    });

    this.emit({ type: 'ready' });
  }

  submit(message: PiRunnerInputMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ message, resolve, reject });
      void this.drainQueue();
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          await this.submitNow(item.message);
          item.resolve();
        } catch (error: unknown) {
          const err = error instanceof Error ? error : new Error(String(error));
          item.reject(err);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async submitNow(message: PiRunnerInputMessage): Promise<void> {
    const child = this.child;
    if (!child || !child.stdin.writable) throw new Error('Pi RPC process is not writable');

    if (message.type === 'raw_command') {
      await this.submitRawCommand(message);
      return;
    }

    // First turn must be RPC `prompt`; once a prompt has been accepted, every
    // later botmux message is an explicit `follow_up`. This keeps queueing
    // semantics deterministic and avoids mixing prompt streamingBehavior modes.
    const commandType = message.type === 'follow_up' || this.initialPromptSent ? 'follow_up' : 'prompt';
    const command = commandType === 'prompt'
      ? { type: 'prompt', message: message.content }
      : { type: 'follow_up', message: message.content };

    this.runningTurns.push(message.id);
    try {
      await this.sendRpc(command);
      if (commandType === 'prompt') {
        this.initialPromptSent = true;
      }
      this.emit({ type: 'ack', id: message.id });
    } catch (error: unknown) {
      this.runningTurns = this.runningTurns.filter(id => id !== message.id);
      const msg = error instanceof Error ? error.message : String(error);
      this.emit({ type: 'error', id: message.id, message: msg });
      throw error;
    }
  }

  private async submitRawCommand(message: Extract<PiRunnerInputMessage, { type: 'raw_command' }>): Promise<void> {
    if (this.runningTurns.length > 0) {
      const msg = `Pi is still running; wait for the current turn to finish before sending ${message.content.trim()}`;
      this.emit({ type: 'error', id: message.id, message: msg });
      throw new Error(msg);
    }
    const command = parseRawCommand(message.content);
    if (!command) {
      const msg = `Pi adapter does not support passthrough slash command: ${message.content.trim()}`;
      this.emit({ type: 'error', id: message.id, message: msg });
      throw new Error(msg);
    }
    try {
      await this.sendRpc(command);
      if (command.type === 'new_session') {
        this.initialPromptSent = false;
        this.runningTurns = [];
      }
      this.emit({ type: 'ack', id: message.id });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.emit({ type: 'error', id: message.id, message: msg });
      throw error;
    }
  }

  private sendRpc(command: Record<string, unknown>): Promise<RpcResponse> {
    const child = this.child;
    if (!child || !child.stdin.writable) return Promise.reject(new Error('Pi RPC process is not writable'));
    const id = `botmux_pi_${++this.requestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Pi RPC response to ${String(command.type)}`));
      }, 30_000);
      this.pending.set(id, {
        command: String(command.type),
        resolve,
        reject,
        timer,
      });
      child.stdin.write(jsonLine({ ...command, id }));
    });
  }

  private handleRpcLine(line: string): void {
    if (!line.trim()) return;
    let obj: RpcEvent;
    try {
      obj = JSON.parse(line);
    } catch {
      process.stderr.write(`[pi-runner] non-json rpc stdout: ${line}\n`);
      return;
    }

    if (obj.type === 'response' && typeof obj.id === 'string') {
      this.handleRpcResponse(obj as RpcResponse);
      return;
    }

    const finalText = finalTextFromAgentEnd(obj);
    if (finalText !== undefined) {
      const turnId = this.runningTurns.shift() ?? `pi-orphan-${this.requestId}`;
      this.emit({ type: 'final_output', turnId, content: finalText });
    }
  }

  private handleRpcResponse(response: RpcResponse): void {
    if (!response.id) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.success) {
      pending.resolve(response);
    } else {
      pending.reject(new Error(response.error ?? `Pi RPC ${pending.command} failed`));
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private rejectQueued(error: Error): void {
    while (this.queue.length > 0) {
      this.queue.shift()!.reject(error);
    }
  }

  private emit(message: PiRunnerOutputMessage): void {
    process.stdout.write(encodePiRunnerOutput(message));
  }
}

export function createPiRunner(argv: string[]): PiRpcBridge {
  const { piBin, piArgs } = parseArgs(argv);
  return new PiRpcBridge(piBin, piArgs);
}

const invokedAsMain = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (invokedAsMain) {
  const runner = createPiRunner(process.argv.slice(2));
  runner.start();

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    let message: PiRunnerInputMessage | undefined;
    try {
      message = decodePiRunnerInput(line);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stdout.write(encodePiRunnerOutput({ type: 'error', message: msg }));
      return;
    }
    if (!message) return;
    void runner.submit(message).catch(() => {
      // Error already emitted as a structured runner message.
    });
  });

  process.once('SIGTERM', () => process.exit(143));
  process.once('SIGINT', () => process.exit(130));
}

export function defaultPiSessionDir(dataDir = process.env.SESSION_DATA_DIR): string | undefined {
  return dataDir ? join(dataDir, 'pi-sessions') : undefined;
}

export function defaultRunnerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'pi-runner.js');
}
