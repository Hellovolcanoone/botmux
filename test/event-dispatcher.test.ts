/**
 * Unit tests for event-dispatcher: bot-to-bot @mention routing.
 *
 * Covers the im.message.receive_v1 handler behavior when receiving messages
 * from other bots (sender_type === 'app'), specifically:
 * - Routing @mentioned bot messages to handleThreadReply
 * - Ignoring bot messages that don't @mention this bot
 * - Processing /close commands from the bot's own messages
 * - Learning own open_id from outgoing messages
 *
 * Run:  pnpm vitest run test/event-dispatcher.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock external modules ──────────────────────────────────────────────────

const mockExistsSync = vi.fn(() => true);
const mockReadFileSync = vi.fn(() => '[]');
const mockWriteFileSync = vi.fn();
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (...args: any[]) => mockExistsSync(...args),
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
    writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
    mkdirSync: vi.fn(),
  };
});

const mockGetBot = vi.fn();
const mockGetAllBots = vi.fn(() => []);
const mockFindOncallChat = vi.fn(() => undefined);
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...args: any[]) => mockGetBot(...args),
  getAllBots: () => mockGetAllBots(),
  findOncallChat: (...args: any[]) => mockFindOncallChat(...args),
}));

const mockListChatBotMembers = vi.fn(async () => [] as Array<{ openId: string; name: string }>);
const mockGetChatMode = vi.fn(async () => 'topic' as 'group' | 'topic' | 'p2p');
const mockGetChatInfo = vi.fn(async () => ({ userCount: 1, botCount: 1 }));
vi.mock('../src/im/lark/client.js', () => ({
  getChatInfo: (...args: any[]) => mockGetChatInfo(...args),
  getChatMode: (...args: any[]) => mockGetChatMode(...args),
  listChatBotMembers: (...args: any[]) => mockListChatBotMembers(...args),
  replyMessage: vi.fn(async () => 'msg-id'),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Capture the registered event handlers from EventDispatcher.register()
let capturedHandlers: Record<string, Function> = {};

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockEventDispatcher {
    register(handlers: Record<string, Function>) {
      capturedHandlers = handlers;
      return this;
    }
  }
  class MockWSClient {
    start() {}
  }
  return {
    EventDispatcher: MockEventDispatcher,
    WSClient: MockWSClient,
    LoggerLevel: { info: 2 },
  };
});

// ─── Imports (must be after mocks) ──────────────────────────────────────────

import { isBotMentioned, startLarkEventDispatcher, writeBotInfoFile, type EventHandlers } from '../src/im/lark/event-dispatcher.js';
import { _resetForTest as _resetBotMentionDedup } from '../src/utils/bot-mention-dedup.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const MY_APP_ID = 'app-bot-a';
const MY_OPEN_ID = 'ou_bot_a_open_id';
const OTHER_BOT_OPEN_ID = 'ou_bot_b_open_id';
const USER_OPEN_ID = 'ou_user_123';

function setupBotState(opts?: { botOpenId?: string | undefined }) {
  mockGetBot.mockReturnValue({
    config: { larkAppId: MY_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code' },
    botOpenId: opts && 'botOpenId' in opts ? opts.botOpenId : MY_OPEN_ID,
    resolvedAllowedUsers: [],
  });
}

function makeHandlers(): EventHandlers & {
  handleNewTopic: ReturnType<typeof vi.fn>;
  handleThreadReply: ReturnType<typeof vi.fn>;
  handleCardAction: ReturnType<typeof vi.fn>;
  isSessionOwner: ReturnType<typeof vi.fn>;
} {
  return {
    handleCardAction: vi.fn(async () => undefined),
    handleNewTopic: vi.fn(async () => {}),
    handleThreadReply: vi.fn(async () => {}),
    isSessionOwner: vi.fn(() => false),
  };
}

/** Build a Lark im.message.receive_v1 event data object */
function makeBotMessageEvent(opts: {
  senderOpenId: string;
  content: string;
  rootId?: string;
  /** Pass `null` to omit thread_id (model Lark quote-bubble quirk).
   *  Otherwise defaults to rootId, matching real Lark threaded messages
   *  where root_id and thread_id are co-present. */
  threadId?: string | null;
  chatId?: string;
  chatType?: string;
  messageId?: string;
  mentions?: Array<{ key: string; name: string; id: { open_id: string } }>;
}) {
  const rootId = opts.rootId ?? 'root-001';
  const threadId = opts.threadId === null ? undefined : (opts.threadId ?? rootId);
  return {
    message: {
      message_id: opts.messageId ?? 'msg-001',
      root_id: rootId,
      thread_id: threadId,
      chat_id: opts.chatId ?? 'chat-001',
      chat_type: opts.chatType ?? 'group',
      content: opts.content,
      mentions: opts.mentions,
    },
    sender: {
      sender_type: 'app',
      sender_id: { open_id: opts.senderOpenId },
    },
  };
}

