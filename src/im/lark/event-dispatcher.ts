/**
 * Lark event dispatcher — handles WSClient setup, bot identity probing,
 * and message routing (group access checks, @mention detection).
 * Extracted from daemon.ts for modularity.
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getBot, getAllBots, findOncallChat } from '../../bot-registry.js';
import { config } from '../../config.js';
import { getChatInfo, getChatMode, listChatBotMembers, replyMessage } from './client.js';
import { logger } from '../../utils/logger.js';
import { isBotMentionMessageHandled, markBotMentionMessageHandled } from '../../utils/bot-mention-dedup.js';

// ─── Bot identity ─────────────────────────────────────────────────────────

/** Set the bot's open_id. Callers should also call writeBotInfoFile() to persist. */
export function setBotOpenId(larkAppId: string, id: string): void {
  getBot(larkAppId).botOpenId = id;
}

/** Persist bot registry info to disk for agent-facing CLI subcommands to read.
 *  Merges current process's bot(s) into the existing file so that
 *  multiple daemon processes (one per bot) don't overwrite each other. */
export function writeBotInfoFile(dataDir: string): void {
  const filePath = join(dataDir, 'bots-info.json');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  // Read existing entries from other daemon processes
  type BotInfoEntry = { larkAppId: string; botOpenId: string | null; botName: string | null; cliId: string };
  let existing: BotInfoEntry[] = [];
  try {
    if (existsSync(filePath)) {
      existing = JSON.parse(readFileSync(filePath, 'utf-8'));
    }
  } catch { /* ignore corrupt file */ }

  // Build a map keyed by larkAppId, start with existing entries
  const map = new Map<string, BotInfoEntry>();
  for (const entry of existing) {
    if (entry.larkAppId) map.set(entry.larkAppId, entry);
  }

  // Upsert current process's bot(s)
  for (const b of getAllBots()) {
    map.set(b.config.larkAppId, {
      larkAppId: b.config.larkAppId,
      botOpenId: b.botOpenId ?? null,
      botName: b.botName ?? null,
      cliId: b.config.cliId,
    });
  }

  writeFileSync(filePath, JSON.stringify([...map.values()], null, 2) + '\n');
}

/**
 * Probe the bot's own open_id at startup via the Lark bot info API.
 */
export async function probeBotOpenId(larkAppId: string): Promise<void> {
  const bot = getBot(larkAppId);
  if (bot.botOpenId) return; // already known

  // Call /bot/v3/info to get the bot's open_id using tenant_access_token
  const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: bot.config.larkAppId, app_secret: bot.config.larkAppSecret }),
  });
  const tokenData = await tokenRes.json() as any;
  if (tokenData.code !== 0) {
    throw new Error(`Failed to get tenant_access_token: ${tokenData.msg}`);
  }

  const botRes = await fetch('https://open.feishu.cn/open-apis/bot/v3/info/', {
    headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
  });
  const botData = await botRes.json() as any;
  if (botData.code !== 0) {
    throw new Error(`Failed to get bot info: ${botData.msg}`);
  }

  const openId = botData.bot?.open_id;
  const appName = botData.bot?.app_name;
  if (openId) {
    bot.botOpenId = openId;
    if (appName) bot.botName = appName;
    logger.info(`Bot open_id: ${bot.botOpenId}`);
  } else {
    throw new Error('No open_id in bot info response');
  }
}

// ─── Group chat stats cache ───────────────────────────────────────────────
//
// chat.get returns both user_count (real users only) and bot_count (bots).
// One API call, one cache — used to gate auto-replies in multi-bot/multi-user
// groups (oncall chats often have 3rd-party oncall/form/AI-search bots).

export const CHAT_CACHE_TTL = 5 * 60_000; // 5 minutes
const chatStatsCache = new Map<string, { userCount: number; botCount: number; fetchedAt: number }>();

export async function getGroupStats(larkAppId: string, chatId: string): Promise<{ userCount: number; botCount: number }> {
  const cacheKey = `${larkAppId}:${chatId}`;
  const cached = chatStatsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CHAT_CACHE_TTL) {
    return { userCount: cached.userCount, botCount: cached.botCount };
  }
  try {
    const info = await getChatInfo(larkAppId, chatId);
    chatStatsCache.set(cacheKey, { userCount: info.userCount, botCount: info.botCount, fetchedAt: Date.now() });
    return info;
  } catch (err) {
    logger.warn(`Failed to get chat stats for ${chatId}: ${err}`);
    if (cached) return { userCount: cached.userCount, botCount: cached.botCount };
    // Fallback: assume multi-person, multi-bot → require @mention to be safe.
    return { userCount: 999, botCount: 999 };
  }
}

