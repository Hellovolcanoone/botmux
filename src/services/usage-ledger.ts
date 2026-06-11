/**
 * Usage ledger — durable per-turn token usage records.
 *
 * On every turn boundary (working→idle edge, session close) the daemon takes
 * a cumulative token snapshot of the session's transcript (via the cached
 * reader in cost-calculator) and appends the positive delta as one
 * self-describing JSON line to a daily ledger file.
 *
 * The ledger is the stable contract for external usage trackers (kaboo-cli
 * reads it the same way it reads HappyClaw's usage_records table):
 *   ~/.botmux/usage/usage-YYYY-MM-DD.jsonl   (UTC date, append-only)
 *   ~/.botmux/usage/state.json               (per-session baselines)
 *
 * Records intentionally carry redundant context (larkAppId, chatId, title,
 * callerOpenId, cumulative totals) so a single excerpted line self-validates
 * without joining back to sessions.json.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { getSessionTokenUsage, type SessionTokenUsage } from '../core/cost-calculator.js';
import type { DaemonSession } from '../core/types.js';

export interface UsageLedgerRecord {
  v: 1;
  recordId: string;
  ts: string;
  larkAppId?: string;
  sessionId: string;
  cliId?: string;
  cliSessionId?: string;
  chatId?: string;
  title?: string;
  workingDir?: string;
  /** open_id of the user whose message triggered this turn — attribution
   *  metadata only; usage is billed to the machine owner. */
  callerOpenId?: string;
  model: string;
  /** Positive deltas since the previous record of this session. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** Cumulative transcript totals at record time, for self-validation. */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreateTokens: number;
}

export interface RecordSessionUsageArgs {
  sessionId: string;
  usage: SessionTokenUsage;
  larkAppId?: string;
  cliId?: string;
  cliSessionId?: string;
  chatId?: string;
  title?: string;
  workingDir?: string;
  callerOpenId?: string;
  /** Injectable for tests; defaults to wall clock. */
  now?: Date;
  /** Injectable for tests; defaults to ~/.botmux/usage (BOTMUX_USAGE_DIR overrides). */
  ledgerDir?: string;
}

interface SessionBaseline {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  recordedAt: string;
  /** Bumped on every baseline reset (shrink, explicit anchor) so identical
   *  totals transitions in different epochs get distinct recordIds. */
  epoch?: number;
}

interface LedgerState {
  v: 1;
  sessions: { [sessionId: string]: SessionBaseline };
}

/** Baselines for sessions idle longer than this are pruned from state.json. */
const BASELINE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function defaultLedgerDir(): string {
  return process.env.BOTMUX_USAGE_DIR || join(homedir(), '.botmux', 'usage');
}

// Baselines are partitioned per bot (larkAppId): botmux can run one daemon
// per bot, and a shared read-modify-write state file would let one daemon's
// rename clobber another's freshly advanced baselines.
function statePath(dir: string, larkAppId?: string): string {
  const id = (larkAppId ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'default';
  return join(dir, `state-${id}.json`);
}

function loadState(dir: string, larkAppId?: string): LedgerState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(dir, larkAppId), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
      return { v: 1, sessions: parsed.sessions };
    }
  } catch { /* first run or corrupt state — start fresh */ }
  return { v: 1, sessions: {} };
}

function saveState(dir: string, larkAppId: string | undefined, state: LedgerState, now: Date): void {
  for (const [sessionId, baseline] of Object.entries(state.sessions)) {
    const recordedAt = Date.parse(baseline.recordedAt);
    if (Number.isFinite(recordedAt) && now.getTime() - recordedAt > BASELINE_RETENTION_MS) {
      delete state.sessions[sessionId];
    }
  }
  // temp+rename keeps a crash from truncating state; the pid suffix keeps
  // concurrent daemons from stomping each other's tmp file.
  const target = statePath(dir, larkAppId);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, target);
}

/** Deterministic id for one baseline→snapshot transition: a crash-replay of
 *  the same transition regenerates the SAME id, so the consumer's DedupKey
 *  collapses the duplicated ledger line instead of double counting it. */
