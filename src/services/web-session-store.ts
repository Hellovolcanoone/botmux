/**
 * Web session store for the team platform UI.
 *
 * After a successful pairing-login (see pairing-store.ts) and a team-membership
 * check, the platform issues a web session token (set as an httpOnly cookie).
 * Authenticated UI endpoints validate the token here. Identity is the canonical
 * Feishu identity (union_id preferred) plus the team the session is scoped to.
 *
 * Tokens are high-entropy and never logged. Storage: `{dataDir}/web-sessions.json`
 * (shared across web + daemon processes), atomic writes; expired sessions pruned
 * on access.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface WebSessionIdentity {
  unionId?: string;
  openId?: string;
  name?: string;
}

export interface WebSession {
  token: string;
  identity: WebSessionIdentity;
  teamId: string;
  createdAt: number;
  expiresAt: number;
}

type FileShape = Record<string, WebSession>; // keyed by token

function filePath(dataDir: string): string {
  return join(dataDir, 'web-sessions.json');
}

function readFile(dataDir: string): FileShape {
  const fp = filePath(dataDir);
  if (!existsSync(fp)) return {};
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as FileShape;
  } catch { /* corrupt — fall through */ }
  return {};
}

function writeFileAtomic(dataDir: string, data: FileShape): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const fp = filePath(dataDir);
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, fp);
}

function prune(data: FileShape, now: number): FileShape {
  for (const [token, s] of Object.entries(data)) {
    if (s.expiresAt <= now) delete data[token];
  }
  return data;
}

export interface CreatedWebSession {
  token: string;
  expiresAt: number;
}

/** Issue a new web session for an authenticated, team-gated identity. */
export function createWebSession(
  dataDir: string,
  identity: WebSessionIdentity,
  teamId: string,
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now(),
): CreatedWebSession {
  const data = prune(readFile(dataDir), now);
  const token = randomBytes(32).toString('base64url');
  data[token] = { token, identity, teamId, createdAt: now, expiresAt: now + ttlMs };
  writeFileAtomic(dataDir, data);
  return { token, expiresAt: now + ttlMs };
}

/** Resolve a session token to its session, or null if missing/expired. */
export function getWebSession(dataDir: string, token: string, now: number = Date.now()): WebSession | null {
  if (!token) return null;
  const data = prune(readFile(dataDir), now);
  return data[token] ?? null;
}

/** Revoke (logout). Returns true if a session was removed. */
export function revokeWebSession(dataDir: string, token: string): boolean {
  const data = readFile(dataDir);
  if (!data[token]) return false;
  delete data[token];
  writeFileAtomic(dataDir, data);
  return true;
}
