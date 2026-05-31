/**
 * Unit tests for HerdrBackend.
 *
 * Covers:
 *   - Backend "connection" surface: isAvailable / hasSession / ensureServer
 *     boot polling (no busy-spin; respects an already-running session).
 *   - spawn() in three flavours: fresh agent start, existing-agent reuse, and
 *     external-target adopt — verifies the right `herdr agent {start,get}` /
 *     pane-id wiring runs in each case.
 *   - Message writing: write / sendText / sendSpecialKeys hit `pane
 *     send-text` and `pane send-keys` with the resolved pane target.
 *   - Data + exit callbacks: poll() emits the prefix-delta on changed
 *     `pane read` output, and emits exit once the agent vanishes from
 *     `agent list`.
 *
 * Run:  pnpm vitest run test/herdr-backend.test.ts
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execFileSync, spawn } from 'node:child_process';
import { HerdrBackend } from '../src/adapters/backend/herdr-backend.js';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedSpawn = vi.mocked(spawn);

// ─── Helpers ───────────────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  killed = false;
  unref = vi.fn();
  kill = vi.fn(() => { this.killed = true; return true; });
}

function makeFakeChild(): FakeChild { return new FakeChild(); }

function findCall(predicate: (args: string[]) => boolean): string[] | undefined {
  for (const call of mockedExecFileSync.mock.calls) {
    const args = (call[1] as string[]) ?? [];
    if (predicate(args)) return args;
  }
  return undefined;
}

function herdrCall(...needles: string[]): string[] | undefined {
  return findCall(args => needles.every(n => args.includes(n)));
}

/**
 * Route mocked herdr CLI invocations to canned payloads. Anything not matched
 * returns "" (sleep, version probes, fire-and-forget writes).
 */
function setHerdrResponses(handlers: Array<{ match: (args: string[]) => boolean; reply: () => string }>) {
  mockedExecFileSync.mockImplementation(((cmd: any, args: any) => {
    if (cmd !== 'herdr') return '' as any;
    const argv = args as string[];
    for (const h of handlers) {
      if (h.match(argv)) return h.reply() as any;
    }
    return '' as any;
  }) as any);
}

const SESSION = 'bmx-deadbeef';
const EXISTING_SESSION_REPLY = JSON.stringify({ sessions: [{ name: SESSION, running: true }] });
const EMPTY_SESSIONS_REPLY = JSON.stringify({ sessions: [] });
const AGENT_GET_REPLY = (paneId: string) => JSON.stringify({ result: { agent: { name: 'botmux', pane_id: paneId } } });
const AGENT_LIST_REPLY = (paneId: string) => JSON.stringify({ result: { agents: [{ name: 'botmux', pane_id: paneId }] } });
const PANE_READ_REPLY = (text: string) => JSON.stringify({ result: { read: { text } } });

beforeEach(() => {
  mockedExecFileSync.mockReset();
  mockedSpawn.mockReset();
  // Default: every spawn (including the bg `wait agent-status` watcher) gets
  // a fake child whose lifecycle the test fully controls.
  mockedSpawn.mockImplementation((() => makeFakeChild()) as any);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Backend connection surface ────────────────────────────────────────────

describe('HerdrBackend connection surface', () => {
  it('isAvailable() returns true when `herdr --version` succeeds', () => {
    mockedExecFileSync.mockImplementation((() => 'herdr 1.0\n') as any);
    expect(HerdrBackend.isAvailable()).toBe(true);
    const versionCall = mockedExecFileSync.mock.calls.find(c => (c[1] as string[]).includes('--version'));
    expect(versionCall).toBeDefined();
  });

  it('isAvailable() returns false when herdr binary is missing', () => {
    mockedExecFileSync.mockImplementation((() => { throw new Error('ENOENT'); }) as any);
    expect(HerdrBackend.isAvailable()).toBe(false);
  });

  it('hasSession() parses `session list --json` and matches running sessions', () => {
    setHerdrResponses([{
      match: a => a[0] === 'session' && a[1] === 'list',
      reply: () => JSON.stringify({ sessions: [{ name: SESSION, running: true }, { name: 'other', running: false }] }),
    }]);
    expect(HerdrBackend.hasSession(SESSION)).toBe(true);
    expect(HerdrBackend.hasSession('other')).toBe(false);
    expect(HerdrBackend.hasSession('missing')).toBe(false);
  });

  it('ensureServer skips boot poll when session already exists (no spawn, no sleep)', () => {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('1-1') },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);
    const be = new HerdrBackend(SESSION);
    be.spawn('claude', [], { cwd: '/tmp', cols: 80, rows: 24, env: {} });
    // Only the bg status watcher should be spawned. No `herdr ... server`, no
    // sleep child_process call.
    const headlessSpawns = mockedSpawn.mock.calls.filter(c => (c[1] as string[]).includes('server'));
    expect(headlessSpawns).toHaveLength(0);
    const sleepCalls = mockedExecFileSync.mock.calls.filter(c => c[0] === 'sleep');
    expect(sleepCalls).toHaveLength(0);
    be.kill();
  });

  it('ensureServer spawns `herdr server` then polls until hasSession returns true', () => {
    // First three session-list probes report empty, fourth reports running.
    let listCount = 0;
    setHerdrResponses([
      {
        match: a => a[0] === 'session' && a[1] === 'list',
        reply: () => {
          listCount++;
          return listCount >= 4 ? EXISTING_SESSION_REPLY : EMPTY_SESSIONS_REPLY;
        },
      },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('1-1') },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);
    const be = new HerdrBackend(SESSION);
    be.spawn('claude', [], { cwd: '/tmp', cols: 80, rows: 24, env: {} });
    const serverSpawn = mockedSpawn.mock.calls.find(c => (c[1] as string[]).includes('server'));
    expect(serverSpawn).toBeDefined();
    // At least one `sleep` invocation between session-list probes — proves we
    // are not busy-spinning.
    const sleepCalls = mockedExecFileSync.mock.calls.filter(c => c[0] === 'sleep');
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1);
    be.kill();
  });
});

