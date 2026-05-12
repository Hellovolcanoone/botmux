import * as pty from 'node-pty';
import { execSync, execFileSync } from 'node:child_process';
import type { SessionBackend, SpawnOpts } from './types.js';
import { probeTmuxFunctional, tmuxEnv } from '../../setup/ensure-tmux.js';
import { logger } from '../../utils/logger.js';

/**
 * TmuxBackend — session backend using tmux for process persistence.
 *
 * Architecture: pty-under-tmux.
 *   - A node-pty process runs `tmux new-session` or `tmux attach-session`
 *   - All output flows through the pty (onData/onExit work unchanged)
 *   - kill() only detaches (kills the pty viewer), tmux session survives
 *   - destroySession() kills the tmux session (for explicit /close)
 *
 * Naming: tmux sessions are named `bmx-<sessionId.slice(0,8)>`.
 */
export class TmuxBackend implements SessionBackend {
  private process: pty.IPty | null = null;
  private readonly sessionName: string;
  private readonly ownsSession: boolean;
  private reattaching = false;
  /** Tmux pane target when in adopt mode (e.g. "0:2.0") — set by attachToExisting.
   *  When non-null, ALL pane-scoped tmux commands (send-keys / paste-buffer /
   *  copy-mode / list-panes) must address this pane explicitly; using
   *  `this.sessionName` would either resolve nothing (the name is synthetic
   *  in adopt mode) or fall through to whichever pane tmux happens to have
   *  active, which is exactly the bug we're avoiding. */
  private adoptedPaneTarget: string | null = null;

  constructor(sessionName: string, opts?: { ownsSession?: boolean }) {
    this.sessionName = sessionName;
    this.ownsSession = opts?.ownsSession ?? true;
  }

  /** Target string to use for pane-scoped tmux commands. In adopt mode this
   *  is the real pane address ("0:2.0"); otherwise the bmx-* session name. */
  private get cmdTarget(): string {
    return this.adoptedPaneTarget ?? this.sessionName;
  }

  // ─── Static helpers ───────────────────────────────────────────────────────

  /**
   * Check if tmux is usable — runs a functional probe (start + kill a
   * disposable server), not just `tmux -V`. Same probe as config.ts so
   * backend selection and runtime guard agree.
   */
  static isAvailable(): boolean {
    return probeTmuxFunctional().ok;
  }

  /** Derive tmux session name from a session UUID. */
  static sessionName(sessionId: string): string {
    return `bmx-${sessionId.slice(0, 8)}`;
  }

  /** Check if a named tmux session exists. */
  static hasSession(name: string): boolean {
    try {
      execSync(`tmux has-session -t ${shellescape(name)}`, { stdio: 'ignore', env: tmuxEnv() });
      return true;
    } catch {
      return false;
    }
  }

  /** Kill a named tmux session (no-op if it doesn't exist). */
  static killSession(name: string): void {
    try {
      execSync(`tmux kill-session -t ${shellescape(name)}`, { stdio: 'ignore', env: tmuxEnv() });
    } catch { /* session doesn't exist */ }
  }

