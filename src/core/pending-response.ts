import type { Session } from '../types.js';

export const COMPLETED_REACTION_EMOJI_TYPE = 'DONE';

type PendingResponseSession = Pick<Session, 'pendingResponseCardId' | 'pendingResponseCardState' | 'lastPatchedResponseCardId'>;

export function isPendingResponseCardOpen(session: Pick<Session, 'pendingResponseCardId' | 'pendingResponseCardState'>): boolean {
  return !!session.pendingResponseCardId && session.pendingResponseCardState === 'open';
}

/** Sync only the cross-process pending-response fields from a fresher Session. */
export function syncPendingResponseState(target: PendingResponseSession, source: PendingResponseSession | undefined): void {
  if (!source) return;
  target.pendingResponseCardId = source.pendingResponseCardId;
  target.pendingResponseCardState = source.pendingResponseCardState;
  target.lastPatchedResponseCardId = source.lastPatchedResponseCardId;
}

export function mergePendingResponseState<T extends PendingResponseSession>(incoming: T, existing: PendingResponseSession | undefined): T {
  if (!existing) return incoming;

  const hasExistingPendingState = existing.pendingResponseCardId !== undefined
    || existing.pendingResponseCardState !== undefined
    || existing.lastPatchedResponseCardId !== undefined;
  if (!hasExistingPendingState) return incoming;

  const incomingStartsNewOpenCard = incoming.pendingResponseCardState === 'open'
    && !!incoming.pendingResponseCardId
    && incoming.pendingResponseCardId !== existing.lastPatchedResponseCardId;
  if (incomingStartsNewOpenCard) return incoming;

  const incomingMarksPatched = incoming.pendingResponseCardState === 'patched';
  const existingHasNewerOpenCard = existing.pendingResponseCardState === 'open'
    && !!existing.pendingResponseCardId
    && incoming.lastPatchedResponseCardId !== existing.pendingResponseCardId;
  if (incomingMarksPatched && !existingHasNewerOpenCard) return incoming;

  return {
    ...incoming,
    pendingResponseCardId: existing.pendingResponseCardId,
    pendingResponseCardState: existing.pendingResponseCardState,
    lastPatchedResponseCardId: existing.lastPatchedResponseCardId,
  };
}

export function shouldUseCardForSend(opts: {
  forceCard: boolean;
  forceText: boolean;
  hasMarkdown: boolean;
  hasOpenPendingResponseCard: boolean;
}): boolean {
  if (opts.hasOpenPendingResponseCard) return true;
  return opts.forceCard || (!opts.forceText && opts.hasMarkdown);
}

export function shouldWithdrawPreviousPendingOnNewTurn(_session: Pick<Session, 'pendingResponseCardId' | 'pendingResponseCardState'>): boolean {
  return false;
}

/** A patched marker means the Feishu PATCH returned, but session save may not have. */
export function shouldTreatPendingCardAsPatchedByMarker(
  pendingCardId: string | undefined,
  marker: { cardId?: string; state?: string } | undefined,
): boolean {
  return !!pendingCardId && marker?.state === 'patched' && marker.cardId === pendingCardId;
}

export function createPendingResponseQueue() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const prev = tails.get(key);
      const next = prev ? prev.catch(() => undefined).then(work) : work();
      const stored = next.finally(() => {
        if (tails.get(key) === stored) tails.delete(key);
      });
      tails.set(key, stored);
      return next;
    },
    size(): number { return tails.size; },
  };
}

export function startPendingResponseTurn(session: PendingResponseSession, messageId: string): void {
  session.pendingResponseCardId = messageId;
  session.pendingResponseCardState = 'open';
}

/** Mark the current open placeholder as patched; keep its id for diagnostics. */
export function markPendingResponseCardPatched(session: PendingResponseSession): void {
  session.lastPatchedResponseCardId = session.pendingResponseCardId;
  session.pendingResponseCardId = undefined;
  session.pendingResponseCardState = 'patched';
}

export function markPendingResponseCardPatchedIfCurrent(session: PendingResponseSession, cardId: string): boolean {
  if (session.pendingResponseCardId !== cardId || session.pendingResponseCardState !== 'open') return false;
  markPendingResponseCardPatched(session);
  return true;
}

/** Read the open placeholder id without claiming it until PATCH succeeds. */
export function claimPendingResponseCard(session: PendingResponseSession): string | undefined {
  return isPendingResponseCardOpen(session) ? session.pendingResponseCardId : undefined;
}
