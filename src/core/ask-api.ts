/**
 * Pure helpers for the daemon's `POST /api/asks` IPC route.
 *
 * Kept separate from daemon.ts so the body-validator and the approver
 * fallback chain (§6) are unit-testable without spinning up an HTTP server,
 * registering bots, or mounting a full session map.
 */

import type { AskOption } from './ask-types.js';

export interface AskApiBody {
  sessionId: string;
  chatId: string;
  larkAppId: string;
  rootMessageId: string | null;
  options: AskOption[];
  prompt: string;
  /** Already in milliseconds. CLI side converts from `--timeout` seconds. */
  timeoutMs: number;
  /** Empty array → use the §6 fallback chain. */
  approvers: string[];
}

export type AskApiBodyError =
  | 'bad_body'
  | 'bad_sessionId'
  | 'bad_chatId'
  | 'bad_larkAppId'
  | 'bad_rootMessageId'
  | 'bad_prompt'
  | 'bad_timeoutMs'
  | 'bad_options'
  | 'bad_option_shape'
  | 'bad_option_key'
  | 'bad_option_label'
  | 'duplicate_option_key';

/** Validate the request body. Returns either the parsed body or an error code
 *  ready to be sent back as `{ ok: false, error }` with HTTP 400. */
export function parseAskBody(raw: unknown): AskApiBody | { error: AskApiBodyError } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'bad_body' };
  const r = raw as Record<string, unknown>;

  if (typeof r.sessionId !== 'string' || !r.sessionId.trim()) return { error: 'bad_sessionId' };
  if (typeof r.chatId !== 'string' || !r.chatId.trim()) return { error: 'bad_chatId' };
  if (typeof r.larkAppId !== 'string' || !r.larkAppId.trim()) return { error: 'bad_larkAppId' };
  if (r.rootMessageId !== null && typeof r.rootMessageId !== 'string') {
    return { error: 'bad_rootMessageId' };
  }
  if (typeof r.prompt !== 'string' || !r.prompt.trim()) return { error: 'bad_prompt' };
  if (
    typeof r.timeoutMs !== 'number' ||
    !Number.isFinite(r.timeoutMs) ||
    r.timeoutMs < 1000
  ) {
    return { error: 'bad_timeoutMs' };
  }
  if (!Array.isArray(r.options) || r.options.length < 2) return { error: 'bad_options' };

  const opts: AskOption[] = [];
  const seen = new Set<string>();
  for (const o of r.options) {
    if (!o || typeof o !== 'object') return { error: 'bad_option_shape' };
    const oo = o as Record<string, unknown>;
    if (typeof oo.key !== 'string' || !oo.key.trim()) return { error: 'bad_option_key' };
    if (typeof oo.label !== 'string') return { error: 'bad_option_label' };
    if (seen.has(oo.key)) return { error: 'duplicate_option_key' };
    seen.add(oo.key);
    opts.push({ key: oo.key, label: oo.label });
  }

  const approvers = Array.isArray(r.approvers)
    ? r.approvers.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];

  return {
    sessionId: r.sessionId,
    chatId: r.chatId,
    larkAppId: r.larkAppId,
    rootMessageId: r.rootMessageId as string | null,
    options: opts,
    prompt: r.prompt,
    timeoutMs: r.timeoutMs,
    approvers,
  };
}

/** Resolve the approver allowlist per §6 fallback chain:
 *   1. explicit `--approver` list from CLI args (non-empty wins outright)
 *   2. session.ownerOpenId ∩ bot.allowedUsers (single-owner topic chats)
 *   3. bot.allowedUsers (shared chats / no owner / owner not in allow)
 *
 *  Pure function: caller injects the lookups. The daemon wires
 *  `getBotAllowedUsers = (id) => getBot(id).resolvedAllowedUsers` and
 *  `getSessionOwner` = scan over activeSessions; tests pass stub funcs. */
export function resolveAskApprovers(args: {
  larkAppId: string;
  sessionId: string;
  explicit: ReadonlyArray<string>;
  getBotAllowedUsers: (larkAppId: string) => ReadonlyArray<string>;
  getSessionOwner: (sessionId: string) => string | undefined;
}): Set<string> {
  const explicit = args.explicit.filter((s) => s.trim().length > 0);
  if (explicit.length > 0) return new Set(explicit);

  const allow = args.getBotAllowedUsers(args.larkAppId);
  const owner = args.getSessionOwner(args.sessionId);
  if (owner && allow.includes(owner)) return new Set([owner]);
  return new Set(allow);
}
