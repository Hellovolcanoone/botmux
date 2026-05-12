/**
 * Regression test: TmuxBackend must forward daemon `process.env` to the
 * spawned CLI via `tmux new-session -e KEY=VAL` flags.
 *
 * Failure mode this guards against:
 *   - tmux's `new-session ... -- cmd` runs cmd with the tmux **server's**
 *     env (frozen at first-spawn time), not the env passed to pty.spawn.
 *   - Pre-fix, only a hand-picked allow-list (LARK_*, *_PROXY, IS_SANDBOX,
 *     SESSION_DATA_DIR, BOTMUX) was forwarded via `-e`, so PATH / NVM_BIN /
 *     PNPM_HOME / HOME / USER got dropped.
 *   - Any `#!/usr/bin/env node` CLI installed under nvm or pnpm (CoCo, Aiden,
 *     etc.) then exited code 1 immediately because the tmux session's PATH
 *     didn't see `node`.
 */
import { describe, it, expect } from 'vitest';
import { buildTmuxSessionEnvFlags } from '../src/adapters/backend/tmux-backend.js';

describe('buildTmuxSessionEnvFlags()', () => {
  it('forwards every defined env entry as a -e KEY=VAL pair', () => {
    const flags = buildTmuxSessionEnvFlags({
      PATH: '/home/u/.nvm/versions/node/v20/bin:/usr/bin',
      HOME: '/home/u',
      NVM_BIN: '/home/u/.nvm/versions/node/v20/bin',
      PNPM_HOME: '/home/u/.local/share/pnpm',
    });
    // -e PATH=... -e HOME=... -e NVM_BIN=... -e PNPM_HOME=...
    expect(flags).toEqual([
      '-e', 'PATH=/home/u/.nvm/versions/node/v20/bin:/usr/bin',
      '-e', 'HOME=/home/u',
      '-e', 'NVM_BIN=/home/u/.nvm/versions/node/v20/bin',
      '-e', 'PNPM_HOME=/home/u/.local/share/pnpm',
    ]);
  });

  it('still forwards the previously-allowlisted vars (LARK_*, IS_SANDBOX, etc.)', () => {
    const flags = buildTmuxSessionEnvFlags({
      LARK_APP_ID: 'cli_abc',
      LARK_APP_SECRET: 'secret',
      BOTMUX: '1',
      __OWNER_OPEN_ID: 'ou_x',
      SESSION_DATA_DIR: '/home/u/.botmux/data',
      IS_SANDBOX: '1',
      HTTP_PROXY: 'http://proxy:8080',
      HTTPS_PROXY: 'http://proxy:8080',
      http_proxy: 'http://proxy:8080',
      NO_PROXY: 'localhost',
    });
    const joined = flags.join(' ');
    expect(joined).toContain('-e LARK_APP_ID=cli_abc');
    expect(joined).toContain('-e LARK_APP_SECRET=secret');
    expect(joined).toContain('-e BOTMUX=1');
    expect(joined).toContain('-e __OWNER_OPEN_ID=ou_x');
    expect(joined).toContain('-e SESSION_DATA_DIR=/home/u/.botmux/data');
    expect(joined).toContain('-e IS_SANDBOX=1');
    expect(joined).toContain('-e HTTP_PROXY=http://proxy:8080');
    expect(joined).toContain('-e HTTPS_PROXY=http://proxy:8080');
    expect(joined).toContain('-e http_proxy=http://proxy:8080');
    expect(joined).toContain('-e NO_PROXY=localhost');
  });

  it('drops TMUX / TMUX_PANE so a stale parent socket address never reaches the child', () => {
    const flags = buildTmuxSessionEnvFlags({
      TMUX: '/tmp/tmux-99999/missing,12345,0',
      TMUX_PANE: '%99',
      PATH: '/usr/bin',
    });
    const joined = flags.join(' ');
    expect(joined).not.toContain('TMUX=');
    expect(joined).not.toContain('TMUX_PANE=');
    expect(joined).toContain('-e PATH=/usr/bin');
  });

  it('drops shell-local bookkeeping (_, OLDPWD, PWD, SHLVL)', () => {
    const flags = buildTmuxSessionEnvFlags({
      _: '/usr/bin/node',
      OLDPWD: '/home/u',
      PWD: '/home/u/work',
      SHLVL: '2',
      LANG: 'en_US.UTF-8',
    });
    const joined = flags.join(' ');
    expect(joined).not.toMatch(/-e _=/);
    expect(joined).not.toContain('OLDPWD=');
    expect(joined).not.toContain('PWD=');
    expect(joined).not.toContain('SHLVL=');
    expect(joined).toContain('-e LANG=en_US.UTF-8');
  });

  it('skips entries whose value is undefined', () => {
    // worker.ts:2285 spreads { ...process.env, CLAUDECODE: undefined } — the
    // explicit `undefined` should not produce a `-e CLAUDECODE=undefined`.
    const flags = buildTmuxSessionEnvFlags({
      PATH: '/usr/bin',
      CLAUDECODE: undefined,
    });
    expect(flags).toEqual(['-e', 'PATH=/usr/bin']);
  });

  it('skips entries whose key is not a valid POSIX env-var name', () => {
    // Defensive: a malformed parent env (e.g. a key containing `=`) must not
    // be able to inject extra `-e` flags or desync the tmux argv. We just
    // drop those entries entirely.
    const flags = buildTmuxSessionEnvFlags({
      'OK_NAME': '1',
      '1BAD': 'starts-with-digit',
      'BAD-KEY': 'contains-dash',
      'BAD=KEY': 'contains-equals',
      '': 'empty-key',
    });
    expect(flags).toEqual(['-e', 'OK_NAME=1']);
  });

  it('handles undefined env arg (no spawn-opts env passed)', () => {
    expect(buildTmuxSessionEnvFlags(undefined)).toEqual([]);
  });

  it('preserves values containing spaces, quotes, and other special chars', () => {
    // Each `-e KEY=VAL` lands in execve(2)'s argv directly — no shell, no
    // escaping needed. The VAL string is passed through verbatim, and tmux
    // splits on the first `=` to get key/value.
    const flags = buildTmuxSessionEnvFlags({
      WITH_SPACE: 'hello world',
      WITH_QUOTE: `it's "tricky"`,
      WITH_EQUALS: 'a=b=c',
      WITH_NEWLINE: 'line1\nline2',
    });
    expect(flags).toContain('-e');
    expect(flags).toContain('WITH_SPACE=hello world');
    expect(flags).toContain(`WITH_QUOTE=it's "tricky"`);
    expect(flags).toContain('WITH_EQUALS=a=b=c');
    expect(flags).toContain('WITH_NEWLINE=line1\nline2');
  });
});
