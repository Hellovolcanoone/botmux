export const PI_RUNNER_PREFIX = '::botmux-pi:';

export type PiRunnerInputMessage =
  | { id: string; type: 'prompt' | 'follow_up'; content: string }
  | { id: string; type: 'raw_command'; content: string };

export type PiRunnerOutputMessage =
  | { type: 'ready' }
  | { type: 'ack'; id: string }
  | { type: 'final_output'; turnId: string; content: string }
  | { type: 'error'; id?: string; message: string };

export function encodePiRunnerInput(message: PiRunnerInputMessage): string {
  return `${PI_RUNNER_PREFIX}${Buffer.from(JSON.stringify(message), 'utf8').toString('base64')}`;
}

export function decodePiRunnerInput(line: string): PiRunnerInputMessage | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(PI_RUNNER_PREFIX)) return undefined;
  const encoded = trimmed.slice(PI_RUNNER_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    throw new Error('Invalid Pi runner payload');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid Pi runner payload shape');
  }
  const msg = parsed as Record<string, unknown>;
  if (typeof msg.id !== 'string' || !msg.id) {
    throw new Error('Invalid Pi runner payload: missing id');
  }
  if (msg.type !== 'prompt' && msg.type !== 'follow_up' && msg.type !== 'raw_command') {
    throw new Error('Invalid Pi runner payload: unsupported type');
  }
  if (typeof msg.content !== 'string') {
    throw new Error('Invalid Pi runner payload: missing content');
  }
  return { id: msg.id, type: msg.type, content: msg.content };
}

export function encodePiRunnerOutput(message: PiRunnerOutputMessage): string {
  return `${PI_RUNNER_PREFIX}${Buffer.from(JSON.stringify(message), 'utf8').toString('base64')}\n`;
}

export function decodePiRunnerOutput(line: string): PiRunnerOutputMessage | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(PI_RUNNER_PREFIX)) return undefined;
  const encoded = trimmed.slice(PI_RUNNER_PREFIX.length);
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as PiRunnerOutputMessage;
  } catch {
    return undefined;
  }
}
