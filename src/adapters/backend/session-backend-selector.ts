import { HerdrBackend } from './herdr-backend.js';
import { PtyBackend } from './pty-backend.js';
import { TmuxBackend } from './tmux-backend.js';
import { TmuxPipeBackend } from './tmux-pipe-backend.js';
import { ZellijBackend } from './zellij-backend.js';
import type { BackendType, SessionBackend } from './types.js';

export interface SelectedSessionBackend {
  backend: SessionBackend;
  isTmuxMode: boolean;
  isPipeMode: boolean;
  /** True for the pty-under-zellij backend. From the worker's POV it behaves
   *  like the non-tmux (pty) path — screenshots via the headless renderer, web
   *  terminal via relay — but it owns a persistent zellij session internally. */
  isZellijMode: boolean;
}

export function selectSessionBackend(opts: { sessionId: string; backendType: BackendType }): SelectedSessionBackend {
  if (opts.backendType === 'zellij') {
    const sessionName = ZellijBackend.sessionName(opts.sessionId);
    const reattach = ZellijBackend.hasSession(sessionName);
    return {
      backend: new ZellijBackend(sessionName, { ownsSession: true, isReattach: reattach }),
      isTmuxMode: false,
      isPipeMode: false,
      isZellijMode: true,
    };
  }

  if (opts.backendType === 'pty') {
    return {
      backend: new PtyBackend(),
      isTmuxMode: false,
      isPipeMode: false,
      isZellijMode: false,
    };
  }

  if (opts.backendType === 'herdr') {
    const sessionName = HerdrBackend.sessionName(opts.sessionId);
    if (HerdrBackend.hasSession(sessionName)) {
      return {
        backend: new HerdrBackend(sessionName, { isReattach: true }),
        isTmuxMode: false,
        isPipeMode: true,
        isZellijMode: false,
      };
    }

    return {
      backend: new HerdrBackend(sessionName, { createSession: true }),
      isTmuxMode: false,
      isPipeMode: true,
      isZellijMode: false,
    };
  }

  const sessionName = TmuxBackend.sessionName(opts.sessionId);
  if (TmuxBackend.hasSession(sessionName)) {
    return {
      backend: new TmuxPipeBackend(sessionName, { ownsSession: true, isReattach: true }),
      isTmuxMode: true,
      isPipeMode: true,
      isZellijMode: false,
    };
  }

  return {
    backend: new TmuxPipeBackend(sessionName, { createSession: true, ownsSession: true }),
    isTmuxMode: true,
    isPipeMode: true,
    isZellijMode: false,
  };
}