function makeUserMessageEvent(opts: {
  senderOpenId: string;
  content: string;
  rootId?: string;
  /** Pass `null` to model Lark's quote-bubble quirk (root_id present without
   *  thread_id). Otherwise defaults to rootId, matching real Lark threaded
   *  messages where both fields are co-present. */
  threadId?: string | null;
  chatId?: string;
  chatType?: string;
  messageId?: string;
  mentions?: Array<{ key: string; name: string; id: { open_id: string } }>;
}) {
  const threadId = opts.threadId === null
    ? undefined
    : (opts.threadId ?? opts.rootId);
  return {
    message: {
      message_id: opts.messageId ?? 'msg-001',
      root_id: opts.rootId,
      thread_id: threadId,
      chat_id: opts.chatId ?? 'chat-001',
      chat_type: opts.chatType ?? 'group',
      content: opts.content,
      mentions: opts.mentions,
    },
    sender: {
      sender_type: 'user',
      sender_id: { open_id: opts.senderOpenId },
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('isBotMentioned', () => {
  beforeEach(() => {
    setupBotState();
  });

  it('detects @mention via message.mentions array', () => {
    const message = {
      mentions: [{ key: '@_bot', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
      content: JSON.stringify({ text: '@BotA hello' }),
    };
    expect(isBotMentioned(MY_APP_ID, message, undefined)).toBe(true);
  });

  it('detects @mention in post content at tags (bot-sent messages)', () => {
    // Bot-sent post messages embed @mentions as inline `at` nodes in content,
    // NOT in the message.mentions array
    const postContent = JSON.stringify({
      zh_cn: {
        content: [[
          { tag: 'text', text: 'Hey ' },
          { tag: 'at', user_id: MY_OPEN_ID },
          { tag: 'text', text: ' can you help?' },
        ]],
      },
    });
    const message = { content: postContent, mentions: [] };
    expect(isBotMentioned(MY_APP_ID, message, undefined)).toBe(true);
  });

  it('returns false when bot is not mentioned', () => {
    const message = {
      mentions: [{ key: '@_other', name: 'Other', id: { open_id: 'ou_other' } }],
      content: JSON.stringify({ text: '@Other hello' }),
    };
    expect(isBotMentioned(MY_APP_ID, message, undefined)).toBe(false);
  });

  it('returns false when bot open_id is unknown', () => {
    setupBotState({ botOpenId: undefined });
    const message = {
      mentions: [{ key: '@_bot', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    };
    expect(isBotMentioned(MY_APP_ID, message, undefined)).toBe(false);
  });
});

describe('im.message.receive_v1 — bot-to-bot @mention routing', () => {
  let handlers: ReturnType<typeof makeHandlers>;

  beforeEach(() => {
    capturedHandlers = {};
    setupBotState();
    handlers = makeHandlers();
    _resetBotMentionDedup();
    startLarkEventDispatcher(MY_APP_ID, 'secret', handlers);
  });

  it('routes @mentioned bot message to handleThreadReply', async () => {
    // Another bot sends a post message that @mentions this bot in a thread
    const postContent = JSON.stringify({
      zh_cn: {
        content: [[
          { tag: 'at', user_id: MY_OPEN_ID },
          { tag: 'text', text: ' please review this' },
        ]],
      },
    });

    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      content: postContent,
      rootId: 'root-thread-1',
    });

    const handler = capturedHandlers['im.message.receive_v1'];
    expect(handler).toBeDefined();
    await handler(event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      anchor: 'root-thread-1',
      scope: 'thread',
      larkAppId: MY_APP_ID,
    }));
  });

  it('routes @mentioned bot message (via mentions array) to handleThreadReply', async () => {
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      content: JSON.stringify({ text: '@BotA check this' }),
      rootId: 'root-thread-2',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      anchor: 'root-thread-2',
      scope: 'thread',
      larkAppId: MY_APP_ID,
    }));
  });

  it('ignores bot message that does not @mention this bot', async () => {
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      content: JSON.stringify({ text: 'talking to someone else' }),
      rootId: 'root-thread-3',
    });

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('ignores cross-bot @mention in chat-scope from an unknown bot', async () => {
    // Foreign bot @mentions us at top level (no rootId) in a 普通群, but the
    // sender is NOT in our peer cross-ref (random Lark bot, not a botmux peer).
    // Drop it — otherwise random bots could spawn chat-scope sessions in any
    // chat they share with us.
    mockGetChatMode.mockResolvedValueOnce('group');
    // No cross-ref entries → unknown peer
    mockReadFileSync.mockReturnValue('{}');
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      content: JSON.stringify({
        zh_cn: { content: [[{ tag: 'at', user_id: MY_OPEN_ID }]] },
      }),
      rootId: undefined,
    });
    event.message.root_id = undefined as any;
    handlers.isSessionOwner.mockReturnValue(false);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('routes cross-bot @mention in chat-scope when sender is a known botmux peer', async () => {
    // Same setup as above, but the foreign bot IS in our peer cross-ref → the
    // dispatcher should route it through to handleThreadReply (which auto-
    // creates a chat-scope session and inherits the peer's workingDir).
    mockGetChatMode.mockResolvedValueOnce('group');
    mockReadFileSync.mockReturnValue(JSON.stringify({ 'BotB': OTHER_BOT_OPEN_ID }));
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      content: JSON.stringify({
        zh_cn: { content: [[{ tag: 'at', user_id: MY_OPEN_ID }]] },
      }),
      rootId: undefined,
    });
    event.message.root_id = undefined as any;
    handlers.isSessionOwner.mockReturnValue(false);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-001',
      larkAppId: MY_APP_ID,
    }));
  });

  it('dedups bot-to-bot @mention if signal-file path already handled this messageId', async () => {
    // Pre-mark messageId as handled (signal-file watcher fired first).
    const { markBotMentionMessageHandled } = await import('../src/utils/bot-mention-dedup.js');
    markBotMentionMessageHandled('msg-dedup-1');

    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      messageId: 'msg-dedup-1',
      content: JSON.stringify({ text: '@BotA hi' }),
      rootId: 'root-dedup',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('processes /close from own bot messages in a thread', async () => {
    const event = makeBotMessageEvent({
      senderOpenId: MY_OPEN_ID,  // own message
      content: JSON.stringify({ text: '/close' }),
      rootId: 'root-thread-4',
    });

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      anchor: 'root-thread-4',
      scope: 'thread',
      larkAppId: MY_APP_ID,
    }));
  });

  it('ignores own bot messages that are not /close', async () => {
    const event = makeBotMessageEvent({
      senderOpenId: MY_OPEN_ID,  // own message
      content: JSON.stringify({ text: 'I just finished the task' }),
      rootId: 'root-thread-5',
    });

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('does not interfere with normal user messages (sole bot)', async () => {
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: 'hello' }),
      rootId: 'root-thread-6',
      chatType: 'group',
    });
    // User message in a thread where bot owns session, sole bot in chat
    handlers.isSessionOwner.mockReturnValue(true);
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      anchor: 'root-thread-6',
      scope: 'thread',
      larkAppId: MY_APP_ID,
    }));
  });

  it('requires @mention in multi-bot thread even if bot owns session', async () => {
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: 'hello everyone' }),
      rootId: 'root-thread-7',
      chatId: 'chat-multi-1',  // unique chatId to avoid botCount cache
      chatType: 'group',
    });
    handlers.isSessionOwner.mockReturnValue(true);
    // Multi-bot stats — the relax check needs botCount > 1 to fail and force
    // the @mention requirement back on.
    mockGetChatInfo.mockResolvedValue({ userCount: 1, botCount: 2 });
    mockListChatBotMembers.mockResolvedValue([
      { openId: MY_OPEN_ID, name: 'BotA' },
      { openId: OTHER_BOT_OPEN_ID, name: 'BotB' },
    ]);

    await capturedHandlers['im.message.receive_v1'](event);

    // No @mention → should NOT be routed even though bot owns session
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('processes @mentioned message in multi-bot thread', async () => {
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA do this' }),
      rootId: 'root-thread-8',
      chatId: 'chat-multi-2',  // unique chatId to avoid botCount cache
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    handlers.isSessionOwner.mockReturnValue(true);

    mockListChatBotMembers.mockResolvedValue([
      { openId: MY_OPEN_ID, name: 'BotA' },
      { openId: OTHER_BOT_OPEN_ID, name: 'BotB' },
    ]);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      anchor: 'root-thread-8',
      scope: 'thread',
      larkAppId: MY_APP_ID,
    }));
  });

  it('treats 普通群 root_id WITHOUT thread_id as chat-scope (Lark quote-bubble quirk)', async () => {
    // User typed a top-level message in 普通群; Lark UI attached root_id but
    // NOT thread_id (引用气泡 / 快速回复 bubble). decideRouting now keys on
    // thread_id, so this routes straight to chat-scope (no fallback needed).
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA continue please' }),
      rootId: 'root-not-mine',
      threadId: null, // explicit: simulate Lark quirk
      chatId: 'chat-fallback-1',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    mockGetChatMode.mockResolvedValueOnce('group'); // 普通群
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-fallback-1');
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-fallback-1',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('honors a real Lark 话题 (root_id + thread_id) in 普通群 even when chat-scope session exists', async () => {
    // User explicitly opened a 话题 on a message in 普通群 → message carries
    // both root_id AND thread_id. The bot owns a chat-scope session at this
    // chat, but the user's intent is a fresh thread, so we must NOT bounce
    // them back into chat-scope. Routes thread-scope; since no thread session
    // owns this root, handleNewTopic is invoked (fresh thread session).
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA new topic please' }),
      rootId: 'real-topic-root',
      threadId: 'omt_real_thread', // real Lark thread
      chatId: 'chat-fallback-3',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    // Bot owns chat-scope at this chat — but we should NOT re-route into it.
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-fallback-3');
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'real-topic-root',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('keeps thread-scope when root_id+thread_id are set and a thread session DOES exist', async () => {
    // Bot already owns a thread-scope session at this root → continue it.
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA continue please' }),
      rootId: 'root-keep',
      chatId: 'chat-fallback-2',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'root-keep');
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'root-keep',
      larkAppId: MY_APP_ID,
    }));
  });

  it('ignores unmentioned replies when another bot owns the thread', async () => {
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: 'hello everyone' }),
      rootId: 'root-thread-9',
      chatId: 'chat-multi-3',
      chatType: 'group',
    });
    handlers.isSessionOwner.mockReturnValue(false);

    mockListChatBotMembers.mockResolvedValue([
      { openId: MY_OPEN_ID, name: 'BotA' },
      { openId: OTHER_BOT_OPEN_ID, name: 'BotB' },
    ]);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });
});