  /** List all botmux tmux sessions (bmx-* prefix). */
  static listBotmuxSessions(): string[] {
    try {
      const out = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", {
        encoding: 'utf-8',
        env: tmuxEnv(),
      });
      return out.split('\n').filter(s => s.startsWith('bmx-'));
    } catch {
      return [];
    }
  }

  // ─── SessionBackend implementation ────────────────────────────────────────

  spawn(bin: string, args: string[], opts: SpawnOpts): void {
    this.reattaching = TmuxBackend.hasSession(this.sessionName);
    logger.debug(
      `[tmux:${this.sessionName}] spawn ${this.reattaching ? 'reattach' : 'new'} ` +
      `bin=${bin} args=${JSON.stringify(args)} cwd=${opts.cwd} ${opts.cols}x${opts.rows}`,
    );
    // Strip TMUX/TMUX_PANE from caller env before handing to pty.spawn — if
    // the daemon was started inside a tmux session, leaving TMUX set would
    // make this `tmux attach-session`/`new-session` target that parent
    // session's socket. After the user's terminal tmux dies, every call
    // here would print `error connecting to <stale-socket>` to the PTY and
    // flood the daemon log via the leaked-stderr path.
    const childEnv = tmuxEnv(opts.env);

    if (this.reattaching) {
      // Re-attach to surviving tmux session (CLI is still running)
      this.process = pty.spawn('tmux', ['attach-session', '-t', this.sessionName], {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: childEnv,
      });
    } else {
      // tmux server inherits env from its first session's creator; subsequent
      // sessions share that server env, which is frozen at first-spawn time
      // and may be missing PATH/NVM_BIN/PNPM_HOME entries the daemon's caller
      // added via .zshrc. To make tmux-backend behave like PtyBackend (which
      // forwards daemon process.env directly via pty.spawn's env option), we
      // pass every var in opts.env through `-e KEY=VAL`, except a small
      // blacklist of vars that would actively confuse tmux or that are
      // process-local (TMUX, _, OLDPWD, PWD, SHLVL).
      const envFlags = buildTmuxSessionEnvFlags(opts.env);

      // Create new tmux session running the CLI command
      const tmuxArgs = [
        'new-session',
        '-s', this.sessionName,
        ...envFlags,
        '-x', String(opts.cols),
        '-y', String(opts.rows),
        '--', bin, ...args,
      ];
      this.process = pty.spawn('tmux', tmuxArgs, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: childEnv,
      });
    }

    // Configure tmux session options.
    // Runs for BOTH new sessions and reattach — reattach needs this to
    // backfill options added after the session was originally created.
    // Setting an already-applied option is idempotent.
    setTimeout(() => {
      try {
        const t = shellescape(this.sessionName);
        const env = tmuxEnv();
        execSync(`tmux set-option -t ${t} status off`, { stdio: 'ignore', env });
        execSync(`tmux set-option -t ${t} mouse on`, { stdio: 'ignore', env });
        // set-clipboard is a server option — enable OSC 52 passthrough for web copy
        execSync(`tmux set-option -s set-clipboard on`, { stdio: 'ignore', env });
        execSync(`tmux set-option -t ${t} history-limit 50000`, { stdio: 'ignore', env });
        // Prevent web terminal clients (smaller viewport) from shrinking the
        // tmux window.  If a web client at 80×24 causes tmux to resize the
        // window down, reflowed content shifts buffer positions and the
        // terminal renderer's baseline tracking breaks — historical output
        // leaks into the streaming card.
        execSync(`tmux set-option -t ${t} window-size largest`, { stdio: 'ignore', env });
      } catch { /* session may not be ready yet — benign */ }
    }, 500);
  }

  /** Whether the last spawn() re-attached to an existing tmux session. */
  get isReattach(): boolean {
    return this.reattaching;
  }

  /** Claude Code session JSONL path — set by worker for claude-code sessions so
   *  the claude-code adapter can verify paste+Enter submissions via file growth. */
  claudeJsonlPath?: string;
  /** PID of the spawned Claude Code child — used by the claude-code adapter to
   *  follow Claude's authoritative session id via ~/.claude/sessions/<pid>.json. */
  cliPid?: number;
  /** Working directory the CLI was spawned in — cross-checked against the pid
   *  file's cwd field so a recycled PID can't mislead the resolver. */
  cliCwd?: string;

  write(data: string): void {
    this.process?.write(data);
  }

  /**
   * Send text literally to the tmux pane via `tmux send-keys -l`.
   * Uses execFileSync (no shell) so arbitrary text is safe — no escaping needed.
   * For multiline text, use pasteText() instead (send-keys -l sends \n as Enter).
   */
  sendText(text: string): void {
    execFileSync('tmux', ['send-keys', '-t', this.cmdTarget, '-l', '--', text], {
      stdio: 'ignore',
      timeout: 5000,
      env: tmuxEnv(),
    });
  }

  /** Send special keys (Enter, Escape, C-c, etc.) to the tmux pane. */
  sendSpecialKeys(...keys: string[]): void {
    execFileSync('tmux', ['send-keys', '-t', this.cmdTarget, ...keys], {
      stdio: 'ignore',
      timeout: 5000,
      env: tmuxEnv(),
    });
  }

  /**
   * Enter copy-mode on the pane (`-e` makes it auto-exit when scrolled back to
   * the bottom). Lets us use tmux's own scrollback even when the running app
   * is in the alternate screen buffer (Claude Code, vim, etc.).
   */
  enterCopyMode(): void {
    execFileSync('tmux', ['copy-mode', '-e', '-t', this.cmdTarget], {
      stdio: 'ignore',
      timeout: 5000,
      env: tmuxEnv(),
    });
  }

  /** Send a copy-mode X-command (e.g. 'halfpage-up', 'halfpage-down', 'cancel'). */
  sendCopyModeCommand(xCommand: string): void {
    execFileSync('tmux', ['send-keys', '-t', this.cmdTarget, '-X', xCommand], {
      stdio: 'ignore',
      timeout: 5000,
      env: tmuxEnv(),
    });
  }

  /**
   * Paste text into the tmux pane via load-buffer + paste-buffer.
   * Tmux automatically wraps in bracketed paste if the pane has it enabled.
   * Safe for multiline content (unlike sendText where \n becomes Enter).
   */
  pasteText(text: string): void {
    execFileSync('tmux', ['load-buffer', '-'], {
      input: text,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 5000,
      env: tmuxEnv(),
    });
    execFileSync('tmux', ['paste-buffer', '-t', this.cmdTarget, '-d'], {
      stdio: 'ignore',
      timeout: 5000,
      env: tmuxEnv(),
    });
  }

  resize(cols: number, rows: number): void {
    this.process?.resize(cols, rows);
  }

  /** Must be called AFTER spawn(). Callbacks registered before spawn are silently lost. */
  onData(cb: (data: string) => void): void {
    this.process?.onData(cb);
  }

  /** Must be called AFTER spawn(). Callbacks registered before spawn are silently lost. */
  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.process?.onExit(({ exitCode, signal }) => {
      cb(exitCode, signal !== undefined ? String(signal) : null);
    });
  }

  getChildPid(): number | null {
    try {
      // display-message resolves the *exact* target pane (single line out),
      // unlike list-panes which returns every pane in the target's window
      // when cmdTarget is a pane address — taking the first line of that
      // would silently bind to whichever pane tmux happens to list first.
      const output = execSync(
        `tmux display-message -p -t ${shellescape(this.cmdTarget)} '#{pane_pid}'`,
        // Explicit stdio: execSync's default leaks the child's stderr to the
        // parent's stderr fd. When tmux server is unavailable (transient
        // restart, killed by user, /tmp wiped), this command writes "error
        // connecting to /tmp/tmux-UID/default" to stderr, which the daemon's
        // worker.stderr handler then logs as a worker error every poll cycle.
        // tmuxEnv() also strips $TMUX so we don't target a dead parent server.
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000, env: tmuxEnv() },
      ).trim();
      const pid = parseInt(output, 10);
      return pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  /** Detach only — kills the pty viewer but leaves tmux session alive. */
  kill(): void {
    // Unzoom adopted pane before detaching (restore user's original layout)
    if (this.adoptedPaneTarget) {
      try {
        // Only unzoom if the pane is currently zoomed
        const zoomed = execSync(
          `tmux display -t ${shellescape(this.adoptedPaneTarget)} -p '#{window_zoomed_flag}'`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: tmuxEnv() },
        ).trim();
        if (zoomed === '1') {
          execSync(`tmux resize-pane -Z -t ${shellescape(this.adoptedPaneTarget)}`, { stdio: 'ignore', env: tmuxEnv() });
        }
      } catch { /* pane may be gone — benign */ }
      this.adoptedPaneTarget = null;
    }
    if (this.process) {
      try { this.process.kill(); } catch { /* already dead */ }
      this.process = null;
    }
  }

  /** Kill the tmux session permanently. Called on explicit /close. */
  destroySession(): void {
    this.kill();
    if (this.ownsSession) {
      TmuxBackend.killSession(this.sessionName);
    }
  }

  /**
   * Attach to an existing user tmux pane (not a bmx-* session).
   * Used by adopt mode — Botmux observes an already-running CLI.
   *
   * Zooms the target pane so only it is visible (hides other panes in the window).
   * The zoom is undone when the backend is killed (detach/disconnect).
   */
  attachToExisting(tmuxTarget: string, opts: SpawnOpts): void {
    this.reattaching = true;
    this.adoptedPaneTarget = tmuxTarget;

    // Zoom the target pane BEFORE attaching — this makes the pane fill the entire
    // window, so the PTY output (and web terminal) only shows this one pane.
    // If the pane is already the only one in the window, zoom is a no-op.
    //
    // We intentionally attach to the source session directly rather than
    // creating a grouped viewer session: in tmux -CC + iTerm2 control mode
    // the extra session disrupts the integration's window/pane bookkeeping
    // and tearing it down on disconnect breaks the user's original layout
    // (iTerm splits one source window's panes into separate native windows).
    // The downside is the web terminal will follow whichever window the
    // user's primary -CC client is currently focused on; that stickiness
    // can be revisited later via `tmux pipe-pane` (out-of-band capture)
    // without polluting the -CC client.
    try {
      execSync(`tmux resize-pane -Z -t ${shellescape(tmuxTarget)}`, { stdio: 'ignore', env: tmuxEnv() });
    } catch { /* benign */ }

    this.process = pty.spawn('tmux', ['attach-session', '-t', tmuxTarget], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: tmuxEnv(opts.env),
    });
  }

  getAttachInfo() {
    return { type: 'tmux' as const, sessionName: this.sessionName };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Vars NOT to forward via `-e` to a new tmux session.
 *
 *   - TMUX / TMUX_PANE: tmuxEnv() already strips these from the tmux client's
 *     own env; keep them out of the spawned CLI's env too so any tmux child
 *     the CLI itself spawns can't sneak through and target a dead socket.
 *   - PWD / OLDPWD: tmux uses the `cwd` we pass via pty.spawn options;
 *     forwarding PWD verbatim would override that with the daemon's cwd.
 *   - SHLVL / `_`: shell-local bookkeeping that's meaningless in the child
 *     and confusing if a user runs `env` inside the CLI.
 */
const TMUX_PASSTHROUGH_BLACKLIST: ReadonlySet<string> = new Set([
  'TMUX',
  'TMUX_PANE',
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
]);

/** Valid POSIX-ish env var name. `-e KEY=VAL` would silently misbehave with
 *  keys that contain `=` or unusual characters; clamp here so a malformed
 *  parent env can't desync tmux's argv. */
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Build `-e KEY=VAL ...` argv flags for `tmux new-session`. Forwards every
 * defined entry in `env` (so the CLI inherits PATH / NVM_* / PNPM_HOME /
 * LARK_APP_*, etc.) except the blacklist above and entries whose key isn't
 * a valid env-var name. Pure function so it can be unit-tested without
 * spawning tmux.
 *
 * Background: tmux `new-session ... -- cmd` runs cmd with the tmux **server's**
 * env, not the env we pass to `pty.spawn('tmux', ...)`. Whatever isn't
 * forwarded via `-e` gets dropped on the floor — that's how CoCo (and any
 * other `#!/usr/bin/env node` script installed under nvm/pnpm) used to land
 * in a tmux session with a PATH that doesn't see `node`.
 */
export function buildTmuxSessionEnvFlags(env: NodeJS.ProcessEnv | undefined): string[] {
  if (!env) return [];
  const flags: string[] = [];
  for (const [key, val] of Object.entries(env)) {
    if (val === undefined) continue;
    if (TMUX_PASSTHROUGH_BLACKLIST.has(key)) continue;
    if (!ENV_VAR_NAME_RE.test(key)) continue;
    flags.push('-e', `${key}=${val}`);
  }
  return flags;
}

/** Minimal shell-escape for tmux session names (alphanumeric + dash). */
function shellescape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