// ─── spawn(): fresh / existing / external ──────────────────────────────────

describe('HerdrBackend.spawn', () => {
  it('fresh session: calls `agent start botmux --cwd <cwd> -- bin args...` and records pane_id', () => {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => '' },
      {
        match: a => a.includes('agent') && a.includes('start'),
        reply: () => JSON.stringify({ result: { agent: { name: 'botmux', pane_id: '2-3' } } }),
      },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('hello') },
    ]);
    const be = new HerdrBackend(SESSION);
    be.spawn('claude', ['--resume', 'abc'], { cwd: '/work', cols: 120, rows: 30, env: {} });

    const startCall = herdrCall('agent', 'start', 'botmux', '--cwd', '/work', '--', 'claude', '--resume', 'abc');
    expect(startCall).toBeDefined();
    expect(startCall).toContain('--session');
    expect(startCall![startCall!.indexOf('--session') + 1]).toBe(SESSION);
    be.kill();
  });

  it('reuses an existing agent without re-running `agent start`', () => {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('9-9') },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);
    const be = new HerdrBackend(SESSION);
    be.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });
    expect(herdrCall('agent', 'start', 'botmux')).toBeUndefined();
    be.kill();
  });

  it('external target adopt: uses externalTarget paneId, never spawns server or agent', () => {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('adopted screen') },
    ]);
    const be = new HerdrBackend(SESSION, {
      externalTarget: { sessionName: SESSION, target: '1-1', paneId: '1-1' },
    });
    be.spawn('', [], { cwd: '/work', cols: 80, rows: 24, env: {} });

    expect(herdrCall('agent', 'start', 'botmux')).toBeUndefined();
    const serverSpawn = mockedSpawn.mock.calls.find(c => (c[1] as string[]).includes('server'));
    expect(serverSpawn).toBeUndefined();
    be.kill();
  });

  it('external target adopt throws when the herdr session is not running', () => {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EMPTY_SESSIONS_REPLY },
    ]);
    const be = new HerdrBackend(SESSION, {
      externalTarget: { sessionName: SESSION, target: '1-1', paneId: '1-1' },
    });
    expect(() => be.spawn('', [], { cwd: '/work', cols: 80, rows: 24, env: {} }))
      .toThrow(/is not running/);
  });
});

// ─── Message writing ───────────────────────────────────────────────────────

describe('HerdrBackend message writing', () => {
  function spawnBackend(paneId = '1-1'): HerdrBackend {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY(paneId) },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);
    const be = new HerdrBackend(SESSION);
    be.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });
    mockedExecFileSync.mockClear();
    // re-install the response handlers since mockClear wipes them
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
      { match: a => a.includes('agent') && a.includes('list'), reply: () => AGENT_LIST_REPLY(paneId) },
    ]);
    return be;
  }

  it('write() / sendText() invoke `pane send-text` on the resolved pane id', () => {
    const be = spawnBackend('5-5');
    be.sendText('飞书消息');

    const call = herdrCall('pane', 'send-text', '5-5', '飞书消息');
    expect(call).toBeDefined();
    expect(call!.slice(0, 2)).toEqual(['--session', SESSION]);
    be.kill();
  });

  it('sendSpecialKeys() invokes `pane send-keys` with each key', () => {
    const be = spawnBackend('5-5');
    be.sendSpecialKeys('Enter', 'C-c');

    const call = herdrCall('pane', 'send-keys', '5-5', 'Enter', 'C-c');
    expect(call).toBeDefined();
    be.kill();
  });

  it('write() is a no-op after kill()', () => {
    const be = spawnBackend('5-5');
    be.kill();
    mockedExecFileSync.mockClear();
    be.sendText('after-exit');
    const call = herdrCall('pane', 'send-text');
    expect(call).toBeUndefined();
  });
});

// ─── Callbacks: onData delta + onExit ──────────────────────────────────────

