/**
 * Unit tests for `botmux send` same-name bot disambiguation.
 *
 * Regression: bots-info.json can hold multiple entries with the same
 * `botName` (multi-tenant deployments running two apps under the same
 * display name). Cross-ref reverse lookup used `Array.find` on botName,
 * which silently routed to whichever entry sorted first — typically not
 * the one bound to the outbound chat. `pickBotEntryByName` now prefers
 * the entry whose `oncallChats` includes the outbound `chatId`.
 */
import { describe, it, expect } from 'vitest';
import { pickBotEntryByName } from '../src/utils/bot-routing.js';

type Entry = { larkAppId: string; botName: string | null };

const ENTRY_COCO_UNBOUND: Entry = { larkAppId: 'cli_coco_unbound', botName: 'CoCo' };
const ENTRY_COCO_BOUND: Entry = { larkAppId: 'cli_coco_bound', botName: 'CoCo' };
const ENTRY_CLAUDE: Entry = { larkAppId: 'cli_claude', botName: 'Claude' };
const TARGET_CHAT = 'oc_target_chat';

describe('pickBotEntryByName', () => {
  it('returns undefined when no entry matches the name', () => {
    const result = pickBotEntryByName(
      [ENTRY_CLAUDE],
      'CoCo',
      TARGET_CHAT,
      new Map(),
    );
    expect(result).toBeUndefined();
  });

  it('returns the sole match when only one entry has the name', () => {
    const result = pickBotEntryByName(
      [ENTRY_CLAUDE, ENTRY_COCO_UNBOUND],
      'CoCo',
      TARGET_CHAT,
      new Map(),
    );
    expect(result).toEqual(ENTRY_COCO_UNBOUND);
  });

  it('prefers the same-named bot bound to the outbound chat over the first match', () => {
    // bots-info.json order: unbound CoCo first, bound CoCo second.
    // Without oncall preference, Array.find would silently return unbound.
    const oncallChatsByApp = new Map([
      [ENTRY_COCO_BOUND.larkAppId, new Set([TARGET_CHAT])],
    ]);
    const result = pickBotEntryByName(
      [ENTRY_COCO_UNBOUND, ENTRY_COCO_BOUND],
      'CoCo',
      TARGET_CHAT,
      oncallChatsByApp,
    );
    expect(result).toEqual(ENTRY_COCO_BOUND);
  });

  it('falls back to the first match when no candidate is bound to the chat', () => {
    // None bound — preserve old behavior (route to whichever bots-info.json
    // sorts first) so single-instance deployments keep working unchanged.
    const oncallChatsByApp = new Map([
      [ENTRY_COCO_BOUND.larkAppId, new Set(['oc_some_other_chat'])],
    ]);
    const result = pickBotEntryByName(
      [ENTRY_COCO_UNBOUND, ENTRY_COCO_BOUND],
      'CoCo',
      TARGET_CHAT,
      oncallChatsByApp,
    );
    expect(result).toEqual(ENTRY_COCO_UNBOUND);
  });

  it('falls back to the first match when targetChatId is missing', () => {
    // Top-level publish (no specific chat) — no preference to apply.
    const oncallChatsByApp = new Map([
      [ENTRY_COCO_BOUND.larkAppId, new Set([TARGET_CHAT])],
    ]);
    const result = pickBotEntryByName(
      [ENTRY_COCO_UNBOUND, ENTRY_COCO_BOUND],
      'CoCo',
      undefined,
      oncallChatsByApp,
    );
    expect(result).toEqual(ENTRY_COCO_UNBOUND);
  });

  it('matches case-insensitively', () => {
    const result = pickBotEntryByName(
      [ENTRY_COCO_UNBOUND],
      'coco',
      TARGET_CHAT,
      new Map(),
    );
    expect(result).toEqual(ENTRY_COCO_UNBOUND);
  });
});
