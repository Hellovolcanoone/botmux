/**
 * Zellij adopt discovery — find CLIs running in a user's zellij sessions and
 * resolve the (paneId, pid, cwd, cliSessionId) needed to adopt them.
 *
 * The per-pid resolution (CLI detection, cwd, CLI-native session id) is shared
 * with the tmux path (session-discovery.ts) — multiplexer-agnostic. What's
 * zellij-specific is pane enumeration (`dump-layout` for command/cwd +
 * `list-panes` for the drive id) and the pane→pid join.
 *
 * pane→pid join: zellij exposes no pid in list-panes, so we enumerate the
 * session server's descendant CLI processes and match each dump-layout pane by
 * (cliId, cwd). cwd is a strong discriminator (each CLI usually in its own
 * project dir). If a pane matches zero or >1 process, we REFUSE it (skip) —
 * better no-adopt than adopting the wrong pane (Codex's guidance).
 */
import { realpathSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { CliId } from '../adapters/cli/types.js';
import {
  cliIdForComm, readComm, readCwd, getChildPids, readClaudeSessionMeta,
} from './session-discovery.js';
import { findCodexRolloutByPid } from '../services/codex-transcript.js';
import { findCocoSessionByPid } from '../services/coco-transcript.js';
import { findServerPid } from '../adapters/backend/zellij-backend.js';
import {
  listLiveSessions, parseDumpLayoutLeafPanes, parseListPanesJson,
} from './zellij-session-discovery.js';
import { zellijEnv } from '../setup/ensure-zellij.js';
import { logger } from '../utils/logger.js';
import { execFileSync } from 'node:child_process';

export interface ZellijAdoptableSession {
  zellijSession: string;   // e.g. "mywork"
  zellijPaneId: string;    // e.g. "terminal_1" — the action/dump-screen target
  cliPid: number;          // resolved CLI process pid
  cliId: CliId;
  sessionId?: string;      // CLI-native session id (claude/codex/coco)
  cwd: string;             // CLI working directory
  startedAt?: number;      // epoch ms (claude only)
  paneCols: number;
  paneRows: number;
}

/** Normalise a path for comparison (resolve symlinks + strip trailing slash). */
function canonPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  let out = p;
  try { out = realpathSync(p); } catch { /* keep raw */ }
  return out.length > 1 && out.endsWith('/') ? out.slice(0, -1) : out;
}

/** Interpreters that launch a CLI as a script argument (fnm/npx shims, etc.),
 *  so the CLI identity lives in argv, not in comm. */
const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python2', 'python3', 'ruby', 'npx', 'tsx']);

/** /proc/<pid>/cmdline → argv (Linux fast path; ps fallback for macOS). */
function readCmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').filter(Boolean);
  } catch {
    try {
      const out = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      return out.trim().split(/\s+/).filter(Boolean);
    } catch { return []; }
  }
}

/**
 * Resolve a CliId from a process's comm + argv (pure — unit testable). Checks
 * comm first (renamed binary, e.g. `codex`/`claude`); if comm is a bare
 * interpreter (e.g. an fnm shim launches `node …/bin/codex`, so /proc/comm is
 * "node"), scan argv for the CLI script basename. Without this, node-wrapped
 * CLIs are invisible to discovery.
 */
export function cliIdFromCommArgv(comm: string | undefined, argv: string[], filterCliId?: CliId): CliId | undefined {
  if (!comm) return undefined;
  // cliIdForComm only special-cases mtr/opencode for filterCliId; it does NOT
  // otherwise filter — so apply the filter explicitly at the end.
  let detected = cliIdForComm(comm, filterCliId);
  if (!detected && INTERPRETERS.has(comm)) {
    for (const arg of argv.slice(1)) {
      if (arg.startsWith('-')) continue; // skip flags
      const id = cliIdForComm(basename(arg), filterCliId);
      if (id) { detected = id; break; }
    }
  }
  if (!detected) return undefined;
  if (filterCliId && detected !== filterCliId) return undefined;
  return detected;
}

function cliIdForProc(pid: number, filterCliId?: CliId): CliId | undefined {
  return cliIdFromCommArgv(readComm(pid), readCmdline(pid), filterCliId);
}

/** BFS the process tree under rootPid collecting every known CLI process with
 *  its cwd, for matching against dump-layout panes. Interpreter-wrapper chains
 *  (e.g. an fnm shim `node …/bin/codex` whose child is the native `codex`
 *  binary) are collapsed to ONE entry — the deepest match — so a single CLI
 *  doesn't look like two same-cwd candidates (which would trip the ambiguity
 *  guard). The deepest process is also the one holding the transcript fds,
 *  matching tmux's findCliProcess. */
function findAllClisUnder(
  rootPid: number,
  maxDepth: number,
  filterCliId?: CliId,
): Array<{ pid: number; cliId: CliId; cwd?: string }> {
  const found: Array<{ pid: number; cliId: CliId; cwd?: string }> = [];
  const parentOf = new Map<number, number>();
  let current = [rootPid];
  for (let depth = 0; depth <= maxDepth && current.length > 0; depth++) {
    const next: number[] = [];
    for (const pid of current) {
      const cliId = cliIdForProc(pid, filterCliId);
      if (cliId) found.push({ pid, cliId, cwd: canonPath(readCwd(pid)) });
      for (const ch of getChildPids(pid)) { parentOf.set(ch, pid); next.push(ch); }
    }
    current = next;
  }
  // Drop a match that is an ancestor of another same-cliId match (the wrapper);
  // keep the deepest (native) process.
  const isAncestor = (anc: number, desc: number): boolean => {
    let p: number | undefined = desc;
    while (p !== undefined && parentOf.has(p)) { p = parentOf.get(p); if (p === anc) return true; }
    return false;
  };
  return found.filter(m => !found.some(n => n.pid !== m.pid && n.cliId === m.cliId && isAncestor(m.pid, n.pid)));
}

