/**
 * Web session store for the team platform UI.
 * Run: pnpm vitest run test/web-session-store.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { createWebSession, getWebSession, revokeWebSession } from '../src/services/web-session-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-websess-')); });

describe('web-session-store', () => {
  it('creates and resolves a session', () => {
    const { token } = createWebSession(dataDir, { unionId: 'on_1', name: '张三' }, 'default');
    expect(token.length).toBeGreaterThan(30);
    const s = getWebSession(dataDir, token)!;
    expect(s.identity).toEqual({ unionId: 'on_1', name: '张三' });
    expect(s.teamId).toBe('default');
  });

  it('returns null for unknown / empty token', () => {
    expect(getWebSession(dataDir, 'nope')).toBeNull();
    expect(getWebSession(dataDir, '')).toBeNull();
  });

  it('expires sessions past TTL', () => {
    const { token } = createWebSession(dataDir, { unionId: 'on_1' }, 'default', 1000, 1_000_000);
    expect(getWebSession(dataDir, token, 1_000_500)).not.toBeNull();
    expect(getWebSession(dataDir, token, 1_002_000)).toBeNull();
  });

  it('revokes a session (logout)', () => {
    const { token } = createWebSession(dataDir, { unionId: 'on_1' }, 'default');
    expect(revokeWebSession(dataDir, token)).toBe(true);
    expect(getWebSession(dataDir, token)).toBeNull();
    expect(revokeWebSession(dataDir, token)).toBe(false);
  });

  it('tokens are unique', () => {
    const tokens = new Set(Array.from({ length: 30 }, () => createWebSession(dataDir, { unionId: 'x' }, 'default').token));
    expect(tokens.size).toBe(30);
  });
});
