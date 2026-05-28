/**
 * Tests for setActiveSession / deleteActiveSession / findActiveBySessionId
 * session registry index management.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setActiveSessionsRegistry,
  setActiveSession,
  deleteActiveSession,
  findActiveBySessionId,
} from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

function makeDs(sessionId: string, larkAppId = 'app_test'): DaemonSession {
  return {
    session: {
      sessionId,
      chatId: `chat_${sessionId}`,
      rootMessageId: `root_${sessionId}`,
      title: `test ${sessionId}`,
      status: 'active',
      createdAt: new Date().toISOString(),
      scope: 'thread',
      chatType: 'group',
      larkAppId,
      ownerOpenId: 'ou_user',
      workingDir: '/tmp',
      cliId: 'claude-code',
    } as any,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId,
    chatId: `chat_${sessionId}`,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
  };
}

describe('session registry index', () => {
  let registry: Map<string, DaemonSession>;

  beforeEach(() => {
    registry = new Map();
    setActiveSessionsRegistry(registry);
  });

  it('findActiveBySessionId returns undefined for unknown sessionId', () => {
    expect(findActiveBySessionId('does-not-exist')).toBeUndefined();
  });

  it('setActiveSession creates index entry and findActiveBySessionId finds it', () => {
    const ds = makeDs('sess-1');
    const key = 'key-1';
    setActiveSession(registry, key, ds);

    const found = findActiveBySessionId('sess-1');
    expect(found).toBeDefined();
    expect(found?.session.sessionId).toBe('sess-1');
  });

  it('deleteActiveSession removes both registry entry and index', () => {
    const ds = makeDs('sess-2');
    const key = 'key-2';
    setActiveSession(registry, key, ds);
    expect(findActiveBySessionId('sess-2')).toBeDefined();

    const deleted = deleteActiveSession(registry, key);
    expect(deleted).toBe(true);
    expect(registry.has(key)).toBe(false);
    expect(findActiveBySessionId('sess-2')).toBeUndefined();
  });

  it('deleteActiveSession returns false for non-existent key', () => {
    expect(deleteActiveSession(registry, 'no-such-key')).toBe(false);
  });

  it('overwriting same key with different sessionId cleans up old index', () => {
    const oldDs = makeDs('sess-old');
    const newDs = makeDs('sess-new');
    const key = 'same-key';

    // Register old session
    setActiveSession(registry, key, oldDs);
    expect(findActiveBySessionId('sess-old')?.session.sessionId).toBe('sess-old');

    // Overwrite same key with new session (different sessionId)
    setActiveSession(registry, key, newDs);

    // Old sessionId should NOT be findable
    expect(findActiveBySessionId('sess-old')).toBeUndefined();

    // New sessionId should be findable and return the new ds
    const found = findActiveBySessionId('sess-new');
    expect(found).toBeDefined();
    expect(found?.session.sessionId).toBe('sess-new');
  });

  it('overwriting same key with same sessionId (updated ds) keeps index', () => {
    const ds1 = makeDs('sess-same');
    const key = 'key-same';
    setActiveSession(registry, key, ds1);

    // Overwrite with updated ds but same sessionId
    const ds2 = makeDs('sess-same');
    ds2.lastMessageAt = Date.now() + 1000;
    setActiveSession(registry, key, ds2);

    // Should still find the session
    const found = findActiveBySessionId('sess-same');
    expect(found).toBeDefined();
    expect(found?.lastMessageAt).toBe(ds2.lastMessageAt);
  });

  it('multiple sessions with different keys maintain independent indexes', () => {
    const ds1 = makeDs('sess-a');
    const ds2 = makeDs('sess-b');
    const ds3 = makeDs('sess-c');

    setActiveSession(registry, 'key-a', ds1);
    setActiveSession(registry, 'key-b', ds2);
    setActiveSession(registry, 'key-c', ds3);

    expect(findActiveBySessionId('sess-a')?.session.sessionId).toBe('sess-a');
    expect(findActiveBySessionId('sess-b')?.session.sessionId).toBe('sess-b');
    expect(findActiveBySessionId('sess-c')?.session.sessionId).toBe('sess-c');

    // Delete one — others unaffected
    deleteActiveSession(registry, 'key-b');
    expect(findActiveBySessionId('sess-a')?.session.sessionId).toBe('sess-a');
    expect(findActiveBySessionId('sess-b')).toBeUndefined();
    expect(findActiveBySessionId('sess-c')?.session.sessionId).toBe('sess-c');
  });
});