// ─── Cross-bot open_id mapping ──────────────────────────────────────────
//
// Lark open_id is per-app scoped: Bot A sees a different open_id for Bot B
// than Bot B sees for itself. The self-reported botOpenId (from /bot/v3/info)
// is useless for other bots to @mention.
//
// We build a per-bot cross-reference from event data: when Bot A's event
// handler receives a message that @mentions Bot B, the mention includes
// Bot B's open_id as seen by Bot A's app. We persist this mapping so that
// listChatBotMembers can return correct open_ids.

/** Read the per-bot cross-reference: botName(lowercase) → openId as seen by larkAppId's app */
export function readBotOpenIdCrossRef(dataDir: string, larkAppId: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const fp = join(dataDir, `bot-openids-${larkAppId}.json`);
    if (existsSync(fp)) {
      const data: Record<string, string> = JSON.parse(readFileSync(fp, 'utf-8'));
      for (const [name, openId] of Object.entries(data)) {
        map.set(name.toLowerCase(), openId);
      }
    }
  } catch { /* ignore */ }
  return map;
}

/** Is `senderOpenId` a registered botmux peer (from larkAppId's cross-ref)?
 *  Used to gate chat-scope foreign-bot @mention spawning to vetted peers. */
export function isKnownPeerBot(dataDir: string, larkAppId: string, senderOpenId: string | undefined): boolean {
  if (!senderOpenId) return false;
  for (const openId of readBotOpenIdCrossRef(dataDir, larkAppId).values()) {
    if (openId === senderOpenId) return true;
  }
  return false;
}

/** Update the per-bot cross-reference from @mention data in an event.
 *  mentionsList comes from Lark event message.mentions array. */
export function updateBotOpenIdCrossRef(
  dataDir: string,
  larkAppId: string,
  mentionsList: Array<{ name?: string; id?: { open_id?: string } }>,
): void {
  if (!mentionsList || mentionsList.length === 0) return;

  // Read known bot names from bots-info.json
  const knownBotNames = new Set<string>();
  try {
    const infoPath = join(dataDir, 'bots-info.json');
    if (existsSync(infoPath)) {
      const entries: Array<{ botName: string | null }> = JSON.parse(readFileSync(infoPath, 'utf-8'));
      for (const e of entries) {
        if (e.botName) knownBotNames.add(e.botName.toLowerCase());
      }
    }
  } catch { /* ignore */ }
  if (knownBotNames.size === 0) return;

  // Read existing cross-reference
  const fp = join(dataDir, `bot-openids-${larkAppId}.json`);
  let existing: Record<string, string> = {};
  try {
    if (existsSync(fp)) existing = JSON.parse(readFileSync(fp, 'utf-8'));
  } catch { /* ignore */ }

  // Update with new mentions that match known bot names
  let changed = false;
  for (const m of mentionsList) {
    const name = m.name;
    const openId = m.id?.open_id;
    if (!name || !openId) continue;
    if (!knownBotNames.has(name.toLowerCase())) continue;
    if (existing[name] === openId) continue;
    existing[name] = openId;
    changed = true;
  }

  if (changed) {
    try {
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      writeFileSync(fp, JSON.stringify(existing, null, 2) + '\n');
      logger.debug(`Updated bot open_id cross-ref for ${larkAppId}: ${JSON.stringify(existing)}`);
    } catch (err) {
      logger.debug(`Failed to write bot open_id cross-ref: ${err}`);
    }
  }
}

// ─── @mention detection ──────────────────────────────────────────────────

/** Check if the bot was @mentioned in this message */
export function isBotMentioned(larkAppId: string, message: any, _senderOpenId: string | undefined): boolean {
  const botOpenId = getBot(larkAppId).botOpenId;
  if (!botOpenId) {
    logger.warn('Bot open_id unknown, cannot check @mentions');
    return false;
  }

  // 1. Check message.mentions array (populated for user-sent text messages)
  const mentions: any[] = message.mentions ?? [];
  if (mentions.some((m: any) => m.id?.open_id === botOpenId)) {
    return true;
  }

  // 2. Check post content for inline at tags (bot-sent post messages may not
  //    populate message.mentions — the @mention is embedded in the content structure)
  try {
    const content = JSON.parse(message.content ?? '{}');
    const inner = content.zh_cn ?? content.en_us ?? content;
    if (Array.isArray(inner?.content)) {
      for (const paragraph of inner.content) {
        if (!Array.isArray(paragraph)) continue;
        for (const node of paragraph) {
          if (node.tag === 'at' && node.user_id === botOpenId) return true;
        }
      }
    }
  } catch { /* ignore parse errors */ }

  return false;
}