/** Run a read-only `zellij --session S action …`, returning stdout or null. */
function zellijRead(session: string, args: string[]): string | null {
  try {
    return execFileSync('zellij', ['--session', session, 'action', ...args], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, env: zellijEnv(),
    });
  } catch {
    return null;
  }
}

/** Trailing integer of a "terminal_<n>" id, for stable sorting. */
function paneNum(paneId: string): number {
  const m = paneId.match(/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

/** Live pane dimensions (content area) for a paneId in a session. */
function paneDimensions(session: string, paneId: string): { cols: number; rows: number } | undefined {
  try {
    const out = execFileSync('zellij', ['--session', session, 'action', 'list-panes', '--json'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, env: zellijEnv(),
    });
    const arr = JSON.parse(out);
    if (!Array.isArray(arr)) return undefined;
    const pane = arr.find((p: any) => !p.is_plugin && `terminal_${p.id}` === paneId);
    if (!pane) return undefined;
    const cols = Number(pane.pane_content_columns ?? pane.pane_columns);
    const rows = Number(pane.pane_content_rows ?? pane.pane_rows);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return undefined;
    return { cols, rows };
  } catch {
    return undefined;
  }
}

function resolveSessionId(cliId: CliId, pid: number): { sessionId?: string; startedAt?: number } {
  if (cliId === 'claude-code') {
    const meta = readClaudeSessionMeta(pid);
    return { sessionId: meta?.sessionId, startedAt: meta?.startedAt };
  }
  if (cliId === 'codex') {
    const rollout = findCodexRolloutByPid(pid);
    return { sessionId: rollout?.cliSessionId };
  }
  if (cliId === 'coco') {
    const coco = findCocoSessionByPid(pid);
    return { sessionId: coco?.sessionId };
  }
  return {};
}

/**
 * Scan all live zellij sessions for adoptable CLIs. Skips bmx-* (botmux's own).
 * @param filterCliId only return sessions matching this CLI type.
 */
export function discoverAdoptableZellijSessions(filterCliId?: CliId): ZellijAdoptableSession[] {
  const results: ZellijAdoptableSession[] = [];

  for (const session of listLiveSessions()) {
    if (session.startsWith('bmx-')) continue;

    const layoutOut = zellijRead(session, ['dump-layout']);
    const panesOut = zellijRead(session, ['list-panes', '--json']);
    if (!layoutOut || !panesOut) continue;

    // Positional join: ALL leaf terminal panes (command + bare shell) in
    // dump-layout document order vs non-plugin/non-floating terminals in
    // list-panes sorted by id. Counts MUST match or the alignment is
    // untrustworthy — refuse the whole session rather than bind the wrong pane.
    const leaves = parseDumpLayoutLeafPanes(layoutOut);
    const terminals = parseListPanesJson(panesOut)
      .filter(p => !p.isPlugin && !p.isFloating)
      .sort((a, b) => paneNum(a.paneId) - paneNum(b.paneId));
    if (leaves.length === 0 || leaves.length !== terminals.length) {
      if (leaves.length !== terminals.length) {
        logger.debug(`[zellij-adopt] ${session}: leaf(${leaves.length})/terminal(${terminals.length}) count mismatch — refusing adopt`);
      }
      continue;
    }

    const serverPid = findServerPid(session);
    if (!serverPid) continue;
    const clis = findAllClisUnder(serverPid, 4, filterCliId);

    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i]!;
      const term = terminals[i]!;
      if (!leaf.command) continue; // bare shell pane — not adoptable

      // The cliId comes from the actual PROCESS (cliIdForProc handles
      // node-wrapped CLIs where dump-layout's command is just "node"); we only
      // need leaf.command to know the pane is running something. Bind by cwd:
      // each running pane's cwd should match exactly one process-tree CLI of
      // the (already filtered) cliId. `clis` is pre-filtered by filterCliId.
      const paneCwd = canonPath(leaf.cwd);
      const matches = clis.filter(c => c.cwd && c.cwd === paneCwd);
      // Refuse ambiguous (>1) or unresolved (0) — never adopt the wrong pane.
      if (matches.length !== 1) continue;
      const cli = matches[0]!;

      const dims = paneDimensions(session, term.paneId);
      if (!dims) continue;

      const { sessionId, startedAt } = resolveSessionId(cli.cliId, cli.pid);
      results.push({
        zellijSession: session,
        zellijPaneId: term.paneId,
        cliPid: cli.pid,
        cliId: cli.cliId,
        sessionId,
        cwd: cli.cwd ?? leaf.cwd ?? '',
        startedAt,
        paneCols: dims.cols,
        paneRows: dims.rows,
      });
    }
  }

  return results;
}

/** Re-confirm a zellij pane still runs the expected CLI pid (pre-adopt guard). */
export function validateZellijAdoptTarget(session: string, paneId: string, expectedPid: number): boolean {
  const serverPid = findServerPid(session);
  if (!serverPid) return false;
  const clis = findAllClisUnder(serverPid, 4);
  if (!clis.some(c => c.pid === expectedPid)) return false;
  // And the pane must still exist.
  return paneDimensions(session, paneId) !== undefined;
}
