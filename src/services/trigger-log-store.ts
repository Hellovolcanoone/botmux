import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import type { TriggerAction, TriggerErrorCode } from './trigger-types.js';

export interface TriggerLogEntry {
  triggerId: string;
  connectorId?: string;
  action: TriggerAction | 'failed';
  status: 'ok' | 'error';
  error?: string;
  errorCode?: TriggerErrorCode;
  createdAt: string;
}

function logPath(dataDir: string = config.session.dataDir): string {
  return join(dataDir, 'trigger-logs.jsonl');
}

export function appendTriggerLog(
  entry: Omit<TriggerLogEntry, 'createdAt'> & { createdAt?: string },
  dataDir: string = config.session.dataDir,
): TriggerLogEntry {
  const full: TriggerLogEntry = { ...entry, createdAt: entry.createdAt ?? new Date().toISOString() };
  const fp = logPath(dataDir);
  mkdirSync(dirname(fp), { recursive: true });
  appendFileSync(fp, JSON.stringify(full) + '\n', 'utf-8');
  return full;
}

export function listTriggerLogs(
  opts: { limit?: number; connectorId?: string } = {},
  dataDir: string = config.session.dataDir,
): TriggerLogEntry[] {
  const fp = logPath(dataDir);
  if (!existsSync(fp)) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  const out: TriggerLogEntry[] = [];
  const lines = readFileSync(fp, 'utf-8').split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as TriggerLogEntry;
      if (opts.connectorId && parsed.connectorId !== opts.connectorId) continue;
      out.push(parsed);
    } catch { /* ignore corrupt line */ }
  }
  return out;
}