// ─── Permission gates ────────────────────────────────────────────────────
//
// Two separate gates for oncall support:
//   canTalk    — may address the bot in this chat (prompts, thread replies)
//   canOperate — may trigger state-changing actions (card buttons, daemon
//                slash commands like /cd /restart /close /oncall)
//
// Non-oncall chats: both fall back to the bot's allowedUsers. Oncall-bound
// chats: talking is open to everyone; operating is restricted to the entry's
// `owners` list (initial binder + anyone they later add).

export function canTalk(larkAppId: string, chatId: string | undefined, senderOpenId: string | undefined): boolean {
  const oncall = chatId ? findOncallChat(larkAppId, chatId) : undefined;
  if (oncall) return true;
  const allowedUsers = getBot(larkAppId).resolvedAllowedUsers;
  if (allowedUsers.length === 0) return true;
  return !!senderOpenId && allowedUsers.includes(senderOpenId);
}

export function canOperate(larkAppId: string, chatId: string | undefined, senderOpenId: string | undefined): boolean {
  const oncall = chatId ? findOncallChat(larkAppId, chatId) : undefined;
  if (oncall) return !!senderOpenId && oncall.owners.includes(senderOpenId);
  const allowedUsers = getBot(larkAppId).resolvedAllowedUsers;
  if (allowedUsers.length === 0) return true;
  return !!senderOpenId && allowedUsers.includes(senderOpenId);
}

// ─── Group message access check ──────────────────────────────────────────

/**
 * Check group message addressing:
 * - 'allowed'     -> sender is allowed, bot was @mentioned or solo group
 * - 'not_allowed' -> bot was @mentioned but sender is not in allowlist
 * - 'ignore'      -> not addressed to bot at all
 */
export async function checkGroupMessageAccess(
  larkAppId: string, message: any, chatId: string, senderOpenId: string | undefined,
): Promise<'allowed' | 'not_allowed' | 'ignore'> {
  const mentioned = isBotMentioned(larkAppId, message, senderOpenId);
  const isAllowed = canTalk(larkAppId, chatId, senderOpenId);

  logger.debug(`Check group message access: mentioned=${mentioned}, isAllowed=${isAllowed}`);
  if (mentioned) {
    return isAllowed ? 'allowed' : 'not_allowed';
  }

  // No @mention — only allow if sender is the sole human in the group
  // AND this is the only bot in the chat. With multiple bots, require @mention
  // to disambiguate.
  if (isAllowed) {
    const { userCount, botCount } = await getGroupStats(larkAppId, chatId);
    logger.debug(`Group user count: ${userCount}, bot count: ${botCount}`);
    if (userCount <= 1 && botCount <= 1) {
      return 'allowed';
    }
  }

  return 'ignore';
}

// ─── Event callbacks ─────────────────────────────────────────────────────

/** Routing context computed from the incoming message — describes the
 *  conversational unit (`scope`) and the addressing key (`anchor`) used
 *  throughout the rest of the system. The dispatcher computes this once
 *  per message and hands it to the daemon's session handlers, so the
 *  daemon never has to re-derive it. */
export interface RoutingContext {
  chatId: string;
  /** message_id of the inbound message that triggered this routing. */
  messageId: string;
  chatType: 'group' | 'p2p';
  /** 'thread' → reply_in_thread to a (real or freshly seeded) thread root.
   *  'chat'   → plain message to the chat (no threading). */
  scope: 'thread' | 'chat';
  /** Routing key. `chatId` for chat-scope, the thread root id for
   *  thread-scope (an existing rootMessageId, or this messageId when
   *  it's the seed of a brand-new thread). */
  anchor: string;
  larkAppId: string;
}

export interface EventHandlers {
  handleCardAction: (data: any, larkAppId: string) => Promise<any>;
  handleNewTopic: (data: any, ctx: RoutingContext) => Promise<void>;
  handleThreadReply: (data: any, ctx: RoutingContext) => Promise<void>;
  /** Check if this bot owns an active session anchored at the given id
   *  (rootMessageId for thread-scope, chatId for chat-scope). */
  isSessionOwner?: (anchor: string, larkAppId: string) => boolean;
}

