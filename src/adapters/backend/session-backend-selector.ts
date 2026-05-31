import { HerdrBackend } from './herdr-backend.js';
import { PtyBackend } from './pty-backend.js';
import { TmuxBackend } from './tmux-backend.js';
import { TmuxPipeBackend } from './tmux-pipe-backend.js';
import type { BackendType, SessionBackend } from './types.js';

export interface SelectedSessionBackend {
  backend: SessionBackend;
  isTmuxMode: boolean;
  isPipeMode: boolean;
}

export function selectSessionBackend(opts: { sessionId: string; backendType: BackendType }): SelectedSessionBackend {
  if (opts.backendType === 'pty') {
    return {
      backend: new PtyBackend(),
      isTmuxMode: false,
      isPipeMode: false,
    };
  }

  if (opts.backendType === 'herdr') {
    const sessionName = HerdrBackend.sessionName(opts.sessionId);
    if (HerdrBackend.hasSession(sessionName)) {
      return {
        backend: new HerdrBackend(sessionName, { isReattach: true }),
        isTmuxMode: false,
        isPipeMode: true,
      };
    }

    return {
      backend: new HerdrBackend(sessionName, { createSession: true }),
      isTmuxMode: false,
      isPipeMode: true,
    };
  }

  const sessionName = TmuxBackend.sessionName(opts.sessionId);
  if (TmuxBackend.hasSession(sessionName)) {
    return {
      backend: new TmuxPipeBackend(sessionName, { ownsSession: true, isReattach: true }),
      isTmuxMode: true,
      isPipeMode: true,
    };
  }

  return {
    backend: new TmuxPipeBackend(sessionName, { createSession: true, ownsSession: true }),
    isTmuxMode: true,
    isPipeMode: true,
  };
}
