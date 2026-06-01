import type { HookAskAdapter } from './types.js';
import claude from './claude-code.js';
import codex from './codex.js';
import opencode from './opencode.js';

const REGISTRY: Record<string, HookAskAdapter> = {
  'claude-code': claude,
  // Seed CLI is a Claude Code fork — identical AskUserQuestion hook payload,
  // so it reuses the claude hook adapter (the `botmux hook seed` command's
  // payload parses the same way).
  seed: claude,
  codex,
  opencode,
};

export function getHookAdapter(cliId: string): HookAskAdapter | undefined {
  return REGISTRY[cliId];
}
