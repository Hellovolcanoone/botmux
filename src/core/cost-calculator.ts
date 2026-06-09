/**
 * Session cost calculator — computes token usage from JSONL logs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
import { expandHome } from './working-dir.js';
import type { CliId } from '../adapters/cli/types.js';
import { findAidenLatestCheckpointByBotmuxSessionId, findAidenLatestCheckpointBySessionId } from '../services/aiden-checkpoints.js';
import { findCodexRolloutBySessionId, findCodexSessionIdByBotmuxSessionId } from '../services/codex-transcript.js';
import { cocoEventsPathForSession } from '../services/coco-transcript.js';
import { findCursorTranscriptByChatId } from '../services/cursor-transcript.js';
import { findTraexRolloutBySessionId } from '../services/traex-transcript.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  model: string;
  turns: number;
}

export interface SessionTokenUsage extends SessionCost {
  in: number;
  out: number;
}

export interface SessionTokenUsageQuery {
  cliId?: CliId | 'unknown';
  sessionId: string;
  cliSessionId?: string;
  cwd?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function getSessionJsonlPath(sessionId: string, cwd: string): string | null {
  return getClaudeSessionJsonlPath(sessionId, cwd, join(homedir(), '.claude'));
}

function getClaudeSessionJsonlPath(sessionId: string, cwd: string, dataDir: string): string | null {
  const resolvedCwd = resolve(expandHome(cwd));
  // Claude stores sessions at ~/.claude/projects/<project-key>/<sessionId>.jsonl
  // where project-key = absolute path with non [A-Za-z0-9-] chars replaced by -
  const projectKey = resolvedCwd.replace(/[^A-Za-z0-9-]/g, '-');
  const jsonlPath = join(dataDir, 'projects', projectKey, `${sessionId}.jsonl`);
  return existsSync(jsonlPath) ? jsonlPath : null;
}

export function getSessionCost(sessionId: string, cwd: string): SessionCost | null {
  const jsonlPath = getSessionJsonlPath(sessionId, cwd);
  if (!jsonlPath) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;
  let model = '';
  let turns = 0;

  try {
    const content = readFileSync(jsonlPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'assistant') continue;
        const msg = entry.message;
        if (!msg?.usage) continue;
        const u = msg.usage;
        inputTokens += u.input_tokens ?? 0;
        outputTokens += u.output_tokens ?? 0;
        cacheReadTokens += u.cache_read_input_tokens ?? 0;
        cacheCreateTokens += u.cache_creation_input_tokens ?? 0;
        if (msg.model && !model) model = msg.model;
        turns++;
      } catch { /* skip malformed lines */ }
    }
  } catch (err: any) {
    logger.error(`Failed to read session JSONL: ${err.message}`);
    return null;
  }

  return { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, model, turns };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function pickNum(obj: any, keys: readonly string[]): number {
  if (!obj || typeof obj !== 'object') return 0;
  for (const key of keys) {
    const value = num(obj[key]);
    if (value) return value;
  }
  return 0;
}

function extractNativeUsage(entry: any): { usage: any; model?: string } | null {
  const candidates = [
    { usage: entry?.message?.usage, model: entry?.message?.model },
    { usage: entry?.message?.usageMetadata, model: entry?.message?.model },
    {
      usage: entry?.message?.message?.response_meta?.usage,
      model: entry?.message?.message?.extra?._source_model ?? entry?.message?.message?.extra?.trae_extra_info?.model,
    },
    { usage: entry?.payload?.usage, model: entry?.payload?.model },
    { usage: entry?.payload?.usageMetadata, model: entry?.payload?.model },
    { usage: entry?.response?.usage, model: entry?.response?.model },
    { usage: entry?.response?.usageMetadata, model: entry?.response?.model },
    { usage: entry?.usage, model: entry?.model },
    { usage: entry?.usageMetadata, model: entry?.model },
  ];
  for (const c of candidates) {
    if (c.usage && typeof c.usage === 'object') return c;
  }
  return null;
}

function extractCodexTokenCountUsage(entry: any): SessionTokenUsage | null {
  if (entry?.type !== 'event_msg' || entry?.payload?.type !== 'token_count') return null;
  const u = entry.payload?.info?.total_token_usage;
  if (!u || typeof u !== 'object') return null;
  const inputTokens = pickNum(u, ['input_tokens', 'inputTokens']);
  const outputTokens = pickNum(u, ['output_tokens', 'outputTokens']);
  const cacheReadTokens = pickNum(u, ['cached_input_tokens', 'cachedInputTokens']);
  return {
    in: inputTokens,
    out: outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens: 0,
    model: '',
    turns: 0,
  };
}

