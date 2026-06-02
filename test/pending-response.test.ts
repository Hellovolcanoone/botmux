import { describe, expect, it } from 'vitest';

import {
  claimPendingResponseCard,
  COMPLETED_REACTION_EMOJI_TYPE,
  createPendingResponseQueue,
  isPendingResponseCardOpen,
  markPendingResponseCardPatched,
  markPendingResponseCardPatchedIfCurrent,
  shouldWithdrawPreviousPendingOnNewTurn,
  shouldUseCardForSend,
  startPendingResponseTurn,
  syncPendingResponseState,
} from '../src/core/pending-response.js';

describe('pending response state', () => {
  it('uses the Feishu completed emoji for completion notification', () => {
    expect(COMPLETED_REACTION_EMOJI_TYPE).toBe('DONE');
  });

  it('starts and patches pending response state explicitly', () => {
    const session = {} as { pendingResponseCardId?: string; pendingResponseCardState?: 'open' | 'patched'; lastPatchedResponseCardId?: string };

    startPendingResponseTurn(session, 'om_processing');
    expect(session.pendingResponseCardId).toBe('om_processing');
    expect(session.pendingResponseCardState).toBe('open');
    expect(isPendingResponseCardOpen(session)).toBe(true);

    markPendingResponseCardPatched(session);
    expect(session.pendingResponseCardId).toBeUndefined();
    expect(session.lastPatchedResponseCardId).toBe('om_processing');
    expect(session.pendingResponseCardState).toBe('patched');
    expect(isPendingResponseCardOpen(session)).toBe(false);
  });

  it('uses card output when an open pending card exists even if --text is set', () => {
    expect(shouldUseCardForSend({ forceCard: false, forceText: true, hasMarkdown: false, hasOpenPendingResponseCard: true })).toBe(true);
    expect(shouldUseCardForSend({ forceCard: false, forceText: true, hasMarkdown: true, hasOpenPendingResponseCard: false })).toBe(false);
  });

  it('syncs daemon in-memory pending state from persisted patched state', () => {
    const memory = { pendingResponseCardId: 'om_old_memory', pendingResponseCardState: 'open' as const, lastPatchedResponseCardId: undefined as string | undefined };
    const persisted = { pendingResponseCardId: undefined, pendingResponseCardState: 'patched' as const, lastPatchedResponseCardId: 'om_done' };

    syncPendingResponseState(memory, persisted);

    expect(memory.pendingResponseCardId).toBeUndefined();
    expect(memory.lastPatchedResponseCardId).toBe('om_done');
    expect(memory.pendingResponseCardState).toBe('patched');
    expect(isPendingResponseCardOpen(memory)).toBe(false);
  });

  it('does not treat patched cards as mergeable even if the last patched id is present', () => {
    const session = { pendingResponseCardId: undefined, pendingResponseCardState: 'patched' as const, lastPatchedResponseCardId: 'om_done' };

    expect(isPendingResponseCardOpen(session)).toBe(false);
  });

  it('only marks patched when the current pending card still matches', () => {
    const session = { pendingResponseCardId: 'om_a', pendingResponseCardState: 'open' as const, lastPatchedResponseCardId: undefined as string | undefined };
    expect(markPendingResponseCardPatchedIfCurrent(session, 'om_a')).toBe(true);
    expect(session.pendingResponseCardId).toBeUndefined();
    expect(session.pendingResponseCardState).toBe('patched');
    expect(session.lastPatchedResponseCardId).toBe('om_a');

    const newer = { pendingResponseCardId: 'om_b', pendingResponseCardState: 'open' as const, lastPatchedResponseCardId: undefined as string | undefined };
    expect(markPendingResponseCardPatchedIfCurrent(newer, 'om_a')).toBe(false);
    expect(newer.pendingResponseCardId).toBe('om_b');
    expect(newer.pendingResponseCardState).toBe('open');
    expect(newer.lastPatchedResponseCardId).toBeUndefined();
  });

  it('does not let an old finalizer mark a newer pending card as patched', () => {
    const session = { pendingResponseCardId: 'om_b', pendingResponseCardState: 'open' as const, lastPatchedResponseCardId: undefined as string | undefined };

    expect(markPendingResponseCardPatchedIfCurrent(session, 'om_a')).toBe(false);

    expect(session.pendingResponseCardId).toBe('om_b');
    expect(session.pendingResponseCardState).toBe('open');
    expect(session.lastPatchedResponseCardId).toBeUndefined();
  });

  it('does not withdraw an older pending card when a newer turn starts', () => {
    const session = { pendingResponseCardId: 'om_a', pendingResponseCardState: 'open' as const };

    expect(shouldWithdrawPreviousPendingOnNewTurn(session)).toBe(false);
  });

  it('does not clear pending response state when reading the pending id', () => {
    const session = { pendingResponseCardId: 'om_processing', pendingResponseCardState: 'open' as const };

    expect(claimPendingResponseCard(session)).toBe('om_processing');
    expect(session.pendingResponseCardId).toBe('om_processing');
    expect(session.pendingResponseCardState).toBe('open');
  });

  it('cleans up queue entries after work settles', async () => {
    const queue = createPendingResponseQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;

    const first = queue.run('s1', async () => {
      events.push('first:start');
      await new Promise<void>(resolve => { releaseFirst = resolve; });
      events.push('first:end');
    });
    const second = queue.run('s1', async () => {
      events.push('second:start');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    expect(queue.size()).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    expect(queue.size()).toBe(0);
  });
});
