import { describe, expect, it } from 'vitest';
import {
  decodePiRunnerInput,
  decodePiRunnerOutput,
  encodePiRunnerInput,
  encodePiRunnerOutput,
} from '../src/pi-runner-protocol.js';
import { extractAssistantText, finalTextFromAgentEnd } from '../src/pi-runner.js';

describe('Pi runner line protocol', () => {
  it('round-trips base64 input payloads', () => {
    const line = encodePiRunnerInput({ id: 'turn-1', type: 'prompt', content: 'hello\npi' });
    expect(line).toMatch(/^::botmux-pi:/);
    expect(decodePiRunnerInput(line)).toEqual({ id: 'turn-1', type: 'prompt', content: 'hello\npi' });
  });

  it('round-trips raw command payloads', () => {
    const line = encodePiRunnerInput({ id: 'cmd-1', type: 'raw_command', content: '/clear' });
    expect(decodePiRunnerInput(line)).toEqual({ id: 'cmd-1', type: 'raw_command', content: '/clear' });
  });

  it('rejects invalid input payloads', () => {
    expect(() => decodePiRunnerInput('::botmux-pi:not-base64')).toThrow(/Invalid Pi runner payload/);
    const malformed = `::botmux-pi:${Buffer.from(JSON.stringify({ id: 'x', type: 'steer', content: 'nope' })).toString('base64')}`;
    expect(() => decodePiRunnerInput(malformed)).toThrow(/unsupported type/);
  });

  it('round-trips structured output payloads', () => {
    const line = encodePiRunnerOutput({ type: 'ack', id: 'turn-1' });
    expect(decodePiRunnerOutput(line)).toEqual({ type: 'ack', id: 'turn-1' });
  });
});

describe('Pi runner final output extraction', () => {
  it('extracts assistant text blocks from a message', () => {
    expect(extractAssistantText({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hidden' },
        { type: 'text', text: 'hello ' },
        { type: 'toolCall', name: 'read' },
        { type: 'text', text: 'world' },
      ],
    })).toBe('hello world');
  });

  it('uses the last assistant text from agent_end events', () => {
    expect(finalTextFromAgentEnd({
      type: 'agent_end',
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'old' }] },
        { role: 'user', content: 'ignored' },
        { role: 'assistant', content: [{ type: 'text', text: 'final' }] },
      ],
    })).toBe('final');
  });
});
