/**
 * Team-level bot profile store: a short, human-facing **capability label** per
 * bot (keyed by larkAppId), separate from the full team role markdown.
 *
 * Why separate from the team role (see role-resolver.ts):
 * - The capability label is a one-liner used in the collaboration roster
 *   (`botmux bots list`) for discovery/selection — "后端 bot，擅长服务端排查".
 * - The full team role is the persona injected into the CLI `<role>` block.
 * Keeping them apart lets the roster stay scannable while the role stays rich.
 *
 * Storage: `{dataDir}/bot-profiles.json` — a flat map keyed by larkAppId, so it
 * relocates with the rest of session state via SESSION_DATA_DIR. Atomic writes
 * (unique tmp + rename) so concurrent daemons don't clobber each other.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** A capability label longer than this is almost certainly a full role, not a tag. */
const MAX_CAPABILITY_CHARS = 120;

export interface BotProfile {
  capability?: string;
  updatedAt: number;
  updatedBy?: string;
}

type FileShape = Record<string, BotProfile>;

function filePath(dataDir: string): string {
  return join(dataDir, 'bot-profiles.json');
}

function readFile(dataDir: string): FileShape {
  const fp = filePath(dataDir);
  if (!existsSync(fp)) return {};
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as FileShape;
  } catch { /* corrupt — fall through to empty */ }
  return {};
}

function writeFileAtomic(dataDir: string, data: FileShape): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const fp = filePath(dataDir);
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, fp);
}

/** Full profile for a bot, or null if none recorded. */
export function getBotProfile(dataDir: string, larkAppId: string): BotProfile | null {
  if (!larkAppId) return null;
  return readFile(dataDir)[larkAppId] ?? null;
}

/** Just the capability label for a bot, or null. */
export function getBotCapability(dataDir: string, larkAppId: string): string | null {
  return getBotProfile(dataDir, larkAppId)?.capability ?? null;
}

/** Set (or overwrite) a bot's capability label. Trimmed and length-capped. */
export function setBotCapability(dataDir: string, larkAppId: string, capability: string, updatedBy?: string, now: number = Date.now()): void {
  if (!larkAppId) return;
  const label = capability.trim().slice(0, MAX_CAPABILITY_CHARS);
  const data = readFile(dataDir);
  data[larkAppId] = { ...data[larkAppId], capability: label, updatedAt: now, ...(updatedBy ? { updatedBy } : {}) };
  writeFileAtomic(dataDir, data);
}

/** Remove a bot's capability label. Returns true if something was removed. */
export function clearBotCapability(dataDir: string, larkAppId: string, now: number = Date.now()): boolean {
  const data = readFile(dataDir);
  const prior = data[larkAppId];
  if (!prior || prior.capability === undefined) return false;
  data[larkAppId] = { ...prior, capability: undefined, updatedAt: now };
  delete data[larkAppId].capability;
  writeFileAtomic(dataDir, data);
  return true;
}

/** All recorded profiles, keyed by larkAppId. */
export function listBotProfiles(dataDir: string): FileShape {
  return readFile(dataDir);
}
