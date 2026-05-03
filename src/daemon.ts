import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, watch, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { config } from './config.js';
import { replyMessage, resolveAllowedUsers, sendMessage } from './im/lark/client.js';
import { loadBotConfigs, registerBot, getBot, getAllBots, findOncallChat } from './bot-registry.js';
import * as sessionStore from './services/session-store.js';
import * as scheduleStore from './services/schedule-store.js';
import * as messageQueue from './services/message-queue.js';
import { parseEventMessage, resolveNonsupportMessage, stripLeadingMentions, type MessageResource } from './im/lark/message-parser.js';
import { expandMergeForward } from './im/lark/merge-forward.js';
import { logger } from './utils/logger.js';
import { ensureCjkFontsInstalled } from './utils/font-installer.js';
import type { DaemonToWorker, LarkMessage } from './types.js';
export type { DaemonSession } from './core/types.js';
import type { DaemonSession } from './core/types.js';
import { sessionKey, sessionAnchorId } from './core/types.js';
import type { CliId } from './adapters/cli/types.js';
import * as scheduler from './core/scheduler.js';
import { scanProjects, scanMultipleProjects } from './services/project-scanner.js';
import { buildRepoSelectCard, buildStreamingCard, getCliDisplayName } from './im/lark/card-builder.js';
import { createCliAdapterSync } from './adapters/cli/registry.js';
import {
  initWorkerPool,
  setActiveSessionsRegistry,
  forkWorker,
  killWorker,
  scheduleCardPatch,
  setCurrentCliVersion,
  getCurrentCliVersion,
  CARD_POSTING_SENTINEL,
  parkStreamCard,
  closeSession as closeSessionHelper,
} from './core/worker-pool.js';
import { setBotName, setLarkAppId, startIpcServer } from './core/dashboard-ipc-server.js';
import { saveFrozenCards, deleteFrozenCards } from './services/frozen-card-store.js';
import { DAEMON_COMMANDS, PASSTHROUGH_COMMANDS, handleCommand, parseSlashCommandInvocation } from './core/command-handler.js';
import type { CommandHandlerDeps } from './core/command-handler.js';
import { isCallbackUrl, handleCallbackUrl } from './utils/user-token.js';
import {
  getSessionWorkingDir,
  getProjectScanDir,
  getProjectScanDirs,
  downloadResources,
  formatAttachmentsHint,
  buildNewTopicPrompt,
  buildFollowUpContent,
  buildBridgeInputContent,
  getAvailableBots,
  restoreActiveSessions,
  executeScheduledTask,
  persistStreamCardState,
} from './core/session-manager.js';
import { handleCardAction } from './im/lark/card-handler.js';
import type { CardHandlerDeps } from './im/lark/card-handler.js';
import { isBotMentioned, probeBotOpenId, startLarkEventDispatcher, writeBotInfoFile, canOperate, type RoutingContext } from './im/lark/event-dispatcher.js';
import { isBotMentionMessageHandled, markBotMentionMessageHandled } from './utils/bot-mention-dedup.js';

// ─── State ───────────────────────────────────────────────────────────────────

const activeSessions = new Map<string, DaemonSession>();
// Cache last /repo scan results per chat for /repo <number> fallback
const lastRepoScan = new Map<string, import('./services/project-scanner.js').ProjectInfo[]>();
const cliVersionCache = new Map<string, { version: string; lastCheckAt: number }>();
const VERSION_CHECK_INTERVAL = 60_000; // cache 1 min

/**
 * Reply into a session — scope-aware.
 *
 * `anchor` is whatever the caller has at hand:
 *   - thread-scope sessions → rootMessageId
 *   - chat-scope sessions  → chatId
 *
 * Behaviour:
 *   - thread-scope (or no matching DS, the legacy default) → reply with
 *     reply_in_thread=true to the anchor message_id
 *   - chat-scope                                           → send a plain
 *     message to ds.chatId (no reply, no thread). Cards / button values
 *     embed the chatId so handleCardAction can route back into the same
 *     session.
 *
 * Lark message ids start with `om_` and chat ids with `oc_`, so the two
 * address spaces never collide; the lookup just tries both.
 */
async function sessionReply(anchor: string, content: string, msgType: string = 'text', larkAppId?: string): Promise<string> {
  let ds: DaemonSession | undefined;
  if (larkAppId) {
    ds = activeSessions.get(sessionKey(anchor, larkAppId));
  } else {
    for (const s of activeSessions.values()) {
      if (sessionAnchorId(s) === anchor) { ds = s; break; }
    }
  }
  const appId = larkAppId ?? ds?.larkAppId ?? getAllBots()[0]?.config.larkAppId;
  if (!appId) throw new Error('No bot configured');

  // Chat-scope: post a plain message to the chat. No reply_in_thread → keeps
  // the conversation flat in 普通群 / p2p. The card layer carries chatId in
  // its button values, so handleCardAction routes back via sessionKey(chatId).
  //
  // Detect chat-scope from either ds.scope or anchor's `oc_` prefix. The
  // prefix fallback covers the close-button race: card-handler deletes ds
  // from activeSessions BEFORE sending the close-confirmation reply, so by
  // the time we run, ds is gone — but the anchor (chatId, oc_xxx) is enough
  // to know we should sendMessage, not reply_in_thread to a non-message-id.
  if (ds?.scope === 'chat' || anchor.startsWith('oc_')) {
    return sendMessage(appId, ds?.chatId ?? anchor, content, msgType);
  }

  // Thread-scope (or unknown / legacy): reply in thread.
  return replyMessage(appId, anchor, content, msgType, true);
}

// ─── PID file ────────────────────────────────────────────────────────────────

function getPidFile(): string {
  const botIndex = process.env.BOTMUX_BOT_INDEX;
  const name = botIndex !== undefined ? `daemon-${botIndex}.pid` : 'daemon.pid';
  return join(config.session.dataDir, name);
}

/** Path to the wrapper bin directory — injected into worker PATH so CLIs
 *  can call `botmux send` / `botmux schedule` without a global npm install. */
const BOTMUX_BIN_DIR = join(homedir(), '.botmux', 'bin');

