import { describe, expect, it } from 'vitest';
import { shouldSuppressBridgeEmit, type BridgeSendMarker } from '../src/services/bridge-fallback-gate.js';

describe('Pi final_output marker gating', () => {
  it('uses actual final time, not next ACK time, for type-ahead turn windows', () => {
    const markers: BridgeSendMarker[] = [{ sentAtMs: 1500, messageId: 'from-turn-a' }];
    const turnAAckAt = 1000;
    const turnBQueuedAckAt = 1010;
    const turnAFinalAt = 1800;
    const turnBFinalAt = 2200;

    const turnA = shouldSuppressBridgeEmit({ markTimeMs: turnAAckAt, isLocal: false }, turnAFinalAt, markers, false);
    const turnBStart = Math.max(turnBQueuedAckAt, turnAFinalAt);
    const turnB = shouldSuppressBridgeEmit({ markTimeMs: turnBStart, isLocal: false }, turnBFinalAt, markers, false);

    expect(turnA).toBe(true);
    expect(turnB).toBe(false);
  });
});
