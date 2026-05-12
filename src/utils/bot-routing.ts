/**
 * Same-name bot disambiguation for `botmux send` cross-ref reverse lookup.
 *
 * bots-info.json can hold multiple entries with the same `botName` when a
 * deployment runs two apps under the same display name. Cross-ref files key
 * on botName (`{ <name>: <sender-scoped open_id> }`), so the reverse path
 * — botName → larkAppId — is ambiguous: `Array.find` silently routes to
 * whichever entry sorts first, often the wrong one. Prefer the entry whose
 * `oncallChats` includes the outbound chat — that's the deployment intent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BOTS_JSON = join(homedir(), '.botmux', 'bots.json');

export function loadOncallChatsByApp(botsJsonPath?: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const path = botsJsonPath
    ?? (process.env.BOTS_CONFIG ? resolve(process.env.BOTS_CONFIG) : DEFAULT_BOTS_JSON);
  try {
    if (!existsSync(path)) return map;
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(parsed)) return map;
    for (const cfg of parsed) {
      if (!cfg?.larkAppId || !Array.isArray(cfg.oncallChats)) continue;
      const chats = new Set<string>();
      for (const c of cfg.oncallChats) {
        if (typeof c?.chatId === 'string') chats.add(c.chatId);
      }
      if (chats.size > 0) map.set(cfg.larkAppId, chats);
    }
  } catch { /* */ }
  return map;
}

export function pickBotEntryByName<T extends { larkAppId: string; botName: string | null }>(
  botEntries: T[],
  name: string,
  targetChatId: string | undefined,
  oncallChatsByApp: Map<string, Set<string>>,
): T | undefined {
  const lower = name.toLowerCase();
  const candidates = botEntries.filter(e => e.botName?.toLowerCase() === lower);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1 || !targetChatId) return candidates[0];
  return candidates.find(e => oncallChatsByApp.get(e.larkAppId)?.has(targetChatId)) ?? candidates[0];
}