function writePidFile(): void {
  const dir = config.session.dataDir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getPidFile(), String(process.pid), 'utf-8');
  // Write breadcrumb so CLI tools (botmux list/delete) can find the active data dir
  const breadcrumb = join(homedir(), '.botmux', '.data-dir');
  try {
    mkdirSync(join(homedir(), '.botmux'), { recursive: true });
    writeFileSync(breadcrumb, config.session.dataDir, 'utf-8');
  } catch { /* best effort */ }

  // Write a thin wrapper script so `botmux` is always in PATH for CLI sessions,
  // regardless of whether the package was installed globally.  The wrapper
  // points at THIS daemon's dist/cli.js, so it's always the same version.
  try {
    mkdirSync(BOTMUX_BIN_DIR, { recursive: true });
    const cliScript = join(__dirname, 'cli.js');  // dist/cli.js
    const wrapper = join(BOTMUX_BIN_DIR, 'botmux');
    const content = `#!/bin/sh\nexec node "${cliScript}" "$@"\n`;
    // Only write if changed (avoid unnecessary disk writes on every restart)
    let existing = '';
    try { existing = readFileSync(wrapper, 'utf-8'); } catch { /* doesn't exist yet */ }
    if (existing !== content) {
      writeFileSync(wrapper, content, { mode: 0o755 });
      logger.info(`Wrapper script written: ${wrapper} → ${cliScript}`);
    }
  } catch (err: any) {
    logger.warn(`Failed to write botmux wrapper script: ${err.message}`);
  }

  logger.info(`PID file written: ${getPidFile()} (pid: ${process.pid})`);
}

function removePidFile(): void {
  const pidFile = getPidFile();
  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
    logger.info('PID file removed');
  }
}

// ─── Daemon descriptor (dashboard registry) ─────────────────────────────────
// Each per-bot daemon publishes a self-descriptor JSON at
// ~/.botmux/data/dashboard-daemons/<larkAppId>.json so the dashboard sibling
// process can discover all running daemons. The file is touched every 30s as
// a heartbeat (mtime drives offline detection) and removed on graceful exit.

const DAEMON_REGISTRY_DIR = join(homedir(), '.botmux', 'data', 'dashboard-daemons');

interface DaemonDescriptor {
  larkAppId: string;
  botName: string;
  botIndex: number;
  ipcPort: number;
  pid: number;
  startedAt: number;
  lastHeartbeat: number;
}

function writeDaemonDescriptor(d: DaemonDescriptor): void {
  mkdirSync(DAEMON_REGISTRY_DIR, { recursive: true });
  const fp = join(DAEMON_REGISTRY_DIR, `${d.larkAppId}.json`);
  writeFileSync(fp, JSON.stringify(d), { mode: 0o600 });
}

function removeDaemonDescriptor(larkAppId: string): void {
  const fp = join(DAEMON_REGISTRY_DIR, `${larkAppId}.json`);
  if (existsSync(fp)) {
    try { unlinkSync(fp); } catch { /* ignore */ }
  }
}

// ─── Version tracking ────────────────────────────────────────────────────────

