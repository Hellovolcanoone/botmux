/**
 * Per-chat reply mode for regular groups, layered over the per-bot default.
 *
 * Three modes (tri-state) — unifies #116 + #131 into one knob so a chat resolves
 * to EXACTLY ONE mode and the two thread-reply mechanisms can never compete:
 *   • chat        — flat chat-scope replies in the group (default).
 *   • new-topic   — each top-level @mention opens a fresh thread-scope session
 *                   under the trigger (its own worker/cwd/context). This is the
 *                   per-bot fork behavior from #116.
 *   • shared      — 话题模式但复用同一个 session: reuse the bot's existing
 *                   chat-scope session/worker/cwd, but route this turn's reply
 *                   into the trigger message's thread (#131).
 *
 * Resolution: per-chat override (`chatReplyModes[chatId]`) wins; otherwise fall
 * back to the per-bot default (`regularGroupReplyMode`, default 'chat'). The
 * setting is bot-scoped: Bot A can prefer topic replies in one group while Bot B
 * or another group stays flat.
 */
import { rmwBotEntry } from './config-store.js';
import { getBot, type ChatReplyMode } from '../bot-registry.js';
import { logger } from '../utils/logger.js';

export type { ChatReplyMode } from '../bot-registry.js';

export function normalizeChatReplyMode(raw: string | undefined): ChatReplyMode | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v || v === 'status') return undefined;
  if (v === 'chat') return 'chat';
  if (v === 'topic' || v === 'new-topic' || v === 'newtopic' || v === 'thread') return 'new-topic';
  if (v === 'shared' || v === 'share' || v === 'alias' || v === 'topic-alias' || v === 'topic_alias') return 'shared';
  return undefined;
}

/** Short command-word label for status / confirmation messages. */
export function replyModeLabel(mode: ChatReplyMode): 'chat' | 'topic' | 'shared' {
  return mode === 'new-topic' ? 'topic' : mode === 'shared' ? 'shared' : 'chat';
}

/** Per-bot default regular-group mode (`regularGroupReplyMode`, default 'chat'). */
function regularGroupDefaultMode(larkAppId: string): ChatReplyMode {
  try {
    return getBot(larkAppId).config.regularGroupReplyMode ?? 'chat';
  } catch {
    return 'chat';
  }
}

export type GroupMentionMode = 'always' | 'topic' | 'never';

/**
 * Per-bot (bot-global) @-requirement policy for regular groups, default 'always'.
 *   • always — @ required everywhere (incl. inside shared topics).
 *   • topic  — @ required at top level, but non-@ continues inside shared topics.
 *   • never  — non-@ messages are answered too (where the bot has talk access).
 */
export function resolveGroupMentionMode(larkAppId: string): GroupMentionMode {
  try {
    const m = getBot(larkAppId).config.regularGroupMentionMode;
    return m === 'topic' || m === 'never' ? m : 'always';
  } catch {
    return 'always';
  }
}

/**
 * Effective regular-group reply mode for a chat — the SINGLE source of truth for
 * routing. Per-chat override first, then the per-bot default. Both the
 * `regularGroupRouting` (new-topic) and `maybeApplySharedTopicSeed` (shared)
 * code paths read this, so they are mutually exclusive by construction.
 */
export function resolveRegularGroupMode(larkAppId: string, chatId: string | undefined): ChatReplyMode {
  try {
    const perChat = chatId ? getBot(larkAppId).config.chatReplyModes?.[chatId] : undefined;
    if (perChat) return perChat;
  } catch { /* fall through to default */ }
  return regularGroupDefaultMode(larkAppId);
}

export async function setChatReplyMode(
  larkAppId: string,
  chatId: string,
  mode: ChatReplyMode,
): Promise<{ ok: true; mode: ChatReplyMode } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  // Persist only when the per-chat mode differs from the per-bot default, so
  // bots.json stays tidy in the common default-off case while an explicit
  // opt-out (e.g. per-bot default new-topic, this chat pinned back to chat)
  // still sticks instead of being silently dropped.
  const redundant = mode === regularGroupDefaultMode(larkAppId);

  const r = await rmwBotEntry<ChatReplyMode>(larkAppId, (entry) => {
    if (!entry.chatReplyModes || typeof entry.chatReplyModes !== 'object' || Array.isArray(entry.chatReplyModes)) {
      entry.chatReplyModes = {};
    }
    if (redundant) {
      delete entry.chatReplyModes[chatId];
      if (Object.keys(entry.chatReplyModes).length === 0) delete entry.chatReplyModes;
    } else {
      entry.chatReplyModes[chatId] = mode;
    }
    return { write: true, result: mode };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  const next = { ...(bot.config.chatReplyModes ?? {}) };
  if (redundant) delete next[chatId];
  else next[chatId] = mode;
  bot.config.chatReplyModes = Object.keys(next).length > 0 ? next : undefined;
  logger.info(`[reply-mode:${larkAppId}] chat=${chatId} mode=${mode}`);
  return { ok: true, mode };
}
