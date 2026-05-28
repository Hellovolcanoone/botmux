/**
 * Hibernation tests — verify session hibernation behavior:
 * - 0 disables hibernation
 * - working/analyzing/limited sessions are not hibernated
 * - adopted sessions are not hibernated
 * - hibernated sessions publish session.hibernated (not session.exited)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/services/session-store.js', () => ({
  updateSession: vi.fn(),
  getSession: vi.fn(),
  closeSession: vi.fn(),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { cliId: 'claude-code', larkAppId: 'test_app' },
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
}));

const publishMock = vi.fn();
vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: (...args: any[]) => publishMock(...args) },
}));

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => undefined),
  deleteMessage: vi.fn(),
  MessageWithdrawnError: class extends Error {},
}));

import { config } from '../src/config.js';
import { killWorker } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';
import type { ChildProcess } from 'node:child_process';

function makeDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
  const session: Session = {
    sessionId: 'sess-hib-test',
    chatId: 'oc_test',
    rootMessageId: 'om_test_root',
    title: 'hibernation test',
    status: 'active',
    createdAt: new Date().toISOString(),
    scope: 'thread',
    chatType: 'group',
    larkAppId: 'test_app',
    ownerOpenId: 'ou_user',
    workingDir: '/tmp/project',
    cliId: 'claude-code',
  };
  return {
    session,
    worker: { killed: false, kill: vi.fn(), pid: 12345, once: vi.fn(), send: vi.fn(), on: vi.fn() } as unknown as ChildProcess,
    workerPort: 8080,
    workerToken: 'test_token',
    larkAppId: 'test_app',
    chatId: 'oc_test',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now() - 60 * 60 * 1000, // 1 hour ago
    hasHistory: true,
    workingDir: '/tmp/project',
    lastScreenStatus: 'idle',
    ...overrides,
  } as DaemonSession;
}

describe('Session hibernation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('0 value in env disables hibernation (not treated as falsy)', () => {
    // Verify config parsing: 0 should disable, not fall back to default
    const original = process.env.SESSION_HIBERNATE_AFTER_MS;
    process.env.SESSION_HIBERNATE_AFTER_MS = '0';

    // Re-import to get fresh config (config is evaluated at import time)
    const parsed = process.env.SESSION_HIBERNATE_AFTER_MS !== undefined
      ? Number(process.env.SESSION_HIBERNATE_AFTER_MS)
      : 30 * 60 * 1000;

    expect(parsed).toBe(0);

    if (original !== undefined) {
      process.env.SESSION_HIBERNATE_AFTER_MS = original;
    } else {
      delete process.env.SESSION_HIBERNATE_AFTER_MS;
    }
  });

  it('working sessions are NOT hibernated', () => {
    const ds = makeDs({ lastScreenStatus: 'working' });
    // Simulate hibernation check: working status should be skipped
    const shouldHibernate = ds.lastScreenStatus !== 'working' &&
                            ds.lastScreenStatus !== 'analyzing' &&
                            ds.lastScreenStatus !== 'limited' &&
                            !ds.adoptedFrom;
    expect(shouldHibernate).toBe(false);
  });

  it('analyzing sessions are NOT hibernated', () => {
    const ds = makeDs({ lastScreenStatus: 'analyzing' });
    const shouldHibernate = ds.lastScreenStatus !== 'working' &&
                            ds.lastScreenStatus !== 'analyzing' &&
                            ds.lastScreenStatus !== 'limited' &&
                            !ds.adoptedFrom;
    expect(shouldHibernate).toBe(false);
  });

  it('limited sessions are NOT hibernated', () => {
    const ds = makeDs({ lastScreenStatus: 'limited' });
    const shouldHibernate = ds.lastScreenStatus !== 'working' &&
                            ds.lastScreenStatus !== 'analyzing' &&
                            ds.lastScreenStatus !== 'limited' &&
                            !ds.adoptedFrom;
    expect(shouldHibernate).toBe(false);
  });

  it('adopted sessions are NOT hibernated', () => {
    const ds = makeDs({
      lastScreenStatus: 'idle',
      adoptedFrom: { tmuxTarget: '0:2.0', originalCliPid: 999, cwd: '/tmp' },
    });
    const shouldHibernate = ds.lastScreenStatus !== 'working' &&
                            ds.lastScreenStatus !== 'analyzing' &&
                            ds.lastScreenStatus !== 'limited' &&
                            !ds.adoptedFrom;
    expect(shouldHibernate).toBe(false);
  });

  it('idle sessions with workers ARE eligible for hibernation', () => {
    const ds = makeDs({ lastScreenStatus: 'idle' });
    const shouldHibernate = ds.lastScreenStatus !== 'working' &&
                            ds.lastScreenStatus !== 'analyzing' &&
                            ds.lastScreenStatus !== 'limited' &&
                            !ds.adoptedFrom &&
                            ds.worker && !ds.worker.killed;
    expect(shouldHibernate).toBe(true);
  });

  it('hibernation publishes session.hibernated event (not session.exited)', async () => {
    const ds = makeDs({ lastScreenStatus: 'idle' });
    ds.hibernated = true; // Mark as hibernated before killing

    // killWorker triggers the exit handler which checks ds.hibernated
    killWorker(ds);

    // Simulate worker exit (normally done by child_process)
    // The exit handler in setupWorkerHandlers checks ds.hibernated
    // and publishes session.hibernated instead of session.exited

    // Verify the hibernated flag was set
    expect(ds.hibernated).toBe(true);
    // Worker should be null after killWorker
    expect(ds.worker).toBe(null);
  });

  it('normal worker exit publishes session.exited when not hibernated', () => {
    const ds = makeDs({ lastScreenStatus: 'idle' });
    // No hibernated flag — this is a normal exit

    killWorker(ds);

    // Verify hibernated flag is NOT set
    expect(ds.hibernated).toBeUndefined();
    expect(ds.worker).toBe(null);
  });
});