function refreshCliVersion(cliId: CliId, cliPathOverride?: string): boolean {
  const now = Date.now();
  const cached = cliVersionCache.get(cliId);
  if (cached && now - cached.lastCheckAt < VERSION_CHECK_INTERVAL) return false;

  try {
    const adapter = createCliAdapterSync(cliId, cliPathOverride);
    const raw = execFileSync(adapter.resolvedBin, ['--version'], {
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    const newVersion = raw.replace(/^[^0-9]*/, '');

    if (newVersion === 'unknown' || !newVersion) return false;

    const oldVersion = cached?.version;
    cliVersionCache.set(cliId, { version: newVersion, lastCheckAt: now });
    // Also update the shared version (used by forkWorker for ds.cliVersion)
    setCurrentCliVersion(newVersion);

    if (oldVersion && oldVersion !== newVersion) {
      logger.info(`CLI version updated: ${oldVersion} → ${newVersion} (${adapter.id})`);
      return true;
    }

    logger.info(`CLI version: ${newVersion} (${adapter.id})`);
    return false;
  } catch (err: any) {
    logger.warn(`Failed to get CLI version for ${cliId}: ${err.message}`);
    return false;
  }
}

// ─── Helpers (local to daemon) ───────────────────────────────────────────────

function tag(ds: DaemonSession): string {
  return ds.session.sessionId.substring(0, 8);
}

function getActiveCount(): number {
  let count = 0;
  for (const [, ds] of activeSessions) {
    if (ds.worker && !ds.worker.killed) count++;
  }
  return count;
}

/**
 * Find a sibling session whose `workingDir` we can reuse to skip the repo card.
 *
 * Three layers, tried in order:
 *   1. Same-anchor cross-bot peer (thread → root, chat → chatId): another bot
 *      already pinned a workingDir at exactly this anchor, e.g. 同根 thread
 *      reply or 同群 chat-scope reply.
 *   2. New-thread-in-普通群 fallback: scope=thread + chatType=group + no
 *      same-anchor peer → look for any chat-scope session in the same chat,
 *      regardless of bot. Covers the user's "open a 话题 in 普通群 where
 *      chat-scope sessions already exist" flow — the new thread is a child
 *      context of the same chat, the workingDir is unambiguous, no need to
 *      bounce through repo selection.
 *   3. Otherwise: null (caller falls through to oncall pin or repo card).
 *
 * Same-bot is allowed in layer 2 only — the new thread anchors on a different
 * id than the chat-scope session, so there's no anchor conflict and inheriting
 * one's own pinned workingDir is the obvious default. Layer 1 keeps the
 * cross-bot filter so two daemons don't ping-pong each other's anchors.
 */
function findInheritablePeer(opts: {
  scope: 'thread' | 'chat';
  anchor: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  selfAppId: string;
}): { sessionId: string; larkAppId?: string; workingDir: string } | null {
  const { scope, anchor, chatId, chatType, selfAppId } = opts;
  const sameAnchorPeers = scope === 'thread'
    ? sessionStore.findActiveSessionsByRoot(anchor)
    : sessionStore.findActiveChatScopeSessionsByChat(chatId);
  let peer = sameAnchorPeers.find(p => p.larkAppId !== selfAppId && !!p.workingDir);
  if (peer && peer.workingDir) {
    return { sessionId: peer.sessionId, larkAppId: peer.larkAppId, workingDir: peer.workingDir };
  }
  if (scope === 'thread' && chatType === 'group') {
    const chatPeers = sessionStore.findActiveChatScopeSessionsByChat(chatId);
    peer = chatPeers.find(p => !!p.workingDir);
    if (peer && peer.workingDir) {
      return { sessionId: peer.sessionId, larkAppId: peer.larkAppId, workingDir: peer.workingDir };
    }
  }
  return null;
}


// Dependencies passed to command-handler
const commandDeps: CommandHandlerDeps = {
  activeSessions,
  sessionReply,
  getActiveCount,
  lastRepoScan,
};

// Dependencies passed to card-handler
const cardDeps: CardHandlerDeps = {
  activeSessions,
  sessionReply,
  lastRepoScan,
};

// ─── Event handling ──────────────────────────────────────────────────────────

async function handleNewTopic(data: any, ctx: RoutingContext): Promise<void> {
  const { chatId, messageId, chatType, scope, anchor, larkAppId } = ctx;
  await resolveNonsupportMessage(data, larkAppId);
  const { parsed, resources } = parseEventMessage(data);

  // Expand merge_forward: fetch sub-messages and collect their resources
  if (parsed.msgType === 'merge_forward') {
    const { extraResources } = await expandMergeForward(larkAppId, messageId, parsed);
    resources.push(...extraResources);
  }

  const content = parsed.content.trim();
  // Strip leading @<bot> mentions so "@bot /oncall bind" is recognized as a command.
  const cmdContent = stripLeadingMentions(content, parsed.mentions);
  const senderOpenId: string | undefined = data.sender?.sender_id?.open_id;
  const botCfg = getBot(larkAppId).config;
  logger.info(`New session: "${content.substring(0, 60)}" (scope=${scope}, anchor=${anchor.substring(0, 12)}, resources: ${resources.length}, active: ${getActiveCount()}, messageId: ${messageId}, chatId: ${chatId})`);

  // Intercept daemon commands in new topics (no session needed for some commands)
  const invocation = parseSlashCommandInvocation(cmdContent);
  if (invocation) {
    const { cmd, content: commandContent } = invocation;
    if (PASSTHROUGH_COMMANDS.has(cmd)) {
      await sessionReply(anchor, `${cmd} 需要在已有会话内使用（先发一条普通消息启动 CLI）。`, 'text', larkAppId);
      return;
    }
    if (DAEMON_COMMANDS.has(cmd)) {
      // Oncall groups: any member can talk, but daemon commands (except /oncall
      // itself which gates bind/unbind inside) are owner-only.
      if (cmd !== '/oncall' && findOncallChat(larkAppId, chatId) && !canOperate(larkAppId, chatId, senderOpenId)) {
        await sessionReply(anchor, `⚠️ ${cmd} 仅 oncall owner 可执行。`, 'text', larkAppId);
        return;
      }
      // Same rootMessageId reasoning as below in the main spawn path:
      // thread-scope MUST anchor on the thread root or sessionAnchorId() will
      // disagree with activeSessions's key and downstream card buttons silently
      // break. Chat-scope keeps the inbound messageId as audit only.
      const cmdRootIdForStore = scope === 'thread' ? anchor : messageId;
      const session = sessionStore.createSession(chatId, cmdRootIdForStore, cmdContent.substring(0, 50), chatType);
      session.larkAppId = larkAppId;
      session.ownerOpenId = senderOpenId;
      session.lastCallerOpenId = senderOpenId;
      session.scope = scope;
      sessionStore.updateSession(session);
      activeSessions.set(sessionKey(anchor, larkAppId), {
        session,
        worker: null,
        workerPort: null,
        workerToken: null,
        larkAppId,
        chatId,
        chatType,
        scope,
        spawnedAt: Date.now(),
        cliVersion: cliVersionCache.get(botCfg.cliId)?.version ?? 'unknown',
        lastMessageAt: Date.now(),
        hasHistory: false,
        ownerOpenId: senderOpenId,
      });
      // Pass mention-stripped content so /command argument parsing works.
      await handleCommand(cmd, anchor, { ...parsed, content: commandContent }, commandDeps, larkAppId);
      return;
    }
  }

  // Download attachments
  const { attachments, needLogin } = await downloadResources(larkAppId, messageId, resources);
  if (attachments.length > 0) {
    parsed.attachments = attachments;
  }
  if (needLogin) {
    sessionReply(anchor, '⚠️ 部分图片/文件下载失败（缺少 User Token）。请在话题中发送 /login 授权后重新发送。', 'text', larkAppId);
  }

  refreshCliVersion(botCfg.cliId, botCfg.cliPathOverride);

  // Create session in pending-repo state — don't spawn CLI yet.
  // For thread-scope, rootMessageId == anchor (the thread root). Critical
  // because sessionAnchorId() uses rootMessageId for thread-scope, and the
  // session card's button payload (value.root_id) flows from there back into
  // activeSessions.get(sessionKey(rootId, larkAppId)) — if rootMessageId is
  // the inbound message_id instead of the thread root, every restart/close/
  // disconnect click silently no-ops.
  // For chat-scope, rootMessageId stores the seed message_id (audit only);
  // routing keys off chatId via sessionAnchorId(), so any value works.
  const rootIdForStore = scope === 'thread' ? anchor : messageId;
  const session = sessionStore.createSession(chatId, rootIdForStore, parsed.content.substring(0, 50), chatType);
  session.larkAppId = larkAppId;
  session.ownerOpenId = senderOpenId;
  session.scope = scope;
  sessionStore.updateSession(session);
  messageQueue.ensureQueue(anchor);
  messageQueue.appendMessage(anchor, parsed);

  // Oncall group: pin working dir from binding, skip repo selection entirely.
  const oncallEntry = findOncallChat(larkAppId, chatId);

  // Cross-bot / chat-scope inheritance: reuse a sibling session's workingDir
  // and skip the repo card. Same block lives in handleThreadReply's auto-create
  // branch — both handlers land unowned messages after the 4fec43c routing
  // change. Helper is shared.
  const inheritedFrom = !oncallEntry
    ? findInheritablePeer({ scope, anchor, chatId, chatType, selfAppId: larkAppId })
    : null;

  const pinnedWorkingDir = oncallEntry?.workingDir ?? inheritedFrom?.workingDir;
  const ds: DaemonSession = {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId,
    chatId,
    chatType,
    scope,
    spawnedAt: Date.now(),
    cliVersion: cliVersionCache.get(botCfg.cliId)?.version ?? 'unknown',
    lastMessageAt: Date.now(),
    hasHistory: false,
    pendingRepo: !pinnedWorkingDir,
    pendingPrompt: content,
    pendingAttachments: attachments.length > 0 ? attachments : undefined,
    pendingMentions: parsed.mentions,
    ownerOpenId: senderOpenId,
    currentTurnTitle: content.substring(0, 50),
    workingDir: pinnedWorkingDir,
  };
  if (pinnedWorkingDir) {
    ds.session.workingDir = pinnedWorkingDir;
    sessionStore.updateSession(ds.session);
  }
  activeSessions.set(sessionKey(anchor, larkAppId), ds);

  // Pinned (oncall binding or inherited from sibling bot): spawn CLI immediately.
  if (pinnedWorkingDir) {
    const selfBot = getBot(larkAppId);
    const prompt = buildNewTopicPrompt(content, session.sessionId, botCfg.cliId, botCfg.cliPathOverride, attachments, parsed.mentions, await getAvailableBots(larkAppId, chatId), undefined, { name: selfBot.botName, openId: selfBot.botOpenId });
    forkWorker(ds, prompt);
    const reason = oncallEntry
      ? `oncall-bound chat ${chatId}`
      : `inherited from sibling session ${inheritedFrom!.sessionId.substring(0, 8)} (app=${inheritedFrom!.larkAppId ?? 'unknown'})`;
    logger.info(`[${tag(ds)}] ${reason} → workingDir=${pinnedWorkingDir}, skipped repo select`);
    return;
  }

  // Show repo selection card
  const scanDirs = getProjectScanDirs(ds).filter(d => existsSync(d));
  let projects: import('./services/project-scanner.js').ProjectInfo[] = [];
  if (scanDirs.length > 0) {
    projects = scanMultipleProjects(scanDirs);
  }
  if (projects.length > 0) {
    lastRepoScan.set(chatId, projects);
    const currentCwd = getSessionWorkingDir(ds);
    const cardJson = buildRepoSelectCard(projects, currentCwd, anchor);
    ds.repoCardMessageId = await sessionReply(anchor, cardJson, 'interactive', larkAppId);
    logger.info(`[${tag(ds)}] Waiting for repo selection (${projects.length} projects)`);
  } else {
    // No projects found — skip repo selection, spawn directly
    ds.pendingRepo = false;
    const selfBot = getBot(larkAppId);
    const prompt = buildNewTopicPrompt(content, session.sessionId, botCfg.cliId, botCfg.cliPathOverride, attachments, parsed.mentions, await getAvailableBots(larkAppId, chatId), undefined, { name: selfBot.botName, openId: selfBot.botOpenId });
    forkWorker(ds, prompt);
    logger.info(`Session ${session.sessionId} ready (no projects to select), total active: ${getActiveCount()}`);
  }
}

async function handleThreadReply(data: any, ctx: RoutingContext): Promise<void> {
  const { chatId: ctxChatId, chatType: ctxChatType, scope, anchor, larkAppId } = ctx;
  await resolveNonsupportMessage(data, larkAppId);
  const { parsed, resources } = parseEventMessage(data);

  // Expand merge_forward: fetch sub-messages and collect their resources
  if (parsed.msgType === 'merge_forward') {
    const { extraResources } = await expandMergeForward(larkAppId, parsed.messageId, parsed);
    resources.push(...extraResources);
  }

  const content = parsed.content.trim();
  // Strip leading @<bot> mentions so "@bot /restart" is recognized as a command.
  const cmdContent = stripLeadingMentions(content, parsed.mentions);

  // Intercept OAuth callback URLs (from /login flow)
  if (isCallbackUrl(content)) {
    const result = await handleCallbackUrl(content);
    if (result) {
      // Route through sessionReply so chat-scope (普通群) lands as a plain
      // chat message instead of a forced new thread.
      sessionReply(anchor, result, 'text', larkAppId)
        .catch(err => logger.error(`Failed to reply login result: ${err}`));
      return;
    }
  }

  // Intercept daemon commands
  const invocation = parseSlashCommandInvocation(cmdContent);
  if (invocation) {
    const { cmd, content: commandContent } = invocation;
    if (PASSTHROUGH_COMMANDS.has(cmd)) {
      const ds = activeSessions.get(sessionKey(anchor, larkAppId));
      if (ds?.worker && !ds.worker.killed) {
        ds.worker.send({ type: 'raw_input', content: commandContent } as DaemonToWorker);
        ds.lastMessageAt = Date.now();
        logger.info(`[${anchor.substring(0, 12)}] Passthrough ${cmd} → worker`);
      } else {
        sessionReply(anchor, `${cmd} 需要活跃的 CLI 进程，当前话题无运行中的会话。`, 'text', larkAppId);
      }
      return;
    }
    if (DAEMON_COMMANDS.has(cmd)) {
      // Oncall owner gate for thread-reply daemon commands
      const existingDs = activeSessions.get(sessionKey(anchor, larkAppId));
      const threadChatId = existingDs?.chatId ?? ctxChatId ?? data?.message?.chat_id;
      const threadSenderOpenId = parsed.senderId || data?.sender?.sender_id?.open_id;
      if (cmd !== '/oncall' && threadChatId && findOncallChat(larkAppId, threadChatId) && !canOperate(larkAppId, threadChatId, threadSenderOpenId)) {
        sessionReply(anchor, `⚠️ ${cmd} 仅 oncall owner 可执行。`, 'text', larkAppId);
        return;
      }
      // Pass mention-stripped content so /command argument parsing works.
      handleCommand(cmd, anchor, { ...parsed, content: commandContent }, commandDeps, larkAppId);
      return;
    }
  }

  logger.info(`Reply in ${scope}-scope session ${anchor.substring(0, 12)}: ${content.substring(0, 100)} (resources: ${resources.length})`);

  let ds = activeSessions.get(sessionKey(anchor, larkAppId));

  // If another bot already owns this anchor, ignore unmentioned replies here as a
  // second line of defense. Explicit @mentions are still allowed to spin up/take over.
  // For chat-scope: another bot's session in the same chat is keyed by its own chatId.
  // For thread-scope: same rootMessageId may have peer sessions across bots.
  if (!ds) {
    const mentionedThisBot = isBotMentioned(larkAppId, data?.message ?? {}, data?.sender?.sender_id?.open_id);
    const hasOtherBot = [...activeSessions.values()].some(s => {
      if (s.larkAppId === larkAppId) return false;
      if (s.scope === 'chat') return s.chatId === ctxChatId && scope === 'chat';
      return s.session.rootMessageId === anchor;
    });
    if (hasOtherBot && !mentionedThisBot) {
      logger.info(`[${larkAppId}] Ignoring ${scope}-scope ${anchor}; another bot already owns it`);
      return;
    }
  }

  // Download attachments
  const effectiveAppId = ds?.larkAppId ?? larkAppId;
  const { attachments, needLogin } = await downloadResources(effectiveAppId, parsed.messageId, resources);
  if (attachments.length > 0) {
    parsed.attachments = attachments;
  }
  if (needLogin) {
    sessionReply(anchor, '⚠️ 部分图片/文件下载失败（缺少 User Token）。请在话题中发送 /login 授权后重新发送。', 'text', effectiveAppId);
  }

  // Update last message time + last caller (used by `botmux send` to address
  // reply cards to whoever triggered this turn — matters in oncall groups
  // where the caller is often not the session owner).
  if (ds) {
    ds.lastMessageAt = Date.now();
    const callerOpenId = parsed.senderId || data?.sender?.sender_id?.open_id;
    if (callerOpenId && ds.session.lastCallerOpenId !== callerOpenId) {
      ds.session.lastCallerOpenId = callerOpenId;
      sessionStore.updateSession(ds.session);
    }
  }

  // If waiting for repo selection, buffer the message and remind user
  if (ds?.pendingRepo) {
    // Enrich content with attachment hints and mention metadata (same as normal send)
    let enriched = attachments.length > 0
      ? `${parsed.content}${formatAttachmentsHint(attachments)}`
      : parsed.content;
    if (parsed.mentions && parsed.mentions.length > 0) {
      const mentionLines = parsed.mentions.map(m => {
        const idPart = m.openId ? ` → open_id: ${m.openId}` : '';
        return `- @${m.name}${idPart}`;
      });
      enriched += `\n\n消息中的 @mention：\n${mentionLines.join('\n')}`;
    }
    if (!ds.pendingFollowUps) ds.pendingFollowUps = [];
    ds.pendingFollowUps.push(enriched);
    await sessionReply(anchor, '请先在上方卡片中选择仓库，您的消息已暂存，选择后会自动发送。', 'text', larkAppId);
    return;
  }

  // Route to file queue (keyed by anchor: rootMessageId for thread, chatId for chat)
  messageQueue.ensureQueue(anchor);
  messageQueue.appendMessage(anchor, parsed);

  if (!ds) {
    // No active session at this anchor — auto-create. This branch is mostly a
    // safety net; the dispatcher routes here only when isSessionOwner() returns
    // true, but races (between check and execution, or session-closed events)
    // can land us here.
    if (activeSessions.has(sessionKey(anchor, larkAppId))) {
      logger.info(`[${larkAppId}] Session already exists for ${scope}-scope ${anchor}, skipping auto-create`);
      return;
    }

    const autoCreateChatId: string = ctxChatId ?? data?.message?.chat_id ?? '';
    const autoCreateChatType = ctxChatType ?? (data?.message?.chat_type === 'p2p' ? 'p2p' : 'group') as 'group' | 'p2p';
    const botCfg = getBot(larkAppId).config;
    logger.info(`No active session for ${scope}-scope ${anchor}, auto-creating new session...`);
    refreshCliVersion(botCfg.cliId, botCfg.cliPathOverride);
    const senderOId = data.sender?.sender_id?.open_id;
    // For thread-scope: rootMessageId = anchor (real thread root).
    // For chat-scope:   rootMessageId = the message_id that triggered this auto-create
    //                   (used as audit trail; routing key is chatId).
    const rootIdForStore = scope === 'thread' ? anchor : parsed.messageId;
    const session = sessionStore.createSession(autoCreateChatId, rootIdForStore, parsed.content.substring(0, 50), autoCreateChatType);
    session.larkAppId = larkAppId;
    session.ownerOpenId = senderOId;
    session.lastCallerOpenId = senderOId;
    session.scope = scope;
    sessionStore.updateSession(session);

    // Oncall group: pin working dir from binding, skip repo selection entirely
    // (mirrors handleNewTopic — auto-create was missing this check).
    const oncallEntry = findOncallChat(larkAppId, autoCreateChatId);

    // Cross-bot / chat-scope inheritance — see findInheritablePeer comments.
    const inheritedFrom = !oncallEntry
      ? findInheritablePeer({
          scope,
          anchor,
          chatId: autoCreateChatId,
          chatType: autoCreateChatType,
          selfAppId: larkAppId,
        })
      : null;

    const pinnedWorkingDir = oncallEntry?.workingDir ?? inheritedFrom?.workingDir;
    const newDs: DaemonSession = {
      session,
      worker: null,
      workerPort: null,
      workerToken: null,
      larkAppId,
      chatId: autoCreateChatId,
      chatType: autoCreateChatType,
      scope,
      spawnedAt: Date.now(),
      cliVersion: cliVersionCache.get(botCfg.cliId)?.version ?? 'unknown',
      lastMessageAt: Date.now(),
      hasHistory: false,
      pendingRepo: !pinnedWorkingDir,
      pendingPrompt: parsed.content,
      pendingAttachments: attachments.length > 0 ? attachments : undefined,
      pendingMentions: parsed.mentions,
      ownerOpenId: senderOId,
      currentTurnTitle: parsed.content.substring(0, 50),
      workingDir: pinnedWorkingDir,
    };
    if (pinnedWorkingDir) {
      newDs.session.workingDir = pinnedWorkingDir;
      sessionStore.updateSession(newDs.session);
    }
    activeSessions.set(sessionKey(anchor, larkAppId), newDs);

    // Pinned (oncall binding or inherited from peer bot in same thread):
    // spawn CLI immediately, skip repo selection.
    if (pinnedWorkingDir) {
      const selfBot = getBot(larkAppId);
      const prompt = buildNewTopicPrompt(parsed.content, session.sessionId, botCfg.cliId, botCfg.cliPathOverride, attachments, parsed.mentions, await getAvailableBots(larkAppId, autoCreateChatId), undefined, { name: selfBot.botName, openId: selfBot.botOpenId });
      forkWorker(newDs, prompt);
      const reason = oncallEntry
        ? `oncall-bound chat ${autoCreateChatId}`
        : `inherited from peer session ${inheritedFrom!.sessionId.substring(0, 8)} (app=${inheritedFrom!.larkAppId ?? 'unknown'})`;
      logger.info(`[${tag(newDs)}] ${reason} → workingDir=${pinnedWorkingDir}, skipped repo select`);
      return;
    }

    // Show repo selection card (same as handleNewTopic)
    const scanDirs2 = getProjectScanDirs(newDs).filter(d => existsSync(d));
    let projects: import('./services/project-scanner.js').ProjectInfo[] = [];
    if (scanDirs2.length > 0) {
      projects = scanMultipleProjects(scanDirs2);
    }
    if (projects.length > 0) {
      lastRepoScan.set(autoCreateChatId, projects);
      const currentCwd = getSessionWorkingDir(newDs);
      const cardJson = buildRepoSelectCard(projects, currentCwd, anchor);
      newDs.repoCardMessageId = await sessionReply(anchor, cardJson, 'interactive', larkAppId);
      logger.info(`[${tag(newDs)}] Waiting for repo selection (${projects.length} projects)`);
    } else {
      // No projects found — skip repo selection, spawn directly
      newDs.pendingRepo = false;
      const selfBot = getBot(larkAppId);
      const prompt = buildNewTopicPrompt(parsed.content, session.sessionId, botCfg.cliId, botCfg.cliPathOverride, attachments, parsed.mentions, await getAvailableBots(larkAppId, autoCreateChatId), undefined, { name: selfBot.botName, openId: selfBot.botOpenId });
      forkWorker(newDs, prompt);
    }

    return;
  }

  // Send message to worker via IPC
  if (ds.worker && !ds.worker.killed) {
    const dsBotCfgForMsg = getBot(ds.larkAppId).config;
    // Adopt mode: the adopted CLI is the user's external process and was
    // never injected with botmux's skill / system prompt. Sending it the
    // `<user_message>` / `<botmux_reminder>` / `<session_id>` wrappers
    // surfaces those tags verbatim in its UI (the user reported Codex
    // showing raw XML on every Lark message). Use the bridge raw-input
    // builder for ALL adopt sessions regardless of cliId — transcript
    // harvest (Claude bridge or Codex bridge) handles the reply path
    // out-of-band.
    const isBridge = !!ds.adoptedFrom;
    const msgContent = isBridge
      ? buildBridgeInputContent(parsed.content, {
          attachments,
          mentions: parsed.mentions,
        })
      : buildFollowUpContent(parsed.content, ds.session.sessionId, {
          attachments,
          mentions: parsed.mentions,
          isAdoptMode: false,
          cliId: dsBotCfgForMsg.cliId,
          cliPathOverride: dsBotCfgForMsg.cliPathOverride,
        });
    // Freeze the previous turn's card at "idle" before starting a new turn
    if (ds.streamCardId && ds.workerPort) {
      const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
      const dsBotCfg = getBot(ds.larkAppId).config;
      const prevTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(dsBotCfg.cliId);
      const prevMode = ds.displayMode ?? 'hidden';
      const frozenCard = buildStreamingCard(
        ds.session.sessionId, sessionAnchorId(ds), readUrl, prevTitle,
        ds.lastScreenContent ?? '', 'idle', dsBotCfg.cliId,
        prevMode, ds.streamCardNonce, ds.currentImageKey,
        !!ds.adoptedFrom, false,
      );
      // Freeze through the serialization queue to avoid racing with an in-flight PATCH.
      // scheduleCardPatch replaces any stale pending item (latest-wins).
      scheduleCardPatch(ds, frozenCard);

      // Cache frozen card data so historical cards can still be toggled (expand/collapse)
      if (ds.streamCardNonce && ds.streamCardId !== CARD_POSTING_SENTINEL) {
        if (!ds.frozenCards) ds.frozenCards = new Map();
        ds.frozenCards.set(ds.streamCardNonce, {
          messageId: ds.streamCardId,
          content: ds.lastScreenContent ?? '',
          title: prevTitle,
          displayMode: prevMode,
          imageKey: ds.currentImageKey,
        });
        saveFrozenCards(ds.session.sessionId, ds.frozenCards);
      }
    }
    // Mark new turn — next screen_update will create a fresh streaming card
    ds.streamCardPending = true;
    ds.currentTurnTitle = parsed.content.substring(0, 50);
    persistStreamCardState(ds);
    ds.worker.send({ type: 'message', content: msgContent } as DaemonToWorker);
  } else {
    // Worker not running — re-fork with resume. This is a NEW turn, so drop
    // any restored streaming-card reference; worker_ready will POST a fresh
    // card instead of PATCHing the previous turn's card in place.
    logger.info(`[${tag(ds)}] Worker not running, re-forking...`);
    ds.currentTurnTitle = parsed.content.substring(0, 50);
    // The cosmetic freeze step (above) is gated on a live worker. With no
    // worker we just park the current card in frozenCards — the upcoming
    // new POST will recall it. Parking instead of deleting preserves the
    // "old card stays until a new one is live" invariant: if fork /
    // worker_ready / POST fails, the user still sees the previous card.
    parkStreamCard(ds);
    ds.streamCardId = undefined;
    ds.streamCardNonce = undefined;
    persistStreamCardState(ds);
    forkWorker(ds, parsed.content, ds.hasHistory);
  }
}

// ─── Bot-to-bot mention routing ───────────────────────────────────────────────

interface BotMentionSignal {
  rootMessageId: string;
  chatId: string;
  chatType?: string;
  /** Sender session's routing scope; receivers use it to pick the right
   *  activeSessions key. Older signals without this field default to 'thread'
   *  (the legacy behaviour). */
  scope?: 'thread' | 'chat';
  senderAppId: string;
  targetBotOpenId: string;
  content: string;
  messageId: string;
  timestamp: number;
}

function processBotMentionSignal(signal: BotMentionSignal): void {
  // Find the target bot by open_id
  const targetBot = getAllBots().find(b => b.botOpenId === signal.targetBotOpenId);
  if (!targetBot) {
    logger.debug(`[bot-mention] No bot found for open_id ${signal.targetBotOpenId}`);
    return;
  }

  // Cross-path dedup: WSClient may have already enqueued this turn. messageId
  // is the canonical key (per-message, immune to ordering between WS push and
  // fs watch).
  if (isBotMentionMessageHandled(signal.messageId)) {
    logger.debug(`[bot-mention] Signal-file path skipping ${signal.messageId.substring(0, 12)}: already handled by WSClient`);
    return;
  }

  const targetAppId = targetBot.config.larkAppId;
  // Anchor depends on sender's session scope: chat-scope sessions are keyed
  // by chatId, thread-scope by rootMessageId.
  const anchor = signal.scope === 'chat' ? signal.chatId : signal.rootMessageId;
  const ds = activeSessions.get(sessionKey(anchor, targetAppId));

  if (ds && ds.worker && !ds.worker.killed) {
    // Target bot has an active session in this thread — send the message.
    // Look up sender name from bots-info.json (each daemon only registers its own bot,
    // so getAllBots() won't find other bots).
    let senderName = 'Bot';
    try {
      const infoPath = join(config.session.dataDir, 'bots-info.json');
      if (existsSync(infoPath)) {
        const entries: Array<{ larkAppId: string; botName: string | null; cliId: string }> = JSON.parse(readFileSync(infoPath, 'utf-8'));
        const sender = entries.find(e => e.larkAppId === signal.senderAppId);
        if (sender) senderName = sender.botName ?? getCliDisplayName(sender.cliId as CliId);
      }
    } catch { /* ignore */ }
    const enrichedParts = [`[来自 ${senderName} 的 @mention]\n${signal.content}`];
    if (!ds.adoptedFrom) {
      const mentionBotCfg = getBot(ds.larkAppId).config;
      const mentionAdapter = createCliAdapterSync(mentionBotCfg.cliId, mentionBotCfg.cliPathOverride);
      if (!mentionAdapter.injectsSessionContext) {
        enrichedParts.push(`Session ID: ${ds.session.sessionId}`);
      }
    }
    const enrichedContent = enrichedParts.join('\n\n');
    ds.lastMessageAt = Date.now();
    // Park the current streaming card so the new turn's POST can recall it.
    // Without this the bot-to-bot mention path leaves old cards stranded —
    // it bypasses the user-message freeze block in handleThreadReply.
    parkStreamCard(ds);
    ds.streamCardPending = true;
    ds.currentTurnTitle = signal.content.substring(0, 50);
    persistStreamCardState(ds);
    markBotMentionMessageHandled(signal.messageId);
    ds.worker.send({ type: 'message', content: enrichedContent } as DaemonToWorker);
    logger.info(`[bot-mention] Routed message from ${signal.senderAppId} to ${targetAppId} (scope=${signal.scope ?? 'thread'}, anchor=${anchor.substring(0, 12)})`);
  } else {
    logger.debug(`[bot-mention] Target bot ${targetAppId} has no active worker at ${signal.scope ?? 'thread'}-scope anchor ${anchor.substring(0, 12)} — WSClient auto-create path will handle it if @mention was delivered`);
  }
}

function isSignalForMe(signal: BotMentionSignal): boolean {
  return getAllBots().some(b => b.botOpenId === signal.targetBotOpenId);
}

function startBotMentionWatcher(): void {
  const signalDir = join(config.session.dataDir, 'bot-mentions');
  if (!existsSync(signalDir)) mkdirSync(signalDir, { recursive: true });

  // Process any existing signal files (from before daemon started)
  try {
    for (const file of readdirSync(signalDir)) {
      if (!file.endsWith('.json')) continue;
      const filePath = join(signalDir, file);
      try {
        const signal: BotMentionSignal = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (!isSignalForMe(signal)) continue; // not for this daemon, leave for target
        unlinkSync(filePath);
        processBotMentionSignal(signal);
      } catch (err) {
        logger.debug(`[bot-mention] Failed to process signal ${file}: ${err}`);
      }
    }
  } catch { /* ignore */ }

  // Watch for new signal files
  watch(signalDir, (event, filename) => {
    if (event !== 'rename' || !filename?.endsWith('.json')) return;
    const filePath = join(signalDir, filename);
    // Small delay to ensure the file is fully written
    setTimeout(() => {
      try {
        if (!existsSync(filePath)) return; // already processed or deleted
        const signal: BotMentionSignal = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (!isSignalForMe(signal)) return; // not for this daemon, leave for target
        unlinkSync(filePath);
        processBotMentionSignal(signal);
      } catch (err) {
        logger.debug(`[bot-mention] Failed to process signal ${filename}: ${err}`);
      }
    }, 50);
  });

  logger.info(`[bot-mention] Watching for signals in ${signalDir}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function startDaemon(botIndex?: number): Promise<void> {
  // 首次启动时后台尝试安装 CJK 字体（Debian/Ubuntu），避免截图中文显示豆腐块。
  // 不阻塞：首张截图可能仍是豆腐块，装完重启 daemon 即可正常。
  ensureCjkFontsInstalled();

  // Load the assigned bot (one daemon per bot)
  const botConfigs = loadBotConfigs();
  const idx = botIndex ?? 0;
  if (idx < 0 || idx >= botConfigs.length) {
    throw new Error(`Invalid BOTMUX_BOT_INDEX=${idx}, only ${botConfigs.length} bot(s) configured`);
  }
  const cfg = botConfigs[idx];
  registerBot(cfg);
  sessionStore.init(cfg.larkAppId);
  // Watch schedules.json for external writes (e.g. `botmux schedule add`
  // running in a separate node process) so dashboard event bus stays in sync.
  scheduleStore.startExternalWriteWatcher();
  logger.info(`Bot ${idx}/${botConfigs.length}: ${cfg.larkAppId} (cli: ${cfg.cliId})`)

  writePidFile();

  // Publish self-descriptor for the dashboard registry. The dashboard sibling
  // process discovers running daemons by scanning ~/.botmux/data/dashboard-daemons/
  // and watching for mtime updates (heartbeat) / file removal (shutdown).
  const ipcPort = config.dashboard.ipcBasePort + idx;
  const desc: DaemonDescriptor = {
    larkAppId: cfg.larkAppId,
    botName: cfg.larkAppId,
    botIndex: idx,
    ipcPort,
    pid: process.pid,
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
  };
  // Initialise worker pool with daemon callbacks
  initWorkerPool({
    sessionReply,
    getSessionWorkingDir,
    getActiveCount,
    closeSession(ds: DaemonSession) {
      // Route through the dashboard-aware helper so session.exited / session.update
      // events fire for withdrawn-message / crash / adopt-exit teardown paths too,
      // matching the dashboard-driven close.
      void closeSessionHelper(ds.session.sessionId).catch(() => { /* idempotent */ });
      logger.info(`[${ds.session.sessionId.substring(0, 8)}] Session auto-closed (message withdrawn)`);
    },
  });
  // Expose the activeSessions Map (owned by daemon) to worker-pool readers,
  // so dashboard IPC and other consumers can list/lookup live sessions.
  setActiveSessionsRegistry(activeSessions);
  // Seed dashboard IPC botName with the bot's config id; the friendly name from
  // /bot/v3/info is wired into the registry descriptor (below) but the IPC server
  // also needs its own copy for SessionRow.botName.
  setBotName(cfg.larkAppId);
  setLarkAppId(cfg.larkAppId);

  // Bind dashboard IPC HTTP server BEFORE publishing the registry descriptor.
  // Otherwise the dashboard process can race-fetch the IPC port from the
  // descriptor and hit ECONNREFUSED before we're listening — that left every
  // newly-started daemon's hydrate failing on dashboard startup. Binds to
  // 127.0.0.1 only since the dashboard sibling runs on the same host.
  const ipcHandle = await startIpcServer({ port: ipcPort, host: '127.0.0.1' });
  logger.info(`[dashboard-ipc] listening on 127.0.0.1:${ipcHandle.port} (bot ${idx})`);

  // Now that the IPC port is actually listening, publish the descriptor so
  // the dashboard can discover us and successfully fetch /api/sessions etc.
  desc.lastHeartbeat = Date.now();
  writeDaemonDescriptor(desc);
  const descriptorHeartbeat = setInterval(() => {
    desc.lastHeartbeat = Date.now();
    try { writeDaemonDescriptor(desc); } catch { /* best effort */ }
  }, 30_000);
  // Don't keep the event loop alive on this interval alone.
  if (typeof descriptorHeartbeat.unref === 'function') descriptorHeartbeat.unref();

  // Per-bot initialization
  for (const bot of getAllBots()) {
    const cfg = bot.config;

    // Refresh CLI version per bot's cliId
    refreshCliVersion(cfg.cliId, cfg.cliPathOverride);

    // Resolve allowed users per bot
    if (bot.resolvedAllowedUsers.length > 0) {
      const hasEmails = bot.resolvedAllowedUsers.some(u => u.includes('@'));
      if (hasEmails) {
        try {
          bot.resolvedAllowedUsers = await resolveAllowedUsers(cfg.larkAppId, bot.resolvedAllowedUsers);
          logger.info(`[${cfg.larkAppId}] Resolved allowedUsers: ${bot.resolvedAllowedUsers.join(', ')}`);
        } catch (err: any) {
          logger.warn(`[${cfg.larkAppId}] Failed to resolve allowedUsers: ${err.message}`);
        }
      }
    }

    // Probe bot open_id and persist to bots-info.json. When the friendly
    // botName comes back from /bot/v3/info, refresh the dashboard descriptor
    // so the registry shows "Claude" / "Codex" instead of the raw app id.
    probeBotOpenId(cfg.larkAppId).then(() => {
      writeBotInfoFile(config.session.dataDir);
      const probedName = bot.botName;
      if (probedName && probedName !== desc.botName) {
        desc.botName = probedName;
        try { writeDaemonDescriptor(desc); } catch { /* best effort */ }
      }
    }).catch(err => {
      logger.warn(`[${cfg.larkAppId}] Bot open_id probe failed: ${err.message}`);
    });

    // Start event dispatcher for this bot
    startLarkEventDispatcher(cfg.larkAppId, cfg.larkAppSecret, {
      handleCardAction: (data, appId) => handleCardAction(data, cardDeps, appId),
      handleNewTopic: (data, ctx) => handleNewTopic(data, ctx),
      handleThreadReply: (data, ctx) => handleThreadReply(data, ctx),
      isSessionOwner: (anchor, appId) => activeSessions.has(sessionKey(anchor, appId)),
    });
  }

  // Restore active sessions from previous run
  restoreActiveSessions(activeSessions);

  // Start scheduler in every daemon.  Each daemon owns exactly one bot, so
  // each filters to only execute tasks whose `larkAppId` matches its bot
  // (unmatched tasks are handled by the owning bot's daemon instead; a
  // missing larkAppId falls through to bot-0 as a legacy fallback).
  scheduler.setExecuteCallback((task) => executeScheduledTask(task, activeSessions, refreshCliVersion));
  scheduler.setOwnerFilter(cfg.larkAppId, idx === 0);
  scheduler.startScheduler();

  // Watch for bot-to-bot mention signals. Lark WSClient does not deliver
  // events for bot-sent messages, so `botmux send --mention <other-bot>`
  // writes a signal file that the daemon picks up and routes internally.
  startBotMentionWatcher();

  // Graceful shutdown
  const shutdown = () => {
    logger.info(`Daemon shutting down... (active: ${getActiveCount()})`);
    scheduler.stopScheduler();
    clearInterval(descriptorHeartbeat);
    removeDaemonDescriptor(cfg.larkAppId);
    ipcHandle.close().catch(() => { /* swallow */ });
    for (const [, ds] of activeSessions) {
      if (ds.worker && !ds.worker.killed) {
        logger.info(`Shutting down worker for session ${ds.session.sessionId}`);
        const backendType = ds.larkAppId
          ? (getBot(ds.larkAppId).config.backendType ?? config.daemon.backendType)
          : config.daemon.backendType;
        if (backendType === 'tmux') {
          // Tmux mode: just kill the worker process — tmux session survives for re-attach.
          // Worker's SIGTERM handler calls backend.kill() which only detaches.
          try { ds.worker.kill('SIGTERM'); } catch { /* ignore */ }
          ds.worker = null;
          ds.workerPort = null;
          ds.workerToken = null;
        } else {
          killWorker(ds);
        }
      }
    }
    removePidFile();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // Best-effort cleanup on plain `exit` (e.g. uncaught fatal). No worker
  // shutdown here since the process is already on its way out — just remove
  // the descriptor so the dashboard doesn't see a phantom daemon.
  process.on('exit', () => {
    clearInterval(descriptorHeartbeat);
    removeDaemonDescriptor(cfg.larkAppId);
  });

  logger.info('Daemon is running. Press Ctrl+C to stop.');
}
