/**
 * Per-bot "first seen" timestamps for chats — the dashboard sorts Groups & Bots
 * by these timestamps so newly-added chats surface at the top. Lark's chat
 * APIs do not return chat create_time, so we approximate creation order with
 * the moment our daemon first observed each chat in `im.v1.chat.list`.
 *
 * On a fresh install all existing chats get the same backfill timestamp on
 * first enumeration, so their relative order is undefined (the dashboard
 * tie-breaks by name). From that point on, every newly-added chat gets its
 * own real timestamp and rises above the bunch.
 *
 * File layout mirrors session-store: one file per bot at
 * `${config.session.dataDir}/chat-first-seen-${appId}.json`, written
 * atomically via tmp + rename.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let firstSeen: Map<string, number> = new Map();
let loaded = false;
let currentAppId: string | undefined;

export function init(appId: string): void {
  currentAppId = appId;
  loaded = false;
  firstSeen = new Map();
}

function getFilePath(): string {
  if (!currentAppId) throw new Error('chat-first-seen-store not initialised (call init(appId) first)');
  return join(config.session.dataDir, `chat-first-seen-${currentAppId}.json`);
}

/** True iff init() has been called with an appId. Callers that may run before
 *  daemon startup (e.g. the dashboard IPC server invoked from tests) can use
 *  this to skip persistence rather than crash the request. */
export function isInitialised(): boolean {
  return !!currentAppId;
}

function ensureDir(): void {
  const dir = dirname(getFilePath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function load(): void {
  if (loaded) return;
  ensureDir();
  const fp = getFilePath();
  if (existsSync(fp)) {
    try {
      const data = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, number>;
      firstSeen = new Map(Object.entries(data));
    } catch (err) {
      logger.error(`[chat-first-seen] failed to load ${fp}: ${err}`);
      firstSeen = new Map();
    }
  }
  loaded = true;
}

function save(): void {
  ensureDir();
  const fp = getFilePath();
  const tmpFp = fp + '.tmp';
  const obj: Record<string, number> = {};
  for (const [k, v] of firstSeen) obj[k] = v;
  writeFileSync(tmpFp, JSON.stringify(obj, null, 2), 'utf-8');
  renameSync(tmpFp, fp);
}

/**
 * Record `Date.now()` for each chatId not yet known, return the full map of
 * (chatId → firstSeenAt) for the requested ids. Batches the write so a fresh
 * 44-chat listChats only hits disk once.
 */
export function markSeenBulk(chatIds: readonly string[]): Map<string, number> {
  // Safe no-op when init() hasn't been called yet (e.g. dashboard IPC server
  // spun up in a test without a daemon backing it). Returning an empty map
  // lets the /api/groups handler degrade to `firstSeenAt: null` instead of
  // 502'ing the whole response.
  if (!currentAppId) return new Map();
  load();
  const now = Date.now();
  let dirty = false;
  for (const id of chatIds) {
    if (!firstSeen.has(id)) {
      firstSeen.set(id, now);
      dirty = true;
    }
  }
  if (dirty) {
    try { save(); }
    catch (err) { logger.error(`[chat-first-seen] save failed: ${err}`); }
  }
  const out = new Map<string, number>();
  for (const id of chatIds) {
    const ts = firstSeen.get(id);
    if (ts !== undefined) out.set(id, ts);
  }
  return out;
}