/** Compute the scope + anchor for an inbound message:
 *   - root_id + thread_id     → thread-scope, anchor = root_id (real Lark 话题)
 *   - 话题群 + no real thread → thread-scope, anchor = message_id (thread seed)
 *   - p2p + no real thread    → thread-scope, anchor = message_id (each DM
 *                               top-level message starts a fresh topic; a
 *                               reply inside an existing thread carries
 *                               root_id+thread_id and threads into its session)
 *   - 普通群 + no real thread  → chat-scope, anchor = chat_id (entire group
 *                               is one session)
 *
 *  Why we gate on thread_id (not root_id alone): Lark 客户端的引用气泡 / 快速
 *  回复 UI 有时会给"用户视角的顶层消息"塞 root_id 但**不会**塞 thread_id。
 *  飞书官方文档：root_id/parent_id "仅在回复消息场景会有返回值"；thread_id
 *  "不返回说明该消息非话题消息"。所以 thread_id 才是"是否真的处于话题里"的
 *  权威信号。只看 root_id 会把 quote-bubble 错认为话题回复，把用户从 chat-scope
 *  会话里拽走、又起一个孤立的 thread session。
 *  Exported for unit tests. */
export async function decideRouting(
  larkAppId: string,
  message: any,
): Promise<{ scope: 'thread' | 'chat'; anchor: string }> {
  const rootId: string | undefined = message.root_id;
  const threadId: string | undefined = message.thread_id;
  if (rootId && threadId) return { scope: 'thread', anchor: rootId };

  const chatType: string = message.chat_type ?? 'group';
  const messageId: string = message.message_id;
  const chatId: string = message.chat_id;

  // 私聊：每条 top-level DM 都视为新话题 — 跟话题群同款，匹配 Lark DM 的话题
  // 化默认行为，避免无限把 1:1 对话塞进同一个 CLI 进程里。
  if (chatType === 'p2p') {
    return { scope: 'thread', anchor: messageId };
  }

  // Group chat — fetch chat_mode (cached) to disambiguate 话题群 from 普通群.
  const mode = await getChatMode(larkAppId, chatId);
  if (mode === 'topic') {
    return { scope: 'thread', anchor: messageId };
  }
  return { scope: 'chat', anchor: chatId };
}

/**
 * Create and start the Lark WSClient with event dispatching.
 * Returns the WSClient instance for lifecycle management.
 */