function readTokenUsageFromJsonl(path: string): SessionTokenUsage | null {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;
  let model = '';
  let turns = 0;
  let latestCodexUsage: SessionTokenUsage | null = null;

  try {
    const content = readFileSync(path, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const codexUsage = extractCodexTokenCountUsage(entry);
        if (codexUsage) {
          latestCodexUsage = codexUsage;
          continue;
        }
        const native = extractNativeUsage(entry);
        if (!native) continue;
        const u = native.usage;
        inputTokens += pickNum(u, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'promptTokenCount']);
        outputTokens += pickNum(u, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'candidatesTokenCount']);
        cacheReadTokens += pickNum(u, ['cache_read_input_tokens', 'cacheReadInputTokens', 'cache_read_tokens', 'cacheReadTokens']);
        cacheCreateTokens += pickNum(u, ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'cache_write_input_tokens', 'cacheWriteInputTokens']);
        if (!model && typeof native.model === 'string') model = native.model;
        turns++;
      } catch { /* skip malformed lines */ }
    }
  } catch (err: any) {
    logger.error(`Failed to read session token usage JSONL: ${err.message}`);
    return null;
  }

  if (latestCodexUsage) return latestCodexUsage;
  if (turns === 0) return null;
  return {
    in: inputTokens + cacheReadTokens + cacheCreateTokens,
    out: outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    model,
    turns,
  };
}

function readTokenUsageFromAidenCheckpoint(path: string): SessionTokenUsage | null {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;
  let model = '';
  let turns = 0;

  try {
    const checkpoint = JSON.parse(readFileSync(path, 'utf-8'));
    const messages = checkpoint?.checkpoint?.channel_values?.messages;
    if (!Array.isArray(messages)) return null;
    for (const msg of messages) {
      const u = msg?.usage_metadata ?? msg?.usage;
      if (!u || typeof u !== 'object') continue;
      const input = pickNum(u, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
      const output = pickNum(u, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
      inputTokens += input;
      outputTokens += output;
      cacheReadTokens +=
        pickNum(u?.input_token_details, ['cache_read', 'cached_tokens', 'cacheRead']) +
        pickNum(u?.input_tokens_details, ['cache_read', 'cached_tokens', 'cacheRead']);
      cacheCreateTokens +=
        pickNum(u?.input_token_details, ['cache_creation', 'cache_write', 'cacheCreate']) +
        pickNum(u?.input_tokens_details, ['cache_creation', 'cache_write', 'cacheCreate']);
      if (!model && typeof msg?.response_metadata?.model_name === 'string') model = msg.response_metadata.model_name;
      turns++;
    }
  } catch (err: any) {
    logger.error(`Failed to read Aiden checkpoint token usage: ${err.message}`);
    return null;
  }

  if (turns === 0) return null;
  return {
    in: inputTokens,
    out: outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    model,
    turns,
  };
}

function tokenUsagePathForSession(q: SessionTokenUsageQuery): string | null {
  const sid = q.cliSessionId || q.sessionId;
  switch (q.cliId) {
    case 'claude-code':
      return q.cwd ? getClaudeSessionJsonlPath(sid, q.cwd, join(homedir(), '.claude')) : null;
    case 'seed':
      return q.cwd ? getClaudeSessionJsonlPath(sid, q.cwd, process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude-runtime')) : null;
    case 'codex': {
      const codexSid = q.cliSessionId || findCodexSessionIdByBotmuxSessionId(q.sessionId) || q.sessionId;
      return findCodexRolloutBySessionId(codexSid) ?? null;
    }
    case 'coco':
      return cocoEventsPathForSession(sid);
    case 'cursor':
      return findCursorTranscriptByChatId(sid) ?? null;
    case 'traex':
      return findTraexRolloutBySessionId(sid) ?? null;
    case 'antigravity':
      return q.cliSessionId
        ? join(homedir(), '.gemini', 'antigravity-cli', 'brain', q.cliSessionId, '.system_generated', 'logs', 'transcript.jsonl')
        : null;
    default:
      return null;
  }
}

export function getSessionTokenUsage(q: SessionTokenUsageQuery): SessionTokenUsage | null {
  if (q.cliId === 'aiden') {
    const sid = q.cliSessionId || q.sessionId;
    const checkpointPath =
      findAidenLatestCheckpointBySessionId(sid, undefined, q.cwd) ??
      findAidenLatestCheckpointByBotmuxSessionId(q.sessionId, undefined, q.cwd);
    if (!checkpointPath || !existsSync(checkpointPath)) return null;
    return readTokenUsageFromAidenCheckpoint(checkpointPath);
  }
  const path = tokenUsagePathForSession(q);
  if (!path || !existsSync(path)) return null;
  return readTokenUsageFromJsonl(path);
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}
