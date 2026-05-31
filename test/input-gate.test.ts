/**
 * Worker input-gate: decide whether an incoming Lark message is written to the
 * CLI's PTY immediately or queued until the CLI is ready.
 *
 * The bug this pins: type-ahead adapters (Codex/CoCo) may write while the CLI is
 * BUSY (an active turn parks the input in the TUI queue). But during STARTUP the
 * TUI input box doesn't exist yet, so a type-ahead write is silently lost — the
 * concrete failure was dispatch's brief reaching Codex ~6s before it first went
 * idle and never landing in the input box. The gate must therefore queue even
 * type-ahead messages until the CLI has been ready at least once; the worker's
 * markPromptReady() flush then delivers them.
 *
 * Run: pnpm vitest run test/input-gate.test.ts
 */
import { describe, it, expect } from 'vitest';
import { shouldWriteNow } from '../src/utils/input-gate.js';

const base = {
  isPromptReady: false,
  isFlushing: false,
  supportsTypeAhead: false,
  awaitingFirstPrompt: false,
};

describe('shouldWriteNow', () => {
  it('writes immediately when the prompt is ready (idle)', () => {
    expect(shouldWriteNow({ ...base, isPromptReady: true })).toBe(true);
  });

  it('writes immediately while a flush is already draining', () => {
    expect(shouldWriteNow({ ...base, isFlushing: true })).toBe(true);
  });

  it('type-ahead writes while busy ONCE the CLI has booted (awaitingFirstPrompt=false)', () => {
    expect(shouldWriteNow({ ...base, supportsTypeAhead: true, awaitingFirstPrompt: false })).toBe(true);
  });

  it('THE BUG: queues a type-ahead message that arrives during startup (awaitingFirstPrompt=true)', () => {
    // Codex supports type-ahead, but its TUI input box is not up yet during boot
    // — writing now loses the message. Must queue (false) so markPromptReady flushes it.
    expect(shouldWriteNow({ ...base, supportsTypeAhead: true, awaitingFirstPrompt: true })).toBe(false);
  });

  it('queues when the CLI is busy and does not support type-ahead', () => {
    expect(shouldWriteNow({ ...base, supportsTypeAhead: false, awaitingFirstPrompt: false })).toBe(false);
  });
});