export function startLarkEventDispatcher(larkAppId: string, larkAppSecret: string, handlers: EventHandlers): Lark.WSClient {
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'card.action.trigger': async (data: any) => {
      try {
        const cardBody = await handlers.handleCardAction(data, larkAppId);
        // If the handler returns a card body (e.g. toggle_stream), return it
        // so Lark renders the update immediately without waiting for an API PATCH.
        if (cardBody) return { card: { type: 'raw', data: cardBody } };
      } catch (err) {
        logger.error(`Error handling card action: ${err}`);
      }
      return undefined;
    },
    'im.message.receive_v1': async (data: any) => {
      try {
        const message = data.message;
        const sender = data.sender;
        if (!message) return;

        // Learn other bots' open_ids from @mentions in this event.
        // Lark open_id is per-app: these IDs are correct for our app context.
        if (message.mentions?.length > 0) {
          updateBotOpenIdCrossRef(config.session.dataDir, larkAppId, message.mentions);
        }

        const chatId = message.chat_id;
        const chatType = (message.chat_type === 'p2p' ? 'p2p' : 'group') as 'group' | 'p2p';
        const messageId = message.message_id;

        // Bot-originated messages — bots historically only post inside threads
        // (their own thread replies). With chat-scope sessions a bot can also
        // post top-level (its first reply in a chat-scope group), so we still
        // route them through `decideRouting` rather than gating on root_id.
        if (sender?.sender_type === 'app') {
          const senderOpenId = sender.sender_id?.open_id;
          const isSelfMessage = senderOpenId === getBot(larkAppId).botOpenId;
          // Self messages: only echoed `/close` commands matter.
          if (isSelfMessage) {
            try {
              const body = JSON.parse(message.content ?? '{}');
              if (body.text?.trim() !== '/close') return;
            } catch {
              return;
            }
            const ctx = await decideRouting(larkAppId, message);
            handlers.handleThreadReply(data, { ...ctx, chatId, messageId, chatType, larkAppId })
              .catch(err => logger.error(`Error handling message event: ${err}`));
            return;
          }
          // Foreign bot: only route on @mention of us.
          if (!isBotMentioned(larkAppId, message, undefined)) return;
          // Cross-path dedup: signal-file watcher may have already enqueued
          // this turn (Bot A's `botmux send --mention` writes both a Lark
          // message and a signal file; whichever path lands first wins).
          if (isBotMentionMessageHandled(messageId)) {
            logger.debug(`[bot-mention] WS path skipping ${messageId.substring(0, 12)}: already handled by signal-file watcher`);
            return;
          }
          const ctx = await decideRouting(larkAppId, message);
          // Chat-scope foreign-bot @mention without an existing session: gate to
          // vetted botmux peers (registered in our bot-openids cross-ref). This
          // keeps random Lark bots from silently spawning chat-scope sessions
          // in 普通群/p2p, while letting Bot A → Bot B handoffs in 普通群 work
          // (handleThreadReply auto-create + chat-scope inheritance below).
          if (ctx.scope === 'chat') {
            const ownsSession = handlers.isSessionOwner?.(ctx.anchor, larkAppId) ?? false;
            if (!ownsSession && !isKnownPeerBot(config.session.dataDir, larkAppId, senderOpenId)) {
              return;
            }
          }
          markBotMentionMessageHandled(messageId);
          logger.info(`Bot-to-bot @mention detected (scope=${ctx.scope}): routing to handleThreadReply`);
          handlers.handleThreadReply(data, { ...ctx, chatId, messageId, chatType, larkAppId })
            .catch(err => logger.error(`Error handling bot @mention: ${err}`));
          return;
        }

        const senderOpenId = sender?.sender_id?.open_id as string | undefined;
        const isAllowed = canTalk(larkAppId, chatId, senderOpenId);

        logger.debug('Received message:', message);

        // Diagnostic: record the Lark quote-bubble UI quirk where root_id
        // appears without thread_id. decideRouting now treats this as
        // "no thread" (chat-scope / topic / new-topic depending on context),
        // which is the authoritative behavior. Logging it here so we can spot
        // any future surprise in the wild.
        if (message.root_id && !message.thread_id) {
          logger.info(
            `[routing] root_id w/o thread_id (Lark UI quirk, treating as top-level): ` +
            `msg=${messageId.substring(0, 12)} chat=${chatId.substring(0, 12)} ` +
            `type=${chatType} root=${String(message.root_id).substring(0, 12)} ` +
            `parent=${String(message.parent_id ?? '').substring(0, 12)}`,
          );
        }

        const routing = await decideRouting(larkAppId, message);
        const ownsSession = handlers.isSessionOwner?.(routing.anchor, larkAppId) ?? false;

        // Permission gating — same shape as before, just keyed on
        // `ownsSession` (anchor-aware) instead of "rootId presence":
        //
        //   ownsSession + 1v1 group → relax (no @mention required)
        //   ownsSession + multi     → require @mention
        //   !ownsSession (group)    → require @mention + allowlist
        //   p2p                     → allowlist only
        if (chatType === 'group') {
          let stats: { userCount: number; botCount: number } | null = null;
          if (ownsSession) stats = await getGroupStats(larkAppId, chatId);
          const relax = ownsSession && isAllowed && !!stats && stats.userCount <= 1 && stats.botCount <= 1;
          if (!relax) {
            const access = await checkGroupMessageAccess(larkAppId, message, chatId, senderOpenId);
            if (access === 'not_allowed') {
              if (!ownsSession) {
                replyMessage(larkAppId, messageId, JSON.stringify({ text: '⚠️ 无操作权限' }))
                  .catch(err => logger.debug(`Failed to send permission denied: ${err}`));
              }
              logger.debug(`Ignoring group message from non-allowed user: ${senderOpenId}`);
              return;
            }
            if (access === 'ignore') {
              logger.debug(`Ignoring group message not addressed to bot: ${messageId}`);
              return;
            }
          }
        } else if (!isAllowed) {
          logger.debug(`Ignoring p2p message from non-allowed user: ${senderOpenId}`);
          return;
        }

        const ctx: RoutingContext = { chatId, messageId, chatType, larkAppId, ...routing };
        const promise = ownsSession
          ? handlers.handleThreadReply(data, ctx)
          : handlers.handleNewTopic(data, ctx);
        promise.catch(err => logger.error(`Error handling message event: ${err}`));
      } catch (err) {
        logger.error(`Error handling message event: ${err}`);
      }
    },
  });

  // Start WSClient
  const wsClient = new Lark.WSClient({
    appId: larkAppId,
    appSecret: larkAppSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });

  wsClient.start({ eventDispatcher });
  logger.info('Daemon WSClient started');

  return wsClient;
}