function deterministicRecordId(
  sessionId: string,
  epoch: number,
  prev: SessionBaseline | undefined,
  cur: SessionTokenUsage,
): string {
  const h = createHash('sha256');
  h.update([
    sessionId,
    epoch,
    prev?.inputTokens ?? 0,
    prev?.outputTokens ?? 0,
    prev?.cacheReadTokens ?? 0,
    prev?.cacheCreateTokens ?? 0,
    cur.inputTokens,
    cur.outputTokens,
    cur.cacheReadTokens,
    cur.cacheCreateTokens,
  ].join('|'));
  return h.digest('hex').slice(0, 32);
}

function ledgerFilePath(dir: string, now: Date): string {
  const date = now.toISOString().slice(0, 10);
  return join(dir, `usage-${date}.jsonl`);
}

/**
 * Diff the cumulative usage snapshot against the session's stored baseline
 * and append a record when the delta is positive. Returns the record, or
 * null when there is nothing to write (no growth, or a shrink — transcript
 * rotation / clear — which just resets the baseline).
 */
export function recordSessionUsage(args: RecordSessionUsageArgs): UsageLedgerRecord | null {
  try {
    const now = args.now ?? new Date();
    const dir = args.ledgerDir ?? defaultLedgerDir();
    mkdirSync(dir, { recursive: true });

    const state = loadState(dir, args.larkAppId);
    const prev = state.sessions[args.sessionId];
    const cur = args.usage;
    const prevEpoch = prev?.epoch ?? 0;

    const deltaInput = cur.inputTokens - (prev?.inputTokens ?? 0);
    const deltaOutput = cur.outputTokens - (prev?.outputTokens ?? 0);
    const deltaCacheRead = cur.cacheReadTokens - (prev?.cacheReadTokens ?? 0);
    const deltaCacheCreate = cur.cacheCreateTokens - (prev?.cacheCreateTokens ?? 0);

    const baseline: SessionBaseline = {
      inputTokens: cur.inputTokens,
      outputTokens: cur.outputTokens,
      cacheReadTokens: cur.cacheReadTokens,
      cacheCreateTokens: cur.cacheCreateTokens,
      recordedAt: now.toISOString(),
      epoch: prevEpoch,
    };

    if (deltaInput < 0 || deltaOutput < 0 || deltaCacheRead < 0 || deltaCacheCreate < 0) {
      // Cumulative shrank (/clear, rotation): re-anchor, never write negatives.
      // The epoch bump keeps a later identical totals transition from reusing
      // a pre-reset recordId.
      baseline.epoch = prevEpoch + 1;
      state.sessions[args.sessionId] = baseline;
      saveState(dir, args.larkAppId, state, now);
      return null;
    }
    if (deltaInput === 0 && deltaOutput === 0 && deltaCacheRead === 0 && deltaCacheCreate === 0) {
      return null;
    }

    const record: UsageLedgerRecord = {
      v: 1,
      recordId: deterministicRecordId(args.sessionId, prevEpoch, prev, cur),
      ts: now.toISOString(),
      ...(args.larkAppId ? { larkAppId: args.larkAppId } : {}),
      sessionId: args.sessionId,
      ...(args.cliId ? { cliId: args.cliId } : {}),
      ...(args.cliSessionId ? { cliSessionId: args.cliSessionId } : {}),
      ...(args.chatId ? { chatId: args.chatId } : {}),
      ...(args.title ? { title: args.title } : {}),
      ...(args.workingDir ? { workingDir: args.workingDir } : {}),
      ...(args.callerOpenId ? { callerOpenId: args.callerOpenId } : {}),
      model: cur.model,
      inputTokens: deltaInput,
      outputTokens: deltaOutput,
      cacheReadTokens: deltaCacheRead,
      cacheCreateTokens: deltaCacheCreate,
      totalInputTokens: cur.inputTokens,
      totalOutputTokens: cur.outputTokens,
      totalCacheReadTokens: cur.cacheReadTokens,
      totalCacheCreateTokens: cur.cacheCreateTokens,
    };

    // Append first, then advance the baseline: a crash in between replays the
    // same transition with the SAME recordId, which the consumer dedupes.
    appendFileSync(ledgerFilePath(dir, now), JSON.stringify(record) + '\n');
    state.sessions[args.sessionId] = baseline;
    saveState(dir, args.larkAppId, state, now);
    return record;
  } catch (err: any) {
    // The ledger must never take the daemon down with it.
    logger.error(`usage-ledger: failed to record session usage: ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Re-anchor a session's baseline to the current cumulative snapshot WITHOUT
 * writing a record. Called at worker spawn: anything already in the
 * transcript at that point (resumed history, direct-tmux use while the
 * daemon was down) stays out of the ledger — only growth that happens while
 * botmux drives the session is recorded.
 */
export function anchorSessionUsage(args: RecordSessionUsageArgs): void {
  try {
    const now = args.now ?? new Date();
    const dir = args.ledgerDir ?? defaultLedgerDir();
    mkdirSync(dir, { recursive: true });

    const state = loadState(dir, args.larkAppId);
    state.sessions[args.sessionId] = {
      inputTokens: args.usage.inputTokens,
      outputTokens: args.usage.outputTokens,
      cacheReadTokens: args.usage.cacheReadTokens,
      cacheCreateTokens: args.usage.cacheCreateTokens,
      recordedAt: now.toISOString(),
      // Anchors start a new epoch: transitions after a re-anchor must never
      // collide with recordIds from before it.
      epoch: (state.sessions[args.sessionId]?.epoch ?? 0) + 1,
    };
    saveState(dir, args.larkAppId, state, now);
  } catch (err: any) {
    logger.error(`usage-ledger: failed to anchor session baseline: ${err?.message ?? err}`);
  }
}

// ─── Daemon-session wrappers ─────────────────────────────────────────────────

interface DaemonSessionLedgerOpts {
  now?: Date;
  ledgerDir?: string;
}

function ledgerArgsForDaemonSession(ds: DaemonSession): Omit<RecordSessionUsageArgs, 'usage'> & { usage: SessionTokenUsage | null } {
  const s = ds.session;
  const workingDir = ds.workingDir ?? s.workingDir;
  // fresh: ledger snapshots are turn-boundary exact — bypass the dashboard
  // read throttle (incremental folding keeps this cheap).
  const usage = getSessionTokenUsage({
    cliId: s.cliId ?? 'unknown',
    sessionId: s.sessionId,
    cliSessionId: s.cliSessionId,
    cwd: workingDir,
    fresh: true,
  });
  return {
    sessionId: s.sessionId,
    usage,
    larkAppId: ds.larkAppId ?? s.larkAppId,
    cliId: s.cliId,
    cliSessionId: s.cliSessionId,
    chatId: s.chatId,
    title: s.title,
    workingDir,
    callerOpenId: s.lastCallerOpenId ?? s.creatorOpenId ?? s.ownerOpenId,
  };
}

/** Turn boundary (idle/limited edge, session close): append the delta. */
export function recordUsageForDaemonSession(ds: DaemonSession, opts?: DaemonSessionLedgerOpts): UsageLedgerRecord | null {
  try {
    const args = ledgerArgsForDaemonSession(ds);
    if (!args.usage) return null;
    return recordSessionUsage({ ...args, usage: args.usage, ...opts });
  } catch (err: any) {
    logger.error(`usage-ledger: failed to record daemon session usage: ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Daemon-restart restore: a turn that was in flight when the daemon died may
 * have finished inside tmux while we were away — that work was submitted by
 * botmux and belongs in the ledger. If the session already has a baseline,
 * record the catch-up delta; only sessions the ledger has never seen are
 * anchored (their transcript history predates botmux bookkeeping).
 */
export function reconcileUsageForDaemonSession(ds: DaemonSession, opts?: DaemonSessionLedgerOpts): UsageLedgerRecord | null {
  try {
    const args = ledgerArgsForDaemonSession(ds);
    if (!args.usage) return null;
    const dir = opts?.ledgerDir ?? defaultLedgerDir();
    const state = loadState(dir, args.larkAppId);
    if (state.sessions[args.sessionId]) {
      return recordSessionUsage({ ...args, usage: args.usage, ...opts });
    }
    anchorSessionUsage({ ...args, usage: args.usage, ...opts });
    return null;
  } catch (err: any) {
    logger.error(`usage-ledger: failed to reconcile daemon session usage: ${err?.message ?? err}`);
    return null;
  }
}

/** Worker spawn: re-anchor so pre-existing transcript history is not billed. */
export function anchorUsageForDaemonSession(ds: DaemonSession, opts?: DaemonSessionLedgerOpts): void {
  try {
    const args = ledgerArgsForDaemonSession(ds);
    if (!args.usage) return;
    anchorSessionUsage({ ...args, usage: args.usage, ...opts });
  } catch (err: any) {
    logger.error(`usage-ledger: failed to anchor daemon session usage: ${err?.message ?? err}`);
  }
}