describe('HerdrBackend callbacks', () => {
  it('onData fires with the prefix-delta when pane recent output grows', () => {
    let paneText = 'hello';
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('1-1') },
      { match: a => a.includes('agent') && a.includes('list'), reply: () => AGENT_LIST_REPLY('1-1') },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY(paneText) },
    ]);

    vi.useFakeTimers();
    // Use an isReattach backend so the baseline is captured at spawn
    // (lastText = current pane content) — that mirrors the worker.ts
    // reattach contract, where the initial screen is seeded separately and
    // the data stream emits only deltas.
    const be = new HerdrBackend(SESSION, { isReattach: true });
    const seen: string[] = [];
    be.onData(d => seen.push(d));
    be.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });

    // Reattach captures the current screen as baseline → no immediate emit.
    expect(seen).toEqual([]);

    paneText = 'hello world';
    vi.advanceTimersByTime(600); // > POLL_INTERVAL_MS (500ms)
    expect(seen).toEqual([' world']);

    paneText = 'hello world!';
    vi.advanceTimersByTime(600);
    expect(seen).toEqual([' world', '!']);

    be.kill();
  });

  it('onData fresh-spawn baseline: lastText starts empty so listeners see initial output', () => {
    // Counterpart to the reattach test: a fresh spawn keeps lastText='' so
    // listeners attached *before* spawn don't miss output the agent emitted
    // between agent-start and the first poll tick (the herdr-backend's
    // missing-initial-output bug we hit in the e2e run).
    let paneText = '';
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => '' },
      {
        match: a => a.includes('agent') && a.includes('start'),
        reply: () => JSON.stringify({ result: { agent: { name: 'botmux', pane_id: '1-1' } } }),
      },
      { match: a => a.includes('agent') && a.includes('list'), reply: () => AGENT_LIST_REPLY('1-1') },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY(paneText) },
    ]);

    vi.useFakeTimers();
    const be = new HerdrBackend(SESSION);
    const seen: string[] = [];
    be.onData(d => seen.push(d));
    be.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });

    paneText = 'HELLO_HERDR\n';
    vi.advanceTimersByTime(600);
    expect(seen.join('')).toBe('HELLO_HERDR\n');

    be.kill();
  });

  it('onExit fires when the agent disappears from `agent list`', () => {
    let agentAlive = true;
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('1-1') },
      {
        match: a => a.includes('agent') && a.includes('list'),
        reply: () => agentAlive
          ? AGENT_LIST_REPLY('1-1')
          : JSON.stringify({ result: { agents: [] } }),
      },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);

    vi.useFakeTimers();
    const be = new HerdrBackend(SESSION);
    const exits: Array<[number | null, string | null]> = [];
    be.onExit((code, signal) => exits.push([code, signal]));
    be.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });

    agentAlive = false;
    vi.advanceTimersByTime(600);
    expect(exits).toEqual([[0, null]]);
  });

  it('status watcher: one wait child per settled status (done/blocked/idle), first exit wins', () => {
    // Capture every fake `wait agent-status` child + its --status arg so the
    // test can drive a specific watcher's exit and verify the cohort
    // behaviour (first-to-fire reads, the rest get SIGTERM'd).
    const waitChildren: Array<{ status: string; child: FakeChild }> = [];
    mockedSpawn.mockImplementation(((_cmd: any, args: any) => {
      const child = makeFakeChild();
      const argv = args as string[];
      if (argv.includes('wait') && argv.includes('agent-status')) {
        const statusIdx = argv.indexOf('--status');
        waitChildren.push({ status: argv[statusIdx + 1]!, child });
      }
      return child;
    }) as any);

    let paneText = 'baseline';
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('1-1') },
      { match: a => a.includes('agent') && a.includes('list'), reply: () => AGENT_LIST_REPLY('1-1') },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY(paneText) },
    ]);

    // Reattach so the baseline is captured at spawn — keeps the assertion
    // focused on "watcher exit triggers delta", not on the initial screen.
    const be = new HerdrBackend(SESSION, { isReattach: true });
    const seen: string[] = [];
    be.onData(d => seen.push(d));
    be.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });

    // Cohort = one watcher per settled status.
    const cohort = waitChildren.slice();
    expect(cohort.map(w => w.status).sort()).toEqual(['blocked', 'done', 'idle']);

    // Simulate the agent transitioning to `done` mid-turn — that watcher wins.
    paneText = 'baseline result';
    const doneWatcher = cohort.find(w => w.status === 'done')!;
    doneWatcher.child.emit('exit', 0, null);

    // The win triggered a read+emit.
    expect(seen).toEqual([' result']);

    // The two losing siblings got killed and a fresh cohort got armed.
    for (const w of cohort) {
      if (w !== doneWatcher) expect(w.child.killed).toBe(true);
    }
    const nextCohort = waitChildren.slice(cohort.length);
    expect(nextCohort.map(w => w.status).sort()).toEqual(['blocked', 'done', 'idle']);

    be.kill();
    // kill() tears down the live cohort.
    for (const w of nextCohort) expect(w.child.killed).toBe(true);
  });
});