describe('writeBotInfoFile — multi-daemon merge', () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('[]');
    mockWriteFileSync.mockReset();
  });

  it('merges current bot into existing entries from other daemons', () => {
    // Existing file has bot B written by another daemon process
    const existing = [
      { larkAppId: 'app-bot-b', botOpenId: 'ou_bot_b', botName: 'BotB', cliId: 'aiden' },
    ];
    mockReadFileSync.mockReturnValue(JSON.stringify(existing));

    // Current daemon has bot A
    mockGetAllBots.mockReturnValue([{
      config: { larkAppId: MY_APP_ID, cliId: 'claude-code' },
      botOpenId: MY_OPEN_ID,
      botName: 'BotA',
    }]);

    writeBotInfoFile('/data');

    // Should have written merged result with both bots
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written).toHaveLength(2);
    expect(written.find((e: any) => e.larkAppId === 'app-bot-b')?.botOpenId).toBe('ou_bot_b');
    expect(written.find((e: any) => e.larkAppId === MY_APP_ID)?.botOpenId).toBe(MY_OPEN_ID);
  });

  it('updates own entry without removing others', () => {
    // File already has both bots, but bot A has stale open_id
    const existing = [
      { larkAppId: MY_APP_ID, botOpenId: null, botName: null, cliId: 'claude-code' },
      { larkAppId: 'app-bot-b', botOpenId: 'ou_bot_b', botName: 'BotB', cliId: 'aiden' },
    ];
    mockReadFileSync.mockReturnValue(JSON.stringify(existing));

    mockGetAllBots.mockReturnValue([{
      config: { larkAppId: MY_APP_ID, cliId: 'claude-code' },
      botOpenId: MY_OPEN_ID,
      botName: 'BotA',
    }]);

    writeBotInfoFile('/data');

    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written).toHaveLength(2);
    // Bot A should be updated
    expect(written.find((e: any) => e.larkAppId === MY_APP_ID)?.botOpenId).toBe(MY_OPEN_ID);
    // Bot B should remain unchanged
    expect(written.find((e: any) => e.larkAppId === 'app-bot-b')?.botOpenId).toBe('ou_bot_b');
  });

  it('creates new file when none exists', () => {
    mockExistsSync.mockImplementation((p: string) => !p.endsWith('.json'));
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

    mockGetAllBots.mockReturnValue([{
      config: { larkAppId: MY_APP_ID, cliId: 'claude-code' },
      botOpenId: MY_OPEN_ID,
      botName: 'BotA',
    }]);

    writeBotInfoFile('/data');

    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written).toHaveLength(1);
    expect(written[0].larkAppId).toBe(MY_APP_ID);
  });
});
